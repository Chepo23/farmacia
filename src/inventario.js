// Inventario unificado: UNA sola fuente de verdad para las existencias de todas las pantallas
// (Productos, Venta, búsqueda F3, Bajo mínimo, Apoyos, Pedidos, Reportes y Kardex).
//
// - Modo local (sin Supabase): SQLite es la verdad; cada movimiento valida y aplica dentro
//   de una transacción.
// - Modo central (con Supabase): la central es la verdad. Cada movimiento se aplica en la
//   central de forma atómica (compara y escribe: si otra caja cambió la existencia entre la
//   lectura y la escritura, se vuelve a intentar, así nunca se pierde una venta) y la copia
//   local se actualiza con el valor que quedó.
//   Si no hay internet las VENTAS no se detienen: el descuento queda en la cola
//   inventario_pendiente y se sube solo cuando vuelve la conexión.
//   Copia local = existencia en la central + movimientos de esta computadora pendientes de subir.
const db = require('./db');
const catalogo = require('./catalogo');
const { ErrorApp, modoCentral, centralDisponible, consultar, sb, sinConexion, estadoCentral } = require('./central');

const TIPOS = ['entrada', 'salida', 'venta', 'ajuste'];
const EPS = 1e-6;
const MAX_INTENTOS_SINCRONIZACION = 10;
const TAMANO_LOTE = 150;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

function lotes(lista, tamano = TAMANO_LOTE) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function idsValidos(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

// Fecha de la central (ISO en UTC) a la hora local 'AAAA-MM-DD HH:MM:SS', igual que SQLite
function fechaLocal(valor) {
  if (!valor) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(valor)) return valor;
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return String(valor);
  return fecha.toLocaleString('sv-SE').replace('T', ' ');
}

// ---------- Consultas locales preparadas ----------
const stmt = {
  pendiente: db.prepare(
    "SELECT COALESCE(SUM(delta), 0) AS d FROM inventario_pendiente WHERE estado = 'delta' AND producto_id = ? AND sucursal_id = ?"
  ),
  filaLocal: db.prepare('SELECT existencia, minimo FROM inventario WHERE producto_id = ? AND sucursal_id = ?'),
  upsertLocal: db.prepare(
    `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo) VALUES (?, ?, ?, ?)
     ON CONFLICT(producto_id, sucursal_id) DO UPDATE SET existencia = excluded.existencia, minimo = excluded.minimo`
  ),
  movimientoLocal: db.prepare(
    `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota, existencia_resultante)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  encolar: db.prepare(
    `INSERT INTO inventario_pendiente (producto_id, sucursal_id, tipo, cantidad, delta, usuario_id, nota, estado, existencia_resultante)
     VALUES (@producto_id, @sucursal_id, @tipo, @cantidad, @delta, @usuario_id, @nota, @estado, @existencia_resultante)`
  ),
  productoLocal: db.prepare('SELECT id, descripcion FROM productos WHERE id = ?'),
  sucursalLocal: db.prepare('SELECT id FROM sucursales WHERE id = ?'),
  usuarioLocal: db.prepare('SELECT id FROM usuarios WHERE id = ?'),
};

function pendienteDe(productoId, sucursalId) {
  return r2(stmt.pendiente.get(productoId, sucursalId).d);
}

function descripcionDe(productoId) {
  return stmt.productoLocal.get(productoId)?.descripcion || `producto ${productoId}`;
}

// Filas que la sincronización está subiendo en este momento: no se refrescan en la copia
// local para no contar dos veces el mismo movimiento mientras dura la operación.
const filasSincronizando = new Set();

// Guarda en la copia local existencias leídas de la central (respetando lo pendiente de subir)
const escribirCache = db.transaction((filas) => {
  for (const fila of filas) {
    const productoId = Number(fila.producto_id);
    const sucursalId = Number(fila.sucursal_id);
    if (filasSincronizando.has(`${productoId}:${sucursalId}`)) continue;
    if (!stmt.productoLocal.get(productoId) || !stmt.sucursalLocal.get(sucursalId)) continue; // llaves foráneas
    stmt.upsertLocal.run(productoId, sucursalId, r2(Number(fila.existencia) + pendienteDe(productoId, sucursalId)), r2(fila.minimo));
  }
});

// Sucursales nuevas dadas de alta desde otra computadora: se copian para poder guardar su inventario
async function asegurarSucursales(ids) {
  const faltan = idsValidos(ids).filter((id) => !stmt.sucursalLocal.get(id));
  if (!faltan.length || !modoCentral()) return;
  try {
    const { data } = await consultar(sb().from('sucursales').select('*').in('id', faltan));
    const guardar = db.prepare(
      `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
         telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
    );
    db.transaction(() => {
      for (const s of data || []) {
        guardar.run(Number(s.id), s.nombre, s.direccion || '', s.telefono || '', s.es_central ? 1 : 0, s.activa === false ? 0 : 1);
      }
    })();
  } catch (error) {
    if (!error.sinConexion) console.error('No se pudieron copiar sucursales de la central:', error.message);
  }
}

// Copia todas las sucursales de la central (nombre, dirección y bajas incluidas)
async function sincronizarSucursales() {
  if (!modoCentral()) return { sucursales: 0 };
  const { data } = await consultar(sb().from('sucursales').select('*').order('id'));
  const guardar = db.prepare(
    `INSERT INTO sucursales (id, nombre, direccion, telefono, es_central, activa) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion,
       telefono = excluded.telefono, es_central = excluded.es_central, activa = excluded.activa`
  );
  const ids = (data || []).map((s) => Number(s.id));
  db.transaction(() => {
    for (const s of data || []) {
      guardar.run(Number(s.id), s.nombre, s.direccion || '', s.telefono || '', s.es_central ? 1 : 0, s.activa === false ? 0 : 1);
    }
    // Sucursales que solo existen en esta computadora (las que crea la instalación nueva): fuera de las listas
    if (ids.length) {
      db.prepare(`UPDATE sucursales SET activa = 0 WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
  })();
  return { sucursales: ids.length };
}

function sucursalesActivas() {
  return db
    .prepare('SELECT id, nombre, es_central FROM sucursales WHERE activa = 1 ORDER BY es_central DESC, id')
    .all();
}

// ---------- Lectura ----------
function ponerEnMapa(mapa, productoId, sucursalId, valor) {
  if (!mapa.has(productoId)) mapa.set(productoId, new Map());
  mapa.get(productoId).set(sucursalId, valor);
}

function leerLocal(ids, sucursalId) {
  const mapa = new Map();
  for (const lote of lotes(ids, 500)) {
    const filas = db
      .prepare(
        `SELECT producto_id, sucursal_id, existencia, minimo FROM inventario
         WHERE producto_id IN (${lote.map(() => '?').join(',')}) ${sucursalId ? 'AND sucursal_id = ?' : ''}`
      )
      .all(...lote, ...(sucursalId ? [sucursalId] : []));
    for (const f of filas) {
      ponerEnMapa(mapa, Number(f.producto_id), Number(f.sucursal_id), { existencia: r2(f.existencia), minimo: r2(f.minimo) });
    }
  }
  return mapa;
}

// Existencias de los productos indicados: Map productoId -> Map sucursalId -> { existencia, minimo }
async function leerExistencias(productoIds, { sucursalId = null } = {}) {
  const ids = idsValidos(productoIds);
  const sucursal = sucursalId ? Number(sucursalId) : null;
  if (ids.length === 0) return { mapa: new Map(), fuente: modoCentral() ? 'central' : 'local' };

  if (modoCentral() && centralDisponible()) {
    try {
      const filas = [];
      // La central responde a lo mucho 1000 filas por consulta: el lote depende de cuántas sucursales hay
      const porConsulta = sucursal ? TAMANO_LOTE : Math.max(10, Math.floor(900 / Math.max(1, sucursalesActivas().length + 2)));
      for (const lote of lotes(ids, Math.min(TAMANO_LOTE, porConsulta))) {
        let consulta = sb().from('inventario').select('producto_id,sucursal_id,existencia,minimo').in('producto_id', lote);
        if (sucursal) consulta = consulta.eq('sucursal_id', sucursal);
        const { data } = await consultar(consulta);
        filas.push(...(data || []));
      }
      await asegurarSucursales(filas.map((f) => f.sucursal_id));
      try {
        escribirCache(filas);
      } catch (error) {
        console.error('No se pudo actualizar la copia local del inventario:', error.message);
      }
      const mapa = new Map();
      for (const f of filas) {
        const p = Number(f.producto_id);
        const s = Number(f.sucursal_id);
        ponerEnMapa(mapa, p, s, { existencia: r2(Number(f.existencia) + pendienteDe(p, s)), minimo: r2(f.minimo) });
      }
      // Ventas sin conexión de productos que todavía no tienen fila en la central
      for (const lote of lotes(ids, 500)) {
        const pendientes = db
          .prepare(
            `SELECT producto_id, sucursal_id, SUM(delta) AS d FROM inventario_pendiente
             WHERE estado = 'delta' AND producto_id IN (${lote.map(() => '?').join(',')})
             GROUP BY producto_id, sucursal_id`
          )
          .all(...lote);
        for (const pnd of pendientes) {
          const p = Number(pnd.producto_id);
          const s = Number(pnd.sucursal_id);
          if (sucursal && s !== sucursal) continue;
          if (!mapa.get(p)?.has(s)) ponerEnMapa(mapa, p, s, { existencia: r2(pnd.d), minimo: 0 });
        }
      }
      lanzarSincronizacion();
      return { mapa, fuente: 'central' };
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  return { mapa: leerLocal(ids, sucursal), fuente: 'local' };
}

// Existencia de un producto en una sucursal
async function existenciaDe(productoId, sucursalId) {
  const { mapa, fuente } = await leerExistencias([productoId], { sucursalId });
  const valor = mapa.get(Number(productoId))?.get(Number(sucursalId)) || { existencia: 0, minimo: 0 };
  return { ...valor, fuente };
}

// Agrega a cada producto sus existencias en todas las sucursales activas.
// Cada producto queda con: existencias [{ sucursal_id, sucursal, es_central, existencia, minimo }],
// existencia_local / minimo_local (de la sucursal indicada) y total_disponible.
async function conExistencias(productos, { sucursalId = null } = {}) {
  const lista = (productos || []).filter(Boolean);
  const { mapa, fuente } = await leerExistencias(lista.filter((p) => p.usa_inventario).map((p) => p.id));
  const sucursales = sucursalesActivas();
  const propia = Number(sucursalId) || null;
  return {
    fuente,
    productos: lista.map((p) => {
      const porSucursal = mapa.get(Number(p.id)) || new Map();
      const existencias = sucursales.map((s) => {
        const valor = porSucursal.get(Number(s.id));
        return {
          sucursal_id: s.id,
          sucursal: s.nombre,
          es_central: s.es_central ? 1 : 0,
          existencia: valor ? valor.existencia : 0,
          minimo: valor ? valor.minimo : 0,
        };
      });
      const local = existencias.find((e) => e.sucursal_id === propia);
      return {
        ...p,
        existencias,
        existencia_local: local ? local.existencia : 0,
        minimo_local: local ? local.minimo : 0,
        total_disponible: r2(existencias.reduce((t, e) => t + e.existencia, 0)),
      };
    }),
  };
}

// ---------- Movimientos ----------
function normalizarMovimiento(m) {
  const tipo = String(m.tipo || '');
  if (!TIPOS.includes(tipo)) throw new ErrorApp('Tipo de movimiento no válido');
  const cantidad = Number(m.cantidad);
  if (m.cantidad === '' || m.cantidad === null || m.cantidad === undefined || !Number.isFinite(cantidad)
    || (tipo === 'ajuste' ? cantidad < 0 : cantidad <= 0)) {
    throw new ErrorApp(tipo === 'ajuste' ? 'La existencia del ajuste no puede ser negativa' : 'Cantidad no válida');
  }
  const productoId = Number(m.producto_id);
  const sucursalId = Number(m.sucursal_id);
  if (!(productoId > 0)) throw new ErrorApp('Producto no válido');
  if (!(sucursalId > 0)) throw new ErrorApp('Sucursal no válida');
  let minimo = null;
  if (m.minimo !== undefined && m.minimo !== null && m.minimo !== '') {
    minimo = Number(m.minimo);
    if (!Number.isFinite(minimo) || minimo < 0) throw new ErrorApp('Mínimo no válido');
    minimo = r2(minimo);
  }
  const cant = r2(cantidad);
  return {
    producto_id: productoId,
    sucursal_id: sucursalId,
    tipo,
    cantidad: cant,
    delta: tipo === 'entrada' ? cant : tipo === 'ajuste' ? null : -cant,
    fijar: tipo === 'ajuste' ? cant : null,
    minimo,
    nota: String(m.nota || '').trim().slice(0, 300),
    // Salidas y ventas no pueden dejar la existencia en negativo
    validar: m.validar ?? (tipo === 'salida' || tipo === 'venta'),
  };
}

function agrupar(movimientos) {
  const grupos = new Map();
  for (const m of movimientos) {
    const clave = `${m.producto_id}:${m.sucursal_id}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, { clave, producto_id: m.producto_id, sucursal_id: m.sucursal_id, movs: [], minimo: null });
    }
    const grupo = grupos.get(clave);
    grupo.movs.push(m);
    if (m.minimo !== null) grupo.minimo = m.minimo;
  }
  return [...grupos.values()];
}

function errorSinExistencia(grupo, disponible) {
  const pedido = r2(-grupo.movs.reduce((t, m) => t + (m.delta || 0), 0));
  return new ErrorApp(
    `No hay suficiente existencia de "${descripcionDe(grupo.producto_id)}" (hay ${r2(disponible)} y se piden ${pedido})`,
    { status: 400, codigo: 'SIN_EXISTENCIA', datos: { producto_id: grupo.producto_id, sucursal_id: grupo.sucursal_id, disponible: r2(disponible) } }
  );
}

// Existencia tras cada movimiento del grupo; lanza si alguno que valida deja negativo
function calcular(grupo, anterior, { validar = true } = {}) {
  let valor = r2(anterior);
  const pasos = [];
  for (const m of grupo.movs) {
    valor = r2(m.fijar !== null ? m.fijar : valor + m.delta);
    if (validar && m.validar && valor < -EPS) throw errorSinExistencia(grupo, anterior);
    pasos.push(valor);
  }
  return { final: valor, pasos };
}

// Ejecuta fn sobre la lista con a lo mucho `limite` operaciones a la vez (como Promise.allSettled).
// Si una falla por falta de conexión, las que siguen ya no se intentan (se marcan igual).
async function enParalelo(lista, limite, fn) {
  const resultados = new Array(lista.length);
  let siguiente = 0;
  let sinRed = null;
  async function trabajador() {
    while (siguiente < lista.length) {
      const i = siguiente;
      siguiente += 1;
      if (sinRed) {
        resultados[i] = { status: 'rejected', reason: sinRed };
        continue;
      }
      try {
        resultados[i] = { status: 'fulfilled', value: await fn(lista[i]) };
      } catch (reason) {
        if (reason && reason.sinConexion) sinRed = reason;
        resultados[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabajador));
  return resultados;
}

// Aplica un grupo en la central con compara-y-escribe
async function casCentral(grupo, { validar = true } = {}) {
  for (let intento = 0; intento < 12; intento += 1) {
    const { data: filas } = await consultar(
      sb().from('inventario').select('existencia,minimo')
        .eq('producto_id', grupo.producto_id).eq('sucursal_id', grupo.sucursal_id).limit(1)
    );
    const fila = filas && filas[0];
    const anterior = fila ? r2(fila.existencia) : 0;
    const { final, pasos } = calcular(grupo, anterior, { validar });
    const minimo = grupo.minimo !== null ? grupo.minimo : fila ? r2(fila.minimo) : 0;
    const ahora = new Date().toISOString();
    if (!fila) {
      try {
        await consultar(
          sb().from('inventario')
            .insert({ producto_id: grupo.producto_id, sucursal_id: grupo.sucursal_id, existencia: final, minimo, updated_at: ahora })
            .select('id')
        );
      } catch (error) {
        if (error.codigo === '23505') continue; // otra caja creó la fila al mismo tiempo
        throw error;
      }
    } else {
      const cambios = { existencia: final, updated_at: ahora };
      if (grupo.minimo !== null) cambios.minimo = grupo.minimo;
      const { data } = await consultar(
        sb().from('inventario').update(cambios)
          .eq('producto_id', grupo.producto_id).eq('sucursal_id', grupo.sucursal_id)
          .eq('existencia', fila.existencia)
          .select('existencia')
      );
      if (!data || data.length === 0) {
        // Otra caja cambió la existencia entre la lectura y la escritura: reintentar
        await esperar(15 + intento * 25 + Math.floor(Math.random() * 25));
        continue;
      }
    }
    return { ...grupo, anterior, existencia: final, minimo, pasos };
  }
  throw new ErrorApp('Otra caja está moviendo este mismo producto en este momento; intenta de nuevo', {
    status: 409,
    codigo: 'CONFLICTO',
  });
}

// La columna existencia_resultante es opcional en la central (supabase/schema.sql la agrega)
let centralTieneResultante = true;

async function insertarMovimientosCentral(filas) {
  if (!filas.length) return;
  const basicas = filas.map(({ existencia_resultante: _omitir, ...resto }) => resto);
  if (centralTieneResultante) {
    try {
      await consultar(sb().from('movimientos_inventario').insert(filas));
      return;
    } catch (error) {
      if (!/existencia_resultante|PGRST204|42703/i.test(`${error.codigo} ${error.message}`)) throw error;
      centralTieneResultante = false;
    }
  }
  await consultar(sb().from('movimientos_inventario').insert(basicas));
}

function filasMovimiento(resultados, usuarioId) {
  const filas = [];
  for (const r of resultados) {
    r.movs.forEach((m, i) => {
      filas.push({
        producto_id: m.producto_id,
        sucursal_id: m.sucursal_id,
        tipo: m.tipo,
        cantidad: m.cantidad,
        usuario_id: usuarioId || null,
        nota: m.nota,
        existencia_resultante: r.pasos[i],
      });
    });
  }
  return filas;
}

function encolar(fila) {
  stmt.encolar.run({
    producto_id: fila.producto_id,
    sucursal_id: fila.sucursal_id,
    tipo: fila.tipo,
    cantidad: fila.cantidad,
    delta: fila.delta || 0,
    usuario_id: fila.usuario_id || null,
    nota: fila.nota || '',
    estado: fila.estado,
    existencia_resultante: fila.existencia_resultante ?? null,
  });
}

function registrarMovimientoLocal(m, usuarioId, resultante, sufijoNota = '') {
  if (!usuarioId || !stmt.usuarioLocal.get(usuarioId)) return; // el historial local requiere un usuario conocido
  stmt.movimientoLocal.run(m.producto_id, m.sucursal_id, m.tipo, m.cantidad, usuarioId, `${m.nota}${sufijoNota}`, resultante);
}

// Deshace en la central grupos ya aplicados (si no hay red, el reverso se encola)
async function compensar(resultados, usuarioId, { registrar = false } = {}) {
  for (const r of resultados) {
    const delta = r2(r.anterior - r.existencia);
    if (Math.abs(delta) < EPS) continue;
    const grupo = {
      producto_id: r.producto_id,
      sucursal_id: r.sucursal_id,
      minimo: null,
      movs: [{ producto_id: r.producto_id, sucursal_id: r.sucursal_id, delta, fijar: null, validar: false, tipo: delta > 0 ? 'entrada' : 'salida', cantidad: Math.abs(delta), nota: 'Reverso automático de una operación que no se completó' }],
    };
    try {
      const hecho = await casCentral(grupo, { validar: false });
      if (registrar) await insertarMovimientosCentral(filasMovimiento([hecho], usuarioId)).catch(() => {});
    } catch {
      // Sin red (o la central rechazó): el reverso queda en la cola y se aplica después
      encolar({ ...grupo.movs[0], usuario_id: usuarioId, estado: 'delta' });
    }
  }
}

// Prepara los movimientos. En modo central los aplica en la central; la parte local
// (copia, historial y cola) se hace con plan.aplicarLocal(), que debe llamarse dentro de
// db.transaction() junto con lo demás que se guarde (la venta, el apoyo...). Si esa
// transacción falla, llamar await plan.revertir().
//   movimientos: [{ producto_id, sucursal_id, tipo: 'entrada'|'salida'|'venta'|'ajuste', cantidad, minimo?, nota?, validar? }]
//   opciones.permitirSinConexion: solo para ventas y cancelaciones (se encolan si no hay internet)
async function preparar(movimientos, { usuarioId = null, permitirSinConexion = false } = {}) {
  const movs = (movimientos || []).map(normalizarMovimiento);
  const grupos = agrupar(movs);
  if (grupos.length === 0) return { pendiente: false, aplicarLocal: () => [], revertir: async () => {} };

  const faltantes = await catalogo.asegurarLocales(grupos.map((g) => g.producto_id));
  if (faltantes.length) {
    throw new ErrorApp(`El producto ${faltantes[0]} no existe en esta computadora`, { status: 404, codigo: 'PRODUCTO' });
  }
  await asegurarSucursales(grupos.map((g) => g.sucursal_id));
  const sucursalFaltante = grupos.find((g) => !stmt.sucursalLocal.get(g.sucursal_id));
  if (sucursalFaltante) throw new ErrorApp('Sucursal no válida', { status: 400 });

  if (!modoCentral()) {
    return {
      pendiente: false,
      aplicarLocal() {
        return grupos.map((g) => {
          const fila = stmt.filaLocal.get(g.producto_id, g.sucursal_id);
          const { final, pasos } = calcular(g, fila ? fila.existencia : 0);
          const minimo = g.minimo !== null ? g.minimo : fila ? r2(fila.minimo) : 0;
          stmt.upsertLocal.run(g.producto_id, g.sucursal_id, final, minimo);
          g.movs.forEach((m, i) => registrarMovimientoLocal(m, usuarioId, pasos[i]));
          return { producto_id: g.producto_id, sucursal_id: g.sucursal_id, existencia: final, minimo, pendiente: false };
        });
      },
      revertir: async () => {},
    };
  }

  let aplicados = [];
  let sinRed = [];
  if (centralDisponible() || !permitirSinConexion) {
    const intentos = await enParalelo(grupos, 8, (g) => casCentral(g));
    const errores = [];
    intentos.forEach((r, i) => {
      if (r.status === 'fulfilled') aplicados.push(r.value);
      else if (r.reason && r.reason.sinConexion) sinRed.push(grupos[i]);
      else errores.push(r.reason);
    });
    if (errores.length || (sinRed.length && !permitirSinConexion)) {
      await compensar(aplicados, usuarioId);
      throw errores[0] || sinConexion();
    }
  } else {
    sinRed = grupos;
  }
  if (sinRed.some((g) => g.movs.some((m) => m.fijar !== null))) {
    await compensar(aplicados, usuarioId);
    throw sinConexion('Los ajustes de inventario necesitan conexión con la central');
  }

  let movimientosSinRegistrar = [];
  if (aplicados.length) {
    const filas = filasMovimiento(aplicados, usuarioId);
    try {
      await insertarMovimientosCentral(filas);
    } catch (error) {
      if (!error.sinConexion) console.error('No se pudo registrar el movimiento en la central:', error.message);
      movimientosSinRegistrar = filas;
    }
  }

  return {
    pendiente: sinRed.length > 0,
    aplicarLocal() {
      const salida = [];
      for (const r of aplicados) {
        if (stmt.productoLocal.get(r.producto_id) && stmt.sucursalLocal.get(r.sucursal_id)) {
          stmt.upsertLocal.run(r.producto_id, r.sucursal_id, r2(r.existencia + pendienteDe(r.producto_id, r.sucursal_id)), r.minimo);
        }
        r.movs.forEach((m, i) => registrarMovimientoLocal(m, usuarioId, r.pasos[i]));
        salida.push({ producto_id: r.producto_id, sucursal_id: r.sucursal_id, existencia: r.existencia, minimo: r.minimo, pendiente: false });
      }
      for (const f of movimientosSinRegistrar) encolar({ ...f, delta: 0, estado: 'movimiento' });
      for (const g of sinRed) {
        // Sin conexión: se valida contra la copia local y el descuento queda en la cola
        const fila = stmt.filaLocal.get(g.producto_id, g.sucursal_id);
        const { final, pasos } = calcular(g, fila ? fila.existencia : 0);
        const minimo = fila ? r2(fila.minimo) : 0;
        stmt.upsertLocal.run(g.producto_id, g.sucursal_id, final, minimo);
        g.movs.forEach((m, i) => {
          registrarMovimientoLocal(m, usuarioId, pasos[i], ' (sin conexión)');
          encolar({ ...m, usuario_id: usuarioId, estado: 'delta' });
        });
        salida.push({ producto_id: g.producto_id, sucursal_id: g.sucursal_id, existencia: final, minimo, pendiente: true });
      }
      return salida;
    },
    async revertir() {
      await compensar(aplicados, usuarioId, { registrar: movimientosSinRegistrar.length === 0 });
    },
  };
}

// Prepara y aplica en un solo paso (cuando no hay nada más que guardar en la misma transacción)
async function aplicar(movimientos, opciones = {}) {
  const plan = await preparar(movimientos, opciones);
  try {
    return db.transaction(() => plan.aplicarLocal())();
  } catch (error) {
    await plan.revertir();
    throw error;
  }
}

// Cambiar solo el mínimo (sin mover existencia)
async function fijarMinimo(productoId, sucursalId, minimo) {
  const p = Number(productoId);
  const s = Number(sucursalId);
  const valor = Number(minimo);
  if (!Number.isFinite(valor) || valor < 0) throw new ErrorApp('Mínimo no válido');
  if ((await catalogo.asegurarLocales([p])).length) throw new ErrorApp('Producto no encontrado', { status: 404 });
  if (modoCentral()) {
    const { data } = await consultar(
      sb().from('inventario').update({ minimo: r2(valor), updated_at: new Date().toISOString() })
        .eq('producto_id', p).eq('sucursal_id', s).select('existencia,minimo')
    );
    if (!data || data.length === 0) {
      await consultar(sb().from('inventario').insert({ producto_id: p, sucursal_id: s, existencia: 0, minimo: r2(valor) }).select('id'));
    }
  }
  const fila = stmt.filaLocal.get(p, s);
  if (stmt.sucursalLocal.get(s)) stmt.upsertLocal.run(p, s, fila ? fila.existencia : 0, r2(valor));
  return { producto_id: p, sucursal_id: s, minimo: r2(valor) };
}

// ---------- Sincronización de la cola ----------
let sincronizando = null;
let ultimaSincronizacion = null;

function contarPendientes() {
  return db.prepare("SELECT COUNT(*) AS n FROM inventario_pendiente WHERE estado IN ('delta', 'movimiento')").get().n;
}

async function sincronizarPendientes() {
  if (!modoCentral()) return { enviados: 0, pendientes: 0 };
  if (sincronizando) return sincronizando;
  sincronizando = (async () => {
    let enviados = 0;
    const filas = db
      .prepare("SELECT * FROM inventario_pendiente WHERE estado IN ('delta', 'movimiento') ORDER BY id LIMIT 300")
      .all();
    for (const fila of filas) {
      const clave = `${fila.producto_id}:${fila.sucursal_id}`;
      try {
        let resultante = fila.existencia_resultante;
        if (fila.estado === 'delta') {
          filasSincronizando.add(clave);
          try {
            const hecho = await casCentral(
              {
                producto_id: fila.producto_id,
                sucursal_id: fila.sucursal_id,
                minimo: null,
                movs: [{ producto_id: fila.producto_id, sucursal_id: fila.sucursal_id, delta: r2(fila.delta), fijar: null, validar: false }],
              },
              { validar: false }
            );
            resultante = hecho.existencia;
            db.transaction(() => {
              db.prepare("UPDATE inventario_pendiente SET estado = 'movimiento', existencia_resultante = ? WHERE id = ?")
                .run(resultante, fila.id);
              if (stmt.productoLocal.get(fila.producto_id) && stmt.sucursalLocal.get(fila.sucursal_id)) {
                stmt.upsertLocal.run(fila.producto_id, fila.sucursal_id,
                  r2(hecho.existencia + pendienteDe(fila.producto_id, fila.sucursal_id)), hecho.minimo);
              }
            })();
          } finally {
            filasSincronizando.delete(clave);
          }
        }
        await insertarMovimientosCentral([{
          producto_id: fila.producto_id,
          sucursal_id: fila.sucursal_id,
          tipo: fila.tipo,
          cantidad: fila.cantidad,
          usuario_id: fila.usuario_id,
          nota: fila.estado === 'delta' && fila.nota ? `${fila.nota} (sin conexión)` : fila.nota,
          existencia_resultante: resultante,
        }]);
        db.prepare('DELETE FROM inventario_pendiente WHERE id = ?').run(fila.id);
        enviados += 1;
      } catch (error) {
        if (error.sinConexion) break;
        db.prepare(
          `UPDATE inventario_pendiente SET intentos = intentos + 1, ultimo_error = ?,
             estado = CASE WHEN intentos + 1 >= ? THEN 'error' ELSE estado END
           WHERE id = ?`
        ).run(String(error.message || error).slice(0, 300), MAX_INTENTOS_SINCRONIZACION, fila.id);
      }
    }
    ultimaSincronizacion = new Date().toISOString();
    return { enviados, pendientes: contarPendientes() };
  })().finally(() => {
    sincronizando = null;
  });
  return sincronizando;
}

function lanzarSincronizacion() {
  if (!modoCentral() || !centralDisponible() || sincronizando) return;
  if (contarPendientes() === 0) return;
  sincronizarPendientes().catch((error) => console.error('Error al sincronizar inventario:', error.message));
}

function estadoSincronizacion() {
  const errores = db
    .prepare(
      `SELECT q.id, q.producto_id, p.descripcion, q.sucursal_id, q.tipo, q.cantidad, q.nota, q.intentos,
              q.ultimo_error, q.creado
       FROM inventario_pendiente q LEFT JOIN productos p ON p.id = q.producto_id
       WHERE q.estado = 'error' ORDER BY q.id DESC LIMIT 50`
    )
    .all();
  return {
    ...estadoCentral(),
    pendientes: contarPendientes(),
    errores: errores.length,
    detalle_errores: errores,
    ultima_sincronizacion: ultimaSincronizacion,
  };
}

// Vuelve a intentar (o descarta) los movimientos que fallaron demasiadas veces
function reintentarErrores() {
  return db
    .prepare(
      `UPDATE inventario_pendiente SET intentos = 0, ultimo_error = '',
         estado = CASE WHEN existencia_resultante IS NULL THEN 'delta' ELSE 'movimiento' END
       WHERE estado = 'error'`
    )
    .run().changes;
}

function descartarError(id) {
  return db.prepare("DELETE FROM inventario_pendiente WHERE id = ? AND estado = 'error'").run(id).changes;
}

// ---------- Copia completa (reportes, sugerencias, bajo mínimo) ----------
let ultimoRefrescoCompleto = 0;
let refrescoEnCurso = null;

async function refrescarInventarioCompleto() {
  if (!modoCentral()) return { filas: 0 };
  const PAGINA = 1000;
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data } = await consultar(
      sb().from('inventario').select('producto_id,sucursal_id,existencia,minimo').order('id').range(desde, desde + PAGINA - 1)
    );
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  await catalogo.asegurarLocales(filas.map((f) => f.producto_id));
  await asegurarSucursales(filas.map((f) => f.sucursal_id));
  escribirCache(filas);
  // Filas locales que la central ya no tiene: solo cuenta lo pendiente de subir
  const claves = new Set(filas.map((f) => `${Number(f.producto_id)}:${Number(f.sucursal_id)}`));
  db.transaction(() => {
    for (const local of db.prepare('SELECT producto_id, sucursal_id FROM inventario').all()) {
      const clave = `${local.producto_id}:${local.sucursal_id}`;
      if (claves.has(clave) || filasSincronizando.has(clave)) continue;
      db.prepare('UPDATE inventario SET existencia = ? WHERE producto_id = ? AND sucursal_id = ?')
        .run(pendienteDe(local.producto_id, local.sucursal_id), local.producto_id, local.sucursal_id);
    }
  })();
  ultimoRefrescoCompleto = Date.now();
  return { filas: filas.length };
}

// Antes de una consulta agregada sobre la copia local, la trae al día si es vieja
async function asegurarCopiaFresca({ maxEdadMs = 30000 } = {}) {
  if (!modoCentral()) return 'local';
  if (Date.now() - ultimoRefrescoCompleto < maxEdadMs) return 'central';
  if (!centralDisponible()) return 'local';
  if (!refrescoEnCurso) {
    refrescoEnCurso = refrescarInventarioCompleto().finally(() => {
      refrescoEnCurso = null;
    });
  }
  try {
    await refrescoEnCurso;
    return 'central';
  } catch (error) {
    if (error.sinConexion) return 'local';
    throw error;
  }
}

// Productos en o por debajo de su mínimo en una sucursal
async function bajoMinimo(sucursalId) {
  const fuente = await asegurarCopiaFresca({ maxEdadMs: 10000 });
  const filas = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.descripcion, i.existencia, i.minimo
       FROM inventario i JOIN productos p ON p.id = i.producto_id
       WHERE i.sucursal_id = ? AND p.activo = 1 AND p.usa_inventario = 1 AND p.id <> 0
         AND i.minimo > 0 AND i.existencia <= i.minimo
       ORDER BY (i.existencia <= 0) DESC, p.descripcion`
    )
    .all(Number(sucursalId));
  return { fuente, filas };
}

// ---------- Kardex (historial de movimientos de un producto) ----------
function nombreUsuario(id) {
  if (!id) return '';
  return db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(id)?.nombre || `Usuario ${id}`;
}

function nombreSucursal(id) {
  return db.prepare('SELECT nombre FROM sucursales WHERE id = ?').get(id)?.nombre || `Sucursal ${id}`;
}

function deltaDe(tipo, cantidad) {
  if (tipo === 'entrada') return r2(cantidad);
  if (tipo === 'salida' || tipo === 'venta') return -r2(cantidad);
  return null; // ajuste: fija la existencia
}

async function kardex(productoId, { sucursalId = null, limite = 200 } = {}) {
  const p = Number(productoId);
  const s = sucursalId ? Number(sucursalId) : null;
  const tope = Math.min(Math.max(Number(limite) || 200, 1), 1000);
  const pendientes = db
    .prepare(
      `SELECT id, producto_id, sucursal_id, tipo, cantidad, usuario_id, nota, creado AS fecha, estado
       FROM inventario_pendiente WHERE producto_id = ? ${s ? 'AND sucursal_id = ?' : ''} ORDER BY id DESC`
    )
    .all(p, ...(s ? [s] : []))
    .map((f) => ({
      id: `pendiente-${f.id}`,
      fecha: f.fecha,
      sucursal_id: f.sucursal_id,
      sucursal: nombreSucursal(f.sucursal_id),
      tipo: f.tipo,
      cantidad: r2(f.cantidad),
      delta: deltaDe(f.tipo, f.cantidad),
      existencia_resultante: null,
      usuario: nombreUsuario(f.usuario_id),
      nota: f.nota,
      pendiente: true,
      error: f.estado === 'error',
    }));

  if (modoCentral() && centralDisponible()) {
    try {
      const columnas = `id,producto_id,sucursal_id,tipo,cantidad,usuario_id,nota,fecha${centralTieneResultante ? ',existencia_resultante' : ''}`;
      let consulta = sb().from('movimientos_inventario').select(columnas).eq('producto_id', p);
      if (s) consulta = consulta.eq('sucursal_id', s);
      let resultado;
      try {
        resultado = await consultar(consulta.order('id', { ascending: false }).limit(tope));
      } catch (error) {
        if (!centralTieneResultante || !/existencia_resultante|42703|PGRST204/i.test(`${error.codigo} ${error.message}`)) throw error;
        centralTieneResultante = false;
        return kardex(productoId, { sucursalId, limite });
      }
      const filas = (resultado.data || []).map((f) => ({
        id: f.id,
        fecha: fechaLocal(f.fecha),
        sucursal_id: Number(f.sucursal_id),
        sucursal: nombreSucursal(f.sucursal_id),
        tipo: f.tipo,
        cantidad: r2(f.cantidad),
        delta: deltaDe(f.tipo, f.cantidad),
        existencia_resultante: f.existencia_resultante == null ? null : r2(f.existencia_resultante),
        usuario: nombreUsuario(f.usuario_id),
        nota: f.nota || '',
        pendiente: false,
      }));
      return { fuente: 'central', movimientos: [...pendientes, ...filas] };
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  const filas = db
    .prepare(
      `SELECT m.id, m.fecha, m.sucursal_id, s.nombre AS sucursal, m.tipo, m.cantidad, m.existencia_resultante,
              u.nombre AS usuario, m.nota
       FROM movimientos_inventario m
       LEFT JOIN sucursales s ON s.id = m.sucursal_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.producto_id = ? ${s ? 'AND m.sucursal_id = ?' : ''}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(p, ...(s ? [s] : []), tope)
    .map((f) => ({ ...f, cantidad: r2(f.cantidad), delta: deltaDe(f.tipo, f.cantidad), pendiente: false }));
  // En modo central sin conexión, el historial local ya incluye lo pendiente de subir
  return { fuente: 'local', movimientos: filas };
}

// ---------- Arranque ----------
let temporizadores = [];

function iniciar() {
  if (!modoCentral() || temporizadores.length) return;
  const refrescarTodo = async () => {
    try {
      await sincronizarSucursales();
      await catalogo.sincronizarCatalogoCompleto();
      await refrescarInventarioCompleto();
      await sincronizarPendientes();
    } catch (error) {
      if (!error.sinConexion) console.error('No se pudo sincronizar con la central:', error.message);
    }
  };
  temporizadores = [
    setTimeout(refrescarTodo, 1500),
    setInterval(() => lanzarSincronizacion(), 15000),
    setInterval(refrescarTodo, 10 * 60 * 1000),
  ];
  for (const t of temporizadores) t.unref?.();
}

module.exports = {
  TIPOS,
  fechaLocal,
  sucursalesActivas,
  sincronizarSucursales,
  asegurarSucursales,
  leerExistencias,
  existenciaDe,
  conExistencias,
  preparar,
  aplicar,
  fijarMinimo,
  sincronizarPendientes,
  estadoSincronizacion,
  reintentarErrores,
  descartarError,
  asegurarCopiaFresca,
  refrescarInventarioCompleto,
  bajoMinimo,
  kardex,
  iniciar,
};
