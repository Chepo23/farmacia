#!/usr/bin/env node
/**
 * Arma la app del celular para publicarla en internet y la función de Supabase en un solo archivo.
 *
 *   node scripts/construir-movil.js
 *       usa la dirección de Supabase del .env (solo lee SUPABASE_URL; la llave secreta no se toca)
 *   node scripts/construir-movil.js --api https://TU-PROYECTO.supabase.co/functions/v1/movil
 *
 * Resultado:
 *   dist-movil/              la app: se sube a Cloudflare Pages (ver docs/celular.md)
 *   dist-funcion/index.ts    la función "movil" en un solo archivo, para pegarla en el editor de
 *                            Supabase (Edge Functions → Deploy a new function → Via Editor)
 *
 * Opciones: --salida <carpeta> (dist-movil), --salida-funcion <carpeta> (dist-funcion),
 *           --nombre "<nombre de la app>"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const PUBLICO = path.join(REPO, 'public');

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0) return process.argv[i + 1];
  const conIgual = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return conIgual ? conIgual.slice(nombre.length + 3) : undefined;
}

// Solo se lee SUPABASE_URL del .env: la llave secreta nunca va en la app
function urlDeSupabase() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  const archivo = path.join(REPO, '.env');
  if (!fs.existsSync(archivo)) return '';
  const linea = fs.readFileSync(archivo, 'utf8').split(/\r?\n/).find((l) => /^\s*SUPABASE_URL\s*=/.test(l));
  return linea ? linea.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
}

function direccionApi() {
  let api = argumento('api') || process.env.MOVIL_API_URL || '';
  if (!api) {
    const supabase = urlDeSupabase().replace(/\/+$/, '');
    if (!supabase) {
      throw new Error('No se encontró SUPABASE_URL en el .env. Indica la dirección con --api https://TU-PROYECTO.supabase.co/functions/v1/movil');
    }
    api = `${supabase}/functions/v1/movil`;
  }
  api = api.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(api);
  } catch {
    throw new Error(`La dirección de la función no es válida: ${api}`);
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('La dirección de la función debe empezar con https://');
  }
  return { api, origen: url.origin };
}

function copiar(origen, destino) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.copyFileSync(origen, destino);
}

function escribir(destino, contenido) {
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, contenido);
}

function construirApp({ salida, api, origenApi, nombre }) {
  fs.rmSync(salida, { recursive: true, force: true });
  const archivos = {
    'css/movil.css': path.join(PUBLICO, 'css', 'movil.css'),
    'js/escaner.js': path.join(PUBLICO, 'js', 'escaner.js'),
    'js/movil.js': path.join(PUBLICO, 'js', 'movil.js'),
    'img/logo-login.png': path.join(PUBLICO, 'img', 'logo-login.png'),
    'img/icono.svg': path.join(PUBLICO, 'img', 'icono.svg'),
    'img/icono-192.png': path.join(PUBLICO, 'img', 'icono-192.png'),
    'img/icono-512.png': path.join(PUBLICO, 'img', 'icono-512.png'),
    'img/icono-maskable-512.png': path.join(PUBLICO, 'img', 'icono-maskable-512.png'),
    'img/apple-touch-icon.png': path.join(PUBLICO, 'img', 'apple-touch-icon.png'),
    'img/favicon-32.png': path.join(PUBLICO, 'img', 'favicon-32.png'),
    'vendor/zxing/index.min.js': path.join(REPO, 'node_modules', '@zxing', 'library', 'umd', 'index.min.js'),
  };
  for (const [destino, origen] of Object.entries(archivos)) {
    if (!fs.existsSync(origen)) throw new Error(`Falta el archivo ${path.relative(REPO, origen)} (¿corriste npm install?)`);
    copiar(origen, path.join(salida, destino));
  }

  // La página: la misma del celular, con el manifiesto y los íconos para poder instalarla
  let html = fs.readFileSync(path.join(PUBLICO, 'movil.html'), 'utf8');
  const marca = /[ \t]*<!-- app-instalable:[^>]*-->/;
  if (!marca.test(html)) throw new Error('public/movil.html no tiene la marca <!-- app-instalable -->');
  html = html.replace(marca, [
    '  <link rel="manifest" href="manifest.webmanifest">',
    '  <link rel="icon" type="image/png" sizes="32x32" href="img/favicon-32.png">',
    '  <link rel="apple-touch-icon" href="img/apple-touch-icon.png">',
  ].join('\n'));
  escribir(path.join(salida, 'index.html'), html);

  escribir(path.join(salida, 'config.js'),
    `// Generado por scripts/construir-movil.js: la app habla con la función "movil" de Supabase\nwindow.FARMACIA_CONFIG = ${JSON.stringify({ api }, null, 2)};\n`);

  escribir(path.join(salida, 'manifest.webmanifest'), `${JSON.stringify({
    id: './',
    name: nombre,
    short_name: 'Inventario',
    description: 'Precios, existencias, recepción de mercancía y conteos de inventario de la farmacia',
    lang: 'es-MX',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f3f7f0',
    theme_color: '#2e5f45',
    icons: [
      { src: 'img/icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'img/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'img/icono-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`);

  // Versión = huella de todos los archivos: al publicar cambios, los celulares toman la versión nueva
  const lista = ['index.html', 'config.js', 'manifest.webmanifest', ...Object.keys(archivos)];
  const huella = crypto.createHash('sha256');
  for (const archivo of lista) huella.update(fs.readFileSync(path.join(salida, archivo)));
  const version = `inventario-${huella.digest('hex').slice(0, 12)}`;
  escribir(path.join(salida, 'sw.js'), `// Generado por scripts/construir-movil.js.
// Guarda la app en el celular para que abra rápido y aunque falle el internet.
// Los datos (precios, existencias) siempre se piden a la nube: nunca se guardan aquí.
const VERSION = '${version}';
const ARCHIVOS = ${JSON.stringify(['./', ...lista], null, 2)};

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((clave) => clave !== VERSION).map((clave) => caches.delete(clave))))
      .then(() => self.clients.claim())
  );
});

// Primero la red (así siempre se usa la versión publicada); si no responde pronto, la copia guardada
async function responder(solicitud) {
  const cache = await caches.open(VERSION);
  const deRed = fetch(solicitud).then((respuesta) => {
    if (respuesta.ok) cache.put(solicitud, respuesta.clone()).catch(() => {});
    return respuesta;
  });
  deRed.catch(() => {});
  try {
    const primera = await Promise.race([deRed, new Promise((listo) => setTimeout(listo, 3500, null))]);
    if (primera) return primera;
  } catch { /* sin internet */ }
  const guardada = (await cache.match(solicitud, { ignoreSearch: true }))
    || (solicitud.mode === 'navigate' ? await cache.match('index.html') : null);
  return guardada || deRed;
}

self.addEventListener('fetch', (evento) => {
  const solicitud = evento.request;
  if (solicitud.method !== 'GET') return;
  // La nube (Supabase) y las fuentes van directo, sin pasar por la copia guardada
  if (new URL(solicitud.url).origin !== self.location.origin) return;
  evento.respondWith(responder(solicitud));
});
`);

  // Encabezados de seguridad para Cloudflare Pages
  escribir(path.join(salida, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${origenApi}; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'

/sw.js
  Cache-Control: no-cache

/config.js
  Cache-Control: no-cache
`);
  return { version, archivos: lista.length + 3 };
}

// La función en un solo archivo (el editor del panel de Supabase no necesita la terminal)
function construirFuncion({ salida }) {
  const carpeta = path.join(REPO, 'supabase', 'functions', 'movil');
  const manejador = fs.readFileSync(path.join(carpeta, 'manejador.mjs'), 'utf8');
  const entrada = fs.readFileSync(path.join(carpeta, 'index.ts'), 'utf8');
  if (!/^export function crearManejador/m.test(manejador)) throw new Error('manejador.mjs cambió: no se encontró "export function crearManejador"');
  const importaCliente = entrada.match(/^import \{ createClient \} from '[^']+';$/m);
  const importaManejador = /^import \{ crearManejador \} from '\.\/manejador\.mjs';\r?\n/m;
  if (!importaCliente || !importaManejador.test(entrada)) throw new Error('index.ts cambió: no se encontraron sus import');
  const resto = entrada.replace(importaCliente[0], '').replace(importaManejador, '');
  const archivo = [
    '// @ts-nocheck',
    '// Generado por scripts/construir-movil.js a partir de supabase/functions/movil (no editar aquí).',
    '// Pégalo completo en Supabase → Edge Functions → Deploy a new function → Via Editor, con el nombre "movil",',
    '// y después apaga "Verify JWT" (Enforce JWT verification) en los ajustes de la función.',
    importaCliente[0],
    '',
    manejador.replace(/^export function crearManejador/m, 'function crearManejador'),
    resto,
  ].join('\n');
  fs.rmSync(salida, { recursive: true, force: true });
  escribir(path.join(salida, 'index.ts'), archivo);
}

function main() {
  const { api, origen } = direccionApi();
  const salida = path.resolve(argumento('salida') || path.join(REPO, 'dist-movil'));
  const salidaFuncion = path.resolve(argumento('salida-funcion') || path.join(REPO, 'dist-funcion'));
  const nombre = argumento('nombre') || 'Inventario — Farmacia San Francisco';
  const { version } = construirApp({ salida, api, origenApi: origen, nombre });
  construirFuncion({ salida: salidaFuncion });
  console.log(`App del celular lista en ${path.relative(process.cwd(), salida) || salida} (versión ${version})`);
  console.log(`  Habla con: ${api}`);
  console.log(`Función de Supabase en un solo archivo: ${path.relative(process.cwd(), path.join(salidaFuncion, 'index.ts'))}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`No se pudo armar la app: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { construirApp, construirFuncion, direccionApi };
