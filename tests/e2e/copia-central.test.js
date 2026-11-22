'use strict';
// Copia diaria de la central en cada computadora: baja todo la primera vez y después solo lo que
// cambió (ventas canceladas, renglones de documentos abiertos o que cambiaron, documentos borrados),
// la guarda comprimida con la fecha y la herramienta de restauración la compara y la repone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

// Sin traslape, para que la prueba ejercite de verdad la copia de "solo lo que cambió"
process.env.FARMACIA_COPIA_TRASLAPE = '0';
process.env.FARMACIA_RESPALDOS = '0'; // sin la revisión automática de cada hora durante la prueba
const { escenarioCentral, entrar } = require('../helpers/escenario');

const REPO = path.join(__dirname, '..', '..');
const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

async function esperarQue(condicion, que) {
  for (let i = 0; i < 80; i += 1) {
    if (await condicion()) return;
    await esperar(200);
  }
  throw new Error(`No se cumplió: ${que}`);
}

function leerCopia(archivo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prueba-copia-'));
  const ruta = path.join(dir, 'copia.db');
  fs.writeFileSync(ruta, zlib.gunzipSync(fs.readFileSync(archivo)));
  const db = new Database(ruta, { readonly: true });
  const filas = (tabla) => db.prepare('SELECT datos FROM filas WHERE tabla = ? ORDER BY clave').all(tabla).map((r) => JSON.parse(r.datos));
  const info = db.prepare("SELECT valor FROM info WHERE clave = 'ultima_copia'").get();
  const resultado = { filas, ultima: info && info.valor };
  const todo = {};
  for (const { tabla } of db.prepare('SELECT tabla FROM tablas').all()) todo[tabla] = filas(tabla);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...resultado, todo };
}

function restaurar(centralUrl, argumentos, cwd) {
  const env = { ...process.env };
  for (const clave of Object.keys(env)) if (/^SUPABASE_/.test(clave)) delete env[clave];
  env.SUPABASE_URL = centralUrl;
  env.SUPABASE_SERVICE_ROLE_KEY = 'clave-falsa';
  return new Promise((resolver) => {
    const hijo = spawn(process.execPath, [path.join(REPO, 'scripts', 'restaurar-central.js'), ...argumentos], { cwd, env });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('exit', (codigo) => resolver({ codigo, salida }));
  });
}

test('copia de la central en la computadora', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'prueba-restaurar-'));
  t.after(async () => {
    await cerrarTodo();
    fs.rmSync(trabajo, { recursive: true, force: true });
  });
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234');
  const alta = async (datos) => (await admin.post('/api/productos', { sucursal_id: 2, existencia_inicial: 10, ...datos })).body.id;
  const amox = await alta({ codigo_barras: '7501000000404', descripcion: 'Amoxicilina 500 mg', precio_costo: 40, precio_venta: 89 });
  const ibu = await alta({ codigo_barras: '7501000000202', descripcion: 'Ibuprofeno 400 mg', precio_costo: 12, precio_venta: 30 });
  const venta = await norte.post('/api/ventas', { partidas: [{ producto_id: amox, cantidad: 1 }], forma_pago: 'efectivo', pago: 100 });
  assert.equal(venta.status, 200, JSON.stringify(venta.body));
  await esperarQue(() => central.db.prepare('SELECT COUNT(*) AS n FROM venta_detalle').get().n === 1, 'que suba la venta');

  // Un conteo abierto, uno cerrado y un apoyo en camino, directo en la central
  const hoy = new Date().toISOString().slice(0, 10);
  const conteo = (estado, turno) => central.db.prepare("INSERT INTO conteos (sucursal_id, fecha, turno, estado, productos) VALUES (2, ?, ?, ?, 1)").run(hoy, turno, estado).lastInsertRowid;
  const renglonConteo = (conteoId, productoId) => central.db.prepare("INSERT INTO conteo_detalle (conteo_id, sucursal_id, producto_id, descripcion) VALUES (?, 2, ?, 'x')").run(conteoId, productoId).lastInsertRowid;
  const abierto = conteo('abierto', 'manana');
  const renglonAbierto = renglonConteo(abierto, amox);
  const cerrado = conteo('cerrado', 'tarde');
  renglonConteo(cerrado, ibu);
  const apoyo = central.db.prepare("INSERT INTO apoyos (folio, origen_id, destino_id, estado, creado_por) VALUES (1, 1, 2, 'enviado', 1)").run().lastInsertRowid;
  const renglonApoyo = central.db.prepare(`INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad, precio_costo, precio_venta, importe)
    VALUES (?, ?, '7501000000202', 'Ibuprofeno 400 mg', 3, 12, 30, 36)`).run(apoyo, ibu).lastInsertRowid;

  const carpeta = path.join(path.dirname(servidores.central.dbPath), 'respaldos', 'central');
  const cuenta = (tabla) => central.db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n;
  let archivo;

  await t.test('la primera copia trae todo, sin contraseñas', async () => {
    const r = await admin.post('/api/respaldos/central', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.nombre, /^central-\d{4}-\d{2}-\d{2}\.db\.gz$/);
    archivo = path.join(carpeta, r.body.nombre);
    const c = leerCopia(archivo);
    for (const tabla of ['sucursales', 'productos', 'inventario', 'ventas', 'venta_detalle', 'movimientos_inventario', 'conteos', 'conteo_detalle', 'apoyos', 'apoyo_detalle', 'usuarios_central', 'bitacora']) {
      assert.equal(c.todo[tabla].length, cuenta(tabla), `renglones de ${tabla}`);
    }
    assert.ok(c.todo.usuarios_central.every((u) => !('password_hash' in u)), 'las contraseñas no van en la copia');
    assert.ok(c.ultima);
    const resumen = (await admin.get('/api/respaldos')).body.central;
    assert.deepEqual([resumen.activo, resumen.total, resumen.ultima.nombre, resumen.error], [true, 1, r.body.nombre, '']);
  });

  await t.test('la siguiente copia solo baja lo que cambió y queda igual a la central', async () => {
    const cancelada = await norte.post(`/api/ventas/${venta.body.ventaId}/cancelar`, { motivo: 'Se equivocó' });
    assert.equal(cancelada.status, 200, JSON.stringify(cancelada.body));
    await esperarQue(() => Number(central.db.prepare('SELECT cancelada FROM ventas').get().cancelada) === 1
      && central.db.prepare("SELECT COUNT(*) AS n FROM bitacora WHERE tipo = 'venta_cancelada'").get().n === 1, 'que suba la cancelación');
    central.db.prepare('UPDATE conteo_detalle SET contado = 5 WHERE id = ?').run(renglonAbierto);
    central.db.prepare("UPDATE apoyos SET estado = 'recibido' WHERE id = ?").run(apoyo);
    central.db.prepare('UPDATE apoyo_detalle SET cantidad_recibida = 2 WHERE id = ?').run(renglonApoyo);
    central.db.prepare('DELETE FROM conteo_detalle WHERE conteo_id = ?').run(cerrado);
    central.db.prepare('DELETE FROM conteos WHERE id = ?').run(cerrado);
    // Un cambio de precio (como lo guarda el sistema: con su hora)
    central.db.prepare('UPDATE productos SET precio_venta = 35, updated_at = ? WHERE id = ?').run(new Date().toISOString(), ibu);

    const r = await admin.post('/api/respaldos/central', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(path.join(carpeta, r.body.nombre), archivo, 'el mismo día se reemplaza la copia del día');
    const c = leerCopia(archivo);
    assert.equal(Number(c.todo.ventas[0].cancelada), 1, 'la venta cancelada');
    assert.deepEqual(c.todo.conteo_detalle.map((x) => [x.conteo_id, x.contado]), [[abierto, 5]], 'el conteo abierto se relee y el borrado se quita');
    assert.deepEqual(c.todo.conteos.map((x) => x.id), [abierto]);
    assert.deepEqual([c.todo.apoyos[0].estado, c.todo.apoyo_detalle[0].cantidad_recibida], ['recibido', 2]);
    assert.equal(c.todo.productos.find((p) => p.id === ibu).precio_venta, 35, 'el precio que cambió');
    const enCopia = c.todo.inventario.find((i) => i.producto_id === amox && i.sucursal_id === 2).existencia;
    assert.deepEqual([enCopia, central.db.prepare('SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = 2').get(amox).existencia], [10, 10],
      'la existencia que regresó al cancelar la venta');
    for (const tabla of ['movimientos_inventario', 'bitacora', 'venta_detalle', 'inventario']) {
      assert.equal(c.todo[tabla].length, cuenta(tabla), `renglones de ${tabla}`);
    }
  });

  await t.test('la herramienta compara sin escribir y, con --aplicar, repone lo que se perdió', async () => {
    const existencias = central.db.prepare('SELECT producto_id, existencia FROM inventario WHERE sucursal_id = 2 ORDER BY producto_id').all();
    central.db.prepare('DELETE FROM inventario WHERE sucursal_id = 2').run();
    central.db.prepare('UPDATE productos SET precio_venta = 1 WHERE id = ?').run(amox);

    const comparacion = await restaurar(central.url, [archivo], trabajo);
    assert.equal(comparacion.codigo, 0, comparacion.salida);
    assert.match(comparacion.salida, /inventario: copia \d+, central \d+; faltan en la central 2/);
    assert.match(comparacion.salida, /productos: copia 2, central 2; faltan en la central 0, distintos 1/);
    assert.match(comparacion.salida, /Solo se comparó/);
    assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM inventario WHERE sucursal_id = 2').get().n, 0, 'comparar no escribe');

    const sinTablas = await restaurar(central.url, [archivo, '--aplicar'], trabajo);
    assert.equal(sinTablas.codigo, 1, 'para escribir hay que decir qué tablas');

    const aplicado = await restaurar(central.url, [archivo, '--tablas', 'productos,inventario', '--aplicar'], trabajo);
    assert.equal(aplicado.codigo, 0, aplicado.salida);
    assert.deepEqual(central.db.prepare('SELECT producto_id, existencia FROM inventario WHERE sucursal_id = 2 ORDER BY producto_id').all(), existencias);
    assert.equal(central.db.prepare('SELECT precio_venta FROM productos WHERE id = ?').get(amox).precio_venta, 89);
    const sql = fs.readdirSync(trabajo).filter((f) => /^ajustar-ids-\d+\.sql$/.test(f));
    assert.equal(sql.length, 1, aplicado.salida);
    assert.match(fs.readFileSync(path.join(trabajo, sql[0]), 'utf8'), /setval\(pg_get_serial_sequence\('public\.inventario', 'id'\)/);
  });

  await t.test('se puede descargar desde Administración', async () => {
    const descarga = await admin.get(`/api/respaldos/central/${path.basename(archivo)}`);
    assert.equal(descarga.status, 200);
    assert.match(descarga.headers.get('content-disposition') || '', /central-\d{4}-\d{2}-\d{2}\.db\.gz/);
    assert.equal((await admin.get('/api/respaldos/central/no-existe.db.gz')).status, 404);
    assert.equal((await norte.post('/api/respaldos/central', {})).status, 403, 'solo un administrador');
  });
});
