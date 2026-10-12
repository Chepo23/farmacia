'use strict';
// Armado del programa de escritorio: qué archivos del servidor viajan dentro del instalador.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sirveAlServidor } = require('../scripts/construir-escritorio');

const M = 'C:\\farmacia-construccion\\paquete\\servidor\\node_modules';

test('el servidor del programa lleva lo necesario y nada de compilación', () => {
  const lleva = (ruta) => sirveAlServidor(`${M}\\${ruta}`);
  assert.ok(lleva('express\\index.js'));
  assert.ok(lleva('better-sqlite3\\lib\\database.js'));
  assert.ok(lleva('better-sqlite3\\build'));
  assert.ok(lleva('better-sqlite3\\build\\Release'));
  assert.ok(lleva('better-sqlite3\\build\\Release\\better_sqlite3.node'), 'la base de datos nativa');
  assert.ok(lleva('@zxing\\library\\umd\\index.min.js'), 'lector de códigos para el celular');
  assert.ok(lleva('@supabase\\supabase-js\\dist\\index.cjs'));

  assert.ok(!lleva('better-sqlite3\\deps\\sqlite3\\sqlite3.c'), 'código fuente de SQLite');
  assert.ok(!lleva('better-sqlite3\\src\\better_sqlite3.cpp'));
  assert.ok(!lleva('better-sqlite3\\build\\Release\\obj'));
  assert.ok(!lleva('better-sqlite3\\build\\Release\\better_sqlite3.pdb'));
  assert.ok(!lleva('better-sqlite3\\build\\deps'));
  assert.ok(!lleva('@zxing\\library\\esm\\index.js'));
  assert.ok(!lleva('@zxing\\library\\umd\\index.js'), 'solo la versión mínima');
  assert.ok(!lleva('express\\index.js.map'));
  assert.ok(!lleva('@supabase\\supabase-js\\dist\\index.d.cts'));
  assert.ok(!lleva('.bin'));
});

test('la configuración del instalador incluye el servidor y protege el ejecutable', () => {
  const paquete = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'escritorio', 'package.json'), 'utf8'));
  const recursos = paquete.build.extraResources[0];
  // electron-builder omite node_modules en la raíz de un recurso extra: el servidor va en una subcarpeta
  assert.equal(recursos.to, '.');
  assert.deepEqual(recursos.filter, ['servidor/**/*']);
  assert.equal(paquete.build.electronFuses.runAsNode, false, 'el .exe no se puede usar como Node.js');
  assert.equal(paquete.build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(paquete.build.nsis.deleteAppDataOnUninstall, false, 'desinstalar no borra las ventas');
  assert.match(paquete.version, /^\d+\.\d+\.\d+$/);
});
