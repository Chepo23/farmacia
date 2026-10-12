// Datos del negocio para tickets y documentos impresos (nombre, RFC, mensajes, ancho del papel).
// Se guardan en esta computadora: cada farmacia puede tener su propia impresora.
const express = require('express');
const db = require('../db');

const router = express.Router();

// Cualquier administrador puede configurar la impresión de su farmacia
function requiereAdministrador(req, res, next) {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede cambiar la configuración' });
  next();
}

const CAMPOS = {
  negocio_nombre: 'Farmacia San Francisco',
  negocio_rfc: '',
  ticket_encabezado: 'La salud es lo más importante',
  ticket_mensaje: '¡Gracias por su compra!',
  ticket_pie: 'Conserve su ticket para cualquier aclaración.',
  ticket_ancho: '80',
  // Dirección de la app del celular (https://…pages.dev con la central en Supabase;
  // sin Supabase, la dirección segura de esta computadora). Si está vacía se usa MOVIL_URL del .env
  url_movil: '',
};

function leerConfig() {
  const filas = db.prepare("SELECT clave, valor FROM sync_config WHERE clave LIKE 'cfg.%'").all();
  const guardado = Object.fromEntries(filas.map((f) => [f.clave.slice(4), f.valor]));
  const config = {};
  for (const [campo, porDefecto] of Object.entries(CAMPOS)) config[campo] = guardado[campo] ?? porDefecto;
  if (!config.url_movil) config.url_movil = String(process.env.MOVIL_URL || '').trim().replace(/\/+$/, '');
  return config;
}

router.get('/', (req, res) => {
  res.json(leerConfig());
});

router.put('/', requiereAdministrador, (req, res) => {
  const cambios = req.body || {};
  if (cambios.ticket_ancho !== undefined) {
    const ancho = Number(cambios.ticket_ancho);
    if (!Number.isInteger(ancho) || ancho < 40 || ancho > 120) {
      return res.status(400).json({ error: 'El ancho del papel debe ser de 40 a 120 mm (los más comunes: 58 y 80)' });
    }
    cambios.ticket_ancho = String(ancho);
  }
  if (cambios.url_movil !== undefined) {
    cambios.url_movil = String(cambios.url_movil).trim().replace(/\/+$/, '');
    if (cambios.url_movil && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(cambios.url_movil)) {
      return res.status(400).json({ error: 'La dirección de la app del celular debe empezar con https:// (por ejemplo https://farmacia-inventario.pages.dev)' });
    }
  }
  const guardar = db.prepare(
    'INSERT INTO sync_config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
  );
  db.transaction(() => {
    for (const campo of Object.keys(CAMPOS)) {
      if (cambios[campo] === undefined) continue;
      guardar.run(`cfg.${campo}`, String(cambios[campo]).trim().slice(0, 300));
    }
  })();
  res.json(leerConfig());
});

module.exports = router;
