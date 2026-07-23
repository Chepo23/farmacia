const express = require('express');
const db = require('../db');

const router = express.Router();

const consultaSaldo = `
  COALESCE((SELECT SUM(total) FROM ventas v WHERE v.cliente_id = c.id AND v.forma_pago = 'credito'), 0)
  - COALESCE((SELECT SUM(monto) FROM abonos a WHERE a.cliente_id = c.id), 0) AS saldo`;

router.get('/', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const clientes = db
    .prepare(
      `SELECT c.id, c.nombre, c.telefono, c.limite_credito, c.notas, c.credito_autorizado, c.sucursal_id,
              s.nombre AS sucursal, ${consultaSaldo}
       FROM clientes c JOIN sucursales s ON s.id = c.sucursal_id
       WHERE c.activo = 1 AND (c.nombre LIKE ? OR c.telefono LIKE ?)
       ORDER BY c.nombre LIMIT 200`
    )
    .all(q, q);
  res.json(clientes);
});

router.post('/', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const info = db
    .prepare(
      'INSERT INTO clientes (nombre, telefono, limite_credito, notas, credito_autorizado, sucursal_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      nombre, (req.body.telefono || '').trim(), Number(req.body.limite_credito) || 0,
      (req.body.notas || '').trim(), req.body.credito_autorizado ? 1 : 0, req.usuario.sucursal_id
    );
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const info = db
    .prepare(
      'UPDATE clientes SET nombre = ?, telefono = ?, limite_credito = ?, notas = ?, credito_autorizado = ? WHERE id = ? AND activo = 1'
    )
    .run(
      nombre, (req.body.telefono || '').trim(), Number(req.body.limite_credito) || 0,
      (req.body.notas || '').trim(), req.body.credito_autorizado ? 1 : 0, req.params.id
    );
  if (info.changes === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE clientes SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Estado de cuenta: ventas a crédito y abonos
router.get('/:id/estado', (req, res) => {
  const cliente = db
    .prepare(`SELECT c.*, ${consultaSaldo} FROM clientes c WHERE c.id = ? AND c.activo = 1`)
    .get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const cargos = db
    .prepare(
      `SELECT id, folio, fecha, total FROM ventas
       WHERE cliente_id = ? AND forma_pago = 'credito' ORDER BY fecha DESC LIMIT 100`
    )
    .all(cliente.id);
  // Productos comprados en cada venta a crédito
  const buscarPartidas = db.prepare(
    'SELECT descripcion, cantidad, precio_unitario, importe FROM venta_detalle WHERE venta_id = ?'
  );
  for (const cargo of cargos) cargo.partidas = buscarPartidas.all(cargo.id);
  const abonos = db
    .prepare('SELECT id, fecha, monto, nota FROM abonos WHERE cliente_id = ? ORDER BY fecha DESC LIMIT 100')
    .all(cliente.id);
  res.json({ ...cliente, cargos, abonos });
});

router.post('/:id/abonos', (req, res) => {
  const monto = Number(req.body?.monto);
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto no válido' });
  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ? AND activo = 1').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.prepare(
    'INSERT INTO abonos (cliente_id, sucursal_id, usuario_id, monto, nota) VALUES (?, ?, ?, ?, ?)'
  ).run(cliente.id, req.usuario.sucursal_id, req.usuario.id, monto, (req.body.nota || '').trim());
  res.json({ ok: true });
});

module.exports = router;
