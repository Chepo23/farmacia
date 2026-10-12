// Vinculación de celulares con la app del inventario en la nube (función "movil" de Supabase).
// La computadora genera un código de un solo uso (dura 15 minutos); el celular lo cambia por una
// sesión de larga duración que se puede revocar desde aquí. Solo se guarda el resumen SHA-256
// del código y de la sesión, nunca el valor real.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { modoCentral, consultar, sb, manejar, ErrorApp } = require('../central');

const router = express.Router();

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O, 1/I/L para que no se confundan
const LARGO_CODIGO = 8;
const VIGENCIA_MINUTOS = 15;
const SESION_MAX_DIAS_SIN_USO = 180; // igual que en supabase/functions/movil/manejador.mjs

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const esAdminCentral = (u) => u.rol === 'admin' && Number(u.es_central) === 1;

function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i += 1) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

// Dirección de la app del celular: la de Administración → Datos del ticket o MOVIL_URL del .env
function urlApp() {
  const fila = db.prepare("SELECT valor FROM sync_config WHERE clave = 'cfg.url_movil'").get();
  return String((fila && fila.valor) || process.env.MOVIL_URL || '').trim().replace(/\/+$/, '');
}

function requiereNube(req, res, next) {
  if (!modoCentral()) {
    return res.status(400).json({
      error: 'La app del celular en la nube necesita que esta computadora esté conectada a la central (Supabase)',
      codigo: 'SIN_NUBE',
    });
  }
  next();
}

// Genera el código para vincular un celular (el propio, o el de otra persona si es el admin de la central)
router.post('/vincular', requiereNube, manejar(async (req, res) => {
  let usuarioId = Number(req.usuario.id);
  const pedido = Number(req.body?.usuario_id) || usuarioId;
  if (pedido !== usuarioId) {
    if (!esAdminCentral(req.usuario)) {
      throw new ErrorApp('Solo el administrador de la central puede vincular el celular de otra persona', { status: 403 });
    }
    usuarioId = pedido;
  }
  const { data: usuarios } = await consultar(
    sb().from('usuarios_central').select('id,nombre,usuario,activo').eq('id', usuarioId).limit(1)
  );
  const usuario = usuarios && usuarios[0];
  if (!usuario || usuario.activo === false) throw new ErrorApp('El usuario no existe o está dado de baja', { status: 404 });

  // Un código nuevo reemplaza a los que esa persona no alcanzó a usar; los viejos se limpian
  await consultar(sb().from('vinculos_movil').delete().eq('usuario_id', usuarioId).is('usado', null));
  await consultar(sb().from('vinculos_movil').delete().lt('expira', new Date(Date.now() - 86400000).toISOString()));

  const codigo = generarCodigo();
  const expira = new Date(Date.now() + VIGENCIA_MINUTOS * 60000).toISOString();
  await consultar(sb().from('vinculos_movil').insert({
    codigo_hash: sha256(codigo), usuario_id: usuarioId, creado_por: Number(req.usuario.id), expira,
  }));
  const app = urlApp();
  res.json({
    codigo: `${codigo.slice(0, 4)}-${codigo.slice(4)}`,
    expira,
    minutos: VIGENCIA_MINUTOS,
    usuario: { id: Number(usuario.id), nombre: usuario.nombre, usuario: usuario.usuario },
    url_app: app || null,
    // El código va después de "#": el navegador no lo manda al servidor de la página
    url: app ? `${app}/#vincular=${codigo}` : null,
  });
}));

// Celulares vinculados (el admin de la central ve todos; los demás, solo los suyos)
router.get('/', manejar(async (req, res) => {
  if (!modoCentral()) return res.json({ disponible: false, url_app: urlApp() || null, sesiones: [] });
  const limite = new Date(Date.now() - SESION_MAX_DIAS_SIN_USO * 86400000).toISOString();
  let consulta = sb().from('sesiones_movil').select('id,usuario_id,dispositivo,creada,ultimo_uso')
    .is('revocada', null).gte('ultimo_uso', limite);
  if (!esAdminCentral(req.usuario)) consulta = consulta.eq('usuario_id', Number(req.usuario.id));
  const { data } = await consultar(consulta.order('ultimo_uso', { ascending: false }).limit(200));
  const sesiones = data || [];
  const ids = [...new Set(sesiones.map((s) => Number(s.usuario_id)))];
  const nombres = new Map();
  if (ids.length) {
    const { data: usuarios } = await consultar(sb().from('usuarios_central').select('id,nombre,usuario').in('id', ids));
    for (const u of usuarios || []) nombres.set(Number(u.id), u);
  }
  res.json({
    disponible: true,
    url_app: urlApp() || null,
    sesiones: sesiones.map((s) => ({
      id: Number(s.id),
      usuario_id: Number(s.usuario_id),
      usuario: nombres.get(Number(s.usuario_id))?.nombre || `Usuario ${s.usuario_id}`,
      dispositivo: s.dispositivo || '',
      creada: s.creada,
      ultimo_uso: s.ultimo_uso,
      propia: Number(s.usuario_id) === Number(req.usuario.id),
    })),
  });
}));

// Desvincular un celular (por ejemplo, si se perdió): deja de entrar al momento
router.delete('/:id', requiereNube, manejar(async (req, res) => {
  const id = Number(req.params.id);
  if (!(id > 0)) throw new ErrorApp('Celular no válido');
  let consulta = sb().from('sesiones_movil').update({ revocada: new Date().toISOString() }).eq('id', id).is('revocada', null);
  if (!esAdminCentral(req.usuario)) consulta = consulta.eq('usuario_id', Number(req.usuario.id));
  const { data } = await consultar(consulta.select('id'));
  if (!data || !data.length) throw new ErrorApp('No se encontró ese celular', { status: 404 });
  res.json({ ok: true });
}));

module.exports = router;
