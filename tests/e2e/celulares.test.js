'use strict';
// Celulares vinculados a la app en la nube: la computadora genera el código, el celular se vincula
// con la función "movil" y ambos ven y mueven el mismo inventario de la central.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, escenarioLocal, entrar } = require('../helpers/escenario');
const { cliente } = require('../helpers/servidor');
const { crearNube, sha256 } = require('../helpers/nube');

const CODIGO = '7501000000024';

function existencia(producto, sucursalId) {
  assert.ok(producto, 'el producto no apareció');
  return producto.existencias.find((e) => e.sucursal_id === sucursalId)?.existencia;
}

test('celulares vinculados desde la computadora', async (t) => {
  const escenario = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(() => escenario.cerrarTodo());
  const { central, servidores } = escenario;
  const nube = await crearNube(central);
  const admin = await entrar(servidores.central.base, 'admin', 'admin');
  const cajero = await entrar(servidores.norte.base, 'cajero2', '1234');
  let tokenAdmin;
  let tokenCajero;
  let productoId;

  await t.test('la computadora genera un código de un solo uso y el celular se vincula', async () => {
    let r = await admin.post('/api/celulares/vincular', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(r.body.url, null, 'sin la dirección de la app no hay QR');
    const primero = r.body.codigo;

    // Con la dirección de la app, el QR lleva el código después de "#"
    const config = await admin.put('/api/config', { url_movil: 'https://farmacia-inventario.pages.dev/' });
    assert.equal(config.status, 200, JSON.stringify(config.body));
    r = await admin.post('/api/celulares/vincular', {});
    assert.equal(r.body.url, `https://farmacia-inventario.pages.dev/#vincular=${r.body.codigo.replace('-', '')}`);
    assert.equal(r.body.usuario.nombre, 'Administrador');
    const minutos = (new Date(r.body.expira).getTime() - Date.now()) / 60000;
    assert.ok(minutos > 14 && minutos <= 15, `dura 15 minutos (${minutos})`);

    const viejo = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo: primero } });
    assert.equal(viejo.status, 400, 'un código nuevo reemplaza al que no se usó');
    const nuevo = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo: r.body.url, dispositivo: 'iPhone' } });
    assert.equal(nuevo.status, 200, JSON.stringify(nuevo.body));
    tokenAdmin = nuevo.body.token;
    assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM vinculos_movil WHERE usado IS NULL').get().n, 0);
  });

  await t.test('cada quien vincula su propio celular; el admin de la central puede vincular el de otros', async () => {
    let r = await cajero.post('/api/celulares/vincular', { usuario_id: 1 });
    assert.equal(r.status, 403, 'un cajero no genera códigos para otra cuenta');
    r = await cajero.post('/api/celulares/vincular', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usuario.id, 2);
    const vinculo = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo: r.body.codigo, dispositivo: 'Android · Galaxy A15' } });
    tokenCajero = vinculo.body.token;
    assert.equal(vinculo.body.usuario.sucursal_id, 2);

    r = await admin.post('/api/celulares/vincular', { usuario_id: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.body.usuario.nombre, 'Cajero Sur');
    r = await admin.post('/api/celulares/vincular', { usuario_id: 999 });
    assert.equal(r.status, 404);
  });

  await t.test('lista de celulares: el admin ve todos, el cajero solo los suyos', async () => {
    const todos = await admin.get('/api/celulares');
    assert.equal(todos.status, 200);
    assert.deepEqual(todos.body.sesiones.map((s) => [s.usuario, s.dispositivo]).sort(),
      [['Administrador', 'iPhone'], ['Cajero Norte', 'Android · Galaxy A15']]);
    const suyos = await cajero.get('/api/celulares');
    assert.deepEqual(suyos.body.sesiones.map((s) => s.usuario), ['Cajero Norte']);
  });

  await t.test('el celular y las computadoras ven y mueven el mismo inventario', async () => {
    const alta = await admin.post('/api/productos', {
      codigo_barras: CODIGO, descripcion: 'Ibuprofeno 400 mg c/10', precio_costo: 20, precio_venta: 35, existencia_inicial: 10,
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.body));
    productoId = alta.body.id;

    // Entrada desde el celular del cajero (sucursal norte)
    let r = await nube.pedir('POST', `/api/productos/${productoId}/inventario`, { token: tokenCajero, cuerpo: { tipo: 'entrada', cantidad: 4, sucursal_id: 2 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const enNorte = await cajero.get(`/api/productos/codigo/${CODIGO}`);
    assert.equal(existencia(enNorte.body, 2), 4, 'la computadora de la sucursal ve la entrada del celular');
    assert.equal(existencia(enNorte.body, 1), 10);

    // Venta en la computadora de la sucursal: el celular ve el descuento
    const venta = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo', pago: 100 });
    assert.equal(venta.status, 200, JSON.stringify(venta.body));
    r = await nube.pedir('GET', `/api/productos/codigo/${CODIGO}`, { token: tokenAdmin });
    assert.deepEqual(r.body.existencias.map((e) => e.existencia), [10, 3, 0]);

    // Precio cambiado desde el celular del admin: lo cobran las computadoras
    r = await nube.pedir('PUT', `/api/productos/${productoId}`, {
      token: tokenAdmin, cuerpo: { codigo_barras: CODIGO, descripcion: 'Ibuprofeno 400 mg c/10', precio_costo: 20, precio_venta: 38, usa_inventario: true },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const precio = await cajero.get(`/api/productos/codigo/${CODIGO}`);
    assert.equal(precio.body.precio_venta, 38);
    const venta2 = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo', pago: 100 });
    assert.equal(venta2.status, 200, JSON.stringify(venta2.body));
    assert.equal(venta2.body.total, 38);

    // Kardex: los movimientos del celular y de la computadora en el mismo historial
    const kardex = await admin.get(`/api/productos/${productoId}/kardex?sucursal_id=2`);
    assert.deepEqual(kardex.body.movimientos.map((m) => m.tipo), ['venta', 'venta', 'entrada']);
  });

  await t.test('desvincular un celular lo saca al momento', async () => {
    const lista = (await admin.get('/api/celulares')).body.sesiones;
    const delAdmin = lista.find((s) => s.usuario === 'Administrador');
    const delCajero = lista.find((s) => s.usuario === 'Cajero Norte');
    let r = await cajero.del(`/api/celulares/${delAdmin.id}`);
    assert.equal(r.status, 404, 'un cajero no desvincula celulares ajenos');
    r = await cajero.del(`/api/celulares/${delCajero.id}`);
    assert.equal(r.status, 200);
    assert.equal((await nube.pedir('GET', '/api/auth/yo', { token: tokenCajero })).status, 401);
    r = await admin.del(`/api/celulares/${delAdmin.id}`);
    assert.equal(r.status, 200);
    assert.equal((await nube.pedir('GET', '/api/auth/yo', { token: tokenAdmin })).status, 401);
    assert.ok(central.db.prepare('SELECT revocada FROM sesiones_movil WHERE token_hash = ?').get(sha256(tokenAdmin)).revocada);
    assert.deepEqual((await admin.get('/api/celulares')).body.sesiones, []);
  });

  assert.deepEqual(nube.errores, []);
});

test('sin la central (modo local) la app en la nube no está disponible', async (t) => {
  const { servidor, cerrarTodo } = await escenarioLocal();
  t.after(() => cerrarTodo());
  const admin = cliente(servidor.base);
  await admin.login('admin', 'admin');
  const r = await admin.post('/api/celulares/vincular', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.codigo, 'SIN_NUBE');
  const lista = await admin.get('/api/celulares');
  assert.equal(lista.status, 200);
  assert.equal(lista.body.disponible, false);
});
