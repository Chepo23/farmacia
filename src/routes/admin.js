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

async function guardarUsuarioCentral(usuario) {
  if (!hasSupabase || !supabaseAdmin) return null;

  const rol = usuario.rol === 'admin' ? 'admin' : 'cajero';
  const payload = {
    id: Number(usuario.id),
    nombre: usuario.nombre,
    usuario: usuario.usuario,
    rol,
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
  res.json(db.prepare('SELECT * FROM sucursales WHERE activa = 1 ORDER BY id').all());
});

router.post('/sucursales', requiereAdmin, async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const info = db
    .prepare('INSERT INTO sucursales (nombre, direccion, telefono) VALUES (?, ?, ?)')
    .run(nombre, (req.body.direccion || '').trim(), (req.body.telefono || '').trim());

  const sucursalId = Number(info.lastInsertRowid);
  const sucursal = db.prepare('SELECT * FROM sucursales WHERE id = ?').get(sucursalId);

  try {
    await guardarSucursalCentral(sucursal);
  } catch (error) {
    console.error('No se pudo sincronizar sucursal a Supabase:', error.message);
  }

  res.json({ ok: true, id: sucursalId });
});

router.put('/sucursales/:id', requiereAdmin, async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  db.prepare('UPDATE sucursales SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?').run(
    nombre, (req.body.direccion || '').trim(), (req.body.telefono || '').trim(), req.params.id
  );

  const sucursal = db.prepare('SELECT * FROM sucursales WHERE id = ?').get(req.params.id);
  try {
    await guardarSucursalCentral(sucursal);
  } catch (error) {
    console.error('No se pudo sincronizar actualización de sucursal a Supabase:', error.message);
  }
  res.json({ ok: true });
});

router.delete('/sucursales/:id', requiereAdmin, async (req, res) => {
  const sucursalId = Number(req.params.id);
  if (!sucursalId) return res.status(400).json({ error: 'Sucursal no válida' });

  const sucursal = db
    .prepare('SELECT id, nombre, es_central FROM sucursales WHERE id = ?')
    .get(sucursalId);

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
    console.error('No se pudo eliminar sucursal en Supabase:', error.message);
  }

  res.json({ ok: true });
});

router.get('/usuarios', requiereAdmin, (req, res) => {
  res.json(
    db.prepare(
      `SELECT u.id, u.nombre, u.usuario, u.rol, u.sucursal_id, s.nombre AS sucursal
       FROM usuarios u JOIN sucursales s ON s.id = u.sucursal_id
       WHERE u.activo = 1 ORDER BY u.id`
    ).all()
  );
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
    const info = db
      .prepare(
        'INSERT INTO usuarios (nombre, usuario, password_hash, rol, sucursal_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(datos.nombre, datos.usuario, passwordHash, datos.rol, datos.sucursal_id);

    const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(info.lastInsertRowid);
    try {
      await guardarUsuarioCentral({
        ...usuario,
        activo: Boolean(usuario.activo ?? true),
      });
    } catch (error) {
      console.error('No se pudo sincronizar usuario a Supabase:', error.message);
      return res.status(500).json({ error: 'El usuario se creó localmente, pero falló la sincronización con Supabase: ' + error.message });
    }

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    throw e;
  }
});

router.put('/usuarios/:id', requiereAdmin, async (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: false });
  if (datos.error) return res.status(400).json({ error: datos.error });
  db.prepare('UPDATE usuarios SET nombre = ?, usuario = ?, rol = ?, sucursal_id = ? WHERE id = ?').run(
    datos.nombre, datos.usuario, datos.rol, datos.sucursal_id, req.params.id
  );
  let passwordHash = null;
  if ((req.body.password || '').trim()) {
    passwordHash = hashPassword(req.body.password.trim());
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(passwordHash, req.params.id);
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  try {
    await guardarUsuarioCentral({
      ...usuario,
      activo: Boolean(usuario.activo ?? true),
    });
  } catch (error) {
    console.error('No se pudo sincronizar actualización de usuario a Supabase:', error.message);
    return res.status(500).json({ error: 'La actualización local se realizó, pero la sincronización con Supabase falló: ' + error.message });
  }
  res.json({ ok: true });
});

router.delete('/usuarios/:id', requiereAdmin, async (req, res) => {
  if (Number(req.params.id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });

  db.transaction(() => {
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(req.params.id);
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  })();

  try {
    await eliminarUsuarioCentral(req.params.id);
  } catch (error) {
    console.error('No se pudo eliminar usuario en Supabase:', error.message);
  }

  res.json({ ok: true });
});

module.exports = router;
