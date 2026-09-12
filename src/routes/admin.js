const express = require('express');
const db = require('../db');
const { hashPassword } = require('../passwords');
const { requiereAdmin } = require('../auth');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');

const router = express.Router();

async function guardarSucursalCentral(sucursal) {
  if (!hasSupabase || !supabaseAdmin) return null;
  const payload = {
    id: Number(sucursal.id),
    nombre: sucursal.nombre,
    direccion: sucursal.direccion || '',
    telefono: sucursal.telefono || '',
    es_central: Boolean(sucursal.es_central ?? false),
    activa: Boolean(sucursal.activa ?? true),
  };

  const { data, error } = await supabaseAdmin
    .from('sucursales')
    .upsert(payload, { onConflict: 'id' })
    .select();

  if (error) throw error;
  return data?.[0] || null;
}

function guardarSucursalLocal(sucursal) {
  db.prepare("INSERT OR REPLACE INTO sync_config (clave, valor) VALUES ('aplicando', '1')").run();
  try {
    db.prepare(
      `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
         telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
    ).run(sucursal.id, sucursal.nombre, sucursal.direccion || '', sucursal.telefono || '',
      sucursal.es_central ? 1 : 0, sucursal.activa === false ? 0 : 1);
  } finally {
    db.prepare("DELETE FROM sync_config WHERE clave = 'aplicando'").run();
  }
}

async function guardarUsuarioCentral(usuario) {
  if (!hasSupabase || !supabaseAdmin) return null;

  const rol = usuario.rol === 'admin' ? 'admin' : 'cajero';
  const payload = {
    id: Number(usuario.id),
    nombre: usuario.nombre,
    usuario: usuario.usuario,
    password_hash: usuario.password_hash,
    rol,
    sucursal_id: Number(usuario.sucursal_id),
    activo: Boolean(usuario.activo ?? true),
  };

  const { data, error } = await supabaseAdmin
    .from('usuarios_central')
    .upsert(payload, { onConflict: 'id' })
    .select();

  if (error) throw error;
  return data?.[0] || null;
}

async function eliminarSucursalCentral(id) {
  if (!hasSupabase || !supabaseAdmin) return null;
  const { error } = await supabaseAdmin.from('sucursales').delete().eq('id', Number(id));
  if (error) throw error;
  return true;
}

async function eliminarUsuarioCentral(id) {
  if (!hasSupabase || !supabaseAdmin) return null;
  const { error } = await supabaseAdmin.from('usuarios_central').delete().eq('id', Number(id));
  if (error) throw error;
  return true;
}

// Lista de sucursales (visible para todos, se usa en filtros y consultas)
router.get('/sucursales', (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.json(db.prepare('SELECT * FROM sucursales WHERE activa = 1 ORDER BY id').all());
  }
  supabaseAdmin.from('sucursales').select('*').eq('activa', true).order('id').then(({ data, error }) => {
    if (error) throw error;
    for (const sucursal of data || []) guardarSucursalLocal(sucursal);
    res.json(data || []);
  }).catch((error) => {
    console.error('No se pudieron cargar sucursales de Supabase:', error.message);
    res.json(db.prepare('SELECT * FROM sucursales WHERE activa = 1 ORDER BY id').all());
  });
});

router.post('/sucursales', requiereAdmin, async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const { data, error } = await supabaseAdmin.from('sucursales').insert({
      nombre, direccion: (req.body.direccion || '').trim(), telefono: (req.body.telefono || '').trim(),
    }).select().single();
    if (error) throw error;
    guardarSucursalLocal(data);
    return res.json({ ok: true, id: data.id });
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo guardar la sucursal en Supabase: ' + error.message });
  }
});

router.put('/sucursales/:id', requiereAdmin, async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const { data, error } = await supabaseAdmin.from('sucursales').update({
      nombre, direccion: (req.body.direccion || '').trim(), telefono: (req.body.telefono || '').trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).select().single();
    if (error) throw error;
    guardarSucursalLocal(data);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo actualizar la sucursal en Supabase: ' + error.message });
  }
});

router.delete('/sucursales/:id', requiereAdmin, async (req, res) => {
  const sucursalId = Number(req.params.id);
  if (!sucursalId) return res.status(400).json({ error: 'Sucursal no válida' });

  const sucursal = db.prepare('SELECT id, nombre, es_central FROM sucursales WHERE id = ?').get(sucursalId);

  if (!sucursal) return res.status(404).json({ error: 'Sucursal no encontrada' });
  if (sucursal.es_central) return res.status(400).json({ error: 'La sucursal central no se puede eliminar' });

  db.transaction(() => {
    db.prepare('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE sucursal_id = ?)').run(sucursalId);
    db.prepare('DELETE FROM usuarios WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM sync_resumen WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM sync_conflictos WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM sync_estado WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM mini_apoyos WHERE origen_sucursal_id = ? OR destino_sucursal_id = ?').run(sucursalId, sucursalId);
    db.prepare('DELETE FROM venta_detalle WHERE venta_id IN (SELECT id FROM ventas WHERE sucursal_id = ?)').run(sucursalId);
    db.prepare('DELETE FROM ventas WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM abonos WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM clientes WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM inventario WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM movimientos_inventario WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM aperturas_caja WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM cortes WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM pedido_detalle WHERE pedido_id IN (SELECT id FROM pedidos WHERE sucursal_id = ?)').run(sucursalId);
    db.prepare('DELETE FROM pedidos WHERE sucursal_id = ?').run(sucursalId);
    db.prepare('DELETE FROM apoyo_detalle WHERE apoyo_id IN (SELECT id FROM apoyos WHERE origen_id = ? OR destino_id = ?)').run(sucursalId, sucursalId);
    db.prepare('DELETE FROM apoyos WHERE origen_id = ? OR destino_id = ?').run(sucursalId, sucursalId);
    db.prepare('DELETE FROM sucursales WHERE id = ?').run(sucursalId);
  })();

  try {
    await eliminarSucursalCentral(sucursalId);
  } catch (error) {
    return res.status(502).json({ error: 'La sucursal se eliminó localmente, pero falló Supabase: ' + error.message });
  }

  res.json({ ok: true });
});

router.get('/usuarios', requiereAdmin, async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.json(db.prepare(`SELECT u.id, u.nombre, u.usuario, u.rol, u.sucursal_id, s.nombre AS sucursal
      FROM usuarios u JOIN sucursales s ON s.id = u.sucursal_id WHERE u.activo = 1 ORDER BY u.id`).all());
  }
  try {
    const [{ data: usuarios, error: usuariosError }, { data: sucursales, error: sucursalesError }] = await Promise.all([
      supabaseAdmin.from('usuarios_central').select('id,nombre,usuario,rol,sucursal_id,activo,password_hash').eq('activo', true).order('id'),
      supabaseAdmin.from('sucursales').select('*').eq('activa', true),
    ]);
    if (usuariosError) throw usuariosError;
    if (sucursalesError) throw sucursalesError;
    const sucursalesPorId = new Map((sucursales || []).map((s) => [s.id, s]));
    for (const sucursal of sucursales || []) guardarSucursalLocal(sucursal);
    for (const usuario of usuarios || []) {
      if (usuario.password_hash && sucursalesPorId.has(usuario.sucursal_id)) {
        db.prepare(`INSERT INTO usuarios (id,nombre,usuario,password_hash,rol,sucursal_id,activo) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre,usuario=excluded.usuario,password_hash=excluded.password_hash,
          rol=excluded.rol,sucursal_id=excluded.sucursal_id,activo=excluded.activo`).run(
          usuario.id, usuario.nombre, usuario.usuario, usuario.password_hash, usuario.rol, usuario.sucursal_id, usuario.activo ? 1 : 0);
      }
    }
    return res.json((usuarios || []).map((u) => ({
      id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursal_id: u.sucursal_id,
      sucursal: sucursalesPorId.get(u.sucursal_id)?.nombre || '',
    })));
  } catch (error) {
    console.error('No se pudieron cargar usuarios de Supabase:', error.message);
    return res.status(502).json({ error: 'No se pudieron cargar los usuarios desde Supabase: ' + error.message });
  }
});

function validarUsuario(body, { nuevo }) {
  const nombre = (body.nombre || '').trim();
  const usuario = (body.usuario || '').trim().toLowerCase();
  if (!nombre || !usuario) return { error: 'Nombre y usuario son obligatorios' };
  if (nuevo && !(body.password || '').trim()) return { error: 'La contraseña es obligatoria' };
  if (!['admin', 'cajero'].includes(body.rol)) return { error: 'Rol no válido' };
  if (!Number(body.sucursal_id)) return { error: 'Sucursal no válida' };
  return { nombre, usuario, rol: body.rol, sucursal_id: Number(body.sucursal_id) };
}

router.post('/usuarios', requiereAdmin, async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: true });
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    const passwordHash = hashPassword(req.body.password.trim());
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const { data, error } = await supabaseAdmin.from('usuarios_central').insert({
      nombre: datos.nombre, usuario: datos.usuario, password_hash: passwordHash,
      rol: datos.rol, sucursal_id: datos.sucursal_id, activo: true,
    }).select().single();
    if (error) throw error;
    db.prepare(`INSERT INTO usuarios (id,nombre,usuario,password_hash,rol,sucursal_id,activo)
      VALUES (?,?,?,?,?,?,1)`).run(data.id, data.nombre, data.usuario, data.password_hash,
      data.rol, data.sucursal_id);
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || String(e.message).includes('duplicate')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    return res.status(502).json({ error: 'No se pudo crear el usuario en Supabase: ' + e.message });
  }
});

router.put('/usuarios/:id', requiereAdmin, async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: false });
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const cambios = { nombre: datos.nombre, usuario: datos.usuario, rol: datos.rol,
      sucursal_id: datos.sucursal_id };
    if ((req.body.password || '').trim()) cambios.password_hash = hashPassword(req.body.password.trim());
    const { data, error } = await supabaseAdmin.from('usuarios_central').update(cambios)
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    db.prepare(`UPDATE usuarios SET nombre=?,usuario=?,rol=?,sucursal_id=?,password_hash=COALESCE(?,password_hash)
      WHERE id=?`).run(data.nombre, data.usuario, data.rol, data.sucursal_id,
      data.password_hash || null, data.id);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo actualizar el usuario en Supabase: ' + error.message });
  }
});

router.delete('/usuarios/:id', requiereAdmin, async (req, res) => {
  if (Number(req.params.id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  }

  try {
    await eliminarUsuarioCentral(req.params.id);
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo eliminar el usuario en Supabase: ' + error.message });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(req.params.id);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  })();

  res.json({ ok: true });
});

module.exports = router;
