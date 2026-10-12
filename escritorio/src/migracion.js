// Traer los datos del sistema anterior (la carpeta donde se corría "npm start"): la base de datos
// farmacia.db (ventas, clientes, cortes…) y, si existe, la conexión a Supabase de su archivo .env.
const fs = require('fs');
const path = require('path');

// Lee un .env sencillo (CLAVE=valor); los valores no se muestran, solo se usan para llenar la configuración
function leerEnv(texto) {
  const valores = {};
  for (const linea of String(texto).split(/\r?\n/)) {
    const coincide = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!coincide) continue;
    let valor = coincide[2].trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) valor = valor.slice(1, -1);
    valores[coincide[1].toUpperCase()] = valor;
  }
  return valores;
}

function infoArchivo(ruta) {
  try {
    const info = fs.statSync(ruta);
    return info.isFile() ? { ruta, bytes: info.size, modificado: info.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

// Un archivo SQLite empieza con "SQLite format 3"
function esSqlite(ruta) {
  try {
    const descriptor = fs.openSync(ruta, 'r');
    const cabecera = Buffer.alloc(16);
    fs.readSync(descriptor, cabecera, 0, 16, 0);
    fs.closeSync(descriptor);
    return cabecera.toString('latin1').startsWith('SQLite format 3');
  } catch {
    return false;
  }
}

// carpeta: la del sistema anterior; o archivo: directamente un farmacia.db
function examinar({ carpeta = '', archivo = '' } = {}) {
  let env = {};
  let base = null;
  if (carpeta) {
    const rutaEnv = path.join(carpeta, '.env');
    if (fs.existsSync(rutaEnv)) env = leerEnv(fs.readFileSync(rutaEnv, 'utf8'));
    const relativa = env.FARMACIA_DB || './farmacia.db';
    base = infoArchivo(path.resolve(carpeta, relativa));
  } else if (archivo) {
    base = infoArchivo(archivo);
  }
  if (base && !esSqlite(base.ruta)) base = null;
  const llave = env.SUPABASE_SERVICE_ROLE_KEY || '';
  return {
    carpeta,
    base,
    supabaseUrl: env.SUPABASE_URL || '',
    llave, // no se manda a la pantalla (ver main.js)
    tieneLlave: Boolean(llave && !/REEMPLAZA/i.test(llave)),
    puerto: Number(env.PORT) || 3000,
    urlMovil: env.MOVIL_URL || '',
    encontrado: Boolean(base || env.SUPABASE_URL),
  };
}

// ¿El sistema anterior sigue abierto? (si responde en su puerto, no se debe copiar su base)
async function sistemaAbierto(puerto) {
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/api/sync/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

function sello() {
  const d = new Date();
  const dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}`;
}

// Copia la base anterior (con sus archivos -wal y -shm) a la carpeta de datos del programa.
// Si ya había una base ahí, se aparta con otro nombre para no perder nada.
function importarBase(origen, destino) {
  if (!esSqlite(origen)) throw new Error('El archivo elegido no es una base de datos del sistema');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  if (path.resolve(origen) === path.resolve(destino)) return { apartada: null };
  let apartada = null;
  if (fs.existsSync(destino)) {
    apartada = destino.replace(/\.db$/i, `-antes-de-importar-${sello()}.db`);
    for (const extra of ['', '-wal', '-shm']) {
      if (fs.existsSync(destino + extra)) fs.renameSync(destino + extra, apartada + extra);
    }
  }
  for (const extra of ['-wal', '-shm']) {
    try { fs.unlinkSync(destino + extra); } catch { /* no había */ }
  }
  fs.copyFileSync(origen, destino);
  for (const extra of ['-wal', '-shm']) {
    if (fs.existsSync(origen + extra)) fs.copyFileSync(origen + extra, destino + extra);
  }
  return { apartada };
}

module.exports = { leerEnv, examinar, sistemaAbierto, importarBase, esSqlite };
