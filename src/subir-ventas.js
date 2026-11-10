// Sube a la central las ventas, cortes, clientes con crédito y abonos de esta computadora (su "caja")
// para que el jefe vea todas las farmacias. La caja sigue cobrando con su propia base aunque no haya
// internet: lo pendiente ("subir" = 1) se sube solo en cuanto hay conexión. Mientras se sube, la fila
// queda en 2; si algo cambia en ese momento (un trigger la regresa a 1), se vuelve a subir.
// Cada fila lleva clave = clave de la caja + su id aquí, así subirla dos veces no la duplica.
const crypto = require('crypto');
const db = require('./db');
const { modoCentral, centralDisponible, consultar, sb } = require('./central');

const CADA_MS = Number(process.env.FARMACIA_SUBIDA_MS) || 15000;
const NO_SE_PUEDE = 3; // de una sucursal que la central no tiene: no se reintenta

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function leerConfig(clave) {
  return db.prepare('SELECT valor FROM sync_config WHERE clave = ?').get(clave)?.valor || null;
}

function guardarConfig(clave, valor) {
  db.prepare('INSERT INTO sync_config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, String(valor));
}

// Identidad de esta computadora como caja (se crea una sola vez)
function claveCaja() {
  let clave = leerConfig('caja_clave');
  if (!clave) {
    clave = crypto.randomUUID();
    guardarConfig('caja_clave', clave);
  }
  return clave;
}

// 'AAAA-MM-DD HH:MM:SS' (hora de esta computadora) -> ISO
function aIso(fecha) {
  if (!fecha) return null;
  const valor = new Date(String(fecha).replace(' ', 'T'));
  return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
}

// La caja en la central (número 1, 2... dentro de su sucursal)
async function cajaCentral(sucursalId) {
  const clave = claveCaja();
  const guardada = leerConfig('caja_central');
  if (guardada) {
    const caja = JSON.parse(guardada);
    if (caja.clave === clave) return caja;
  }
  const buscar = async () => (await consultar(sb().from('cajas').select('id,numero,sucursal_id').eq('clave', clave).limit(1))).data || [];
  let filas = await buscar();
  if (!filas.length) {
    const { data: otras } = await consultar(sb().from('cajas').select('numero').eq('sucursal_id', sucursalId).order('numero', { ascending: false }).limit(1));
    const numero = Number(otras && otras[0] ? otras[0].numero : 0) + 1;
    try {
      await consultar(sb().from('cajas').insert({ clave, sucursal_id: sucursalId, numero, nombre: `Caja ${numero}` }));
    } catch (error) {
      if (error.codigo !== '23505') throw error;
    }
    filas = await buscar();
  }
  const caja = { clave, id: Number(filas[0].id), numero: Number(filas[0].numero), sucursal_id: Number(filas[0].sucursal_id) };
  guardarConfig('caja_central', JSON.stringify(caja));
  return caja;
}

function apartar(tabla, limite) {
  return db.transaction(() => {
    const ids = db.prepare(`SELECT id FROM ${tabla} WHERE subir = 1 ORDER BY id LIMIT ?`).all(limite).map((f) => f.id);
    if (ids.length) db.prepare(`UPDATE ${tabla} SET subir = 2 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return ids;
  })();
}

function marcar(tabla, ids, valor) {
  if (!ids.length) return;
  db.prepare(`UPDATE ${tabla} SET subir = ? WHERE subir = 2 AND id IN (${ids.map(() => '?').join(',')})`).run(valor, ...ids);
}

const enLista = (ids) => ids.map(() => '?').join(',');

// ---------- Lo que se sube de cada tabla ----------
function clientesParaSubir(caja, ids) {
  return db.prepare(
    `SELECT c.*,
       ROUND(COALESCE((SELECT SUM(total) FROM ventas v WHERE v.cliente_id = c.id AND v.forma_pago = 'credito' AND v.cancelada = 0), 0)
           - COALESCE((SELECT SUM(monto) FROM abonos a WHERE a.cliente_id = c.id), 0), 2) AS saldo,
       (SELECT MAX(fecha) FROM ventas v WHERE v.cliente_id = c.id AND v.cancelada = 0) AS ultima_compra,
       (SELECT MAX(fecha) FROM abonos a WHERE a.cliente_id = c.id) AS ultimo_abono
     FROM clientes c WHERE c.id IN (${enLista(ids)})`
  ).all(...ids).map((c) => ({
    id: c.id,
    sucursal_id: c.sucursal_id,
    fila: {
      clave: `${caja.clave}:${c.id}`, caja_id: caja.id, sucursal_id: c.sucursal_id, cliente_local_id: c.id,
      nombre: c.nombre, telefono: c.telefono || '', limite_credito: r2(c.limite_credito), credito_autorizado: Boolean(c.credito_autorizado),
      notas: c.notas || '', activo: Boolean(c.activo), saldo: r2(c.saldo),
      ultima_compra: aIso(c.ultima_compra), ultimo_abono: aIso(c.ultimo_abono), updated_at: new Date().toISOString(),
    },
  }));
}

function ventasParaSubir(caja, ids) {
  const detalle = db.prepare(
    `SELECT d.*, CASE WHEN d.producto_id = 0 THEN '' ELSE COALESCE(p.departamento, '') END AS departamento
     FROM venta_detalle d LEFT JOIN productos p ON p.id = d.producto_id WHERE d.venta_id IN (${enLista(ids)}) ORDER BY d.id`
  ).all(...ids);
  return db.prepare(
    `SELECT v.*, c.nombre AS cliente_nombre FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id WHERE v.id IN (${enLista(ids)})`
  ).all(...ids).map((v) => {
    const lineas = detalle.filter((d) => d.venta_id === v.id);
    const fecha = aIso(v.fecha);
    return {
      id: v.id,
      sucursal_id: v.sucursal_id,
      central_id: v.central_id,
      fila: {
        clave: `${caja.clave}:${v.id}`, caja_id: caja.id, sucursal_id: v.sucursal_id, venta_local_id: v.id, folio: v.folio,
        usuario_id: v.usuario_id, cliente_clave: v.cliente_id ? `${caja.clave}:${v.cliente_id}` : null, cliente_nombre: v.cliente_nombre || '',
        forma_pago: v.forma_pago, total: r2(v.total),
        costo: r2(lineas.reduce((t, d) => t + (Number(d.costo_unitario) || 0) * (Number(d.cantidad) || 0), 0)),
        piezas: Math.round(lineas.reduce((t, d) => t + (Number(d.cantidad) || 0), 0) * 1000) / 1000,
        pago: r2(v.pago), cambio: r2(v.cambio), pago_usd: v.pago_usd, tipo_cambio: v.tipo_cambio,
        pago_efectivo: v.pago_efectivo, pago_tarjeta: v.pago_tarjeta, nota: v.nota || '', fecha,
        cancelada: Boolean(v.cancelada), cancelada_por: v.cancelada_por || null, cancelada_fecha: aIso(v.cancelada_fecha),
        motivo_cancelacion: v.motivo_cancelacion || '', corte_clave: v.corte_id ? `${caja.clave}:${v.corte_id}` : null,
        updated_at: new Date().toISOString(),
      },
      detalle: lineas.map((d) => ({
        sucursal_id: v.sucursal_id, fecha, producto_id: d.producto_id, descripcion: d.descripcion, departamento: d.departamento,
        cantidad: d.cantidad, precio_unitario: r2(d.precio_unitario), precio_lista: d.precio_lista == null ? null : r2(d.precio_lista),
        costo_unitario: r2(d.costo_unitario), importe: r2(d.importe),
      })),
    };
  });
}

function abonosParaSubir(caja, ids) {
  return db.prepare(
    `SELECT a.*, c.nombre AS cliente_nombre FROM abonos a LEFT JOIN clientes c ON c.id = a.cliente_id WHERE a.id IN (${enLista(ids)})`
  ).all(...ids).map((a) => ({
    id: a.id,
    sucursal_id: a.sucursal_id,
    fila: {
      clave: `${caja.clave}:${a.id}`, caja_id: caja.id, sucursal_id: a.sucursal_id, abono_local_id: a.id,
      cliente_clave: `${caja.clave}:${a.cliente_id}`, cliente_nombre: a.cliente_nombre || '', usuario_id: a.usuario_id,
      monto: r2(a.monto), forma_pago: a.forma_pago || 'efectivo', saldo_anterior: a.saldo_anterior, saldo_nuevo: a.saldo_nuevo,
      fecha: aIso(a.fecha), corte_clave: a.corte_id ? `${caja.clave}:${a.corte_id}` : null,
    },
  }));
}

function cortesParaSubir(caja, ids) {
  const { cargarCorte } = require('./routes/cortes');
  return ids.map((id) => {
    const corte = cargarCorte(id);
    const vendido = corte.estadisticas ? corte.estadisticas.vendido
      : r2((corte.total_efectivo || 0) + (corte.total_tarjeta || 0) + (corte.total_credito || 0) + (corte.total_dolares || 0));
    return {
      id,
      sucursal_id: corte.sucursal_id,
      fila: {
        clave: `${caja.clave}:${id}`, caja_id: caja.id, sucursal_id: corte.sucursal_id, corte_local_id: id, usuario_id: corte.usuario_id,
        fecha: aIso(corte.fecha), num_ventas: corte.num_ventas, total_vendido: r2(vendido), efectivo_esperado: r2(corte.efectivo_esperado),
        efectivo_contado: r2(corte.efectivo_contado), diferencia: r2(corte.diferencia), num_canceladas: corte.num_canceladas || 0,
        total_canceladas: r2(corte.total_canceladas), salidas_efectivo: r2(corte.salidas_efectivo), detalle: corte,
      },
    };
  });
}

const LOTES = { clientes: 200, ventas: 100, abonos: 200, cortes: 20 };
const ARMAR = { clientes: clientesParaSubir, ventas: ventasParaSubir, abonos: abonosParaSubir, cortes: cortesParaSubir };

async function subirLote(tabla, caja, sucursalesCentral) {
  const ids = apartar(tabla, LOTES[tabla]);
  if (!ids.length) return 0;
  try {
    const todos = ARMAR[tabla](caja, ids);
    const ajenos = todos.filter((r) => !sucursalesCentral.has(Number(r.sucursal_id))).map((r) => r.id);
    marcar(tabla, ajenos, NO_SE_PUEDE);
    const registros = todos.filter((r) => sucursalesCentral.has(Number(r.sucursal_id)));
    if (registros.length) {
      const { data } = await consultar(sb().from(tabla).upsert(registros.map((r) => r.fila), { onConflict: 'clave' }).select('id,clave'));
      if (tabla === 'ventas') {
        // El detalle de una venta no cambia: solo se sube la primera vez (si falló a medias, se repone completo)
        const porClave = new Map((data || []).map((f) => [f.clave, Number(f.id)]));
        const nuevas = registros.filter((r) => !r.central_id && porClave.has(r.fila.clave));
        if (nuevas.length) {
          await consultar(sb().from('venta_detalle').delete().in('venta_id', nuevas.map((r) => porClave.get(r.fila.clave))));
          const lineas = nuevas.flatMap((r) => r.detalle.map((d) => ({ ...d, venta_id: porClave.get(r.fila.clave) })));
          for (let i = 0; i < lineas.length; i += 1000) await consultar(sb().from('venta_detalle').insert(lineas.slice(i, i + 1000)));
          const guardar = db.prepare('UPDATE ventas SET central_id = ? WHERE id = ?');
          db.transaction(() => { for (const r of nuevas) guardar.run(porClave.get(r.fila.clave), r.id); })();
        }
      }
    }
    marcar(tabla, registros.map((r) => r.id), 0);
    return registros.length;
  } catch (error) {
    marcar(tabla, ids, 1);
    throw error;
  }
}

function pendientes() {
  const salida = {};
  for (const tabla of Object.keys(LOTES)) salida[tabla] = db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE subir IN (1, 2)`).get().n;
  return salida;
}

function sucursalPendiente() {
  for (const tabla of Object.keys(LOTES)) {
    const fila = db.prepare(`SELECT sucursal_id FROM ${tabla} WHERE subir = 1 ORDER BY id LIMIT 1`).get();
    if (fila) return Number(fila.sucursal_id);
  }
  return null;
}

let subiendo = null;
let avisado = false;
let ultimaSubida = null;

async function subir() {
  if (!modoCentral() || !centralDisponible()) return { subidos: 0 };
  if (subiendo) return subiendo;
  subiendo = (async () => {
    const sucursal = sucursalPendiente();
    if (!sucursal) return { subidos: 0 };
    let subidos = 0;
    try {
      const { data: sucursales } = await consultar(sb().from('sucursales').select('id'));
      const enCentral = new Set((sucursales || []).map((s) => Number(s.id)));
      const caja = await cajaCentral(enCentral.has(sucursal) ? sucursal : [...enCentral][0]);
      // Primero los clientes (las ventas los mencionan) y al final los cortes
      for (const tabla of ['clientes', 'ventas', 'abonos', 'cortes']) {
        for (let vuelta = 0; vuelta < 50; vuelta += 1) {
          const n = await subirLote(tabla, caja, enCentral);
          subidos += n;
          if (!n) break;
        }
      }
      await consultar(sb().from('cajas').update({ ultima_subida: new Date().toISOString() }).eq('id', caja.id)).catch(() => {});
      ultimaSubida = new Date().toISOString();
      avisado = false;
    } catch (error) {
      // Sin internet se reintenta en la siguiente vuelta; otros errores (por ejemplo, la central sin las
      // tablas nuevas) se avisan una vez en el registro del servidor
      if (!error.sinConexion && !avisado) console.error('No se pudieron subir las ventas a la central:', error.message);
      avisado = true;
    }
    return { subidos };
  })().finally(() => {
    subiendo = null;
  });
  return subiendo;
}

function estado() {
  const leida = leerConfig('caja_central');
  return { pendientes: pendientes(), caja: leida ? JSON.parse(leida) : null, ultima_subida: ultimaSubida };
}

let temporizador = null;
function iniciar() {
  // Lo que se quedó a medias si se apagó la computadora mientras subía
  for (const tabla of Object.keys(LOTES)) db.prepare(`UPDATE ${tabla} SET subir = 1 WHERE subir = 2`).run();
  if (!modoCentral() || temporizador) return;
  temporizador = setInterval(() => {
    subir().catch((error) => console.error('Error al subir las ventas:', error.message));
  }, CADA_MS);
  temporizador.unref?.();
}

module.exports = { subir, estado, iniciar, claveCaja };
