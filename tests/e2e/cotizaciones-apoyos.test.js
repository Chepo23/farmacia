'use strict';
// Cotizaciones (el jefe las arma en el celular y la sucursal las cobra en la caja) y revisión de
// apoyos desde el celular, con la central falsa, la función "movil" y la computadora de una sucursal.
// También el modo local (una sola computadora sin Supabase).
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, escenarioLocal, entrar } = require('../helpers/escenario');
const { crearNube } = require('../helpers/nube');

const PARACETAMOL = '7501234567893';
const VITAMINA = '7509876543213';

function sembrarProductos(db) {
  const producto = db.prepare(
    `INSERT INTO productos (id, codigo_barras, descripcion, precio_costo, precio_venta, precio_mayoreo, cantidad_mayoreo, usa_inventario, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
  );
  producto.run(1, PARACETAMOL, 'Paracetamol 500 mg c/10', 14.5, 28, 25, 3);
  producto.run(2, VITAMINA, 'Vitamina C 1000 mg c/30', 24, 42, null, null);
  const inventario = db.prepare('INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo) VALUES (?, ?, ?, ?)');
  inventario.run(1, 1, 20, 0);
  inventario.run(1, 2, 10, 0);
  inventario.run(2, 2, 5, 0);
}

const existencia = (db, productoId, sucursalId) =>
  db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId)?.existencia;

const venta = (cotizacionId, partidas) => ({
  partidas, forma_pago: 'efectivo', pago: 1000, cotizacion_id: cotizacionId,
});

test('cotizaciones del jefe cobradas en la sucursal (con la central)', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['norte'] });
  t.after(cerrarTodo);
  sembrarProductos(central.db);
  const nube = await crearNube(central);
  const jefe = await nube.vincular(1);
  const cajeroCel = await nube.vincular(2);
  const caja = await entrar(servidores.norte.base, 'cajero2', '1234');
  const cotizar = (cuerpo, token = jefe) => nube.pedir('POST', '/api/cotizaciones', { token, cuerpo });
  let primera;

  await t.test('solo el administrador de la central cotiza, y a destinos válidos', async () => {
    const cajero = await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 1, cantidad: 1 }] }, cajeroCel);
    assert.equal(cajero.status, 403);
    const destinos = await nube.pedir('GET', '/api/cotizaciones/destinos', { token: jefe });
    assert.equal(destinos.status, 200, JSON.stringify(destinos.body));
    assert.deepEqual(destinos.body.sucursales.map((s) => s.id), [1, 2, 3]);
    assert.ok(destinos.body.usuarios.some((u) => u.id === 2 && u.sucursal_id === 2));
    const otraSucursal = await cotizar({ destino_sucursal_id: 2, destino_usuario_id: 3, renglones: [{ producto_id: 1, cantidad: 1 }] });
    assert.equal(otraSucursal.status, 400);
    assert.match(otraSucursal.body.error, /otra sucursal/);
    const vacia = await cotizar({ destino_sucursal_id: 2, renglones: [] });
    assert.equal(vacia.status, 400);
    const precioMalo = await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 1, cantidad: 1, precio_unitario: -1 }] });
    assert.equal(precioMalo.status, 400);
  });

  await t.test('el jefe arma la cotización en el celular: junta renglones y respeta su precio', async () => {
    const r = await cotizar({
      destino_sucursal_id: 2, destino_usuario_id: 2, cliente: 'Juan Pérez', nota: 'Pasa en la tarde',
      renglones: [{ producto_id: 1, cantidad: 2, precio_unitario: 22 }, { producto_id: 2, cantidad: 1 }, { producto_id: 1, cantidad: 1 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    primera = r.body;
    assert.equal(primera.folio, 1);
    assert.equal(primera.estado, 'enviada');
    assert.equal(primera.vigente, true);
    assert.equal(primera.destino, 'Sucursal Norte');
    assert.equal(primera.destino_usuario, 'Cajero Norte');
    assert.equal(primera.total, 108); // 3 × 22 + 42
    assert.deepEqual(primera.renglones.map((x) => [x.producto_id, x.cantidad, x.precio_unitario, x.precio_lista]), [[1, 3, 22, 28], [2, 1, 42, 42]]);
    const dias = (new Date(primera.vigente_hasta) - new Date(primera.creado)) / 86400000;
    assert.ok(Math.abs(dias - 7) < 0.01, `vigencia de ${dias} días`);

    const enviadas = await nube.pedir('GET', '/api/cotizaciones?bandeja=enviadas', { token: jefe });
    assert.equal(enviadas.body.length, 1);
    const ajenas = await nube.pedir('GET', '/api/cotizaciones?bandeja=enviadas', { token: cajeroCel });
    assert.equal(ajenas.status, 403);
  });

  await t.test('a la sucursal le aparece en la caja con los datos de hoy de cada producto', async () => {
    const pendientes = await caja.get('/api/cotizaciones/pendientes');
    assert.deepEqual(pendientes.body, { pendientes: 1, para_mi: 1 });
    const lista = await caja.get('/api/cotizaciones?estado=enviada');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.deepEqual(lista.body.map((c) => c.folio), [1]);
    const detalle = await caja.get(`/api/cotizaciones/${primera.id}?productos=1`);
    assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
    const paracetamol = detalle.body.productos_actuales.find((p) => p.id === 1);
    assert.equal(paracetamol.existencia_local, 10);
    assert.equal(paracetamol.precio_venta, 28);
  });

  let folioVenta;
  await t.test('al cobrarla se respeta el precio cotizado y queda como vendida', async () => {
    const r = await caja.post('/api/ventas', venta(primera.id, [{ producto_id: 1, cantidad: 3 }, { producto_id: 2, cantidad: 1 }]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 108);
    assert.deepEqual(r.body.cotizacion, { id: primera.id, folio: 1, vigente: true });
    folioVenta = r.body.folio;
    const fila = central.db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(primera.id);
    assert.equal(fila.estado, 'vendida');
    assert.equal(fila.vendida_folio, folioVenta);
    assert.equal(fila.vendida_por, 2);
    const ticket = await caja.get(`/api/ventas/${r.body.ventaId}`);
    assert.match(ticket.body.nota, /Cotización folio 1 · Juan Pérez/);
    assert.deepEqual(ticket.body.partidas.map((p) => [p.producto_id, p.precio_unitario, p.precio_lista]), [[1, 22, 28], [2, 42, 42]]);
    assert.equal(existencia(central.db, 1, 2), 7);
    const jefeVe = await nube.pedir('GET', `/api/cotizaciones/${primera.id}`, { token: jefe });
    assert.equal(jefeVe.body.estado, 'vendida');
    assert.equal(jefeVe.body.vendedor, 'Cajero Norte');
  });

  await t.test('no se puede cobrar dos veces la misma cotización', async () => {
    const ventasAntes = (await caja.get('/api/ventas')).body.length;
    const r = await caja.post('/api/ventas', venta(primera.id, [{ producto_id: 1, cantidad: 1 }]));
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'COTIZACION_USADA');
    assert.match(r.body.error, new RegExp(`venta folio ${folioVenta}`));
    assert.equal((await caja.get('/api/ventas')).body.length, ventasAntes);
    assert.equal(existencia(central.db, 1, 2), 7);
  });

  await t.test('si se llevan más piezas de las cotizadas, o ya venció, se cobra el precio de hoy', async () => {
    const poca = (await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 2, cantidad: 1, precio_unitario: 30 }] })).body;
    const mas = await caja.post('/api/ventas', venta(poca.id, [{ producto_id: 2, cantidad: 2 }]));
    assert.equal(mas.status, 200, JSON.stringify(mas.body));
    assert.equal(mas.body.total, 84);

    const vieja = (await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 2, cantidad: 1, precio_unitario: 30 }] })).body;
    central.db.prepare('UPDATE cotizaciones SET vigente_hasta = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), vieja.id);
    const detalle = await caja.get(`/api/cotizaciones/${vieja.id}`);
    assert.equal(detalle.body.vigente, false);
    const vencida = await caja.post('/api/ventas', venta(vieja.id, [{ producto_id: 2, cantidad: 1 }]));
    assert.equal(vencida.status, 200, JSON.stringify(vencida.body));
    assert.equal(vencida.body.total, 42);
    assert.equal(vencida.body.cotizacion.vigente, false);

    // Si el precio de hoy es más bajo que el cotizado, se cobra el de hoy
    const cara = (await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 2, cantidad: 1, precio_unitario: 50 }] })).body;
    const barata = await caja.post('/api/ventas', venta(cara.id, [{ producto_id: 2, cantidad: 1 }]));
    assert.equal(barata.body.total, 42);
  });

  await t.test('si la venta falla, la cotización vuelve a quedar disponible', async () => {
    const grande = (await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 1, cantidad: 50, precio_unitario: 20 }] })).body;
    const r = await caja.post('/api/ventas', venta(grande.id, [{ producto_id: 1, cantidad: 50 }]));
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'SIN_EXISTENCIA');
    const fila = central.db.prepare('SELECT estado, vendida_por, vendida_folio FROM cotizaciones WHERE id = ?').get(grande.id);
    assert.deepEqual({ ...fila }, { estado: 'enviada', vendida_por: null, vendida_folio: null });
  });

  await t.test('el jefe la cancela y la sucursal ya no la puede cobrar; las de otra sucursal no se ven', async () => {
    const otra = (await cotizar({ destino_sucursal_id: 2, renglones: [{ producto_id: 1, cantidad: 1 }] })).body;
    const noPuede = await nube.pedir('POST', `/api/cotizaciones/${otra.id}/cancelar`, { token: cajeroCel });
    assert.equal(noPuede.status, 403);
    const cancelada = await nube.pedir('POST', `/api/cotizaciones/${otra.id}/cancelar`, { token: jefe });
    assert.equal(cancelada.status, 200, JSON.stringify(cancelada.body));
    assert.equal(cancelada.body.estado, 'cancelada');
    const r = await caja.post('/api/ventas', venta(otra.id, [{ producto_id: 1, cantidad: 1 }]));
    assert.equal(r.body.codigo, 'COTIZACION_USADA');
    assert.match(r.body.error, /cancelada/);

    const sur = (await cotizar({ destino_sucursal_id: 3, renglones: [{ producto_id: 1, cantidad: 1 }] })).body;
    assert.equal((await caja.get(`/api/cotizaciones/${sur.id}`)).status, 403);
    assert.equal((await caja.post('/api/ventas', venta(sur.id, [{ producto_id: 1, cantidad: 1 }]))).status, 403);
    const pendientes = await caja.get('/api/cotizaciones/pendientes');
    assert.equal(pendientes.body.pendientes, 1, 'solo la que falló por existencia sigue pendiente en Norte');
  });

  await t.test('sin conexión con la central se avisa que se quite la cotización', async () => {
    const pendiente = central.db.prepare("SELECT id FROM cotizaciones WHERE estado = 'enviada' AND destino_sucursal_id = 2").get();
    central.simularCaida(true);
    try {
      const r = await caja.post('/api/ventas', venta(pendiente.id, [{ producto_id: 1, cantidad: 1 }]));
      assert.equal(r.status, 503);
      assert.equal(r.body.codigo, 'COTIZACION_SIN_CONEXION');
    } finally {
      central.simularCaida(false);
    }
  });

  assert.deepEqual(nube.errores, []);
});

test('revisión de apoyos desde el celular (función "movil")', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['norte'] });
  t.after(cerrarTodo);
  sembrarProductos(central.db);
  const nube = await crearNube(central);
  const norte = await nube.vincular(2);
  const sur = await nube.vincular(3);
  const apoyo = central.db.prepare(
    `INSERT INTO apoyos (folio, origen_id, destino_id, estado, nota, creado_por, enviado_por, enviado)
     VALUES (1, 1, 2, 'enviado', 'Urgente', 1, 1, ?)`
  ).run(new Date().toISOString()).lastInsertRowid;
  const renglon = central.db.prepare(
    `INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad, precio_costo, precio_venta, importe)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0)`
  );
  const rParacetamol = renglon.run(apoyo, 1, PARACETAMOL, 'Paracetamol 500 mg c/10', 5).lastInsertRowid;
  const rVitamina = renglon.run(apoyo, 2, VITAMINA, 'Vitamina C 1000 mg c/30', 2).lastInsertRowid;

  await t.test('la sucursal ve los apoyos que le llegan, con sus renglones', async () => {
    const lista = await nube.pedir('GET', '/api/apoyos?estado=enviado', { token: norte });
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.deepEqual(lista.body.map((a) => [a.folio, a.origen, a.renglones, a.piezas]), [[1, 'Farmacia Central', 2, 7]]);
    const detalle = await nube.pedir('GET', `/api/apoyos/${apoyo}`, { token: norte });
    assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
    assert.deepEqual(detalle.body.renglones.map((r) => [r.codigo_barras, r.cantidad, r.usa_inventario]), [[PARACETAMOL, 5, 1], [VITAMINA, 2, 1]]);
    assert.equal((await nube.pedir('GET', `/api/apoyos/${apoyo}`, { token: sur })).status, 403);
    assert.deepEqual((await nube.pedir('GET', '/api/apoyos?estado=enviado', { token: sur })).body, []);
  });

  await t.test('no se puede recibir más de lo que se mandó ni desde otra sucursal', async () => {
    const demas = await nube.pedir('POST', `/api/apoyos/${apoyo}/recibir`, { token: norte, cuerpo: { renglones: [{ id: rParacetamol, cantidad_recibida: 6 }] } });
    assert.equal(demas.status, 400);
    const ajena = await nube.pedir('POST', `/api/apoyos/${apoyo}/recibir`, { token: sur, cuerpo: {} });
    assert.equal(ajena.status, 403);
    assert.equal(central.db.prepare('SELECT estado FROM apoyos WHERE id = ?').get(apoyo).estado, 'enviado');
    assert.equal(existencia(central.db, 1, 2), 10);
  });

  await t.test('recibir con diferencias: entra lo que llegó y las diferencias quedan anotadas', async () => {
    const r = await nube.pedir('POST', `/api/apoyos/${apoyo}/recibir`, {
      token: norte,
      cuerpo: {
        renglones: [{ id: rParacetamol, cantidad_recibida: 4 }, { id: rVitamina, cantidad_recibida: 2 }],
        nota_recepcion: 'Revisado con el celular: faltaron 1 Paracetamol 500 mg c/10',
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'recibido');
    assert.equal(r.body.receptor, 'Cajero Norte');
    assert.equal(r.body.nota, 'Urgente · Recepción: Revisado con el celular: faltaron 1 Paracetamol 500 mg c/10');
    assert.deepEqual(r.body.renglones.map((x) => x.cantidad_recibida), [4, 2]);
    assert.equal(existencia(central.db, 1, 2), 14);
    assert.equal(existencia(central.db, 2, 2), 7);
    const movimiento = central.db.prepare("SELECT * FROM movimientos_inventario WHERE producto_id = 1 AND sucursal_id = 2 ORDER BY id DESC").get();
    assert.equal(movimiento.nota, 'Apoyo folio 1 recibido de Farmacia Central');
    assert.equal(movimiento.existencia_resultante, 14);
    const otraVez = await nube.pedir('POST', `/api/apoyos/${apoyo}/recibir`, { token: norte, cuerpo: {} });
    assert.equal(otraVez.status, 400);
    assert.equal(existencia(central.db, 1, 2), 14);
  });

  await t.test('la computadora de la sucursal ve el apoyo recibido con la nota', async () => {
    const caja = await entrar(servidores.norte.base, 'cajero2', '1234', { caja: false });
    const r = await caja.get(`/api/apoyos/${apoyo}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'recibido');
    assert.match(r.body.nota, /faltaron 1 Paracetamol/);
    assert.equal(r.body.faltantes, 1);
  });

  assert.deepEqual(nube.errores, []);
});

test('cotizaciones y nota de recepción sin Supabase (una sola computadora)', async (t) => {
  const { servidor, cerrarTodo } = await escenarioLocal();
  t.after(cerrarTodo);
  const admin = await entrar(servidor.base, 'admin', 'admin');
  const alta = await admin.post('/api/productos', { codigo_barras: PARACETAMOL, descripcion: 'Paracetamol 500 mg c/10', precio_costo: 14.5, precio_venta: 28, existencia_inicial: 10 });
  assert.equal(alta.status, 200, JSON.stringify(alta.body));
  const usuario = await admin.post('/api/admin/usuarios', { nombre: 'Cajero Dos', usuario: 'cajero2', password: '1234', rol: 'cajero', sucursal_id: 2 });
  assert.equal(usuario.status, 200, JSON.stringify(usuario.body));
  const cajero = await entrar(servidor.base, 'cajero2', '1234');

  await t.test('las ventas que quedaron abiertas se actualizan con los datos de hoy de sus productos', async () => {
    const r = await admin.get(`/api/productos?ids=${alta.body.id},999999`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((p) => [p.id, p.precio_venta, p.existencia_local]), [[alta.body.id, 28, 10]]);
  });

  await t.test('cotizar, cobrar y no repetir', async () => {
    const noPuede = await cajero.post('/api/cotizaciones', { destino_sucursal_id: 1, renglones: [{ producto_id: alta.body.id, cantidad: 1 }] });
    assert.equal(noPuede.status, 403);
    const c = await admin.post('/api/cotizaciones', { destino_sucursal_id: 1, cliente: 'Mostrador', renglones: [{ producto_id: alta.body.id, cantidad: 2, precio_unitario: 25 }] });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.folio, 1);
    assert.equal(c.body.total, 50);
    assert.equal((await cajero.get(`/api/cotizaciones/${c.body.id}`)).status, 403);
    assert.deepEqual((await admin.get('/api/cotizaciones/pendientes')).body, { pendientes: 1, para_mi: 0 });
    const r = await admin.post('/api/ventas', venta(c.body.id, [{ producto_id: alta.body.id, cantidad: 2 }]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 50);
    const vista = await admin.get(`/api/cotizaciones/${c.body.id}`);
    assert.equal(vista.body.estado, 'vendida');
    assert.equal(vista.body.vendida_folio, r.body.folio);
    const otra = await admin.post('/api/ventas', venta(c.body.id, [{ producto_id: alta.body.id, cantidad: 1 }]));
    assert.equal(otra.body.codigo, 'COTIZACION_USADA');
    const cancelar = await admin.post(`/api/cotizaciones/${c.body.id}/cancelar`, {});
    assert.equal(cancelar.status, 400, 'una cotización cobrada ya no se cancela');
  });

  await t.test('la nota de la revisión con el celular queda en el apoyo', async () => {
    const apoyo = await admin.post('/api/apoyos', { destino_id: 2 });
    await admin.post(`/api/apoyos/${apoyo.body.id}/renglones`, { codigo_barras: PARACETAMOL, cantidad: 3 });
    await admin.put(`/api/apoyos/${apoyo.body.id}`, { nota: 'Para el fin de semana' });
    assert.equal((await admin.post(`/api/apoyos/${apoyo.body.id}/enviar`, {})).status, 200);
    const renglonId = (await cajero.get(`/api/apoyos/${apoyo.body.id}`)).body.renglones[0].id;
    const r = await cajero.post(`/api/apoyos/${apoyo.body.id}/recibir`, {
      renglones: [{ id: renglonId, cantidad_recibida: 2 }],
      nota_recepcion: 'Revisado con el celular: faltaron 1 Paracetamol 500 mg c/10',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.nota, 'Para el fin de semana · Recepción: Revisado con el celular: faltaron 1 Paracetamol 500 mg c/10');
    assert.equal(r.body.faltantes, 1);
  });
});
