// Lo del jefe en esta computadora (movimientos, registro de cambios, inventario de las sucursales e
// inventario del día) con las mismas reglas que el celular: el código vive en
// supabase/functions/movil/supervision.mjs y aquí se conecta con la central y el inventario.
// Sin conexión con la central (o sin Supabase), los movimientos y los cambios se leen de lo que
// tiene esta computadora; el inventario del día y el resumen de sucursales necesitan la central.
const db = require('./db');
const inventario = require('./inventario');
const bitacora = require('./bitacora');
const { ErrorApp, modoCentral, consultar, sb } = require('./central');
const {
  crearSupervision, claseDeMovimiento, deltaDe, esJefe, TIPOS_CAMBIO, GRUPOS_CAMBIO, TIPOS_MOVIMIENTO,
} = require('../supabase/functions/movil/supervision.mjs');
const { crearVentasCentral } = require('../supabase/functions/movil/ventas.mjs');

const compartida = crearSupervision({
  sb,
  consultar,
  ErrorApp,
  aplicarMovimientos: (movimientos, usuarioId) => inventario.aplicar(movimientos, { usuarioId }),
  existenciaActual: async (productoId, sucursalId) => (await inventario.existenciaDe(productoId, sucursalId)).existencia,
  registrarCambio: (cambio) => bitacora.registrar(cambio),
  zona: process.env.FARMACIA_ZONA_HORARIA || undefined,
  ventasHoy: () => ventasCentral.hoyPorSucursal(),
});

// Ventas de todas las farmacias (lo que suben las cajas; ver src/subir-ventas.js)
const ventasCentral = crearVentasCentral({ sb, consultar, ErrorApp, fechas: compartida });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function necesitaCentral(nombre = 'Esta parte del sistema') {
  if (!modoCentral()) {
    throw new ErrorApp(`${nombre} necesita la conexión con la central (Supabase)`, { status: 503, codigo: 'SOLO_CENTRAL' });
  }
}

// Intenta con la central; si no hay conexión, no hay Supabase o a la central le faltan las tablas
// nuevas (todavía no se actualiza), usa lo de esta computadora
async function conRespaldoLocal(enCentral, local) {
  if (modoCentral()) {
    try {
      return await enCentral();
    } catch (error) {
      if (!error.sinConexion && error.codigo !== 'FALTA_ACTUALIZAR_CENTRAL') throw error;
    }
  }
  return local();
}

// Mismas reglas que en la central: el jefe ve todas las sucursales, un administrador la suya
function sucursalDeMovimientos(usuario, pedida) {
  if (esJefe(usuario)) return Number(pedida) || null;
  if (usuario.rol === 'admin') return Number(usuario.sucursal_id);
  throw new ErrorApp('Los movimientos los ven el jefe y los administradores', { status: 403, codigo: 'SOLO_ADMIN' });
}

const PREFIJOS_CLASE = {
  apoyo: ['Apoyo folio', 'Cancelación del apoyo'],
  conteo: ['Conteo físico', 'Inventario del día'],
  cancelacion: ['Cancelación de la venta'],
  recepcion: ['Recepción de mercancía'],
  alta: ['Existencia inicial'],
};

// 'AAAA-MM-DD' -> rango de texto con la hora de esta computadora (así se guardan las fechas aquí)
function rangoLocal(filtros, dias = 1) {
  const { desde, hasta } = compartida.rangoDias(filtros.desde, filtros.hasta, { dias });
  const [a, m, d] = hasta.split('-').map(Number);
  const siguiente = new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
  return { desde, hasta, inicio: `${desde} 00:00:00`, fin: `${siguiente} 00:00:00` };
}

function movimientosLocales(usuario, filtros = {}) {
  const sucursal = sucursalDeMovimientos(usuario, filtros.sucursal_id);
  const { desde, hasta, inicio, fin } = rangoLocal(filtros);
  const limite = Math.min(Math.max(Number(filtros.limite) || 100, 1), 200);
  const salto = Math.max(0, Number(filtros.desde_fila) || 0);
  const condiciones = ['m.fecha >= @inicio', 'm.fecha < @fin'];
  const valores = { inicio, fin, limite: limite + 1, salto };
  if (sucursal) { condiciones.push('m.sucursal_id = @sucursal'); valores.sucursal = sucursal; }
  if (Number(filtros.usuario_id)) { condiciones.push('m.usuario_id = @usuario'); valores.usuario = Number(filtros.usuario_id); }
  const tipo = TIPOS_MOVIMIENTO.includes(filtros.tipo) ? filtros.tipo : '';
  if (['venta', 'entrada', 'salida', 'ajuste'].includes(tipo)) { condiciones.push('m.tipo = @tipo'); valores.tipo = tipo; }
  if (PREFIJOS_CLASE[tipo]) {
    condiciones.push(`(${PREFIJOS_CLASE[tipo].map((_, i) => `m.nota LIKE @prefijo${i}`).join(' OR ')})`);
    PREFIJOS_CLASE[tipo].forEach((p, i) => { valores[`prefijo${i}`] = `${p}%`; });
  }
  const texto = String(filtros.q || '').trim().slice(0, 80);
  if (texto) {
    condiciones.push("(p.codigo_barras = @codigo OR p.descripcion LIKE @texto ESCAPE '\\')");
    valores.codigo = texto;
    valores.texto = `%${texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  const donde = condiciones.join(' AND ');
  const filas = db.prepare(
    `SELECT m.id, m.fecha, m.sucursal_id, s.nombre AS sucursal, m.producto_id, p.descripcion AS producto, p.codigo_barras,
            m.tipo, m.cantidad, m.existencia_resultante, m.usuario_id, u.nombre AS usuario, m.nota,
            (SELECT m2.existencia_resultante FROM movimientos_inventario m2
              WHERE m2.producto_id = m.producto_id AND m2.sucursal_id = m.sucursal_id AND m2.id < m.id
              ORDER BY m2.id DESC LIMIT 1) AS anterior
     FROM movimientos_inventario m
     LEFT JOIN productos p ON p.id = m.producto_id
     LEFT JOIN sucursales s ON s.id = m.sucursal_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE ${donde}
     ORDER BY m.id DESC LIMIT @limite OFFSET @salto`
  ).all(valores);
  let resumen = null;
  if (!salto) {
    const todas = db.prepare(
      `SELECT m.tipo, m.cantidad, m.nota FROM movimientos_inventario m LEFT JOIN productos p ON p.id = m.producto_id
       WHERE ${donde} ORDER BY m.id DESC LIMIT 3000`
    ).all(valores);
    const porClase = {};
    for (const f of todas) {
      const clase = claseDeMovimiento(f.tipo, f.nota);
      const actual = porClase[clase] || { movimientos: 0, piezas: 0 };
      actual.movimientos += 1;
      actual.piezas = r2(actual.piezas + Number(f.cantidad || 0));
      porClase[clase] = actual;
    }
    resumen = { total: todas.length, por_clase: porClase, parcial: todas.length >= 3000 };
  }
  const visibles = filas.slice(0, limite);
  return {
    fuente: 'local',
    desde,
    hasta,
    sucursal_id: sucursal,
    movimientos: visibles.map((f) => {
      const delta = deltaDe(f.tipo, f.cantidad);
      const hay = f.existencia_resultante == null ? null : r2(f.existencia_resultante);
      const habia = hay == null ? null : delta == null ? (f.anterior == null ? null : r2(f.anterior)) : r2(hay - delta);
      return {
        id: f.id,
        fecha: f.fecha,
        sucursal_id: f.sucursal_id,
        sucursal: f.sucursal || '',
        producto_id: f.producto_id,
        producto: f.producto || `Producto ${f.producto_id}`,
        codigo_barras: f.codigo_barras || null,
        tipo: f.tipo,
        clase: claseDeMovimiento(f.tipo, f.nota),
        cantidad: r2(f.cantidad),
        delta,
        habia,
        hay,
        usuario_id: f.usuario_id,
        usuario: f.usuario || '',
        nota: f.nota || '',
      };
    }),
    hay_mas: filas.length > limite,
    siguiente: salto + visibles.length,
    resumen,
  };
}

function filtrosLocales(usuario) {
  const jefe = esJefe(usuario);
  if (!jefe && usuario.rol !== 'admin') throw new ErrorApp('Los movimientos los ven el jefe y los administradores', { status: 403, codigo: 'SOLO_ADMIN' });
  const sucursales = db.prepare('SELECT id, nombre, es_central FROM sucursales WHERE activa = 1 ORDER BY es_central DESC, id').all()
    .filter((s) => jefe || s.id === Number(usuario.sucursal_id));
  const usuarios = db.prepare(`SELECT id, nombre, sucursal_id, activo FROM usuarios WHERE usuario NOT LIKE '%#%' ${jefe ? '' : 'AND sucursal_id = ?'} ORDER BY nombre`)
    .all(...(jefe ? [] : [Number(usuario.sucursal_id)]))
    .map((u) => ({ ...u, activo: u.activo === 1 }));
  return { jefe, sucursales, usuarios, tipos: TIPOS_MOVIMIENTO, grupos_cambio: Object.keys(GRUPOS_CAMBIO) };
}

function cambioLocal(f) {
  return {
    id: `local-${f.id}`,
    clave: f.clave,
    fecha: f.fecha,
    sucursal_id: f.sucursal_id,
    sucursal: f.sucursal || '',
    usuario_id: f.usuario_id,
    usuario: f.usuario || '',
    tipo: f.tipo,
    titulo: TIPOS_CAMBIO[f.tipo] || f.tipo,
    descripcion: f.descripcion || '',
    detalle: f.detalle ? JSON.parse(f.detalle) : null,
    alerta: Boolean(f.alerta),
    origen: 'computadora',
    por_subir: !f.subido,
  };
}

function cambiosLocales(filtros, { soloPorSubir = false } = {}) {
  const { desde, hasta, inicio, fin } = rangoLocal(filtros, 7);
  const condiciones = ['b.fecha >= @inicio', 'b.fecha < @fin'];
  const valores = { inicio, fin };
  if (soloPorSubir) condiciones.push('b.subido = 0');
  if (Number(filtros.sucursal_id)) { condiciones.push('b.sucursal_id = @sucursal'); valores.sucursal = Number(filtros.sucursal_id); }
  if (Number(filtros.usuario_id)) { condiciones.push('b.usuario_id = @usuario'); valores.usuario = Number(filtros.usuario_id); }
  if (filtros.grupo === 'alertas') condiciones.push('b.alerta = 1');
  else if (GRUPOS_CAMBIO[filtros.grupo]) {
    condiciones.push(`b.tipo IN (${GRUPOS_CAMBIO[filtros.grupo].map((_, i) => `@tipo${i}`).join(',')})`);
    GRUPOS_CAMBIO[filtros.grupo].forEach((t, i) => { valores[`tipo${i}`] = t; });
  }
  const limite = Math.min(Math.max(Number(filtros.limite) || 100, 1), 200);
  const salto = soloPorSubir ? 0 : Math.max(0, Number(filtros.desde_fila) || 0);
  const filas = db.prepare(
    `SELECT b.*, s.nombre AS sucursal, u.nombre AS usuario FROM bitacora b
     LEFT JOIN sucursales s ON s.id = b.sucursal_id LEFT JOIN usuarios u ON u.id = b.usuario_id
     WHERE ${condiciones.join(' AND ')} ORDER BY b.fecha DESC, b.id DESC LIMIT @limite OFFSET @salto`
  ).all({ ...valores, limite: limite + 1, salto });
  return { desde, hasta, filas: filas.slice(0, limite), hay_mas: filas.length > limite, siguiente: salto + Math.min(filas.length, limite) };
}

async function listarCambios(usuario, filtros = {}) {
  if (!esJefe(usuario)) throw new ErrorApp('Esto solo lo ve el jefe', { status: 403, codigo: 'SOLO_JEFE' });
  return conRespaldoLocal(async () => {
    // Lo de esta computadora que todavía no llega a la central se toma antes de leerla (si se sube
    // mientras tanto, la central ya lo trae y no se repite) y va primero: es lo más reciente
    const porSubir = Number(filtros.desde_fila) ? [] : cambiosLocales(filtros, { soloPorSubir: true }).filas;
    await bitacora.subir().catch(() => {});
    const r = await compartida.listarCambios(usuario, filtros);
    const enCentral = new Set(r.cambios.map((c) => c.clave));
    r.cambios = [...porSubir.filter((f) => !enCentral.has(f.clave)).map(cambioLocal), ...r.cambios];
    return r;
  }, () => {
    const r = cambiosLocales(filtros);
    return { fuente: 'local', desde: r.desde, hasta: r.hasta, cambios: r.filas.map(cambioLocal), hay_mas: r.hay_mas, siguiente: r.siguiente };
  });
}

module.exports = {
  compartida,
  ventasCentral,
  esJefe,
  necesitaCentral,
  movimientos: (usuario, filtros) => conRespaldoLocal(() => compartida.movimientos(usuario, filtros), () => movimientosLocales(usuario, filtros)),
  filtros: (usuario) => conRespaldoLocal(() => compartida.filtros(usuario), () => filtrosLocales(usuario)),
  listarCambios,
};
