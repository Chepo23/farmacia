const express = require('express');
const db = require('../db');

const router = express.Router();

function fechaUltimoCorte(sucursalId) {
  return (
    db.prepare('SELECT MAX(fecha) AS f FROM cortes WHERE sucursal_id = ?').get(sucursalId).f ||
    '1900-01-01 00:00:00'
  );
}

// Última apertura de caja de la sucursal aún sin corte (para el fondo del corte)
function aperturaActual(sucursalId) {
  return db
    .prepare(
      `SELECT * FROM aperturas_caja
       WHERE sucursal_id = ? AND corte_id IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(sucursalId);
}

// Apertura registrada en ESTA sesión: cada inicio de sesión debe capturar la suya
function aperturaDeSesion(token) {
  return db
    .prepare(
      `SELECT a.* FROM sesiones se
       JOIN aperturas_caja a ON a.id = se.apertura_id
       WHERE se.token = ?`
    )
    .get(token);
}

// Consultar la apertura de la sesión (para saber si hay que pedirla al entrar)
router.get('/apertura', (req, res) => {
  res.json(aperturaDeSesion(req.sesionToken) || null);
});

// Registrar la apertura de caja: fondo y tipo de cambio peso/dólar
router.post('/apertura', (req, res) => {
  const existente = aperturaDeSesion(req.sesionToken);
  if (existente) return res.json(existente);

  const fondo = Number(req.body?.fondo_caja);
  const tipoCambio = Number(req.body?.tipo_cambio);
  if (!(fondo >= 0)) return res.status(400).json({ error: 'Fondo de caja no válido' });
  if (!(tipoCambio > 0)) return res.status(400).json({ error: 'Tipo de cambio no válido' });

  const id = db.transaction(() => {
    const aperturaId = db
      .prepare(
        'INSERT INTO aperturas_caja (sucursal_id, usuario_id, fondo_caja, tipo_cambio) VALUES (?, ?, ?, ?)'
      )
      .run(req.usuario.sucursal_id, req.usuario.id, fondo, tipoCambio).lastInsertRowid;
    db.prepare('UPDATE sesiones SET apertura_id = ? WHERE token = ?').run(aperturaId, req.sesionToken);
    return aperturaId;
  })();
  res.json(db.prepare('SELECT * FROM aperturas_caja WHERE id = ?').get(id));
});

// Resumen de lo vendido desde el último corte (para la pantalla de corte).
// El pago mixto se reparte entre efectivo y tarjeta; el dólar se reporta aparte.
function resumenPendiente(sucursalId) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS num_ventas,
         COALESCE(SUM(CASE WHEN forma_pago = 'efectivo' THEN total
                           WHEN forma_pago = 'mixto' THEN pago_efectivo END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN forma_pago = 'tarjeta' THEN total
                           WHEN forma_pago = 'mixto' THEN pago_tarjeta END), 0) AS tarjeta,
         COALESCE(SUM(CASE WHEN forma_pago = 'credito' THEN total END), 0) AS credito,
         COALESCE(SUM(CASE WHEN forma_pago = 'dolar' THEN total END), 0) AS dolares
       FROM ventas WHERE sucursal_id = ? AND corte_id IS NULL`
    )
    .get(sucursalId);
  const abonos = db
    .prepare(
      'SELECT COALESCE(SUM(monto), 0) AS total FROM abonos WHERE sucursal_id = ? AND fecha > ?'
    )
    .get(sucursalId, fechaUltimoCorte(sucursalId)).total;
  return { ...r, abonos };
}

router.get('/pendiente', (req, res) => {
  const apertura = aperturaActual(req.usuario.sucursal_id);
  res.json({ ...resumenPendiente(req.usuario.sucursal_id), fondo_caja: apertura ? apertura.fondo_caja : 0 });
});

router.post('/', (req, res) => {
  const sucursalId = req.usuario.sucursal_id;
  const apertura = aperturaActual(sucursalId);
  const fondo = apertura ? apertura.fondo_caja : 0;
  const resumen = resumenPendiente(sucursalId);

  if (resumen.num_ventas === 0 && resumen.abonos === 0) {
    return res.status(400).json({ error: 'No hay ventas ni abonos pendientes de corte' });
  }

  const esperado = fondo + resumen.efectivo + resumen.abonos;

  const corteId = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO cortes (sucursal_id, usuario_id, fondo_caja, total_efectivo, total_tarjeta,
           total_credito, total_dolares, num_ventas, efectivo_contado, diferencia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
      )
      .run(
        sucursalId, req.usuario.id, fondo,
        resumen.efectivo + resumen.abonos, resumen.tarjeta, resumen.credito, resumen.dolares,
        resumen.num_ventas
      ).lastInsertRowid;
    db.prepare('UPDATE ventas SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    // La apertura queda ligada al corte: al volver a entrar se pedirá una nueva
    db.prepare('UPDATE aperturas_caja SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    return id;
  })();

  res.json({ ok: true, id: corteId, esperado });
});

router.get('/', (req, res) => {
  const cortes = db
    .prepare(
      `SELECT co.*, u.nombre AS usuario, s.nombre AS sucursal
       FROM cortes co
       JOIN usuarios u ON u.id = co.usuario_id
       JOIN sucursales s ON s.id = co.sucursal_id
       WHERE co.sucursal_id = ?
       ORDER BY co.id DESC LIMIT 60`
    )
    .all(req.usuario.rol === 'admin' && req.query.sucursal_id ? req.query.sucursal_id : req.usuario.sucursal_id);
  res.json(cortes);
});

module.exports = router;
