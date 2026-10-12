// Rutas internas para el programa de escritorio (Electron): saber si quedan movimientos por subir
// antes de cerrar, pedir un respaldo y apagar el servidor de forma ordenada.
// Solo responden desde esta misma computadora y con la contraseña interna que el programa genera al
// arrancar (FARMACIA_TOKEN_INTERNO). Sin esa variable no existen.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const inventario = require('../inventario');
const respaldos = require('../respaldos');
const { manejar } = require('../central');

const router = express.Router();
const TOKEN = process.env.FARMACIA_TOKEN_INTERNO || '';

function esLocal(req) {
  const ip = String(req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function tokenValido(recibido) {
  const a = Buffer.from(String(recibido || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!TOKEN || TOKEN.length < 32 || !esLocal(req) || !tokenValido(req.get('x-farmacia-interno'))) {
    return res.status(404).json({ error: 'Ruta no encontrada' });
  }
  next();
});

router.get('/estado', (req, res) => {
  res.json({ sincronizacion: inventario.estadoSincronizacion(), respaldos: respaldos.resumen() });
});

router.post('/respaldar', manejar(async (req, res) => {
  const r = await respaldos.respaldar({ manual: true });
  res.json({ ok: true, ...r });
}));

// Cierra la base (deja todo escrito en el archivo principal) y termina el proceso
router.post('/apagar', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    process.exit(0);
  }, 50);
});

module.exports = router;
