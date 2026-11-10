// Cotizaciones: el administrador de la central las arma y las manda a una sucursal; la caja de esa
// sucursal las carga en la venta (las reglas están en src/cotizaciones.js).
const express = require('express');
const cotizaciones = require('../cotizaciones');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const bitacora = require('../bitacora');
const { manejar } = require('../central');

const router = express.Router();

// Aviso del botón "Cotizaciones" en la caja
router.get('/pendientes', manejar(async (req, res) => {
  res.json(await cotizaciones.pendientes(req.usuario));
}));

router.get('/destinos', manejar(async (req, res) => {
  res.json(await cotizaciones.destinos(req.usuario));
}));

router.get('/', manejar(async (req, res) => {
  res.json(await cotizaciones.listar(req.usuario, {
    bandeja: String(req.query.bandeja || 'recibidas'),
    estado: String(req.query.estado || ''),
  }));
}));

router.get('/:id(\\d+)', manejar(async (req, res) => {
  const cotizacion = await cotizaciones.cargar(req.params.id, req.usuario);
  // ?productos=1: los datos de hoy de cada producto (precio y existencia) para cargarla en la venta
  if (req.query.productos) {
    const mapa = await catalogo.porIds(cotizacion.renglones.map((r) => r.producto_id));
    const { productos } = await inventario.conExistencias([...mapa.values()], { sucursalId: req.usuario.sucursal_id });
    cotizacion.productos_actuales = productos;
  }
  res.json(cotizacion);
}));

router.post('/', manejar(async (req, res) => {
  const c = await cotizaciones.crear(req.usuario, req.body || {});
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: c.destino_sucursal_id, tipo: 'cotizacion_creada',
    descripcion: `Folio ${c.folio} para ${c.destino}${c.cliente ? ` (${c.cliente})` : ''}: ${c.productos} producto(s), $${Number(c.total).toFixed(2)}`,
    detalle: { cotizacion_id: c.id, folio: c.folio, total: c.total },
  });
  res.json(c);
}));

router.post('/:id(\\d+)/cancelar', manejar(async (req, res) => {
  const antes = await cotizaciones.cargar(req.params.id, req.usuario);
  const c = await cotizaciones.cancelar(req.params.id, req.usuario);
  if (antes.estado !== 'cancelada') {
    bitacora.registrar({
      usuario: req.usuario, sucursal_id: c.destino_sucursal_id, tipo: 'cotizacion_cancelada',
      descripcion: `Folio ${c.folio} para ${c.destino}, $${Number(c.total).toFixed(2)}`,
      detalle: { cotizacion_id: c.id, folio: c.folio },
    });
  }
  res.json(c);
}));

module.exports = router;
