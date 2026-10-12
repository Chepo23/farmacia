'use strict';
// Prueba de punta a punta en modo central: varias computadoras (cada una con su SQLite)
// comparten una central falsa. Verifica que el stock sea el mismo en todas las pantallas
// de todas las computadoras después de cada operación.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');
const { iniciarServidor, cliente } = require('../helpers/servidor');
const { esperar } = require('../helpers/temporal');

const CODIGO = '7501000000017';

function existencia(producto, sucursalId) {
  assert.ok(producto, 'el producto no apareció');
  return producto.existencias.find((e) => e.sucursal_id === sucursalId)?.existencia;
}

function stockCentral(central, sucursalId) {
  const fila = central.db
    .prepare('SELECT i.existencia FROM inventario i JOIN productos p ON p.id = i.producto_id WHERE p.codigo_barras = ? AND i.sucursal_id = ?')
    .get(CODIGO, sucursalId);
  return fila ? fila.existencia : 0;
}

// Lista de productos, escáner y búsqueda F3 deben decir lo mismo
async function verificarStock(cajas, sucursalId, esperado, contexto) {
  for (const [nombre, caja] of Object.entries(cajas)) {
    const [lista, escaner, busqueda] = await Promise.all([
      caja.get(`/api/productos?q=${CODIGO}`),
      caja.get(`/api/productos/codigo/${CODIGO}`),
      caja.get(`/api/productos/buscar?q=${CODIGO}`),
    ]);
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.equal(existencia(lista.body[0], sucursalId), esperado, `${contexto} — lista en ${nombre}`);
    assert.equal(existencia(escaner.body, sucursalId), esperado, `${contexto} — escáner en ${nombre}`);
    assert.equal(existencia(busqueda.body[0], sucursalId), esperado, `${contexto} — F3 en ${nombre}`);
  }
}

async function vender(caja, productoId, cantidad, extra = {}) {
  return caja.post('/api/ventas', {
    partidas: [{ producto_id: productoId, cantidad }],
    forma_pago: 'efectivo',
    pago: 10000,
    ...extra,
  });
}

test('inventario conectado entre farmacias que comparten la central', async (t) => {
  const esc = await escenarioCentral();
  t.after(() => esc.cerrarTodo());
  const { central } = esc;
  const pcs = esc.servidores;
  const admin = await entrar(pcs.central.base, 'admin', 'admin');
  const norte = await entrar(pcs.norte.base, 'cajero2', '1234');
  const sur = await entrar(pcs.sur.base, 'cajero3', '1234');
  const todas = { central: admin, norte, sur };
  let productoId;
  let pedidoNorte;

  await t.test('alta con existencia inicial: igual en todas las computadoras', async () => {
    const r = await admin.post('/api/productos', {
      codigo_barras: CODIGO, descripcion: 'Ibuprofeno 400 mg, caja (10)', departamento: 'Analgésicos',
      precio_costo: 20, precio_venta: 45, existencia_inicial: 20, minimo_inicial: 5,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.aviso, null);
    productoId = r.body.id;
    assert.equal(stockCentral(central, 1), 20);
    await verificarStock(todas, 1, 20, 'alta');
    const movs = central.db.prepare('SELECT tipo, cantidad FROM movimientos_inventario WHERE producto_id = ?').all(productoId);
    assert.deepEqual(movs, [{ tipo: 'entrada', cantidad: 20 }]);
  });

  await t.test('búsqueda con comas y paréntesis no falla', async () => {
    const r = await norte.get(`/api/productos/buscar?q=${encodeURIComponent('caja (10')}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body[0]?.id, productoId);
  });

  await t.test('solo el administrador de la central fija precios y el cambio llega a todas', async () => {
    const alta = await norte.post('/api/productos', { descripcion: 'Producto de sucursal', precio_venta: 10 });
    assert.equal(alta.status, 403, 'una sucursal no da de alta productos');
    const actual = (await norte.get(`/api/productos/codigo/${CODIGO}`)).body;
    const base = {
      codigo_barras: CODIGO, descripcion: actual.descripcion, departamento: actual.departamento,
      precio_costo: actual.precio_costo, precio_venta: actual.precio_venta, usa_inventario: true,
    };
    const cambiaPrecio = await norte.put(`/api/productos/${productoId}`, { ...base, precio_venta: 1 });
    assert.equal(cambiaPrecio.status, 403, 'una sucursal no cambia precios');
    assert.equal(cambiaPrecio.body.codigo, 'SOLO_CENTRAL');
    const otrosDatos = await norte.put(`/api/productos/${productoId}`, { ...base, departamento: 'Vitaminas' });
    assert.equal(otrosDatos.status, 200, JSON.stringify(otrosDatos.body));
    const nuevoPrecio = await admin.put(`/api/productos/${productoId}`, { ...base, departamento: 'Analgésicos', precio_venta: 50 });
    assert.equal(nuevoPrecio.status, 200, JSON.stringify(nuevoPrecio.body));
    for (const [nombre, caja] of Object.entries(todas)) {
      const producto = (await caja.get(`/api/productos/codigo/${CODIGO}`)).body;
      assert.equal(producto.precio_venta, 50, `precio nuevo en ${nombre}`);
    }
    assert.equal(central.db.prepare('SELECT precio_venta FROM productos WHERE id = ?').get(productoId).precio_venta, 50);
  });

  await t.test('pedidos de dos sucursales no chocan por id', async () => {
    const [pn, ps] = await Promise.all([norte.post('/api/pedidos'), sur.post('/api/pedidos')]);
    assert.equal(pn.status, 200, JSON.stringify(pn.body));
    assert.equal(ps.status, 200, JSON.stringify(ps.body));
    assert.notEqual(pn.body.id, ps.body.id);
    const conRenglon = await norte.post(`/api/pedidos/${pn.body.id}/renglones`, { codigo_barras: CODIGO, cantidad: 6 });
    assert.equal(conRenglon.status, 200, JSON.stringify(conRenglon.body));
    const otro = await sur.post(`/api/pedidos/${ps.body.id}/renglones`, { codigo_barras: CODIGO, cantidad: 2 });
    assert.equal(otro.status, 200, JSON.stringify(otro.body));
    const enviado = await norte.post(`/api/pedidos/${pn.body.id}/enviar`, { nota: 'urgente' });
    assert.equal(enviado.body.estado, 'enviado');
    pedidoNorte = pn.body.id;
    const enCentral = central.db.prepare('SELECT sucursal_id, estado FROM pedidos ORDER BY id').all();
    assert.deepEqual(enCentral.map((p) => p.sucursal_id).sort(), [2, 3]);
    const detalle = central.db.prepare('SELECT pedido_id, cantidad FROM pedido_detalle ORDER BY pedido_id').all();
    assert.equal(detalle.length, 2);
  });

  let apoyo;
  await t.test('la central arma el apoyo desde el pedido (dos clics no duplican)', async () => {
    const lista = await admin.get('/api/pedidos');
    assert.ok(lista.body.some((p) => p.id === pedidoNorte && p.estado === 'enviado'), JSON.stringify(lista.body));
    const r1 = await admin.post('/api/apoyos', { destino_id: 2, pedido_id: pedidoNorte });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await admin.post('/api/apoyos', { destino_id: 2, pedido_id: pedidoNorte });
    assert.equal(r2.body.id, r1.body.id);
    apoyo = r2.body;
    assert.equal(apoyo.renglones.length, 1);
    assert.equal(apoyo.renglones[0].cantidad, 6);
    assert.equal(apoyo.renglones[0].existencia_origen, 20);
  });

  await t.test('enviar el apoyo descuenta a la central en todas las pantallas', async () => {
    const r = await admin.post(`/api/apoyos/${apoyo.id}/enviar`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'enviado');
    assert.equal(stockCentral(central, 1), 14);
    await verificarStock(todas, 1, 14, 'después de enviar');
    const pedido = central.db.prepare('SELECT estado FROM pedidos WHERE id = ?').get(pedidoNorte);
    assert.equal(pedido.estado, 'surtido');
    const otraVez = await admin.post(`/api/apoyos/${apoyo.id}/enviar`, {});
    assert.equal(otraVez.status, 400);
  });

  await t.test('la sucursal recibe con un faltante y su stock se ve en todas las computadoras', async () => {
    const pendientes = await norte.get('/api/apoyos/pendientes');
    assert.equal(pendientes.body.por_recibir, 1);
    const detalle = await norte.get(`/api/apoyos/${apoyo.id}`);
    const renglon = detalle.body.renglones[0];
    const r = await norte.post(`/api/apoyos/${apoyo.id}/recibir`, { renglones: [{ id: renglon.id, cantidad_recibida: 5 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'recibido');
    assert.equal(r.body.faltantes, 1);
    assert.equal(stockCentral(central, 2), 5);
    assert.equal(stockCentral(central, 1), 14);
    await verificarStock(todas, 2, 5, 'después de recibir');
    const otraVez = await norte.post(`/api/apoyos/${apoyo.id}/recibir`, {});
    assert.equal(otraVez.status, 400, 'no se puede recibir dos veces');
    assert.equal(stockCentral(central, 2), 5);
  });

  let ventaDos;
  await t.test('la venta en la sucursal descuenta y se ve igual en todas partes', async () => {
    const r = await vender(norte, productoId, 2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inventarioPendiente, false);
    assert.equal(r.body.total, 100, 'la sucursal vende con el precio que fijó la central');
    ventaDos = r.body;
    assert.equal(stockCentral(central, 2), 3);
    await verificarStock(todas, 2, 3, 'después de vender');
  });

  await t.test('dos computadoras de la misma sucursal vendiendo a la vez no venden de más', async () => {
    const otraPc = await iniciarServidor({ nombre: 'norte-caja2', centralUrl: central.url });
    t.after(() => otraPc.cerrar());
    const caja2 = await entrar(otraPc.base, 'cajero2', '1234');
    const [a, b] = await Promise.all([vender(norte, productoId, 2), vender(caja2, productoId, 2)]);
    const exitos = [a, b].filter((r) => r.status === 200);
    const rechazos = [a, b].filter((r) => r.status === 400);
    assert.equal(exitos.length, 1, `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`);
    assert.equal(rechazos.length, 1);
    assert.equal(rechazos[0].body.codigo, 'SIN_EXISTENCIA');
    assert.equal(stockCentral(central, 2), 1);
    await verificarStock({ norte, caja2, central: admin }, 2, 1, 'después de la venta simultánea');
  });

  await t.test('sin internet se sigue vendiendo y al volver la conexión se sube solo', async () => {
    central.simularCaida(true);
    const r = await vender(norte, productoId, 1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inventarioPendiente, true);
    const estado = await norte.get('/api/productos/sincronizacion');
    assert.equal(estado.body.pendientes, 1);
    const local = await norte.get(`/api/productos/codigo/${CODIGO}`);
    assert.equal(existencia(local.body, 2), 0, 'la copia local ya refleja la venta');
    const sinStock = await vender(norte, productoId, 1);
    assert.equal(sinStock.status, 400, 'sin conexión tampoco deja vender de más');
    central.simularCaida(false);
    assert.equal(stockCentral(central, 2), 1, 'la central todavía no lo sabe');
    let pendientes = 1;
    for (let i = 0; i < 40 && pendientes > 0; i += 1) {
      await esperar(300);
      await norte.get(`/api/productos/codigo/${CODIGO}`);
      pendientes = (await norte.get('/api/productos/sincronizacion')).body.pendientes;
    }
    assert.equal(pendientes, 0, 'la cola se vació');
    assert.equal(stockCentral(central, 2), 0);
    await verificarStock(todas, 2, 0, 'después de sincronizar');
    const movs = central.db.prepare("SELECT nota FROM movimientos_inventario WHERE sucursal_id = 2 AND tipo = 'venta' ORDER BY id").all();
    assert.ok(movs.at(-1).nota.includes('sin conexión'), JSON.stringify(movs));
  });

  await t.test('cancelar una venta regresa la mercancía', async () => {
    const r = await norte.post(`/api/ventas/${ventaDos.ventaId}/cancelar`, { motivo: 'cliente se arrepintió' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.venta.cancelada, 1);
    assert.equal(stockCentral(central, 2), 2);
    await verificarStock(todas, 2, 2, 'después de cancelar la venta');
    const otraVez = await norte.post(`/api/ventas/${ventaDos.ventaId}/cancelar`, { motivo: 'x' });
    assert.equal(otraVez.status, 400);
    assert.equal(stockCentral(central, 2), 2);
  });

  await t.test('la sucursal cancela un apoyo enviado y la mercancía regresa a la central', async () => {
    const nuevo = await admin.post('/api/apoyos', { destino_id: 2 });
    assert.equal(nuevo.status, 200, JSON.stringify(nuevo.body));
    const conRenglon = await admin.post(`/api/apoyos/${nuevo.body.id}/renglones`, { codigo_barras: CODIGO, cantidad: 3 });
    assert.equal(conRenglon.body.renglones[0].cantidad, 3);
    const enviado = await admin.post(`/api/apoyos/${nuevo.body.id}/enviar`, {});
    assert.equal(enviado.status, 200, JSON.stringify(enviado.body));
    assert.equal(stockCentral(central, 1), 11);
    const sinMotivo = await norte.post(`/api/apoyos/${nuevo.body.id}/cancelar`, {});
    assert.equal(sinMotivo.status, 400);
    const laCentral = await admin.post(`/api/apoyos/${nuevo.body.id}/cancelar`, { motivo: 'x' });
    assert.equal(laCentral.status, 403, 'la central no cancela un apoyo ya enviado');
    const cancelado = await norte.post(`/api/apoyos/${nuevo.body.id}/cancelar`, { motivo: 'ya no se necesita' });
    assert.equal(cancelado.status, 200, JSON.stringify(cancelado.body));
    assert.equal(cancelado.body.estado, 'cancelado');
    assert.equal(stockCentral(central, 1), 14);
    assert.equal(stockCentral(central, 2), 2);
    await verificarStock(todas, 1, 14, 'después de cancelar el apoyo');
  });

  await t.test('la central puede descartar su propio borrador', async () => {
    const borrador = await admin.post('/api/apoyos', { destino_id: 3 });
    await admin.post(`/api/apoyos/${borrador.body.id}/renglones`, { producto_id: productoId, cantidad: 1 });
    const r = await admin.post(`/api/apoyos/${borrador.body.id}/cancelar`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'cancelado');
    assert.equal(stockCentral(central, 1), 14);
  });

  await t.test('mínimo, bajo mínimo, sugerencias, reporte y kardex usan la misma existencia', async () => {
    const minimo = await norte.post(`/api/productos/${productoId}/inventario`, { minimo: 5 });
    assert.equal(minimo.status, 200, JSON.stringify(minimo.body));
    assert.equal(minimo.body.existencia, 2);
    const bajo = await norte.get('/api/productos/bajo-minimo');
    assert.deepEqual(bajo.body.map((f) => [f.id, f.existencia, f.minimo]), [[productoId, 2, 5]]);
    const sugerencias = await norte.get('/api/pedidos/sugerencias');
    assert.equal(sugerencias.body[0]?.producto_id, productoId);
    assert.equal(sugerencias.body[0]?.existencia, 2);
    const reporte = await admin.get('/api/reportes/inventario?sucursal_id=todas');
    const porSucursal = Object.fromEntries(reporte.body.por_sucursal.map((s) => [s.sucursal, s.unidades]));
    assert.equal(porSucursal['Farmacia Central'], 14);
    assert.equal(porSucursal['Sucursal Norte'], 2);
    const kardex = await admin.get(`/api/productos/${productoId}/kardex?sucursal_id=2`);
    assert.equal(kardex.status, 200, JSON.stringify(kardex.body));
    const resultantes = kardex.body.movimientos.map((m) => m.existencia_resultante).reverse();
    assert.deepEqual(resultantes, [5, 3, 1, 0, 2]);
  });

  await t.test('celular: recepción por lote y conteo que respeta las ventas hechas mientras se contaba', async () => {
    const p2 = (await admin.post('/api/productos', { codigo_barras: '7501000000024', descripcion: 'Loratadina 10 mg', precio_costo: 30, precio_venta: 60 })).body.id;
    const stockP2 = () => central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = 2').get(p2)?.existencia ?? 0;
    const recepcion = await norte.post('/api/productos/inventario/lote', {
      tipo: 'entrada', nota: 'Factura A-1',
      renglones: [{ producto_id: productoId, cantidad: 5 }, { producto_id: p2, cantidad: 12 }, { producto_id: p2, cantidad: 3 }],
    });
    assert.equal(recepcion.status, 200, JSON.stringify(recepcion.body));
    assert.equal(recepcion.body.aplicados, 2);
    assert.equal(stockCentral(central, 2), 7);
    assert.equal(stockP2(), 15);
    await verificarStock(todas, 2, 7, 'después de la recepción por lote');

    // Se cuenta el estante: el sistema decía 7 y había 5; mientras tanto se vende 1
    assert.equal((await vender(norte, productoId, 1)).status, 200);
    const conteo = await norte.post('/api/productos/inventario/lote', {
      tipo: 'conteo', nota: 'Estante 1',
      renglones: [{ producto_id: productoId, contado: 5, existencia_al_contar: 7 }, { producto_id: p2, contado: 15, existencia_al_contar: 15 }],
    });
    assert.equal(conteo.status, 200, JSON.stringify(conteo.body));
    assert.equal(conteo.body.aplicados, 1);
    assert.equal(conteo.body.sin_diferencia, 1);
    assert.equal(stockCentral(central, 2), 4, '7 - 1 vendida - 2 que faltaban');
    await verificarStock(todas, 2, 4, 'después del conteo');

    const otraSucursal = await norte.post('/api/productos/inventario/lote', { tipo: 'entrada', sucursal_id: 1, renglones: [{ producto_id: p2, cantidad: 1 }] });
    assert.equal(otraSucursal.status, 403, 'un cajero no mueve el inventario de otra sucursal');
    const conProductoMalo = await norte.post('/api/productos/inventario/lote', {
      tipo: 'entrada', renglones: [{ producto_id: p2, cantidad: 1 }, { producto_id: 999999, cantidad: 1 }],
    });
    assert.equal(conProductoMalo.status, 404);
    assert.equal(stockP2(), 15, 'todo o nada: no se aplicó ningún renglón');
  });

  await t.test('seguridad: sincronización solo para el administrador y bajas de usuarios', async () => {
    const anonimo = cliente(pcs.norte.base);
    assert.equal((await anonimo.get('/api/sync/estado')).status, 401);
    assert.equal((await norte.get('/api/sync/estado')).status, 403);
    assert.equal((await admin.get('/api/sync/estado')).status, 200);
    const baja = await admin.del('/api/admin/usuarios/3');
    assert.equal(baja.status, 200, JSON.stringify(baja.body));
    const intento = await cliente(pcs.sur.base).post('/api/auth/login', { usuario: 'cajero3', password: '1234' });
    assert.equal(intento.status, 401, 'un usuario dado de baja en la central ya no entra');
  });
});
