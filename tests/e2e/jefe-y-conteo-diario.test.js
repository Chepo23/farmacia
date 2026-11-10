'use strict';
// Cuenta de jefe, movimientos como en Eleventa, registro de cambios, inventario de las sucursales e
// inventario del día (a ciegas, con recuento, motivo y autorización de un jefe que no contó).
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar, abrirCaja } = require('../helpers/escenario');
const { crearNube } = require('../helpers/nube');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));
const stock = (central, productoId, sucursalId) =>
  central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId)?.existencia;

// Lo que se registra en otra computadora llega a la central unos segundos después
async function esperarCambios(caja, condicion, ruta = '/api/bitacora') {
  let ultimo = null;
  for (let i = 0; i < 60; i += 1) {
    ultimo = await caja.get(ruta);
    if (ultimo.status === 200 && condicion(ultimo.body.cambios)) return ultimo.body.cambios;
    await esperar(250);
  }
  throw new Error(`No llegaron los cambios esperados: ${JSON.stringify(ultimo && ultimo.body)}`);
}

test('jefe: cuenta, movimientos, cambios e inventario del día', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  let jefa;
  let laura;
  let paracetamol;
  let ibuprofeno;
  let vitamina;

  await t.test('el administrador crea la primera cuenta de jefe; después solo un jefe la toca', async () => {
    const r = await admin.post('/api/admin/usuarios', { nombre: 'Laura Jefa', usuario: 'laura', password: 'jefa1234', rol: 'jefe', sucursal_id: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    laura = Number(r.body.id);
    assert.deepEqual(
      { ...central.db.prepare('SELECT rol, jefe, sucursal_id FROM usuarios_central WHERE usuario = ?').get('laura') },
      { rol: 'admin', jefe: 1, sucursal_id: 1 },
      'el jefe siempre queda en la central'
    );
    jefa = await entrar(servidores.central.base, 'laura', 'jefa1234', { caja: false });
    assert.equal((await jefa.get('/api/auth/yo')).body.jefe, 1);
    assert.equal((await admin.get('/api/auth/yo')).body.jefe, 0);

    const otro = await admin.post('/api/admin/usuarios', { nombre: 'Otro', usuario: 'otrojefe', password: '1234', rol: 'jefe', sucursal_id: 1 });
    assert.equal(otro.status, 403, 'ya hay un jefe: solo un jefe crea otro');
    const cambio = await admin.put(`/api/admin/usuarios/${laura}`, { nombre: 'Laura', usuario: 'laura', password: 'nueva', rol: 'jefe', sucursal_id: 1 });
    assert.equal(cambio.status, 403, 'el administrador no le cambia la contraseña al jefe');
    const quitar = await admin.put(`/api/admin/usuarios/${laura}`, { nombre: 'Laura', usuario: 'laura', rol: 'cajero', sucursal_id: 1 });
    assert.equal(quitar.status, 403);
    assert.equal((await admin.del(`/api/admin/usuarios/${laura}`)).status, 403);
    assert.equal((await admin.get('/api/admin/usuarios')).body.find((u) => u.usuario === 'laura').jefe, 1);

    const segundo = await jefa.post('/api/admin/usuarios', { nombre: 'Pedro Jefe', usuario: 'pedro', password: 'jefe1234', rol: 'jefe', sucursal_id: 1 });
    assert.equal(segundo.status, 200, 'un jefe sí crea otro');
  });

  await t.test('movimientos como en Eleventa: cuánto había, cuánto hay, quién y por qué', async () => {
    paracetamol = (await admin.post('/api/productos', {
      codigo_barras: '7501000000101', descripcion: 'Paracetamol 500 mg', precio_costo: 10, precio_venta: 25, existencia_inicial: 20,
    })).body.id;
    assert.equal((await norte.post(`/api/productos/${paracetamol}/inventario`, { tipo: 'entrada', cantidad: 8, nota: 'Factura 1' })).status, 200);
    const venta = await norte.post('/api/ventas', { partidas: [{ producto_id: paracetamol, cantidad: 3 }], forma_pago: 'efectivo', pago: 100 });
    assert.equal(venta.status, 200, JSON.stringify(venta.body));
    assert.equal((await admin.post(`/api/productos/${paracetamol}/inventario`, { tipo: 'ajuste', cantidad: 18, nota: 'Revisión' })).status, 200);

    const r = await jefa.get('/api/movimientos');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.movimientos.map((m) => [m.sucursal, m.clase, m.delta, m.habia, m.hay, m.usuario]), [
      ['Farmacia Central', 'ajuste', null, 20, 18, 'Administrador'],
      ['Sucursal Norte', 'venta', -3, 8, 5, 'Cajero Norte'],
      ['Sucursal Norte', 'entrada', 8, 0, 8, 'Cajero Norte'],
      ['Farmacia Central', 'alta', 20, 0, 20, 'Administrador'],
    ]);
    assert.equal(r.body.movimientos[0].producto, 'Paracetamol 500 mg');
    assert.deepEqual(r.body.resumen.por_clase.venta, { movimientos: 1, piezas: 3 });
    assert.deepEqual((await jefa.get('/api/movimientos?tipo=venta')).body.movimientos.map((m) => m.cantidad), [3]);
    assert.equal((await jefa.get(`/api/movimientos?q=${encodeURIComponent('paracet')}&sucursal_id=2`)).body.movimientos.length, 2);
    assert.equal((await jefa.get('/api/movimientos?q=7501000000101&tipo=alta')).body.movimientos.length, 1);

    // Un administrador solo ve su sucursal; un cajero, ninguna
    const delAdmin = (await admin.get('/api/movimientos?sucursal_id=2')).body.movimientos;
    assert.ok(delAdmin.length > 0 && delAdmin.every((m) => m.sucursal_id === 1));
    assert.equal((await norte.get('/api/movimientos')).status, 403);
    const filtros = (await jefa.get('/api/movimientos/filtros')).body;
    assert.equal(filtros.jefe, true);
    assert.deepEqual(filtros.sucursales.map((s) => s.id), [1, 2, 3]);
  });

  await t.test('registro de cambios: precios, cancelaciones y cortes con faltante (solo lo ve el jefe)', async () => {
    const base = { codigo_barras: '7501000000101', descripcion: 'Paracetamol 500 mg', precio_costo: 10, usa_inventario: true };
    assert.equal((await admin.put(`/api/productos/${paracetamol}`, { ...base, precio_venta: 28 })).status, 200);
    const venta = await norte.post('/api/ventas', { partidas: [{ producto_id: paracetamol, cantidad: 1 }], forma_pago: 'efectivo', pago: 50 });
    assert.equal((await norte.post(`/api/ventas/${venta.body.ventaId}/cancelar`, { motivo: 'se equivocó de producto' })).status, 200);
    const corte = await norte.post('/api/cortes', { efectivo_contado: 10 });
    assert.equal(corte.status, 200, JSON.stringify(corte.body));

    const cambios = await esperarCambios(jefa, (lista) => ['producto_cambio', 'venta_cancelada', 'corte'].every((tipo) => lista.some((c) => c.tipo === tipo)));
    const precio = cambios.find((c) => c.tipo === 'producto_cambio');
    assert.match(precio.descripcion, /precio \$25\.00 → \$28\.00/);
    assert.equal(precio.alerta, true);
    assert.equal(precio.usuario, 'Administrador');
    const cancelada = cambios.find((c) => c.tipo === 'venta_cancelada');
    assert.match(cancelada.descripcion, /se equivocó de producto/);
    assert.equal(cancelada.sucursal, 'Sucursal Norte');
    const delCorte = cambios.find((c) => c.tipo === 'corte');
    assert.equal(delCorte.alerta, true, 'el corte con faltante es alerta');
    assert.match(delCorte.descripcion, /faltan \$565\.00/);
    assert.ok(cambios.some((c) => c.tipo === 'usuario_alta' && /Pedro Jefe/.test(c.descripcion)));

    const alertas = (await jefa.get('/api/bitacora?grupo=alertas')).body.cambios;
    assert.ok(alertas.length >= 3 && alertas.every((c) => c.alerta));
    const deCaja = (await jefa.get('/api/bitacora?grupo=caja')).body.cambios;
    assert.deepEqual([...new Set(deCaja.map((c) => c.tipo))].sort(), ['corte', 'venta_cancelada']);
    assert.equal((await admin.get('/api/bitacora')).status, 403, 'solo el jefe ve el registro');
    assert.equal((await norte.get('/api/bitacora')).status, 403);
  });

  await t.test('inventario del día: a ciegas, recuento, motivo y autorización del jefe', async () => {
    ibuprofeno = (await norte.post('/api/productos', {
      codigo_barras: '7501000000202', descripcion: 'Ibuprofeno 400 mg', departamento: 'Analgésicos', precio_costo: 12, precio_venta: 30, existencia_inicial: 10,
    })).body.id;
    vitamina = (await norte.post('/api/productos', {
      codigo_barras: '7501000000303', descripcion: 'Vitamina C', departamento: 'Vitaminas', precio_costo: 20, precio_venta: 45, existencia_inicial: 6,
    })).body.id;
    assert.equal(stock(central, paracetamol, 2), 5);

    const hoy = await norte.get('/api/conteos/hoy');
    assert.equal(hoy.status, 200, JSON.stringify(hoy.body));
    const lista = hoy.body;
    assert.equal(lista.estado, 'abierto');
    assert.equal(lista.productos, 3);
    assert.ok(lista.renglones.every((r) => r.existencia_sistema === undefined && r.diferencia === undefined), 'quien cuenta no ve el sistema');
    assert.equal((await norte.get('/api/conteos/hoy')).body.id, lista.id, 'la lista del día es una sola');
    const renglon = (id) => lista.renglones.find((r) => r.producto_id === id);
    const contar = (id, contado) => norte.post(`/api/conteos/${lista.id}/contar`, { renglon_id: renglon(id).id, contado });

    assert.equal((await contar(paracetamol, 5)).body.resultado, 'cuadra');
    let r = await contar(ibuprofeno, 7);
    assert.equal(r.body.resultado, 'recontar');
    assert.equal(r.body.renglon.sentido, null, 'al primer conteo no se dice si faltan o sobran');
    r = await contar(ibuprofeno, 8);
    assert.equal(r.body.resultado, 'diferencia');
    assert.equal(r.body.renglon.estado, 'falta_motivo');
    assert.equal(r.body.renglon.sentido, 'faltan');
    assert.equal((await contar(ibuprofeno, 10)).status, 400, 'no se cuenta una tercera vez');
    assert.equal((await norte.post(`/api/conteos/${lista.id}/terminar`, { dejar_pendientes: true })).body.codigo, 'FALTA_MOTIVO');
    assert.equal((await norte.post(`/api/conteos/${lista.id}/motivo`, { renglon_id: renglon(ibuprofeno).id, motivo: 'Caducado' })).status, 200);
    assert.equal((await norte.post(`/api/conteos/${lista.id}/terminar`, {})).body.codigo, 'FALTAN_POR_CONTAR');
    await contar(vitamina, 9);
    await contar(vitamina, 9);
    await norte.post(`/api/conteos/${lista.id}/motivo`, { renglon_id: renglon(vitamina).id, motivo: 'Sobrante' });
    const fin = await norte.post(`/api/conteos/${lista.id}/terminar`, {});
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.estado, 'por_autorizar');
    assert.equal(fin.body.exactitud, 33);
    assert.equal((await contar(paracetamol, 1)).body.codigo, 'CONTEO_CERRADO');

    // Se vende una vitamina después de contar: el ajuste respeta esa venta
    await abrirCaja(norte);
    assert.equal((await norte.post('/api/ventas', { partidas: [{ producto_id: vitamina, cantidad: 1 }], forma_pago: 'efectivo', pago: 100 })).status, 200);

    assert.equal((await norte.post(`/api/conteos/${lista.id}/autorizar`, { aprobar: [renglon(ibuprofeno).id] })).status, 403);
    const porAutorizar = (await jefa.get('/api/conteos?estado=por_autorizar')).body;
    assert.deepEqual(porAutorizar.map((c) => [c.sucursal, c.por_autorizar, c.faltante, c.sobrante]), [['Sucursal Norte', 2, 24, 60]]);
    const detalle = (await jefa.get(`/api/conteos/${lista.id}`)).body;
    const ibu = detalle.renglones.find((x) => x.producto_id === ibuprofeno);
    assert.deepEqual([ibu.existencia_sistema, ibu.primer_conteo, ibu.contado, ibu.diferencia, ibu.valor, ibu.motivo, ibu.contador],
      [10, 7, 8, -2, -24, 'Caducado', 'Cajero Norte']);
    const vit = detalle.renglones.find((x) => x.producto_id === vitamina);
    const autorizado = await jefa.post(`/api/conteos/${lista.id}/autorizar`, { aprobar: [ibu.id, vit.id] });
    assert.equal(autorizado.status, 200, JSON.stringify(autorizado.body));
    assert.equal(autorizado.body.estado, 'cerrado');
    assert.equal(stock(central, ibuprofeno, 2), 8);
    assert.equal(stock(central, vitamina, 2), 8, '6 − 1 vendida + 3 que sobraban');
    const delConteo = (await jefa.get('/api/movimientos?tipo=conteo')).body.movimientos;
    assert.equal(delConteo.length, 2);
    assert.match(delConteo.find((m) => m.producto_id === ibuprofeno).nota, /^Inventario del día .*: el sistema tenía 10 y se contaron 8 \(Caducado\)$/);
    assert.equal((await jefa.post(`/api/conteos/${lista.id}/autorizar`, { aprobar: [ibu.id] })).status, 400, 'no se aplica dos veces');
    const registro = await esperarCambios(jefa, (lista) => lista.some((c) => c.tipo === 'conteo_autorizado') && lista.some((c) => c.tipo === 'conteo_terminado'));
    assert.match(registro.find((c) => c.tipo === 'conteo_terminado').descripcion, /1 de 3 productos cuadraron/);
  });

  await t.test('el jefe no autoriza lo que él contó; lo rechazado no toca el inventario', async () => {
    const lista = (await jefa.get('/api/conteos/hoy')).body;
    assert.deepEqual(lista.renglones.map((r) => r.producto_id), [paracetamol], 'la central solo tiene paracetamol');
    const r = lista.renglones[0];
    assert.equal(r.existencia_sistema, null, 'aun el jefe cuenta sin ver el sistema');
    await jefa.post(`/api/conteos/${lista.id}/contar`, { renglon_id: r.id, contado: 15 });
    await jefa.post(`/api/conteos/${lista.id}/contar`, { renglon_id: r.id, contado: 15 });
    await jefa.post(`/api/conteos/${lista.id}/motivo`, { renglon_id: r.id, motivo: 'No sé' });
    assert.equal((await jefa.post(`/api/conteos/${lista.id}/terminar`, {})).body.estado, 'por_autorizar');
    const propio = await jefa.post(`/api/conteos/${lista.id}/autorizar`, { aprobar: [r.id] });
    assert.equal(propio.status, 403);
    assert.equal(propio.body.codigo, 'PROPIO');
    const pedro = await entrar(servidores.central.base, 'pedro', 'jefe1234', { caja: false });
    const rechazo = await pedro.post(`/api/conteos/${lista.id}/autorizar`, { rechazar: [r.id] });
    assert.equal(rechazo.status, 200, JSON.stringify(rechazo.body));
    assert.equal(rechazo.body.estado, 'cerrado');
    assert.equal(stock(central, paracetamol, 1), 18, 'lo rechazado no se ajusta');
    assert.equal(rechazo.body.renglones[0].decision, 'rechazado');
    assert.equal(rechazo.body.renglones[0].decisor, 'Pedro Jefe');
  });

  await t.test('inicio del jefe: inventario de cada sucursal, negativos y productos por día', async () => {
    // Existencia negativa en Sur (por ejemplo, una venta sin conexión de más)
    central.db.prepare('INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo) VALUES (?, 3, -2, 0)').run(ibuprofeno);
    const inicio = await jefa.get('/api/supervision/inicio?fresco=1');
    assert.equal(inicio.status, 200, JSON.stringify(inicio.body));
    const porNombre = Object.fromEntries(inicio.body.sucursales.map((s) => [s.sucursal, s]));
    assert.equal(porNombre['Sucursal Sur'].negativos, 1);
    assert.equal(porNombre['Sucursal Norte'].valor_costo, 5 * 10 + 8 * 12 + 8 * 20);
    assert.equal(porNombre['Sucursal Norte'].conteo_hoy.estado, 'cerrado');
    assert.equal(porNombre['Sucursal Norte'].conteo_hoy.exactitud, 33);
    assert.equal(porNombre['Sucursal Sur'].conteo_hoy, null);
    assert.deepEqual(inicio.body.por_autorizar, []);
    assert.ok(inicio.body.alertas.some((c) => c.tipo === 'corte'));
    const negativos = (await jefa.get('/api/supervision/inventario/lista?lista=negativos&sucursal_id=3')).body;
    assert.deepEqual(negativos.productos.map((p) => [p.descripcion, p.existencia]), [['Ibuprofeno 400 mg', -2]]);
    assert.equal((await admin.get('/api/supervision/inicio')).status, 403, 'el administrador no es jefe');

    assert.equal((await norte.put('/api/conteos/config', { sucursal_id: 3, productos_por_dia: 5 })).status, 403);
    const config = await jefa.put('/api/conteos/config', { sucursal_id: 3, productos_por_dia: 5 });
    assert.equal(config.status, 200, JSON.stringify(config.body));
    assert.equal(config.body.find((c) => c.sucursal_id === 3).productos_por_dia, 5);
    assert.equal((await jefa.put('/api/conteos/config', { sucursal_id: 3, productos_por_dia: 1 })).status, 400);
    assert.equal((await jefa.post('/api/conteos/importante', { producto_id: vitamina, importante: true })).body.importante, true);
    assert.equal((await jefa.get(`/api/conteos/importante/${vitamina}`)).body.importante, true);
    assert.equal((await norte.get(`/api/conteos/importante/${vitamina}`)).status, 403);
  });

  await t.test('desde el celular (la nube) el jefe y las sucursales usan las mismas reglas', async () => {
    const nube = await crearNube(central);
    const tokenJefa = await nube.vincular(laura);
    const tokenSur = await nube.vincular(3);
    assert.equal((await nube.pedir('GET', '/api/auth/yo', { token: tokenJefa })).body.jefe, 1);
    assert.equal((await nube.pedir('GET', '/api/auth/yo', { token: tokenSur })).body.jefe, 0);

    // La sucursal Sur cuenta (lo negativo entra primero) y el jefe lo ve completo
    const hoy = await nube.pedir('GET', '/api/conteos/hoy', { token: tokenSur });
    assert.equal(hoy.status, 200, JSON.stringify(hoy.body));
    assert.deepEqual(hoy.body.renglones.map((r) => r.producto_id), [ibuprofeno]);
    const contado = await nube.pedir('POST', `/api/conteos/${hoy.body.id}/contar`, { token: tokenSur, cuerpo: { renglon_id: hoy.body.renglones[0].id, contado: 0 } });
    assert.equal(contado.body.resultado, 'recontar');
    const completo = await nube.pedir('GET', `/api/conteos/${hoy.body.id}`, { token: tokenJefa });
    assert.equal(completo.body.renglones[0].razon, 'negativo');
    assert.equal(completo.body.renglones[0].existencia_sistema, -2);
    assert.equal((await nube.pedir('GET', `/api/conteos/${hoy.body.id}`, { token: tokenSur })).body.renglones[0].existencia_sistema, undefined);

    const movimientos = await nube.pedir('GET', '/api/movimientos?sucursal_id=2', { token: tokenJefa });
    assert.equal(movimientos.status, 200, JSON.stringify(movimientos.body));
    assert.ok(movimientos.body.movimientos.length >= 5);
    assert.equal((await nube.pedir('GET', '/api/movimientos', { token: tokenSur })).status, 403);
    const inicio = await nube.pedir('GET', '/api/supervision/inicio?fresco=1', { token: tokenJefa });
    assert.equal(inicio.status, 200, JSON.stringify(inicio.body));
    assert.equal(inicio.body.sucursales.find((s) => s.sucursal_id === 3).conteo_hoy.contados, 1);

    // El cambio de precio desde el celular queda en el registro con antes y después
    const producto = (await nube.pedir('GET', '/api/productos/codigo/7501000000303', { token: tokenJefa })).body;
    const precio = await nube.pedir('PUT', `/api/productos/${vitamina}`, {
      token: tokenJefa,
      cuerpo: { codigo_barras: producto.codigo_barras, descripcion: producto.descripcion, departamento: producto.departamento, precio_costo: 20, precio_venta: 48, usa_inventario: true },
    });
    assert.equal(precio.status, 200, JSON.stringify(precio.body));
    const cambios = (await nube.pedir('GET', '/api/bitacora', { token: tokenJefa })).body.cambios;
    const deCelular = cambios.find((c) => c.tipo === 'producto_cambio' && c.origen === 'celular');
    assert.match(deCelular.descripcion, /Vitamina C: precio \$45\.00 → \$48\.00/);
    assert.equal(deCelular.usuario, 'Laura Jefa');
    assert.deepEqual(nube.errores, []);
  });
});

test('sin la central el inventario del día avisa claro; movimientos y cambios se leen de la computadora', async (t) => {
  const { escenarioLocal } = require('../helpers/escenario');
  const { servidor, cerrarTodo } = await escenarioLocal();
  t.after(cerrarTodo);
  const admin = await entrar(servidor.base, 'admin', 'admin', { caja: false });
  const r = await admin.post('/api/admin/usuarios', { nombre: 'Jefe Local', usuario: 'jefelocal', password: '1234', rol: 'jefe', sucursal_id: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const jefe = await entrar(servidor.base, 'jefelocal', '1234', { caja: false });
  const producto = (await admin.post('/api/productos', { descripcion: 'Gasas', precio_venta: 12, existencia_inicial: 4 })).body.id;
  await admin.post(`/api/productos/${producto}/inventario`, { tipo: 'ajuste', cantidad: 3 });

  const hoy = await jefe.get('/api/conteos/hoy');
  assert.equal(hoy.status, 503);
  assert.match(hoy.body.error, /necesita la conexión con la central/);
  const movimientos = await jefe.get('/api/movimientos');
  assert.equal(movimientos.status, 200, JSON.stringify(movimientos.body));
  assert.equal(movimientos.body.fuente, 'local');
  assert.deepEqual(movimientos.body.movimientos.map((m) => [m.clase, m.habia, m.hay]), [['ajuste', 4, 3], ['alta', 0, 4]]);
  const cambios = await jefe.get('/api/bitacora');
  assert.equal(cambios.status, 200, JSON.stringify(cambios.body));
  assert.ok(cambios.body.cambios.some((c) => c.tipo === 'usuario_alta' && /Jefe Local/.test(c.descripcion)));
  assert.equal((await admin.get('/api/bitacora')).status, 403);
});
