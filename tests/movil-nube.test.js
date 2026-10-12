'use strict';
// App del celular en la nube: la función "movil" de Supabase contra la central falsa.
// Vinculación por código, sesiones, consultas y movimientos con las mismas reglas que la computadora.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword } = require('../src/passwords');
const { iniciarCentralFalsa, sembrarBase } = require('./helpers/central-falsa');
const { SUCURSALES } = require('./helpers/escenario');
const { crearNube, sha256 } = require('./helpers/nube');

const PARACETAMOL = '7501234567893';
const VITAMINA = '7509876543213';

function sembrar(central) {
  sembrarBase(central.db, {
    sucursales: SUCURSALES,
    usuarios: [
      { id: 1, nombre: 'Administrador', usuario: 'admin', password_hash: hashPassword('admin'), rol: 'admin', sucursal_id: 1, activo: true },
      { id: 2, nombre: 'Cajero Norte', usuario: 'cajero2', password_hash: hashPassword('1234'), rol: 'cajero', sucursal_id: 2, activo: true },
      { id: 3, nombre: 'Cajero Sur', usuario: 'cajero3', password_hash: hashPassword('1234'), rol: 'cajero', sucursal_id: 3, activo: true },
      { id: 4, nombre: 'Encargada Norte', usuario: 'adminnorte', password_hash: hashPassword('1234'), rol: 'admin', sucursal_id: 2, activo: true },
    ],
    productos: [
      { id: 1, codigo_barras: PARACETAMOL, descripcion: 'Paracetamol 500 mg c/10', precio_costo: 14.5, precio_venta: 28, precio_mayoreo: 25, cantidad_mayoreo: 3 },
      { id: 2, codigo_barras: VITAMINA, descripcion: 'Vitamina C 1000 mg c/30', precio_costo: 24, precio_venta: 42 },
      { id: 3, codigo_barras: '7500000000015', descripcion: 'Bolsa de regalo', precio_venta: 5, usa_inventario: false },
      { id: 4, codigo_barras: '7500000000022', descripcion: 'Jarabe descontinuado', precio_venta: 50, activo: false },
    ],
    inventario: [
      { producto_id: 1, sucursal_id: 1, existencia: 10, minimo: 4 },
      { producto_id: 1, sucursal_id: 2, existencia: 3, minimo: 2 },
      { producto_id: 2, sucursal_id: 1, existencia: 6, minimo: 0 },
    ],
  });
}

const existenciaCentral = (central, productoId, sucursalId) =>
  central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?').get(productoId, sucursalId)?.existencia;

test('app del celular en la nube (función "movil" de Supabase)', async (t) => {
  const central = await iniciarCentralFalsa();
  t.after(() => central.cerrar());
  sembrar(central);
  const nube = await crearNube(central);
  let admin;
  let cajero;

  await t.test('vincular: el código sirve una sola vez y solo se guarda su huella', async () => {
    const codigo = nube.crearCodigo(2);
    const r = await nube.pedir('POST', '/api/movil/vincular', {
      cuerpo: { codigo: `${codigo.slice(0, 4).toLowerCase()}-${codigo.slice(4)}`, dispositivo: 'Android · Pixel 7' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token.length >= 40);
    assert.deepEqual(
      { id: r.body.usuario.id, rol: r.body.usuario.rol, sucursal: r.body.usuario.sucursal, modo: r.body.usuario.modo },
      { id: 2, rol: 'cajero', sucursal: 'Sucursal Norte', modo: 'nube' }
    );
    cajero = r.body.token;
    const sesion = central.db.prepare('SELECT * FROM sesiones_movil WHERE usuario_id = 2').get();
    assert.equal(sesion.token_hash, sha256(cajero), 'la central guarda la huella, no el token');
    assert.equal(sesion.dispositivo, 'Android · Pixel 7');
    assert.ok(!JSON.stringify(central.db.prepare('SELECT * FROM vinculos_movil').all()).includes(codigo), 'el código no se guarda');

    const otraVez = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo } });
    assert.equal(otraVez.status, 400);
    assert.equal(otraVez.body.codigo, 'CODIGO_USADO');

    const vencido = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo: nube.crearCodigo(2, { minutos: -1 }) } });
    assert.equal(vencido.body.codigo, 'CODIGO_VENCIDO');
    const inventado = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: { codigo: 'ZZZZ-9999' } });
    assert.equal(inventado.body.codigo, 'CODIGO_INVALIDO');
    const vacio = await nube.pedir('POST', '/api/movil/vincular', { cuerpo: {} });
    assert.equal(vacio.status, 400);

    // El código también se acepta dentro de la dirección del QR
    const qr = await nube.pedir('POST', '/api/movil/vincular', {
      cuerpo: { codigo: `https://farmacia-inventario.pages.dev/#vincular=${nube.crearCodigo(1)}` },
    });
    assert.equal(qr.status, 200, JSON.stringify(qr.body));
    admin = qr.body.token;
    assert.equal(qr.body.usuario.es_central, 1);
  });

  await t.test('sin sesión válida no se puede consultar nada', async () => {
    for (const token of [undefined, 'token-inventado-que-no-existe-en-la-central']) {
      const r = await nube.pedir('GET', `/api/productos/codigo/${PARACETAMOL}`, { token });
      assert.equal(r.status, 401);
      assert.equal(r.body.codigo, 'SIN_SESION');
    }
    const yo = await nube.pedir('GET', '/api/auth/yo', { token: cajero });
    assert.equal(yo.status, 200);
    assert.equal(yo.body.nombre, 'Cajero Norte');
  });

  await t.test('consultar: precio y existencias de todas las sucursales', async () => {
    const r = await nube.pedir('GET', `/api/productos/codigo/${PARACETAMOL}`, { token: cajero });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.precio_venta, 28);
    assert.equal(r.body.precio_mayoreo, 25);
    assert.equal(r.body.cantidad_mayoreo, 3);
    assert.deepEqual(r.body.existencias.map((e) => [e.sucursal, e.existencia, e.minimo]), [
      ['Farmacia Central', 10, 4], ['Sucursal Norte', 3, 2], ['Sucursal Sur', 0, 0],
    ]);
    assert.equal(r.body.existencia_local, 3);
    assert.equal(r.body.total_disponible, 13);

    assert.equal((await nube.pedir('GET', '/api/productos/codigo/7500000000022', { token: cajero })).status, 404, 'dado de baja');
    assert.equal((await nube.pedir('GET', '/api/productos/codigo/0000', { token: cajero })).status, 404);

    const busqueda = await nube.pedir('GET', `/api/productos/buscar?q=${encodeURIComponent('vitamina')}`, { token: cajero });
    assert.deepEqual(busqueda.body.map((p) => p.descripcion), ['Vitamina C 1000 mg c/30']);
    const raro = await nube.pedir('GET', `/api/productos/buscar?q=${encodeURIComponent('a,b"(c)')}`, { token: cajero });
    assert.equal(raro.status, 200, 'comas, comillas y paréntesis no rompen la búsqueda');

    const sucursales = await nube.pedir('GET', '/api/admin/sucursales', { token: cajero });
    assert.deepEqual(sucursales.body.map((s) => s.id), [1, 2, 3]);
  });

  await t.test('movimientos: mismas reglas que en la computadora', async () => {
    const mover = (token, productoId, cuerpo) => nube.pedir('POST', `/api/productos/${productoId}/inventario`, { token, cuerpo });

    let r = await mover(cajero, 1, { tipo: 'entrada', cantidad: 5, sucursal_id: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existencia, 8);
    assert.equal(existenciaCentral(central, 1, 2), 8);
    const movimiento = central.db.prepare('SELECT * FROM movimientos_inventario ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual([movimiento.tipo, movimiento.cantidad, movimiento.usuario_id, movimiento.existencia_resultante, movimiento.nota],
      ['entrada', 5, 2, 8, 'Desde el celular']);

    r = await mover(cajero, 1, { tipo: 'salida', cantidad: 20, sucursal_id: 2 });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'SIN_EXISTENCIA');
    assert.equal(existenciaCentral(central, 1, 2), 8, 'una merma mayor a lo que hay no se aplica');

    r = await mover(cajero, 1, { tipo: 'ajuste', cantidad: 4, nota: 'Conteo rápido', sucursal_id: 2 });
    assert.equal(r.body.existencia, 4);
    r = await mover(cajero, 1, { minimo: 7, sucursal_id: 2 });
    assert.deepEqual([r.status, r.body.minimo, r.body.existencia], [200, 7, 4]);

    r = await mover(cajero, 1, { tipo: 'entrada', cantidad: 1, sucursal_id: 1 });
    assert.equal(r.status, 403, 'un cajero no mueve el inventario de otra sucursal');
    r = await mover(cajero, 3, { tipo: 'entrada', cantidad: 1 });
    assert.equal(r.status, 400, 'producto sin control de inventario');
    r = await mover(cajero, 1, { tipo: 'entrada', cantidad: -2 });
    assert.equal(r.status, 400);
    r = await mover(cajero, 1, { tipo: 'regalo', cantidad: 2 });
    assert.equal(r.status, 400);

    // El administrador de la central trabaja con cualquier sucursal (crea la existencia si no había)
    r = await mover(admin, 2, { tipo: 'entrada', cantidad: 2, sucursal_id: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(existenciaCentral(central, 2, 3), 2);

    const kardex = await nube.pedir('GET', '/api/productos/1/kardex?sucursal_id=2&limite=10', { token: cajero });
    assert.equal(kardex.status, 200);
    assert.deepEqual(kardex.body.movimientos.map((m) => [m.tipo, m.delta, m.existencia_resultante, m.usuario]), [
      ['ajuste', null, 4, 'Cajero Norte'],
      ['entrada', 5, 8, 'Cajero Norte'],
    ]);
    assert.equal(kardex.body.producto.existencia_local, 4);
  });

  await t.test('recepción y conteo por lote', async () => {
    const antes1 = existenciaCentral(central, 1, 2);
    let r = await nube.pedir('POST', '/api/productos/inventario/lote', {
      token: cajero,
      cuerpo: {
        tipo: 'entrada', sucursal_id: 2, nota: 'Factura A-77',
        renglones: [{ producto_id: 1, cantidad: 2 }, { producto_id: 2, cantidad: 3 }, { producto_id: 3, cantidad: 1 }, { producto_id: 1, cantidad: 1 }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.aplicados, 2);
    assert.deepEqual(r.body.omitidos, ['Bolsa de regalo']);
    assert.equal(existenciaCentral(central, 1, 2), antes1 + 3);
    assert.equal(existenciaCentral(central, 2, 2), 3);

    // Todo o nada: un producto que no existe cancela toda la lista
    r = await nube.pedir('POST', '/api/productos/inventario/lote', {
      token: cajero, cuerpo: { tipo: 'entrada', sucursal_id: 2, renglones: [{ producto_id: 1, cantidad: 5 }, { producto_id: 999, cantidad: 1 }] },
    });
    assert.equal(r.status, 404);
    assert.equal(existenciaCentral(central, 1, 2), antes1 + 3);

    // Conteo: se contó con 10 en sistema; mientras tanto se vendieron 2. Se ajusta la diferencia del conteo.
    const alContar = existenciaCentral(central, 1, 2);
    central.db.prepare('UPDATE inventario SET existencia = existencia - 2 WHERE producto_id = 1 AND sucursal_id = 2').run();
    r = await nube.pedir('POST', '/api/productos/inventario/lote', {
      token: cajero,
      cuerpo: {
        tipo: 'conteo', sucursal_id: 2, nota: 'Estante 3',
        renglones: [
          { producto_id: 1, contado: alContar - 1, existencia_al_contar: alContar },
          { producto_id: 2, contado: 3, existencia_al_contar: 3 },
        ],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.aplicados, r.body.sin_diferencia], [1, 1]);
    assert.equal(existenciaCentral(central, 1, 2), alContar - 2 - 1, 'faltaba 1: se resta sin deshacer las ventas');
    const nota = central.db.prepare('SELECT nota FROM movimientos_inventario ORDER BY id DESC LIMIT 1').get().nota;
    assert.match(nota, /Conteo físico: el sistema tenía \d+ y se contaron \d+ — Estante 3/);
  });

  await t.test('dos celulares sacando la última pieza a la vez: solo uno puede', async () => {
    central.db.prepare('UPDATE inventario SET existencia = 1 WHERE producto_id = 2 AND sucursal_id = 2').run();
    const otro = await nube.vincular(4);
    const [a, b] = await Promise.all([
      nube.pedir('POST', '/api/productos/2/inventario', { token: cajero, cuerpo: { tipo: 'salida', cantidad: 1, sucursal_id: 2 } }),
      nube.pedir('POST', '/api/productos/2/inventario', { token: otro, cuerpo: { tipo: 'salida', cantidad: 1, sucursal_id: 2 } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);
    assert.equal(existenciaCentral(central, 2, 2), 0);
  });

  await t.test('precios y altas: solo el administrador de la central', async () => {
    const datos = { codigo_barras: PARACETAMOL, descripcion: 'Paracetamol 500 mg c/10', departamento: '', usa_inventario: true, precio_venta: 30, precio_costo: 15, precio_mayoreo: 26, cantidad_mayoreo: 3 };
    let r = await nube.pedir('PUT', '/api/productos/1', { token: cajero, cuerpo: datos });
    assert.deepEqual([r.status, r.body.codigo], [403, 'SOLO_CENTRAL']);
    const encargada = await nube.vincular(4);
    r = await nube.pedir('PUT', '/api/productos/1', { token: encargada, cuerpo: datos });
    assert.equal(r.status, 403, 'el administrador de una sucursal tampoco cambia precios');

    r = await nube.pedir('PUT', '/api/productos/1', { token: admin, cuerpo: datos });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fila = central.db.prepare('SELECT precio_venta, precio_costo, precio_mayoreo FROM productos WHERE id = 1').get();
    assert.deepEqual(fila, { precio_venta: 30, precio_costo: 15, precio_mayoreo: 26 });
    r = await nube.pedir('PUT', '/api/productos/1', { token: admin, cuerpo: { ...datos, precio_venta: -1 } });
    assert.equal(r.status, 400);
    r = await nube.pedir('PUT', '/api/productos/1', { token: admin, cuerpo: { ...datos, codigo_barras: VITAMINA } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Ya existe/);

    r = await nube.pedir('POST', '/api/productos', { token: cajero, cuerpo: { codigo_barras: '7500000000039', descripcion: 'Nuevo', precio_venta: 10 } });
    assert.equal(r.status, 403);
    r = await nube.pedir('POST', '/api/productos', {
      token: admin,
      cuerpo: { codigo_barras: '7500000000039', descripcion: 'Suero oral 500 ml', precio_costo: 12, precio_venta: 22, sucursal_id: 2, existencia_inicial: 6 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(existenciaCentral(central, r.body.id, 2), 6);
    r = await nube.pedir('POST', '/api/productos', { token: admin, cuerpo: { codigo_barras: '7500000000039', descripcion: 'Otro', precio_venta: 1 } });
    assert.match(r.body.error, /Ya existe/);
  });

  await t.test('cerrar sesión, revocar, baja del usuario y sesión abandonada', async () => {
    const yo = (token) => nube.pedir('GET', '/api/auth/yo', { token }).then((r) => r.status);

    const token1 = await nube.vincular(3);
    assert.equal((await nube.pedir('POST', '/api/auth/logout', { token: token1 })).status, 200);
    assert.equal(await yo(token1), 401);

    const token2 = await nube.vincular(3);
    central.db.prepare('UPDATE sesiones_movil SET revocada = ? WHERE token_hash = ?').run(new Date().toISOString(), sha256(token2));
    assert.equal(await yo(token2), 401, 'desvinculado desde la computadora');

    const token3 = await nube.vincular(3);
    central.db.prepare('UPDATE sesiones_movil SET ultimo_uso = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 181 * 86400000).toISOString(), sha256(token3));
    assert.equal(await yo(token3), 401, 'más de 180 días sin usarse');

    const token4 = await nube.vincular(3);
    assert.equal(await yo(token4), 200);
    central.db.prepare('UPDATE usuarios_central SET activo = 0 WHERE id = 3').run();
    assert.equal(await yo(token4), 401, 'usuario dado de baja');
    central.db.prepare('UPDATE usuarios_central SET activo = 1 WHERE id = 3').run();

    // Una sesión en uso se renueva sola
    central.db.prepare('UPDATE sesiones_movil SET ultimo_uso = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 30 * 86400000).toISOString(), sha256(token4));
    assert.equal(await yo(token4), 200);
    const ultimoUso = central.db.prepare('SELECT ultimo_uso FROM sesiones_movil WHERE token_hash = ?').get(sha256(token4)).ultimo_uso;
    assert.ok(Date.now() - new Date(ultimoUso).getTime() < 60000);
  });

  await t.test('CORS, rutas desconocidas y solicitudes mal formadas', async () => {
    const pre = await nube.manejar(new Request('https://x.invalid/functions/v1/movil/api/productos/buscar', {
      method: 'OPTIONS', headers: { Origin: 'https://farmacia-inventario.pages.dev' },
    }));
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);

    const nada = await nube.pedir('GET', '/api/ventas', { token: admin });
    assert.equal(nada.status, 404);
    assert.equal(nada.headers.get('access-control-allow-origin'), '*');
    const malo = await nube.pedir('POST', '/api/productos/inventario/lote', { token: admin, cuerpo: '{"tipo":' });
    assert.equal(malo.status, 400);

    const restringida = await crearNube(central, { origenesPermitidos: ['https://farmacia-inventario.pages.dev'] });
    const r = await restringida.pedir('GET', '/api/auth/yo', { token: admin, cabeceras: { Origin: 'https://otro-sitio.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://farmacia-inventario.pages.dev');
  });

  assert.deepEqual(nube.errores, [], 'la función no debe registrar errores inesperados');
});
