// Administración de sucursales y usuarios.
// Con Supabase se guardan primero en la central y después en la copia local; sin Supabase,
// directo en SQLite. Dar de baja es lógico (activo = 0): el historial de ventas se conserva.
const express = require('express');
const db = require('../db');
const { hashPassword } = require('../passwords');
const { requiereAdmin } = require('../auth');
const { modoCentral, centralDisponible, consultar, sb, manejar, ErrorApp } = require('../central');

const router = express.Router();

function guardarSucursalLocal(s) {
  db.prepare(
    `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
       telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
  ).run(Number(s.id), s.nombre, s.direccion || '', s.telefono || '', s.es_central ? 1 : 0, s.activa === false || s.activa === 0 ? 0 : 1);
}

function guardarUsuarioLocal(u) {
  if (!db.prepare('SELECT 1 FROM sucursales WHERE id = ?').get(u.sucursal_id)) return;
  db.transaction(() => {
    db.prepare("UPDATE usuarios SET usuario = usuario || '#' || id, activo = 0 WHERE usuario = ? AND id <> ?").run(u.usuario, u.id);
    db.prepare(
      `INSERT INTO usuarios (id, nombre, usuario, password_hash, rol, sucursal_id, activo) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, usuario = excluded.usuario,
         password_hash = CASE WHEN excluded.password_hash = '!' THEN usuarios.password_hash ELSE excluded.password_hash END,
         rol = excluded.rol, sucursal_id = excluded.sucursal_id, activo = excluded.activo`
    ).run(Number(u.id), u.nombre, u.usuario, u.password_hash || '!', u.rol === 'admin' ? 'admin' : 'cajero',
      Number(u.sucursal_id), u.activo === false || u.activo === 0 ? 0 : 1);
  })();
}

function sucursalesLocales() {
  return db.prepare('SELECT id, nombre, direccion, telefono, es_central, activa FROM sucursales WHERE activa = 1 ORDER BY id').all();
}

function validarSucursal(body) {
  const nombre = String(body?.nombre || '').trim();
  if (!nombre) return { error: 'El nombre es obligatorio' };
  return {
    nombre: nombre.slice(0, 120),
    direccion: String(body.direccion || '').trim().slice(0, 200),
    telefono: String(body.telefono || '').trim().slice(0, 40),
  };
}

// Lista de sucursales (visible para todos, se usa en filtros y consultas)
router.get('/sucursales', manejar(async (req, res) => {
  if (modoCentral() && centralDisponible()) {
    try {
      const { data } = await consultar(sb().from('sucursales').select('*').order('id'));
      db.transaction(() => { for (const s of data || []) guardarSucursalLocal(s); })();
      return res.json((data || []).filter((s) => s.activa !== false).map((s) => ({ ...s, es_central: s.es_central ? 1 : 0 })));
    } catch (error) {
      if (!error.sinConexion) console.error('No se pudieron cargar sucursales de la central:', error.message);
    }
  }
  res.json(sucursalesLocales());
}));

router.post('/sucursales', requiereAdmin, manejar(async (req, res) => {
  const datos = validarSucursal(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });
  if (modoCentral()) {
    const { data } = await consultar(sb().from('sucursales').insert({ ...datos, es_central: false, activa: true }).select().single());
    guardarSucursalLocal(data);
    return res.json({ ok: true, id: data.id });
  }
  const id = db.prepare('INSERT INTO sucursales (nombre, direccion, telefono, es_central, activa) VALUES (?, ?, ?, 0, 1)')
    .run(datos.nombre, datos.direccion, datos.telefono).lastInsertRowid;
  res.json({ ok: true, id });
}));

router.put('/sucursales/:id', requiereAdmin, manejar(async (req, res) => {
  const datos = validarSucursal(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });
  const id = Number(req.params.id);
  if (modoCentral()) {
    const { data } = await consultar(sb().from('sucursales').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id).select());
    if (!data || !data.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    guardarSucursalLocal(data[0]);
    return res.json({ ok: true });
  }
  const info = db.prepare('UPDATE sucursales SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?')
    .run(datos.nombre, datos.direccion, datos.telefono, id);
  if (!info.changes) return res.status(404).json({ error: 'Sucursal no encontrada' });
  res.json({ ok: true });
}));

// Dar de baja una sucursal: deja de aparecer y sus usuarios ya no pueden entrar;
// sus ventas, apoyos e inventario quedan en el historial
router.delete('/sucursales/:id', requiereAdmin, manejar(async (req, res) => {
  const sucursalId = Number(req.params.id);
  const sucursal = db.prepare('SELECT id, nombre, es_central FROM sucursales WHERE id = ?').get(sucursalId);
  if (!sucursal) return res.status(404).json({ error: 'Sucursal no encontrada' });
  if (sucursal.es_central) return res.status(400).json({ error: 'La sucursal central no se puede dar de baja' });
  if (sucursalId === Number(req.usuario.sucursal_id)) return res.status(400).json({ error: 'No puedes dar de baja tu propia sucursal' });

  if (modoCentral()) {
    await consultar(sb().from('sucursales').update({ activa: false, updated_at: new Date().toISOString() }).eq('id', sucursalId));
    await consultar(sb().from('usuarios_central').update({ activo: false }).eq('sucursal_id', sucursalId));
  }
  db.transaction(() => {
    db.prepare('UPDATE sucursales SET activa = 0 WHERE id = ?').run(sucursalId);
    db.prepare('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE sucursal_id = ?)').run(sucursalId);
    db.prepare('UPDATE usuarios SET activo = 0 WHERE sucursal_id = ?').run(sucursalId);
  })();
  res.json({ ok: true, baja: 'logica' });
}));

router.get('/usuarios', requiereAdmin, manejar(async (req, res) => {
  if (modoCentral()) {
    const [{ data: usuarios }, { data: sucursales }] = await Promise.all([
      consultar(sb().from('usuarios_central').select('id,nombre,usuario,rol,sucursal_id,activo,password_hash').order('id')),
      consultar(sb().from('sucursales').select('*')),
    ]);
    db.transaction(() => {
      for (const s of sucursales || []) guardarSucursalLocal(s);
      for (const u of usuarios || []) guardarUsuarioLocal(u);
    })();
    const nombres = new Map((sucursales || []).map((s) => [Number(s.id), s.nombre]));
    return res.json((usuarios || []).filter((u) => u.activo !== false).map((u) => ({
      id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursal_id: u.sucursal_id,
      sucursal: nombres.get(Number(u.sucursal_id)) || '',
    })));
  }
  res.json(db.prepare(
    `SELECT u.id, u.nombre, u.usuario, u.rol, u.sucursal_id, s.nombre AS sucursal
     FROM usuarios u JOIN sucursales s ON s.id = u.sucursal_id WHERE u.activo = 1 ORDER BY u.id`
  ).all());
}));

function validarUsuario(body, { nuevo }) {
  const nombre = String(body.nombre || '').trim();
  const usuario = String(body.usuario || '').trim().toLowerCase();
  const password = String(body.password || '').trim();
  if (!nombre || !usuario) return { error: 'Nombre y usuario son obligatorios' };
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
    return { error: 'El usuario debe tener de 3 a 30 letras o números, sin espacios ni acentos' };
  }
  if (nuevo && !password) return { error: 'La contraseña es obligatoria' };
  if (password && password.length < 4) return { error: 'La contraseña debe tener al menos 4 caracteres' };
  if (!['admin', 'cajero'].includes(body.rol)) return { error: 'Rol no válido' };
  const sucursalId = Number(body.sucursal_id);
  if (!sucursalId || !db.prepare('SELECT 1 FROM sucursales WHERE id = ? AND activa = 1').get(sucursalId)) {
    return { error: 'Sucursal no válida' };
  }
  return { nombre: nombre.slice(0, 120), usuario, rol: body.rol, sucursal_id: sucursalId, password };
}

function errorUsuarioDuplicado(error) {
  return /UNIQUE|duplicate|23505/i.test(`${error.codigo || ''} ${error.message || ''}`);
}

router.post('/usuarios', requiereAdmin, manejar(async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: true });
  if (datos.error) return res.status(400).json({ error: datos.error });
  const passwordHash = hashPassword(datos.password);
  try {
    if (modoCentral()) {
      const { data } = await consultar(sb().from('usuarios_central').insert({
        nombre: datos.nombre, usuario: datos.usuario, password_hash: passwordHash,
        rol: datos.rol, sucursal_id: datos.sucursal_id, activo: true,
      }).select().single());
      guardarUsuarioLocal(data);
      return res.json({ ok: true, id: data.id });
    }
    const existente = db.prepare('SELECT id, activo FROM usuarios WHERE usuario = ?').get(datos.usuario);
    if (existente && existente.activo) throw new ErrorApp('Ese nombre de usuario ya existe');
    if (existente) db.prepare("UPDATE usuarios SET usuario = usuario || '#' || id WHERE id = ?").run(existente.id);
    const id = db.prepare('INSERT INTO usuarios (nombre, usuario, password_hash, rol, sucursal_id) VALUES (?, ?, ?, ?, ?)')
      .run(datos.nombre, datos.usuario, passwordHash, datos.rol, datos.sucursal_id).lastInsertRowid;
    res.json({ ok: true, id });
  } catch (error) {
    if (errorUsuarioDuplicado(error)) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    throw error;
  }
}));

router.put('/usuarios/:id', requiereAdmin, manejar(async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: false });
  if (datos.error) return res.status(400).json({ error: datos.error });
  const id = Number(req.params.id);
  if (id === req.usuario.id && (datos.rol !== req.usuario.rol || datos.sucursal_id !== req.usuario.sucursal_id)) {
    return res.status(400).json({ error: 'No puedes cambiar tu propio rol ni tu sucursal' });
  }
  const cambios = { nombre: datos.nombre, usuario: datos.usuario, rol: datos.rol, sucursal_id: datos.sucursal_id };
  if (datos.password) cambios.password_hash = hashPassword(datos.password);
  const previo = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(id);
  try {
    if (modoCentral()) {
      const { data } = await consultar(sb().from('usuarios_central').update({ ...cambios, updated_at: new Date().toISOString() }).eq('id', id).select());
      if (!data || !data.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      guardarUsuarioLocal(data[0]);
    } else {
      const info = db.prepare(
        `UPDATE usuarios SET nombre = @nombre, usuario = @usuario, rol = @rol, sucursal_id = @sucursal_id,
           password_hash = COALESCE(@password_hash, password_hash) WHERE id = @id AND activo = 1`
      ).run({ ...cambios, password_hash: cambios.password_hash || null, id });
      if (!info.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    // Si cambió la contraseña o el rol, sus sesiones abiertas deben volver a entrar
    if (datos.password || (previo && previo.rol !== datos.rol)) {
      db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token <> ?').run(id, req.sesionToken);
    }
    res.json({ ok: true });
  } catch (error) {
    if (errorUsuarioDuplicado(error)) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    throw error;
  }
}));

// Baja lógica: el usuario ya no puede entrar, pero sus ventas y movimientos conservan su nombre
router.delete('/usuarios/:id', requiereAdmin, manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  if (modoCentral()) {
    await consultar(sb().from('usuarios_central').update({ activo: false, updated_at: new Date().toISOString() }).eq('id', id));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
    db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
}));

module.exports = router;
