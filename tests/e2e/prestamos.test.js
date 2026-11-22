'use strict';
// Préstamos de medicamento a otras farmacias (dadas de alta como clientes): prestar saca la mercancía
// del inventario; "Regresaron" la vuelve a meter; "Lo van a pagar" la cobra en la caja (a costo, al
// contado o a crédito) sin volver a sacarla. El jefe ve lo prestado en Créditos y en Movimientos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

async function esperarQue(condicion, que) {
  for (let i = 0; i < 80; i += 1) {
    if (await condicion()) return;
    await esperar(200);
  }
  throw new Error(`No se cumplió: ${que}`);
}

test('préstamos a otras farmacias', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const stock = (productoId) => central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = 2').get(productoId)?.existencia;
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  await admin.post('/api/admin/usuarios', { nombre: 'Laura Jefa', usuario: 'laura', password: 'jefa1234', rol: 'jefe', sucursal_id: 1 });
  const jefa = await entrar(servidores.central.base, 'laura', 'jefa1234', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  const alta = async (datos) => (await admin.post('/api/productos', { sucursal_id: 2, existencia_inicial: 10, ...datos })).body.id;
  const amox = await alta({ codigo_barras: '7501000000404', descripcion: 'Amoxicilina 500 mg', precio_costo: 40, precio_venta: 89 });
  const ibu = await alta({ codigo_barras: '7501000000202', descripcion: 'Ibuprofeno 400 mg', precio_costo: 12, precio_venta: 30 });
  const guadalupe = (await norte.post('/api/clientes', { nombre: 'Farmacia Guadalupe', credito_autorizado: true })).body.id;
  let prestamo;
  const renglon = (p, id) => p.renglones.find((d) => d.producto_id === id);

  await t.test('prestar: sale del inventario y queda pendiente', async () => {
    const r = await norte.post('/api/prestamos', { cliente_id: guadalupe, nota: 'Lo regresan el viernes', partidas: [{ producto_id: amox, cantidad: 3 }, { producto_id: ibu, cantidad: 2 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    prestamo = r.body;
    assert.deepEqual([prestamo.folio, prestamo.estado, prestamo.piezas_pendientes, prestamo.valor_pendiente, prestamo.cliente], [1, 'pendiente', 5, 144, 'Farmacia Guadalupe']);
    assert.deepEqual([stock(amox), stock(ibu)], [7, 8]);
    const clientes = (await norte.get('/api/clientes')).body;
    assert.equal(clientes.find((c) => c.id === guadalupe).prestamos_pendientes, 1);
    const movs = (await jefa.get('/api/movimientos?sucursal_id=2&tipo=prestamo')).body.movimientos;
    assert.equal(movs.length, 2);
    assert.ok(movs.every((m) => m.nota === 'Préstamo P-1 a Farmacia Guadalupe'), JSON.stringify(movs.map((m) => m.nota)));
  });

  await t.test('lo que no se puede prestar', async () => {
    const demasiado = await norte.post('/api/prestamos', { cliente_id: guadalupe, partidas: [{ producto_id: amox, cantidad: 50 }] });
    assert.equal(demasiado.status, 400);
    assert.equal(demasiado.body.codigo, 'SIN_EXISTENCIA');
    assert.equal((await norte.get(`/api/prestamos?cliente_id=${guadalupe}`)).body.length, 1, 'no queda un préstamo a medias');
    assert.equal(stock(amox), 7);
    assert.equal((await norte.post('/api/prestamos', { cliente_id: guadalupe, partidas: [] })).status, 400);
    assert.equal((await norte.post('/api/prestamos', { cliente_id: 999, partidas: [{ producto_id: ibu, cantidad: 1 }] })).status, 404);
  });

  await t.test('regresaron una parte: vuelve al inventario', async () => {
    const r = await norte.post(`/api/prestamos/${prestamo.id}/devolver`, { renglones: [{ detalle_id: renglon(prestamo, amox).id, cantidad: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([renglon(r.body, amox).pendiente, renglon(r.body, ibu).pendiente, r.body.estado], [2, 2, 'pendiente']);
    assert.equal(stock(amox), 8);
    const demasiado = await norte.post(`/api/prestamos/${prestamo.id}/devolver`, { renglones: [{ detalle_id: renglon(prestamo, amox).id, cantidad: 3 }] });
    assert.equal(demasiado.status, 400);
    assert.equal(stock(amox), 8);
  });

  let ventaFiada;
  await t.test('lo van a pagar: se cobra a crédito sin volver a sacarlo del inventario', async () => {
    const detalleAmox = renglon(prestamo, amox).id;
    const demasiado = await norte.post('/api/ventas', { partidas: [{ producto_id: amox, cantidad: 3, prestamo_detalle_id: detalleAmox, precio_manual: 40 }], forma_pago: 'efectivo', pago: 500 });
    assert.equal(demasiado.status, 400, 'solo faltan 2');
    const enCaja = await norte.post('/api/ventas', { partidas: [{ producto_id: amox, cantidad: 1, caja: true, prestamo_detalle_id: detalleAmox }], forma_pago: 'efectivo', pago: 500 });
    assert.equal(enCaja.status, 400);
    const r = await norte.post('/api/ventas', {
      partidas: [{ producto_id: amox, cantidad: 2, prestamo_detalle_id: detalleAmox, precio_manual: 40 }],
      forma_pago: 'credito', cliente_id: guadalupe, pago: 0,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 80, 'a costo');
    ventaFiada = r.body.ventaId;
    assert.equal(stock(amox), 8, 'ya había salido al prestarlo');
    const p = (await norte.get(`/api/prestamos/${prestamo.id}`)).body;
    assert.deepEqual([renglon(p, amox).cobrado, renglon(p, amox).pendiente, p.estado], [2, 0, 'pendiente']);
    assert.equal((await norte.get('/api/clientes')).body.find((c) => c.id === guadalupe).saldo, 80, 'queda a su cuenta');
    assert.ok(p.historial.some((h) => h.tipo === 'cobro' && h.venta_folio === r.body.folio));
  });

  await t.test('si se cancela esa venta, lo cobrado vuelve a quedar pendiente (y no regresa al inventario)', async () => {
    const r = await norte.post(`/api/ventas/${ventaFiada}/cancelar`, { motivo: 'Se equivocó de cliente' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stock(amox), 8);
    const p = (await norte.get(`/api/prestamos/${prestamo.id}`)).body;
    assert.deepEqual([renglon(p, amox).cobrado, renglon(p, amox).pendiente], [0, 2]);
    assert.ok(p.historial.some((h) => h.tipo === 'cobro' && h.anulado === 1));
  });

  await t.test('lo pagan de contado y regresan lo demás: el préstamo se cierra', async () => {
    const pago = await norte.post('/api/ventas', {
      partidas: [{ producto_id: amox, cantidad: 2, prestamo_detalle_id: renglon(prestamo, amox).id, precio_manual: 45 }], forma_pago: 'efectivo', pago: 100,
    });
    assert.equal(pago.status, 200, JSON.stringify(pago.body));
    assert.equal(pago.body.total, 90);
    const fin = await norte.post(`/api/prestamos/${prestamo.id}/devolver`, { renglones: [{ detalle_id: renglon(prestamo, ibu).id, cantidad: 2 }] });
    assert.equal(fin.body.estado, 'cerrado');
    assert.deepEqual([stock(amox), stock(ibu)], [8, 10]);
    assert.equal((await norte.get('/api/clientes')).body.find((c) => c.id === guadalupe).prestamos_pendientes, 0);
  });

  await t.test('el jefe ve lo prestado de todas las farmacias', async () => {
    const otro = await norte.post('/api/prestamos', { cliente_id: guadalupe, partidas: [{ producto_id: ibu, cantidad: 1 }] });
    assert.equal(otro.body.folio, 2);
    await esperarQue(() => central.db.prepare("SELECT COUNT(*) AS n FROM prestamos WHERE estado = 'pendiente'").get().n === 1
      && central.db.prepare("SELECT COUNT(*) AS n FROM prestamos WHERE estado = 'cerrado'").get().n === 1, 'que suban los préstamos');
    const creditos = (await jefa.get('/api/ventas-central/creditos')).body;
    assert.deepEqual(creditos.prestamos.map((p) => [p.farmacia, p.sucursal, p.folio, p.piezas, p.valor, p.productos]),
      [['Farmacia Guadalupe', 'Sucursal Norte', 2, 1, 12, [{ descripcion: 'Ibuprofeno 400 mg', pendiente: 1 }]]]);
    assert.equal(creditos.valor_prestado, 12);
    await esperarQue(() => central.db.prepare("SELECT COUNT(*) AS n FROM bitacora WHERE tipo IN ('prestamo', 'prestamo_devuelto')").get().n >= 4, 'el registro de cambios');
    const registro = central.db.prepare("SELECT descripcion FROM bitacora WHERE tipo = 'prestamo' ORDER BY id").get().descripcion;
    assert.equal(registro, 'Préstamo P-1 a Farmacia Guadalupe: 3 Amoxicilina 500 mg, 2 Ibuprofeno 400 mg ($144.00 a costo)');
  });
});
