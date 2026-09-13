// Pedidos de apoyo: lo que una sucursal le solicita a la farmacia central.
// Sustituye la lista escrita a mano que antes se mandaba por foto.
const express = require('express');
const db = require('../db');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');
const { publicarPedidoSinBloquear, descargarPedidos } = require('../sync/apoyos');

const router = express.Router();

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

function cargarPedido(id) {
  const pedido = db
    .prepare(
      `SELECT p.*, s.nombre AS sucursal, s.es_central, u.nombre AS creador
       FROM pedidos p
       JOIN sucursales s ON s.id = p.sucursal_id
       JOIN usuarios u ON u.id = p.creado_por
       WHERE p.id = ?`
    )
    .get(id);
  if (!pedido) return null;
  pedido.renglones = db
    .prepare('SELECT * FROM pedido_detalle WHERE pedido_id = ? ORDER BY id')
    .all(pedido.id);
  pedido.piezas = pedido.renglones.reduce((t, r) => t + r.cantidad, 0);
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

// ---------- Listado ----------
router.get('/', async (req, res) => {
  try { await descargarPedidos(); } catch (error) { console.error('No se pudieron descargar pedidos:', error.message); }
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
       JOIN usuarios u ON u.id = p.creado_por
       WHERE (p.sucursal_id = @suc OR (@central = 1 AND p.estado <> 'borrador'))
         AND p.estado <> 'cancelado'
       ORDER BY p.id DESC LIMIT 100`
    )
    .all({ suc: req.usuario.sucursal_id, central: req.usuario.es_central ? 1 : 0 });
  res.json(filas);
});

// Qué conviene pedir: lo que está en cero o bajo mínimo en mi sucursal,
// con lo vendido en la última semana para sugerir la cantidad
router.get('/sugerencias', (req, res) => {
  const filas = db
    .prepare(
      `SELECT p.id AS producto_id, p.codigo_barras, p.descripcion,
              i.existencia, i.minimo,
              COALESCE((SELECT SUM(d.cantidad) FROM venta_detalle d
                        JOIN ventas v ON v.id = d.venta_id
                        WHERE d.producto_id = p.id AND v.sucursal_id = @suc
                          AND v.fecha >= datetime('now', 'localtime', '-7 day')), 0) AS vendidos_semana
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       WHERE i.sucursal_id = @suc AND p.activo = 1 AND p.es_comun = 0 AND p.usa_inventario = 1
         AND (i.existencia <= 0 OR (i.minimo > 0 AND i.existencia <= i.minimo))
       ORDER BY (i.existencia <= 0) DESC, vendidos_semana DESC, p.descripcion
       LIMIT 200`
    )
    .all({ suc: req.usuario.sucursal_id });
  res.json(
    filas.map((f) => ({
      ...f,
      cantidad_sugerida: Math.max(1, Math.ceil(f.vendidos_semana) - Math.max(0, f.existencia)),
    }))
  );
});

// ---------- Abrir o crear el pedido en borrador de mi sucursal ----------
router.post('/', (req, res) => {
  if (req.usuario.es_central) {
    return res.status(400).json({ error: 'La farmacia central no pide apoyos, los envía' });
  }
  const abierto = db
    .prepare("SELECT id FROM pedidos WHERE sucursal_id = ? AND estado = 'borrador' ORDER BY id DESC")
    .get(req.usuario.sucursal_id);
  if (abierto) return res.json(cargarPedido(abierto.id));

  const folio = db
    .prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM pedidos WHERE sucursal_id = ?')
    .get(req.usuario.sucursal_id).f;
  const id = db
    .prepare('INSERT INTO pedidos (folio, sucursal_id, creado_por) VALUES (?, ?, ?)')
    .run(folio, req.usuario.sucursal_id, req.usuario.id).lastInsertRowid;
  publicarPedidoSinBloquear(id);
  res.json(cargarPedido(id));
});

router.get('/:id', (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeVer(pedido, req.usuario)) return res.status(403).json({ error: 'Ese pedido no es de tu farmacia' });
  res.json(pedido);
});

// ---------- Renglones ----------
router.post('/:id/renglones', async (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  const producto = await buscarProducto(req.body || {});
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const cantidad = Number(req.body.cantidad ?? 1);
  if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

  const productoLocal = asegurarProductoLocal(producto);
  const existente = db
    .prepare('SELECT * FROM pedido_detalle WHERE pedido_id = ? AND producto_id = ?')
    .get(pedido.id, productoLocal.id);
  if (existente) {
    db.prepare('UPDATE pedido_detalle SET cantidad = cantidad + ? WHERE id = ?').run(cantidad, existente.id);
  } else {
    db.prepare(
      `INSERT INTO pedido_detalle (pedido_id, producto_id, codigo_barras, descripcion, cantidad)
       VALUES (?, ?, ?, ?, ?)`
    ).run(pedido.id, productoLocal.id, productoLocal.codigo_barras, productoLocal.descripcion, cantidad);
  }
  publicarPedidoSinBloquear(pedido.id);
  res.json(cargarPedido(pedido.id));
});

router.put('/:id/renglones/:renglon', (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  const cantidad = Number(req.body?.cantidad);
  if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });
  const info = db
    .prepare('UPDATE pedido_detalle SET cantidad = ? WHERE id = ? AND pedido_id = ?')
    .run(cantidad, req.params.renglon, pedido.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Renglón no encontrado' });
  publicarPedidoSinBloquear(pedido.id);
  res.json(cargarPedido(pedido.id));
});

router.delete('/:id/renglones/:renglon', (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Solo se puede modificar un pedido en borrador de tu farmacia' });
  }
  db.prepare('DELETE FROM pedido_detalle WHERE id = ? AND pedido_id = ?').run(req.params.renglon, pedido.id);
  publicarPedidoSinBloquear(pedido.id);
  res.json(cargarPedido(pedido.id));
});

// ---------- Enviar el pedido a la central ----------
router.post('/:id/enviar', (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!puedeEditar(pedido, req.usuario)) {
    return res.status(400).json({ error: 'Este pedido ya fue enviado' });
  }
  if (pedido.renglones.length === 0) {
    return res.status(400).json({ error: 'El pedido no tiene productos' });
  }
  db.prepare(
    `UPDATE pedidos SET estado = 'enviado', enviado_por = ?, enviado = datetime('now', 'localtime'), nota = ?
     WHERE id = ?`
  ).run(req.usuario.id, (req.body?.nota || pedido.nota || '').trim(), pedido.id);
  publicarPedidoSinBloquear(pedido.id);
  res.json(cargarPedido(pedido.id));
});

router.post('/:id/cancelar', (req, res) => {
  const pedido = cargarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (pedido.sucursal_id !== req.usuario.sucursal_id) {
    return res.status(403).json({ error: 'Ese pedido no es de tu farmacia' });
  }
  if (pedido.estado === 'surtido') {
    return res.status(400).json({ error: 'Este pedido ya fue surtido con un apoyo' });
  }
  db.prepare("UPDATE pedidos SET estado = 'cancelado' WHERE id = ?").run(pedido.id);
  publicarPedidoSinBloquear(pedido.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.router = router;
module.exports.puedeEditar = puedeEditar;
