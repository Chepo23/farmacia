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
         COALESCE(SUM(CASE WHEN v.forma_pago IN ('efectivo', 'dolar') THEN v.total
                           WHEN v.forma_pago = 'mixto' THEN v.pago_efectivo END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'tarjeta' THEN v.total
                           WHEN v.forma_pago = 'mixto' THEN v.pago_tarjeta END), 0) AS tarjeta,
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

router.get('/inventario', (req, res) => {
  const sucursalId = req.usuario.rol === 'admin'
    ? (req.query.sucursal_id === 'todas' ? null : Number(req.query.sucursal_id) || req.usuario.sucursal_id)
    : req.usuario.sucursal_id;

  const resumen = db
    .prepare(
      `SELECT COUNT(*) AS productos_totales,
              COALESCE(SUM(i.existencia), 0) AS unidades_totales,
              COALESCE(SUM(CASE WHEN i.existencia <= i.minimo AND i.minimo > 0 THEN 1 ELSE 0 END), 0) AS bajo_minimo
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       WHERE p.activo = 1 AND p.usa_inventario = 1 ${sucursalId ? 'AND i.sucursal_id = @sucursalId' : ''}`
    )
    .get({ sucursalId });

  const porSucursal = db
    .prepare(
      `SELECT s.nombre AS sucursal,
              COUNT(i.producto_id) AS productos,
              COALESCE(SUM(i.existencia), 0) AS unidades,
              COALESCE(SUM(CASE WHEN i.existencia <= i.minimo AND i.minimo > 0 THEN 1 ELSE 0 END), 0) AS bajo_minimo
       FROM sucursales s
       LEFT JOIN inventario i ON i.sucursal_id = s.id
       LEFT JOIN productos p ON p.id = i.producto_id AND p.activo = 1 AND p.usa_inventario = 1
       WHERE s.activa = 1 ${sucursalId ? 'AND s.id = @sucursalId' : ''}
       GROUP BY s.id, s.nombre
       ORDER BY s.nombre`
    )
    .all({ sucursalId });

  const bajoMinimo = db
    .prepare(
      `SELECT s.nombre AS sucursal, p.descripcion, p.codigo_barras,
              i.existencia, i.minimo
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       JOIN sucursales s ON s.id = i.sucursal_id
       WHERE p.activo = 1 AND p.usa_inventario = 1 AND i.existencia <= i.minimo AND i.minimo > 0
         ${sucursalId ? 'AND i.sucursal_id = @sucursalId' : ''}
       ORDER BY i.existencia ASC, p.descripcion`
    )
    .all({ sucursalId });

  const totalProductos = Number(resumen.productos_totales || 0);
  const totalUnidades = Number(resumen.unidades_totales || 0);
  const totalBajoMinimo = Number(resumen.bajo_minimo || 0);

  res.json({
    total_productos: totalProductos,
    total_unidades: totalUnidades,
    bajo_minimo: totalBajoMinimo,
    por_sucursal: porSucursal,
    bajo_minimo_detalle: bajoMinimo,
  });
});

module.exports = router;
