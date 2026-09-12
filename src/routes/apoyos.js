// Apoyos: traspaso de mercancía de la farmacia central hacia una sucursal.
// Ciclo: borrador -> enviado (sale del inventario de la central)
//                -> recibido (entra al inventario de la sucursal, revisado pieza por pieza)
const express = require('express');
const db = require('../db');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');
const { publicarSinBloquear, descargarApoyos } = require('../sync/apoyos');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

function requiereCentral(req, res, next) {
  if (!req.usuario.es_central) {
    return res.status(403).json({ error: 'Solo la farmacia central puede armar y enviar apoyos' });
  }
  next();
}

async function buscarProductoEnCentral(productoId, codigo) {
  if (!hasSupabase || !supabaseAdmin) return null;
  let query = supabaseAdmin.from('productos').select('*').eq('activo', true);
  if (productoId) query = query.eq('id', Number(productoId));
  if (codigo) query = query.eq('codigo_barras', codigo);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function buscarProducto(body) {
  if (body.producto_id) {
    const local = db
      .prepare('SELECT * FROM productos WHERE id = ? AND activo = 1 AND es_comun = 0')
      .get(body.producto_id);
    if (local) return local;
    try {
      return await buscarProductoEnCentral(body.producto_id, null);
    } catch {
      return null;
    }
  }
  const codigo = (body.codigo_barras || '').trim();
  if (!codigo) return null;
  const local = db
    .prepare('SELECT * FROM productos WHERE codigo_barras = ? AND activo = 1 AND es_comun = 0')
    .get(codigo);
  if (local) return local;
  try {
    return await buscarProductoEnCentral(null, codigo);
  } catch {
    return null;
  }
}

function asegurarProductoLocal(producto) {
  if (!producto) return null;
  const codigo = (producto.codigo_barras || '').trim();
  const existente = codigo
    ? db.prepare('SELECT * FROM productos WHERE codigo_barras = ?').get(codigo)
    : db.prepare('SELECT * FROM productos WHERE descripcion = ?').get((producto.descripcion || '').trim());
  if (existente) return existente;

  const info = db.prepare(
    `INSERT INTO productos (codigo_barras, descripcion, departamento, precio_costo, precio_venta, precio_mayoreo, cantidad_mayoreo, usa_inventario, es_comun, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    codigo || null,
    (producto.descripcion || '').trim(),
    (producto.departamento || '').trim(),
    Number(producto.precio_costo) || 0,
    Number(producto.precio_venta) || 0,
    producto.precio_mayoreo != null ? Number(producto.precio_mayoreo) : null,
    producto.cantidad_mayoreo != null ? Number(producto.cantidad_mayoreo) : null,
    Boolean(producto.usa_inventario) ? 1 : 0,
    Boolean(producto.es_comun) ? 1 : 0,
    Boolean(producto.activo) ? 1 : 0
  );

  return db.prepare('SELECT * FROM productos WHERE id = ?').get(info.lastInsertRowid);
}

function cargarApoyo(id) {
  const apoyo = db
    .prepare(
      `SELECT a.*,
              o.nombre AS origen, o.direccion AS origen_direccion, o.telefono AS origen_telefono,
              d.nombre AS destino,
              uc.nombre AS creador, ue.nombre AS remitente, ur.nombre AS receptor,
              (SELECT pe.folio FROM pedidos pe WHERE pe.id = a.pedido_id) AS pedido_folio
       FROM apoyos a
       JOIN sucursales o ON o.id = a.origen_id
       JOIN sucursales d ON d.id = a.destino_id
       JOIN usuarios uc ON uc.id = a.creado_por
       LEFT JOIN usuarios ue ON ue.id = a.enviado_por
       LEFT JOIN usuarios ur ON ur.id = a.recibido_por
       WHERE a.id = ?`
    )
    .get(id);
  if (!apoyo) return null;

  apoyo.renglones = db
    .prepare(
      `SELECT d.*, p.usa_inventario,
              COALESCE((SELECT i.existencia FROM inventario i
                        WHERE i.producto_id = d.producto_id AND i.sucursal_id = ?), 0) AS existencia_origen
       FROM apoyo_detalle d
       JOIN productos p ON p.id = d.producto_id
       WHERE d.apoyo_id = ?
       ORDER BY d.id`
    )
    .all(apoyo.origen_id, apoyo.id);

  apoyo.piezas = redondear(apoyo.renglones.reduce((t, r) => t + r.cantidad, 0));
  apoyo.total_costo = redondear(apoyo.renglones.reduce((t, r) => t + r.importe, 0));
  apoyo.total_publico = redondear(
    apoyo.renglones.reduce((t, r) => t + r.precio_venta * r.cantidad, 0)
  );
  apoyo.piezas_recibidas = redondear(
    apoyo.renglones.reduce((t, r) => t + (r.cantidad_recibida ?? 0), 0)
  );
  apoyo.faltantes = redondear(
    apoyo.renglones.reduce(
      (t, r) => t + (r.cantidad_recibida == null ? 0 : r.cantidad - r.cantidad_recibida),
      0
    )
  );
  return apoyo;
}

async function cargarApoyoConInventarioCentral(id) {
  const apoyo = cargarApoyo(id);
  if (!apoyo || !hasSupabase || !supabaseAdmin || apoyo.renglones.length === 0) return apoyo;
  const ids = apoyo.renglones.filter((r) => r.usa_inventario).map((r) => r.producto_id);
  if (!ids.length) return apoyo;
  const { data, error } = await supabaseAdmin.from('inventario')
    .select('producto_id,existencia,minimo')
    .eq('sucursal_id', Number(apoyo.origen_id)).in('producto_id', ids);
  if (error) throw error;
  const inventario = new Map((data || []).map((r) => [Number(r.producto_id), r]));
  apoyo.renglones = apoyo.renglones.map((r) => {
    const central = inventario.get(Number(r.producto_id));
    return central ? { ...r, existencia_origen: Number(central.existencia || 0), minimo: Number(central.minimo || 0) } : r;
  });
  return apoyo;
}

function puedeVer(apoyo, usuario) {
  if (apoyo.origen_id === usuario.sucursal_id) return true;
  return apoyo.destino_id === usuario.sucursal_id && apoyo.estado !== 'borrador';
}

// Solo la central que lo creó puede tocar el contenido, y solo mientras es borrador
function verificarEdicion(apoyo, usuario) {
  if (apoyo.origen_id !== usuario.sucursal_id) return 'Este apoyo lo armó otra farmacia';
  if (apoyo.estado !== 'borrador') return 'Este apoyo ya fue enviado y no se puede modificar';
  return null;
}

// ---------- Avisos para el badge de la pestaña ----------
router.get('/pendientes', async (req, res) => {
  try { await descargarApoyos(); } catch (error) { console.error('No se pudieron descargar apoyos:', error.message); }
  const porRecibir = db
    .prepare("SELECT COUNT(*) AS n FROM apoyos WHERE destino_id = ? AND estado = 'enviado'")
    .get(req.usuario.sucursal_id).n;
  const pedidosPorSurtir = req.usuario.es_central
    ? db.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE estado = 'enviado'").get().n
    : 0;
  res.json({ por_recibir: porRecibir, pedidos_por_surtir: pedidosPorSurtir });
});

// ---------- Listado ----------
router.get('/', async (req, res) => {
  try { await descargarApoyos(); } catch (error) { console.error('No se pudieron descargar apoyos:', error.message); }
  const estado = (req.query.estado || '').trim();
  const filas = db
    .prepare(
      `SELECT a.id, a.folio, a.estado, a.creado, a.enviado, a.recibido,
              a.origen_id, a.destino_id, a.nota,
              o.nombre AS origen, d.nombre AS destino, uc.nombre AS creador,
              (SELECT COUNT(*) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS renglones,
              (SELECT COALESCE(SUM(x.cantidad), 0) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS piezas,
              (SELECT COALESCE(SUM(x.importe), 0) FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS total_costo,
              (SELECT COALESCE(SUM(x.cantidad - COALESCE(x.cantidad_recibida, x.cantidad)), 0)
                 FROM apoyo_detalle x WHERE x.apoyo_id = a.id) AS faltantes
       FROM apoyos a
       JOIN sucursales o ON o.id = a.origen_id
       JOIN sucursales d ON d.id = a.destino_id
       JOIN usuarios uc ON uc.id = a.creado_por
       WHERE (a.origen_id = @suc OR (a.destino_id = @suc AND a.estado <> 'borrador'))
         AND (@estado = '' OR a.estado = @estado)
       ORDER BY a.id DESC LIMIT 100`
    )
    .all({ suc: req.usuario.sucursal_id, estado });
  res.json(filas);
});

// ---------- Abrir o crear el borrador hacia una sucursal ----------
router.post('/', requiereCentral, async (req, res) => {
  const destinoId = Number(req.body?.destino_id);
  const destino = db.prepare('SELECT * FROM sucursales WHERE id = ? AND activa = 1').get(destinoId);
  if (!destino) return res.status(400).json({ error: 'Sucursal de destino no válida' });
  if (destinoId === req.usuario.sucursal_id) {
    return res.status(400).json({ error: 'No puedes mandarte un apoyo a ti mismo' });
  }

  // Si ya hay un apoyo a medias hacia esa sucursal, se continúa ese
  const abierto = db
    .prepare(
      "SELECT id FROM apoyos WHERE origen_id = ? AND destino_id = ? AND estado = 'borrador' ORDER BY id DESC"
    )
    .get(req.usuario.sucursal_id, destinoId);
  if (abierto && !req.body.pedido_id) return res.json(await cargarApoyoConInventarioCentral(abierto.id));

  let pedido = null;
  if (req.body.pedido_id) {
    pedido = db.prepare("SELECT * FROM pedidos WHERE id = ? AND estado = 'enviado'").get(req.body.pedido_id);
    if (!pedido) return res.status(400).json({ error: 'El pedido no existe o ya fue surtido' });
    if (pedido.sucursal_id !== destinoId) {
      return res.status(400).json({ error: 'El pedido es de otra sucursal' });
    }
  }

  const id = db.transaction(() => {
    const apoyoId =
      abierto?.id ??
      db
        .prepare(
          'INSERT INTO apoyos (folio, origen_id, destino_id, pedido_id, creado_por) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM apoyos WHERE origen_id = ?')
            .get(req.usuario.sucursal_id).f,
          req.usuario.sucursal_id,
          destinoId,
          pedido?.id ?? null,
          req.usuario.id
        ).lastInsertRowid;

    if (pedido) {
      if (abierto) db.prepare('UPDATE apoyos SET pedido_id = ? WHERE id = ?').run(pedido.id, apoyoId);
      // Precargar lo que la sucursal pidió, con los precios de hoy
      const renglones = db
        .prepare(
          `SELECT d.producto_id, d.cantidad, p.codigo_barras, p.descripcion,
                  p.precio_costo, p.precio_venta, p.precio_mayoreo
           FROM pedido_detalle d JOIN productos p ON p.id = d.producto_id
           WHERE d.pedido_id = ? AND p.activo = 1`
        )
        .all(pedido.id);
      const insertar = db.prepare(
        `INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad,
           precio_costo, precio_venta, precio_mayoreo, importe)
         VALUES (@apoyo_id, @producto_id, @codigo_barras, @descripcion, @cantidad,
           @precio_costo, @precio_venta, @precio_mayoreo, @importe)
         ON CONFLICT(apoyo_id, producto_id) DO UPDATE SET cantidad = cantidad + excluded.cantidad,
           importe = round((cantidad + excluded.cantidad) * precio_costo, 2)`
      );
      for (const r of renglones) {
        insertar.run({
          apoyo_id: apoyoId,
          producto_id: r.producto_id,
          codigo_barras: r.codigo_barras,
          descripcion: r.descripcion,
          cantidad: r.cantidad,
          precio_costo: r.precio_costo,
          precio_venta: r.precio_venta,
          precio_mayoreo: r.precio_mayoreo,
          importe: redondear(r.precio_costo * r.cantidad),
        });
      }
    }
    return apoyoId;
  })();

  const respuesta = await cargarApoyoConInventarioCentral(id);
  publicarSinBloquear(id);
  res.json(respuesta);
});

router.get('/:id', async (req, res) => {
  const apoyo = await cargarApoyoConInventarioCentral(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  if (!puedeVer(apoyo, req.usuario)) return res.status(403).json({ error: 'Ese apoyo no es de tu farmacia' });
  res.json(apoyo);
});

// ---------- Renglones (escaneo) ----------
router.post('/:id/renglones', requiereCentral, async (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });

  const producto = await buscarProducto(req.body || {});
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const cantidad = Number(req.body.cantidad ?? 1);
  if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

  const productoLocal = asegurarProductoLocal(producto);
  const existente = db
    .prepare('SELECT * FROM apoyo_detalle WHERE apoyo_id = ? AND producto_id = ?')
    .get(apoyo.id, productoLocal.id);
  if (existente) {
    const nueva = existente.cantidad + cantidad;
    db.prepare('UPDATE apoyo_detalle SET cantidad = ?, importe = ? WHERE id = ?').run(
      nueva, redondear(existente.precio_costo * nueva), existente.id
    );
  } else {
    db.prepare(
      `INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad,
         precio_costo, precio_venta, precio_mayoreo, importe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      apoyo.id, productoLocal.id, productoLocal.codigo_barras, productoLocal.descripcion, cantidad,
      productoLocal.precio_costo, productoLocal.precio_venta, productoLocal.precio_mayoreo,
      redondear(productoLocal.precio_costo * cantidad)
    );
  }
  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

router.put('/:id/renglones/:renglon', requiereCentral, (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });

  const renglon = db
    .prepare('SELECT * FROM apoyo_detalle WHERE id = ? AND apoyo_id = ?')
    .get(req.params.renglon, apoyo.id);
  if (!renglon) return res.status(404).json({ error: 'Renglón no encontrado' });
  const cantidad = Number(req.body?.cantidad);
  if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

  db.prepare('UPDATE apoyo_detalle SET cantidad = ?, importe = ? WHERE id = ?').run(
    cantidad, redondear(renglon.precio_costo * cantidad), renglon.id
  );
  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

router.delete('/:id/renglones/:renglon', requiereCentral, (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  db.prepare('DELETE FROM apoyo_detalle WHERE id = ? AND apoyo_id = ?').run(req.params.renglon, apoyo.id);
  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

router.put('/:id', requiereCentral, (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  db.prepare('UPDATE apoyos SET nota = ? WHERE id = ?').run((req.body?.nota || '').trim(), apoyo.id);
  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

// ---------- Enviar: la mercancía sale del inventario de la central ----------
router.post('/:id/enviar', requiereCentral, async (req, res) => {
  const apoyo = await cargarApoyoConInventarioCentral(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  const problema = verificarEdicion(apoyo, req.usuario);
  if (problema) return res.status(400).json({ error: problema });
  if (apoyo.renglones.length === 0) {
    return res.status(400).json({ error: 'El apoyo no tiene productos' });
  }

  const sinExistencia = apoyo.renglones.filter(
    (r) => r.usa_inventario && r.cantidad > r.existencia_origen
  );
  if (sinExistencia.length > 0) {
    return res.status(400).json({
      error:
        'No hay existencia suficiente en ' + apoyo.origen + ' de: ' +
        sinExistencia
          .map((r) => `${r.descripcion} (hay ${r.existencia_origen}, se mandan ${r.cantidad})`)
          .join('; '),
    });
  }

  db.transaction(() => {
    const asegurar = db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0) ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    );
    const descontar = db.prepare(
      'UPDATE inventario SET existencia = existencia - ? WHERE producto_id = ? AND sucursal_id = ?'
    );
    const movimiento = db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, 'salida', ?, ?, ?)`
    );
    const nota = `Apoyo folio ${apoyo.folio} enviado a ${apoyo.destino}`;
    for (const r of apoyo.renglones) {
      if (!r.usa_inventario) continue;
      asegurar.run(r.producto_id, apoyo.origen_id);
      descontar.run(r.cantidad, r.producto_id, apoyo.origen_id);
      movimiento.run(r.producto_id, apoyo.origen_id, r.cantidad, req.usuario.id, nota);
    }
    db.prepare(
      `UPDATE apoyos SET estado = 'enviado', enviado_por = ?, enviado = datetime('now', 'localtime'),
         nota = ? WHERE id = ?`
    ).run(req.usuario.id, (req.body?.nota ?? apoyo.nota ?? '').trim(), apoyo.id);

    // Si venía de un pedido, se marca lo que se le surtió
    if (apoyo.pedido_id) {
      const surtir = db.prepare(
        `UPDATE pedido_detalle SET cantidad_surtida = cantidad_surtida + ?
         WHERE pedido_id = ? AND producto_id = ?`
      );
      for (const r of apoyo.renglones) surtir.run(r.cantidad, apoyo.pedido_id, r.producto_id);
      db.prepare("UPDATE pedidos SET estado = 'surtido' WHERE id = ?").run(apoyo.pedido_id);
    }
  })();

  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

// ---------- Recibir: la sucursal revisa pieza por pieza ----------
router.post('/:id/recibir', (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  if (apoyo.destino_id !== req.usuario.sucursal_id) {
    return res.status(403).json({ error: 'Solo la farmacia que recibe puede confirmar el apoyo' });
  }
  if (apoyo.estado !== 'enviado') {
    return res.status(400).json({ error: 'Este apoyo no está pendiente de recibir' });
  }

  // Lo que no venga en el cuerpo se da por recibido completo
  const capturado = new Map(
    (Array.isArray(req.body?.renglones) ? req.body.renglones : []).map((r) => [
      Number(r.id), Number(r.cantidad_recibida),
    ])
  );
  const recibidas = [];
  for (const r of apoyo.renglones) {
    const cantidad = capturado.has(r.id) ? capturado.get(r.id) : r.cantidad;
    if (!Number.isFinite(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: `Cantidad recibida no válida en "${r.descripcion}"` });
    }
    if (cantidad > r.cantidad) {
      return res.status(400).json({
        error: `No puedes recibir más de lo que se mandó de "${r.descripcion}" (se mandaron ${r.cantidad})`,
      });
    }
    recibidas.push({ renglon: r, cantidad });
  }

  db.transaction(() => {
    const asegurar = db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0) ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    );
    const sumar = db.prepare(
      'UPDATE inventario SET existencia = existencia + ? WHERE producto_id = ? AND sucursal_id = ?'
    );
    const movimiento = db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, 'entrada', ?, ?, ?)`
    );
    const marcar = db.prepare('UPDATE apoyo_detalle SET cantidad_recibida = ? WHERE id = ?');
    const nota = `Apoyo folio ${apoyo.folio} recibido de ${apoyo.origen}`;
    for (const { renglon, cantidad } of recibidas) {
      marcar.run(cantidad, renglon.id);
      if (!renglon.usa_inventario || cantidad <= 0) continue;
      asegurar.run(renglon.producto_id, apoyo.destino_id);
      sumar.run(cantidad, renglon.producto_id, apoyo.destino_id);
      movimiento.run(renglon.producto_id, apoyo.destino_id, cantidad, req.usuario.id, nota);
    }
    db.prepare(
      `UPDATE apoyos SET estado = 'recibido', recibido_por = ?, recibido = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(req.usuario.id, apoyo.id);
  })();

  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

// ---------- Cancelar ----------
router.post('/:id/cancelar', requiereCentral, (req, res) => {
  const apoyo = cargarApoyo(req.params.id);
  if (!apoyo) return res.status(404).json({ error: 'Apoyo no encontrado' });
  if (apoyo.origen_id !== req.usuario.sucursal_id) {
    return res.status(403).json({ error: 'Este apoyo lo armó otra farmacia' });
  }
  if (apoyo.estado === 'recibido') {
    return res.status(400).json({ error: 'Este apoyo ya fue recibido, no se puede cancelar' });
  }
  if (apoyo.estado === 'cancelado') return res.json(cargarApoyo(apoyo.id));

  const motivo = (req.body?.motivo || '').trim();
  if (apoyo.estado === 'enviado' && !motivo) {
    return res.status(400).json({ error: 'Escribe el motivo de la cancelación' });
  }

  db.transaction(() => {
    // Si ya se había enviado, la mercancía regresa al inventario de la central
    if (apoyo.estado === 'enviado') {
      const sumar = db.prepare(
        'UPDATE inventario SET existencia = existencia + ? WHERE producto_id = ? AND sucursal_id = ?'
      );
      const movimiento = db.prepare(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
         VALUES (?, ?, 'entrada', ?, ?, ?)`
      );
      const nota = `Cancelación del apoyo folio ${apoyo.folio} a ${apoyo.destino}`;
      for (const r of apoyo.renglones) {
        if (!r.usa_inventario) continue;
        sumar.run(r.cantidad, r.producto_id, apoyo.origen_id);
        movimiento.run(r.producto_id, apoyo.origen_id, r.cantidad, req.usuario.id, nota);
      }
      if (apoyo.pedido_id) {
        const devolver = db.prepare(
          `UPDATE pedido_detalle SET cantidad_surtida = MAX(cantidad_surtida - ?, 0)
           WHERE pedido_id = ? AND producto_id = ?`
        );
        for (const r of apoyo.renglones) devolver.run(r.cantidad, apoyo.pedido_id, r.producto_id);
        db.prepare("UPDATE pedidos SET estado = 'enviado' WHERE id = ?").run(apoyo.pedido_id);
      }
    }
    db.prepare(
      `UPDATE apoyos SET estado = 'cancelado', cancelado_por = ?, cancelado = datetime('now', 'localtime'),
         motivo_cancelacion = ? WHERE id = ?`
    ).run(req.usuario.id, motivo, apoyo.id);
  })();

  publicarSinBloquear(apoyo.id);
  res.json(cargarApoyo(apoyo.id));
});

module.exports = router;
