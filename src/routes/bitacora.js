// Registro de cambios (solo el jefe): precios, altas y bajas, usuarios, cancelaciones, cortes con
// faltante, salidas de efectivo, apoyos, cotizaciones y ajustes del inventario del día.
const express = require('express');
const supervision = require('../supervision');
const { manejar } = require('../central');

const router = express.Router();

router.get('/', manejar(async (req, res) => {
  res.json(await supervision.listarCambios(req.usuario, req.query));
}));

module.exports = router;
