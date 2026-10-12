// Sincronización con la base central. Solo /health es pública (dice si el servidor está vivo);
// todo lo demás requiere al administrador de la sucursal central.
const express = require('express');
const { requiereSesion, requiereAdmin } = require('../auth');
const { modoCentral, consultar, sb, manejar, ErrorApp } = require('../central');
const catalogo = require('../catalogo');
const inventario = require('../inventario');

const router = express.Router();

router.get('/health', (req, res) => {
  // instancia: identifica el servidor que arrancó el programa de escritorio (no es un secreto)
  res.json({ ok: true, mode: modoCentral() ? 'central' : 'local', hasSupabase: modoCentral(), instancia: process.env.FARMACIA_INSTANCIA || null });
});

router.use(requiereSesion, requiereAdmin);

function requiereCentral() {
  if (!modoCentral()) throw new ErrorApp('Supabase no está configurado en esta computadora', { status: 503 });
}

router.get('/estado', (req, res) => {
  res.json(inventario.estadoSincronizacion());
});

// Descarga catálogo e inventario completos y sube lo pendiente
router.post('/sincronizar', manejar(async (req, res) => {
  requiereCentral();
  const catalogoBajado = await catalogo.sincronizarCatalogoCompleto();
  const inventarioBajado = await inventario.refrescarInventarioCompleto();
  const subido = await inventario.sincronizarPendientes();
  res.json({ ok: true, ...catalogoBajado, ...inventarioBajado, ...subido, estado: inventario.estadoSincronizacion() });
}));

router.get('/resumen', manejar(async (req, res) => {
  requiereCentral();
  const contar = async (tabla) => (await consultar(sb().from(tabla).select('id', { count: 'exact', head: true }))).count || 0;
  res.json({
    ok: true,
    productos: await contar('productos'),
    inventario: await contar('inventario'),
    sucursales: await contar('sucursales'),
  });
}));

// Productos de ejemplo para una central vacía
router.post('/seed-demo', manejar(async (req, res) => {
  requiereCentral();
  const { count } = await consultar(sb().from('productos').select('id', { count: 'exact', head: true }));
  if ((count || 0) > 0) return res.json({ ok: true, inserted: 0, message: 'La base central ya tiene productos' });
  const { data: sucursales } = await consultar(sb().from('sucursales').select('id, nombre, es_central').order('id'));
  const base = [
    { codigo_barras: '7501234567890', descripcion: 'Paracetamol 500 mg', departamento: 'Analgesicos', precio_costo: 14.5, precio_venta: 28 },
    { codigo_barras: '7501234567891', descripcion: 'Vitamina C 1000 mg', departamento: 'Vitaminas', precio_costo: 24, precio_venta: 42 },
    { codigo_barras: '7501234567892', descripcion: 'Jabón antibacterial 200 ml', departamento: 'Higiene', precio_costo: 18, precio_venta: 35 },
  ].map((p) => ({ ...p, usa_inventario: true, es_comun: false, activo: true }));
  const { data: productos } = await consultar(sb().from('productos').insert(base).select());
  catalogo.guardarLocal(productos);
  const central = (sucursales || []).find((s) => s.es_central);
  if (central) {
    await inventario.aplicar(
      (productos || []).map((p) => ({ producto_id: p.id, sucursal_id: central.id, tipo: 'entrada', cantidad: 25, minimo: 8, nota: 'Existencia de ejemplo' })),
      { usuarioId: req.usuario.id }
    );
  }
  res.json({ ok: true, inserted: (productos || []).length, sucursales: (sucursales || []).length });
}));

module.exports = router;
