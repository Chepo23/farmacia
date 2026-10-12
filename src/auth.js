const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const { supabaseAdmin, hasSupabase } = require('./sync/supabase-client');

const router = express.Router();

// La sesión vence tras 12 horas sin usarse; mientras se use, se renueva sola
const DURACION_SESION_HORAS = 12;
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;
const intentosFallidos = new Map(); // usuario -> { n, hasta }

function leerToken(req) {
  const cookies = req.headers.cookie || '';
  const par = cookies.split(';').map((c) => c.trim()).find((c) => c.startsWith('sesion='));
  return par ? par.slice('sesion='.length) : null;
}

// Por HTTPS (celular por el túnel) la cookie solo viaja cifrada
function cookieSesion(token, req) {
  return `sesion=${token}; HttpOnly; Path=/; Max-Age=${DURACION_SESION_HORAS * 3600}; SameSite=Lax${req && req.secure ? '; Secure' : ''}`;
}

function usuarioDeSesion(req) {
  const token = leerToken(req);
  if (!token) return null;
  return db
    .prepare(
      `SELECT u.id, u.nombre, u.usuario, u.rol, u.sucursal_id, s.nombre AS sucursal, s.es_central,
              COALESCE(se.ultimo_uso, se.creada) AS ultimo_uso
       FROM sesiones se
       JOIN usuarios u ON u.id = se.usuario_id
       JOIN sucursales s ON s.id = u.sucursal_id
       WHERE se.token = ? AND u.activo = 1
         AND COALESCE(se.ultimo_uso, se.creada) >= datetime('now', 'localtime', '-${DURACION_SESION_HORAS} hours')`
    )
    .get(token);
}

function requiereSesion(req, res, next) {
  const usuario = usuarioDeSesion(req);
  if (!usuario) return res.status(401).json({ error: 'Sesión no válida' });
  const token = leerToken(req);
  // Renovar la sesión (como mucho una vez cada 5 minutos)
  const minutos = (Date.now() - new Date(usuario.ultimo_uso.replace(' ', 'T')).getTime()) / 60000;
  if (!(minutos < 5)) {
    db.prepare("UPDATE sesiones SET ultimo_uso = datetime('now', 'localtime') WHERE token = ?").run(token);
    res.setHeader('Set-Cookie', cookieSesion(token, req));
  }
  delete usuario.ultimo_uso;
  req.usuario = usuario;
  req.sesionToken = token;
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
    db.prepare(
      `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
         telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
    ).run(central.data.id, central.data.nombre, central.data.direccion || '', central.data.telefono || '',
      central.data.es_central ? 1 : 0, central.data.activa === false ? 0 : 1);
  }
  db.transaction(() => {
    // Otro registro local con el mismo nombre de usuario (copia vieja): se aparta para no chocar
    db.prepare(
      "UPDATE usuarios SET usuario = usuario || '#' || id, activo = 0 WHERE usuario = ? AND id <> ?"
    ).run(usuario.usuario, usuario.id);
    db.prepare(
      `INSERT INTO usuarios (id, nombre, usuario, password_hash, rol, sucursal_id, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, usuario = excluded.usuario,
         password_hash = excluded.password_hash, rol = excluded.rol, sucursal_id = excluded.sucursal_id,
         activo = excluded.activo`
    ).run(usuario.id, usuario.nombre, usuario.usuario, usuario.password_hash, usuario.rol === 'admin' ? 'admin' : 'cajero',
      usuario.sucursal_id, usuario.activo === false ? 0 : 1);
  })();
}

function verificarPasswordCompatible(password, almacenada) {
  if (!almacenada) return false;
  if (almacenada.includes(':')) return verifyPassword(password, almacenada);
  return almacenada === password;
}

function esErrorDeRed(resultado) {
  return resultado.status === 0
    || /fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|AbortError/i.test(resultado.error?.message || '');
}

function registrarFallo(nombre) {
  const actual = intentosFallidos.get(nombre) || { n: 0, hasta: 0 };
  actual.n += 1;
  if (actual.n >= MAX_INTENTOS) {
    actual.hasta = Date.now() + BLOQUEO_MS;
    actual.n = 0;
  }
  intentosFallidos.set(nombre, actual);
}

router.post('/login', async (req, res) => {
  try {
    const { usuario, password } = req.body || {};
    const nombreUsuario = String(usuario || '').trim().toLowerCase();
    const clave = String(password || '');
    if (!nombreUsuario || !clave) return res.status(400).json({ error: 'Escribe tu usuario y contraseña' });

    const bloqueo = intentosFallidos.get(nombreUsuario);
    if (bloqueo && bloqueo.hasta > Date.now()) {
      const minutos = Math.ceil((bloqueo.hasta - Date.now()) / 60000);
      return res.status(429).json({ error: `Demasiados intentos fallidos. Espera ${minutos} minuto(s) e intenta de nuevo.` });
    }

    let fila = null;
    let usarLocal = true;
    if (hasSupabase && supabaseAdmin) {
      const remoto = await supabaseAdmin
        .from('usuarios_central')
        .select('id, nombre, usuario, password_hash, rol, sucursal_id, activo')
        .eq('usuario', nombreUsuario)
        .maybeSingle();
      if (!remoto.error) {
        // La central respondió: ella decide (un usuario dado de baja ya no entra en ninguna computadora)
        usarLocal = false;
        if (!remoto.data || remoto.data.activo === false) {
          db.prepare('UPDATE usuarios SET activo = 0 WHERE usuario = ?').run(nombreUsuario);
        } else if (remoto.data.password_hash && verificarPasswordCompatible(clave, remoto.data.password_hash)) {
          if (!remoto.data.password_hash.includes(':')) {
            const passwordHash = hashPassword(clave);
            const actualizado = await supabaseAdmin.from('usuarios_central')
              .update({ password_hash: passwordHash }).eq('id', remoto.data.id);
            if (!actualizado.error) remoto.data.password_hash = passwordHash;
          }
          await guardarUsuarioLocal(remoto.data);
          fila = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(remoto.data.id);
        }
      } else if (!esErrorDeRed(remoto)) {
        console.error('No se pudo consultar el login central:', remoto.error.message);
      }
    }
    if (usarLocal) {
      // Sin conexión con la central (o sin Supabase): se usa la copia local del usuario
      const local = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(nombreUsuario);
      if (local && verifyPassword(clave, local.password_hash)) fila = local;
    }
    if (!fila) {
      registrarFallo(nombreUsuario);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    intentosFallidos.delete(nombreUsuario);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO sesiones (token, usuario_id, ultimo_uso) VALUES (?, ?, datetime('now', 'localtime'))").run(token, fila.id);
    // Limpieza de sesiones viejas
    db.prepare("DELETE FROM sesiones WHERE COALESCE(ultimo_uso, creada) < datetime('now', 'localtime', '-7 days')").run();
    res.setHeader('Set-Cookie', cookieSesion(token, req));
    res.json({ ok: true });
  } catch (error) {
    console.error('Error en el inicio de sesión:', error);
    res.status(500).json({ error: 'No se pudo iniciar sesión. Intenta de nuevo.' });
  }
});

router.post('/logout', (req, res) => {
  const token = leerToken(req);
  if (token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'sesion=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

router.get('/yo', requiereSesion, (req, res) => {
  res.json({ ...req.usuario, modo: hasSupabase && supabaseAdmin ? 'central' : 'local' });
});

module.exports = { router, requiereSesion, requiereAdmin };
