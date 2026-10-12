#!/usr/bin/env node
/**
 * Arma el instalador del programa de escritorio para Windows (Electron).
 *
 *   node scripts/construir-escritorio.js            -> dist-escritorio\Farmacia-Instalador-X.Y.Z.exe
 *   node scripts/construir-escritorio.js --carpeta  -> solo la carpeta del programa, sin instalador (para probar)
 *
 * Todo se arma en una carpeta local fuera de OneDrive (%LOCALAPPDATA%\farmacia-construccion; se puede
 * cambiar con FARMACIA_CONSTRUCCION) para no subir a la nube cientos de MB de herramientas. Al final
 * solo el instalador (y latest.yml para las actualizaciones automáticas) se copia a dist-escritorio\.
 *
 * El servidor del sistema va dentro del programa con el mismo Node.js con el que se corre este
 * script (y con el que pasan las pruebas): así la base de datos nativa no se recompila.
 * La versión del programa está en escritorio/package.json ("version"): súbela en cada entrega.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FUENTE = path.join(REPO, 'escritorio');
const BASE = path.resolve(process.env.FARMACIA_CONSTRUCCION || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'farmacia-construccion'));
const SOLO_CARPETA = process.argv.includes('--carpeta');

function paso(texto) {
  console.log(`\n▶ ${texto}`);
}

// En Windows npm y electron-builder son archivos .cmd: se ejecutan con el intérprete de comandos
function ejecutar(comando, argumentos, cwd) {
  const linea = [comando, ...argumentos].map((parte) => (/[\s"]/.test(parte) ? `"${parte.replace(/"/g, '\\"')}"` : parte)).join(' ');
  const r = spawnSync(linea, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`Falló: ${linea}`);
}

function copiar(origen, destino, filtro) {
  fs.cpSync(origen, destino, { recursive: true, force: true, filter: filtro ? (o) => filtro(o) : undefined });
}

function tamanio(ruta) {
  let total = 0;
  const info = fs.statSync(ruta);
  if (!info.isDirectory()) return info.size;
  for (const nombre of fs.readdirSync(ruta)) total += tamanio(path.join(ruta, nombre));
  return total;
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// Lo que el servidor no necesita para funcionar (código fuente de C, compilación, mapas, tipos)
function sirveAlServidor(origen) {
  const r = origen.replace(/\\/g, '/');
  if (/\/node_modules\/\.bin(\/|$)/.test(r) || /\/node_modules\/\.package-lock\.json$/.test(r)) return false;
  if (/\/better-sqlite3\/(deps|src)(\/|$)/.test(r)) return false;
  const compilado = r.match(/\/better-sqlite3\/build\/(.+)$/);
  if (compilado) return compilado[1] === 'Release' || compilado[1] === 'Release/better_sqlite3.node';
  if (/\/@zxing\/library\/(cjs|esm|esm5|es2015|esnext)(\/|$)/.test(r)) return false;
  if (/\/@zxing\/library\/umd\/index\.js$/.test(r)) return false;
  return !/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(r);
}

function prepararPrograma() {
  paso('Copiando el programa de escritorio');
  const destino = path.join(BASE, 'escritorio');
  fs.mkdirSync(destino, { recursive: true });
  for (const nombre of ['main.js', 'preload.js', 'package.json']) fs.copyFileSync(path.join(FUENTE, nombre), path.join(destino, nombre));
  for (const carpeta of ['src', 'paginas', 'recursos']) {
    fs.rmSync(path.join(destino, carpeta), { recursive: true, force: true });
    copiar(path.join(FUENTE, carpeta), path.join(destino, carpeta));
  }
  // Las herramientas (Electron y el armador) se instalan una vez y se reusan mientras no cambien
  const paquete = JSON.parse(fs.readFileSync(path.join(FUENTE, 'package.json'), 'utf8'));
  const huella = crypto.createHash('sha256').update(JSON.stringify([paquete.dependencies, paquete.devDependencies])).digest('hex');
  const marca = path.join(destino, 'node_modules', '.farmacia-dependencias');
  const instaladas = fs.existsSync(marca) && fs.readFileSync(marca, 'utf8') === huella;
  if (!instaladas) {
    paso('Instalando Electron y el armador del instalador (solo la primera vez; descarga ~150 MB)');
    ejecutar('npm', ['install', '--no-audit', '--no-fund'], destino);
    fs.writeFileSync(marca, huella);
  }
  return { destino, version: paquete.version };
}

// Va en paquete\servidor (y no en servidor\): electron-builder siempre omite la carpeta node_modules
// que queda en la raíz de un recurso extra, pero no la de una subcarpeta
function prepararServidor() {
  paso('Copiando el servidor del sistema');
  const destino = path.join(BASE, 'paquete', 'servidor');
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  for (const nombre of ['server.js', 'package.json']) fs.copyFileSync(path.join(REPO, nombre), path.join(destino, nombre));
  copiar(path.join(REPO, 'src'), path.join(destino, 'src'));
  copiar(path.join(REPO, 'public'), path.join(destino, 'public'));
  const modulos = path.join(REPO, 'node_modules');
  if (!fs.existsSync(path.join(modulos, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))) {
    throw new Error('Faltan las dependencias del sistema: corre "npm install" en la carpeta del sistema y vuelve a intentar.');
  }
  copiar(modulos, path.join(destino, 'node_modules'), sirveAlServidor);
  // El mismo Node.js que corre este script (con el que se compiló better-sqlite3)
  fs.copyFileSync(process.execPath, path.join(destino, 'node.exe'));
  // Comprobación: el servidor copiado carga su base de datos con ese Node.js
  const prueba = spawnSync(path.join(destino, 'node.exe'), ['-e', "require('better-sqlite3')(':memory:').prepare('select 1').get()"], { cwd: destino });
  if (prueba.status !== 0) throw new Error(`El servidor copiado no puede abrir la base de datos:\n${prueba.stderr}`);
  console.log(`  Servidor listo (${mb(tamanio(destino))}, Node.js ${process.version})`);
  return destino;
}

function construir({ destino, version }) {
  paso(SOLO_CARPETA ? 'Armando la carpeta del programa' : 'Armando el instalador');
  const salida = path.join(BASE, 'salida');
  fs.rmSync(salida, { recursive: true, force: true });
  const armador = path.join(destino, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  ejecutar(armador, ['--win', SOLO_CARPETA ? 'dir' : 'nsis', '--x64', '--publish', 'never'], destino);
  const carpeta = path.join(salida, 'win-unpacked');
  if (SOLO_CARPETA) return { carpeta };
  const instalador = path.join(salida, `Farmacia-Instalador-${version}.exe`);
  if (!fs.existsSync(instalador)) throw new Error(`No se generó ${instalador}`);
  const entrega = path.join(REPO, 'dist-escritorio');
  fs.mkdirSync(entrega, { recursive: true });
  const copiados = [];
  for (const nombre of fs.readdirSync(salida)) {
    if (/^Farmacia-Instalador-.*\.(exe|blockmap)$/.test(nombre) || nombre === 'latest.yml') {
      fs.copyFileSync(path.join(salida, nombre), path.join(entrega, nombre));
      copiados.push(nombre);
    }
  }
  return { carpeta, instalador: path.join(entrega, path.basename(instalador)), copiados };
}

function main() {
  if (process.platform !== 'win32') throw new Error('El instalador se arma en Windows');
  console.log(`Carpeta de armado: ${BASE}`);
  const programa = prepararPrograma();
  prepararServidor();
  const r = construir(programa);
  console.log('\n✔ Listo');
  console.log(`  Programa (carpeta): ${r.carpeta}`);
  if (r.instalador) {
    console.log(`  Instalador: ${r.instalador} (${mb(fs.statSync(r.instalador).size)})`);
    console.log(`  Archivos en dist-escritorio: ${r.copiados.join(', ')}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n✖ No se pudo armar el programa: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { sirveAlServidor };
