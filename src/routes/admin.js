// Administración de sucursales y usuarios.
// Con Supabase se guardan primero en la central y después en la copia local; sin Supabase,
// directo en SQLite. Dar de baja es lógico (activo = 0): el historial de ventas se conserva.
// Jefe: administrador de la central que además ve movimientos, cambios e inventario de todas las
// sucursales. Solo un jefe crea, cambia o da de baja otra cuenta de jefe (así nadie más le puede
// cambiar la contraseña); si todavía no hay ninguno, el administrador de la central crea el primero.
const express = require('express');
const db = require('../db');
const { hashPassword } = require('../passwords');
const { requiereAdmin } = require('../auth');
const bitacora = require('../bitacora');
const { modoCentral, centralDisponible, consultar, sb, manejar, ErrorApp } = require('../central');

const router = express.Router();

const esJefe = (u) => Boolean(u) && (u.jefe === true || Number(u.jefe) === 1);
const nombreRol = (u) => (esJefe(u) ? 'jefe' : u.rol === 'admin' ? 'administrador' : 'cajero');
const nombreSucursal = (id) => db.prepare('SELECT nombre FROM sucursales WHERE id = ?').get(id)?.nombre || `Sucursal ${id}`;

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
      `INSERT INTO usuarios (id, nombre, usuario, password_hash, rol, sucursal_id, activo, jefe) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, usuario = excluded.usuario,
         password_hash = CASE WHEN excluded.password_hash = '!' THEN usuarios.password_hash ELSE excluded.password_hash END,
         rol = excluded.rol, sucursal_id = excluded.sucursal_id, activo = excluded.activo, jefe = excluded.jefe`
    ).run(Number(u.id), u.nombre, u.usuario, u.password_hash || '!', u.rol === 'admin' ? 'admin' : 'cajero',
      Number(u.sucursal_id), u.activo === false || u.activo === 0 ? 0 : 1, esJefe(u) ? 1 : 0);
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
  let id;
  if (modoCentral()) {
    const { data } = await consultar(sb().from('sucursales').insert({ ...datos, es_central: false, activa: true }).select().single());
    guardarSucursalLocal(data);
    id = data.id;
  } else {
    id = db.prepare('INSERT INTO sucursales (nombre, direccion, telefono, es_central, activa) VALUES (?, ?, ?, 0, 1)')
      .run(datos.nombre, datos.direccion, datos.telefono).lastInsertRowid;
  }
  bitacora.registrar({ usuario: req.usuario, sucursal_id: id, tipo: 'sucursal_alta', descripcion: datos.nombre, detalle: { sucursal_id: Number(id), ...datos } });
  res.json({ ok: true, id });
}));

router.put('/sucursales/:id', requiereAdmin, manejar(async (req, res) => {
  const datos = validarSucursal(req.body);
  if (datos.error) return res.status(400).json({ error: datos.error });
  const id = Number(req.params.id);
  const antes = db.prepare('SELECT nombre, direccion, telefono FROM sucursales WHERE id = ?').get(id);
  if (modoCentral()) {
    const { data } = await consultar(sb().from('sucursales').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id).select());
    if (!data || !data.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    guardarSucursalLocal(data[0]);
  } else {
    const info = db.prepare('UPDATE sucursales SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?')
      .run(datos.nombre, datos.direccion, datos.telefono, id);
    if (!info.changes) return res.status(404).json({ error: 'Sucursal no encontrada' });
  }
  const cambios = antes ? ['nombre', 'direccion', 'telefono'].filter((c) => String(antes[c] || '') !== datos[c]) : [];
  if (cambios.length) {
    bitacora.registrar({
      usuario: req.usuario, sucursal_id: id, tipo: 'sucursal_cambio',
      descripcion: `${datos.nombre}: ${cambios.map((c) => `${c === 'direccion' ? 'dirección' : c === 'telefono' ? 'teléfono' : c} "${antes[c] || ''}" → "${datos[c]}"`).join(', ')}`,
      detalle: { sucursal_id: id, antes, despues: datos },
    });
  }
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
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: sucursalId, tipo: 'sucursal_baja',
    descripcion: `${sucursal.nombre} (sus usuarios ya no pueden entrar)`, detalle: { sucursal_id: sucursalId }, alerta: true,
  });
  res.json({ ok: true, baja: 'logica' });
}));

router.get('/usuarios', requiereAdmin, manejar(async (req, res) => {
  if (modoCentral()) {
    // select('*'): así funciona aunque la central todavía no tenga la columna "jefe"
    const [{ data: usuarios }, { data: sucursales }] = await Promise.all([
      consultar(sb().from('usuarios_central').select('*').order('id')),
      consultar(sb().from('sucursales').select('*')),
    ]);
    db.transaction(() => {
      for (const s of sucursales || []) guardarSucursalLocal(s);
      for (const u of usuarios || []) guardarUsuarioLocal(u);
    })();
    const nombres = new Map((sucursales || []).map((s) => [Number(s.id), s.nombre]));
    return res.json((usuarios || []).filter((u) => u.activo !== false).map((u) => ({
      id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, jefe: esJefe(u) ? 1 : 0, sucursal_id: u.sucursal_id,
      sucursal: nombres.get(Number(u.sucursal_id)) || '',
    })));
  }
  res.json(db.prepare(
    `SELECT u.id, u.nombre, u.usuario, u.rol, u.jefe, u.sucursal_id, s.nombre AS sucursal
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
  if (!['admin', 'cajero', 'jefe'].includes(body.rol)) return { error: 'Rol no válido' };
  const jefe = body.rol === 'jefe';
  let sucursalId = Number(body.sucursal_id);
  // El jefe siempre es de la central (desde ahí ve todas las sucursales)
  if (jefe) sucursalId = db.prepare('SELECT id FROM sucursales WHERE es_central = 1 AND activa = 1 ORDER BY id LIMIT 1').get()?.id;
  if (!sucursalId || !db.prepare('SELECT 1 FROM sucursales WHERE id = ? AND activa = 1').get(sucursalId)) {
    return { error: 'Sucursal no válida' };
  }
  return { nombre: nombre.slice(0, 120), usuario, rol: jefe ? 'admin' : body.rol, jefe: jefe ? 1 : 0, sucursal_id: sucursalId, password };
}

function errorUsuarioDuplicado(error) {
  return /UNIQUE|duplicate|23505/i.test(`${error.codigo || ''} ${error.message || ''}`);
}

const faltaColumnaJefe = (error) => /jefe/.test(String(error.message || '')) && /PGRST204|42703|does not exist|schema cache/i.test(`${error.codigo || ''} ${error.message || ''}`);

// La central puede no tener todavía la columna "jefe" (falta actualizarla): sin jefe se guarda igual
async function guardarEnCentral(construir, datos) {
  try {
    return await consultar(construir(datos));
  } catch (error) {
    if (!faltaColumnaJefe(error)) throw error;
    if (datos.jefe) {
      throw new ErrorApp('Falta actualizar la base central para crear cuentas de jefe. Avisa a quien instaló el sistema.', { status: 503, codigo: 'FALTA_ACTUALIZAR_CENTRAL' });
    }
    const { jefe: _sinJefe, ...resto } = datos;
    return consultar(construir(resto));
  }
}

async function hayJefeActivo() {
  if (modoCentral()) {
    try {
      const { data } = await consultar(sb().from('usuarios_central').select('id').eq('jefe', true).eq('activo', true).limit(1));
      return Boolean(data && data.length);
    } catch (error) {
      if (faltaColumnaJefe(error)) return false;
      throw error;
    }
  }
  return Boolean(db.prepare('SELECT 1 FROM usuarios WHERE jefe = 1 AND activo = 1 LIMIT 1').get());
}

// Cómo está hoy la cuenta (en la central si la hay: es la que manda)
async function usuarioActual(id) {
  if (modoCentral()) {
    const { data } = await consultar(sb().from('usuarios_central').select('*').eq('id', id).limit(1));
    return data && data[0] && data[0].activo !== false ? data[0] : null;
  }
  return db.prepare('SELECT id, nombre, usuario, rol, sucursal_id, jefe FROM usuarios WHERE id = ? AND activo = 1').get(id) || null;
}

router.post('/usuarios', requiereAdmin, manejar(async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: true });
  if (datos.error) return res.status(400).json({ error: datos.error });
  if (datos.jefe && !esJefe(req.usuario) && await hayJefeActivo()) {
    return res.status(403).json({ error: 'Solo un jefe puede crear otra cuenta de jefe' });
  }
  const passwordHash = hashPassword(datos.password);
  let id;
  try {
    if (modoCentral()) {
      const { data } = await guardarEnCentral((fila) => sb().from('usuarios_central').insert(fila).select().single(), {
        nombre: datos.nombre, usuario: datos.usuario, password_hash: passwordHash,
        rol: datos.rol, sucursal_id: datos.sucursal_id, activo: true, jefe: Boolean(datos.jefe),
      });
      guardarUsuarioLocal(data);
      id = data.id;
    } else {
      const existente = db.prepare('SELECT id, activo FROM usuarios WHERE usuario = ?').get(datos.usuario);
      if (existente && existente.activo) throw new ErrorApp('Ese nombre de usuario ya existe');
      if (existente) db.prepare("UPDATE usuarios SET usuario = usuario || '#' || id WHERE id = ?").run(existente.id);
      id = db.prepare('INSERT INTO usuarios (nombre, usuario, password_hash, rol, sucursal_id, jefe) VALUES (?, ?, ?, ?, ?, ?)')
        .run(datos.nombre, datos.usuario, passwordHash, datos.rol, datos.sucursal_id, datos.jefe).lastInsertRowid;
    }
  } catch (error) {
    if (errorUsuarioDuplicado(error)) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    throw error;
  }
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: datos.sucursal_id, tipo: 'usuario_alta',
    descripcion: `${datos.nombre} (${datos.usuario}), ${nombreRol(datos)} de ${nombreSucursal(datos.sucursal_id)}`,
    detalle: { usuario_id: Number(id), usuario: datos.usuario, rol: nombreRol(datos), sucursal_id: datos.sucursal_id },
    alerta: Boolean(datos.jefe),
  });
  res.json({ ok: true, id });
}));

router.put('/usuarios/:id', requiereAdmin, manejar(async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: false });
  if (datos.error) return res.status(400).json({ error: datos.error });
  const id = Number(req.params.id);
  if (id === req.usuario.id && (datos.rol !== req.usuario.rol || datos.sucursal_id !== req.usuario.sucursal_id
    || Boolean(datos.jefe) !== esJefe(req.usuario))) {
    return res.status(400).json({ error: 'No puedes cambiar tu propio rol ni tu sucursal' });
  }
  const previo = await usuarioActual(id);
  if (!previo) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (!esJefe(req.usuario)) {
    if (esJefe(previo)) return res.status(403).json({ error: 'Solo un jefe puede cambiar la cuenta de otro jefe' });
    if (datos.jefe && await hayJefeActivo()) return res.status(403).json({ error: 'Solo un jefe puede dar el rol de jefe' });
  }
  const cambios = { nombre: datos.nombre, usuario: datos.usuario, rol: datos.rol, sucursal_id: datos.sucursal_id, jefe: Boolean(datos.jefe) };
  if (datos.password) cambios.password_hash = hashPassword(datos.password);
  try {
    if (modoCentral()) {
      const { data } = await guardarEnCentral(
        (fila) => sb().from('usuarios_central').update({ ...fila, updated_at: new Date().toISOString() }).eq('id', id).select(),
        cambios
      );
      if (!data || !data.length) return res.status(404).json({ error: 'Usuario no encontrado' });
      guardarUsuarioLocal(data[0]);
    } else {
      const info = db.prepare(
        `UPDATE usuarios SET nombre = @nombre, usuario = @usuario, rol = @rol, sucursal_id = @sucursal_id, jefe = @jefe,
           password_hash = COALESCE(@password_hash, password_hash) WHERE id = @id AND activo = 1`
      ).run({ ...cambios, jefe: datos.jefe, password_hash: cambios.password_hash || null, id });
      if (!info.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
    }
  } catch (error) {
    if (errorUsuarioDuplicado(error)) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    throw error;
  }
  // Si cambió la contraseña o el rol, sus sesiones abiertas deben volver a entrar
  const cambioRol = previo.rol !== datos.rol || esJefe(previo) !== Boolean(datos.jefe);
  if (datos.password || cambioRol) {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token <> ?').run(id, req.sesionToken);
  }
  const partes = [];
  if (previo.nombre !== datos.nombre) partes.push(`nombre "${previo.nombre}" → "${datos.nombre}"`);
  if (previo.usuario !== datos.usuario) partes.push(`usuario ${previo.usuario} → ${datos.usuario}`);
  if (cambioRol) partes.push(`rol ${nombreRol(previo)} → ${nombreRol(datos)}`);
  if (Number(previo.sucursal_id) !== datos.sucursal_id) partes.push(`sucursal ${nombreSucursal(previo.sucursal_id)} → ${nombreSucursal(datos.sucursal_id)}`);
  if (datos.password) partes.push('cambió la contraseña');
  if (partes.length) {
    bitacora.registrar({
      usuario: req.usuario, sucursal_id: datos.sucursal_id, tipo: 'usuario_cambio',
      descripcion: `${datos.nombre}: ${partes.join(', ')}`,
      detalle: { usuario_id: id, cambios: partes },
      alerta: cambioRol,
    });
  }
  res.json({ ok: true });
}));

// Baja lógica: el usuario ya no puede entrar, pero sus ventas y movimientos conservan su nombre
router.delete('/usuarios/:id', requiereAdmin, manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  const previo = await usuarioActual(id);
  if (previo && esJefe(previo) && !esJefe(req.usuario)) {
    return res.status(403).json({ error: 'Solo un jefe puede dar de baja la cuenta de otro jefe' });
  }
  if (modoCentral()) {
    await consultar(sb().from('usuarios_central').update({ activo: false, updated_at: new Date().toISOString() }).eq('id', id));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
    db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(id);
  })();
  if (previo) {
    bitacora.registrar({
      usuario: req.usuario, sucursal_id: previo.sucursal_id, tipo: 'usuario_baja',
      descripcion: `${previo.nombre} (${previo.usuario}), ${nombreRol(previo)} de ${nombreSucursal(previo.sucursal_id)}`,
      detalle: { usuario_id: id },
    });
  }
  res.json({ ok: true });
}));

module.exports = router;
