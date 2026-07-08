const express = require('express');
const db = require('../db');
const { hashPassword } = require('../passwords');
const { requiereAdmin } = require('../auth');

const router = express.Router();

// Lista de sucursales (visible para todos, se usa en filtros y consultas)
router.get('/sucursales', (req, res) => {
  res.json(db.prepare('SELECT * FROM sucursales WHERE activa = 1 ORDER BY id').all());
});

router.post('/sucursales', requiereAdmin, (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const info = db
    .prepare('INSERT INTO sucursales (nombre, direccion, telefono) VALUES (?, ?, ?)')
    .run(nombre, (req.body.direccion || '').trim(), (req.body.telefono || '').trim());
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.put('/sucursales/:id', requiereAdmin, (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  db.prepare('UPDATE sucursales SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?').run(
    nombre, (req.body.direccion || '').trim(), (req.body.telefono || '').trim(), req.params.id
  );
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

router.post('/usuarios', requiereAdmin, (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: true });
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    const info = db
      .prepare(
        'INSERT INTO usuarios (nombre, usuario, password_hash, rol, sucursal_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(datos.nombre, datos.usuario, hashPassword(req.body.password.trim()), datos.rol, datos.sucursal_id);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    throw e;
  }
});

router.put('/usuarios/:id', requiereAdmin, (req, res) => {
  const datos = validarUsuario(req.body || {}, { nuevo: false });
  if (datos.error) return res.status(400).json({ error: datos.error });
  db.prepare('UPDATE usuarios SET nombre = ?, usuario = ?, rol = ?, sucursal_id = ? WHERE id = ?').run(
    datos.nombre, datos.usuario, datos.rol, datos.sucursal_id, req.params.id
  );
  if ((req.body.password || '').trim()) {
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(
      hashPassword(req.body.password.trim()), req.params.id
    );
  }
  res.json({ ok: true });
});

router.delete('/usuarios/:id', requiereAdmin, (req, res) => {
  if (Number(req.params.id) === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
  }
  db.transaction(() => {
    db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

module.exports = router;
