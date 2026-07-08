// Núcleo: sesión, navegación, utilidades compartidas
const App = {
  usuario: null,
  sucursales: [],
  alMostrarSeccion: {}, // cada módulo registra qué recargar al abrir su pestaña
};

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, {
    headers: { 'Content-Type': 'application/json' },
    ...opciones,
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('Sesión expirada');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.error || 'Error del servidor');
  return datos;
}

function dinero(n) {
  return '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

let temporizadorAviso = null;
function aviso(mensaje, tipo = '') {
  const el = document.getElementById('aviso');
  el.textContent = mensaje;
  el.className = 'aviso ' + tipo;
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- Modal genérico ----------
function abrirModal(html) {
  const fondo = document.getElementById('fondo-modal');
  const contenido = document.getElementById('contenido-modal');
  contenido.innerHTML = html;
  fondo.hidden = false;
  const primero = contenido.querySelector('input, select, button');
  if (primero) primero.focus();
  return contenido;
}

function cerrarModal() {
  document.getElementById('fondo-modal').hidden = true;
  document.getElementById('contenido-modal').innerHTML = '';
  const seccionVenta = document.getElementById('seccion-venta');
  if (seccionVenta.classList.contains('activa')) {
    document.getElementById('entrada-codigo').focus();
  }
}

function hayModalAbierto() {
  return !document.getElementById('fondo-modal').hidden;
}

document.getElementById('fondo-modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'fondo-modal') cerrarModal();
});

// ---------- Navegación ----------
function mostrarSeccion(nombre) {
  document.querySelectorAll('.seccion').forEach((s) => s.classList.remove('activa'));
  document.querySelectorAll('.pestania').forEach((p) => p.classList.remove('activa'));
  document.getElementById('seccion-' + nombre).classList.add('activa');
  document.querySelector(`.pestania[data-seccion="${nombre}"]`).classList.add('activa');
  if (App.alMostrarSeccion[nombre]) App.alMostrarSeccion[nombre]();
  if (nombre === 'venta') document.getElementById('entrada-codigo').focus();
}

document.querySelectorAll('.pestania').forEach((p) => {
  p.addEventListener('click', () => mostrarSeccion(p.dataset.seccion));
});

document.getElementById('boton-salir').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// Teclas rápidas globales
document.addEventListener('keydown', (e) => {
  const teclas = { F2: 'venta', F5: 'productos', F6: 'clientes', F7: 'corte', F8: 'reportes' };
  if (teclas[e.key] && !hayModalAbierto()) {
    e.preventDefault();
    mostrarSeccion(teclas[e.key]);
  }
  if (e.key === 'Escape' && hayModalAbierto()) cerrarModal();
});

// ---------- Arranque ----------
async function iniciar() {
  try {
    App.usuario = await api('/api/auth/yo');
  } catch {
    return; // api() ya redirigió al login
  }
  App.sucursales = await api('/api/admin/sucursales');
  document.getElementById('info-usuario').textContent =
    `${App.usuario.nombre} — ${App.usuario.sucursal}`;
  if (App.usuario.rol === 'admin') {
    document.querySelectorAll('.solo-admin').forEach((el) => { el.hidden = false; });
  }
  document.getElementById('entrada-codigo').focus();
  document.dispatchEvent(new Event('app:listo'));
}

iniciar();
