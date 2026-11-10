// Movimientos de inventario como en Eleventa: entradas, salidas, ventas, ajustes, apoyos y conteos
// con cuánto había, cuánto hay, quién lo hizo y la nota. El jefe ve todas las sucursales; un
// administrador, la suya (las reglas están en src/supervision.js).
const express = require('express');
const supervision = require('../supervision');
const { manejar } = require('../central');

const router = express.Router();

router.get('/', manejar(async (req, res) => {
  res.json(await supervision.movimientos(req.usuario, req.query));
}));

// Sucursales y personas para los filtros
router.get('/filtros', manejar(async (req, res) => {
  res.json(await supervision.filtros(req.usuario));
}));

module.exports = router;
