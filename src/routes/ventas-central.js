// Ventas de todas las farmacias para el jefe (lo que cada caja sube a la central): reporte, cortes de
// caja (para consultarlos y reimprimirlos) y clientes con crédito. Las reglas están en
// supabase/functions/movil/ventas.mjs, las mismas que usa el celular.
const express = require('express');
const supervision = require('../supervision');
const { manejar } = require('../central');

const router = express.Router();
const { ventasCentral } = supervision;

router.get('/reporte', manejar(async (req, res) => {
  supervision.necesitaCentral('Las ventas de todas las farmacias');
  res.json(await ventasCentral.reporte(req.usuario, req.query));
}));

router.get('/cortes', manejar(async (req, res) => {
  supervision.necesitaCentral('Los cortes de todas las farmacias');
  res.json(await ventasCentral.listarCortes(req.usuario, req.query));
}));

router.get('/cortes/:id(\\d+)', manejar(async (req, res) => {
  supervision.necesitaCentral('Los cortes de todas las farmacias');
  res.json(await ventasCentral.cargarCorte(req.usuario, req.params.id));
}));

router.get('/creditos', manejar(async (req, res) => {
  supervision.necesitaCentral('Los créditos de todas las farmacias');
  res.json(await ventasCentral.creditos(req.usuario, req.query));
}));

module.exports = router;
