'use strict';
/**
 * Levanta server.js como si fuera la computadora de una farmacia, con su propia base SQLite.
 *
 * SEGURIDAD: el proceso arranca en un directorio temporal (no en el repositorio) para que
 * dotenv NO lea el .env real (que trae las llaves del Supabase de producción y
 * FARMACIA_DB=./farmacia.db). Además se verifica en /api/sync/health que el modo sea el pedido.
 *
 *   const pc = await iniciarServidor({ nombre: 'norte', centralUrl })   // modo central
 *   const pc = await iniciarServidor({ nombre: 'local' })               // modo local
 *   const caja = cliente(pc.base); await caja.login('admin', 'admin');
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { REPO, crearDirTemporal, borrarDir, esperar } = require('./temporal');

function puertoLibre() {
  return new Promise((resolver, rechazar) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rechazar);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolver(port));
    });
  });
}

async function iniciarServidor({ nombre = 'pc', centralUrl = null, dbPath = null, envExtra = {} } = {}) {
  const dir = crearDirTemporal(nombre);
  const puerto = await puertoLibre();
  const env = { ...process.env };
  for (const clave of Object.keys(env)) {
    if (/^(SUPABASE_|DATABASE_URL|SYNC_|DB_CLIENT|APP_MODE|FARMACIA_DB)/.test(clave)) delete env[clave];
  }
  env.PORT = String(puerto);
  env.FARMACIA_DB = dbPath || path.join(dir, 'farmacia.db');
  env.CENTRAL_ESPERA_CAIDA_MS = env.CENTRAL_ESPERA_CAIDA_MS || '1500';
  env.SUPABASE_TIMEOUT_MS = env.SUPABASE_TIMEOUT_MS || '3000';
  if (centralUrl) {
    if (/supabase\.co/i.test(centralUrl)) throw new Error('Las pruebas nunca deben usar un Supabase real');
    env.SUPABASE_URL = centralUrl;
    env.SUPABASE_SERVICE_ROLE_KEY = 'clave-falsa';
  }
  Object.assign(env, envExtra);

  const hijo = spawn(process.execPath, [path.join(REPO, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const salida = [];
  hijo.stdout.on('data', (d) => salida.push(String(d)));
  hijo.stderr.on('data', (d) => salida.push(String(d)));
  let terminado = false;
  const fin = new Promise((resolver) => hijo.on('exit', () => { terminado = true; resolver(); }));

  const base = `http://127.0.0.1:${puerto}`;
  let salud = null;
  for (let i = 0; i < 80 && !salud; i += 1) {
    if (terminado) break;
    try {
      const r = await fetch(`${base}/api/sync/health`);
      if (r.ok) salud = await r.json();
    } catch {
      await esperar(150);
    }
  }
  const cerrar = async () => {
    if (!terminado) hijo.kill();
    await fin;
    await borrarDir(dir);
  };
  if (!salud) {
    await cerrar();
    throw new Error(`El servidor ${nombre} no arrancó:\n${salida.join('')}`);
  }
  if (salud.hasSupabase !== Boolean(centralUrl)) {
    await cerrar();
    throw new Error(`El servidor ${nombre} arrancó en un modo distinto al pedido (${JSON.stringify(salud)})`);
  }
  return { nombre, base, puerto, dbPath: env.FARMACIA_DB, logs: () => salida.join(''), cerrar };
}

// Cliente HTTP con su propia cookie de sesión (una "caja" o pestaña del navegador)
function cliente(base) {
  let cookie = '';
  async function pedir(metodo, ruta, cuerpo) {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const nueva = r.headers.get('set-cookie');
    if (nueva && /sesion=/.test(nueva)) cookie = nueva.split(';')[0];
    const texto = await r.text();
    let body = texto;
    try { body = texto ? JSON.parse(texto) : null; } catch { /* texto plano */ }
    return { status: r.status, body, headers: r.headers };
  }
  return {
    async login(usuario, password) {
      const r = await pedir('POST', '/api/auth/login', { usuario, password });
      if (r.status !== 200) throw new Error(`No se pudo iniciar sesión como ${usuario}: ${JSON.stringify(r.body)}`);
      return r;
    },
    get: (ruta) => pedir('GET', ruta),
    post: (ruta, cuerpo = {}) => pedir('POST', ruta, cuerpo),
    put: (ruta, cuerpo = {}) => pedir('PUT', ruta, cuerpo),
    del: (ruta) => pedir('DELETE', ruta),
  };
}

module.exports = { iniciarServidor, cliente, puertoLibre };
