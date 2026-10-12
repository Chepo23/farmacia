// Apoyos: traspaso de mercancía de la farmacia central hacia una sucursal.
// Ciclo: borrador -> enviado (sale del inventario de la central)
//                -> recibido (entra al inventario de la sucursal, revisado pieza por pieza)
// El inventario se mueve con el módulo unificado y cada cambio de estado se aparta primero
// (en la central cuando hay Supabase), así dos computadoras no envían, reciben o cancelan
// dos veces el mismo apoyo.
const express = require('express');
const db = require('../db');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const traspasos = require('../traspasos');
const { manejar } = require('../central');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

function requiereCentral(req, res, next) {
  if (!req.usuario.es_central) {
    return res.status(403).json({ error: 'Solo la farmacia central puede armar y enviar apoyos' });
  }
  next();
}

function cargarApoyo(id) {
  const apoyo = db
    .prepare(
      `SELECT a.*,
              o.nombre AS origen, o.direccion AS origen_direccion, o.telefono AS origen_telefono,
              d.nombre AS destino, d.direccion AS destino_direccion, d.telefono AS destino_telefono,
              uc.nombre AS creador, ue.nombre AS remitente, ur.nombre AS receptor, ux.nombre AS cancelador,
              (SELECT pe.folio FROM pedidos pe WHERE pe.id = a.pedido_id) AS pedido_folio
       FROM apoyos a
       JOIN sucursales o ON o.id = a.origen_id
       JOIN sucursales d ON d.id = a.destino_id
       LEFT JOIN usuarios uc ON uc.id = a.creado_por
       LEFT JOIN usuarios ue ON ue.id = a.enviado_por
       LEFT JOIN usuarios ur ON ur.id = a.recibido_por
       LEFT JOIN usuarios ux ON ux.id = a.cancelado_por
       WHERE a.id = ?`
    )
    .get(id);
  if (!apoyo) return null;

  apoyo.renglones = db
    .prepare(
      `SELECT d.*, COALESCE(p.usa_inventario, 1) AS usa_inventario
       FROM apoyo_detalle d
       LEFT JOIN productos p ON p.id = d.producto_id
       WHERE d.apoyo_id = ?
       ORDER BY d.id`
    )
    .all(apoyo.id);

  apoyo.piezas = redondear(apoyo.renglones.reduce((t, r) => t + r.cantidad, 0));
  apoyo.total_costo = redondear(apoyo.renglones.reduce((t, r) => t + r.importe, 0));
  apoyo.total_publico = redondear(apoyo.renglones.reduce((t, r) => t + r.precio_venta * r.cantidad, 0));
  apoyo.piezas_recibidas = redondear(apoyo.renglones.reduce((t, r) => t + (r.cantidad_recibida ?? 0), 0));
  apoyo.faltantes = redondear(
    apoyo.renglones.reduce((t, r) => t + (r.cantidad_recibida == null ? 0 : r.cantidad - r.cantidad_recibida), 0)
  );
  return apoyo;
}

// El apoyo con la existencia actual de cada producto en la farmacia que lo manda
async function cargarApoyoCompleto(id) {
  const apoyo = cargarApoyo(id);
  if (!apoyo) return null;
  const ids = apoyo.renglones.filter((r) => r.usa_inventario).map((r) => r.producto_id);
  const { mapa, fuente } = await inventario.leerExistencias(ids, { sucursalId: apoyo.origen_id });
  apoyo.renglones = apoyo.renglones.map((r) => {
    const valor = mapa.get(Number(r.producto_id))?.get(Number(apoyo.origen_id));
    return { ...r, existencia_origen: valor ? valor.existencia : 0, minimo: valor ? valor.minimo : 0 };
  });
  apoyo.fuente_inventario = fuente;
  return apoyo;
}

function puedeVer(apoyo, usuario) {
  if (apoyo.origen_id === usuario.sucursal_id) return true;
  return apoyo.destino_id === usuario.sucursal_id && apoyo.estado !== 'borrador';
}

// Solo la farmacia que solicitó el apoyo puede cancelarlo
function puedeCancelarApoyo(apoyo, usuario) {
  if (!apoyo || !usuario) return false;
  if (apoyo.estado === 'cancelado' || apoyo.estado === 'recibido') return false;
  return apoyo.destino_id === usuario.sucursal_id;
}

// La central puede descartar un borrador que ella armó y que todavía no envía
function puedeDescartarBorrador(apoyo, usuario) {
  if (!apoyo || !usuario) return false;
  return apoyo.estado === 'borrador' && apoyo.origen_id === usuario.sucursal_id;
}

function resolverPedidoTrasCancelarApoyo(apoyo, pedido, tieneOtrosApoyos = false) {
  if (!apoyo || !apoyo.pedido_id) return pedido?.estado || null;
  if (tieneOtrosApoyos) return pedido?.estado === 'cancelado' ? 'cancelado' : 'enviado';
  return 'cancelado';
}

// Solo la central que lo creó puede tocar el contenido, y solo mientras es borrador
function verificarEdicion(apoyo, usuario) {
  if (apoyo.origen_id !== usuario.sucursal_id) return 'Este apoyo lo armó otra farmacia';
  if (apoyo.estado !== 'borrador') return 'Este apoyo ya fue enviado y no se puede modificar';
  return null;
}

async function refrescar(id) {
  await traspasos.traerApoyos({ ids: [id] });
}

// ---------- Avisos para el badge de la pestaña ----------
router.get('/pendientes', manejar(async (req, res) => {
  res.json(await traspasos.contarPendientes(req.usuario));
}));

// ---------- Listado ----------
router.get('/', manejar(async (req, res) => {
  await traspasos.traerApoyos({ sucursalId: req.usuario.sucursal_id });
  const estado = String(req.query.estado || '').trim();
  const filas = db
    .prepare(
      `SELECT a.id, a.folio, a.estado, a.creado, a.enviado, a.recibido, a.cancelado,
              a.origen_id, a.destino_id, a.pedido_id, a.nota, a.motivo_cancelacion,
              o.nombre AS origen, d.nombre AS destino, uc.nombre AS creador,
              (SELECT COUNT(*) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS renglones,
              (SELECT COALESCE(SUM(x.cantidad), 0) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS piezas,
              (SELECT COALESCE(SUM(x.importe), 0) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS total_costo,
              (SELECT COALESCE(SUM(x.cantidad - COALESCE(x.cantidad_recibida, x.cantidad)), 0)
                 FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS faltantes
       FROM apoyos a
       JOIN sucursales o ON o.id = a.origen_id
       JOIN sucursales d ON d.id = a.destino_id
       LEFT JOIN usuarios uc ON uc.id = a.creado_por
       WHERE (a.origen_id = @suc OR (a.destino_id = @suc AND a.estado <> 'borrador'))
         AND (@estado = '' OR a.estado = @estado)
       ORDER BY a.id DESC LIMIT 200`
    )
    .all({ suc: req.usuario.sucursal_id, estado });
  res.json(filas);
}));

// ---------- Abrir o crear el borrador hacia una sucursal ----------
router.post('/', requiereCentral, manejar(async (req, res) => {
  const origenId = Number(req.usuario.sucursal_id);
  const destinoId = Number(req.body?.destino_id);
  await inventario.asegurarSucursales([destinoId]);
  const destino = db.prepare('SELECT * FROM sucursales WHERE id = ? AND activa = 1').get(destinoId);
  if (!destino) return res.status(400).json({ error: 'Sucursal de destino no válida' });
  if (destinoId === origenId) return res.status(400).json({ error: 'No puedes mandarte un apoyo a ti mismo' });

  // Si ya hay un apoyo a medias hacia esa sucursal, se continúa ese
  await traspasos.traerApoyos({ sucursalId: origenId });
  const abierto = db
    .prepare("SELECT id, pedido_id FROM apoyos WHERE origen_id = ? AND destino_id = ? AND estado = 'borrador' ORDER BY id DESC")
    .get(origenId, destinoId);
  const pedidoId = Number(req.body?.pedido_id) || null;
  if (abierto && (!pedidoId || Number(abierto.pedido_id) === pedidoId)) {
    return res.json(await cargarApoyoCompleto(abierto.id));
  }

  let pedido = null;
  if (pedidoId) {
    await traspasos.traerPedidos({ ids: [pedidoId] });
    pedido = db.prepare("SELECT * FROM pedidos WHERE id = ? AND estado = 'enviado'").get(pedidoId);
    if (!pedido) return res.status(400).json({ error: 'El pedido no existe, fue cancelado o ya fue surtido' });
    if (pedido.sucursal_id !== destinoId) return res.status(400).json({ error: 'El pedido es de otra sucursal' });
  }

  let apoyoId = abierto?.id;
  if (!apoyoId) {
    apoyoId = await traspasos.crearApoyo({ origenId, destinoId, pedidoId: pedido?.id, usuarioId: req.usuario.id });
  } else if (pedido) {
    await traspasos.actualizar('apoyos', apoyoId, { pedido_id: pedido.id }, { estadoEsperado: 'borrador' });
  }

  if (pedido) {
    // Precargar lo que la sucursal pidió, con los precios de hoy
    const pedidos = db.prepare('SELECT producto_id, cantidad FROM pedido_detalle WHERE pedido_id = ? ORDER BY id').all(pedido.id);
    const productos = await catalogo.porIds(pedidos.map((r) => r.producto_id));
    for (const r of pedidos) {
      const producto = productos.get(Number(r.producto_id));
      if (producto && r.cantidad > 0) await traspasos.sumarRenglonApoyo(apoyoId, producto, r.cantidad);
    }
  }
  res.json(await cargarApoyoCompleto(apoyoId));
}));

router.get('/:id', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = await cargarApoyoCompleto(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  if (!puedeVer(apoyo, req.usuario)) return res.status(403).json({ error: 'Ese apoyo no es de tu farmacia' });
  res.json(apoyo);
}));

// ---------- Renglones (escaneo) ----------
router.post('/:id/renglones', requiereCentral, manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });

  const producto = req.body?.producto_id
    ? await catalogo.porId(req.body.producto_id)
    : await catalogo.porCodigo(req.body?.codigo_barras);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const cantidad = Number(req.body?.cantidad ?? 1);
  if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

  await traspasos.sumarRenglonApoyo(apoyo.id, producto, cantidad);
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

router.put('/:id/renglones/:renglon', requiereCentral, manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  const cantidad = Number(req.body?.cantidad);
  if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });
  await traspasos.cambiarCantidadApoyo(apoyo.id, Number(req.params.renglon), cantidad);
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

router.delete('/:id/renglones/:renglon', requiereCentral, manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  await traspasos.quitarRenglonApoyo(apoyo.id, Number(req.params.renglon));
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

router.put('/:id', requiereCentral, manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  await traspasos.actualizar('apoyos', apoyo.id, { nota: String(req.body?.nota || '').trim().slice(0, 300) }, { estadoEsperado: 'borrador' });
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

// ---------- Enviar: la mercancía sale del inventario de la central ----------
router.post('/:id/enviar', requiereCentral, manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = await cargarApoyoCompleto(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  if (apoyo.renglones.length === 0) return res.status(400).json({ error: 'El apoyo no tiene productos' });

  const sinExistencia = apoyo.renglones.filter((r) => r.usa_inventario && r.cantidad > r.existencia_origen + 1e-9);
  if (sinExistencia.length > 0) {
    return res.status(400).json({
      error: `No hay existencia suficiente en ${apoyo.origen} de: ${sinExistencia
        .map((r) => `${r.descripcion} (hay ${r.existencia_origen}, se mandan ${r.cantidad})`)
        .join('; ')}`,
    });
  }

  const nota = String(req.body?.nota ?? apoyo.nota ?? '').trim().slice(0, 300);
  const tomado = await traspasos.actualizar(
    'apoyos', apoyo.id,
    { estado: 'enviado', enviado_por: req.usuario.id, enviado: new Date(), nota },
    { estadoEsperado: 'borrador' }
  );
  if (!tomado) return res.status(400).json({ error: 'Este apoyo ya fue enviado o cancelado; actualiza la pantalla' });

  try {
    await inventario.aplicar(
      apoyo.renglones
        .filter((r) => r.usa_inventario && r.cantidad > 0)
        .map((r) => ({
          producto_id: r.producto_id,
          sucursal_id: apoyo.origen_id,
          tipo: 'salida',
          cantidad: r.cantidad,
          nota: `Apoyo folio ${apoyo.folio} enviado a ${apoyo.destino}`,
        })),
      { usuarioId: req.usuario.id }
    );
  } catch (error) {
    await traspasos.actualizar('apoyos', apoyo.id, { estado: 'borrador', enviado_por: null, enviado: null }, { estadoEsperado: 'enviado' });
    throw error;
  }

  // Si venía de un pedido, se marca lo que se le surtió
  if (apoyo.pedido_id) {
    await traspasos.ajustarSurtido(apoyo.pedido_id, apoyo.renglones, 1);
    await traspasos.actualizar('pedidos', apoyo.pedido_id, { estado: 'surtido' }, { estadoEsperado: ['enviado', 'borrador'] });
  }
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

// ---------- Recibir: la sucursal revisa pieza por pieza ----------
router.post('/:id/recibir', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  if (apoyo.destino_id !== req.usuario.sucursal_id) {
    return res.status(403).json({ error: 'Solo la farmacia que recibe puede confirmar el apoyo' });
  }
  if (apoyo.estado !== 'enviado') return res.status(400).json({ error: 'Este apoyo no está pendiente de recibir' });

  // Lo que no venga en el cuerpo se da por recibido completo
  const capturado = new Map(
    (Array.isArray(req.body?.renglones) ? req.body.renglones : []).map((r) => [Number(r.id), Number(r.cantidad_recibida)])
  );
  const recibidas = [];
  for (const r of apoyo.renglones) {
    const cantidad = capturado.has(r.id) ? capturado.get(r.id) : r.cantidad;
    if (!Number.isFinite(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: `Cantidad recibida no válida en "${r.descripcion}"` });
    }
    if (cantidad > r.cantidad + 1e-9) {
      return res.status(400).json({
        error: `No puedes recibir más de lo que se mandó de "${r.descripcion}" (se mandaron ${r.cantidad})`,
      });
    }
    recibidas.push({ renglon: r, cantidad: redondear(cantidad) });
  }

  const tomado = await traspasos.actualizar(
    'apoyos', apoyo.id,
    { estado: 'recibido', recibido_por: req.usuario.id, recibido: new Date() },
    { estadoEsperado: 'enviado' }
  );
  if (!tomado) return res.status(400).json({ error: 'Este apoyo ya fue recibido o cancelado; actualiza la pantalla' });

  try {
    await inventario.aplicar(
      recibidas
        .filter(({ renglon, cantidad }) => renglon.usa_inventario && cantidad > 0)
        .map(({ renglon, cantidad }) => ({
          producto_id: renglon.producto_id,
          sucursal_id: apoyo.destino_id,
          tipo: 'entrada',
          cantidad,
          nota: `Apoyo folio ${apoyo.folio} recibido de ${apoyo.origen}`,
        })),
      { usuarioId: req.usuario.id }
    );
  } catch (error) {
    await traspasos.actualizar('apoyos', apoyo.id, { estado: 'enviado', recibido_por: null, recibido: null }, { estadoEsperado: 'recibido' });
    throw error;
  }
  await traspasos.marcarRecibido(apoyo.id, recibidas);
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

// ---------- Cancelar ----------
router.post('/:id/cancelar', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const descarteDeLaCentral = puedeDescartarBorrador(apoyo, req.usuario);
  if (!puedeCancelarApoyo(apoyo, req.usuario) && !descarteDeLaCentral) {
    return res.status(403).json({ error: 'Solo la farmacia que solicitó el apoyo puede cancelarlo' });
  }
  if (apoyo.estado === 'recibido') {
    return res.status(400).json({ error: 'Este apoyo ya fue recibido, no se puede cancelar' });
  }
  if (apoyo.estado === 'cancelado') return res.json(await cargarApoyoCompleto(apoyo.id));

  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  if (apoyo.estado === 'enviado' && !motivo) return res.status(400).json({ error: 'Escribe el motivo de la cancelación' });

  const estadoPrevio = apoyo.estado;
  const tomado = await traspasos.actualizar(
    'apoyos', apoyo.id,
    { estado: 'cancelado', cancelado_por: req.usuario.id, cancelado: new Date(), motivo_cancelacion: motivo },
    { estadoEsperado: estadoPrevio }
  );
  if (!tomado) return res.status(400).json({ error: 'El apoyo cambió de estado; actualiza la pantalla' });

  // Si ya se había enviado, la mercancía regresa al inventario de la central
  if (estadoPrevio === 'enviado') {
    try {
      await inventario.aplicar(
        apoyo.renglones
          .filter((r) => r.usa_inventario && r.cantidad > 0)
          .map((r) => ({
            producto_id: r.producto_id,
            sucursal_id: apoyo.origen_id,
            tipo: 'entrada',
            cantidad: r.cantidad,
            nota: `Cancelación del apoyo folio ${apoyo.folio} a ${apoyo.destino}`,
          })),
        { usuarioId: req.usuario.id }
      );
    } catch (error) {
      await traspasos.actualizar(
        'apoyos', apoyo.id,
        { estado: 'enviado', cancelado_por: null, cancelado: null, motivo_cancelacion: '' },
        { estadoEsperado: 'cancelado' }
      );
      throw error;
    }
    if (apoyo.pedido_id) await traspasos.ajustarSurtido(apoyo.pedido_id, apoyo.renglones, -1);
  }

  // Si la central solo descarta su borrador, el pedido sigue pendiente de surtir
  if (apoyo.pedido_id && !descarteDeLaCentral) {
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(apoyo.pedido_id);
    const tieneOtros = await traspasos.otrosApoyosActivos(apoyo.pedido_id, apoyo.id);
    const nuevoEstado = resolverPedidoTrasCancelarApoyo(apoyo, pedido, tieneOtros);
    if (nuevoEstado && (!pedido || nuevoEstado !== pedido.estado)) {
      await traspasos.actualizar('pedidos', apoyo.pedido_id, { estado: nuevoEstado });
    }
  }
  res.json(await cargarApoyoCompleto(apoyo.id));
}));

module.exports = router;
module.exports.puedeCancelarApoyo = puedeCancelarApoyo;
module.exports.puedeDescartarBorrador = puedeDescartarBorrador;
module.exports.resolverPedidoTrasCancelarApoyo = resolverPedidoTrasCancelarApoyo;
