'use strict';
/**
 * Central falsa para pruebas: imita la API REST de Supabase (PostgREST) sobre un SQLite
 * temporal, con las mismas tablas, llaves únicas, llaves foráneas y CHECK de
 * supabase/schema.sql. Así se prueban varias "computadoras" (varios server.js) que comparten
 * una central sin tocar el Supabase real.
 *
 *   const central = await iniciarCentralFalsa();
 *   central.url            -> SUPABASE_URL para los servidores
 *   central.db             -> better-sqlite3 para revisar o sembrar datos
 *   central.simularCaida(true|false)  -> sin conexión / con conexión
 *   await central.cerrar()
 *
 * Soporta lo que usa la app: select de columnas, filtros eq/neq/gt/gte/lt/lte/like/ilike/in/is,
 * not.*, or=(...) y and=(...) con valores entre comillas, order, limit/offset, count=exact
 * (también HEAD), single (Accept vnd.pgrst.object+json), insert, update, upsert y delete.
 */
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { crearDirTemporal, borrarDir } = require('./temporal');

const ESQUEMA = `
CREATE TABLE sucursales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT DEFAULT '', telefono TEXT DEFAULT '',
  es_central INTEGER NOT NULL DEFAULT 0, activa INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')));
CREATE TABLE productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_barras TEXT, descripcion TEXT NOT NULL, departamento TEXT DEFAULT '',
  precio_costo REAL NOT NULL DEFAULT 0, precio_venta REAL NOT NULL DEFAULT 0, precio_mayoreo REAL, cantidad_mayoreo REAL,
  usa_inventario INTEGER NOT NULL DEFAULT 1, es_comun INTEGER NOT NULL DEFAULT 0, activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  CONSTRAINT productos_codigo_barras_key UNIQUE (codigo_barras));
CREATE TABLE inventario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  existencia REAL NOT NULL DEFAULT 0, minimo REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  CONSTRAINT inventario_producto_id_sucursal_id_key UNIQUE (producto_id, sucursal_id));
CREATE TABLE movimientos_inventario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida', 'ajuste', 'venta')),
  cantidad REAL NOT NULL, usuario_id INTEGER, nota TEXT DEFAULT '', existencia_resultante REAL,
  fecha TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')));
CREATE TABLE pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, folio INTEGER NOT NULL, sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviado', 'surtido', 'cancelado')),
  nota TEXT DEFAULT '', creado_por INTEGER, creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  enviado_por INTEGER, enviado TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')));
CREATE TABLE pedido_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  codigo_barras TEXT, descripcion TEXT NOT NULL, cantidad REAL NOT NULL, cantidad_surtida REAL NOT NULL DEFAULT 0,
  CONSTRAINT pedido_detalle_pedido_id_producto_id_key UNIQUE (pedido_id, producto_id));
CREATE TABLE apoyos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, folio INTEGER NOT NULL,
  origen_id INTEGER NOT NULL REFERENCES sucursales(id), destino_id INTEGER NOT NULL REFERENCES sucursales(id),
  pedido_id INTEGER REFERENCES pedidos(id),
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviado', 'recibido', 'cancelado')),
  nota TEXT DEFAULT '', creado_por INTEGER, creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  enviado_por INTEGER, enviado TEXT, recibido_por INTEGER, recibido TEXT, cancelado_por INTEGER, cancelado TEXT,
  motivo_cancelacion TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')));
CREATE TABLE apoyo_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apoyo_id INTEGER NOT NULL REFERENCES apoyos(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  codigo_barras TEXT, descripcion TEXT NOT NULL, cantidad REAL NOT NULL, cantidad_recibida REAL,
  precio_costo REAL NOT NULL DEFAULT 0, precio_venta REAL NOT NULL DEFAULT 0, precio_mayoreo REAL, importe REAL NOT NULL DEFAULT 0,
  CONSTRAINT apoyo_detalle_apoyo_id_producto_id_key UNIQUE (apoyo_id, producto_id));
CREATE TABLE departamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  CONSTRAINT departamentos_nombre_key UNIQUE (nombre));
CREATE TABLE usuarios_central (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, usuario TEXT NOT NULL, password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'admin' CHECK (rol IN ('admin', 'cajero')),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id), activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  CONSTRAINT usuarios_central_usuario_key UNIQUE (usuario));
CREATE TABLE vinculos_movil (
  id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_hash TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios_central(id) ON DELETE CASCADE,
  creado_por INTEGER, expira TEXT NOT NULL, usado TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  CONSTRAINT vinculos_movil_codigo_hash_key UNIQUE (codigo_hash));
CREATE TABLE sesiones_movil (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios_central(id) ON DELETE CASCADE,
  dispositivo TEXT NOT NULL DEFAULT '',
  creada TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  ultimo_uso TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00','now')),
  revocada TEXT,
  CONSTRAINT sesiones_movil_token_hash_key UNIQUE (token_hash));
`;

// Columnas booleanas (SQLite guarda 0/1; PostgREST responde true/false)
const BOOLEANAS = {
  sucursales: ['es_central', 'activa'],
  productos: ['usa_inventario', 'es_comun', 'activo'],
  departamentos: ['activo'],
  usuarios_central: ['activo'],
};

function errorPg(status, code, message, details = null) {
  const e = new Error(message);
  e.respuesta = { status, body: { code, message, details, hint: null } };
  return e;
}

// ---------- Análisis de la URL ----------
// Divide por comas de primer nivel respetando comillas y paréntesis
function dividir(texto) {
  const partes = [];
  let actual = '';
  let comillas = false;
  let nivel = 0;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      actual += c;
      if (c === '\\' && i + 1 < texto.length) { actual += texto[i + 1]; i += 1; continue; }
      if (c === '"') comillas = false;
      continue;
    }
    if (c === '"') { comillas = true; actual += c; continue; }
    if (c === '(') nivel += 1;
    if (c === ')') nivel -= 1;
    if (c === ',' && nivel === 0) { partes.push(actual); actual = ''; continue; }
    actual += c;
  }
  if (actual !== '') partes.push(actual);
  return partes;
}

function quitarComillas(valor) {
  if (valor.length >= 2 && valor.startsWith('"') && valor.endsWith('"')) {
    return valor.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return valor;
}

class Consulta {
  constructor(tabla, columnas) {
    this.tabla = tabla;
    this.columnas = columnas;
    this.params = [];
  }

  columna(nombre) {
    if (!this.columnas.includes(nombre)) {
      throw errorPg(400, '42703', `column ${this.tabla}.${nombre} does not exist`);
    }
    return `"${nombre}"`;
  }

  valor(columna, crudo) {
    if ((BOOLEANAS[this.tabla] || []).includes(columna)) {
      if (crudo === 'true') return 1;
      if (crudo === 'false') return 0;
    }
    return crudo;
  }

  // "operador.valor" sobre una columna -> SQL
  condicion(columna, expresion) {
    let negar = false;
    let resto = expresion;
    if (resto.startsWith('not.')) { negar = true; resto = resto.slice(4); }
    const punto = resto.indexOf('.');
    const op = resto.slice(0, punto);
    const crudo = resto.slice(punto + 1);
    const col = this.columna(columna);
    let sql;
    const comparar = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    if (comparar[op]) {
      this.params.push(this.valor(columna, quitarComillas(crudo)));
      sql = `${col} ${comparar[op]} ?`;
    } else if (op === 'like' || op === 'ilike') {
      const patron = quitarComillas(crudo).replace(/\*/g, '%');
      this.params.push(op === 'ilike' ? patron.toLowerCase() : patron);
      sql = op === 'ilike' ? `lower(${col}) LIKE ?` : `${col} LIKE ?`;
    } else if (op === 'in') {
      const lista = dividir(crudo.replace(/^\(/, '').replace(/\)$/, '')).map((v) => this.valor(columna, quitarComillas(v)));
      if (lista.length === 0) sql = '0';
      else {
        this.params.push(...lista);
        sql = `${col} IN (${lista.map(() => '?').join(',')})`;
      }
    } else if (op === 'is') {
      const v = crudo.toLowerCase();
      sql = v === 'null' ? `${col} IS NULL` : v === 'true' ? `${col} = 1` : `${col} = 0`;
    } else {
      throw errorPg(400, 'PGRST100', `operador no soportado por la central falsa: ${op}`);
    }
    return negar ? `NOT (${sql})` : sql;
  }

  // or=(a.eq.1,b.ilike."*x*") / and=(...) con anidamiento
  logica(tipo, cuerpo) {
    const partes = dividir(cuerpo.replace(/^\(/, '').replace(/\)$/, ''));
    const sqls = partes.map((parte) => {
      const anidado = parte.match(/^(not\.)?(and|or)(\(.*\))$/);
      if (anidado) {
        const sql = this.logica(anidado[2], anidado[3]);
        return anidado[1] ? `NOT ${sql}` : sql;
      }
      const punto = parte.indexOf('.');
      return this.condicion(parte.slice(0, punto), parte.slice(punto + 1));
    });
    return `(${sqls.join(tipo === 'or' ? ' OR ' : ' AND ')})`;
  }
}

const RESERVADOS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function construirWhere(consulta, busqueda) {
  const condiciones = [];
  for (const [clave, valor] of busqueda) {
    if (RESERVADOS.has(clave)) continue;
    if (clave === 'or' || clave === 'and') condiciones.push(consulta.logica(clave, valor));
    else if (clave === 'not.or' || clave === 'not.and') condiciones.push(`NOT ${consulta.logica(clave.slice(4), valor)}`);
    else condiciones.push(consulta.condicion(clave, valor));
  }
  return condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
}

function construirOrden(consulta, orden) {
  if (!orden) return '';
  return `ORDER BY ${orden.split(',').map((parte) => {
    const [columna, ...mods] = parte.split('.');
    let sql = consulta.columna(columna);
    if (mods.includes('desc')) sql += ' DESC';
    if (mods.includes('nullsfirst')) sql += ' NULLS FIRST';
    if (mods.includes('nullslast')) sql += ' NULLS LAST';
    return sql;
  }).join(', ')}`;
}

function preferencias(req) {
  const prefer = String(req.headers.prefer || '');
  return {
    representacion: /return=representation/.test(prefer),
    contar: /count=(exact|planned|estimated)/.test(prefer),
    combinar: /resolution=merge-duplicates/.test(prefer),
    ignorar: /resolution=ignore-duplicates/.test(prefer),
  };
}

function iniciarCentralFalsa({ dbPath = null, rpc = {} } = {}) {
  const dir = dbPath ? null : crearDirTemporal('central');
  const archivo = dbPath || path.join(dir, 'central.db');
  const db = new Database(archivo);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(ESQUEMA);
  const columnasDe = (tabla) => db.prepare(`PRAGMA table_info("${tabla}")`).all().map((c) => c.name);
  const tablas = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name));

  let caida = false;
  const sockets = new Set();
  const estadisticas = { peticiones: 0 };

  function aJson(tabla, fila, seleccion) {
    const salida = {};
    const booleanas = BOOLEANAS[tabla] || [];
    for (const columna of seleccion) {
      const valor = fila[columna];
      salida[columna] = booleanas.includes(columna) && valor !== null && valor !== undefined ? Boolean(valor) : valor;
    }
    return salida;
  }

  function seleccionDe(tabla, select) {
    const columnas = columnasDe(tabla);
    if (!select || select === '*') return columnas;
    return dividir(select).map((c) => {
      if (c === '*') return columnas;
      if (/[:(]/.test(c)) throw errorPg(400, 'PGRST100', `la central falsa no soporta recursos anidados: ${c}`);
      if (!columnas.includes(c)) throw errorPg(400, '42703', `column ${tabla}.${c} does not exist`);
      return [c];
    }).flat();
  }

  function filaParaSql(tabla, objeto) {
    const columnas = columnasDe(tabla);
    const booleanas = BOOLEANAS[tabla] || [];
    const salida = {};
    for (const [clave, valor] of Object.entries(objeto)) {
      if (!columnas.includes(clave)) {
        throw errorPg(400, 'PGRST204', `Could not find the '${clave}' column of '${tabla}' in the schema cache`);
      }
      salida[clave] = booleanas.includes(clave) && typeof valor === 'boolean' ? (valor ? 1 : 0) : valor;
    }
    return salida;
  }

  function traducirErrorSqlite(error, tabla) {
    const mensaje = String(error.message || '');
    if (/UNIQUE constraint failed/.test(mensaje)) {
      const cols = mensaje.split(':').pop().trim().split(',').map((c) => c.trim().split('.').pop());
      const nombre = cols.length === 1 && cols[0] === 'id' ? `${tabla}_pkey` : `${tabla}_${cols.join('_')}_key`;
      return errorPg(409, '23505', `duplicate key value violates unique constraint "${nombre}"`);
    }
    if (/FOREIGN KEY constraint failed/.test(mensaje)) return errorPg(409, '23503', `insert or update on table "${tabla}" violates foreign key constraint`);
    if (/CHECK constraint failed/.test(mensaje)) return errorPg(400, '23514', `new row for relation "${tabla}" violates check constraint`);
    if (/NOT NULL constraint failed/.test(mensaje)) return errorPg(400, '23502', `null value in column violates not-null constraint (${mensaje})`);
    return errorPg(500, 'XX000', mensaje);
  }

  function responder(res, status, cuerpo, cabeceras = {}) {
    const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cabeceras });
    res.end(texto);
  }

  function atender(req, res, cuerpoTexto) {
    const url = new URL(req.url, 'http://central-falsa');
    const partes = url.pathname.split('/').filter(Boolean); // rest, v1, tabla
    if (partes[0] !== 'rest' || partes[1] !== 'v1') return responder(res, 404, { message: 'no encontrado' });
    if (partes[2] === 'rpc') {
      const fn = rpc[partes[3]];
      if (!fn) return responder(res, 404, { code: 'PGRST202', message: `Could not find the function public.${partes[3]}`, details: null, hint: null });
      const resultado = fn(cuerpoTexto ? JSON.parse(cuerpoTexto) : {}, db);
      return responder(res, 200, resultado);
    }
    const tabla = decodeURIComponent(partes[2] || '');
    if (!tablas.has(tabla)) {
      return responder(res, 404, { code: 'PGRST205', message: `Could not find the table 'public.${tabla}' in the schema cache`, details: null, hint: null });
    }
    const busqueda = [...url.searchParams.entries()];
    const consulta = new Consulta(tabla, columnasDe(tabla));
    const pref = preferencias(req);
    const objetoUnico = /vnd\.pgrst\.object\+json/.test(String(req.headers.accept || ''));
    const select = url.searchParams.get('select');

    const entregar = (filas, status, conteo = null) => {
      const cabeceras = {};
      if (conteo !== null) cabeceras['Content-Range'] = filas.length ? `0-${filas.length - 1}/${conteo}` : `*/${conteo}`;
      if (objetoUnico) {
        if (filas.length !== 1) {
          return responder(res, 406, {
            code: 'PGRST116',
            details: `The result contains ${filas.length} rows`,
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          });
        }
        return responder(res, status, filas[0], cabeceras);
      }
      return responder(res, status, filas, cabeceras);
    };

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const seleccion = seleccionDe(tabla, select);
        const where = construirWhere(consulta, busqueda);
        const orden = construirOrden(consulta, url.searchParams.get('order'));
        const limite = url.searchParams.get('limit');
        const desde = url.searchParams.get('offset');
        let sql = `SELECT * FROM "${tabla}" ${where} ${orden}`;
        if (limite) sql += ` LIMIT ${Number(limite)}`;
        if (desde) sql += `${limite ? '' : ' LIMIT -1'} OFFSET ${Number(desde)}`;
        const filas = db.prepare(sql).all(...consulta.params).map((f) => aJson(tabla, f, seleccion));
        let conteo = null;
        if (pref.contar) {
          const c2 = new Consulta(tabla, columnasDe(tabla));
          conteo = db.prepare(`SELECT COUNT(*) AS n FROM "${tabla}" ${construirWhere(c2, busqueda)}`).get(...c2.params).n;
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, conteo === null ? {} : { 'Content-Range': `*/${conteo}` });
          return res.end();
        }
        return entregar(filas, 200, conteo);
      }

      if (req.method === 'POST') {
        const cuerpo = cuerpoTexto ? JSON.parse(cuerpoTexto) : {};
        const lista = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
        const conflicto = url.searchParams.get('on_conflict');
        const insertados = db.transaction(() => lista.map((objeto) => {
          const fila = filaParaSql(tabla, objeto);
          const columnas = Object.keys(fila);
          let sql = columnas.length
            ? `INSERT INTO "${tabla}" (${columnas.map((c) => `"${c}"`).join(',')}) VALUES (${columnas.map((c) => `@${c}`).join(',')})`
            : `INSERT INTO "${tabla}" DEFAULT VALUES`;
          if (pref.combinar || pref.ignorar) {
            const llave = (conflicto || 'id').split(',').map((c) => `"${c.trim()}"`).join(',');
            const actualizar = columnas.filter((c) => !(conflicto || 'id').split(',').includes(c));
            sql += pref.ignorar || actualizar.length === 0
              ? ` ON CONFLICT (${llave}) DO NOTHING`
              : ` ON CONFLICT (${llave}) DO UPDATE SET ${actualizar.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`;
          }
          sql += ' RETURNING *';
          return db.prepare(sql).get(fila);
        }))().filter(Boolean);
        const seleccion = seleccionDe(tabla, select);
        if (!pref.representacion) return responder(res, 201, undefined);
        return entregar(insertados.map((f) => aJson(tabla, f, seleccion)), 201);
      }

      if (req.method === 'PATCH') {
        const cambios = filaParaSql(tabla, cuerpoTexto ? JSON.parse(cuerpoTexto) : {});
        const columnas = Object.keys(cambios);
        if (!columnas.length) return responder(res, 400, { code: 'PGRST100', message: 'sin cambios' });
        const where = construirWhere(consulta, busqueda);
        const set = columnas.map((c) => `"${c}" = ?`).join(', ');
        const filas = db.prepare(`UPDATE "${tabla}" SET ${set} ${where} RETURNING *`)
          .all(...columnas.map((c) => cambios[c]), ...consulta.params);
        if (!pref.representacion) return responder(res, 204, undefined);
        return entregar(filas.map((f) => aJson(tabla, f, seleccionDe(tabla, select))), 200);
      }

      if (req.method === 'DELETE') {
        const where = construirWhere(consulta, busqueda);
        const filas = db.prepare(`DELETE FROM "${tabla}" ${where} RETURNING *`).all(...consulta.params);
        if (!pref.representacion) return responder(res, 204, undefined);
        return entregar(filas.map((f) => aJson(tabla, f, seleccionDe(tabla, select))), 200);
      }

      return responder(res, 405, { message: 'método no soportado' });
    } catch (error) {
      const e = error.respuesta ? error : traducirErrorSqlite(error, tabla);
      return responder(res, e.respuesta.status, e.respuesta.body);
    }
  }

  const servidor = http.createServer((req, res) => {
    estadisticas.peticiones += 1;
    if (caida) {
      req.socket.destroy(); // como si no hubiera internet
      return;
    }
    let cuerpo = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => atender(req, res, cuerpo));
  });
  servidor.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${servidor.address().port}`;
      resolver({
        url,
        key: 'clave-falsa',
        db,
        estadisticas,
        simularCaida(valor) {
          caida = Boolean(valor);
          if (caida) for (const s of sockets) s.destroy();
        },
        async cerrar() {
          for (const s of sockets) s.destroy();
          await new Promise((r) => servidor.close(() => r()));
          db.close();
          if (dir) await borrarDir(dir);
        },
      });
    });
  });
}

// Siembra directa (sin pasar por la API)
function sembrarBase(db, { sucursales = [], usuarios = [], productos = [], inventario = [], departamentos = [] } = {}) {
  const insertar = (tabla, fila) => {
    const datos = {};
    for (const [k, v] of Object.entries(fila)) datos[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    const cols = Object.keys(datos);
    db.prepare(`INSERT INTO "${tabla}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(datos);
  };
  db.transaction(() => {
    for (const s of sucursales) insertar('sucursales', s);
    for (const u of usuarios) insertar('usuarios_central', u);
    for (const d of departamentos) insertar('departamentos', d);
    for (const p of productos) insertar('productos', p);
    for (const i of inventario) insertar('inventario', i);
  })();
}

module.exports = { iniciarCentralFalsa, sembrarBase };
