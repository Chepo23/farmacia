// Registro de cambios de esta computadora (precios, altas, usuarios, cancelaciones, cortes,
// salidas de efectivo, apoyos...). Se guarda aquí al momento, aunque no haya internet, y se sube
// solo a la central para que lo vea el jefe. Sin Supabase solo vive en esta computadora.
const crypto = require('crypto');
const db = require('./db');
const { modoCentral, centralDisponible, consultar, sb } = require('./central');

const insertar = db.prepare(
  `INSERT INTO bitacora (clave, sucursal_id, usuario_id, tipo, descripcion, detalle, alerta)
   VALUES (@clave, @sucursal_id, @usuario_id, @tipo, @descripcion, @detalle, @alerta)`
);

// Nunca detiene la operación que se está registrando: si algo falla, solo se avisa en el registro del servidor
function registrar({ usuario = null, sucursal_id = null, tipo, descripcion = '', detalle = null, alerta = false }) {
  try {
    insertar.run({
      clave: crypto.randomUUID(),
      sucursal_id: Number(sucursal_id) || Number(usuario?.sucursal_id) || null,
      usuario_id: usuario ? Number(usuario.id) || null : null,
      tipo: String(tipo),
      descripcion: String(descripcion || '').slice(0, 500),
      detalle: detalle ? JSON.stringify(detalle) : null,
      alerta: alerta ? 1 : 0,
    });
  } catch (error) {
    console.error('No se pudo guardar el cambio en el registro:', error.message);
    return;
  }
  subirPronto();
}

// 'AAAA-MM-DD HH:MM:SS' (hora de esta computadora) -> ISO
function aIso(fecha) {
  const valor = new Date(String(fecha).replace(' ', 'T'));
  return Number.isNaN(valor.getTime()) ? new Date().toISOString() : valor.toISOString();
}

let subiendo = null;
let pausaHasta = 0;
let avisado = false;

async function subir() {
  if (!modoCentral() || !centralDisponible() || Date.now() < pausaHasta) return { subidos: 0 };
  if (subiendo) return subiendo;
  subiendo = (async () => {
    let subidos = 0;
    for (let vuelta = 0; vuelta < 20; vuelta += 1) {
      const filas = db.prepare('SELECT * FROM bitacora WHERE subido = 0 ORDER BY id LIMIT 200').all();
      if (!filas.length) break;
      try {
        await consultar(sb().from('bitacora').upsert(filas.map((f) => ({
          clave: f.clave,
          fecha: aIso(f.fecha),
          sucursal_id: f.sucursal_id,
          usuario_id: f.usuario_id,
          tipo: f.tipo,
          descripcion: f.descripcion,
          detalle: f.detalle ? JSON.parse(f.detalle) : null,
          alerta: Boolean(f.alerta),
          origen: 'computadora',
        })), { onConflict: 'clave', ignoreDuplicates: true }));
      } catch (error) {
        if (!error.sinConexion) {
          // Por ejemplo, la central todavía no tiene la tabla: se reintenta más tarde
          pausaHasta = Date.now() + 10 * 60000;
          if (!avisado) console.error('No se pudo subir el registro de cambios a la central:', error.message);
          avisado = true;
        }
        break;
      }
      db.prepare(`UPDATE bitacora SET subido = 1 WHERE id IN (${filas.map(() => '?').join(',')})`).run(...filas.map((f) => f.id));
      subidos += filas.length;
      avisado = false;
    }
    return { subidos };
  })().finally(() => {
    subiendo = null;
  });
  return subiendo;
}

let temporizadorPronto = null;
function subirPronto() {
  if (!modoCentral() || temporizadorPronto) return;
  temporizadorPronto = setTimeout(() => {
    temporizadorPronto = null;
    subir().catch((error) => console.error('Error al subir el registro de cambios:', error.message));
  }, 1500);
  temporizadorPronto.unref?.();
}

function pendientes() {
  return db.prepare('SELECT COUNT(*) AS n FROM bitacora WHERE subido = 0').get().n;
}

let temporizador = null;
function iniciar() {
  // Lo que ya llegó a la central no hace falta guardarlo aquí para siempre
  try {
    db.prepare("DELETE FROM bitacora WHERE subido = 1 AND fecha < datetime('now', 'localtime', '-400 days')").run();
  } catch (error) {
    console.error('No se pudo limpiar el registro de cambios:', error.message);
  }
  if (!modoCentral() || temporizador) return;
  temporizador = setInterval(() => {
    subir().catch((error) => console.error('Error al subir el registro de cambios:', error.message));
  }, 60000);
  temporizador.unref?.();
  subirPronto();
}

module.exports = { registrar, subir, pendientes, iniciar };
