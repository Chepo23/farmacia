'use strict';
// Cambiar el precio solo en una venta (doble clic en el precio, como en Eleventa): lo puede hacer
// cualquiera, nunca abajo del costo; el precio del producto no cambia, el ticket dice el precio de
// antes, el corte suma los descuentos y el jefe lo ve en el registro de cambios.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

test('precio cambiado en la venta', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  const alta = async (datos) => (await admin.post('/api/productos', { sucursal_id: 2, existencia_inicial: 20, ...datos })).body.id;
  const para = await alta({ codigo_barras: '7501000000101', descripcion: 'Paracetamol 500 mg', precio_costo: 10, precio_venta: 25 });
  const keto = await alta({ codigo_barras: '7501000000202', descripcion: 'Ketorolaco c/3', precio_costo: 20, precio_venta: 30, piezas_caja: 3, precio_caja: 80 });
  const vender = (partidas) => norte.post('/api/ventas', { partidas, forma_pago: 'efectivo', pago: 1000 });
  let folio;

  await t.test('descuento: solo en esa venta y con el precio de antes en el ticket', async () => {
    const r = await vender([{ producto_id: para, cantidad: 2, precio_manual: 20 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 40);
    folio = r.body.folio;
    const venta = (await norte.get(`/api/ventas/${r.body.ventaId}`)).body;
    const [p] = venta.partidas;
    assert.deepEqual([p.precio_unitario, p.precio_lista, p.precio_manual, p.importe], [20, 25, 1, 40]);
    assert.equal(venta.ahorro, 10, 'el ticket dice cuánto se ahorró');
    const producto = (await norte.get(`/api/productos?ids=${para}`)).body[0];
    assert.equal(producto.precio_venta, 25, 'el precio del producto no cambia');
  });

  await t.test('nunca abajo del costo; a costo sí', async () => {
    const abajo = await vender([{ producto_id: para, cantidad: 1, precio_manual: 9.5 }]);
    assert.equal(abajo.status, 400);
    assert.equal(abajo.body.codigo, 'ABAJO_DEL_COSTO');
    assert.match(abajo.body.error, /Paracetamol 500 mg.*abajo del costo \(\$10\.00\)/);
    const aCosto = await vender([{ producto_id: para, cantidad: 1, precio_manual: 10 }]);
    assert.equal(aCosto.status, 200, JSON.stringify(aCosto.body));
    assert.equal(aCosto.body.total, 10);
    const masCaro = await vender([{ producto_id: para, cantidad: 1, precio_manual: 27 }]);
    assert.equal(masCaro.body.total, 27, 'también se puede subir');
  });

  await t.test('la caja completa también, contra el costo de la caja', async () => {
    const abajo = await vender([{ producto_id: keto, cantidad: 1, caja: true, precio_manual: 55 }]);
    assert.equal(abajo.status, 400, 'la caja cuesta 3 × $20');
    assert.equal(abajo.body.codigo, 'ABAJO_DEL_COSTO');
    const r = await vender([{ producto_id: keto, cantidad: 2, caja: true, precio_manual: 70 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 140);
    const [p] = (await norte.get(`/api/ventas/${r.body.ventaId}`)).body.partidas;
    assert.deepEqual([p.cantidad, p.cajas, p.importe, p.precio_manual], [6, 2, 140, 1]);
  });

  await t.test('no aplica a artículos comunes ni a los cócteles; precio no válido', async () => {
    assert.equal((await vender([{ comun: true, descripcion: 'Algo', cantidad: 1, precio: 10, precio_manual: 5 }])).status, 400);
    assert.equal((await vender([{ producto_id: para, cantidad: 1, precio_manual: 0 }])).status, 400);
    assert.equal((await vender([{ producto_id: para, cantidad: 1, precio_manual: 'x' }])).status, 400);
  });

  await t.test('el corte suma los descuentos y el jefe lo ve en el registro de cambios', async () => {
    const pendiente = (await norte.get('/api/cortes/pendiente')).body;
    assert.equal(pendiente.estadisticas.ventas_precio_especial, 4);
    // Paracetamol 2 × (25 − 20) + 1 × (25 − 10) + caja: 2 × (80 − 70)
    assert.equal(pendiente.estadisticas.descuentos, 10 + 15 + 20);
    let filas = [];
    for (let i = 0; i < 60 && filas.length < 4; i += 1) {
      filas = central.db.prepare("SELECT descripcion, alerta FROM bitacora WHERE tipo = 'precio_en_venta' ORDER BY id").all();
      if (filas.length < 4) await esperar(250);
    }
    assert.equal(filas.length, 4);
    assert.deepEqual({ ...filas[0] }, { descripcion: `Folio ${folio}: Paracetamol 500 mg $25.00 → $20.00 (2); descuento $10.00`, alerta: 1 });
    assert.match(filas[2].descripcion, /Paracetamol 500 mg \$25\.00 → \$27\.00; \$2\.00 más caro$/);
    assert.equal(filas[2].alerta, 0, 'subir el precio no es alerta');
    assert.match(filas[3].descripcion, /Ketorolaco c\/3 \(caja c\/3\) \$80\.00 → \$70\.00 la caja \(2\); descuento \$20\.00$/);
  });
});
