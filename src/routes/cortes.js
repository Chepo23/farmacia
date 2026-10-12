// Apertura y corte de caja.
// Efectivo esperado = fondo + ventas en efectivo (y la parte en efectivo de las mixtas)
//   + abonos en efectivo + entradas de efectivo - salidas de efectivo
//   - cambio en pesos entregado en ventas pagadas con dólares.
// Los dólares recibidos se cuentan aparte. Las ventas canceladas no suman.
const express = require('express');
const db = require('../db');
const { manejar } = require('../central');
const { aperturaActual, aperturaVigente } = require('../caja');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Apertura con la que trabaja la sesión (si la caja ya se abrió hoy, se une a ese turno)
router.get('/apertura', (req, res) => {
  res.json(aperturaVigente(req.sesionToken, req.usuario.sucursal_id) || null);
});

// Registrar la apertura de caja: fondo y tipo de cambio peso/dólar
router.post('/apertura', (req, res) => {
  const existente = aperturaVigente(req.sesionToken, req.usuario.sucursal_id);
  if (existente) return res.json(existente);

  const fondo = Number(req.body?.fondo_caja);
  const tipoCambio = Number(req.body?.tipo_cambio);
  if (req.body?.fondo_caja === '' || !Number.isFinite(fondo) || fondo < 0) {
    return res.status(400).json({ error: 'Fondo de caja no válido' });
  }
  if (!Number.isFinite(tipoCambio) || !(tipoCambio > 0) || tipoCambio > 1000) {
    return res.status(400).json({ error: 'Tipo de cambio no válido' });
  }

  const id = db.transaction(() => {
    const aperturaId = db
      .prepare('INSERT INTO aperturas_caja (sucursal_id, usuario_id, fondo_caja, tipo_cambio) VALUES (?, ?, ?, ?)')
      .run(req.usuario.sucursal_id, req.usuario.id, redondear(fondo), tipoCambio).lastInsertRowid;
    db.prepare('UPDATE sesiones SET apertura_id = ? WHERE token = ?').run(aperturaId, req.sesionToken);
    return aperturaId;
  })();
  res.json(db.prepare('SELECT * FROM aperturas_caja WHERE id = ?').get(id));
});

// Todo lo pendiente de corte de una sucursal
function resumenPendiente(sucursalId) {
  const ventas = db
    .prepare(
      `SELECT COUNT(*) AS num_ventas,
         COALESCE(SUM(total), 0) AS total_vendido,
         COALESCE(SUM(CASE WHEN forma_pago = 'efectivo' THEN total
                           WHEN forma_pago = 'mixto' THEN pago_efectivo END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN forma_pago = 'tarjeta' THEN total
                           WHEN forma_pago = 'mixto' THEN pago_tarjeta END), 0) AS tarjeta,
         COALESCE(SUM(CASE WHEN forma_pago = 'credito' THEN total END), 0) AS credito,
         COALESCE(SUM(CASE WHEN forma_pago = 'dolar' THEN total END), 0) AS dolares,
         COALESCE(SUM(CASE WHEN forma_pago = 'dolar' THEN pago_usd END), 0) AS usd_recibidos,
         COALESCE(SUM(CASE WHEN forma_pago = 'dolar' THEN cambio END), 0) AS cambio_dolares
       FROM ventas WHERE sucursal_id = ? AND corte_id IS NULL AND cancelada = 0`
    )
    .get(sucursalId);
  const canceladas = db
    .prepare(
      `SELECT COUNT(*) AS num, COALESCE(SUM(total), 0) AS total
       FROM ventas WHERE sucursal_id = ? AND corte_id IS NULL AND cancelada = 1`
    )
    .get(sucursalId);
  const abonos = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN forma_pago = 'tarjeta' THEN 0 ELSE monto END), 0) AS efectivo,
              COALESCE(SUM(CASE WHEN forma_pago = 'tarjeta' THEN monto ELSE 0 END), 0) AS tarjeta,
              COUNT(*) AS num
       FROM abonos WHERE sucursal_id = ? AND corte_id IS NULL`
    )
    .get(sucursalId);
  const caja = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN monto ELSE 0 END), 0) AS entradas,
              COALESCE(SUM(CASE WHEN tipo = 'salida' THEN monto ELSE 0 END), 0) AS salidas
       FROM movimientos_caja WHERE sucursal_id = ? AND corte_id IS NULL`
    )
    .get(sucursalId);
  const porCajero = db
    .prepare(
      `SELECT u.nombre AS cajero, COUNT(*) AS num_ventas, COALESCE(SUM(v.total), 0) AS total
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.sucursal_id = ? AND v.corte_id IS NULL AND v.cancelada = 0
       GROUP BY v.usuario_id ORDER BY total DESC`
    )
    .all(sucursalId);
  const apertura = aperturaActual(sucursalId);
  const fondo = apertura ? Number(apertura.fondo_caja) : 0;
  const efectivoEsperado = fondo + ventas.efectivo + abonos.efectivo + caja.entradas - caja.salidas - ventas.cambio_dolares;
  return {
    num_ventas: ventas.num_ventas,
    total_vendido: redondear(ventas.total_vendido),
    efectivo: redondear(ventas.efectivo),
    tarjeta: redondear(ventas.tarjeta),
    credito: redondear(ventas.credito),
    dolares: redondear(ventas.dolares),
    usd_recibidos: redondear(ventas.usd_recibidos),
    cambio_dolares: redondear(ventas.cambio_dolares),
    abonos: redondear(abonos.efectivo + abonos.tarjeta),
    abonos_efectivo: redondear(abonos.efectivo),
    abonos_tarjeta: redondear(abonos.tarjeta),
    num_abonos: abonos.num,
    entradas_efectivo: redondear(caja.entradas),
    salidas_efectivo: redondear(caja.salidas),
    num_canceladas: canceladas.num,
    total_canceladas: redondear(canceladas.total),
    fondo_caja: redondear(fondo),
    tipo_cambio: apertura ? Number(apertura.tipo_cambio) : 0,
    apertura_fecha: apertura ? apertura.fecha : null,
    efectivo_esperado: redondear(efectivoEsperado),
    por_cajero: porCajero.map((c) => ({ ...c, total: redondear(c.total) })),
  };
}

router.get('/pendiente', (req, res) => {
  res.json(resumenPendiente(req.usuario.sucursal_id));
});

// ---------- Entradas y salidas de efectivo (pago a proveedor, retiro, morralla) ----------
router.get('/movimientos', (req, res) => {
  const filas = db
    .prepare(
      `SELECT m.id, m.tipo, m.monto, m.concepto, m.fecha, u.nombre AS usuario
       FROM movimientos_caja m JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.sucursal_id = ? AND m.corte_id IS NULL ORDER BY m.id DESC`
    )
    .all(req.usuario.sucursal_id);
  res.json(filas);
});

router.post('/movimientos', (req, res) => {
  const tipo = String(req.body?.tipo || '');
  const monto = Number(req.body?.monto);
  const concepto = String(req.body?.concepto || '').trim().slice(0, 200);
  if (!['entrada', 'salida'].includes(tipo)) return res.status(400).json({ error: 'Indica si es entrada o salida de efectivo' });
  if (!Number.isFinite(monto) || !(monto > 0)) return res.status(400).json({ error: 'Monto no válido' });
  if (!concepto) return res.status(400).json({ error: 'Escribe el concepto (por ejemplo: pago a proveedor)' });
  if (!aperturaActual(req.usuario.sucursal_id)) return res.status(400).json({ error: 'La caja no tiene apertura' });
  if (tipo === 'salida') {
    const disponible = resumenPendiente(req.usuario.sucursal_id).efectivo_esperado;
    if (monto > disponible + 0.005) {
      return res.status(400).json({ error: `No hay tanto efectivo en caja (se esperan ${disponible.toFixed(2)})` });
    }
  }
  const id = db
    .prepare('INSERT INTO movimientos_caja (sucursal_id, usuario_id, tipo, monto, concepto) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.sucursal_id, req.usuario.id, tipo, redondear(monto), concepto).lastInsertRowid;
  res.json({ ok: true, id, resumen: resumenPendiente(req.usuario.sucursal_id) });
});

// ---------- Corte ----------
function cargarCorte(id) {
  const corte = db
    .prepare(
      `SELECT co.*, u.nombre AS usuario, s.nombre AS sucursal, s.direccion, s.telefono
       FROM cortes co
       JOIN usuarios u ON u.id = co.usuario_id
       JOIN sucursales s ON s.id = co.sucursal_id
       WHERE co.id = ?`
    )
    .get(id);
  if (!corte) return null;
  corte.movimientos_caja = db
    .prepare(
      `SELECT m.tipo, m.monto, m.concepto, m.fecha, u.nombre AS usuario
       FROM movimientos_caja m JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.corte_id = ? ORDER BY m.id`
    )
    .all(corte.id);
  corte.por_cajero = db
    .prepare(
      `SELECT u.nombre AS cajero, COUNT(*) AS num_ventas, COALESCE(SUM(v.total), 0) AS total
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.corte_id = ? AND v.cancelada = 0
       GROUP BY v.usuario_id ORDER BY total DESC`
    )
    .all(corte.id);
  corte.apertura = db.prepare('SELECT fecha, fondo_caja, tipo_cambio FROM aperturas_caja WHERE corte_id = ? ORDER BY id LIMIT 1').get(corte.id) || null;
  return corte;
}

router.post('/', manejar(async (req, res) => {
  const sucursalId = req.usuario.sucursal_id;
  const resumen = resumenPendiente(sucursalId);
  const hayApertura = Boolean(aperturaActual(sucursalId));
  const hayAlgo = resumen.num_ventas > 0 || resumen.num_canceladas > 0 || resumen.num_abonos > 0
    || resumen.entradas_efectivo > 0 || resumen.salidas_efectivo > 0;
  if (!hayAlgo && !hayApertura) {
    return res.status(400).json({ error: 'No hay ventas, abonos ni caja abierta pendientes de corte' });
  }
  const contado = Number(req.body?.efectivo_contado);
  if (req.body?.efectivo_contado === '' || req.body?.efectivo_contado == null || !Number.isFinite(contado) || contado < 0) {
    return res.status(400).json({ error: 'Cuenta el efectivo de la caja y escribe cuánto hay' });
  }
  const usdContado = req.body?.usd_contado === '' || req.body?.usd_contado == null ? resumen.usd_recibidos : Number(req.body.usd_contado);
  if (!Number.isFinite(usdContado) || usdContado < 0) return res.status(400).json({ error: 'Dólares contados no válidos' });
  const diferencia = redondear(contado - resumen.efectivo_esperado);

  const corteId = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO cortes (sucursal_id, usuario_id, fondo_caja, total_efectivo, total_tarjeta, total_credito,
           total_dolares, num_ventas, efectivo_contado, diferencia, total_abonos, abonos_tarjeta, total_usd,
           cambio_dolares, entradas_efectivo, salidas_efectivo, efectivo_esperado, usd_contado,
           num_canceladas, total_canceladas, tipo_cambio, nota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sucursalId, req.usuario.id, resumen.fondo_caja, resumen.efectivo, resumen.tarjeta, resumen.credito,
        resumen.dolares, resumen.num_ventas, redondear(contado), diferencia, resumen.abonos, resumen.abonos_tarjeta,
        resumen.usd_recibidos, resumen.cambio_dolares, resumen.entradas_efectivo, resumen.salidas_efectivo,
        resumen.efectivo_esperado, redondear(usdContado), resumen.num_canceladas, resumen.total_canceladas,
        resumen.tipo_cambio, String(req.body?.nota || '').trim().slice(0, 300)
      ).lastInsertRowid;
    db.prepare('UPDATE ventas SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    db.prepare('UPDATE abonos SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    db.prepare('UPDATE movimientos_caja SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    // La apertura queda ligada al corte: al volver a entrar se pedirá una nueva
    db.prepare('UPDATE aperturas_caja SET corte_id = ? WHERE sucursal_id = ? AND corte_id IS NULL').run(id, sucursalId);
    return id;
  })();

  res.json({ ok: true, id: corteId, esperado: resumen.efectivo_esperado, diferencia, corte: cargarCorte(corteId) });
}));

router.get('/', (req, res) => {
  const esAdminCentral = req.usuario.rol === 'admin' && req.usuario.es_central === 1;
  const sucursalId = esAdminCentral && req.query.sucursal_id ? Number(req.query.sucursal_id) : req.usuario.sucursal_id;
  const cortes = db
    .prepare(
      `SELECT co.*, u.nombre AS usuario, s.nombre AS sucursal
       FROM cortes co
       JOIN usuarios u ON u.id = co.usuario_id
       JOIN sucursales s ON s.id = co.sucursal_id
       WHERE co.sucursal_id = ?
       ORDER BY co.id DESC LIMIT 60`
    )
    .all(sucursalId);
  res.json(cortes);
});

router.get('/:id', (req, res) => {
  const corte = cargarCorte(req.params.id);
  if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });
  const esAdminCentral = req.usuario.rol === 'admin' && req.usuario.es_central === 1;
  if (corte.sucursal_id !== req.usuario.sucursal_id && !esAdminCentral) {
    return res.status(403).json({ error: 'Ese corte es de otra sucursal' });
  }
  res.json(corte);
});

module.exports = router;
