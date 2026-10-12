'use strict';
/**
 * Utilidades de directorios temporales para el arnés E2E.
 *
 * Todo lo que crea el arnés (bases SQLite de cada computadora, directorio de trabajo de cada
 * server.js, base de la central falsa) vive FUERA del repositorio, en:
 *   - process.env.FARMACIA_E2E_TMP, si está definida, o
 *   - el directorio temporal del sistema (os.tmpdir()).
 *
 * Variables de entorno útiles:
 *   FARMACIA_E2E_TMP=<dir>     cambia el directorio base de temporales.
 *   FARMACIA_E2E_CONSERVAR=1   no borra los temporales al cerrar (para inspeccionar las bases).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Raíz del repositorio (tests/helpers/ -> ../../)
const REPO = path.resolve(__dirname, '..', '..');

/** true si `hijo` es `padre` o está dentro de él. */
function dentroDe(padre, hijo) {
  const relativo = path.relative(path.resolve(padre), path.resolve(hijo));
  return relativo === '' || (!relativo.startsWith('..') && !path.isAbsolute(relativo));
}

/** Directorio base donde se crean los temporales (nunca dentro del repo). */
function directorioBase() {
  const base = path.resolve(process.env.FARMACIA_E2E_TMP || os.tmpdir());
  if (dentroDe(REPO, base)) {
    throw new Error(`El directorio temporal del arnés (${base}) no puede estar dentro del repositorio`);
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** Crea un directorio temporal nuevo y vacío: <base>/farmacia-e2e-<prefijo>-XXXXXX */
function crearDirTemporal(prefijo = 'tmp') {
  const limpio = String(prefijo).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'tmp';
  return fs.mkdtempSync(path.join(directorioBase(), `farmacia-e2e-${limpio}-`));
}

function conservarTemporales() {
  return process.env.FARMACIA_E2E_CONSERVAR === '1';
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Borra un directorio temporal del arnés. En Windows los archivos SQLite pueden quedar
 * bloqueados unos milisegundos después de que el proceso termina, por eso se reintenta.
 */
async function borrarDir(dir) {
  if (!dir || conservarTemporales() || !fs.existsSync(dir)) return;
  if (dentroDe(REPO, dir)) throw new Error(`Se negó a borrar ${dir}: está dentro del repositorio`);
  for (let intento = 0; ; intento++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error.code) || intento >= 30) throw error;
      await esperar(100);
    }
  }
}

module.exports = { REPO, dentroDe, directorioBase, crearDirTemporal, borrarDir, conservarTemporales, esperar };
