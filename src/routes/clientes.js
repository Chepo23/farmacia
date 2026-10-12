// Clientes con crédito (fiado): compras a crédito, abonos y estado de cuenta.
// Las ventas canceladas no cuentan en el saldo.
const express = require('express');
const db = require('../db');
const { aperturaVigente } = require('../caja');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

const consultaSaldo = `
  ROUND(COALESCE((SELECT SUM(total) FROM ventas v
                  WHERE v.cliente_id = c.id AND v.forma_pago = 'credito' AND v.cancelada = 0), 0)
      - COALESCE((SELECT SUM(monto) FROM abonos a WHERE a.cliente_id = c.id), 0), 2) AS saldo`;

function saldoDe(clienteId) {
  return db.prepare(`SELECT ${consultaSaldo} FROM clientes c WHERE c.id = ?`).get(clienteId)?.saldo ?? 0;
}

function validarCliente(body) {
  const nombre = String(body?.nombre || '').trim();
  if (!nombre) return { error: 'El nombre es obligatorio' };
  if (nombre.length > 120) return { error: 'El nombre es demasiado largo' };
  const limite = body.limite_credito === '' || body.limite_credito == null ? 0 : Number(body.limite_credito);
  if (!Number.isFinite(limite) || limite < 0) return { error: 'El límite de crédito no es válido' };
  return {
    nombre,
    telefono: String(body.telefono || '').trim().slice(0, 40),
    limite_credito: redondear(limite),
    notas: String(body.notas || '').trim().slice(0, 500),
    credito_autorizado: body.credito_autorizado ? 1 : 0,
  };
}

router.get('/', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const clientes = db
    .prepare(
      `SELECT c.id, c.nombre, c.telefono, c.limite_credito, c.notas, c.credito_autorizado, c.sucursal_id,
              s.nombre AS sucursal, ${consultaSaldo},
              (SELECT MAX(fecha) FROM abonos a WHERE a.cliente_id = c.id) AS ultimo_abono
       FROM clientes c JOIN sucursales s ON s.id = c.sucursal_id
       WHERE c.activo = 1 AND (c.nombre LIKE ? OR c.telefono LIKE ?)
       ORDER BY c.nombre LIMIT 300`
    )
    .all(q, q)
    .map((c) => ({
      ...c,
      credito_disponible: c.limite_credito > 0 ? redondear(Math.max(c.limite_credito - c.saldo, 0)) : null,
    }));
  res.json(clientes);
});

router.post('/', (req, res) => {
  const datos = validarCliente(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });
  const info = db
    .prepare(
      `INSERT INTO clientes (nombre, telefono, limite_credito, notas, credito_autorizado, sucursal_id)
       VALUES (@nombre, @telefono, @limite_credito, @notas, @credito_autorizado, @sucursal_id)`
    )
    .run({ ...datos, sucursal_id: req.usuario.sucursal_id });
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const datos = validarCliente(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });
  const info = db
    .prepare(
      `UPDATE clientes SET nombre = @nombre, telefono = @telefono, limite_credito = @limite_credito,
         notas = @notas, credito_autorizado = @credito_autorizado
       WHERE id = @id AND activo = 1`
    )
    .run({ ...datos, id: Number(req.params.id) });
  if (info.changes === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ? AND activo = 1').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const saldo = saldoDe(cliente.id);
  if (saldo > 0.005) {
    return res.status(400).json({ error: `El cliente todavía debe $${saldo.toFixed(2)}; no se puede dar de baja` });
  }
  db.prepare('UPDATE clientes SET activo = 0 WHERE id = ?').run(cliente.id);
  res.json({ ok: true });
});

// Estado de cuenta: compras a crédito y abonos, con el saldo después de cada movimiento
router.get('/:id/estado', (req, res) => {
  const cliente = db
    .prepare(
      `SELECT c.*, s.nombre AS sucursal, ${consultaSaldo}
       FROM clientes c JOIN sucursales s ON s.id = c.sucursal_id
       WHERE c.id = ? AND c.activo = 1`
    )
    .get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const cargos = db
    .prepare(
      `SELECT v.id, v.folio, v.fecha, v.total, s.nombre AS sucursal, u.nombre AS cajero
       FROM ventas v JOIN sucursales s ON s.id = v.sucursal_id JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.cliente_id = ? AND v.forma_pago = 'credito' AND v.cancelada = 0
       ORDER BY v.fecha, v.id`
    )
    .all(cliente.id);
  const buscarPartidas = db.prepare(
    'SELECT descripcion, cantidad, precio_unitario, importe FROM venta_detalle WHERE venta_id = ? ORDER BY id'
  );
  for (const cargo of cargos) cargo.partidas = buscarPartidas.all(cargo.id);

  const abonos = db
    .prepare(
      `SELECT a.id, a.fecha, a.monto, a.nota, a.forma_pago, a.saldo_anterior, a.saldo_nuevo, u.nombre AS cajero
       FROM abonos a JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.cliente_id = ? ORDER BY a.fecha, a.id`
    )
    .all(cliente.id);

  // Movimientos en orden cronológico con saldo acumulado (el mismo instante: primero la compra)
  const orden = { cargo: 0, abono: 1 };
  const conceptoAbono = (a) => {
    const partes = [a.forma_pago === 'tarjeta' ? 'Abono con tarjeta' : 'Abono'];
    if (a.nota) partes.push(a.nota);
    return partes.join(' — ');
  };
  const movimientos = [
    ...cargos.map((v) => ({ fecha: v.fecha, tipo: 'cargo', concepto: `Compra folio ${v.folio}`, folio: v.folio, venta_id: v.id, cargo: v.total, abono: 0, partidas: v.partidas })),
    ...abonos.map((a) => ({ fecha: a.fecha, tipo: 'abono', concepto: conceptoAbono(a), abono_id: a.id, cargo: 0, abono: a.monto })),
  ].sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)) || orden[x.tipo] - orden[y.tipo]);
  let saldo = 0;
  for (const m of movimientos) {
    saldo = redondear(saldo + m.cargo - m.abono);
    m.saldo = saldo;
  }

  res.json({
    ...cliente,
    credito_disponible: cliente.limite_credito > 0 ? redondear(Math.max(cliente.limite_credito - cliente.saldo, 0)) : null,
    total_cargos: redondear(cargos.reduce((t, v) => t + v.total, 0)),
    total_abonos: redondear(abonos.reduce((t, a) => t + a.monto, 0)),
    // Las listas cronológicas más recientes primero, como antes
    cargos: [...cargos].reverse(),
    abonos: [...abonos].reverse(),
    movimientos,
  });
});

function cargarAbono(id) {
  return db
    .prepare(
      `SELECT a.*, c.nombre AS cliente, c.telefono AS cliente_telefono, u.nombre AS cajero,
              s.nombre AS sucursal, s.direccion, s.telefono
       FROM abonos a
       JOIN clientes c ON c.id = a.cliente_id
       JOIN usuarios u ON u.id = a.usuario_id
       JOIN sucursales s ON s.id = a.sucursal_id
       WHERE a.id = ?`
    )
    .get(id);
}

router.post('/:id/abonos', (req, res) => {
  const monto = redondear(req.body?.monto);
  if (!(monto > 0)) return res.status(400).json({ error: 'Monto no válido' });
  const formaPago = req.body?.forma_pago === 'tarjeta' ? 'tarjeta' : 'efectivo';
  const cliente = db.prepare('SELECT id FROM clientes WHERE id = ? AND activo = 1').get(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (formaPago === 'efectivo' && !aperturaVigente(req.sesionToken, req.usuario.sucursal_id)) {
    return res.status(400).json({ error: 'Registra la apertura de caja antes de recibir abonos en efectivo' });
  }

  const id = db.transaction(() => {
    const saldoAnterior = saldoDe(cliente.id);
    if (saldoAnterior <= 0.005) throw Object.assign(new Error('El cliente no tiene saldo pendiente'), { status: 400 });
    if (monto > saldoAnterior + 0.005) {
      throw Object.assign(new Error(`El abono es mayor que lo que debe el cliente ($${saldoAnterior.toFixed(2)})`), { status: 400 });
    }
    return db
      .prepare(
        `INSERT INTO abonos (cliente_id, sucursal_id, usuario_id, monto, nota, forma_pago, saldo_anterior, saldo_nuevo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(cliente.id, req.usuario.sucursal_id, req.usuario.id, monto, String(req.body?.nota || '').trim().slice(0, 200),
        formaPago, saldoAnterior, redondear(saldoAnterior - monto)).lastInsertRowid;
  });
  try {
    const abonoId = id();
    res.json({ ok: true, abono: cargarAbono(abonoId) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

// Para reimprimir el comprobante de un abono
router.get('/:id/abonos/:abono', (req, res) => {
  const abono = cargarAbono(req.params.abono);
  if (!abono || abono.cliente_id !== Number(req.params.id)) return res.status(404).json({ error: 'Abono no encontrado' });
  res.json(abono);
});

module.exports = router;
