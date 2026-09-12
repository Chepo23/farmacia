const express = require('express');
const db = require('../db');
const { requiereAdmin } = require('../auth');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');

const router = express.Router();

// Lista global de departamentos (se usa en el formulario de producto en todas las sucursales)
function guardarLocal(departamento) {
  db.prepare(`INSERT INTO departamentos (id, nombre, activo) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, activo = excluded.activo`)
    .run(departamento.id, departamento.nombre, departamento.activo === false ? 0 : 1);
}

router.get('/', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.json(db.prepare('SELECT id, nombre FROM departamentos WHERE activo = 1 ORDER BY nombre').all());
  }
  try {
    const { data, error } = await supabaseAdmin.from('departamentos')
      .select('id,nombre,activo').eq('activo', true).order('nombre');
    if (error) throw error;
    if ((data || []).length === 0) {
      const locales = db.prepare('SELECT nombre FROM departamentos WHERE activo = 1 ORDER BY nombre').all();
      if (locales.length) {
        const migrados = await supabaseAdmin.from('departamentos')
          .upsert(locales, { onConflict: 'nombre' }).select('id,nombre,activo');
        if (migrados.error) throw migrados.error;
        for (const departamento of migrados.data || []) guardarLocal(departamento);
        return res.json(migrados.data || []);
      }
    }
    for (const departamento of data || []) guardarLocal(departamento);
    return res.json(data || []);
  } catch (error) {
    console.error('No se pudieron cargar departamentos de Supabase:', error.message);
    return res.json(db.prepare('SELECT id, nombre FROM departamentos WHERE activo = 1 ORDER BY nombre').all());
  }
});

router.post('/', requiereAdmin, async (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const { data, error } = await supabaseAdmin.from('departamentos')
      .insert({ nombre, activo: true }).select('id,nombre,activo').single();
    if (error) throw error;
    guardarLocal(data);
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    if (String(e.message).includes('duplicate') || String(e.message).includes('UNIQUE')) {
      const reactivado = await supabaseAdmin.from('departamentos')
        .update({ activo: true }).eq('nombre', nombre).eq('activo', false)
        .select('id,nombre,activo').maybeSingle();
      if (!reactivado.error && reactivado.data) {
        guardarLocal(reactivado.data);
        return res.json({ ok: true, id: reactivado.data.id });
      }
      return res.status(400).json({ error: 'Ya existe un departamento con ese nombre' });
    }
    return res.status(502).json({ error: 'No se pudo guardar el departamento en Supabase: ' + e.message });
  }
});

router.delete('/:id', requiereAdmin, async (req, res) => {
  try {
    if (!hasSupabase || !supabaseAdmin) throw new Error('Supabase no está configurado');
    const { error } = await supabaseAdmin.from('departamentos')
      .update({ activo: false }).eq('id', req.params.id);
    if (error) throw error;
    db.prepare('UPDATE departamentos SET activo = 0 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo eliminar el departamento en Supabase: ' + error.message });
  }
});

module.exports = router;
