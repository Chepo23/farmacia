const test = require('node:test');
const assert = require('node:assert/strict');
const { puedeEditar, puedeCancelar } = require('../src/routes/pedidos');
const { puedeCancelarApoyo, resolverPedidoTrasCancelarApoyo } = require('../src/routes/apoyos');

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
