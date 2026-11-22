'use strict';
// Herramienta del técnico: compara una copia de la central (la que cada computadora guarda en
// respaldos/central) con la central de hoy y, si se le pide, regresa a la central lo que dice la copia.
//
//   node scripts/restaurar-central.js <copia.db.gz>                      solo compara (no escribe nada)
//   node scripts/restaurar-central.js <copia> --tablas productos,inventario
//   node scripts/restaurar-central.js <copia> --tablas productos --aplicar
//        repone en la central los renglones que faltan o que cambiaron (según la copia)
//   ... --borrar-sobrantes   además borra de la central lo que no está en la copia (¡con cuidado!)
//
// --aplicar escribe la central: úsese solo con la autorización del dueño. Después de aplicar deja un
// archivo .sql para ajustar los contadores de ids (correrlo con "supabase db query").
// Las contraseñas no van en las copias: a un usuario que ya no exista en la central no se le puede reponer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const REPO = path.join(__dirname, '..');
// La configuración de la central sale del .env solo si no viene ya en el entorno
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });

const { sb, consultar } = require('../src/central');
const { TABLAS, bajarTabla, limpiarFila, claveDe } = require('../src/copia-central');

const LOTE_ESCRITURA = 500;

function argumentos(lista) {
  const r = { archivo: null, tablas: null, aplicar: false, borrar: false };
  for (let i = 0; i < lista.length; i += 1) {
    const a = lista[i];
    if (a === '--aplicar') r.aplicar = true;
    else if (a === '--borrar-sobrantes') r.borrar = true;
    else if (a === '--tablas') r.tablas = String(lista[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (!r.archivo) r.archivo = a;
    else throw new Error(`No entiendo "${a}"`);
  }
  if (!r.archivo) throw new Error('Falta la copia: node scripts/restaurar-central.js <copia.db.gz> [--tablas a,b] [--aplicar] [--borrar-sobrantes]');
  if ((r.aplicar || r.borrar) && !r.tablas) throw new Error('Para escribir en la central hay que decir qué tablas: --tablas productos,inventario (o --tablas todas)');
  return r;
}

// Abre la copia (comprimida o el espejo tal cual) en modo de solo lectura
function abrirCopia(archivo) {
  if (!fs.existsSync(archivo)) throw new Error(`No existe ${archivo}`);
  let ruta = archivo;
  let temporal = null;
  if (archivo.endsWith('.gz')) {
    temporal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copia-central-')), 'copia.db');
    fs.writeFileSync(temporal, zlib.gunzipSync(fs.readFileSync(archivo)));
    ruta = temporal;
  }
  const copia = new Database(ruta, { readonly: true, fileMustExist: true });
  return {
    copia,
    cerrar() {
      copia.close();
      if (temporal) fs.rmSync(path.dirname(temporal), { recursive: true, force: true });
    },
  };
}

// Iguales si cada dato que trae la copia vale lo mismo en la central (la central puede tener columnas nuevas)
function iguales(deLaCopia, deLaCentral) {
  return Object.keys(deLaCopia).every((k) => JSON.stringify(deLaCopia[k]) === JSON.stringify(deLaCentral[k] ?? null));
}

async function comparar(copia, def) {
  const enCopia = new Map(copia.prepare('SELECT clave, datos FROM filas WHERE tabla = ?').all(def.tabla).map((r) => [r.clave, JSON.parse(r.datos)]));
  const enCentral = new Map((await bajarTabla(def)).map((f) => [claveDe(def, f), limpiarFila(def, f)]));
  const faltan = [];
  const distintos = [];
  const sobran = [];
  for (const [clave, fila] of enCopia) {
    if (!enCentral.has(clave)) faltan.push(fila);
    else if (!iguales(fila, enCentral.get(clave))) distintos.push(fila);
  }
  for (const [clave, fila] of enCentral) if (!enCopia.has(clave)) sobran.push(fila);
  return { enCopia: enCopia.size, enCentral: enCentral.size, faltan, distintos, sobran };
}

async function reponer(def, filas) {
  let hechas = 0;
  const saltadas = [];
  if (def.quitar) {
    // Sin contraseña no se puede crear el renglón: solo se corrigen los que ya existen
    for (const fila of filas) {
      const { data } = await consultar(sb().from(def.tabla).update(fila).eq('id', Number(fila.id)).select('id'));
      if (data && data.length) hechas += 1;
      else saltadas.push(fila);
    }
    return { hechas, saltadas };
  }
  const conflicto = def.llave ? def.llave.join(',') : 'id';
  for (let i = 0; i < filas.length; i += LOTE_ESCRITURA) {
    const lote = filas.slice(i, i + LOTE_ESCRITURA);
    await consultar(sb().from(def.tabla).upsert(lote, { onConflict: conflicto }));
    hechas += lote.length;
  }
  return { hechas, saltadas };
}

async function borrar(def, filas) {
  if (def.llave) {
    for (const fila of filas) {
      let q = sb().from(def.tabla).delete();
      for (const c of def.llave) q = q.eq(c, fila[c]);
      await consultar(q);
    }
    return filas.length;
  }
  const ids = filas.map((f) => Number(f.id));
  for (let i = 0; i < ids.length; i += 200) await consultar(sb().from(def.tabla).delete().in('id', ids.slice(i, i + 200)));
  return ids.length;
}

async function main() {
  const op = argumentos(process.argv.slice(2));
  const { copia, cerrar } = abrirCopia(path.resolve(op.archivo));
  try {
    const fecha = copia.prepare("SELECT valor FROM info WHERE clave = 'ultima_copia'").get();
    console.log(`Copia de la central del ${fecha ? new Date(fecha.valor).toLocaleString('es-MX') : '(sin fecha)'}`);
    const todas = !op.tablas || op.tablas.includes('todas');
    const desconocidas = todas ? [] : op.tablas.filter((t) => !TABLAS.some((d) => d.tabla === t));
    if (desconocidas.length) throw new Error(`Tablas que no están en la copia: ${desconocidas.join(', ')}`);
    const elegidas = TABLAS.filter((d) => todas || op.tablas.includes(d.tabla));
    const enLaCopia = new Set(copia.prepare("SELECT tabla FROM tablas WHERE nota = ''").all().map((r) => r.tabla));

    const resultados = [];
    for (const def of elegidas) {
      if (!enLaCopia.has(def.tabla)) {
        console.log(`- ${def.tabla}: no está en la copia`);
        continue;
      }
      const r = await comparar(copia, def);
      resultados.push({ def, ...r });
      console.log(`- ${def.tabla}: copia ${r.enCopia}, central ${r.enCentral}; faltan en la central ${r.faltan.length}, `
        + `distintos ${r.distintos.length}, de más en la central ${r.sobran.length}`);
    }
    if (!op.aplicar && !op.borrar) {
      console.log('\nSolo se comparó: no se escribió nada en la central.');
      return;
    }

    const conId = [];
    if (op.aplicar) {
      for (const r of resultados) {
        const filas = [...r.faltan, ...r.distintos];
        if (!filas.length) continue;
        const { hechas, saltadas } = await reponer(r.def, filas);
        console.log(`  repuestos en ${r.def.tabla}: ${hechas}${saltadas.length ? ` (sin reponer ${saltadas.length}: ya no existen y no se pueden crear sin contraseña)` : ''}`);
        if (!r.def.llave) conId.push(r.def.tabla);
      }
    }
    if (op.borrar) {
      for (const r of [...resultados].reverse()) {
        if (!r.sobran.length) continue;
        console.log(`  borrados de ${r.def.tabla}: ${await borrar(r.def, r.sobran)}`);
      }
    }
    if (conId.length) {
      const sql = conId.map((t) => `select setval(pg_get_serial_sequence('public.${t}', 'id'), greatest((select max(id) from public.${t}), 1));`).join('\n');
      const archivo = path.join(process.cwd(), `ajustar-ids-${Date.now()}.sql`);
      fs.writeFileSync(archivo, `-- Ajusta los contadores de ids después de reponer desde una copia\n${sql}\n`);
      console.log(`\nFalta ajustar los contadores de ids: correr ${archivo} con "supabase db query".`);
    }
  } finally {
    cerrar();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
