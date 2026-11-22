// Respaldos de la base de esta computadora (ver src/respaldos.js). Solo administradores.
const fs = require('fs');
const path = require('path');
const express = require('express');
const respaldos = require('../respaldos');
const copiaCentral = require('../copia-central');
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

// Copiar la central ahora (además de la copia automática de cada día)
router.post('/central', manejar(async (req, res) => {
  try {
    const r = await copiaCentral.copiar();
    res.json({ ok: true, ...r, resumen: respaldos.resumen() });
  } catch (error) {
    throw new ErrorApp(error.sinConexion ? 'No hay conexión con la central; la copia se hará sola cuando vuelva el internet'
      : `No se pudo copiar la central: ${error.message}`, { status: error.sinConexion ? 503 : 500 });
  }
}));

router.get('/central/:nombre', (req, res) => {
  const nombre = String(req.params.nombre || '');
  const archivo = path.join(copiaCentral.carpeta(), nombre);
  if (!copiaCentral.PATRON.test(nombre) || !fs.existsSync(archivo)) return res.status(404).json({ error: 'Copia no encontrada' });
  res.download(archivo, nombre);
});

// Descargar un respaldo (para guardarlo en una USB o mandarlo a otra computadora)
router.get('/:nombre', (req, res) => {
  const nombre = String(req.params.nombre || '');
  const archivo = path.join(respaldos.carpeta(), nombre);
  if (!respaldos.PATRON.test(nombre) || !fs.existsSync(archivo)) return res.status(404).json({ error: 'Respaldo no encontrado' });
  res.download(archivo, nombre);
});

module.exports = router;
