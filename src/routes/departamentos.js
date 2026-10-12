// Lista global de departamentos (se usa en el formulario de producto en todas las sucursales).
// Con Supabase se guardan en la central; sin Supabase, en SQLite.
const express = require('express');
const db = require('../db');
const { requiereAdmin } = require('../auth');
const { modoCentral, centralDisponible, consultar, sb, manejar } = require('../central');

const router = express.Router();

function guardarLocal(departamento) {
  db.prepare(
    `INSERT INTO departamentos (id, nombre, activo) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, activo = excluded.activo`
  ).run(departamento.id, departamento.nombre, departamento.activo === false ? 0 : 1);
}

function locales() {
  return db.prepare('SELECT id, nombre FROM departamentos WHERE activo = 1 ORDER BY nombre').all();
}

router.get('/', manejar(async (req, res) => {
  if (!modoCentral() || !centralDisponible()) return res.json(locales());
  try {
    const { data } = await consultar(sb().from('departamentos').select('id,nombre,activo').order('nombre'));
    db.transaction(() => {
      for (const departamento of data || []) {
        // Un departamento local con el mismo nombre pero otro id se reemplaza por el de la central
        db.prepare('DELETE FROM departamentos WHERE nombre = ? AND id <> ?').run(departamento.nombre, departamento.id);
        guardarLocal(departamento);
      }
    })();
    return res.json((data || []).filter((d) => d.activo !== false).map((d) => ({ id: d.id, nombre: d.nombre })));
  } catch (error) {
    if (!error.sinConexion) console.error('No se pudieron cargar departamentos de la central:', error.message);
    return res.json(locales());
  }
}));

router.post('/', requiereAdmin, manejar(async (req, res) => {
  const nombre = String(req.body?.nombre || '').trim().slice(0, 80);
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (modoCentral()) {
    const { data: existente } = await consultar(sb().from('departamentos').select('id,nombre,activo').ilike('nombre', nombre).limit(1));
    if (existente && existente[0]) {
      if (existente[0].activo !== false) return res.status(400).json({ error: 'Ya existe un departamento con ese nombre' });
      const { data } = await consultar(sb().from('departamentos').update({ activo: true }).eq('id', existente[0].id).select('id,nombre,activo'));
      guardarLocal(data[0]);
      return res.json({ ok: true, id: data[0].id });
    }
    const { data } = await consultar(sb().from('departamentos').insert({ nombre, activo: true }).select('id,nombre,activo'));
    guardarLocal(data[0]);
    return res.json({ ok: true, id: data[0].id });
  }
  const existente = db.prepare('SELECT id, activo FROM departamentos WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (existente && existente.activo) return res.status(400).json({ error: 'Ya existe un departamento con ese nombre' });
  if (existente) {
    db.prepare('UPDATE departamentos SET activo = 1 WHERE id = ?').run(existente.id);
    return res.json({ ok: true, id: existente.id });
  }
  const id = db.prepare('INSERT INTO departamentos (nombre) VALUES (?)').run(nombre).lastInsertRowid;
  res.json({ ok: true, id });
}));

router.delete('/:id', requiereAdmin, manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (modoCentral()) await consultar(sb().from('departamentos').update({ activo: false }).eq('id', id));
  db.prepare('UPDATE departamentos SET activo = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
}));

module.exports = router;
