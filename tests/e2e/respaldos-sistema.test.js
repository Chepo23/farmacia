'use strict';
// Respaldos automáticos de la base de cada computadora y rutas internas del programa de escritorio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { iniciarServidor, cliente } = require('../helpers/servidor');
const { crearDirTemporal, borrarDir, esperar } = require('../helpers/temporal');

const TOKEN = 'a'.repeat(64);

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('respaldos y rutas internas del programa de escritorio', async (t) => {
  const extra = crearDirTemporal('respaldo-extra');
  t.after(() => borrarDir(extra));
  const pc = await iniciarServidor({
    nombre: 'respaldos',
    envExtra: {
      HOST: '127.0.0.1',
      FARMACIA_TOKEN_INTERNO: TOKEN,
      FARMACIA_INSTANCIA: 'instancia-de-prueba',
      FARMACIA_RESPALDO_INICIAL_MS: '200',
      FARMACIA_RESPALDOS_EXTRA: extra,
    },
  });
  t.after(() => pc.cerrar());
  const carpeta = path.join(path.dirname(pc.dbPath), 'respaldos');
  const admin = cliente(pc.base);
  await admin.login('admin', 'admin');
  const interno = (metodo, ruta, token = TOKEN) => fetch(`${pc.base}/api/sistema${ruta}`, {
    method: metodo,
    headers: token ? { 'x-farmacia-interno': token } : {},
  });

  await t.test('el servidor dice qué instancia es (el programa confirma que es el suyo)', async () => {
    const salud = await (await fetch(`${pc.base}/api/sync/health`)).json();
    assert.equal(salud.instancia, 'instancia-de-prueba');
  });

  await t.test('al arrancar se hace el respaldo del día (y su copia extra)', async () => {
    const nombre = `farmacia-${hoy()}.db`;
    for (let i = 0; i < 50 && !fs.existsSync(path.join(carpeta, nombre)); i += 1) await esperar(100);
    assert.ok(fs.existsSync(path.join(carpeta, nombre)), 'respaldo del día');
    assert.ok(fs.existsSync(path.join(extra, nombre)), 'copia en la carpeta extra');
    const copia = new Database(path.join(carpeta, nombre), { readonly: true });
    assert.ok(copia.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n >= 1, 'el respaldo es una base válida');
    copia.close();
    const r = await admin.get('/api/respaldos');
    assert.equal(r.status, 200);
    assert.equal(r.body.ultimo.nombre, nombre);
    assert.equal(r.body.carpeta_extra, extra);
    assert.equal(r.body.error, '');
  });

  await t.test('respaldo manual, descarga y protección de la carpeta', async () => {
    const r = await admin.post('/api/respaldos');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.nombre, /^farmacia-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    assert.equal(r.body.resumen.total, 2);
    const descarga = await fetch(`${pc.base}/api/respaldos/${r.body.nombre}`, { headers: { Cookie: (await loginCookie(pc.base)) } });
    assert.equal(descarga.status, 200);
    assert.equal(Buffer.from(await descarga.arrayBuffer()).subarray(0, 15).toString('latin1'), 'SQLite format 3');
    const fuera = await admin.get(`/api/respaldos/${encodeURIComponent('../farmacia.db')}`);
    assert.equal(fuera.status, 404, 'no se puede descargar nada fuera de la carpeta de respaldos');

    await admin.post('/api/admin/usuarios', { nombre: 'Cajero Dos', usuario: 'cajero2', password: '1234', rol: 'cajero', sucursal_id: 1 });
    const cajero = cliente(pc.base);
    await cajero.login('cajero2', '1234');
    assert.equal((await cajero.get('/api/respaldos')).status, 403);
    assert.equal((await cajero.post('/api/respaldos')).status, 403);
  });

  await t.test('rutas internas: solo con la contraseña del programa', async () => {
    assert.equal((await interno('GET', '/estado', null)).status, 404);
    assert.equal((await interno('GET', '/estado', 'b'.repeat(64))).status, 404);
    const r = await interno('GET', '/estado');
    assert.equal(r.status, 200);
    const estado = await r.json();
    assert.equal(estado.sincronizacion.pendientes, 0);
    assert.ok(estado.respaldos.total >= 2);
    const respaldo = await interno('POST', '/respaldar');
    assert.equal(respaldo.status, 200);
  });

  await t.test('ancho de papel libre (de 40 a 120 mm)', async () => {
    let r = await admin.put('/api/config', { ticket_ancho: 76 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket_ancho, '76');
    r = await admin.put('/api/config', { ticket_ancho: 300 });
    assert.equal(r.status, 400);
    r = await admin.put('/api/config', { ticket_ancho: '58' });
    assert.equal(r.body.ticket_ancho, '58');
  });

  await t.test('apagar en orden: la base queda cerrada y el proceso termina', async () => {
    const r = await interno('POST', '/apagar');
    assert.equal(r.status, 200);
    let apagado = false;
    for (let i = 0; i < 40 && !apagado; i += 1) {
      try {
        await fetch(`${pc.base}/api/sync/health`);
        await esperar(100);
      } catch {
        apagado = true;
      }
    }
    assert.ok(apagado, 'el servidor se apagó');
    assert.ok(!fs.existsSync(`${pc.dbPath}-wal`) || fs.statSync(`${pc.dbPath}-wal`).size === 0, 'sin cambios pendientes en el WAL');
  });
});

test('sin la contraseña interna las rutas del programa no existen', async (t) => {
  const pc = await iniciarServidor({ nombre: 'sin-token', envExtra: { FARMACIA_RESPALDOS: '0' } });
  t.after(() => pc.cerrar());
  const r = await fetch(`${pc.base}/api/sistema/estado`, { headers: { 'x-farmacia-interno': '' } });
  assert.equal(r.status, 404);
  const apagar = await fetch(`${pc.base}/api/sistema/apagar`, { method: 'POST' });
  assert.equal(apagar.status, 404);
  const salud = await (await fetch(`${pc.base}/api/sync/health`)).json();
  assert.equal(salud.ok, true, 'sigue encendido');
});

async function loginCookie(base) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario: 'admin', password: 'admin' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}
