// Núcleo: sesión, navegación, utilidades compartidas
const App = {
  usuario: null,
  sucursales: [],
  apertura: null, // fondo de caja y tipo de cambio registrados al abrir el día
  modalBloqueado: false, // impide cerrar el modal de apertura sin llenarlo
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
  const contenido = document.getElementById('contenido-modal');
  contenido.innerHTML = '';
  contenido.className = 'modal'; // quitar variantes como "grande"
  const seccionVenta = document.getElementById('seccion-venta');
  if (seccionVenta.classList.contains('activa')) {
    document.getElementById('entrada-codigo').focus();
  }
}

function hayModalAbierto() {
  return !document.getElementById('fondo-modal').hidden;
}

document.getElementById('fondo-modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'fondo-modal' && !App.modalBloqueado) cerrarModal();
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
  if (e.key === 'Escape' && hayModalAbierto() && !App.modalBloqueado) cerrarModal();
});

// ---------- Apertura de caja ----------
// Antes de poder usar el sistema se registra el fondo de caja y el tipo de cambio
async function pedirApertura() {
  App.apertura = await api('/api/cortes/apertura');
  if (App.apertura) return;

  App.modalBloqueado = true;
  const modal = abrirModal(`
    <h3>Apertura de caja — ${escaparHtml(App.usuario.sucursal)}</h3>
    <p>Antes de entrar al sistema, registra con cuánto abre la caja y el tipo de cambio del día.</p>
    <div class="fila">
      <label>Fondo de caja ($)
        <input type="number" id="apertura-fondo" step="0.01" min="0" placeholder="0.00">
      </label>
      <label>Tipo de cambio (pesos por dólar)
        <input type="number" id="apertura-cambio" step="0.01" min="0" placeholder="Ej. 18.50">
      </label>
    </div>
    <div id="apertura-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton exito grande" id="apertura-guardar">Iniciar el día (Enter)</button>
    </div>
  `);

  await new Promise((listo) => {
    async function guardar() {
      const errorEl = modal.querySelector('#apertura-error');
      errorEl.hidden = true;
      try {
        App.apertura = await api('/api/cortes/apertura', {
          method: 'POST',
          body: {
            fondo_caja: Number(modal.querySelector('#apertura-fondo').value),
            tipo_cambio: Number(modal.querySelector('#apertura-cambio').value),
          },
        });
        App.modalBloqueado = false;
        cerrarModal();
        listo();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }
    modal.querySelector('#apertura-guardar').addEventListener('click', guardar);
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); guardar(); }
    });
  });
}

// ---------- Arranque ----------
async function iniciar() {
  try {
    App.usuario = await api('/api/auth/yo');
  } catch {
    return; // api() ya redirigió al login
  }
  App.sucursales = await api('/api/admin/sucursales');
  await pedirApertura();
  document.getElementById('info-usuario').textContent =
    `${App.usuario.nombre} — ${App.usuario.sucursal} — T.C. $${(App.apertura.tipo_cambio || 0).toFixed(2)}`;
  if (App.usuario.rol === 'admin') {
    document.querySelectorAll('.solo-admin').forEach((el) => { el.hidden = false; });
  }
  document.getElementById('entrada-codigo').focus();
  document.dispatchEvent(new Event('app:listo'));
}

iniciar();
