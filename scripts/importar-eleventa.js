#!/usr/bin/env node
/**
 * Pasa a la central lo de Eleventa (su base de datos .fdb). Sin --aplicar solo muestra qué haría.
 *
 *   node scripts/importar-eleventa.js --fdb "C:\ruta\base.fdb" [--aplicar]
 *       catálogo: productos, precios y departamentos (existencia en 0 en todas las sucursales)
 *   node scripts/importar-eleventa.js --fdb "C:\ruta\base.fdb" --departamentos [--aplicar]
 *       deja los departamentos igual que en Eleventa: agrega los activos que falten, desactiva los que
 *       Eleventa tiene borrados (sus productos quedan sin departamento) y junta los repetidos por
 *       escritura ("HIGIENE Y BELLEZA" y "higiene  y belleza" son el mismo)
 *   node scripts/importar-eleventa.js --fdb "C:\ruta\base.fdb" --existencias <sucursal> [--aplicar]
 *       carga la existencia de esa farmacia según Eleventa (lo que quedó después de su último
 *       movimiento; lo negativo queda en 0). Usa el archivo de Eleventa DE ESA FARMACIA.
 *
 * Opciones:
 *   --desde AAAA-MM-DD   solo productos con movimientos de inventario desde ese día (por defecto, el
 *                        año anterior al movimiento más reciente del archivo)
 *   --eleventa <carpeta> donde está instalado Eleventa (de ahí se usa su isql.exe con su Firebird),
 *                        por defecto C:\Program Files (x86)\AbarrotesPDV
 *   --minimos <id>       sucursal que recibe los mínimos de Eleventa (por defecto, la central)
 *
 * Los productos que ya existen en la central no se tocan, así que se puede correr varias veces. Antes
 * de aplicar se guarda un respaldo en respaldos\. Se lee una COPIA del archivo, nunca la base que
 * Eleventa está usando.
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
const CONSULTA_DEPARTAMENTOS = `SELECT '#' || D.ID || '|' || COALESCE(D.NOMBRE, '') || '|' || COALESCE(D.ACTIVO, '') || '#'
  FROM DEPARTAMENTOS D ORDER BY D.ID;`;

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
    const departamentos = path.join(dir, 'departamentos.txt');
    const guion = path.join(dir, 'exportar.sql');
    fs.writeFileSync(guion, [
      'SET HEADING OFF;',
      `OUTPUT '${productos}';`, CONSULTA_PRODUCTOS,
      `OUTPUT '${historial}';`, CONSULTA_HISTORIAL,
      `OUTPUT '${departamentos}';`, CONSULTA_DEPARTAMENTOS,
      'OUTPUT;', 'EXIT;', '',
    ].join('\n'));
    const r = spawnSync(isql, ['-u', 'SYSDBA', '-p', 'masterkey', '-i', guion, copia], { cwd: carpetaEleventa, encoding: 'latin1', timeout: 10 * 60000 });
    if (r.status !== 0 || !fs.existsSync(productos)) throw new Error(`Eleventa no pudo leer el archivo: ${r.stderr || r.stdout || r.error}`);
    const leer = (archivo) => (fs.existsSync(archivo) ? fs.readFileSync(archivo).toString('latin1') : '');
    return { productosTexto: leer(productos), historialTexto: leer(historial), departamentosTexto: leer(departamentos) };
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

// ---------- Departamentos ----------
function leerDepartamentos(texto) {
  return renglones(texto).filter((c) => c.length >= 3).map((c) => ({
    id: Number(c[0].trim()),
    nombre: c.slice(1, -1).join('|').trim(),
    // Eleventa guarda 1/0 (algunas versiones T/F)
    activo: !['0', 'F', 'N', 'FALSE'].includes(String(c[c.length - 1]).trim().toUpperCase()),
  })).filter((d) => d.nombre);
}

// "HIGIENE Y BELLEZA", "higiene  y belleza" y "Higiene y  belleza}" son el mismo departamento escrito distinto
const claveDepartamento = (nombre) => {
  const clave = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clave || String(nombre || '').trim(); // "+" o "." se quedan como son
};

// Cómo debe llamarse en la central cada departamento de Eleventa: los activos que se escriben igual
// se juntan en el que tiene más productos; los borrados en Eleventa quedan sin departamento ('').
function unificarDepartamentos(departamentos, productos = []) {
  const usos = new Map();
  for (const p of productos) usos.set(p.departamento, (usos.get(p.departamento) || 0) + 1);
  const grupos = new Map();
  for (const d of departamentos.filter((x) => x.activo)) {
    const clave = claveDepartamento(d.nombre);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(d);
  }
  const mapa = new Map();
  const activos = [];
  const juntados = [];
  for (const lista of grupos.values()) {
    // El que más productos tiene; si empatan, el escrito en mayúsculas o el más antiguo
    const [canonico] = [...lista].sort((a, b) => (usos.get(b.nombre) || 0) - (usos.get(a.nombre) || 0)
      || Number(b.nombre === b.nombre.toUpperCase()) - Number(a.nombre === a.nombre.toUpperCase()) || a.id - b.id);
    activos.push(canonico.nombre);
    for (const d of lista) mapa.set(d.nombre, canonico.nombre);
    if (lista.length > 1) juntados.push({ queda: canonico.nombre, se_juntan: lista.filter((d) => d !== canonico).map((d) => d.nombre) });
  }
  const borrados = [];
  for (const d of departamentos.filter((x) => !x.activo)) {
    if (mapa.has(d.nombre)) continue;
    const parecido = grupos.get(claveDepartamento(d.nombre));
    mapa.set(d.nombre, parecido ? mapa.get(parecido[0].nombre) : '');
    if (!parecido) borrados.push(d.nombre);
  }
  return { mapa, activos: activos.sort((a, b) => a.localeCompare(b, 'es')), juntados, borrados };
}

// Los productos leídos de Eleventa con el departamento como debe quedar en la central
function aplicarDepartamentos(productos, mapa) {
  for (const p of productos) if (mapa.has(p.departamento)) p.departamento = mapa.get(p.departamento);
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

// Deja los departamentos de la central como en Eleventa. No se borra ninguno: los que sobran se
// desactivan (así también desaparecen en las computadoras). Los que se crearon a mano en el sistema y
// no existen en Eleventa no se tocan.
async function sincronizarDepartamentos(supabase, { mapa, activos }, { aplicar = false } = {}) {
  const sb = () => supabase;
  const central = await todas(() => sb().from('departamentos').select('id,nombre,activo').order('id'));
  const porNombre = new Map(central.map((d) => [d.nombre, d]));
  const crear = activos.filter((n) => !porNombre.has(n));
  const reactivar = activos.filter((n) => porNombre.has(n) && porNombre.get(n).activo === false);
  const desactivar = central.filter((d) => d.activo !== false && mapa.has(d.nombre) && mapa.get(d.nombre) !== d.nombre);
  const usados = new Map();
  for (const p of await todas(() => sb().from('productos').select('departamento').order('id'))) {
    usados.set(p.departamento || '', (usados.get(p.departamento || '') || 0) + 1);
  }
  const mover = [...usados.entries()].filter(([nombre]) => mapa.has(nombre) && mapa.get(nombre) !== nombre)
    .map(([de, productos]) => ({ de, a: mapa.get(de), productos }));
  const resumen = {
    se_crean: crear,
    se_reactivan: reactivar,
    se_desactivan: desactivar.map((d) => d.nombre),
    productos_que_cambian: mover.map((m) => `${m.productos} de "${m.de}" → ${m.a ? `"${m.a}"` : 'sin departamento'}`),
  };
  if (!aplicar) return resumen;

  const ahora = new Date().toISOString();
  if (crear.length) await consultar(sb().from('departamentos').insert(crear.map((nombre) => ({ nombre, activo: true }))));
  for (const nombre of reactivar) await consultar(sb().from('departamentos').update({ activo: true }).eq('id', porNombre.get(nombre).id));
  for (const m of mover) await consultar(sb().from('productos').update({ departamento: m.a, updated_at: ahora }).eq('departamento', m.de));
  for (const d of desactivar) await consultar(sb().from('departamentos').update({ activo: false }).eq('id', d.id));
  const cambios = crear.length + reactivar.length + desactivar.length + mover.length;
  if (cambios) {
    await sb().from('bitacora').insert({
      clave: crypto.randomUUID(), tipo: 'producto_cambio', origen: 'importación',
      descripcion: `Departamentos igualados con Eleventa: ${crear.length} nuevo(s), ${desactivar.length} quitado(s)`
        + `${mover.length ? `, ${mover.reduce((t, m) => t + m.productos, 0)} producto(s) cambiaron de departamento` : ''}`,
      detalle: resumen,
    }).then(() => {}, () => {});
  }
  return resumen;
}

// Carga la existencia de una farmacia según Eleventa: la de cada producto después de su último
// movimiento en el archivo (lo negativo queda en 0). Queda en Movimientos como "Existencia inicial".
async function cargarExistencias(supabase, productos, { sucursalId, origen = 'Eleventa', aplicar = false, alAvanzar = () => {} } = {}) {
  const sb = () => supabase;
  const { data: sucursales } = await consultar(sb().from('sucursales').select('id,nombre').eq('id', Number(sucursalId)).limit(1));
  const sucursal = sucursales && sucursales[0];
  if (!sucursal) throw new Error(`No existe la sucursal ${sucursalId}`);
  // Si un código está repetido en Eleventa (por ejemplo, con un espacio), vale el que se movió al último
  const deEleventa = new Map();
  for (const p of productos) {
    if (!p.codigo || p.existencia_eleventa == null) continue;
    const previo = deEleventa.get(p.codigo);
    if (!previo || (p.ultimo_movimiento || '') > (previo.ultimo_movimiento || '')) deEleventa.set(p.codigo, p);
  }
  const centrales = await todas(() => sb().from('productos').select('id,codigo_barras,precio_costo,usa_inventario').eq('activo', true).order('id'));
  const filas = await todas(() => sb().from('inventario').select('producto_id,existencia').eq('sucursal_id', Number(sucursal.id)).order('id'));
  const actual = new Map(filas.map((f) => [Number(f.producto_id), r2(f.existencia)]));
  const cambios = [];
  let negativos = 0;
  let sinHistorial = 0;
  let iguales = 0;
  for (const p of centrales) {
    const e = deEleventa.get(p.codigo_barras);
    if (!e || p.usa_inventario === false) { sinHistorial += 1; continue; }
    let nueva = r2(e.existencia_eleventa);
    if (nueva < 0) { negativos += 1; nueva = 0; }
    const antes = actual.get(Number(p.id)) ?? 0;
    if (Math.abs(antes - nueva) < 0.005) { iguales += 1; continue; }
    cambios.push({ producto_id: Number(p.id), antes, existencia: nueva, costo: r2(p.precio_costo) });
  }
  const resumen = {
    sucursal: sucursal.nombre,
    se_actualizan: cambios.length,
    con_piezas: cambios.filter((c) => c.existencia > 0).length,
    piezas: r2(cambios.reduce((t, c) => t + c.existencia, 0)),
    valor_a_costo: r2(cambios.reduce((t, c) => t + c.existencia * c.costo, 0)),
    negativos_en_eleventa_quedan_en_0: negativos,
    ya_estaban_igual: iguales,
    sin_movimientos_en_eleventa: sinHistorial,
  };
  if (!aplicar) return resumen;

  const ahora = new Date().toISOString();
  let conResultante = true;
  let hechas = 0;
  for (const lote of lotes(cambios, 500)) {
    await consultar(sb().from('inventario').upsert(
      lote.map((c) => ({ producto_id: c.producto_id, sucursal_id: Number(sucursal.id), existencia: c.existencia, updated_at: ahora })),
      { onConflict: 'producto_id,sucursal_id' }
    ));
    const movimientos = lote.map((c) => ({
      producto_id: c.producto_id, sucursal_id: Number(sucursal.id), tipo: 'ajuste', cantidad: c.existencia, usuario_id: null,
      nota: `Existencia inicial desde ${origen} (había ${c.antes})`, existencia_resultante: c.existencia,
    }));
    if (conResultante) {
      const r = await sb().from('movimientos_inventario').insert(movimientos);
      if (r.error && /existencia_resultante|PGRST204|42703/i.test(`${r.error.code} ${r.error.message}`)) conResultante = false;
      else if (r.error) throw new Error(r.error.message);
    }
    if (!conResultante) await consultar(sb().from('movimientos_inventario').insert(movimientos.map(({ existencia_resultante: _x, ...m }) => m)));
    hechas += lote.length;
    alAvanzar(`existencias ${hechas} de ${cambios.length}`);
  }
  await sb().from('bitacora').insert({
    clave: crypto.randomUUID(), tipo: 'existencia_carga', origen: 'importación', sucursal_id: Number(sucursal.id),
    descripcion: `${sucursal.nombre}: existencia cargada desde ${origen} en ${cambios.length} producto(s) (${resumen.piezas} piezas, $${resumen.valor_a_costo.toFixed(2)} a costo)`,
    detalle: resumen,
  }).then(() => {}, () => {});
  return resumen;
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
  const exportado = exportarEleventa({ fdb, carpetaEleventa: argumento('eleventa') || ELEVENTA });
  const productos = leerExportacion(exportado);
  const departamentos = unificarDepartamentos(leerDepartamentos(exportado.departamentosTexto), productos);
  aplicarDepartamentos(productos, departamentos.mapa);
  const desde = argumento('desde') || desdePorDefecto(productos);
  const seleccion = seleccionar(productos, { desde });
  console.log(`Productos en Eleventa: ${productos.length}; departamentos activos: ${departamentos.activos.length}`);

  require('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });
  const url = process.env.SUPABASE_URL;
  const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !llave) throw new Error('Falta SUPABASE_URL o la llave en el .env');
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, llave, { auth: { persistSession: false, autoRefreshToken: false } });
  const respaldo = async (que) => {
    if (!aplicar) return;
    const archivo = path.join(REPO, 'respaldos', `central-antes-de-${que}-${new Date().toISOString().slice(0, 10)}.json`);
    console.log('Respaldo de la central:', await respaldar(supabase, archivo), '→', path.relative(REPO, archivo));
  };
  const mostrar = (r) => console.log(aplicar ? '\nListo:' : '\nAsí quedaría (para hacerlo agrega --aplicar):', r);

  if (process.argv.includes('--departamentos')) {
    if (departamentos.juntados.length) console.log('Se juntan (se escriben igual):', departamentos.juntados);
    await respaldo('departamentos');
    return mostrar(await sincronizarDepartamentos(supabase, departamentos, { aplicar }));
  }
  if (argumento('existencias')) {
    await respaldo('existencias');
    const archivo = path.basename(fdb);
    return mostrar(await cargarExistencias(supabase, productos, {
      sucursalId: argumento('existencias'), origen: `Eleventa (${archivo})`, aplicar, alAvanzar: (t) => process.stdout.write(`  ${t}\r`),
    }));
  }

  console.log(`Con movimientos de inventario desde ${desde}: ${seleccion.productos.length}`);
  console.log('No se cargan:', seleccion.descartados);
  await respaldo('cargar-catalogo');
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

module.exports = {
  leerExportacion, seleccionar, desdePorDefecto, paraCentral, cargarEnCentral, existenciaDespues,
  leerDepartamentos, unificarDepartamentos, aplicarDepartamentos, sincronizarDepartamentos, cargarExistencias,
};
