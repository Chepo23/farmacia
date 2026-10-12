// Respaldos automáticos de la base de esta computadora. Ventas, clientes, crédito y cortes viven
// solo aquí (cada farmacia tiene sus estadísticas), así que si el disco falla se pierden: cada día
// se guarda una copia y, si se configuró, otra en una carpeta extra (por ejemplo de OneDrive).
//
//   FARMACIA_RESPALDOS_DIR    carpeta de los respaldos (por defecto, "respaldos" junto a la base)
//   FARMACIA_RESPALDOS_EXTRA  carpeta adicional para una segunda copia (opcional)
//   FARMACIA_RESPALDOS_DIAS   cuántos respaldos diarios se conservan (30)
//   FARMACIA_RESPALDOS=0      apaga los respaldos automáticos
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CONSERVAR_DIARIOS = Math.max(3, Number(process.env.FARMACIA_RESPALDOS_DIAS) || 30);
const CONSERVAR_MANUALES = 20;
const PATRON = /^farmacia-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.db$/;

const estado = { ultimo: null, error: '', errorExtra: '', enCurso: null };

function carpeta() {
  if (process.env.FARMACIA_RESPALDOS_DIR) return path.resolve(process.env.FARMACIA_RESPALDOS_DIR);
  return path.join(path.dirname(path.resolve(db.name)), 'respaldos');
}

function carpetaExtra() {
  const extra = String(process.env.FARMACIA_RESPALDOS_EXTRA || '').trim();
  return extra ? path.resolve(extra) : '';
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

function fechaLocal(fecha = new Date()) {
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}`;
}

function horaLocal(fecha = new Date()) {
  return `${dosDigitos(fecha.getHours())}${dosDigitos(fecha.getMinutes())}${dosDigitos(fecha.getSeconds())}`;
}

function listar(dir = carpeta()) {
  let archivos = [];
  try {
    archivos = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return archivos
    .map((nombre) => {
      const coincide = nombre.match(PATRON);
      if (!coincide) return null;
      const info = fs.statSync(path.join(dir, nombre));
      return { nombre, fecha: coincide[1], manual: Boolean(coincide[2]), bytes: info.size, creado: info.mtime.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => (a.nombre < b.nombre ? 1 : -1));
}

// Borra los respaldos más viejos (los diarios y los manuales se cuentan por separado)
function limpiar(dir) {
  const todos = listar(dir);
  const sobran = [
    ...todos.filter((r) => !r.manual).slice(CONSERVAR_DIARIOS),
    ...todos.filter((r) => r.manual).slice(CONSERVAR_MANUALES),
  ];
  for (const r of sobran) {
    try { fs.unlinkSync(path.join(dir, r.nombre)); } catch { /* en uso o ya no existe */ }
  }
}

async function copiarSeguro(destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const temporal = `${destino}.parcial`;
  try { fs.unlinkSync(temporal); } catch { /* no había */ }
  // Copia en línea de SQLite: es consistente aunque se esté vendiendo en ese momento
  await db.backup(temporal);
  fs.renameSync(temporal, destino);
}

// manual = true: respaldo adicional con hora (botón "Respaldar ahora"); si no, el del día
async function respaldar({ manual = false } = {}) {
  if (estado.enCurso) return estado.enCurso;
  estado.enCurso = (async () => {
    const ahora = new Date();
    const nombre = manual ? `farmacia-${fechaLocal(ahora)}-${horaLocal(ahora)}.db` : `farmacia-${fechaLocal(ahora)}.db`;
    const dir = carpeta();
    try {
      await copiarSeguro(path.join(dir, nombre));
      limpiar(dir);
      estado.error = '';
    } catch (error) {
      estado.error = `No se pudo guardar el respaldo: ${error.message}`;
      throw error;
    }
    const extra = carpetaExtra();
    if (extra) {
      try {
        fs.mkdirSync(extra, { recursive: true });
        fs.copyFileSync(path.join(dir, nombre), path.join(extra, nombre));
        limpiar(extra);
        estado.errorExtra = '';
      } catch (error) {
        estado.errorExtra = `No se pudo copiar a la carpeta extra: ${error.message}`;
      }
    }
    estado.ultimo = { nombre, creado: ahora.toISOString() };
    return { nombre, carpeta: dir };
  })();
  try {
    return await estado.enCurso;
  } finally {
    estado.enCurso = null;
  }
}

// El respaldo del día se hace una vez (al abrir el sistema o en la primera revisión del día)
async function revisar() {
  if (process.env.FARMACIA_RESPALDOS === '0') return null;
  const hoy = fechaLocal();
  if (listar().some((r) => r.fecha === hoy && !r.manual)) return null;
  try {
    return await respaldar();
  } catch (error) {
    console.error(estado.error || error.message);
    return null;
  }
}

function resumen() {
  const lista = listar();
  return {
    activo: process.env.FARMACIA_RESPALDOS !== '0',
    carpeta: carpeta(),
    carpeta_extra: carpetaExtra(),
    conservar_dias: CONSERVAR_DIARIOS,
    ultimo: lista[0] || null,
    total: lista.length,
    respaldos: lista.slice(0, 40),
    error: estado.error,
    error_extra: estado.errorExtra,
  };
}

let temporizador = null;
function iniciar() {
  if (process.env.FARMACIA_RESPALDOS === '0' || temporizador) return;
  const primera = Number(process.env.FARMACIA_RESPALDO_INICIAL_MS) || 30000;
  setTimeout(revisar, primera).unref();
  temporizador = setInterval(revisar, 60 * 60 * 1000);
  temporizador.unref();
}

module.exports = { iniciar, respaldar, revisar, resumen, listar, carpeta, PATRON };
