'use strict';
// Fase 2: cada caja sube sus ventas, cortes, clientes con crédito y abonos a la central, y el jefe ve
// todas las farmacias (reporte, inicio, cortes para reimprimir y créditos), en la computadora y en el celular.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');
const { iniciarServidor } = require('../helpers/servidor');
const { crearNube } = require('../helpers/nube');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

async function esperarQue(condicion, que) {
  for (let i = 0; i < 80; i += 1) {
    if (await condicion()) return;
    await esperar(200);
  }
  throw new Error(`No se cumplió: ${que}`);
}

test('las ventas de cada caja llegan a la central y el jefe ve todas las farmacias', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const contar = (tabla, donde = '1 = 1') => central.db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${donde}`).get().n;
  const admin = await entrar(servidores.central.base, 'admin', 'admin');
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  const alta = await admin.post('/api/admin/usuarios', { nombre: 'Laura Jefa', usuario: 'laura', password: 'jefa1234', rol: 'jefe', sucursal_id: 1 });
  const jefa = await entrar(servidores.central.base, 'laura', 'jefa1234', { caja: false });
  await admin.post('/api/departamentos', { nombre: 'Analgésicos' });
  const para = (await admin.post('/api/productos', { codigo_barras: '7501000000101', descripcion: 'Paracetamol 500 mg', departamento: 'Analgésicos', precio_costo: 10, precio_venta: 25 })).body.id;
  const gasas = (await admin.post('/api/productos', { codigo_barras: '7501000000202', descripcion: 'Gasas', precio_costo: 4, precio_venta: 10 })).body.id;
  await norte.post(`/api/productos/${para}/inventario`, { tipo: 'entrada', cantidad: 50 });
  await norte.post(`/api/productos/${gasas}/inventario`, { tipo: 'entrada', cantidad: 50 });
  await admin.post(`/api/productos/${para}/inventario`, { tipo: 'entrada', cantidad: 20 });
  const vender = (caja, partidas, extra = {}) => caja.post('/api/ventas', { partidas, forma_pago: 'efectivo', pago: 1000, ...extra });
  let clienteId;
  let corteId;

  await t.test('Norte vende, cancela, fía, recibe un abono y hace su corte', async () => {
    assert.equal((await vender(norte, [{ producto_id: para, cantidad: 2 }, { producto_id: gasas, cantidad: 3 }])).status, 200);
    assert.equal((await vender(norte, [{ producto_id: para, cantidad: 1 }], { forma_pago: 'tarjeta', pago: 25 })).status, 200);
    const cancelada = await vender(norte, [{ producto_id: gasas, cantidad: 1 }]);
    assert.equal((await norte.post(`/api/ventas/${cancelada.body.ventaId}/cancelar`, { motivo: 'se equivocó de producto' })).status, 200);
    clienteId = (await norte.post('/api/clientes', { nombre: 'Doña Mari', limite_credito: 500, credito_autorizado: true })).body.id;
    const fiada = await vender(norte, [{ producto_id: para, cantidad: 4 }], { forma_pago: 'credito', cliente_id: clienteId, pago: 0 });
    assert.equal(fiada.status, 200, JSON.stringify(fiada.body));
    assert.equal((await norte.post(`/api/clientes/${clienteId}/abonos`, { monto: 30 })).status, 200);
    const corte = await norte.post('/api/cortes', { efectivo_contado: 500 });
    assert.equal(corte.status, 200, JSON.stringify(corte.body));
    corteId = corte.body.id;
    // La central también vende (otra caja, otra sucursal)
    assert.equal((await vender(admin, [{ producto_id: para, cantidad: 1 }])).status, 200);
  });

  await t.test('todo sube a la central sin duplicar, con su caja y su corte', async () => {
    await esperarQue(() => contar('ventas') === 5 && contar('cortes') === 1 && contar('abonos') === 1 && contar('clientes') === 1
      && contar('ventas', 'corte_clave IS NOT NULL') === 4, 'que suba todo');
    assert.equal(contar('cajas'), 2);
    assert.deepEqual(central.db.prepare('SELECT sucursal_id, numero FROM cajas ORDER BY sucursal_id').all().map((c) => [c.sucursal_id, c.numero]), [[1, 1], [2, 1]]);
    const deNorte = central.db.prepare('SELECT * FROM ventas WHERE sucursal_id = 2 ORDER BY folio').all();
    assert.deepEqual(deNorte.map((v) => [v.folio, v.forma_pago, v.total, v.costo, v.cancelada]),
      [[1, 'efectivo', 80, 32, 0], [2, 'tarjeta', 25, 10, 0], [3, 'efectivo', 10, 4, 1], [4, 'credito', 100, 40, 0]]);
    assert.equal(deNorte[3].cliente_nombre, 'Doña Mari');
    assert.equal(deNorte[2].motivo_cancelacion, 'se equivocó de producto');
    assert.equal(contar('venta_detalle'), 6, 'el detalle una sola vez aunque la venta se haya vuelto a subir');
    assert.equal(central.db.prepare("SELECT departamento FROM venta_detalle WHERE descripcion = 'Paracetamol 500 mg' LIMIT 1").get().departamento, 'Analgésicos');
    const cliente = central.db.prepare('SELECT * FROM clientes').get();
    assert.deepEqual([cliente.nombre, cliente.saldo, cliente.limite_credito], ['Doña Mari', 70, 500]);
    const corte = central.db.prepare('SELECT * FROM cortes').get();
    assert.equal(corte.num_ventas, 3);
    assert.equal(JSON.parse(corte.detalle).por_cajero[0].cajero, 'Cajero Norte');
    // Subir otra vez (por ejemplo, con "Sincronizar ahora") no duplica nada
    assert.equal((await admin.post('/api/sync/sincronizar', {})).status, 200);
    assert.equal(contar('ventas'), 5);
  });

  await t.test('el jefe ve el reporte de todas las farmacias, en Reportes y en el celular', async () => {
    const r = await jefa.get('/api/ventas-central/reporte?sucursal_id=todas');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.num_ventas, r.body.total_vendido, r.body.ganancia, r.body.efectivo, r.body.tarjeta, r.body.credito],
      [4, 230, 138, 105, 25, 100]);
    assert.deepEqual(r.body.canceladas, { num: 1, total: 10 });
    assert.equal(r.body.canceladas_detalle[0].motivo, 'se equivocó de producto');
    assert.equal(r.body.canceladas_detalle[0].vendio, 'Cajero Norte');
    assert.deepEqual(r.body.abonos, { num: 1, total: 30 });
    assert.deepEqual(r.body.por_sucursal.map((s) => [s.sucursal, s.total]), [['Sucursal Norte', 205], ['Farmacia Central', 25]]);
    assert.deepEqual(r.body.por_departamento.map((d) => [d.departamento, d.cantidad]), [['Analgésicos', 8], ['Sin departamento', 3]]);
    assert.equal(r.body.mas_vendidos[0].descripcion, 'Paracetamol 500 mg');
    const soloNorte = await jefa.get('/api/ventas-central/reporte?sucursal_id=2');
    assert.equal(soloNorte.body.total_vendido, 205);
    const enReportes = await jefa.get('/api/reportes/ventas?sucursal_id=todas');
    assert.equal(enReportes.body.fuente, 'central');
    assert.equal(enReportes.body.total_vendido, 230);
    // El administrador de la central ve solo lo de su computadora; el cajero, nada de la central
    const delAdmin = await admin.get('/api/reportes/ventas?sucursal_id=todas');
    assert.equal(delAdmin.body.total_vendido, 25);
    assert.equal((await admin.get('/api/ventas-central/reporte')).status, 403);
    assert.equal((await norte.get('/api/ventas-central/creditos')).status, 403);

    const nube = await crearNube(central);
    const token = await nube.vincular(Number(alta.body.id));
    const enCelular = await nube.pedir('GET', '/api/ventas-central/reporte', { token });
    assert.equal(enCelular.status, 200, JSON.stringify(enCelular.body));
    assert.equal(enCelular.body.total_vendido, 230);
    assert.deepEqual(nube.errores, []);
  });

  await t.test('inicio, cortes para reimprimir y créditos', async () => {
    const inicio = (await jefa.get('/api/supervision/inicio')).body;
    const deNorte = inicio.sucursales.find((s) => s.sucursal === 'Sucursal Norte').ventas_hoy;
    assert.deepEqual([deNorte.num_ventas, deNorte.total, deNorte.ganancia, deNorte.canceladas, deNorte.creditos, deNorte.clientes_con_saldo],
      [3, 205, 123, 1, 70, 1]);
    assert.equal(deNorte.ultimo_corte.diferencia, 500 - (500 + 80 + 30), 'contó 500 de 610 (fondo, venta en efectivo y abono)');
    assert.equal(deNorte.ultimo_corte.usuario, 'Cajero Norte');

    const cortes = (await jefa.get('/api/ventas-central/cortes')).body.cortes;
    assert.equal(cortes.length, 1);
    assert.equal(cortes[0].sucursal, 'Sucursal Norte');
    const corte = (await jefa.get(`/api/ventas-central/cortes/${cortes[0].id}`)).body;
    assert.equal(corte.sucursal, 'Sucursal Norte');
    assert.equal(corte.estadisticas.vendido, 205);
    assert.ok(Array.isArray(corte.departamentos));

    const creditos = (await jefa.get('/api/ventas-central/creditos')).body;
    assert.equal(creditos.total, 70);
    assert.deepEqual(creditos.clientes.map((c) => [c.nombre, c.sucursal, c.saldo]), [['Doña Mari', 'Sucursal Norte', 70]]);
    assert.ok(corteId);
  });

  await t.test('una segunda computadora en la central es la caja 2 y sus folios no chocan', async () => {
    const otra = await iniciarServidor({ nombre: 'central2', centralUrl: central.url });
    t.after(() => otra.cerrar());
    const caja2 = await entrar(otra.base, 'admin', 'admin');
    assert.equal((await vender(caja2, [{ producto_id: para, cantidad: 2 }])).status, 200);
    await esperarQue(() => contar('ventas', 'sucursal_id = 1') === 2, 'la venta de la caja 2');
    assert.deepEqual(central.db.prepare('SELECT numero FROM cajas WHERE sucursal_id = 1 ORDER BY numero').all().map((c) => c.numero), [1, 2]);
    assert.deepEqual(central.db.prepare('SELECT folio FROM ventas WHERE sucursal_id = 1').all().map((v) => v.folio), [1, 1], 'cada caja con sus folios');
    const r = (await jefa.get('/api/ventas-central/reporte?sucursal_id=1')).body;
    assert.equal(r.num_ventas, 2);
    assert.equal(r.total_vendido, 75);
  });
});
