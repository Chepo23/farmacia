// Sincronización con la base central. Solo /health es pública (dice si el servidor está vivo);
// todo lo demás requiere al administrador de la sucursal central.
const express = require('express');
const { requiereSesion, requiereAdmin } = require('../auth');
const { modoCentral, manejar, ErrorApp } = require('../central');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const subirVentas = require('../subir-ventas');

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
  res.json({ ...inventario.estadoSincronizacion(), ventas: subirVentas.estado() });
});

// Descarga catálogo e inventario completos y sube lo pendiente
router.post('/sincronizar', manejar(async (req, res) => {
  requiereCentral();
  const catalogoBajado = await catalogo.sincronizarCatalogoCompleto();
  const inventarioBajado = await inventario.refrescarInventarioCompleto();
  const subido = await inventario.sincronizarPendientes();
  const ventas = await subirVentas.subir();
  res.json({ ok: true, ...catalogoBajado, ...inventarioBajado, ...subido, ventas_subidas: ventas.subidos, estado: inventario.estadoSincronizacion() });
}));

module.exports = router;
