// Núcleo: sesión, navegación, utilidades compartidas
const App = {
  usuario: null,
  sucursales: [],
  config: null, // datos del negocio para tickets (Administración → Datos del ticket)
  apertura: null, // fondo de caja y tipo de cambio registrados al abrir el día
  modalBloqueado: false, // impide cerrar el modal de apertura sin llenarlo
  alMostrarSeccion: {}, // cada módulo registra qué recargar al abrir su pestaña
};

async function api(ruta, opciones = {}) {
  let r;
  try {
    r = await fetch(ruta, {
      headers: { 'Content-Type': 'application/json' },
      ...opciones,
      body: opciones.body ? JSON.stringify(opciones.body) : undefined,
    });
  } catch {
    throw new Error('No hay comunicación con el servidor de la farmacia. Revisa que el programa esté abierto.');
  }
  if (r.status === 401 && !ruta.startsWith('/api/auth/login')) {
    location.href = '/login.html';
    throw new Error('Sesión expirada');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(datos.error || 'Error del servidor');
    error.codigo = datos.codigo;
    error.status = r.status;
    throw error;
  }
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
  return !document.getElementById('fondo-modal').hidden || !document.getElementById('fondo-dialogo').hidden;
}

document.getElementById('fondo-modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'fondo-modal' && !App.modalBloqueado) cerrarModal();
});

// ---------- Diálogos (encima de la ventana abierta): confirmar y pedir un texto ----------
let alCerrarDialogo = null;

function abrirDialogo(html) {
  const fondo = document.getElementById('fondo-dialogo');
  const contenido = document.getElementById('contenido-dialogo');
  contenido.innerHTML = html;
  fondo.hidden = false;
  const primero = contenido.querySelector('input, textarea, select') || contenido.querySelector('.boton.exito, .boton.peligro');
  if (primero) primero.focus();
  return contenido;
}

function cerrarDialogo() {
  document.getElementById('fondo-dialogo').hidden = true;
  document.getElementById('contenido-dialogo').innerHTML = '';
  const alCerrar = alCerrarDialogo;
  alCerrarDialogo = null;
  if (alCerrar) alCerrar();
}

function dialogoAbierto() {
  return !document.getElementById('fondo-dialogo').hidden;
}

// Pregunta sí/no. Resuelve true o false.
function confirmar({ titulo, mensaje = '', boton = 'Aceptar', peligro = false }) {
  return new Promise((resolver) => {
    const dialogo = abrirDialogo(`
      <h3>${escaparHtml(titulo)}</h3>
      ${mensaje ? `<p>${escaparHtml(mensaje)}</p>` : ''}
      <div class="pie">
        <button class="boton" data-respuesta="no">Cancelar</button>
        <button class="boton ${peligro ? 'peligro' : 'exito'}" data-respuesta="si">${escaparHtml(boton)}</button>
      </div>`);
    let respuesta = false;
    alCerrarDialogo = () => resolver(respuesta);
    dialogo.querySelector('[data-respuesta="si"]').addEventListener('click', () => { respuesta = true; cerrarDialogo(); });
    dialogo.querySelector('[data-respuesta="no"]').addEventListener('click', cerrarDialogo);
  });
}

// Pide un texto (por ejemplo, el motivo de una cancelación). Resuelve el texto o null.
function pedirTexto({ titulo, mensaje = '', etiqueta = '', boton = 'Aceptar', obligatorio = true, peligro = true }) {
  return new Promise((resolver) => {
    const dialogo = abrirDialogo(`
      <h3>${escaparHtml(titulo)}</h3>
      ${mensaje ? `<p>${escaparHtml(mensaje)}</p>` : ''}
      <label>${escaparHtml(etiqueta)} <input type="text" id="dialogo-texto" maxlength="300" autocomplete="off"></label>
      <div id="dialogo-error" class="mensaje-error" hidden></div>
      <div class="pie">
        <button class="boton" data-respuesta="no">Regresar</button>
        <button class="boton ${peligro ? 'peligro' : 'exito'}" data-respuesta="si">${escaparHtml(boton)}</button>
      </div>`);
    let respuesta = null;
    alCerrarDialogo = () => resolver(respuesta);
    const entrada = dialogo.querySelector('#dialogo-texto');
    const aceptar = () => {
      const texto = entrada.value.trim();
      if (obligatorio && !texto) {
        const error = dialogo.querySelector('#dialogo-error');
        error.textContent = 'Este dato es obligatorio';
        error.hidden = false;
        entrada.focus();
        return;
      }
      respuesta = texto;
      cerrarDialogo();
    };
    dialogo.querySelector('[data-respuesta="si"]').addEventListener('click', aceptar);
    dialogo.querySelector('[data-respuesta="no"]').addEventListener('click', cerrarDialogo);
    entrada.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); aceptar(); }
    });
  });
}

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
  const teclas = { F2: 'venta', F5: 'productos', F6: 'clientes', F7: 'corte', F8: 'reportes', F9: 'apoyos' };
  if (teclas[e.key] && !hayModalAbierto()) {
    e.preventDefault();
    mostrarSeccion(teclas[e.key]);
  }
  if (e.key === 'Escape') {
    if (dialogoAbierto()) cerrarDialogo();
    else if (hayModalAbierto() && !App.modalBloqueado) cerrarModal();
  }
});

// ---------- Apertura de caja ----------
// Antes de poder usar el sistema se registra el fondo de caja y el tipo de cambio.
// Si la caja de la sucursal ya se abrió hoy, la sesión se une a ese turno sin preguntar.
async function pedirApertura() {
  App.apertura = await api('/api/cortes/apertura');
  if (App.apertura) {
    pintarInfoUsuario();
    return;
  }

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
        pintarInfoUsuario();
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

function pintarInfoUsuario() {
  if (!App.usuario) return;
  const tipoCambio = Number(App.apertura?.tipo_cambio) || 0;
  document.getElementById('info-usuario').textContent =
    `${App.usuario.nombre} — ${App.usuario.sucursal}${tipoCambio ? ` — T.C. $${tipoCambio.toFixed(2)}` : ''}`;
}

// ---------- Sincronización con la central (solo cuando hay Supabase) ----------
async function revisarSincronizacion() {
  const indicador = document.getElementById('estado-sync');
  if (App.usuario?.modo !== 'central') {
    indicador.hidden = true;
    return;
  }
  try {
    const estado = await api('/api/productos/sincronizacion');
    indicador.className = 'estado-sync';
    if (estado.disponible === false) {
      indicador.classList.add('error');
      indicador.innerHTML = '<svg class="icono"><use href="#i-nube"/></svg>Sin conexión con la central';
      indicador.title = 'Se puede seguir vendiendo; el inventario se actualizará solo al volver el internet';
    } else if (estado.errores > 0) {
      indicador.classList.add('error');
      indicador.innerHTML = `<svg class="icono"><use href="#i-alerta"/></svg>${estado.errores} movimiento(s) con error`;
      indicador.title = 'Revisa Administración → Sincronización con la central';
    } else if (estado.pendientes > 0) {
      indicador.classList.add('alerta');
      indicador.innerHTML = `<svg class="icono"><use href="#i-nube"/></svg>${estado.pendientes} por subir`;
      indicador.title = 'Movimientos de inventario hechos sin conexión que se están subiendo a la central';
    } else {
      indicador.innerHTML = '<svg class="icono"><use href="#i-nube"/></svg>En línea';
      indicador.title = 'Conectado con la central: el inventario está al día';
    }
    indicador.hidden = false;
  } catch {
    indicador.hidden = true;
  }
}

// ---------- Abrir el inventario en el celular (código QR) ----------
function cargarZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((listo, fallo) => {
    const script = document.createElement('script');
    script.src = '/vendor/zxing/index.min.js';
    script.onload = listo;
    script.onerror = () => fallo(new Error('No se pudo generar el código QR'));
    document.head.appendChild(script);
  });
}

function codigoQrSvg(texto) {
  const matriz = new window.ZXing.QRCodeWriter().encode(texto, window.ZXing.BarcodeFormat.QR_CODE, 0, 0, new Map());
  const n = matriz.getWidth();
  const margen = 2;
  let cuadros = '';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matriz.get(x, y)) cuadros += `<rect x="${x + margen}" y="${y + margen}" width="1" height="1"/>`;
    }
  }
  const lado = n + margen * 2;
  return `<svg viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges" role="img" aria-label="Código QR"><rect width="${lado}" height="${lado}" fill="#fff"/><g fill="#000">${cuadros}</g></svg>`;
}

function fechaHora(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Con la central en Supabase el celular usa la app en la nube: aquí se genera el código para vincularlo
async function vincularCelular() {
  const esAdminCentral = App.usuario.rol === 'admin' && App.usuario.es_central === 1;
  const usuarios = esAdminCentral ? await api('/api/admin/usuarios').catch(() => []) : [];
  const modal = abrirModal(`
    <h3>App del celular</h3>
    <p>Desde el celular se consultan precios y existencias de todas las farmacias, se recibe mercancía y se cuentan
       estantes, aunque las computadoras estén apagadas. Cada celular se vincula una sola vez y queda listo.</p>
    ${esAdminCentral && usuarios.length ? `<label>¿De quién es el celular?
      <select id="celular-usuario">${usuarios.map((u) => `<option value="${u.id}" ${Number(u.id) === Number(App.usuario.id) ? 'selected' : ''}>
        ${escaparHtml(u.nombre)} — ${escaparHtml(u.sucursal || '')}${u.rol === 'admin' ? ' (administrador)' : ''}</option>`).join('')}
      </select></label>` : ''}
    <div id="celular-vinculo"></div>
    <div class="pie">
      <button class="boton" data-cerrar>Cerrar</button>
      <button class="boton exito" id="celular-generar"><svg class="icono"><use href="#i-celular"/></svg>Generar código para vincular</button>
    </div>
    <h4 class="celular-subtitulo">Celulares vinculados</h4>
    <div id="celular-lista"><small>Cargando…</small></div>`);
  modal.querySelector('[data-cerrar]').addEventListener('click', cerrarModal);
  let reloj = null;
  let sesionesAntes = new Set();
  const abierto = () => document.body.contains(modal.querySelector('#celular-lista'));

  async function pintarLista() {
    const caja = modal.querySelector('#celular-lista');
    let r;
    try {
      r = await api('/api/celulares');
    } catch (error) {
      caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
      return [];
    }
    if (!abierto()) return r.sesiones;
    caja.innerHTML = r.sesiones.length ? `<ul class="celular-sesiones">${r.sesiones.map((s) => `
      <li>
        <span><b>${escaparHtml(s.usuario)}</b> · ${escaparHtml(s.dispositivo || 'Celular')}
          <small>Vinculado el ${escaparHtml(fechaHora(s.creada))} · último uso ${escaparHtml(fechaHora(s.ultimo_uso))}</small></span>
        <button class="boton chico peligro" data-desvincular="${s.id}">Desvincular</button>
      </li>`).join('')}</ul>` : '<small>Todavía no hay celulares vinculados.</small>';
    return r.sesiones;
  }

  function detener() {
    clearInterval(reloj);
    reloj = null;
  }

  async function generar() {
    const boton = modal.querySelector('#celular-generar');
    const zona = modal.querySelector('#celular-vinculo');
    const usuarioId = Number(modal.querySelector('#celular-usuario')?.value) || App.usuario.id;
    boton.disabled = true;
    detener();
    try {
      sesionesAntes = new Set((await pintarLista()).map((s) => s.id));
      const v = await api('/api/celulares/vincular', { method: 'POST', body: { usuario_id: usuarioId } });
      let qr = '';
      if (v.url) {
        try {
          await cargarZxing();
          qr = codigoQrSvg(v.url);
        } catch (error) {
          qr = `<p>${escaparHtml(error.message)}</p>`;
        }
      }
      zona.innerHTML = `
        <div class="celular-vinculo">
          ${qr ? `<div class="qr-celular">${qr}</div>` : ''}
          <div class="celular-datos">
            <small>Código para ${escaparHtml(v.usuario.nombre)}</small>
            <div class="celular-codigo">${escaparHtml(v.codigo)}</div>
            <div class="celular-vence" id="celular-vence"></div>
            ${v.url ? `<ol class="celular-pasos">
              <li><b>Android:</b> escanea el código QR con la cámara y abre el enlace. La app queda vinculada;
                  toca <b>Instalar</b> para tenerla en la pantalla de inicio.</li>
              <li><b>iPhone:</b> escanea el código QR con la cámara; en Safari toca <b>Compartir → Agregar a pantalla de inicio</b>,
                  abre <b>Inventario</b> desde la pantalla de inicio y escribe el código.</li>
            </ol>` : `<div class="mensaje-error">Falta la dirección de la app del celular. ${App.usuario.rol === 'admin'
              ? 'Escríbela en Administración → Datos del ticket (se obtiene al publicar la app; ver docs/celular.md).'
              : 'Pide al administrador que la configure.'} Mientras tanto, si la app ya está instalada, escribe este código en ella.</div>`}
          </div>
        </div>`;
      const vence = new Date(v.expira).getTime();
      let vueltas = 0;
      const marcar = async () => {
        if (!abierto()) return detener();
        const resta = Math.max(0, Math.round((vence - Date.now()) / 1000));
        const texto = modal.querySelector('#celular-vence');
        if (resta === 0) {
          detener();
          zona.querySelector('.celular-vinculo').classList.add('vencido');
          texto.textContent = 'El código venció. Genera otro.';
          return;
        }
        texto.textContent = `Vence en ${Math.floor(resta / 60)}:${String(resta % 60).padStart(2, '0')}`;
        vueltas += 1;
        if (vueltas % 4 === 0) {
          // ¿Ya se vinculó? (aparece una sesión nueva de esa persona)
          const sesiones = await pintarLista();
          const nueva = sesiones.find((s) => !sesionesAntes.has(s.id) && s.usuario_id === v.usuario.id);
          if (nueva && abierto()) {
            detener();
            zona.innerHTML = `<div class="celular-listo"><svg class="icono"><use href="#i-check"/></svg>
              Listo: el celular de ${escaparHtml(v.usuario.nombre)} quedó vinculado (${escaparHtml(nueva.dispositivo || 'Celular')}).</div>`;
          }
        }
      };
      marcar();
      reloj = setInterval(marcar, 1000);
    } catch (error) {
      zona.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
    } finally {
      boton.disabled = false;
    }
  }

  modal.querySelector('#celular-generar').addEventListener('click', generar);
  modal.querySelector('#celular-lista').addEventListener('click', async (e) => {
    const boton = e.target.closest('[data-desvincular]');
    if (!boton) return;
    const confirmado = await confirmar({
      titulo: 'Desvincular celular',
      mensaje: 'Ese celular dejará de poder entrar a la app al momento. Para volver a usarlo habrá que vincularlo con un código nuevo.',
      boton: 'Desvincular',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api(`/api/celulares/${boton.dataset.desvincular}`, { method: 'DELETE' });
      aviso('Celular desvinculado', 'exito');
    } catch (error) {
      aviso(error.message, 'error');
    }
    pintarLista();
  });
  pintarLista();
}

async function abrirEnCelular() {
  if (App.usuario?.modo === 'central') return vincularCelular();
  const base = String(App.config?.url_movil || location.origin).replace(/\/+$/, '');
  const url = `${base}/movil.html`;
  const segura = /^https:\/\//i.test(base);
  let qr;
  try {
    await cargarZxing();
    qr = codigoQrSvg(url);
  } catch (err) {
    qr = `<p>${escaparHtml(err.message)}</p>`;
  }
  abrirModal(`
    <h3>Inventario en el celular</h3>
    <p>Escanea este código con la cámara del celular para abrir el inventario móvil: recibir mercancía,
       contar estantes y consultar precios y existencias de todas las sucursales.</p>
    <div class="qr-celular">${qr}</div>
    <p style="text-align:center"><b>${escaparHtml(url)}</b></p>
    ${segura ? '' : `<div class="mensaje-error">Esta dirección no es segura (no empieza con https://), así que el celular no podrá usar la cámara:
       solo se podrá escribir el código o usar un lector Bluetooth. ${App.usuario.rol === 'admin'
         ? 'Configura la dirección segura en Administración → Datos del ticket (instrucciones en docs/celular.md).'
         : 'Pide al administrador que configure la dirección segura.'}</div>`}
    <div class="pie"><button class="boton" onclick="cerrarModal()">Cerrar</button></div>`);
}

document.getElementById('boton-celular').addEventListener('click', () => {
  abrirEnCelular().catch((err) => aviso(err.message, 'error'));
});

document.getElementById('estado-sync').addEventListener('click', () => {
  if (App.usuario?.rol === 'admin' && App.usuario.es_central === 1) {
    mostrarSeccion('admin');
    return;
  }
  aviso(document.getElementById('estado-sync').title);
});

// ---------- Arranque ----------
async function iniciar() {
  try {
    App.usuario = await api('/api/auth/yo');
  } catch {
    return; // api() ya redirigió al login
  }
  // En un celular se abre el inventario móvil (con ?escritorio=1 se puede forzar esta versión)
  if (window.matchMedia('(max-width: 700px)').matches && !new URLSearchParams(location.search).has('escritorio')) {
    location.replace('/movil.html');
    return;
  }
  [App.sucursales, App.config] = await Promise.all([
    api('/api/admin/sucursales'),
    api('/api/config').catch(() => null),
  ]);
  pintarInfoUsuario();
  await pedirApertura();
  if (App.usuario.rol === 'admin' && App.usuario.es_central === 1) {
    document.querySelectorAll('.solo-admin').forEach((el) => { el.hidden = false; });
  }
  revisarSincronizacion();
  setInterval(revisarSincronizacion, 30000);
  document.getElementById('entrada-codigo').focus();
  document.dispatchEvent(new Event('app:listo'));
}

iniciar();
