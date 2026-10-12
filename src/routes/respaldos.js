// Respaldos de la base de esta computadora (ver src/respaldos.js). Solo administradores.
const fs = require('fs');
const path = require('path');
const express = require('express');
const respaldos = require('../respaldos');
const { manejar, ErrorApp } = require('../central');

const router = express.Router();

router.use((req, res, next) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede ver los respaldos' });
  next();
});

router.get('/', (req, res) => {
  res.json(respaldos.resumen());
});

router.post('/', manejar(async (req, res) => {
  try {
    const r = await respaldos.respaldar({ manual: true });
    res.json({ ok: true, ...r, resumen: respaldos.resumen() });
  } catch (error) {
    throw new ErrorApp(`No se pudo hacer el respaldo: ${error.message}`, { status: 500 });
  }
}));

// Descargar un respaldo (para guardarlo en una USB o mandarlo a otra computadora)
router.get('/:nombre', (req, res) => {
  const nombre = String(req.params.nombre || '');
  const archivo = path.join(respaldos.carpeta(), nombre);
  if (!respaldos.PATRON.test(nombre) || !fs.existsSync(archivo)) return res.status(404).json({ error: 'Respaldo no encontrado' });
  res.download(archivo, nombre);
});

module.exports = router;
