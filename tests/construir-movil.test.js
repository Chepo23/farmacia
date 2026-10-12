'use strict';
// El armado de la app del celular para la nube: archivos completos, instalable y la función de
// Supabase en un solo archivo que de verdad funciona (se corre aquí con un "Deno" de mentira).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { construirApp, construirFuncion } = require('../scripts/construir-movil');
const { iniciarCentralFalsa, sembrarBase } = require('./helpers/central-falsa');
const { SUCURSALES } = require('./helpers/escenario');
const { crearDirTemporal, borrarDir } = require('./helpers/temporal');
const { crearCodigo } = require('./helpers/nube');
const { hashPassword } = require('../src/passwords');

test('armado de la app del celular y de la función de Supabase', async (t) => {
  const dir = crearDirTemporal('construir-movil');
  t.after(() => borrarDir(dir));
  const salida = path.join(dir, 'app');
  const salidaFuncion = path.join(dir, 'funcion');
  const api = 'https://proyecto-de-prueba.supabase.co/functions/v1/movil';

  await t.test('la app trae todo lo que necesita para instalarse y funcionar', () => {
    construirApp({ salida, api, origenApi: new URL(api).origin, nombre: 'Inventario — Prueba' });
    const config = fs.readFileSync(path.join(salida, 'config.js'), 'utf8');
    assert.match(config, /"api": "https:\/\/proyecto-de-prueba\.supabase\.co\/functions\/v1\/movil"/);
    assert.doesNotMatch(config, /sb_secret|service_role|clave/i, 'la app no lleva llaves');

    const html = fs.readFileSync(path.join(salida, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="img\/apple-touch-icon.png">/);
    assert.ok(html.indexOf('src="config.js"') < html.indexOf('src="js/movil.js"'), 'config.js se carga antes que la app');

    const manifiesto = JSON.parse(fs.readFileSync(path.join(salida, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifiesto.display, 'standalone');
    assert.equal(manifiesto.name, 'Inventario — Prueba');
    for (const icono of manifiesto.icons) assert.ok(fs.existsSync(path.join(salida, icono.src)), icono.src);
    assert.ok(manifiesto.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));

    const sw = fs.readFileSync(path.join(salida, 'sw.js'), 'utf8');
    const archivos = JSON.parse(sw.match(/const ARCHIVOS = (\[[\s\S]*?\]);/)[1]);
    for (const archivo of archivos.filter((a) => a !== './')) assert.ok(fs.existsSync(path.join(salida, archivo)), archivo);
    const version = sw.match(/const VERSION = '([^']+)'/)[1];

    const encabezados = fs.readFileSync(path.join(salida, '_headers'), 'utf8');
    assert.match(encabezados, /connect-src 'self' https:\/\/proyecto-de-prueba\.supabase\.co;/);
    assert.match(encabezados, /\/sw\.js\n {2}Cache-Control: no-cache/);

    // Volver a armar sin cambios da la misma versión; con otra dirección, otra versión
    construirApp({ salida, api, origenApi: new URL(api).origin, nombre: 'Inventario — Prueba' });
    assert.equal(fs.readFileSync(path.join(salida, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1], version);
    construirApp({ salida, api: 'https://otro.supabase.co/functions/v1/movil', origenApi: 'https://otro.supabase.co', nombre: 'X' });
    assert.notEqual(fs.readFileSync(path.join(salida, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1], version);
  });

  await t.test('la función en un solo archivo atiende como en Supabase', async () => {
    construirFuncion({ salida: salidaFuncion });
    const codigo = fs.readFileSync(path.join(salidaFuncion, 'index.ts'), 'utf8');
    assert.equal((codigo.match(/^import /gm) || []).length, 1, 'solo importa el cliente de Supabase');
    assert.doesNotMatch(codigo, /manejador\.mjs/);

    const central = await iniciarCentralFalsa();
    t.after(() => central.cerrar());
    sembrarBase(central.db, {
      sucursales: SUCURSALES,
      usuarios: [{ id: 1, nombre: 'Administrador', usuario: 'admin', password_hash: hashPassword('admin'), rol: 'admin', sucursal_id: 1, activo: true }],
    });

    // "Deno" de mentira: variables de entorno de la función y Deno.serve que guarda el manejador
    let manejador = null;
    globalThis.Deno = {
      env: { get: (clave) => ({ SUPABASE_URL: central.url, FARMACIA_SECRET_KEY: central.key })[clave] },
      serve: (fn) => { manejador = fn; },
    };
    t.after(() => { delete globalThis.Deno; });
    const supabaseJs = pathToFileURL(require.resolve('@supabase/supabase-js')).href;
    const archivo = path.join(dir, 'funcion-node.mjs');
    fs.writeFileSync(archivo, codigo.replace(/'npm:@supabase\/supabase-js@[^']+'/, `'${supabaseJs}'`));
    await import(pathToFileURL(archivo).href);
    assert.equal(typeof manejador, 'function');

    const sinSesion = await manejador(new Request('https://x.supabase.co/movil/api/auth/yo'));
    assert.equal(sinSesion.status, 401);
    const vinculo = await manejador(new Request('https://x.supabase.co/movil/api/movil/vincular', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: crearCodigo(central.db, 1) }),
    }));
    assert.equal(vinculo.status, 200);
    const { token } = await vinculo.json();
    const yo = await manejador(new Request('https://x.supabase.co/movil/api/auth/yo', { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal((await yo.json()).usuario, 'admin');
  });
});
