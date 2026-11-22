'use strict';
// Copia diaria de la base central en esta computadora (además del respaldo de su propia base).
//
// En la central (Supabase) viven el inventario de todas las farmacias, los productos, los conteos,
// los apoyos, los préstamos, las ventas que suben las cajas y el registro de cambios del jefe. Cada
// computadora lleva un "espejo" de esas tablas (respaldos/central/espejo.db) y una vez al día guarda
// una copia comprimida con la fecha (respaldos/central/central-AAAA-MM-DD.db.gz); se conservan 30.
// Así, si algo se borra o se daña en la central, hay de dónde recuperarlo, y la información queda
// también en las computadoras de la farmacia.
//
// Para no gastar el límite de transferencia de la central, cada vez solo se baja lo que cambió:
//   - completa: tablas chicas (sucursales, usuarios, documentos): enteras;
//   - cambios: productos y existencias: solo lo que cambió desde la copia anterior (cada cambio guarda
//     su hora), y enteras una vez por semana por si algo se escapó;
//   - nuevos: tablas que solo crecen (movimientos, registro de cambios): los renglones nuevos;
//   - recientes: ventas, abonos y cortes: los nuevos y los de los últimos días (una venta se cancela);
//   - hijos: renglones de un documento: los nuevos y los de documentos que cambiaron o siguen abiertos.
//
//   FARMACIA_COPIA_CENTRAL=0   apaga la copia de la central en esta computadora
//   FARMACIA_RESPALDOS_DIAS    cuántas copias diarias se conservan (30), igual que los respaldos
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const { modoCentral, consultar, sb } = require('./central');

const LOTE = 1000;               // renglones por consulta (el máximo que entrega la central)
const LOTE_IDS = 100;            // documentos por consulta al bajar sus renglones
// Los últimos renglones se vuelven a pedir por si alguno se guardó tarde en la central
const TRASLAPE = process.env.FARMACIA_COPIA_TRASLAPE != null ? Math.max(0, Number(process.env.FARMACIA_COPIA_TRASLAPE) || 0) : 500;
const DIAS_RECIENTES = 3;
const DIAS_COMPLETA = 7;         // las tablas "cambios" se bajan enteras cada semana
const CONSERVAR = Math.max(3, Number(process.env.FARMACIA_RESPALDOS_DIAS) || 30);
const PATRON = /^central-(\d{4}-\d{2}-\d{2})\.db\.gz$/;
// Estados con los que un documento ya no cambia (sus renglones tampoco)
const FINALES = new Set(['cerrado', 'cancelado', 'recibido', 'surtido', 'vendida', 'cancelada']);

// En orden: primero las tablas de las que dependen las demás (así también se restauran)
const TABLAS = [
  { tabla: 'sucursales', modo: 'completa' },
  { tabla: 'departamentos', modo: 'completa' },
  { tabla: 'usuarios_central', modo: 'completa', quitar: ['password_hash'] },
  { tabla: 'cajas', modo: 'completa' },
  { tabla: 'productos', modo: 'cambios' },
  { tabla: 'inventario', modo: 'cambios' },
  { tabla: 'conteo_config', modo: 'completa', llave: ['sucursal_id'] },
  { tabla: 'conteo_lista', modo: 'completa', llave: ['sucursal_id', 'producto_id'] },
  { tabla: 'conteo_importantes', modo: 'completa', llave: ['producto_id'] },
  { tabla: 'conteo_ultimos', modo: 'completa', llave: ['sucursal_id', 'producto_id'] },
  { tabla: 'clientes', modo: 'completa' },
  { tabla: 'prestamos', modo: 'completa' },
  { tabla: 'pedidos', modo: 'completa' },
  { tabla: 'apoyos', modo: 'completa' },
  { tabla: 'cotizaciones', modo: 'completa' },
  { tabla: 'conteos', modo: 'completa' },
  { tabla: 'movimientos_inventario', modo: 'nuevos' },
  { tabla: 'bitacora', modo: 'nuevos' },
  { tabla: 'ventas', modo: 'recientes', fecha: 'updated_at' },
  { tabla: 'abonos', modo: 'recientes', fecha: 'fecha' },
  { tabla: 'cortes', modo: 'recientes', fecha: 'fecha' },
  { tabla: 'venta_detalle', modo: 'hijos', padre: 'ventas', columna: 'venta_id' },
  { tabla: 'conteo_detalle', modo: 'hijos', padre: 'conteos', columna: 'conteo_id' },
  { tabla: 'apoyo_detalle', modo: 'hijos', padre: 'apoyos', columna: 'apoyo_id' },
  { tabla: 'pedido_detalle', modo: 'hijos', padre: 'pedidos', columna: 'pedido_id' },
  { tabla: 'cotizacion_detalle', modo: 'hijos', padre: 'cotizaciones', columna: 'cotizacion_id' },
];

const estado = { enCurso: null, error: '', errorExtra: '', ultimo: null };

// La carpeta de los respaldos de esta computadora (se pide al usarla: respaldos.js también usa este módulo)
function carpetaBase() {
  return require('./respaldos').carpeta();
}
function carpeta(base = carpetaBase()) {
  return path.join(base, 'central');
}
function carpetaExtra() {
  const extra = require('./respaldos').carpetaExtra();
  return extra ? path.join(extra, 'central') : '';
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}
function fechaLocal(fecha = new Date()) {
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}`;
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
      return { nombre, fecha: coincide[1], bytes: info.size, creado: info.mtime.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => (a.nombre < b.nombre ? 1 : -1));
}

function limpiar(dir) {
  for (const r of listar(dir).slice(CONSERVAR)) {
    try { fs.unlinkSync(path.join(dir, r.nombre)); } catch { /* en uso o ya no existe */ }
  }
}

// ---------- El espejo ----------
function abrirEspejo(archivo) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const espejo = new Database(archivo);
  espejo.pragma('journal_mode = DELETE');
  espejo.exec(`
    CREATE TABLE IF NOT EXISTS filas (
      tabla TEXT NOT NULL, clave TEXT NOT NULL, datos TEXT NOT NULL, PRIMARY KEY (tabla, clave));
    CREATE TABLE IF NOT EXISTS tablas (
      tabla TEXT PRIMARY KEY, filas INTEGER NOT NULL DEFAULT 0, max_id INTEGER NOT NULL DEFAULT 0,
      actualizada TEXT, nota TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS info (clave TEXT PRIMARY KEY, valor TEXT);
  `);
  return espejo;
}

const claveDe = (def, fila) => (def.llave ? def.llave.map((c) => fila[c]).join(':') : String(fila.id));

function limpiarFila(def, fila) {
  if (!def.quitar) return fila;
  const copia = { ...fila };
  for (const c of def.quitar) delete copia[c];
  return copia;
}

// Baja de la central los renglones de una tabla, por páginas. Con "desde", solo los de id mayor.
async function bajar(def, { desde = null, filtro = (q) => q } = {}) {
  const filas = [];
  if (def.llave) {
    for (let pagina = 0; ; pagina += 1) {
      let q = filtro(sb().from(def.tabla).select('*'));
      for (const c of def.llave) q = q.order(c);
      const { data } = await consultar(q.range(pagina * LOTE, pagina * LOTE + LOTE - 1));
      filas.push(...(data || []));
      if (!data || data.length < LOTE) break;
    }
    return filas;
  }
  let ultimo = desde;
  for (;;) {
    let q = filtro(sb().from(def.tabla).select('*'));
    if (ultimo != null) q = q.gt('id', ultimo);
    const { data } = await consultar(q.order('id').limit(LOTE));
    filas.push(...(data || []));
    if (!data || data.length < LOTE) break;
    ultimo = data[data.length - 1].id;
  }
  return filas;
}

const noExisteLaTabla = (error) => /42P01|PGRST205|does not exist|Could not find the table|no such table/i
  .test(`${error.codigo || ''} ${error.message || ''}`);

function filasDelEspejo(espejo, tabla) {
  const mapa = new Map();
  for (const r of espejo.prepare('SELECT clave, datos FROM filas WHERE tabla = ?').iterate(tabla)) mapa.set(r.clave, r.datos);
  return mapa;
}

// Sincroniza una tabla del espejo con la central. Devuelve cuántos renglones bajó y, para las tablas
// que tienen renglones (documentos), cuáles cambiaron o siguen abiertos y cuáles ya no existen.
async function sincronizarTabla(espejo, def, contexto) {
  const info = espejo.prepare('SELECT * FROM tablas WHERE tabla = ?').get(def.tabla) || { max_id: 0 };
  const guardar = espejo.prepare('INSERT INTO filas (tabla, clave, datos) VALUES (?, ?, ?) ON CONFLICT(tabla, clave) DO UPDATE SET datos = excluded.datos');
  const ahora = new Date().toISOString();
  let bajadas = [];
  const resultado = { cambiados: new Set(), abiertos: new Set(), borrados: new Set() };
  const marcaCompleta = espejo.prepare('SELECT valor FROM info WHERE clave = ?').get(`completa:${def.tabla}`);
  const tocaCompleta = def.modo === 'cambios'
    && (!marcaCompleta || !contexto.ultimaCopia || Date.now() - new Date(marcaCompleta.valor).getTime() > DIAS_COMPLETA * 86400000);

  if (def.modo === 'completa' || tocaCompleta) {
    bajadas = (await bajar(def)).map((f) => limpiarFila(def, f));
    const antes = filasDelEspejo(espejo, def.tabla);
    const nuevas = new Map(bajadas.map((f) => [claveDe(def, f), JSON.stringify(f)]));
    for (const [clave, datos] of nuevas) {
      if (antes.has(clave) && antes.get(clave) !== datos) resultado.cambiados.add(clave);
    }
    for (const clave of antes.keys()) if (!nuevas.has(clave)) resultado.borrados.add(clave);
    for (const f of bajadas) if (f.estado && !FINALES.has(f.estado)) resultado.abiertos.add(claveDe(def, f));
    espejo.transaction(() => {
      espejo.prepare('DELETE FROM filas WHERE tabla = ?').run(def.tabla);
      for (const [clave, datos] of nuevas) guardar.run(def.tabla, clave, datos);
      if (tocaCompleta) {
        espejo.prepare('INSERT INTO info (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
          .run(`completa:${def.tabla}`, ahora);
      }
    })();
  } else if (def.modo === 'cambios') {
    // Lo que cambió desde un día antes de la copia anterior (por si el reloj de alguna computadora va atrasado)
    const desde = new Date(contexto.ultimaCopia - 86400000).toISOString();
    bajadas = (await bajar(def, { filtro: (q) => q.or(`id.gt.${Math.max(0, info.max_id - TRASLAPE)},updated_at.gte."${desde}"`) }))
      .map((f) => limpiarFila(def, f));
    espejo.transaction(() => {
      for (const f of bajadas) guardar.run(def.tabla, claveDe(def, f), JSON.stringify(f));
    })();
  } else if (def.modo === 'nuevos') {
    bajadas = await bajar(def, { desde: Math.max(0, info.max_id - TRASLAPE) });
    espejo.transaction(() => {
      for (const f of bajadas) guardar.run(def.tabla, claveDe(def, f), JSON.stringify(f));
    })();
  } else if (def.modo === 'recientes') {
    const desde = new Date(Math.min(Date.now() - DIAS_RECIENTES * 86400000, contexto.ultimaCopia - 86400000)).toISOString();
    bajadas = await bajar(def, { filtro: (q) => q.or(`id.gt.${Math.max(0, info.max_id - TRASLAPE)},${def.fecha}.gte."${desde}"`) });
    const antes = filasDelEspejo(espejo, def.tabla);
    espejo.transaction(() => {
      for (const f of bajadas) {
        const clave = claveDe(def, f);
        const datos = JSON.stringify(f);
        if (antes.has(clave) && antes.get(clave) !== datos) resultado.cambiados.add(clave);
        guardar.run(def.tabla, clave, datos);
      }
    })();
  } else if (def.modo === 'hijos') {
    const padre = contexto.porTabla.get(def.padre) || { cambiados: new Set(), abiertos: new Set(), borrados: new Set() };
    const releer = [...new Set([...padre.cambiados, ...padre.abiertos])].map(Number).filter((n) => Number.isFinite(n));
    const nuevos = await bajar(def, { desde: Math.max(0, info.max_id - TRASLAPE) });
    const deDocumentos = [];
    for (let i = 0; i < releer.length; i += LOTE_IDS) {
      const lote = releer.slice(i, i + LOTE_IDS);
      deDocumentos.push(...await bajar(def, { filtro: (q) => q.in(def.columna, lote) }));
    }
    bajadas = [...nuevos, ...deDocumentos];
    const quitar = espejo.prepare(`DELETE FROM filas WHERE tabla = ? AND CAST(json_extract(datos, '$.${def.columna}') AS TEXT) = ?`);
    espejo.transaction(() => {
      // Los documentos que se releyeron y los que ya no existen se reemplazan completos
      for (const id of [...releer.map(String), ...padre.borrados]) quitar.run(def.tabla, String(id));
      for (const f of bajadas) guardar.run(def.tabla, claveDe(def, f), JSON.stringify(f));
    })();
  }

  const maximo = def.llave ? 0 : bajadas.reduce((m, f) => Math.max(m, Number(f.id) || 0), info.max_id || 0);
  const total = espejo.prepare('SELECT COUNT(*) AS n FROM filas WHERE tabla = ?').get(def.tabla).n;
  espejo.prepare(`INSERT INTO tablas (tabla, filas, max_id, actualizada, nota) VALUES (?, ?, ?, ?, '')
    ON CONFLICT(tabla) DO UPDATE SET filas = excluded.filas, max_id = excluded.max_id, actualizada = excluded.actualizada, nota = ''`)
    .run(def.tabla, total, maximo, ahora);
  contexto.porTabla.set(def.tabla, resultado);
  return bajadas.length;
}

async function sincronizar(espejo) {
  const ultima = espejo.prepare("SELECT valor FROM info WHERE clave = 'ultima_copia'").get();
  const contexto = { porTabla: new Map(), ultimaCopia: ultima ? new Date(ultima.valor).getTime() || 0 : 0 };
  let renglones = 0;
  const faltan = [];
  for (const def of TABLAS) {
    try {
      renglones += await sincronizarTabla(espejo, def, contexto);
    } catch (error) {
      // Una central que todavía no tiene una tabla nueva no impide copiar lo demás
      if (!noExisteLaTabla(error)) throw error;
      faltan.push(def.tabla);
      espejo.prepare(`INSERT INTO tablas (tabla, nota) VALUES (?, 'No existe en la central')
        ON CONFLICT(tabla) DO UPDATE SET nota = excluded.nota`).run(def.tabla);
    }
  }
  const ahora = new Date().toISOString();
  const guardarInfo = espejo.prepare('INSERT INTO info (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  guardarInfo.run('ultima_copia', ahora);
  guardarInfo.run('version', '1');
  return { renglones, faltan };
}

// Guarda el espejo comprimido como la copia del día
async function guardarCopia(espejo, dir, nombre) {
  const temporal = path.join(dir, `${nombre}.tmp.db`);
  const parcial = path.join(dir, `${nombre}.parcial`);
  for (const f of [temporal, parcial]) { try { fs.unlinkSync(f); } catch { /* no había */ } }
  await espejo.backup(temporal);
  try {
    await pipeline(fs.createReadStream(temporal), zlib.createGzip({ level: 6 }), fs.createWriteStream(parcial));
    fs.renameSync(parcial, path.join(dir, nombre));
  } finally {
    try { fs.unlinkSync(temporal); } catch { /* ya no está */ }
  }
}

async function copiar() {
  if (estado.enCurso) return estado.enCurso;
  estado.enCurso = (async () => {
    if (!modoCentral()) throw new Error('Esta computadora no está conectada a una base central');
    const dir = carpeta();
    const inicio = Date.now();
    let espejo;
    try {
      espejo = abrirEspejo(path.join(dir, 'espejo.db'));
      const { renglones, faltan } = await sincronizar(espejo);
      const nombre = `central-${fechaLocal()}.db.gz`;
      await guardarCopia(espejo, dir, nombre);
      limpiar(dir);
      estado.error = '';
      const extra = carpetaExtra();
      if (extra) {
        try {
          fs.mkdirSync(extra, { recursive: true });
          fs.copyFileSync(path.join(dir, nombre), path.join(extra, nombre));
          limpiar(extra);
          estado.errorExtra = '';
        } catch (error) {
          estado.errorExtra = `No se pudo copiar la central a la carpeta extra: ${error.message}`;
        }
      }
      estado.ultimo = { nombre, creado: new Date().toISOString(), renglones_bajados: renglones, segundos: Math.round((Date.now() - inicio) / 100) / 10, faltan };
      return { ...estado.ultimo, carpeta: dir };
    } catch (error) {
      estado.error = `No se pudo copiar la central: ${error.message}`;
      throw error;
    } finally {
      if (espejo) espejo.close();
    }
  })();
  try {
    return await estado.enCurso;
  } finally {
    estado.enCurso = null;
  }
}

// Una vez al día (al abrir el sistema o en la primera revisión del día con internet)
async function revisar() {
  if (process.env.FARMACIA_COPIA_CENTRAL === '0' || !modoCentral()) return null;
  const hoy = fechaLocal();
  if (listar().some((r) => r.fecha === hoy)) return null;
  try {
    return await copiar();
  } catch (error) {
    console.error(estado.error || error.message);
    return null;
  }
}

function resumen() {
  const lista = listar();
  return {
    activo: process.env.FARMACIA_COPIA_CENTRAL !== '0' && modoCentral(),
    carpeta: carpeta(),
    conservar_dias: CONSERVAR,
    ultima: lista[0] || null,
    total: lista.length,
    copias: lista.slice(0, 40),
    ultimo_resultado: estado.ultimo,
    en_curso: Boolean(estado.enCurso),
    error: estado.error,
    error_extra: estado.errorExtra,
  };
}

module.exports = { copiar, revisar, resumen, listar, carpeta, abrirEspejo, bajarTabla: bajar, limpiarFila, claveDe, TABLAS, PATRON };
