const express = require('express');
const db = require('../db');

const router = express.Router();

function fechaUltimoCorte(sucursalId) {
  return (
    db.prepare('SELECT MAX(fecha) AS f FROM cortes WHERE sucursal_id = ?').get(sucursalId).f ||
    '1900-01-01 00:00:00'
  );
}

// Resumen de lo vendido desde el último corte (para la pantalla de corte)
function resumenPendiente(sucursalId) {
  const ventas = db
    .prepare(
      `SELECT forma_pago, COUNT(*) AS num, COALESCE(SUM(total), 0) AS total
       FROM ventas WHERE sucursal_id = ? AND corte_id IS NULL
       GROUP BY forma_pago`
    )
    .all(sucursalId);
  const porForma = { efectivo: 0, tarjeta: 0, credito: 0 };
  let numVentas = 0;
  for (const v of ventas) {
    porForma[v.forma_pago] = v.total;
    numVentas += v.num;
  }
  const abonos = db
    .prepare(
      'SELECT COALESCE(SUM(monto), 0) AS total FROM abonos WHERE sucursal_id = ? AND fecha > ?'
    )
    .get(sucursalId, fechaUltimoCorte(sucursalId)).total;
  return { ...porForma, abonos, num_ventas: numVentas };
}

router.get('/pendiente', (req, res) => {
  res.json(resumenPendiente(req.usuario.sucursal_id));
});

router.post('/', (req, res) => {
  const sucursalId = req.usuario.sucursal_id;
  const fondo = Number(req.body?.fondo_caja) || 0;
  const contado = Number(req.body?.efectivo_contado) || 0;
  const resumen = resumenPendiente(sucursalId);

  if (resumen.num_ventas === 0 && resumen.abonos === 0) {
    return res.status(400).json({ error: 'No hay ventas ni abonos pendientes de corte' });
  }

  const esperado = fondo + resumen.efectivo + resumen.abonos;
  const diferencia = Math.round((contado - esperado) * 100) / 100;

  const corteId = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO cortes (sucursal_id, usuario_id, fondo_caja, total_efectivo, total_tarjeta,
           total_credito, num_ventas, efectivo_contado, diferencia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sucursalId, req.usuario.id, fondo,
        resumen.efectivo + resumen.abonos, resumen.tarjeta, resumen.credito,
        resumen.num_ventas, contado, diferencia
      ).lastInsertRowid;
    db.prepare('UPDATE ventas SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    return id;
  })();

  res.json({ ok: true, id: corteId, esperado, diferencia });
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
