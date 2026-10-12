'use strict';
/**
 * La función "movil" de Supabase (supabase/functions/movil/manejador.mjs) corriendo en Node contra
 * la central falsa, para probar la app del celular en la nube sin tocar el Supabase real.
 *
 *   const nube = await crearNube(central);
 *   const token = await nube.vincular(usuarioId);          // como si el celular escaneara el código
 *   await nube.pedir('GET', '/api/auth/yo', { token });
 *   const { url, cerrar } = await nube.escuchar();          // servidor HTTP para el navegador
 */
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient } = require('@supabase/supabase-js');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

function codigoAleatorio() {
  let codigo = '';
  for (let i = 0; i < 8; i += 1) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

// Código de vinculación guardado directo en la central (como lo hace la computadora)
function crearCodigo(db, usuarioId, { minutos = 15, usado = null, codigo = codigoAleatorio() } = {}) {
  db.prepare('INSERT INTO vinculos_movil (codigo_hash, usuario_id, creado_por, expira, usado) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(codigo), usuarioId, 1, new Date(Date.now() + minutos * 60000).toISOString(), usado);
  return codigo;
}

async function crearNube(central, { origenesPermitidos = ['*'] } = {}) {
  if (/supabase\.co/i.test(central.url)) throw new Error('Las pruebas nunca deben usar un Supabase real');
  const supabase = createClient(central.url, central.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const archivo = path.join(__dirname, '..', '..', 'supabase', 'functions', 'movil', 'manejador.mjs');
  const { crearManejador } = await import(pathToFileURL(archivo).href);
  const errores = [];
  const manejar = crearManejador({
    supabase,
    origenesPermitidos,
    registrar: (...partes) => errores.push(partes.map((p) => (p && p.stack) || String(p)).join(' ')),
  });

  async function pedir(metodo, ruta, { token, cuerpo, cabeceras = {} } = {}) {
    const headers = { ...cabeceras };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const respuesta = await manejar(new Request(`https://proyecto-de-prueba.invalid/functions/v1/movil${ruta}`, {
      method: metodo,
      headers,
      body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    }));
    const texto = await respuesta.text();
    let body = texto;
    try { body = texto ? JSON.parse(texto) : null; } catch { /* texto plano */ }
    return { status: respuesta.status, body, headers: respuesta.headers };
  }

  async function vincular(usuarioId, { dispositivo = 'Celular de prueba' } = {}) {
    const codigo = crearCodigo(central.db, usuarioId);
    const r = await pedir('POST', '/api/movil/vincular', { cuerpo: { codigo, dispositivo } });
    if (r.status !== 200) throw new Error(`No se pudo vincular: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  // Servidor HTTP con la función (para probar la app en un navegador de verdad)
  function escuchar({ puerto = 0 } = {}) {
    const permitidas = ['authorization', 'content-type', 'origin', 'user-agent', 'access-control-request-method', 'access-control-request-headers'];
    const servidor = http.createServer(async (req, res) => {
      try {
        const trozos = [];
        for await (const trozo of req) trozos.push(trozo);
        const headers = {};
        for (const nombre of permitidas) if (req.headers[nombre]) headers[nombre] = req.headers[nombre];
        const respuesta = await manejar(new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(trozos),
        }));
        res.writeHead(respuesta.status, Object.fromEntries(respuesta.headers));
        res.end(Buffer.from(await respuesta.arrayBuffer()));
      } catch (error) {
        errores.push(error.stack || String(error));
        res.writeHead(500);
        res.end();
      }
    });
    const sockets = new Set();
    servidor.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((listo) => {
      servidor.listen(puerto, '127.0.0.1', () => listo({
        url: `http://127.0.0.1:${servidor.address().port}/functions/v1/movil`,
        cerrar: () => new Promise((r) => { for (const s of sockets) s.destroy(); servidor.close(() => r()); }),
      }));
    });
  }

  return { manejar, pedir, vincular, escuchar, errores, crearCodigo: (usuarioId, opciones) => crearCodigo(central.db, usuarioId, opciones) };
}

module.exports = { crearNube, crearCodigo, sha256 };
