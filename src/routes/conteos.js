// Inventario del día: la lista corta que cada sucursal cuenta con el celular sin ver lo que dice el
// sistema; lo que no cuadra se recuenta, lleva motivo y lo autoriza un jefe (nunca quien contó).
// Las reglas están en supabase/functions/movil/supervision.mjs (las mismas que en la nube).
const express = require('express');
const supervision = require('../supervision');
const { ErrorApp, manejar, responderError } = require('../central');

const router = express.Router();
const { compartida } = supervision;

router.use((req, res, next) => {
  try {
    supervision.necesitaCentral('El inventario del día');
  } catch (error) {
    return responderError(res, error);
  }
  next();
});

// La lista de hoy de la sucursal (se arma la primera vez que alguien la abre)
router.get('/hoy', manejar(async (req, res) => {
  res.json(await compartida.conteoDeHoy(req.usuario, req.query));
}));

// Cuántos productos se cuentan al día en cada sucursal
router.get('/config', manejar(async (req, res) => {
  res.json(await compartida.configuracion(req.usuario));
}));

router.put('/config', manejar(async (req, res) => {
  res.json(await compartida.guardarConfiguracion(req.usuario, req.body || {}));
}));

// Productos importantes (controlados, antibióticos, los más caros): se cuentan seguido
router.get('/importante/:id(\\d+)', manejar(async (req, res) => {
  if (!supervision.esJefe(req.usuario)) throw new ErrorApp('Esto solo lo ve el jefe', { status: 403, codigo: 'SOLO_JEFE' });
  res.json({ producto_id: Number(req.params.id), importante: await compartida.esImportante(req.params.id) });
}));

router.post('/importante', manejar(async (req, res) => {
  res.json(await compartida.marcarImportante(req.usuario, req.body || {}));
}));

router.get('/', manejar(async (req, res) => {
  res.json(await compartida.listarConteos(req.usuario, req.query));
}));

router.get('/:id(\\d+)', manejar(async (req, res) => {
  res.json(await compartida.cargarConteo(req.usuario, req.params.id));
}));

router.post('/:id(\\d+)/contar', manejar(async (req, res) => {
  res.json(await compartida.contar(req.usuario, req.params.id, req.body || {}));
}));

router.post('/:id(\\d+)/motivo', manejar(async (req, res) => {
  res.json(await compartida.anotarMotivo(req.usuario, req.params.id, req.body || {}));
}));

router.post('/:id(\\d+)/terminar', manejar(async (req, res) => {
  res.json(await compartida.terminar(req.usuario, req.params.id, req.body || {}));
}));

router.post('/:id(\\d+)/autorizar', manejar(async (req, res) => {
  res.json(await compartida.autorizar(req.usuario, req.params.id, req.body || {}));
}));

module.exports = router;
