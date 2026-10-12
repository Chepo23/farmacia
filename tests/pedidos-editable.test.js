const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Las rutas abren la base al cargarse: se usa una temporal, nunca la farmacia.db real
const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'farmacia-unit-'));
process.env.FARMACIA_DB = path.join(temporal, 'farmacia.db');
for (const clave of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[clave];

const { puedeEditar, puedeCancelar } = require('../src/routes/pedidos');
const { puedeCancelarApoyo, puedeDescartarBorrador, resolverPedidoTrasCancelarApoyo } = require('../src/routes/apoyos');

test.after(() => {
  require('../src/db').close();
  fs.rmSync(temporal, { recursive: true, force: true });
});

test('la farmacia puede seguir editando un pedido enviado y no surtido', () => {
  const pedido = { sucursal_id: 7, estado: 'enviado' };
  const usuario = { sucursal_id: 7, es_central: 0 };

  assert.equal(puedeEditar(pedido, usuario), true);
});

test('la central solo puede ver el pedido, pero no editarlo', () => {
  const pedido = { sucursal_id: 7, estado: 'enviado' };
  const usuario = { sucursal_id: 1, es_central: 1 };

  assert.equal(puedeEditar(pedido, usuario), false);
});

test('un pedido cancelado no puede cancelarse nuevamente ni seguir apareciendo como pendiente', () => {
  const pedido = { sucursal_id: 7, estado: 'cancelado' };
  const usuario = { sucursal_id: 7, es_central: 0 };

  assert.equal(puedeCancelar(pedido, usuario), false);
});

test('cuando se cancela un apoyo ligado a un pedido, ese pedido debe quedar cancelado para salir de pendientes', () => {
  const apoyo = { pedido_id: 42, estado: 'enviado' };
  const pedido = { id: 42, estado: 'enviado' };

  assert.equal(resolverPedidoTrasCancelarApoyo(apoyo, pedido), 'cancelado');
});

test('solo la sucursal que solicitó el apoyo puede cancelarlo', () => {
  const apoyoEnviado = { destino_id: 7, origen_id: 1, estado: 'enviado' };
  const apoyoBorrador = { destino_id: 7, origen_id: 1, estado: 'borrador' };
  const usuarioSolicitante = { sucursal_id: 7, es_central: 0 };
  const usuarioCentral = { sucursal_id: 1, es_central: 1 };

  assert.equal(puedeCancelarApoyo(apoyoEnviado, usuarioSolicitante), true);
  assert.equal(puedeCancelarApoyo(apoyoBorrador, usuarioSolicitante), true);
  assert.equal(puedeCancelarApoyo(apoyoEnviado, usuarioCentral), false);
});

test('la central puede descartar su borrador, pero no un apoyo ya enviado', () => {
  const usuarioCentral = { sucursal_id: 1, es_central: 1 };
  assert.equal(puedeDescartarBorrador({ origen_id: 1, destino_id: 7, estado: 'borrador' }, usuarioCentral), true);
  assert.equal(puedeDescartarBorrador({ origen_id: 1, destino_id: 7, estado: 'enviado' }, usuarioCentral), false);
  assert.equal(puedeDescartarBorrador({ origen_id: 1, destino_id: 7, estado: 'borrador' }, { sucursal_id: 7 }), false);
});
