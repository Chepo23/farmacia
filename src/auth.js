const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { verifyPassword } = require('./passwords');

const router = express.Router();

function leerToken(req) {
  const cookies = req.headers.cookie || '';
  const par = cookies.split(';').map((c) => c.trim()).find((c) => c.startsWith('sesion='));
  return par ? par.slice('sesion='.length) : null;
}

function usuarioDeSesion(req) {
  const token = leerToken(req);
  if (!token) return null;
  return db
    .prepare(
      `SELECT u.id, u.nombre, u.usuario, u.rol, u.sucursal_id, s.nombre AS sucursal, s.es_central
       FROM sesiones se
       JOIN usuarios u ON u.id = se.usuario_id
       JOIN sucursales s ON s.id = u.sucursal_id
       WHERE se.token = ? AND u.activo = 1`
    )
    .get(token);
}

function requiereSesion(req, res, next) {
  const usuario = usuarioDeSesion(req);
  if (!usuario) return res.status(401).json({ error: 'Sesión no válida' });
  req.usuario = usuario;
  next();
}

function requiereAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({ error: 'Se requiere permiso de administrador' });
  }
  next();
}

router.post('/login', (req, res) => {
  const { usuario, password } = req.body || {};
  const fila = db
    .prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1')
    .get((usuario || '').trim().toLowerCase());
  if (!fila || !verifyPassword(password || '', fila.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones (token, usuario_id) VALUES (?, ?)').run(token, fila.id);
  res.setHeader('Set-Cookie', `sesion=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const token = leerToken(req);
  if (token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sesion=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/yo', requiereSesion, (req, res) => {
  res.json(req.usuario);
});

module.exports = { router, requiereSesion, requiereAdmin };
