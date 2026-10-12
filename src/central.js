// Acceso a la base central (Supabase) con manejo uniforme de errores.
// - modoCentral(): hay Supabase configurado (cada farmacia con su servidor y su SQLite local).
// - consultar(builder): ejecuta la consulta y lanza ErrorApp si falla; distingue
//   "sin conexión" (sinConexion = true) de errores de datos.
// - Si la central no responde, se recuerda unos segundos para no congelar las pantallas
//   repitiendo intentos que van a fallar (las lecturas usan la copia local mientras tanto).
const { supabaseAdmin, hasSupabase } = require('./sync/supabase-client');

const ESPERA_TRAS_CAIDA_MS = Number(process.env.CENTRAL_ESPERA_CAIDA_MS) || 20000;

class ErrorApp extends Error {
  constructor(mensaje, { status = 400, codigo = '', sinConexion = false, datos = null } = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.sinConexion = sinConexion;
    this.datos = datos;
  }
}

const estado = { caidaHasta: 0, ultimoError: '', ultimaRespuesta: null };

function modoCentral() {
  return Boolean(hasSupabase && supabaseAdmin);
}

function centralDisponible() {
  return modoCentral() && Date.now() >= estado.caidaHasta;
}

function marcarCaida(mensaje) {
  estado.caidaHasta = Date.now() + ESPERA_TRAS_CAIDA_MS;
  estado.ultimoError = mensaje || 'Sin conexión con la central';
}

function marcarDisponible() {
  estado.caidaHasta = 0;
  estado.ultimaRespuesta = new Date().toISOString();
}

function esErrorDeRed(resultado) {
  if (!resultado || !resultado.error) return false;
  if (resultado.status === 0) return true;
  return /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|AbortError|aborted/i
    .test(`${resultado.error.message || ''} ${resultado.error.details || ''}`);
}

function sinConexion(mensaje = 'No hay conexión con la base central. Revisa el internet e intenta de nuevo.') {
  return new ErrorApp(mensaje, { status: 503, codigo: 'SIN_CONEXION', sinConexion: true });
}

// Ejecuta una consulta de supabase-js y devuelve { data, count } o lanza ErrorApp
async function consultar(builder) {
  let resultado;
  try {
    resultado = await builder;
  } catch (error) {
    resultado = { error: { message: error.message }, status: 0 };
  }
  if (resultado.error) {
    if (esErrorDeRed(resultado)) {
      marcarCaida(resultado.error.message);
      throw sinConexion();
    }
    marcarDisponible();
    const e = new ErrorApp(resultado.error.message || 'Error de la base central', {
      status: 502,
      codigo: resultado.error.code || 'CENTRAL',
    });
    e.central = resultado.error;
    throw e;
  }
  marcarDisponible();
  return resultado;
}

function sb() {
  return supabaseAdmin;
}

function estadoCentral() {
  return {
    modo: modoCentral() ? 'central' : 'local',
    disponible: modoCentral() ? centralDisponible() : null,
    ultimo_error: estado.caidaHasta > Date.now() ? estado.ultimoError : '',
    ultima_respuesta: estado.ultimaRespuesta,
  };
}

// Responde un error de la app con el estado HTTP adecuado
function responderError(res, error, mensajePorDefecto = 'Error interno del servidor') {
  if (error instanceof ErrorApp) {
    return res.status(error.status).json({ error: error.message, codigo: error.codigo || undefined, ...(error.datos || {}) });
  }
  console.error(error);
  return res.status(500).json({ error: mensajePorDefecto });
}

// Envuelve un manejador async de Express para que sus errores no se pierdan
function manejar(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      if (res.headersSent) return next(error);
      responderError(res, error);
    });
  };
}

module.exports = {
  ErrorApp,
  modoCentral,
  centralDisponible,
  marcarCaida,
  marcarDisponible,
  consultar,
  sinConexion,
  sb,
  estadoCentral,
  responderError,
  manejar,
};
