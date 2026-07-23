const express = require('express');
const db = require('../db');
const { requiereAdmin } = require('../auth');

const router = express.Router();

// Lista global de departamentos (se usa en el formulario de producto en todas las sucursales)
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, nombre FROM departamentos WHERE activo = 1 ORDER BY nombre').all());
});

router.post('/', requiereAdmin, (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const info = db
      .prepare('INSERT INTO departamentos (nombre) VALUES (?)')
      .run(nombre);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      // Si existía pero estaba desactivado, se reactiva
      const info = db
        .prepare('UPDATE departamentos SET activo = 1 WHERE nombre = ? AND activo = 0')
        .run(nombre);
      if (info.changes > 0) return res.json({ ok: true });
      return res.status(400).json({ error: 'Ya existe un departamento con ese nombre' });
    }
    throw e;
  }
});

router.delete('/:id', requiereAdmin, (req, res) => {
  db.prepare('UPDATE departamentos SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
