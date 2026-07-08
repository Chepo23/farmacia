const express = require('express');
const db = require('../db');

const router = express.Router();

function rango(req) {
  const hoy = new Date().toLocaleDateString('sv-SE');
  const desde = req.query.desde || hoy;
  const hasta = req.query.hasta || hoy;
  // Los cajeros solo ven su sucursal; el admin puede elegir una o ver todas
  let sucursalId = req.usuario.sucursal_id;
  if (req.usuario.rol === 'admin') {
    sucursalId = req.query.sucursal_id === 'todas' ? null : Number(req.query.sucursal_id) || req.usuario.sucursal_id;
  }
  return { desde, hasta, sucursalId };
}

router.get('/ventas', (req, res) => {
  const { desde, hasta, sucursalId } = rango(req);
  const filtroSucursal = sucursalId ? 'AND v.sucursal_id = @sucursalId' : '';
  const params = { desde, hasta, sucursalId };

  const resumen = db
    .prepare(
      `SELECT COUNT(*) AS num_ventas, COALESCE(SUM(v.total), 0) AS total_vendido,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'efectivo' THEN v.total END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'tarjeta' THEN v.total END), 0) AS tarjeta,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'credito' THEN v.total END), 0) AS credito
       FROM ventas v
       WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}`
    )
    .get(params);

  const ganancia = db
    .prepare(
      `SELECT COALESCE(SUM(d.importe - d.costo_unitario * d.cantidad), 0) AS ganancia
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}`
    )
    .get(params).ganancia;

  const porDia = db
    .prepare(
      `SELECT date(v.fecha) AS dia, COUNT(*) AS num_ventas, SUM(v.total) AS total
       FROM ventas v
       WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}
       GROUP BY date(v.fecha) ORDER BY dia`
    )
    .all(params);

  const porSucursal = db
    .prepare(
      `SELECT s.nombre AS sucursal, COUNT(*) AS num_ventas, SUM(v.total) AS total
       FROM ventas v JOIN sucursales s ON s.id = v.sucursal_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}
       GROUP BY v.sucursal_id ORDER BY total DESC`
    )
    .all(params);

  const masVendidos = db
    .prepare(
      `SELECT d.descripcion, SUM(d.cantidad) AS cantidad, SUM(d.importe) AS importe
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}
       GROUP BY d.producto_id ORDER BY cantidad DESC LIMIT 20`
    )
    .all(params);

  res.json({ ...resumen, ganancia, por_dia: porDia, por_sucursal: porSucursal, mas_vendidos: masVendidos });
});

module.exports = router;
