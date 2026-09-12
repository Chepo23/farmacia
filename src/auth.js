const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const { supabaseAdmin, hasSupabase } = require('./sync/supabase-client');

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
  req.sesionToken = leerToken(req);
  next();
}

function requiereAdmin(req, res, next) {
  if (req.usuario.rol !== 'admin' || req.usuario.es_central !== 1) {
    return res.status(403).json({ error: 'Solo el administrador de la sucursal central puede administrar usuarios y sucursales' });
  }
  next();
}

async function guardarUsuarioLocal(usuario) {
  const sucursal = db.prepare('SELECT id FROM sucursales WHERE id = ?').get(usuario.sucursal_id);
  if (!sucursal) {
    const central = await supabaseAdmin.from('sucursales').select('*').eq('id', usuario.sucursal_id).maybeSingle();
    if (central.error) throw central.error;
    if (!central.data) throw new Error('La sucursal del usuario no existe');
    db.prepare("INSERT OR REPLACE INTO sync_config (clave, valor) VALUES ('aplicando', '1')").run();
    try {
      db.prepare(
        `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
           telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
      ).run(central.data.id, central.data.nombre, central.data.direccion || '', central.data.telefono || '',
        central.data.es_central ? 1 : 0, central.data.activa === false ? 0 : 1);
    } finally {
      db.prepare("DELETE FROM sync_config WHERE clave = 'aplicando'").run();
    }
  }
  db.prepare(
    `INSERT INTO usuarios (id, nombre, usuario, password_hash, rol, sucursal_id, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, usuario = excluded.usuario,
       password_hash = excluded.password_hash, rol = excluded.rol, sucursal_id = excluded.sucursal_id,
       activo = excluded.activo`
  ).run(usuario.id, usuario.nombre, usuario.usuario, usuario.password_hash, usuario.rol,
    usuario.sucursal_id, usuario.activo === false ? 0 : 1);
}

function verificarPasswordCompatible(password, almacenada) {
  if (!almacenada) return false;
  if (almacenada.includes(':')) return verifyPassword(password, almacenada);
  return almacenada === password;
}

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body || {};
  const nombreUsuario = (usuario || '').trim().toLowerCase();
  let fila;
  let errorCentral;
  let existeEnCentral = false;
  if (hasSupabase && supabaseAdmin) {
    const remoto = await supabaseAdmin
      .from('usuarios_central')
      .select('id, nombre, usuario, password_hash, rol, sucursal_id, activo')
      .eq('usuario', nombreUsuario)
      .eq('activo', true)
      .maybeSingle();
    if (!remoto.error && remoto.data) {
      existeEnCentral = true;
      if (remoto.data.password_hash && verificarPasswordCompatible(password || '', remoto.data.password_hash)) {
        try {
          if (!remoto.data.password_hash.includes(':')) {
            const passwordHash = hashPassword(password || '');
            const actualizado = await supabaseAdmin.from('usuarios_central')
              .update({ password_hash: passwordHash })
              .eq('id', remoto.data.id);
            if (actualizado.error) throw actualizado.error;
            remoto.data.password_hash = passwordHash;
          }
          await guardarUsuarioLocal(remoto.data);
          fila = remoto.data;
        } catch (error) {
          errorCentral = error;
        }
      }
    } else if (remoto.error) {
      errorCentral = remoto.error;
    }
  }
  if (!fila && !existeEnCentral) {
    fila = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(nombreUsuario);
  }
  if (!fila || !verifyPassword(password || '', fila.password_hash)) {
    if (errorCentral) console.error('No se pudo consultar el login central:', errorCentral.message);
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
