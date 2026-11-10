'use strict';
// Estadísticas del corte (utilidad bruta, ventas por departamento, lo más vendido) y existencias
// de referencia al pedir y al armar un apoyo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioLocal, escenarioCentral, entrar } = require('../helpers/escenario');

const venta = (partidas) => ({ partidas, forma_pago: 'efectivo', pago: 1000 });

test('el corte trae ventas por departamento y estadísticas confiables', async (t) => {
  const { servidor, cerrarTodo } = await escenarioLocal();
  t.after(cerrarTodo);
  const admin = await entrar(servidor.base, 'admin', 'admin');
  await admin.post('/api/departamentos', { nombre: 'Analgésicos' });
  const paracetamol = (await admin.post('/api/productos', {
    codigo_barras: '7501234567893', descripcion: 'Paracetamol 500 mg', departamento: 'Analgésicos',
    precio_costo: 14.5, precio_venta: 28, existencia_inicial: 20,
  })).body.id;
  const sinCosto = (await admin.post('/api/productos', {
    codigo_barras: '7509876543213', descripcion: 'Bolsa ecológica', precio_venta: 10, existencia_inicial: 20,
  })).body.id;

  await t.test('pendiente de corte: utilidad solo de lo que tiene costo', async () => {
    assert.equal((await admin.post('/api/ventas', venta([{ producto_id: paracetamol, cantidad: 2 }, { producto_id: sinCosto, cantidad: 1 }]))).status, 200);
    assert.equal((await admin.post('/api/ventas', venta([{ comun: true, descripcion: 'Jeringa suelta', cantidad: 1, precio: 50 }]))).status, 200);
    const cancelada = await admin.post('/api/ventas', venta([{ producto_id: paracetamol, cantidad: 5 }]));
    assert.equal((await admin.post(`/api/ventas/${cancelada.body.ventaId}/cancelar`, { motivo: 'prueba' })).status, 200);

    const p = (await admin.get('/api/cortes/pendiente')).body;
    assert.deepEqual(p.departamentos.map((d) => [d.departamento, d.total, d.piezas]), [
      ['Analgésicos', 56, 2], ['Artículo común', 50, 1], ['Sin departamento', 10, 1],
    ]);
    const e = p.estadisticas;
    assert.equal(e.vendido, 116);
    assert.equal(e.costo, 29);
    assert.equal(e.utilidad_bruta, 27, '56 vendido con costo − 29 de costo');
    assert.equal(e.margen, 48.2);
    assert.equal(e.vendido_sin_costo, 60, 'la bolsa y el artículo común no inflan la utilidad');
    assert.equal(e.ticket_promedio, 58);
    assert.equal(e.venta_mayor, 66);
    assert.equal(e.piezas, 4);
    assert.deepEqual(e.mas_vendidos[0], { descripcion: 'Paracetamol 500 mg', piezas: 2, total: 56 });
  });

  await t.test('el corte guardado (y su reimpresión) trae lo mismo', async () => {
    const r = await admin.post('/api/cortes', { efectivo_contado: 116 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.corte.estadisticas.utilidad_bruta, 27);
    assert.equal(r.body.corte.departamentos.length, 3);
    const otraVez = await admin.get(`/api/cortes/${r.body.id}`);
    assert.deepEqual(otraVez.body.estadisticas, r.body.corte.estadisticas);
    const despues = (await admin.get('/api/cortes/pendiente')).body;
    assert.deepEqual(despues.departamentos, []);
    assert.equal(despues.estadisticas.vendido, 0);
  });

  await t.test('el RFC de la farmacia ya viene puesto para los tickets', async () => {
    assert.equal((await admin.get('/api/config')).body.negocio_rfc, 'RIMA840116U87');
  });
});

test('al pedir y al armar el apoyo se ve cuánto hay en cada farmacia', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  central.db.prepare(
    "INSERT INTO productos (id, codigo_barras, descripcion, precio_costo, precio_venta, usa_inventario, activo) VALUES (1, '7501234567893', 'Paracetamol 500 mg', 14.5, 28, 1, 1)"
  ).run();
  central.db.prepare('INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo) VALUES (1, 1, 20, 0), (1, 2, 3, 5)').run();
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234', { caja: false });
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  let pedidoId;

  await t.test('la sucursal ve lo que tiene ella y lo que hay en la central', async () => {
    const pedido = (await norte.post('/api/pedidos', {})).body;
    pedidoId = pedido.id;
    const r = await norte.post(`/api/pedidos/${pedidoId}/renglones`, { codigo_barras: '7501234567893', cantidad: 6 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.central, 'Farmacia Central');
    assert.deepEqual(r.body.renglones.map((x) => [x.cantidad, x.existencia_sucursal, x.existencia_central]), [[6, 3, 20]]);
    assert.equal((await norte.post(`/api/pedidos/${pedidoId}/enviar`, {})).status, 200);
  });

  await t.test('la central arma el apoyo viendo su existencia y la de la sucursal', async () => {
    const apoyo = await admin.post('/api/apoyos', { destino_id: 2, pedido_id: pedidoId });
    assert.equal(apoyo.status, 200, JSON.stringify(apoyo.body));
    assert.deepEqual(apoyo.body.renglones.map((x) => [x.cantidad, x.existencia_origen, x.existencia_destino]), [[6, 20, 3]]);
    const vistaPedido = await admin.get(`/api/pedidos/${pedidoId}`);
    assert.deepEqual(vistaPedido.body.renglones.map((x) => [x.existencia_sucursal, x.existencia_central]), [[3, 20]]);
  });
});
