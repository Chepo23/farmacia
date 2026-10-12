const express = require('express');
const db = require('../db');
const inventario = require('../inventario');
const { modoCentral, manejar } = require('../central');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esFecha = (texto) => /^\d{4}-\d{2}-\d{2}$/.test(texto || '');

// Los cajeros y administradores de sucursal ven su sucursal; el de la central puede elegir una o todas
function sucursalDelReporte(req) {
  const esAdminCentral = req.usuario.rol === 'admin' && req.usuario.es_central === 1;
  if (!esAdminCentral) return req.usuario.sucursal_id;
  if (req.query.sucursal_id === 'todas') return null;
  return Number(req.query.sucursal_id) || req.usuario.sucursal_id;
}

function rango(req) {
  const hoy = new Date().toLocaleDateString('sv-SE');
  let desde = esFecha(req.query.desde) ? req.query.desde : hoy;
  let hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  return { desde, hasta, sucursalId: sucursalDelReporte(req) };
}

router.get('/ventas', (req, res) => {
  const { desde, hasta, sucursalId } = rango(req);
  const filtroSucursal = sucursalId ? 'AND v.sucursal_id = @sucursalId' : '';
  const params = { desde, hasta, sucursalId };
  const base = `FROM ventas v WHERE date(v.fecha) BETWEEN @desde AND @hasta ${filtroSucursal}`;
  const activas = `${base} AND v.cancelada = 0`;

  const resumen = db
    .prepare(
      `SELECT COUNT(*) AS num_ventas, COALESCE(SUM(v.total), 0) AS total_vendido,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'efectivo' THEN v.total
                           WHEN v.forma_pago = 'mixto' THEN v.pago_efectivo END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'dolar' THEN v.total END), 0) AS dolares,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'dolar' THEN v.pago_usd END), 0) AS usd_recibidos,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'tarjeta' THEN v.total
                           WHEN v.forma_pago = 'mixto' THEN v.pago_tarjeta END), 0) AS tarjeta,
         COALESCE(SUM(CASE WHEN v.forma_pago = 'credito' THEN v.total END), 0) AS credito
       ${activas}`
    )
    .get(params);

  const canceladas = db.prepare(`SELECT COUNT(*) AS num, COALESCE(SUM(v.total), 0) AS total ${base} AND v.cancelada = 1`).get(params);

  const costos = db
    .prepare(
      `SELECT COALESCE(SUM(d.importe - d.costo_unitario * d.cantidad), 0) AS ganancia,
              COALESCE(SUM(d.costo_unitario * d.cantidad), 0) AS costo,
              COALESCE(SUM(d.cantidad), 0) AS piezas
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta AND v.cancelada = 0 ${filtroSucursal}`
    )
    .get(params);

  const abonos = db
    .prepare(
      `SELECT COUNT(*) AS num, COALESCE(SUM(a.monto), 0) AS total FROM abonos a
       WHERE date(a.fecha) BETWEEN @desde AND @hasta ${sucursalId ? 'AND a.sucursal_id = @sucursalId' : ''}`
    )
    .get(params);

  const porDia = db
    .prepare(`SELECT date(v.fecha) AS dia, COUNT(*) AS num_ventas, SUM(v.total) AS total ${activas} GROUP BY date(v.fecha) ORDER BY dia`)
    .all(params);

  const porSucursal = db
    .prepare(
      `SELECT s.nombre AS sucursal, COUNT(*) AS num_ventas, SUM(v.total) AS total
       FROM ventas v JOIN sucursales s ON s.id = v.sucursal_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta AND v.cancelada = 0 ${filtroSucursal}
       GROUP BY v.sucursal_id ORDER BY total DESC`
    )
    .all(params);

  const porCajero = db
    .prepare(
      `SELECT u.nombre AS cajero, COUNT(*) AS num_ventas, SUM(v.total) AS total
       FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta AND v.cancelada = 0 ${filtroSucursal}
       GROUP BY v.usuario_id ORDER BY total DESC`
    )
    .all(params);

  const porFormaPago = db
    .prepare(`SELECT v.forma_pago, COUNT(*) AS num_ventas, SUM(v.total) AS total ${activas} GROUP BY v.forma_pago ORDER BY total DESC`)
    .all(params);

  const porDepartamento = db
    .prepare(
      `SELECT CASE WHEN d.producto_id = 0 THEN 'Artículos comunes'
                   ELSE COALESCE(NULLIF(p.departamento, ''), 'Sin departamento') END AS departamento,
              SUM(d.cantidad) AS cantidad, SUM(d.importe) AS importe,
              SUM(d.importe - d.costo_unitario * d.cantidad) AS ganancia
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
       LEFT JOIN productos p ON p.id = d.producto_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta AND v.cancelada = 0 ${filtroSucursal}
       GROUP BY 1 ORDER BY importe DESC`
    )
    .all(params);

  // Los artículos comunes se agrupan por su nombre, no como un solo producto
  const masVendidos = db
    .prepare(
      `SELECT MIN(d.descripcion) AS descripcion, SUM(d.cantidad) AS cantidad, SUM(d.importe) AS importe,
              SUM(d.importe - d.costo_unitario * d.cantidad) AS ganancia
       FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
       WHERE date(v.fecha) BETWEEN @desde AND @hasta AND v.cancelada = 0 ${filtroSucursal}
       GROUP BY CASE WHEN d.producto_id = 0 THEN 'c:' || d.descripcion ELSE 'p:' || d.producto_id END
       ORDER BY cantidad DESC LIMIT 20`
    )
    .all(params);

  const dinero = (filas) => filas.map((f) => ({ ...f, total: redondear(f.total), importe: redondear(f.importe), ganancia: f.ganancia === undefined ? undefined : redondear(f.ganancia) }));
  res.json({
    desde,
    hasta,
    num_ventas: resumen.num_ventas,
    total_vendido: redondear(resumen.total_vendido),
    efectivo: redondear(resumen.efectivo),
    dolares: redondear(resumen.dolares),
    usd_recibidos: redondear(resumen.usd_recibidos),
    tarjeta: redondear(resumen.tarjeta),
    credito: redondear(resumen.credito),
    ganancia: redondear(costos.ganancia),
    costo: redondear(costos.costo),
    piezas: costos.piezas,
    ticket_promedio: resumen.num_ventas ? redondear(resumen.total_vendido / resumen.num_ventas) : 0,
    abonos: { num: abonos.num, total: redondear(abonos.total) },
    canceladas: { num: canceladas.num, total: redondear(canceladas.total) },
    por_dia: dinero(porDia),
    por_sucursal: dinero(porSucursal),
    por_cajero: dinero(porCajero),
    por_forma_pago: dinero(porFormaPago),
    por_departamento: dinero(porDepartamento),
    mas_vendidos: dinero(masVendidos),
    // En modo central cada farmacia guarda sus ventas en su propia computadora
    ventas_solo_de_esta_computadora: modoCentral(),
  });
});

router.get('/inventario', manejar(async (req, res) => {
  const sucursalId = sucursalDelReporte(req);
  const fuente = await inventario.asegurarCopiaFresca({ maxEdadMs: 15000 });
  const filtro = sucursalId ? 'AND i.sucursal_id = @sucursalId' : '';
  const condicion = `p.activo = 1 AND p.usa_inventario = 1 AND p.id <> 0 AND s.activa = 1 ${filtro}`;

  const resumen = db
    .prepare(
      `SELECT COUNT(DISTINCT i.producto_id) AS productos_totales,
              COALESCE(SUM(i.existencia), 0) AS unidades_totales,
              COALESCE(SUM(CASE WHEN i.existencia <= i.minimo AND i.minimo > 0 THEN 1 ELSE 0 END), 0) AS bajo_minimo,
              COALESCE(SUM(CASE WHEN i.existencia <= 0 THEN 1 ELSE 0 END), 0) AS agotados,
              COALESCE(SUM(CASE WHEN i.existencia > 0 THEN i.existencia * p.precio_costo ELSE 0 END), 0) AS valor_costo,
              COALESCE(SUM(CASE WHEN i.existencia > 0 THEN i.existencia * p.precio_venta ELSE 0 END), 0) AS valor_venta
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       JOIN sucursales s ON s.id = i.sucursal_id
       WHERE ${condicion}`
    )
    .get({ sucursalId });

  const porSucursal = db
    .prepare(
      `SELECT s.nombre AS sucursal,
              COUNT(i.producto_id) AS productos,
              COALESCE(SUM(i.existencia), 0) AS unidades,
              COALESCE(SUM(CASE WHEN i.existencia <= i.minimo AND i.minimo > 0 THEN 1 ELSE 0 END), 0) AS bajo_minimo,
              COALESCE(SUM(CASE WHEN i.existencia <= 0 THEN 1 ELSE 0 END), 0) AS agotados,
              COALESCE(SUM(CASE WHEN i.existencia > 0 THEN i.existencia * p.precio_costo ELSE 0 END), 0) AS valor_costo,
              COALESCE(SUM(CASE WHEN i.existencia > 0 THEN i.existencia * p.precio_venta ELSE 0 END), 0) AS valor_venta
       FROM sucursales s
       LEFT JOIN inventario i ON i.sucursal_id = s.id
       LEFT JOIN productos p ON p.id = i.producto_id
       WHERE s.activa = 1 AND (i.producto_id IS NULL OR (p.activo = 1 AND p.usa_inventario = 1 AND p.id <> 0))
         ${sucursalId ? 'AND s.id = @sucursalId' : ''}
       GROUP BY s.id, s.nombre
       ORDER BY s.es_central DESC, s.nombre`
    )
    .all({ sucursalId });

  const bajoMinimo = db
    .prepare(
      `SELECT s.nombre AS sucursal, p.descripcion, p.codigo_barras, i.existencia, i.minimo
       FROM inventario i
       JOIN productos p ON p.id = i.producto_id
       JOIN sucursales s ON s.id = i.sucursal_id
       WHERE ${condicion} AND i.existencia <= i.minimo AND i.minimo > 0
       ORDER BY i.existencia ASC, p.descripcion
       LIMIT 500`
    )
    .all({ sucursalId });

  res.json({
    fuente,
    total_productos: Number(resumen.productos_totales || 0),
    total_unidades: Number(resumen.unidades_totales || 0),
    bajo_minimo: Number(resumen.bajo_minimo || 0),
    agotados: Number(resumen.agotados || 0),
    valor_costo: redondear(resumen.valor_costo),
    valor_venta: redondear(resumen.valor_venta),
    por_sucursal: porSucursal.map((s) => ({ ...s, valor_costo: redondear(s.valor_costo), valor_venta: redondear(s.valor_venta) })),
    bajo_minimo_detalle: bajoMinimo,
  });
}));

module.exports = router;
