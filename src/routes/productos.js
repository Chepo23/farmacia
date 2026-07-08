const express = require('express');
const db = require('../db');

const router = express.Router();

const camposProducto = `
  p.id, p.codigo_barras, p.descripcion, p.departamento, p.precio_costo,
  p.precio_venta, p.precio_mayoreo, p.cantidad_mayoreo, p.usa_inventario`;

function conExistencias(producto) {
  const existencias = db
    .prepare(
      `SELECT s.id AS sucursal_id, s.nombre AS sucursal, i.existencia, i.minimo
       FROM sucursales s
       LEFT JOIN inventario i ON i.sucursal_id = s.id AND i.producto_id = ?
       WHERE s.activa = 1
       ORDER BY s.id`
    )
    .all(producto.id)
    .map((e) => ({ ...e, existencia: e.existencia ?? 0, minimo: e.minimo ?? 0 }));
  return { ...producto, existencias };
}

// Buscar por código de barras exacto (pantalla de venta / escáner)
router.get('/codigo/:codigo', (req, res) => {
  const producto = db
    .prepare(`SELECT ${camposProducto} FROM productos p WHERE p.codigo_barras = ? AND p.activo = 1`)
    .get(req.params.codigo.trim());
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(conExistencias(producto));
});

// Buscar por descripción o código (F3)
router.get('/buscar', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const productos = db
    .prepare(
      `SELECT ${camposProducto},
              COALESCE((SELECT existencia FROM inventario i
                        WHERE i.producto_id = p.id AND i.sucursal_id = ?), 0) AS existencia_local
       FROM productos p
       WHERE p.activo = 1 AND (p.descripcion LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY p.descripcion LIMIT 50`
    )
    .all(req.usuario.sucursal_id, q, q);
  res.json(productos);
});

// Listado completo con existencias de todas las sucursales
router.get('/', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const productos = db
    .prepare(
      `SELECT ${camposProducto} FROM productos p
       WHERE p.activo = 1 AND (p.descripcion LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY p.descripcion LIMIT 200`
    )
    .all(q, q);
  res.json(productos.map(conExistencias));
});

function validarProducto(body) {
  const descripcion = (body.descripcion || '').trim();
  if (!descripcion) return { error: 'La descripción es obligatoria' };
  const precioVenta = Number(body.precio_venta);
  if (!(precioVenta >= 0)) return { error: 'Precio de venta no válido' };
  return {
    codigo_barras: (body.codigo_barras || '').trim() || null,
    descripcion,
    departamento: (body.departamento || '').trim(),
    precio_costo: Number(body.precio_costo) || 0,
    precio_venta: precioVenta,
    precio_mayoreo: body.precio_mayoreo ? Number(body.precio_mayoreo) : null,
    cantidad_mayoreo: body.cantidad_mayoreo ? Number(body.cantidad_mayoreo) : null,
    usa_inventario: body.usa_inventario === false ? 0 : 1,
  };
}

router.post('/', (req, res) => {
  const datos = validarProducto(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    const info = db
      .prepare(
        `INSERT INTO productos (codigo_barras, descripcion, departamento, precio_costo,
           precio_venta, precio_mayoreo, cantidad_mayoreo, usa_inventario)
         VALUES (@codigo_barras, @descripcion, @departamento, @precio_costo,
           @precio_venta, @precio_mayoreo, @cantidad_mayoreo, @usa_inventario)`
      )
      .run(datos);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ya existe un producto con ese código de barras' });
    }
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const datos = validarProducto(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    const info = db
      .prepare(
        `UPDATE productos SET codigo_barras = @codigo_barras, descripcion = @descripcion,
           departamento = @departamento, precio_costo = @precio_costo, precio_venta = @precio_venta,
           precio_mayoreo = @precio_mayoreo, cantidad_mayoreo = @cantidad_mayoreo,
           usa_inventario = @usa_inventario
         WHERE id = @id AND activo = 1`
      )
      .run({ ...datos, id: req.params.id });
    if (info.changes === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ya existe un producto con ese código de barras' });
    }
    throw e;
  }
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE productos SET activo = 0, codigo_barras = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Movimiento de inventario: entrada, salida o ajuste (fija existencia exacta)
router.post('/:id/inventario', (req, res) => {
  const { tipo, cantidad, minimo, nota } = req.body || {};
  const productoId = Number(req.params.id);
  const sucursalId = req.usuario.sucursal_id;
  const cant = Number(cantidad);

  const producto = db.prepare('SELECT id FROM productos WHERE id = ? AND activo = 1').get(productoId);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido' });
  }
  if (!Number.isFinite(cant) || (tipo !== 'ajuste' && cant <= 0)) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0) ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    ).run(productoId, sucursalId);
    if (tipo === 'entrada') {
      db.prepare(
        'UPDATE inventario SET existencia = existencia + ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    } else if (tipo === 'salida') {
      db.prepare(
        'UPDATE inventario SET existencia = existencia - ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    } else {
      db.prepare(
        'UPDATE inventario SET existencia = ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    }
    if (minimo !== undefined && minimo !== null && minimo !== '') {
      db.prepare(
        'UPDATE inventario SET minimo = ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(Number(minimo) || 0, productoId, sucursalId);
    }
    db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(productoId, sucursalId, tipo, cant, req.usuario.id, (nota || '').trim());
  })();

  res.json({ ok: true });
});

// Productos con existencia por debajo del mínimo en la sucursal del usuario
router.get('/bajo-minimo', (req, res) => {
  const filas = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.descripcion, i.existencia, i.minimo
       FROM inventario i JOIN productos p ON p.id = i.producto_id
       WHERE i.sucursal_id = ? AND p.activo = 1 AND p.usa_inventario = 1
         AND i.existencia <= i.minimo AND i.minimo > 0
       ORDER BY p.descripcion`
    )
    .all(req.usuario.sucursal_id);
  res.json(filas);
});

module.exports = router;
