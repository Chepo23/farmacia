// Configuración de esta computadora (archivo configuracion.json en la carpeta del programa,
// %APPDATA%\Farmacia). La llave secreta de Supabase se guarda cifrada con la cuenta de Windows
// (safeStorage / DPAPI): copiar el archivo a otra computadora no sirve para leerla.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFECTOS = {
  version: 1,
  modo: 'central', // 'central' (con Supabase) o 'local' (solo esta computadora)
  supabaseUrl: '',
  llaveCifrada: '',
  llaveTexto: '', // solo si Windows no permite cifrar
  puerto: 3000,
  red: false, // permitir que otros equipos de la red entren a esta computadora
  carpetaDatos: '',
  impresoraTicket: '',
  anchoTicket: 80,
  impresoraDocumentos: '',
  iniciarConWindows: true,
  urlMovil: '',
  carpetaRespaldoExtra: '',
  urlActualizaciones: '',
};

const archivo = () => path.join(app.getPath('userData'), 'configuracion.json');

// null = todavía no se configura (primera vez)
function leer() {
  try {
    return { ...DEFECTOS, ...JSON.parse(fs.readFileSync(archivo(), 'utf8')) };
  } catch {
    return null;
  }
}

function guardar(conf) {
  const destino = archivo();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const temporal = `${destino}.tmp`;
  fs.writeFileSync(temporal, JSON.stringify({ ...DEFECTOS, ...conf }, null, 2));
  fs.renameSync(temporal, destino);
}

function cifrarLlave(llave) {
  if (!llave) return { llaveCifrada: '', llaveTexto: '' };
  if (safeStorage.isEncryptionAvailable()) {
    return { llaveCifrada: safeStorage.encryptString(llave).toString('base64'), llaveTexto: '' };
  }
  return { llaveCifrada: '', llaveTexto: llave };
}

function llave(conf) {
  if (!conf) return '';
  if (conf.llaveCifrada) {
    try {
      return safeStorage.decryptString(Buffer.from(conf.llaveCifrada, 'base64'));
    } catch {
      return ''; // se cifró con otra cuenta de Windows: hay que volver a escribirla
    }
  }
  return conf.llaveTexto || '';
}

const carpetaDatos = (conf) => (conf && conf.carpetaDatos) || path.join(app.getPath('userData'), 'datos');
const rutaBase = (conf) => path.join(carpetaDatos(conf), 'farmacia.db');
const carpetaRespaldos = (conf) => path.join(carpetaDatos(conf), 'respaldos');
const carpetaRegistros = () => path.join(app.getPath('userData'), 'registros');

function esUrl(texto, { permitirHttpLocal = false } = {}) {
  try {
    const url = new URL(texto);
    if (url.protocol === 'https:') return true;
    return permitirHttpLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

// Revisa lo que llega de la pantalla de configuración. Devuelve { error } o la configuración limpia.
function validar(datos, anterior) {
  const conf = { ...DEFECTOS, ...(anterior || {}) };
  conf.modo = datos.modo === 'local' ? 'local' : 'central';
  if (conf.modo === 'central') {
    const url = String(datos.supabaseUrl || '').trim().replace(/\/+$/, '');
    if (!esUrl(url, { permitirHttpLocal: true })) return { error: 'Escribe la dirección de Supabase (https://….supabase.co)' };
    conf.supabaseUrl = url;
    const nueva = String(datos.llave || '').trim();
    if (nueva) Object.assign(conf, cifrarLlave(nueva));
    if (!llave(conf)) return { error: 'Escribe la llave secreta de Supabase (empieza con sb_secret_)' };
  }
  const puerto = Number(datos.puerto);
  if (!Number.isInteger(puerto) || puerto < 1024 || puerto > 65535) return { error: 'El puerto debe ser un número de 1024 a 65535 (normalmente 3000)' };
  conf.puerto = puerto;
  conf.red = Boolean(datos.red);
  const ancho = Number(datos.anchoTicket);
  if (!Number.isInteger(ancho) || ancho < 40 || ancho > 120) return { error: 'El ancho del papel debe ser de 40 a 120 mm (los más comunes: 58 y 80)' };
  conf.anchoTicket = ancho;
  conf.impresoraTicket = String(datos.impresoraTicket || '');
  conf.impresoraDocumentos = String(datos.impresoraDocumentos || '');
  conf.iniciarConWindows = Boolean(datos.iniciarConWindows);
  const urlMovil = String(datos.urlMovil || '').trim().replace(/\/+$/, '');
  if (urlMovil && !esUrl(urlMovil)) return { error: 'La dirección de la app del celular debe empezar con https://' };
  conf.urlMovil = urlMovil;
  const extra = String(datos.carpetaRespaldoExtra || '').trim();
  if (extra && !path.isAbsolute(extra)) return { error: 'La carpeta extra de respaldos no es válida' };
  conf.carpetaRespaldoExtra = extra;
  const actualizaciones = String(datos.urlActualizaciones || '').trim().replace(/\/+$/, '');
  if (actualizaciones && !esUrl(actualizaciones, { permitirHttpLocal: true })) return { error: 'La dirección de actualizaciones debe empezar con https://' };
  conf.urlActualizaciones = actualizaciones;
  return { conf };
}

// Lo que ve la pantalla de configuración: nunca la llave
function paraPantalla(conf) {
  const c = conf || DEFECTOS;
  const { llaveCifrada: _c, llaveTexto: _t, ...resto } = c;
  return { ...resto, tieneLlave: Boolean(llave(c)) };
}

module.exports = {
  DEFECTOS, leer, guardar, validar, llave, paraPantalla, carpetaDatos, rutaBase, carpetaRespaldos, carpetaRegistros, archivo,
};
