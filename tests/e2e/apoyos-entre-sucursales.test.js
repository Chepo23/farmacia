'use strict';
// Apoyos desde cualquier farmacia: una sucursal le manda a la central o a otra sucursal. Sale del
// inventario de la que lo manda, la que lo recibe lo verifica con el celular y el jefe lo ve en el
// registro de cambios. La central recibe con el celular de su administrador.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');
const { crearNube } = require('../helpers/nube');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

async function esperarQue(condicion, que) {
  for (let i = 0; i < 80; i += 1) {
    if (await condicion()) return;
    await esperar(200);
  }
  throw new Error(`No se cumplió: ${que}`);
}

test('apoyos entre cualquier farmacia', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte', 'sur'] });
  t.after(cerrarTodo);
  const stock = (productoId, sucursalId) => central.db
    .prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId)?.existencia ?? 0;
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234', { caja: false });
  const sur = await entrar(servidores.sur.base, 'cajero3', '1234', { caja: false });
  const amox = (await admin.post('/api/productos', {
    codigo_barras: '7501000000404', descripcion: 'Amoxicilina 500 mg', precio_costo: 40, precio_venta: 89, sucursal_id: 2, existencia_inicial: 6,
  })).body.id;
  const nube = await crearNube(central);
  const celularCentral = await nube.vincular(1);
  const celularSur = await nube.vincular(3);

  let aLaCentral;
  await t.test('una sucursal arma y le manda un apoyo a la central', async () => {
    const r = await norte.post('/api/apoyos', { destino_id: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.folio, r.body.origen, r.body.destino, r.body.estado], [1, 'Sucursal Norte', 'Farmacia Central', 'borrador']);
    const demasiado = await norte.post(`/api/apoyos/${r.body.id}/renglones`, { codigo_barras: '7501000000404', cantidad: 9 });
    assert.equal(demasiado.status, 200, 'se puede capturar, pero no enviar sin existencia');
    assert.equal((await norte.post(`/api/apoyos/${r.body.id}/enviar`, {})).status, 400);
    const renglon = demasiado.body.renglones[0];
    assert.equal((await norte.put(`/api/apoyos/${r.body.id}/renglones/${renglon.id}`, { cantidad: 1 })).status, 200);
    assert.equal((await sur.post(`/api/apoyos/${r.body.id}/renglones`, { codigo_barras: '7501000000404', cantidad: 1 })).status, 400,
      'otra farmacia no toca un apoyo ajeno');
    const enviado = await norte.post(`/api/apoyos/${r.body.id}/enviar`, { nota: 'Le faltaba a la central' });
    assert.equal(enviado.status, 200, JSON.stringify(enviado.body));
    assert.equal(enviado.body.estado, 'enviado');
    assert.equal(stock(amox, 2), 5, 'sale del inventario de la sucursal');
    aLaCentral = enviado.body;
    const enCamino = (await norte.get('/api/apoyos')).body.filter((a) => a.estado === 'enviado');
    assert.deepEqual(enCamino.map((a) => [a.folio, a.destino]), [[1, 'Farmacia Central']], 'quien lo manda lo ve en camino');
  });

  await t.test('quien lo manda ya no lo puede cancelar; la central lo recibe con el celular', async () => {
    assert.equal((await norte.post(`/api/apoyos/${aLaCentral.id}/cancelar`, { motivo: 'x' })).status, 403);
    const lista = await nube.pedir('GET', '/api/apoyos?estado=enviado', { token: celularCentral });
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.deepEqual(lista.body.map((a) => [a.folio, a.origen, a.piezas]), [[1, 'Sucursal Norte', 1]]);
    const recibido = await nube.pedir('POST', `/api/apoyos/${aLaCentral.id}/recibir`, { token: celularCentral, cuerpo: {} });
    assert.equal(recibido.status, 200, JSON.stringify(recibido.body));
    assert.equal(recibido.body.estado, 'recibido');
    assert.equal(stock(amox, 1), 1, 'entra al inventario de la central');
    const notas = central.db.prepare('SELECT sucursal_id, tipo, nota FROM movimientos_inventario WHERE producto_id = ? AND nota LIKE ? ORDER BY id').all(amox, 'Apoyo%');
    assert.deepEqual(notas.map((m) => [m.sucursal_id, m.tipo, m.nota]), [
      [2, 'salida', 'Apoyo folio 1 enviado a Farmacia Central'],
      [1, 'entrada', 'Apoyo folio 1 recibido de Sucursal Norte'],
    ]);
  });

  await t.test('de sucursal a sucursal; la que recibe puede cancelar el envío y regresa a la que lo mandó', async () => {
    const r = await norte.post('/api/apoyos', { destino_id: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.folio, 2, 'el folio sigue la numeración de la sucursal que lo manda');
    await norte.post(`/api/apoyos/${r.body.id}/renglones`, { producto_id: amox, cantidad: 2 });
    assert.equal((await norte.post(`/api/apoyos/${r.body.id}/enviar`, {})).status, 200);
    assert.equal(stock(amox, 2), 3);
    const sinMotivo = await sur.post(`/api/apoyos/${r.body.id}/cancelar`, {});
    assert.equal(sinMotivo.status, 400);
    const cancelado = await sur.post(`/api/apoyos/${r.body.id}/cancelar`, { motivo: 'Ya lo consiguieron' });
    assert.equal(cancelado.status, 200, JSON.stringify(cancelado.body));
    assert.equal(stock(amox, 2), 5, 'regresa a la sucursal que lo mandó');

    const otro = (await norte.post('/api/apoyos', { destino_id: 3 })).body;
    await norte.post(`/api/apoyos/${otro.id}/renglones`, { producto_id: amox, cantidad: 1 });
    await norte.post(`/api/apoyos/${otro.id}/enviar`, {});
    const recibido = await nube.pedir('POST', `/api/apoyos/${otro.id}/recibir`, { token: celularSur, cuerpo: {} });
    assert.equal(recibido.status, 200, JSON.stringify(recibido.body));
    assert.deepEqual([stock(amox, 2), stock(amox, 3)], [4, 1]);
  });

  await t.test('la sucursal descarta su borrador; la central sigue mandando a las sucursales', async () => {
    const borrador = (await sur.post('/api/apoyos', { destino_id: 2 })).body;
    await sur.post(`/api/apoyos/${borrador.id}/renglones`, { producto_id: amox, cantidad: 1 });
    const descartado = await sur.post(`/api/apoyos/${borrador.id}/cancelar`, {});
    assert.equal(descartado.status, 200, JSON.stringify(descartado.body));
    assert.equal(stock(amox, 3), 1, 'un borrador no mueve inventario');
    assert.equal((await sur.post('/api/apoyos', { destino_id: 3 })).status, 400, 'no se manda a sí misma');

    const deLaCentral = (await admin.post('/api/apoyos', { destino_id: 2 })).body;
    await admin.post(`/api/apoyos/${deLaCentral.id}/renglones`, { producto_id: amox, cantidad: 1 });
    const enviado = await admin.post(`/api/apoyos/${deLaCentral.id}/enviar`, {});
    assert.equal(enviado.status, 200, JSON.stringify(enviado.body));
    assert.equal(stock(amox, 1), 0);
  });

  await t.test('el jefe ve en el registro de cambios quién mandó cada apoyo', async () => {
    await esperarQue(() => central.db.prepare("SELECT COUNT(*) AS n FROM bitacora WHERE tipo = 'apoyo_enviado'").get().n >= 4, 'el registro de cambios');
    const enviados = central.db.prepare("SELECT sucursal_id, descripcion FROM bitacora WHERE tipo = 'apoyo_enviado' ORDER BY id").all();
    assert.deepEqual(enviados.map((b) => [b.sucursal_id, b.descripcion]), [
      [2, 'Folio 1 a Farmacia Central: 1 producto(s), 1 pieza(s)'],
      [2, 'Folio 2 a Sucursal Sur: 1 producto(s), 2 pieza(s)'],
      [2, 'Folio 3 a Sucursal Sur: 1 producto(s), 1 pieza(s)'],
      [1, 'Folio 1 a Sucursal Norte: 1 producto(s), 1 pieza(s)'],
    ]);
  });

  assert.deepEqual(nube.errores, []);
});
