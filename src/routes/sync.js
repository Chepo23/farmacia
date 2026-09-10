const express = require('express');
const db = require('../db');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');

const router = express.Router();

function ok(res, payload) {
  return res.json({ ok: true, ...payload });
}

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: process.env.APP_MODE || 'local',
    hasSupabase,
    supabaseUrl: process.env.SUPABASE_URL || null,
  });
});

router.get('/productos', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  const { data, error } = await supabaseAdmin
    .from('productos')
    .select('*')
    .eq('activo', true)
    .order('id', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

router.get('/resumen', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  const [{ count: productos }, { count: inventario }, { count: sucursales }] = await Promise.all([
    supabaseAdmin.from('productos').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('inventario').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('sucursales').select('*', { count: 'exact', head: true }),
  ]);

  return res.json({
    ok: true,
    productos: productos || 0,
    inventario: inventario || 0,
    sucursales: sucursales || 0,
  });
});

router.post('/seed-demo', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  try {
    const { data: sucursales, error: errorSucursales } = await supabaseAdmin
      .from('sucursales')
      .select('id, nombre, es_central')
      .order('id', { ascending: true });

    if (errorSucursales) {
      return res.status(500).json({ error: errorSucursales.message });
    }

    const { count: productosCount, error: errorCount } = await supabaseAdmin
      .from('productos')
      .select('*', { count: 'exact', head: true });

    if (errorCount) {
      return res.status(500).json({ error: errorCount.message });
    }

    if ((productosCount || 0) > 0) {
      return res.json({ ok: true, inserted: 0, message: 'La base central ya tiene productos' });
    }

    const productosBase = [
      {
        codigo_barras: '7501234567890',
        descripcion: 'Paracetamol 500 mg',
        departamento: 'Analgesicos',
        precio_costo: 14.5,
        precio_venta: 28.0,
        usa_inventario: true,
        es_comun: true,
        activo: true,
      },
      {
        codigo_barras: '7501234567891',
        descripcion: 'Vitamina C 1000 mg',
        departamento: 'Vitaminas',
        precio_costo: 24.0,
        precio_venta: 42.0,
        usa_inventario: true,
        es_comun: true,
        activo: true,
      },
      {
        codigo_barras: '7501234567892',
        descripcion: 'Jabón antibacterial 200 ml',
        departamento: 'Higiene',
        precio_costo: 18.0,
        precio_venta: 35.0,
        usa_inventario: true,
        es_comun: true,
        activo: true,
      },
    ];

    const { data: productos, error: errorInsertProductos } = await supabaseAdmin
      .from('productos')
      .insert(productosBase)
      .select();

    if (errorInsertProductos) {
      return res.status(500).json({ error: errorInsertProductos.message });
    }

    const centralId = (sucursales || []).find((s) => s.es_central)?.id;
    const payloadInventario = (productos || []).map((producto) => ({
      producto_id: producto.id,
      sucursal_id: centralId,
      existencia: 25,
      minimo: 8,
    }));

    if (centralId && payloadInventario.length) {
      const { error: errorInventario } = await supabaseAdmin
        .from('inventario')
        .upsert(payloadInventario, { onConflict: 'producto_id,sucursal_id' });

      if (errorInventario) {
        return res.status(500).json({ error: errorInventario.message });
      }
    }

    return res.json({ ok: true, inserted: productos.length, sucursales: sucursales.length });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error al sembrar la base central' });
  }
});

router.post('/push', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  const { entidad, rows } = req.body || {};
  if (!entidad || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'Se requiere entidad y rows' });
  }

  try {
    const payload = rows.map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabaseAdmin.from(entidad).upsert(payload, { onConflict: 'id' });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return ok(res, { entidad, rows: payload.length });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error al sincronizar' });
  }
});

router.get('/pull', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  const { tabla = 'productos', limit = 200 } = req.query || {};
  const { data, error } = await supabaseAdmin.from(tabla).select('*').limit(Number(limit));

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

router.get('/inventario-global', async (req, res) => {
  if (!hasSupabase || !supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase no está configurado' });
  }

  const { data, error } = await supabaseAdmin
    .from('inventario')
    .select('*, productos:producto_id(id, descripcion, codigo_barras), sucursales:sucursal_id(id, nombre, es_central)');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

router.get('/sync-status', (req, res) => {
  const rows = db.prepare('SELECT * FROM sync_estado ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});

module.exports = router;
