// Inicio del jefe e inventario de todas las sucursales: valor, bajo mínimo, agotados, negativos y
// productos sin movimiento (dinero detenido). Se lee de la central.
const express = require('express');
const supervision = require('../supervision');
const { manejar } = require('../central');

const router = express.Router();

router.get('/inicio', manejar(async (req, res) => {
  supervision.necesitaCentral('El inicio del jefe');
  res.json(await supervision.compartida.inicio(req.usuario, { fresco: req.query.fresco !== undefined }));
}));

router.get('/inventario', manejar(async (req, res) => {
  supervision.necesitaCentral('El inventario de las sucursales');
  res.json(await supervision.compartida.inventario(req.usuario, { fresco: req.query.fresco !== undefined }));
}));

// Lista de productos de un resumen: bajo_minimo, agotados, negativos, sin_movimiento o valor
router.get('/inventario/lista', manejar(async (req, res) => {
  supervision.necesitaCentral('El inventario de las sucursales');
  res.json(await supervision.compartida.listaInventario(req.usuario, { ...req.query, fresco: req.query.fresco !== undefined }));
}));

module.exports = router;
