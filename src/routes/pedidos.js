// Pedidos de apoyo: lo que una sucursal le solicita a la farmacia central.
// Sustituye la lista escrita a mano que antes se mandaba por foto.
const express = require('express');
const db = require('../db');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const traspasos = require('../traspasos');
const { manejar } = require('../central');

const router = express.Router();

function cargarPedido(id) {
  const pedido = db
    .prepare(
      `SELECT p.*, s.nombre AS sucursal, s.es_central, u.nombre AS creador, ue.nombre AS remitente
       FROM pedidos p
       JOIN sucursales s ON s.id = p.sucursal_id
       LEFT JOIN usuarios u ON u.id = p.creado_por
       LEFT JOIN usuarios ue ON ue.id = p.enviado_por
       WHERE p.id = ?`
    )
    .get(id);
  if (!pedido) return null;
  pedido.renglones = db.prepare('SELECT * FROM pedido_detalle WHERE pedido_id = ? ORDER BY id').all(pedido.id);
  pedido.piezas = Math.round(pedido.renglones.reduce((t, r) => t + r.cantidad, 0) * 100) / 100;
  return pedido;
}

// Solo quien hizo el pedido lo edita; la central puede verlo cuando ya fue enviado
function puedeVer(pedido, usuario) {
  if (pedido.sucursal_id === usuario.sucursal_id) return true;
  return usuario.es_central === 1 && pedido.estado !== 'borrador';
}

function puedeEditar(pedido, usuario) {
  if (!pedido || !usuario) return false;
  if (pedido.sucursal_id !== usuario.sucursal_id) return false;
  if (pedido.estado === 'cancelado' || pedido.estado === 'surtido') return false;
  return pedido.estado === 'borrador' || pedido.estado === 'enviado';
}

function puedeCancelar(pedido, usuario) {
  if (!pedido || !usuario) return false;
  if (pedido.sucursal_id !== usuario.sucursal_id) return false;
  if (pedido.estado === 'cancelado' || pedido.estado === 'surtido') return false;
  return true;
}

async function refrescar(id) {
  await traspasos.traerPedidos({ ids: [id] });
}

// ---------- Listado ----------
router.get('/', manejar(async (req, res) => {
  const esCentral = Boolean(req.usuario.es_central);
  await traspasos.traerPedidos({ sucursalId: req.usuario.sucursal_id, esCentral });
  const filas = db
    .prepare(
      `SELECT p.id, p.folio, p.estado, p.nota, p.creado, p.enviado, p.sucursal_id,
              s.nombre AS sucursal, u.nombre AS creador,
              (SELECT COUNT(*) FROM pedido_detalle d WHERE d.pedido_id = p.id) AS renglones,
              (SELECT COALESCE(SUM(d.cantidad), 0) FROM pedido_detalle d WHERE d.pedido_id = p.id) AS piezas,
              (SELECT a.id FROM apoyos a WHERE a.pedido_id = p.id AND a.estado <> 'cancelado'
                ORDER BY a.id DESC LIMIT 1) AS apoyo_id
       FROM pedidos p
       JOIN sucursales s ON s.id = p.sucursal_id
       LEFT JOIN usuarios u ON u.id = p.creado_por
       WHERE (p.sucursal_id = @suc OR (@central = 1 AND p.estado <> 'borrador'))
         AND p.estado <> 'cancelado'
       ORDER BY p.id DESC LIMIT 100`
    )
    .all({ suc: req.usuario.sucursal_id, central: esCentral ? 1 : 0 });
  res.json(filas);
}));

// Qué conviene pedir: lo que está en cero o bajo mínimo en mi sucursal,
// con lo vendido en la última semana para sugerir la cantidad
router.get('/sugerencias', manejar(async (req, res) => {
  const fuente = await inventario.asegurarCopiaFresca({ maxEdadMs: 15000 });
  const filas = db
    .prepare(
      `SELECT p.id AS producto_id, p.codigo_barras, p.descripcion,
              i.existencia, i.minimo,
              COALESCE((SELECT SUM(d.cantidad) FROM venta_detalle d
                        JOIN ventas v ON v.id = d.venta_id
                        WHERE d.producto_id = p.id AND v.sucursal_id = @suc AND v.cancelada = 0
                          AND v.fecha >= datetime('now', 'localtime', '-7 day')), 0) AS vendidos_semana
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       WHERE i.sucursal_id = @suc AND p.activo = 1 AND p.id <> 0 AND p.usa_inventario = 1
         AND (i.existencia <= 0 OR (i.minimo > 0 AND i.existencia <= i.minimo))
       ORDER BY (i.existencia <= 0) DESC, vendidos_semana DESC, p.descripcion
       LIMIT 200`
    )
    .all({ suc: req.usuario.sucursal_id });
  res.set('X-Fuente-Inventario', fuente);
  res.json(
    filas.map((f) => ({
      ...f,
      // Lo vendido en la semana o, si es más, lo que falta para llegar al doble del mínimo
      cantidad_sugerida: Math.max(
        1,
        Math.ceil(f.vendidos_semana) - Math.max(0, Math.floor(f.existencia)),
        Math.ceil(f.minimo * 2 - Math.max(0, f.existencia))
      ),
    }))
  );
}));

// ---------- Abrir o crear el pedido en borrador de mi sucursal ----------
router.post('/', manejar(async (req, res) => {
  if (req.usuario.es_central) {
    return res.status(400).json({ error: 'La farmacia central no pide apoyos, los envía' });
  }
  await traspasos.traerPedidos({ sucursalId: req.usuario.sucursal_id });
  const abierto = db
    .prepare("SELECT id FROM pedidos WHERE sucursal_id = ? AND estado = 'borrador' ORDER BY id DESC")
    .get(req.usuario.sucursal_id);
  if (abierto) return res.json(cargarPedido(abierto.id));
  const id = await traspasos.crearPedido({ sucursalId: req.usuario.sucursal_id, usuarioId: req.usuario.id });
  res.json(cargarPedido(id));
}));

router.get('/:id', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeVer(pedido, req.usuario)) return res.status(403).json({ error: 'Ese pedido no es de tu farmacia' });
  res.json(pedido);
}));

// ---------- Renglones ----------
router.post('/:id/renglones', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  const producto = req.body?.producto_id
    ? await catalogo.porId(req.body.producto_id)
    : await catalogo.porCodigo(req.body?.codigo_barras);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const cantidad = Number(req.body?.cantidad ?? 1);
  if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

  await traspasos.sumarRenglonPedido(pedido.id, producto, cantidad);
  res.json(cargarPedido(pedido.id));
}));

router.put('/:id/renglones/:renglon', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  const cantidad = Number(req.body?.cantidad);
  if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });
  await traspasos.cambiarCantidadPedido(pedido.id, Number(req.params.renglon), cantidad);
  res.json(cargarPedido(pedido.id));
}));

router.delete('/:id/renglones/:renglon', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  await traspasos.quitarRenglonPedido(pedido.id, Number(req.params.renglon));
  res.json(cargarPedido(pedido.id));
}));

// ---------- Enviar el pedido a la central (o guardar cambios de uno ya enviado) ----------
router.post('/:id/enviar', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) return res.status(400).json({ error: 'Este pedido ya no se puede modificar' });
  if (pedido.renglones.length === 0) return res.status(400).json({ error: 'El pedido no tiene productos' });
  const tomado = await traspasos.actualizar(
    'pedidos', pedido.id,
    {
      estado: 'enviado',
      enviado_por: req.usuario.id,
      enviado: new Date(),
      nota: String(req.body?.nota ?? pedido.nota ?? '').trim().slice(0, 300),
    },
    { estadoEsperado: ['borrador', 'enviado'] }
  );
  if (!tomado) return res.status(400).json({ error: 'El pedido cambió de estado; actualiza la pantalla' });
  res.json(cargarPedido(pedido.id));
}));

router.post('/:id/cancelar', manejar(async (req, res) => {
  await refrescar(req.params.id);
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeCancelar(pedido, req.usuario)) {
    if (pedido.sucursal_id !== req.usuario.sucursal_id) {
      return res.status(403).json({ error: 'Ese pedido no es de tu farmacia' });
    }
    if (pedido.estado === 'surtido') {
      return res.status(400).json({ error: 'Este pedido ya fue surtido con un apoyo' });
    }
    return res.status(400).json({ error: 'Este pedido ya no se puede cancelar' });
  }
  const tomado = await traspasos.actualizar('pedidos', pedido.id, { estado: 'cancelado' }, { estadoEsperado: ['borrador', 'enviado'] });
  if (!tomado) return res.status(400).json({ error: 'Este pedido ya fue cancelado o no se puede cancelar' });
  res.json({ ok: true, estado: 'cancelado' });
}));

module.exports = router;
module.exports.router = router;
module.exports.puedeEditar = puedeEditar;
module.exports.puedeCancelar = puedeCancelar;
