'use strict';
// Inyecciones: lo que llega en caja y se vende suelto (el inventario va en piezas; la caja completa
// tiene su precio) y los cócteles (las ampolletas, la jeringa y la aguja que se usaron se cobran
// juntas al precio del cóctel, y el inventario descuenta exactamente eso, sea de la marca que sea).
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

test('inyecciones: venta por caja y cócteles', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const stock = (productoId) =>
    central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = 2').get(productoId)?.existencia;
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  const vender = (partidas, extra = {}) => norte.post('/api/ventas', { partidas, forma_pago: 'efectivo', pago: 1000, ...extra });
  const enCoctel = (id, coctel, grupo = 1) => ({ producto_id: id, cantidad: 1, coctel: { id: coctel, grupo } });
  const ids = {};

  await t.test('la central da de alta las ampolletas, la caja y los cócteles', async () => {
    const alta = async (datos, existencia = 10) => {
      const r = await admin.post('/api/productos', {
        departamento: 'Analgésicos', precio_costo: 10, sucursal_id: 2, existencia_inicial: existencia, ...datos,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.id;
    };
    ids.amcef = await alta({ codigo_barras: '7500000000011', descripcion: 'AMCEF ceftriaxona 1 g', precio_venta: 95 });
    ids.xentriac = await alta({ codigo_barras: '7500000000012', descripcion: 'XENTRIAC 1 g', precio_venta: 110 });
    ids.dexa = await alta({ codigo_barras: '7500000000013', descripcion: 'Dexametasona AMSA 8 mg', precio_venta: 25 });
    ids.euca = await alta({ codigo_barras: '7500000000014', descripcion: 'Eucaliptine ampolleta', precio_venta: 50 });
    ids.jeringa = await alta({ codigo_barras: '7500000000015', descripcion: 'Jeringa 5 ml con aguja', precio_venta: 8 });
    ids.linco = await alta({ codigo_barras: '7500000000016', descripcion: 'Lincomicina 600 mg', precio_venta: 60 });
    ids.keto = await alta({
      codigo_barras: '7500000000017', descripcion: 'Ketorolaco 30 mg c/3', precio_venta: 30, piezas_caja: 3, precio_caja: 80,
    }, 9);

    const coctel = await admin.post('/api/productos', { descripcion: 'Cóctel ceftriaxona', precio_venta: 200, es_coctel: true, sucursal_id: 2, existencia_inicial: 5 });
    assert.equal(coctel.status, 200, JSON.stringify(coctel.body));
    ids.coctel200 = coctel.body.id;
    ids.coctel150 = (await admin.post('/api/productos', { descripcion: 'Cóctel lincomicina', precio_venta: 150, es_coctel: true })).body.id;
    assert.deepEqual(
      { ...central.db.prepare('SELECT codigo_barras, usa_inventario, es_coctel, piezas_caja FROM productos WHERE id = ?').get(ids.coctel200) },
      { codigo_barras: null, usa_inventario: 0, es_coctel: 1, piezas_caja: null },
      'el cóctel no tiene código ni inventario'
    );
    assert.equal(stock(ids.coctel200), undefined, 'aunque se escriba una existencia inicial');

    const keto = (await norte.get(`/api/productos?ids=${ids.keto}`)).body[0];
    assert.deepEqual([keto.piezas_caja, keto.precio_caja, keto.es_coctel, keto.existencias.find((e) => e.sucursal_id === 2).existencia], [3, 80, 0, 9]);
    const cocteles = (await norte.get('/api/productos/cocteles')).body;
    assert.deepEqual(cocteles.map((c) => [c.descripcion, c.precio_venta, c.es_coctel]), [['Cóctel ceftriaxona', 200, 1], ['Cóctel lincomicina', 150, 1]]);
  });

  await t.test('solo la central da de alta cócteles y pone la caja; los datos mal escritos no pasan', async () => {
    const pirata = await norte.post('/api/productos', { descripcion: 'Cóctel pirata', precio_venta: 10, es_coctel: true });
    assert.equal(pirata.status, 403, JSON.stringify(pirata.body));
    const cajaDesdeNorte = await norte.put(`/api/productos/${ids.dexa}`, {
      codigo_barras: '7500000000013', descripcion: 'Dexametasona AMSA 8 mg', departamento: 'Analgésicos',
      precio_costo: 10, precio_venta: 25, piezas_caja: 5, precio_caja: 100,
    });
    assert.equal(cajaDesdeNorte.status, 403);
    assert.equal(cajaDesdeNorte.body.codigo, 'SOLO_CENTRAL');
    for (const malo of [
      { piezas_caja: 1, precio_caja: 4 },
      { piezas_caja: 2.5, precio_caja: 10 },
      { piezas_caja: 3 },
    ]) {
      const r = await admin.post('/api/productos', { descripcion: 'Caja rara', precio_venta: 5, ...malo });
      assert.equal(r.status, 400, JSON.stringify(malo));
    }
    assert.equal((await admin.post('/api/productos', { descripcion: 'Cóctel sin precio', precio_venta: 0, es_coctel: true })).status, 400);
  });

  await t.test('caja completa: su precio y descuenta todas sus piezas', async () => {
    const r = await vender([{ producto_id: ids.keto, cantidad: 1, caja: true }, { producto_id: ids.keto, cantidad: 2 }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 140, 'caja $80 + 2 sueltas de $30');
    assert.equal(stock(ids.keto), 4, '9 piezas - 3 de la caja - 2 sueltas');
    const venta = (await norte.get(`/api/ventas/${r.body.ventaId}`)).body;
    assert.deepEqual(venta.partidas.map((p) => [p.descripcion, p.cantidad, p.importe, p.cajas]), [
      ['Ketorolaco 30 mg c/3 (caja c/3)', 3, 80, 1],
      ['Ketorolaco 30 mg c/3', 2, 60, null],
    ]);
    // Solo cajas completas, de lo que sí se vende por caja, y sin pasarse de la existencia
    assert.equal((await vender([{ producto_id: ids.keto, cantidad: 1.5, caja: true }])).status, 400);
    assert.equal((await vender([{ producto_id: ids.dexa, cantidad: 1, caja: true }])).status, 400);
    const sinPiezas = await vender([{ producto_id: ids.keto, cantidad: 2, caja: true }]);
    assert.equal(sinPiezas.status, 400);
    assert.equal(sinPiezas.body.codigo, 'SIN_EXISTENCIA', '2 cajas son 6 piezas y quedan 4');
    assert.equal(stock(ids.keto), 4);
  });

  await t.test('cóctel: lo que se usó se cobra al precio del cóctel y sale del inventario', async () => {
    const r = await vender([
      enCoctel(ids.amcef, ids.coctel200),
      enCoctel(ids.dexa, ids.coctel200),
      enCoctel(ids.euca, ids.coctel200),
      enCoctel(ids.jeringa, ids.coctel200),
      { producto_id: ids.dexa, cantidad: 1 }, // una dexametasona aparte, a su precio
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 225, 'cóctel $200 + dexametasona $25 (por separado serían $203)');
    assert.deepEqual([stock(ids.amcef), stock(ids.dexa), stock(ids.euca), stock(ids.jeringa)], [9, 8, 9, 9]);
    const venta = (await norte.get(`/api/ventas/${r.body.ventaId}`)).body;
    const delCoctel = venta.partidas.filter((p) => p.coctel === 'Cóctel ceftriaxona');
    // Repartido según el precio normal de cada uno (95, 25, 50 y 8 de 178); el último completa los $200
    assert.deepEqual(delCoctel.map((p) => [p.descripcion, p.importe, p.coctel_grupo]), [
      ['AMCEF ceftriaxona 1 g', 106.74, 1],
      ['Dexametasona AMSA 8 mg', 28.09, 1],
      ['Eucaliptine ampolleta', 56.18, 1],
      ['Jeringa 5 ml con aguja', 8.99, 1],
    ]);
    const aparte = venta.partidas.find((p) => !p.coctel);
    assert.deepEqual([aparte.descripcion, aparte.importe, aparte.coctel_grupo], ['Dexametasona AMSA 8 mg', 25, null]);
    ids.ventaCoctel = r.body.ventaId;
  });

  await t.test('dos cócteles en la misma venta, con otra marca de ceftriaxona', async () => {
    const r = await vender([
      enCoctel(ids.xentriac, ids.coctel200, 1),
      enCoctel(ids.dexa, ids.coctel200, 1),
      enCoctel(ids.euca, ids.coctel200, 1),
      enCoctel(ids.jeringa, ids.coctel200, 1),
      enCoctel(ids.linco, ids.coctel150, 2),
      enCoctel(ids.dexa, ids.coctel150, 2),
      enCoctel(ids.euca, ids.coctel150, 2),
      enCoctel(ids.jeringa, ids.coctel150, 2),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 350);
    assert.deepEqual([stock(ids.xentriac), stock(ids.linco), stock(ids.dexa), stock(ids.euca), stock(ids.jeringa)], [9, 9, 6, 7, 7]);
    const venta = (await norte.get(`/api/ventas/${r.body.ventaId}`)).body;
    const suma = (nombre) => Math.round(venta.partidas.filter((p) => p.coctel === nombre).reduce((s, p) => s + p.importe, 0) * 100) / 100;
    assert.deepEqual([suma('Cóctel ceftriaxona'), suma('Cóctel lincomicina')], [200, 150]);
  });

  await t.test('lo que no es un cóctel válido no se cobra', async () => {
    const antes = [stock(ids.amcef), stock(ids.dexa), stock(ids.euca)];
    const casos = [
      [[enCoctel(ids.amcef, ids.coctel200)], 'un cóctel lleva por lo menos dos productos'],
      [[enCoctel(ids.amcef, ids.dexa), enCoctel(ids.euca, ids.dexa)], 'la dexametasona no es un cóctel'],
      [[enCoctel(ids.amcef, ids.coctel200), enCoctel(ids.euca, ids.coctel150)], 'un grupo con dos cócteles distintos'],
      [[{ producto_id: ids.coctel200, cantidad: 1 }], 'el cóctel no se vende solo'],
      [[{ ...enCoctel(ids.keto, ids.coctel200), caja: true }, enCoctel(ids.euca, ids.coctel200)], 'una caja completa no va en un cóctel'],
      [[{ producto_id: ids.amcef, cantidad: 1, coctel: { id: ids.coctel200 } }, enCoctel(ids.euca, ids.coctel200)], 'cóctel sin grupo'],
    ];
    for (const [partidas, porque] of casos) {
      const r = await vender(partidas);
      assert.equal(r.status, 400, `${porque}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual([stock(ids.amcef), stock(ids.dexa), stock(ids.euca)], antes, 'el inventario no se movió');
  });

  await t.test('cancelar la venta del cóctel regresa todo al inventario', async () => {
    const r = await norte.post(`/api/ventas/${ids.ventaCoctel}/cancelar`, { motivo: 'no se aplicó' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([stock(ids.amcef), stock(ids.dexa), stock(ids.euca), stock(ids.jeringa)], [10, 8, 8, 8]);
  });

  await t.test('en la central se ve que fue un cóctel', async () => {
    const delCoctel = () => central.db.prepare("SELECT descripcion, importe FROM venta_detalle WHERE descripcion LIKE '%(Cóctel %' ORDER BY id").all();
    await esperarQue(() => delCoctel().length === 12, 'que suban las ventas con cóctel');
    assert.equal(delCoctel()[0].descripcion, 'AMCEF ceftriaxona 1 g (Cóctel ceftriaxona)');
    const caja = central.db.prepare("SELECT cantidad, importe FROM venta_detalle WHERE descripcion = 'Ketorolaco 30 mg c/3 (caja c/3)'").get();
    assert.deepEqual({ ...caja }, { cantidad: 3, importe: 80 });
  });

  await t.test('en el celular: precio de caja, cóctel protegido e inventario en piezas', async () => {
    const nube = await crearNube(central);
    const token = await nube.vincular(1);
    const ketorolaco = {
      codigo_barras: '7500000000017', descripcion: 'Ketorolaco 30 mg c/3', departamento: 'Analgésicos', usa_inventario: true,
      precio_costo: 10, precio_venta: 30, precio_mayoreo: '', cantidad_mayoreo: '',
    };
    const consulta = await nube.pedir('GET', '/api/productos/codigo/7500000000017', { token });
    assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
    assert.deepEqual([consulta.body.piezas_caja, consulta.body.precio_caja], [3, 80]);

    const cambio = await nube.pedir('PUT', `/api/productos/${ids.keto}`, { token, cuerpo: { ...ketorolaco, piezas_caja: 3, precio_caja: 85 } });
    assert.equal(cambio.status, 200, JSON.stringify(cambio.body));
    assert.equal((await nube.pedir('PUT', `/api/productos/${ids.keto}`, { token, cuerpo: { ...ketorolaco, piezas_caja: 3, precio_caja: '' } })).status, 400);
    // Una pantalla que no manda la caja (versión anterior) no la borra ni anota cambios que no hubo
    const viejo = await nube.pedir('PUT', `/api/productos/${ids.keto}`, { token, cuerpo: { ...ketorolaco, precio_venta: 31 } });
    assert.equal(viejo.status, 200, JSON.stringify(viejo.body));
    assert.deepEqual(
      { ...central.db.prepare('SELECT precio_venta, piezas_caja, precio_caja FROM productos WHERE id = ?').get(ids.keto) },
      { precio_venta: 31, piezas_caja: 3, precio_caja: 85 }
    );
    const cambios = central.db.prepare("SELECT descripcion, alerta FROM bitacora WHERE tipo = 'producto_cambio' ORDER BY id").all();
    assert.ok(cambios.some((c) => /precio de caja \$80\.00 → \$85\.00/.test(c.descripcion) && c.alerta === 1), JSON.stringify(cambios));
    assert.ok(cambios.some((c) => /precio \$30\.00 → \$31\.00/.test(c.descripcion)));
    assert.ok(!cambios.some((c) => /sin caja|no se vende por caja|cóctel/.test(c.descripcion)), JSON.stringify(cambios));

    // A un cóctel no se le pone caja ni inventario desde el celular
    const alCoctel = await nube.pedir('PUT', `/api/productos/${ids.coctel200}`, {
      token, cuerpo: { descripcion: 'Cóctel ceftriaxona', precio_venta: 210, usa_inventario: true, piezas_caja: 3, precio_caja: 500 },
    });
    assert.equal(alCoctel.status, 200, JSON.stringify(alCoctel.body));
    assert.deepEqual(
      { ...central.db.prepare('SELECT precio_venta, usa_inventario, es_coctel, piezas_caja FROM productos WHERE id = ?').get(ids.coctel200) },
      { precio_venta: 210, usa_inventario: 0, es_coctel: 1, piezas_caja: null }
    );

    // En el inventario del día el renglón dice cuántas piezas trae la caja (se cuenta en piezas)
    await admin.post('/api/admin/usuarios', { nombre: 'Laura Jefa', usuario: 'laura', password: 'jefa1234', rol: 'jefe', sucursal_id: 1 });
    const jefa = await entrar(servidores.central.base, 'laura', 'jefa1234', { caja: false });
    const lista = await jefa.post('/api/conteos/lista', { sucursal_id: 2, producto_ids: [ids.keto, ids.dexa] });
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const hoy = await norte.get('/api/conteos/hoy');
    assert.equal(hoy.status, 200, JSON.stringify(hoy.body));
    const renglones = new Map(hoy.body.renglones.map((r) => [r.producto_id, r]));
    assert.deepEqual([renglones.get(ids.keto).piezas_caja, renglones.get(ids.dexa).piezas_caja], [3, null]);
    const desdeCelular = await nube.pedir('GET', '/api/conteos/hoy', { token: await nube.vincular(2) });
    assert.equal(desdeCelular.body.renglones.find((r) => r.producto_id === ids.keto).piezas_caja, 3);
    assert.deepEqual(nube.errores, []);
  });
});
