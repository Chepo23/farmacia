const test = require('node:test');
const assert = require('node:assert/strict');
const { puedeEditar } = require('../src/routes/pedidos');

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
