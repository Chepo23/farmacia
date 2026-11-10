#!/usr/bin/env node
/**
 * Carga el catálogo de Eleventa (su base de datos .fdb) a la central.
 *
 *   node scripts/importar-eleventa.js --fdb "C:\ruta\base.fdb"             solo muestra qué haría
 *   node scripts/importar-eleventa.js --fdb "C:\ruta\base.fdb" --aplicar   lo carga
 *
 * Opciones:
 *   --desde AAAA-MM-DD   solo productos con movimientos de inventario desde ese día (por defecto, el
 *                        año anterior al movimiento más reciente del archivo)
 *   --eleventa <carpeta> donde está instalado Eleventa (de ahí se usa su isql.exe con su Firebird),
 *                        por defecto C:\Program Files (x86)\AbarrotesPDV
 *   --minimos <id>       sucursal que recibe los mínimos de Eleventa (por defecto, la central)
 *
 * Solo el catálogo: productos, precios y departamentos. La existencia queda en 0 en todas las
 * sucursales (cada una cuenta lo suyo). Los productos que ya existen en la central no se tocan, así que
 * se puede correr varias veces. Se lee una COPIA del archivo, nunca la base que Eleventa está usando.
 *
 * Por qué "con movimientos": en la base de Eleventa la marca "usa inventario" no siempre se conserva,
 * pero su historial de inventario sí dice qué productos se descontaban al vender. Los que no se movieron
 * en el periodo (no usaban inventario o ya no se venden) no se cargan.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ELEVENTA = 'C:\\Program Files (x86)\\AbarrotesPDV';
const LARGO_DESCRIPCION = 200;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------- Leer la base de Eleventa con su propio isql ----------
const CONSULTA_PRODUCTOS = `SELECT '#' || P.CODIGO || '|' || COALESCE(P.DESCRIPCION, '') || '|' || P.TVENTA
  || '|' || COALESCE(CAST(CAST(P.PCOSTO AS NUMERIC(18,4)) AS VARCHAR(30)), '')
  || '|' || COALESCE(CAST(CAST(P.PVENTA AS NUMERIC(18,4)) AS VARCHAR(30)), '')
  || '|' || COALESCE(CAST(CAST(P.MAYOREO AS NUMERIC(18,4)) AS VARCHAR(30)), '')
  || '|' || COALESCE(D.NOMBRE, '')
  || '|' || COALESCE(CAST(CAST(P.DINVMINIMO AS NUMERIC(18,4)) AS VARCHAR(30)), '')
  || '|' || COALESCE(CAST(P.CHECADO_EN AS VARCHAR(20)), '') || '#'
  FROM PRODUCTOS P LEFT JOIN DEPARTAMENTOS D ON D.ID = P.DEPT;`;
const CONSULTA_HISTORIAL = `SELECT '#' || H.ID || '|' || H.CODIGO_PRODUCTO || '|' || CAST(H.CUANDO_FUE AS VARCHAR(30)) || '|' || H.TIPO
  || '|' || COALESCE(CAST(CAST(H.HABIA AS NUMERIC(18,4)) AS VARCHAR(30)), '')
  || '|' || CAST(CAST(H.CANTIDAD AS NUMERIC(18,4)) AS VARCHAR(30)) || '#'
  FROM HISTORIAL_INVENTARIO H ORDER BY H.ID;`;

function exportarEleventa({ fdb, carpetaEleventa = ELEVENTA }) {
  const isql = path.join(carpetaEleventa, 'isql.exe');
  if (!fs.existsSync(isql)) throw new Error(`No se encontró Eleventa en ${carpetaEleventa} (falta isql.exe). Indícalo con --eleventa`);
  if (!fs.existsSync(fdb)) throw new Error(`No existe el archivo ${fdb}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eleventa-'));
  try {
    // Una copia: el Firebird de Eleventa puede escribir en el archivo que abre
    const copia = path.join(dir, 'base.fdb');
    fs.copyFileSync(fdb, copia);
    const productos = path.join(dir, 'productos.txt');
    const historial = path.join(dir, 'historial.txt');
    const guion = path.join(dir, 'exportar.sql');
    fs.writeFileSync(guion, [
      'SET HEADING OFF;',
      `OUTPUT '${productos}';`, CONSULTA_PRODUCTOS,
      `OUTPUT '${historial}';`, CONSULTA_HISTORIAL,
      'OUTPUT;', 'EXIT;', '',
    ].join('\n'));
    const r = spawnSync(isql, ['-u', 'SYSDBA', '-p', 'masterkey', '-i', guion, copia], { cwd: carpetaEleventa, encoding: 'latin1', timeout: 10 * 60000 });
    if (r.status !== 0 || !fs.existsSync(productos)) throw new Error(`Eleventa no pudo leer el archivo: ${r.stderr || r.stdout || r.error}`);
    return {
      productosTexto: fs.readFileSync(productos).toString('latin1'),
      historialTexto: fs.existsSync(historial) ? fs.readFileSync(historial).toString('latin1') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Interpretar lo exportado ----------
// Cada renglón viene como "#campo|campo|...#" (isql rellena con espacios)
function renglones(texto) {
  return String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 1 && l.startsWith('#') && l.endsWith('#'))
    .map((l) => l.slice(1, -1).split('|'));
}

const numero = (texto) => {
  const n = Number(String(texto || '').trim());
  return Number.isFinite(n) ? n : 0;
};

// Lo que quedó después de cada movimiento: "a" = ajuste (fija), "s" = salida, "e"/"d" = entrada/devolución
function existenciaDespues(tipo, habia, cantidad) {
  if (tipo === 'a') return cantidad;
  if (tipo === 's') return habia - cantidad;
  return habia + cantidad;
}

function leerExportacion({ productosTexto, historialTexto }) {
  const ultimo = new Map(); // código -> { id, fecha, existencia }
  for (const campos of renglones(historialTexto)) {
    if (campos.length !== 6) continue;
    // El código tal cual (un código con espacios es otro producto en Eleventa)
    const codigo = campos[1];
    const [id, , fecha, tipo, habia, cantidad] = campos.map((c) => c.trim());
    const previo = ultimo.get(codigo);
    if (previo && previo.id > Number(id)) continue;
    ultimo.set(codigo, { id: Number(id), fecha: fecha.slice(0, 10), existencia: existenciaDespues(tipo, numero(habia), numero(cantidad)) });
  }
  const productos = [];
  for (const campos of renglones(productosTexto)) {
    if (campos.length < 9) continue;
    const codigoOriginal = campos[0];
    const resto = campos.slice(-7); // tventa, costo, venta, mayoreo, departamento, mínimo, checado
    const descripcion = campos.slice(1, campos.length - 7).join('|');
    const movimiento = ultimo.get(codigoOriginal) || null;
    productos.push({
      codigo: codigoOriginal.trim(),
      codigo_limpio: codigoOriginal === codigoOriginal.trim(),
      descripcion: descripcion.trim().replace(/\s+/g, ' '),
      costo: r2(numero(resto[1])),
      venta: r2(numero(resto[2])),
      mayoreo: r2(numero(resto[3])),
      departamento: resto[4].trim(),
      minimo: Math.max(0, numero(resto[5])),
      ultimo_movimiento: movimiento ? movimiento.fecha : null,
      existencia_eleventa: movimiento ? r2(movimiento.existencia) : null,
    });
  }
  return productos;
}

// El año anterior al movimiento más reciente del archivo
function desdePorDefecto(productos) {
  const ultima = productos.map((p) => p.ultimo_movimiento).filter(Boolean).sort().at(-1);
  if (!ultima) return null;
  const fecha = new Date(`${ultima}T12:00:00Z`);
  fecha.setUTCFullYear(fecha.getUTCFullYear() - 1);
  return fecha.toISOString().slice(0, 10);
}

// Productos que se cargan: con movimientos desde "desde", con código y precio; si un código se repite
// (por ejemplo, con un espacio de más), se queda el que se movió más recientemente
function seleccionar(productos, { desde }) {
  const porCodigo = new Map();
  const descartados = { sin_movimientos: 0, sin_codigo: 0, sin_precio: 0, repetidos: 0 };
  for (const p of productos) {
    if (!p.codigo) { descartados.sin_codigo += 1; continue; }
    if (!p.ultimo_movimiento || (desde && p.ultimo_movimiento < desde)) { descartados.sin_movimientos += 1; continue; }
    if (!(p.venta > 0)) { descartados.sin_precio += 1; continue; }
    const previo = porCodigo.get(p.codigo);
    if (previo) {
      descartados.repetidos += 1;
      if (previo.ultimo_movimiento > p.ultimo_movimiento) continue;
      if (previo.ultimo_movimiento === p.ultimo_movimiento && (previo.codigo_limpio || !p.codigo_limpio)) continue;
    }
    porCodigo.set(p.codigo, p);
  }
  return { productos: [...porCodigo.values()], descartados };
}

// Como se guarda en la central (mismas reglas que el formulario de producto)
function paraCentral(p) {
  return {
    codigo_barras: p.codigo,
    descripcion: p.descripcion.slice(0, LARGO_DESCRIPCION) || p.codigo,
    departamento: p.departamento,
    precio_costo: Math.max(0, r2(p.costo)),
    precio_venta: r2(p.venta),
    // En Eleventa un mayoreo igual o mayor al precio no es mayoreo
    precio_mayoreo: p.mayoreo > 0 && p.mayoreo < p.venta ? r2(p.mayoreo) : null,
    cantidad_mayoreo: null, // solo con F11, como en Eleventa
    usa_inventario: true,
    activo: true,
  };
}

// ---------- Cargar en la central ----------
async function consultar(builder) {
  const r = await builder;
  if (r.error) throw new Error(r.error.message);
  return r;
}

async function todas(construir) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data } = await consultar(construir().range(desde, desde + 999));
    filas.push(...(data || []));
    if (!data || data.length < 1000) return filas;
  }
}

function lotes(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

async function cargarEnCentral(supabase, productos, { minimosSucursalId = null, desde = null, aplicar = false, alAvanzar = () => {} } = {}) {
  const sb = () => supabase;
  const existentes = new Set((await todas(() => sb().from('productos').select('codigo_barras').order('id'))).map((p) => p.codigo_barras));
  const nuevos = productos.filter((p) => !existentes.has(p.codigo));
  const departamentosCentral = new Set((await todas(() => sb().from('departamentos').select('nombre').order('id'))).map((d) => d.nombre));
  const departamentosNuevos = [...new Set(nuevos.map((p) => p.departamento).filter(Boolean))].filter((d) => !departamentosCentral.has(d)).sort();
  const sucursales = (await consultar(sb().from('sucursales').select('id,nombre,es_central').eq('activa', true).order('id'))).data || [];
  const minimos = Number(minimosSucursalId) || Number((sucursales.find((s) => s.es_central) || {}).id) || null;
  const resumen = {
    ya_estaban: productos.length - nuevos.length,
    productos_nuevos: nuevos.length,
    departamentos_nuevos: departamentosNuevos.length,
    sucursales: sucursales.map((s) => s.nombre),
    minimos_en: (sucursales.find((s) => Number(s.id) === minimos) || {}).nombre || null,
  };
  if (!aplicar) return resumen;

  if (departamentosNuevos.length) {
    await consultar(sb().from('departamentos').upsert(departamentosNuevos.map((nombre) => ({ nombre, activo: true })), { onConflict: 'nombre', ignoreDuplicates: true }));
  }
  const ids = new Map();
  for (const lote of lotes(nuevos, 400)) {
    const { data } = await consultar(sb().from('productos').upsert(lote.map(paraCentral), { onConflict: 'codigo_barras', ignoreDuplicates: true }).select('id,codigo_barras'));
    for (const f of data || []) ids.set(f.codigo_barras, Number(f.id));
    alAvanzar(`productos ${ids.size} de ${nuevos.length}`);
  }
  // Existencia en 0 en todas las sucursales (así entran al inventario del día y a los reportes);
  // los mínimos de Eleventa solo en la sucursal de donde vienen
  const filas = [];
  for (const p of nuevos) {
    const id = ids.get(p.codigo);
    if (!id) continue;
    for (const s of sucursales) {
      filas.push({ producto_id: id, sucursal_id: Number(s.id), existencia: 0, minimo: Number(s.id) === minimos ? r2(p.minimo) : 0 });
    }
  }
  let hechas = 0;
  for (const lote of lotes(filas, 1000)) {
    await consultar(sb().from('inventario').upsert(lote, { onConflict: 'producto_id,sucursal_id', ignoreDuplicates: true }));
    hechas += lote.length;
    alAvanzar(`existencias ${hechas} de ${filas.length}`);
  }
  // Queda en el registro de cambios del jefe (si la central ya tiene la tabla)
  await sb().from('bitacora').insert({
    clave: crypto.randomUUID(), tipo: 'producto_alta', origen: 'importación',
    descripcion: `Catálogo cargado desde Eleventa: ${ids.size} productos${desde ? ` (con movimientos desde ${desde})` : ''}, existencia en 0`,
    detalle: { productos: ids.size, departamentos: departamentosNuevos.length, desde },
  }).then(() => {}, () => {});
  return { ...resumen, productos_cargados: ids.size, existencias: filas.length };
}

// Respaldo de lo que se va a tocar, por si hay que regresar
async function respaldar(supabase, archivo) {
  const datos = {};
  for (const tabla of ['departamentos', 'productos', 'inventario', 'sucursales']) {
    datos[tabla] = await todas(() => supabase.from(tabla).select('*').order('id'));
  }
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify({ fecha: new Date().toISOString(), ...datos }, null, 1));
  return Object.fromEntries(Object.entries(datos).map(([t, f]) => [t, f.length]));
}

async function main() {
  const fdb = argumento('fdb');
  if (!fdb) throw new Error('Indica el archivo de Eleventa: --fdb "C:\\ruta\\base.fdb"');
  const aplicar = process.argv.includes('--aplicar');
  console.log('Leyendo la base de Eleventa…');
  const productos = leerExportacion(exportarEleventa({ fdb, carpetaEleventa: argumento('eleventa') || ELEVENTA }));
  const desde = argumento('desde') || desdePorDefecto(productos);
  const seleccion = seleccionar(productos, { desde });
  console.log(`Productos en Eleventa: ${productos.length}`);
  console.log(`Con movimientos de inventario desde ${desde}: ${seleccion.productos.length}`);
  console.log('No se cargan:', seleccion.descartados);

  require('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });
  const url = process.env.SUPABASE_URL;
  const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !llave) throw new Error('Falta SUPABASE_URL o la llave en el .env');
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, llave, { auth: { persistSession: false, autoRefreshToken: false } });

  if (aplicar) {
    const archivo = path.join(REPO, 'respaldos', `central-antes-de-cargar-catalogo-${new Date().toISOString().slice(0, 10)}.json`);
    console.log('Respaldo de la central:', await respaldar(supabase, archivo), '→', path.relative(REPO, archivo));
  }
  const r = await cargarEnCentral(supabase, seleccion.productos, {
    minimosSucursalId: argumento('minimos'), desde, aplicar, alAvanzar: (t) => process.stdout.write(`  ${t}\r`),
  });
  console.log(aplicar ? '\nListo:' : '\nAsí quedaría (para cargarlo agrega --aplicar):', r);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`No se pudo cargar el catálogo: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { leerExportacion, seleccionar, desdePorDefecto, paraCentral, cargarEnCentral, existenciaDespues };
