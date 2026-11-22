// Inventario: cada farmacia cuenta en la mañana y en la tarde los productos de su lista (la arma el
// jefe), con el celular y sin ver lo que dice el sistema; lo que no cuadra se recuenta, lleva motivo y
// lo autoriza un jefe (nunca quien contó). El jefe también puede empezar un inventario completo.
// Las reglas están en supabase/functions/movil/supervision.mjs (las mismas que en la nube).
const express = require('express');
const supervision = require('../supervision');
const { manejar, responderError } = require('../central');

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

// El conteo del turno que corre (mañana o tarde) de la sucursal; se arma la primera vez que alguien lo abre
router.get('/hoy', manejar(async (req, res) => {
  res.json(await compartida.conteoDeHoy(req.usuario, req.query));
}));

// A qué hora empieza el turno de la tarde en cada sucursal
router.get('/config', manejar(async (req, res) => {
  res.json(await compartida.configuracion(req.usuario));
}));

router.put('/config', manejar(async (req, res) => {
  res.json(await compartida.guardarConfiguracion(req.usuario, req.body || {}));
}));

// La lista del inventario de cada farmacia (solo el jefe la arma)
router.get('/lista', manejar(async (req, res) => {
  res.json(await compartida.lista(req.usuario, req.query));
}));

router.post('/lista', manejar(async (req, res) => {
  res.json(await compartida.agregarALista(req.usuario, req.body || {}));
}));

router.post('/lista/quitar', manejar(async (req, res) => {
  res.json(await compartida.quitarDeLista(req.usuario, req.body || {}));
}));

router.get('/lista/producto/:id(\\d+)', manejar(async (req, res) => {
  res.json(await compartida.listasDeProducto(req.usuario, req.params.id));
}));

router.post('/lista/producto', manejar(async (req, res) => {
  res.json(await compartida.cambiarListaProducto(req.usuario, req.body || {}));
}));

// Inventario completo (todo o un departamento): lo empieza y lo cancela el jefe
router.post('/completo', manejar(async (req, res) => {
  res.json(await compartida.iniciarCompleto(req.usuario, req.body || {}));
}));

router.get('/', manejar(async (req, res) => {
  res.json(await compartida.listarConteos(req.usuario, req.query));
}));

// Revisión semanal del jefe (como la hoja de Excel) y marcarla como revisada
router.get('/semana', manejar(async (req, res) => {
  res.json(await compartida.semana(req.usuario, req.query));
}));

router.post('/semana/revisar', manejar(async (req, res) => {
  res.json(await compartida.revisarSemana(req.usuario, req.body || {}));
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

router.post('/:id(\\d+)/cancelar', manejar(async (req, res) => {
  res.json(await compartida.cancelarConteo(req.usuario, req.params.id));
}));

module.exports = router;
