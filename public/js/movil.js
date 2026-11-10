// Inventario desde el celular: consultar precio, existencias y últimos movimientos; recibir
// mercancía, contar (el inventario del día y conteos libres) y revisar los apoyos que llegan. El
// administrador de la central consulta y arma cotizaciones que manda a una sucursal para que ahí se
// cobren; el jefe además tiene Inicio, Movimientos y Más (movil-jefe.js). El inventario del día
// está en movil-conteo.js. Usa los mismos permisos y el mismo inventario que la computadora.
//
// Funciona de dos maneras:
// - Servida por la computadora de la farmacia (/movil.html): usa la sesión de la computadora.
// - Como app en la nube (instalada desde la dirección https de Cloudflare): habla con la función
//   "movil" de Supabase, así funciona aunque las computadoras estén apagadas. El celular se vincula
//   una sola vez con un código que genera la computadora y guarda su propia sesión.
const NUBE = String((window.FARMACIA_CONFIG && window.FARMACIA_CONFIG.api) || '').replace(/\/+$/, '');
const CLAVE_SESION = 'farmacia.movil.sesion';
const CLAVE_PERFIL = 'farmacia.movil.perfil';

const M = {
  token: '', // sesión del celular (solo en la nube)
  usuario: null,
  sucursales: [],
  sucursalId: null, // sucursal con la que se trabaja (el administrador de la central puede elegir)
  vista: 'consultar',
  producto: null, // producto que se está consultando
  porCodigo: new Map(), // código de barras -> producto
  buscando: new Map(), // código -> consulta en curso
  recepcion: { renglones: [], noEncontrados: [] },
  conteo: { renglones: [], noEncontrados: [] },
  cotizacion: { renglones: [], cliente: '', nota: '', sucursal: '', usuario: '' },
  destinos: null, // sucursales y usuarios a los que se manda una cotización
  enviadas: [], // cotizaciones que ya se mandaron
  apoyos: null, // apoyos por recibir en la sucursal
  revision: null, // apoyo que se está revisando: { apoyo, contado: { renglonId: piezas }, extras, noEncontrados }
};

const $ = (id) => document.getElementById(id);

// ---------- Utilidades ----------
function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

function dinero(n) {
  return '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cantidadTexto(valor) {
  return String(Math.round((Number(valor) || 0) * 1000) / 1000);
}

const redondear = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// "2026-10-12T15:30:00Z" (nube) o "2026-10-12 09:30:00" (computadora) -> "12 oct 2026, 9:30"
function fechaCorta(texto) {
  const valor = String(texto || '');
  const fecha = new Date(valor.includes('T') ? valor : valor.replace(' ', 'T'));
  if (Number.isNaN(fecha.getTime())) return valor;
  return fecha.toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const esAdminCentral = () => M.usuario && M.usuario.rol === 'admin' && Number(M.usuario.es_central) === 1;
const esJefe = () => esAdminCentral() && Number(M.usuario.jefe) === 1;
// Pestañas de abajo. El jefe: Inicio, Consultar, Movimientos, Cotizar y Más (recibir y contar van en Más).
// El administrador de la central consulta y cotiza; las sucursales, todo lo de inventario.
// Los administradores también ven los movimientos de su sucursal.
function vistasEnBarra() {
  if (esJefe()) return ['inicio', 'consultar', 'movimientos', 'cotizar', 'mas'];
  const base = esAdminCentral() ? ['consultar', 'cotizar'] : ['consultar', 'recibir', 'contar', 'apoyos'];
  return M.usuario && M.usuario.rol === 'admin' ? [...base, 'movimientos'] : base;
}
const vistasPermitidas = () => (esJefe() ? [...vistasEnBarra(), 'recibir', 'contar'] : vistasEnBarra());
const VISTAS = ['inicio', 'consultar', 'movimientos', 'cotizar', 'recibir', 'contar', 'apoyos', 'mas'];

// Solo el día: "21 oct"
function fechaDia(texto) {
  const fecha = new Date(String(texto || '').replace(' ', 'T'));
  return Number.isNaN(fecha.getTime()) ? '' : fecha.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
const nombreSucursal = (id = M.sucursalId) => (M.sucursales.find((s) => s.id === Number(id)) || {}).nombre || '';

let temporizadorAviso = null;
function aviso(texto, tipo = '') {
  const el = $('m-aviso');
  el.textContent = texto;
  el.className = `m-aviso ${tipo}`;
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.hidden = true; }, tipo === 'error' ? 5000 : 3000);
}

async function api(ruta, opciones = {}) {
  const cabeceras = { 'Content-Type': 'application/json' };
  if (NUBE) {
    if (!M.token) {
      mostrarVincular();
      throw new Error('Este celular no está vinculado');
    }
    cabeceras.Authorization = `Bearer ${M.token}`;
  }
  let r;
  try {
    r = await fetch(NUBE + ruta, {
      ...opciones,
      headers: cabeceras,
      body: opciones.body ? JSON.stringify(opciones.body) : undefined,
    });
  } catch {
    const error = new Error(NUBE
      ? 'Sin conexión a internet. Revisa los datos o el wifi del celular.'
      : 'Sin conexión con el servidor de la farmacia. Revisa el internet del celular.');
    error.sinConexion = true;
    throw error;
  }
  if (r.status === 401) {
    if (NUBE) {
      olvidarSesion();
      mostrarVincular({ error: 'La sesión de este celular se cerró. Vincúlalo otra vez con un código de la computadora.' });
    } else {
      location.href = '/login.html?volver=/movil.html';
    }
    throw new Error('Sesión expirada');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(datos.error || 'Error del servidor');
    error.status = r.status;
    error.codigo = datos.codigo;
    throw error;
  }
  return datos;
}

// ---------- Borradores guardados en el celular ----------
function clave(nombre, sucursalId = M.sucursalId) {
  return `farmacia.movil.${M.usuario.id}.${sucursalId}.${nombre}`;
}

function guardarBorrador(nombre, valor) {
  try { localStorage.setItem(clave(nombre), JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
}

function leerBorrador(nombre, porDefecto) {
  try {
    const texto = localStorage.getItem(clave(nombre));
    return texto ? { ...porDefecto, ...JSON.parse(texto) } : porDefecto;
  } catch {
    return porDefecto;
  }
}

function cargarBorradores() {
  M.recepcion = leerBorrador('recepcion', { renglones: [], noEncontrados: [], nota: '' });
  M.conteo = leerBorrador('conteo', { renglones: [], noEncontrados: [], nota: '' });
  $('rec-nota').value = M.recepcion.nota || '';
  $('con-nota').value = M.conteo.nota || '';
  pintarRecepcion();
  pintarConteo();
  if (esAdminCentral()) {
    M.cotizacion = leerCotizacion();
    $('cot-cliente').value = M.cotizacion.cliente || '';
    $('cot-nota').value = M.cotizacion.nota || '';
    pintarCotizacion();
  }
}

// ---------- Capas: hoja inferior y botón "atrás" del celular ----------
let alCerrarHoja = null;
let ignorarPop = false;

function abrirHoja(html) {
  const hoja = $('m-hoja');
  hoja.innerHTML = html;
  const fondo = $('m-fondo-hoja');
  if (fondo.hidden) history.pushState({ capa: 'hoja' }, '');
  fondo.hidden = false;
  const primero = hoja.querySelector('input:not([type=checkbox]), select');
  if (primero) setTimeout(() => { primero.focus(); if (primero.select) primero.select(); }, 60);
  return hoja;
}

function cerrarHoja({ desdeHistorial = false } = {}) {
  const fondo = $('m-fondo-hoja');
  if (fondo.hidden) return;
  fondo.hidden = true;
  $('m-hoja').innerHTML = '';
  const alCerrar = alCerrarHoja;
  alCerrarHoja = null;
  if (!desdeHistorial && history.state && history.state.capa === 'hoja') {
    ignorarPop = true;
    history.back();
  }
  if (alCerrar) alCerrar();
}

window.addEventListener('popstate', () => {
  if (ignorarPop) {
    ignorarPop = false;
    return;
  }
  if (!$('m-fondo-hoja').hidden) cerrarHoja({ desdeHistorial: true });
  else if (Escaner.abierto()) Escaner.cerrar();
});

$('m-fondo-hoja').addEventListener('click', (e) => {
  if (e.target.id === 'm-fondo-hoja') cerrarHoja();
});

function confirmarHoja({ titulo, mensaje, boton = 'Aceptar', peligro = false }) {
  return new Promise((resolver) => {
    const hoja = abrirHoja(`
      <h3>${titulo}</h3>
      <p>${mensaje}</p>
      <div class="m-botones">
        <button class="m-boton secundario" data-r="no">Cancelar</button>
        <button class="m-boton ${peligro ? 'peligro' : 'principal'}" data-r="si">${boton}</button>
      </div>`);
    let respuesta = false;
    alCerrarHoja = () => resolver(respuesta);
    hoja.querySelector('[data-r="si"]').addEventListener('click', () => { respuesta = true; cerrarHoja(); });
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  });
}

// Pide una cantidad (y opcionalmente una nota). Resuelve { cantidad, nota } o null.
function pedirCantidad({ titulo, mensaje = '', valor = 1, boton = 'Aceptar', permitirCero = false, conNota = false, notaPlaceholder = '' }) {
  return new Promise((resolver) => {
    const hoja = abrirHoja(`
      <h3>${titulo}</h3>
      ${mensaje ? `<p>${mensaje}</p>` : ''}
      <input class="grande" id="hoja-cantidad" type="number" inputmode="decimal" min="0" step="any" value="${valor}" aria-label="Cantidad">
      ${conNota ? `<input id="hoja-nota" type="text" maxlength="200" placeholder="${escaparHtml(notaPlaceholder)}" aria-label="Nota">` : ''}
      <div id="hoja-error" class="m-error" hidden></div>
      <div class="m-botones">
        <button class="m-boton secundario" data-r="no">Cancelar</button>
        <button class="m-boton principal" data-r="si">${boton}</button>
      </div>`);
    let respuesta = null;
    alCerrarHoja = () => resolver(respuesta);
    const entrada = hoja.querySelector('#hoja-cantidad');
    const aceptar = () => {
      const cantidad = Number(String(entrada.value).replace(',', '.'));
      if (entrada.value === '' || !Number.isFinite(cantidad) || cantidad < 0 || (!permitirCero && cantidad === 0)) {
        const error = hoja.querySelector('#hoja-error');
        error.textContent = permitirCero ? 'Escribe una cantidad válida' : 'Escribe una cantidad mayor a cero';
        error.hidden = false;
        entrada.focus();
        return;
      }
      respuesta = { cantidad: redondear(cantidad), nota: hoja.querySelector('#hoja-nota')?.value.trim() || '' };
      cerrarHoja();
    };
    hoja.querySelector('[data-r="si"]').addEventListener('click', aceptar);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); aceptar(); }
    });
  });
}

// ---------- Productos ----------
function existenciaEn(producto, sucursalId = M.sucursalId) {
  const e = (producto.existencias || []).find((x) => x.sucursal_id === Number(sucursalId));
  return e ? Number(e.existencia) : 0;
}

function recordar(producto) {
  if (producto.codigo_barras) M.porCodigo.set(producto.codigo_barras, producto);
}

// Busca por código exacto (null si no existe). fresco = consultar existencias al momento.
function productoPorCodigo(codigo, { fresco = false } = {}) {
  if (!fresco && M.porCodigo.has(codigo)) return Promise.resolve(M.porCodigo.get(codigo));
  if (M.buscando.has(codigo)) return M.buscando.get(codigo);
  const consulta = api('/api/productos/codigo/' + encodeURIComponent(codigo))
    .then((p) => { recordar(p); return p; })
    .catch((error) => {
      if (error.status === 404) return null;
      throw error;
    })
    .finally(() => M.buscando.delete(codigo));
  M.buscando.set(codigo, consulta);
  return consulta;
}

async function productoPorId(id) {
  const r = await api(`/api/productos/${id}/kardex?limite=1`);
  recordar(r.producto);
  return r.producto;
}

// Lo que se escribió o se leyó con un lector Bluetooth
async function capturar(texto) {
  const valor = String(texto || '').trim();
  if (!valor) return;
  if (M.vista === 'apoyos' && M.revision) {
    const renglon = renglonApoyoPorCodigo(valor);
    if (renglon) return contarRenglonApoyo(renglon, 1);
  }
  if (M.vista === 'contar' && diaAbierto()) return capturarEnDia(valor);
  if (M.vista === 'movimientos') return filtrarMovimientosPorProducto(valor);
  try {
    const pareceCodigo = !/\s/.test(valor) && /\d{3,}/.test(valor);
    if (pareceCodigo) {
      const producto = await productoPorCodigo(valor, { fresco: M.vista !== 'recibir' });
      if (producto) return usarProducto(producto);
    }
    const resultados = await api('/api/productos/buscar?q=' + encodeURIComponent(valor));
    if (resultados.length === 0) return noEncontrado(valor, { pareceCodigo });
    if (resultados.length === 1) return usarProducto(resultados[0]);
    elegirDeResultados(resultados);
  } catch (error) {
    aviso(error.message, 'error');
  }
}

function elegirDeResultados(resultados) {
  const hoja = abrirHoja(`
    <h3>Elige el producto</h3>
    <ul class="m-resultados">
      ${resultados.map((p, i) => `<li><button data-i="${i}">
        <span>${escaparHtml(p.descripcion)}<small>${escaparHtml(p.codigo_barras || 'Sin código')}</small></span>
        <span><b>${dinero(p.precio_venta)}</b><small>Hay ${cantidadTexto(existenciaEn(p))}</small></span>
      </button></li>`).join('')}
    </ul>
    <button class="m-boton secundario" data-r="no">Cerrar</button>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelectorAll('button[data-i]').forEach((b) => {
    b.addEventListener('click', () => {
      const producto = resultados[Number(b.dataset.i)];
      cerrarHoja();
      recordar(producto);
      usarProducto(producto);
    });
  });
}

async function usarProducto(producto) {
  if (M.vista === 'recibir') {
    if ($('rec-preguntar').checked) {
      const r = await pedirCantidad({ titulo: producto.descripcion, mensaje: '¿Cuántas piezas llegaron?', boton: 'Agregar' });
      if (r) agregarRecepcion(producto, r.cantidad);
    } else {
      agregarRecepcion(producto, 1);
    }
    return;
  }
  if (M.vista === 'contar') {
    await agregarConteo(producto, 1);
    return;
  }
  if (M.vista === 'cotizar') {
    agregarCotizacion(producto, 1);
    return;
  }
  if (M.vista === 'apoyos') {
    if (M.revision) contarApoyo(producto, 1);
    else aviso('Primero abre el apoyo que llegó', 'error');
    return;
  }
  mostrarProducto(producto);
}

function noEncontrado(codigo, { pareceCodigo = true } = {}) {
  if (M.vista === 'consultar' || !pareceCodigo) {
    // Cualquier usuario puede dar de alta un producto nuevo (con sus piezas en su sucursal)
    const puedeAlta = pareceCodigo;
    const hoja = abrirHoja(`
      <h3>No se encontró</h3>
      <p>${pareceCodigo ? `El código <b>${escaparHtml(codigo)}</b> no está en el catálogo. Si es un producto nuevo, dalo de alta.` : `No hay productos que coincidan con "<b>${escaparHtml(codigo)}</b>".`}</p>
      <div class="m-botones">
        <button class="m-boton secundario" data-r="no">Cerrar</button>
        ${puedeAlta ? '<button class="m-boton principal" data-r="alta">Dar de alta</button>' : ''}
      </div>`);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.querySelector('[data-r="alta"]')?.addEventListener('click', () => altaProducto(codigo));
    return;
  }
  registrarNoEncontrado(codigo);
  aviso(`El código ${codigo} no está en el catálogo`, 'error');
}

function registrarNoEncontrado(codigo) {
  if (M.vista === 'cotizar') return; // en la cotización solo se avisa
  if (M.vista === 'apoyos') {
    if (!M.revision) return;
    if (!M.revision.noEncontrados.includes(codigo)) M.revision.noEncontrados.push(codigo);
    pintarRevision();
    return;
  }
  const lista = M.vista === 'contar' ? M.conteo : M.recepcion;
  if (!lista.noEncontrados.includes(codigo)) lista.noEncontrados.push(codigo);
  if (M.vista === 'contar') pintarConteo();
  else pintarRecepcion();
}

function pintarNoEncontrados(contenedor, lista) {
  if (!lista.noEncontrados.length) {
    contenedor.innerHTML = '';
    return;
  }
  contenedor.innerHTML = `<div class="m-no-encontrados">
    <b>No están en el catálogo:</b> ${lista.noEncontrados.map((c) => `<button class="m-accion" data-alta="${escaparHtml(c)}">Dar de alta ${escaparHtml(c)}</button>`).join(' ')}
    <br><button class="m-accion" data-limpiar-no-encontrados>Quitar de la lista</button>
  </div>`;
}

// Alta rápida de un producto que no está en el catálogo (cualquier usuario). Al consultar se
// escriben las piezas que hay; al recibir o contar, las piezas se suman con la lista.
function altaProducto(codigo) {
  const conPiezas = M.vista === 'consultar';
  const hoja = abrirHoja(`
    <h3>Nuevo producto</h3>
    <label>Código de barras <input id="alta-codigo" type="text" value="${escaparHtml(codigo)}" readonly></label>
    <label>Descripción <input id="alta-descripcion" type="text" maxlength="200" placeholder="Ej. Paracetamol 500 mg c/10"></label>
    <div class="m-fila">
      <label>Costo <input id="alta-costo" type="number" inputmode="decimal" step="0.01" min="0"></label>
      <label>Precio de venta <input id="alta-venta" type="number" inputmode="decimal" step="0.01" min="0"></label>
    </div>
    ${conPiezas ? `<label>Piezas que hay en ${escaparHtml(nombreSucursal())} <input id="alta-piezas" type="number" inputmode="decimal" step="any" min="0" placeholder="0"></label>` : ''}
    <p class="m-nota-hoja">El precio vale para todas las sucursales; después solo la central lo puede cambiar.${conPiezas ? '' : ' Las piezas se suman con la lista que estás haciendo.'}</p>
    <div id="hoja-error" class="m-error" hidden></div>
    <div class="m-botones">
      <button class="m-boton secundario" data-r="no">Cancelar</button>
      <button class="m-boton principal" data-r="si">Guardar</button>
    </div>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelector('[data-r="si"]').addEventListener('click', async () => {
    const error = hoja.querySelector('#hoja-error');
    error.hidden = true;
    try {
      await api('/api/productos', {
        method: 'POST',
        body: {
          codigo_barras: codigo,
          descripcion: hoja.querySelector('#alta-descripcion').value,
          precio_costo: hoja.querySelector('#alta-costo').value,
          precio_venta: hoja.querySelector('#alta-venta').value,
          usa_inventario: true,
          sucursal_id: M.sucursalId,
          existencia_inicial: conPiezas ? hoja.querySelector('#alta-piezas').value || 0 : 0,
        },
      });
      cerrarHoja();
      for (const lista of [M.recepcion, M.conteo]) lista.noEncontrados = lista.noEncontrados.filter((c) => c !== codigo);
      aviso('Producto dado de alta', 'exito');
      const producto = await productoPorCodigo(codigo, { fresco: true });
      if (producto) usarProducto(producto);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  });
}

// ---------- Consultar ----------
function guardarReciente(producto) {
  try {
    const claveRecientes = `farmacia.movil.${M.usuario.id}.recientes`;
    const lista = JSON.parse(localStorage.getItem(claveRecientes) || '[]').filter((p) => p.id !== producto.id);
    lista.unshift({ id: producto.id, descripcion: producto.descripcion, codigo_barras: producto.codigo_barras });
    localStorage.setItem(claveRecientes, JSON.stringify(lista.slice(0, 8)));
  } catch { /* sin almacenamiento */ }
  pintarRecientes();
}

function pintarRecientes() {
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(`farmacia.movil.${M.usuario.id}.recientes`) || '[]'); } catch { lista = []; }
  $('consulta-recientes').innerHTML = lista.length ? `
    <div class="m-titulo-seccion">Consultados hace poco</div>
    <ul class="m-resultados">${lista.map((p) => `<li><button data-reciente="${p.id}">
      <span>${escaparHtml(p.descripcion)}<small>${escaparHtml(p.codigo_barras || 'Sin código')}</small></span></button></li>`).join('')}
    </ul>` : '';
}

function mostrarProducto(p) {
  M.producto = p;
  recordar(p);
  guardarReciente(p);
  const existencias = [...(p.existencias || [])].sort((a, b) => (b.sucursal_id === M.sucursalId) - (a.sucursal_id === M.sucursalId));
  $('consulta-resultado').innerHTML = `
    <div class="m-tarjeta">
      <div>
        <div class="m-producto-nombre">${escaparHtml(p.descripcion)}</div>
        <div class="m-producto-codigo">${escaparHtml(p.codigo_barras || 'Sin código')}${p.departamento ? ` · ${escaparHtml(p.departamento)}` : ''}</div>
      </div>
      <div class="m-precios">
        <div class="m-precio"><small>Precio</small><b>${dinero(p.precio_venta)}</b></div>
        ${p.precio_mayoreo != null ? `<div class="m-precio secundario"><small>Mayoreo${p.cantidad_mayoreo ? ` desde ${cantidadTexto(p.cantidad_mayoreo)}` : ''}</small><b>${dinero(p.precio_mayoreo)}</b></div>` : ''}
        <div class="m-precio secundario"><small>Costo</small><b>${dinero(p.precio_costo)}</b></div>
      </div>
      ${p.usa_inventario ? `<div class="m-existencias">${existencias.map((e) => `
        <div class="m-existencia ${e.sucursal_id === M.sucursalId ? 'propia' : ''} ${(e.minimo > 0 && e.existencia <= e.minimo) || e.existencia < 0 ? 'bajo' : ''}">
          <span>${escaparHtml(e.sucursal)}${e.minimo > 0 ? `<small>mín. ${cantidadTexto(e.minimo)}</small>` : ''}</span>
          <b>${cantidadTexto(e.existencia)}</b>
        </div>`).join('')}</div>` : '<div class="m-explicacion">Este producto no controla inventario.</div>'}
      ${p.usa_inventario ? '<div id="consulta-movimientos" class="m-movimientos"><div class="m-cargando">Cargando los últimos movimientos…</div></div>' : ''}
      <div class="m-acciones">
        ${esAdminCentral() ? `
          <button class="m-accion principal ancha" data-accion="cotizar"><svg class="icono"><use href="#i-cotizar"/></svg>Agregar a cotización</button>
          <button class="m-accion" data-accion="historial"><svg class="icono"><use href="#i-historial"/></svg>Historial</button>
          <button class="m-accion" data-accion="precio"><svg class="icono"><use href="#i-precio"/></svg>Cambiar precio</button>
          ${esJefe() && p.usa_inventario ? `<button class="m-accion ancha" data-accion="importante" id="consulta-importante" disabled>
            <svg class="icono"><use href="#i-estrella"/></svg><span>Importante para el inventario del día…</span></button>` : ''}` : `
          ${p.usa_inventario ? `
            <button class="m-accion principal" data-accion="entrada">Entrada</button>
            <button class="m-accion" data-accion="salida">Merma / salida</button>
            <button class="m-accion" data-accion="ajuste">Ajustar existencia</button>
            <button class="m-accion" data-accion="minimo">Mínimo</button>` : ''}
          <button class="m-accion ${p.usa_inventario ? 'ancha' : ''}" data-accion="historial"><svg class="icono"><use href="#i-historial"/></svg>Historial completo</button>`}
      </div>
    </div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (p.usa_inventario) pintarMovimientos(p);
  if (esJefe() && p.usa_inventario) pintarImportante(p);
}

const NOMBRES_MOVIMIENTO = { entrada: 'Entrada', salida: 'Salida', venta: 'Venta', ajuste: 'Ajuste' };

function filaMovimiento(m, { conSucursal = false } = {}) {
  const cantidad = m.delta == null ? `= ${cantidadTexto(m.cantidad)}` : `${m.delta > 0 ? '+' : '−'}${cantidadTexto(Math.abs(m.delta))}`;
  return `<li>
    <span>${escaparHtml(NOMBRES_MOVIMIENTO[m.tipo] || m.tipo)}${m.pendiente ? ' (por subir)' : ''}${conSucursal && m.sucursal ? ` · ${escaparHtml(m.sucursal)}` : ''}</span>
    <span class="${m.delta == null ? '' : m.delta > 0 ? 'mas' : 'menos'}">${cantidad}${m.existencia_resultante != null ? ` → ${cantidadTexto(m.existencia_resultante)}` : ''}</span>
    <small>${escaparHtml(fechaCorta(m.fecha))} · ${escaparHtml(m.usuario || '')}${m.nota ? ` · ${escaparHtml(m.nota)}` : ''}</small>
  </li>`;
}

// Últimos movimientos del producto consultado: los de la sucursal, o los de todas para el jefe
async function pintarMovimientos(p) {
  const todas = esAdminCentral();
  try {
    const r = await api(`/api/productos/${p.id}/kardex?limite=5${todas ? '' : `&sucursal_id=${M.sucursalId}`}`);
    const caja = $('consulta-movimientos');
    if (!caja || !M.producto || M.producto.id !== p.id) return; // ya se consultó otro producto
    caja.innerHTML = `<div class="m-movimientos-titulo">Últimos movimientos<small>${todas ? 'Todas las sucursales' : escaparHtml(nombreSucursal())}</small></div>
      ${r.movimientos.length
        ? `<ul class="m-historial">${r.movimientos.map((m) => filaMovimiento(m, { conSucursal: todas })).join('')}</ul>`
        : '<div class="m-sin-datos">Todavía no tiene movimientos.</div>'}`;
  } catch (error) {
    const caja = $('consulta-movimientos');
    if (caja && M.producto && M.producto.id === p.id) {
      caja.innerHTML = `<div class="m-sin-datos">No se pudieron cargar los movimientos: ${escaparHtml(error.message)}</div>`;
    }
  }
}

async function moverInventario(tipo) {
  const p = M.producto;
  const actual = existenciaEn(p);
  const textos = {
    entrada: { titulo: 'Entrada de mercancía', mensaje: `¿Cuántas piezas llegaron? Hay ${cantidadTexto(actual)} en ${nombreSucursal()}.`, boton: 'Sumar', nota: 'Proveedor o factura (opcional)' },
    salida: { titulo: 'Merma o salida', mensaje: `¿Cuántas piezas salen (caducadas, dañadas)? Hay ${cantidadTexto(actual)}.`, boton: 'Restar', nota: 'Motivo (opcional)' },
    ajuste: { titulo: 'Ajustar existencia', mensaje: `¿Cuántas piezas hay realmente en ${nombreSucursal()}? El sistema dice ${cantidadTexto(actual)}.`, boton: 'Ajustar', nota: 'Nota (opcional)' },
  }[tipo];
  const r = await pedirCantidad({
    titulo: textos.titulo, mensaje: textos.mensaje, valor: tipo === 'ajuste' ? actual : 1,
    boton: textos.boton, permitirCero: tipo === 'ajuste', conNota: true, notaPlaceholder: textos.nota,
  });
  if (!r) return;
  try {
    const resultado = await api(`/api/productos/${p.id}/inventario`, {
      method: 'POST',
      body: { tipo, cantidad: r.cantidad, nota: r.nota || (tipo === 'ajuste' ? 'Ajuste desde el celular' : ''), sucursal_id: M.sucursalId },
    });
    aviso(`Listo: ahora hay ${cantidadTexto(resultado.existencia)}`, 'exito');
    mostrarProducto(await productoPorId(p.id));
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function cambiarMinimo() {
  const p = M.producto;
  const actual = (p.existencias || []).find((e) => e.sucursal_id === M.sucursalId)?.minimo || 0;
  const r = await pedirCantidad({
    titulo: 'Mínimo para avisar',
    mensaje: `Cuando haya esta cantidad o menos en ${nombreSucursal()}, el producto aparece en "bajo mínimo" y en las sugerencias de pedido.`,
    valor: actual, boton: 'Guardar', permitirCero: true,
  });
  if (!r) return;
  try {
    await api(`/api/productos/${p.id}/inventario`, { method: 'POST', body: { minimo: r.cantidad, sucursal_id: M.sucursalId } });
    aviso('Mínimo actualizado', 'exito');
    mostrarProducto(await productoPorId(p.id));
  } catch (error) {
    aviso(error.message, 'error');
  }
}

// El jefe puede elegir la sucursal (o todas); los demás ven la suya
async function verHistorial(sucursal = esAdminCentral() ? '' : M.sucursalId) {
  const p = M.producto;
  try {
    const r = await api(`/api/productos/${p.id}/kardex?limite=40${sucursal ? `&sucursal_id=${sucursal}` : ''}`);
    const hoja = abrirHoja(`
      <h3>Historial — ${escaparHtml(p.descripcion)}</h3>
      ${esAdminCentral()
        ? `<select id="historial-sucursal" aria-label="Sucursal"><option value="">Todas las sucursales</option>
            ${M.sucursales.map((x) => `<option value="${x.id}" ${Number(sucursal) === x.id ? 'selected' : ''}>${escaparHtml(x.nombre)}</option>`).join('')}</select>`
        : `<p>${escaparHtml(nombreSucursal())}</p>`}
      <ul class="m-historial">
        ${r.movimientos.map((m) => filaMovimiento(m, { conSucursal: !sucursal })).join('') || '<li>Sin movimientos</li>'}
      </ul>
      <button class="m-boton secundario" data-r="no">Cerrar</button>`);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.querySelector('#historial-sucursal')?.addEventListener('change', (e) => {
      cerrarHoja();
      verHistorial(e.target.value);
    });
  } catch (error) {
    aviso(error.message, 'error');
  }
}

// Solo el administrador de la central: el precio se aplica en todas las sucursales
function cambiarPrecio() {
  const p = M.producto;
  const hoja = abrirHoja(`
    <h3>Precio — ${escaparHtml(p.descripcion)}</h3>
    <p>El cambio se aplica en todas las sucursales.</p>
    <div class="m-fila">
      <label>Precio de venta <input id="precio-venta" type="number" inputmode="decimal" step="0.01" min="0" value="${p.precio_venta}"></label>
      <label>Costo <input id="precio-costo" type="number" inputmode="decimal" step="0.01" min="0" value="${p.precio_costo}"></label>
    </div>
    <div class="m-fila">
      <label>Mayoreo <input id="precio-mayoreo" type="number" inputmode="decimal" step="0.01" min="0" value="${p.precio_mayoreo ?? ''}" placeholder="Sin mayoreo"></label>
      <label>Desde (piezas) <input id="precio-cantidad" type="number" inputmode="decimal" step="any" min="0" value="${p.cantidad_mayoreo ?? ''}" placeholder="Solo con F11"></label>
    </div>
    <div id="hoja-error" class="m-error" hidden></div>
    <div class="m-botones">
      <button class="m-boton secundario" data-r="no">Cancelar</button>
      <button class="m-boton principal" data-r="si">Guardar precio</button>
    </div>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelector('[data-r="si"]').addEventListener('click', async () => {
    const error = hoja.querySelector('#hoja-error');
    error.hidden = true;
    try {
      await api(`/api/productos/${p.id}`, {
        method: 'PUT',
        body: {
          codigo_barras: p.codigo_barras,
          descripcion: p.descripcion,
          departamento: p.departamento,
          usa_inventario: Boolean(p.usa_inventario),
          precio_venta: hoja.querySelector('#precio-venta').value,
          precio_costo: hoja.querySelector('#precio-costo').value,
          precio_mayoreo: hoja.querySelector('#precio-mayoreo').value,
          cantidad_mayoreo: hoja.querySelector('#precio-cantidad').value,
        },
      });
      cerrarHoja();
      aviso('Precio actualizado en todas las sucursales', 'exito');
      mostrarProducto(await productoPorId(p.id));
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  });
}

$('consulta-resultado').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton || !M.producto) return;
  const accion = boton.dataset.accion;
  if (['entrada', 'salida', 'ajuste'].includes(accion)) moverInventario(accion);
  if (accion === 'minimo') cambiarMinimo();
  if (accion === 'historial') verHistorial();
  if (accion === 'precio') cambiarPrecio();
  if (accion === 'cotizar') agregarACotizacionDesdeConsulta();
  if (accion === 'importante') cambiarImportante(boton);
});

$('consulta-recientes').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-reciente]');
  if (!boton) return;
  try {
    mostrarProducto(await productoPorId(Number(boton.dataset.reciente)));
  } catch (error) {
    aviso(error.message, 'error');
  }
});

// ---------- Recibir mercancía ----------
function agregarRecepcion(producto, cantidad) {
  let renglon = M.recepcion.renglones.find((r) => r.producto_id === producto.id);
  if (renglon) {
    renglon.cantidad = redondear(renglon.cantidad + cantidad);
    M.recepcion.renglones = [renglon, ...M.recepcion.renglones.filter((r) => r !== renglon)];
  } else {
    renglon = { producto_id: producto.id, descripcion: producto.descripcion, codigo_barras: producto.codigo_barras, cantidad: redondear(cantidad) };
    M.recepcion.renglones.unshift(renglon);
  }
  pintarRecepcion(producto.id);
  if (Escaner.abierto()) {
    Escaner.informar(`${escaparHtml(producto.descripcion)}<br><b>${cantidadTexto(renglon.cantidad)}</b> pieza(s)`, {
      boton: { texto: '+1', alPulsar: () => { Escaner.sonar('ok'); agregarRecepcion(producto, 1); } },
    });
  }
  return renglon;
}

function pintarRecepcion(nuevo = null) {
  const lista = M.recepcion.renglones;
  $('rec-lista').innerHTML = lista.map((r) => `
    <li class="m-renglon ${r.producto_id === nuevo ? 'nuevo' : ''}" data-id="${r.producto_id}">
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div><div class="m-renglon-dato">${escaparHtml(r.codigo_barras || 'Sin código')}</div></div>
      <button class="m-quitar" data-accion="quitar" aria-label="Quitar"><svg class="icono"><use href="#i-x"/></svg></button>
      <div class="m-paso">
        <button data-accion="menos" aria-label="Una menos"><svg class="icono"><use href="#i-menos"/></svg></button>
        <input type="number" inputmode="decimal" min="0" step="any" value="${cantidadTexto(r.cantidad)}" data-accion="cantidad" aria-label="Cantidad">
        <button data-accion="mas" aria-label="Una más"><svg class="icono"><use href="#i-mas"/></svg></button>
      </div>
    </li>`).join('') || '<li class="m-vacio">Todavía no hay productos. Toca <b>Escanear</b> y apunta al código de cada producto que llegó.</li>';
  const piezas = redondear(lista.reduce((t, r) => t + r.cantidad, 0));
  $('rec-productos').textContent = lista.length;
  $('rec-piezas').textContent = cantidadTexto(piezas);
  $('rec-aplicar').disabled = lista.length === 0;
  $('nav-recibir').hidden = lista.length === 0;
  $('nav-recibir').textContent = lista.length;
  pintarNoEncontrados($('rec-no-encontrados'), M.recepcion);
  M.recepcion.nota = $('rec-nota').value;
  guardarBorrador('recepcion', M.recepcion);
}

function cambiarRenglon(lista, campo, e, pintar) {
  const fila = e.target.closest('li[data-id]');
  if (!fila) return;
  const renglon = lista.renglones.find((r) => r.producto_id === Number(fila.dataset.id));
  if (!renglon) return;
  const accion = e.target.closest('[data-accion]')?.dataset.accion;
  if (accion === 'quitar') lista.renglones = lista.renglones.filter((r) => r !== renglon);
  if (accion === 'menos') renglon[campo] = Math.max(0, redondear(renglon[campo] - 1));
  if (accion === 'mas') renglon[campo] = redondear(renglon[campo] + 1);
  if (accion === 'cantidad' && e.type === 'change') {
    const valor = Number(String(e.target.value).replace(',', '.'));
    renglon[campo] = Number.isFinite(valor) && valor >= 0 ? redondear(valor) : renglon[campo];
  }
  // En recepción una cantidad en cero quita el producto
  if (campo === 'cantidad' && renglon.cantidad === 0) lista.renglones = lista.renglones.filter((r) => r !== renglon);
  pintar();
}

$('rec-lista').addEventListener('click', (e) => {
  if (e.target.closest('button[data-accion]')) cambiarRenglon(M.recepcion, 'cantidad', e, pintarRecepcion);
});
$('rec-lista').addEventListener('change', (e) => {
  if (e.target.matches('input[data-accion="cantidad"]')) cambiarRenglon(M.recepcion, 'cantidad', e, pintarRecepcion);
});
$('rec-nota').addEventListener('input', () => {
  M.recepcion.nota = $('rec-nota').value;
  guardarBorrador('recepcion', M.recepcion);
});

$('rec-aplicar').addEventListener('click', async () => {
  const lista = M.recepcion.renglones;
  if (!lista.length) return;
  const piezas = redondear(lista.reduce((t, r) => t + r.cantidad, 0));
  const confirmado = await confirmarHoja({
    titulo: 'Aplicar entrada',
    mensaje: `Se van a sumar <b>${cantidadTexto(piezas)} pieza(s)</b> de <b>${lista.length} producto(s)</b> al inventario de <b>${escaparHtml(nombreSucursal())}</b>.`,
    boton: 'Aplicar entrada',
  });
  if (!confirmado) return;
  const boton = $('rec-aplicar');
  boton.disabled = true;
  boton.textContent = 'Aplicando…';
  try {
    const r = await api('/api/productos/inventario/lote', {
      method: 'POST',
      body: {
        tipo: 'entrada',
        sucursal_id: M.sucursalId,
        nota: $('rec-nota').value,
        renglones: lista.map((x) => ({ producto_id: x.producto_id, cantidad: x.cantidad })),
      },
    });
    M.recepcion = { renglones: [], noEncontrados: [], nota: '' };
    $('rec-nota').value = '';
    M.porCodigo.clear();
    aviso(`Entrada aplicada: ${r.aplicados} producto(s), ${cantidadTexto(piezas)} pieza(s)${r.omitidos.length ? `. Sin control de inventario: ${r.omitidos.join(', ')}` : ''}`, 'exito');
  } catch (error) {
    aviso(error.message, 'error');
  } finally {
    boton.textContent = 'Aplicar entrada al inventario';
    pintarRecepcion();
  }
});

$('rec-vaciar').addEventListener('click', async () => {
  if (!M.recepcion.renglones.length && !M.recepcion.noEncontrados.length) return;
  const confirmado = await confirmarHoja({ titulo: 'Vaciar lista', mensaje: 'Se borra la lista sin tocar el inventario.', boton: 'Vaciar', peligro: true });
  if (!confirmado) return;
  M.recepcion = { renglones: [], noEncontrados: [], nota: '' };
  $('rec-nota').value = '';
  pintarRecepcion();
});

// ---------- Contar (toma de inventario) ----------
async function agregarConteo(producto, cantidad) {
  let renglon = M.conteo.renglones.find((r) => r.producto_id === producto.id);
  if (!renglon) {
    // La existencia del sistema se toma al momento de empezar a contar ese producto
    let fresco = producto;
    try {
      fresco = (producto.codigo_barras && await productoPorCodigo(producto.codigo_barras, { fresco: true })) || await productoPorId(producto.id);
    } catch { /* se usa lo que ya se tenía */ }
    renglon = M.conteo.renglones.find((r) => r.producto_id === producto.id);
    if (!renglon) {
      if (!fresco.usa_inventario) {
        aviso(`"${producto.descripcion}" no controla inventario`, 'error');
        return null;
      }
      renglon = {
        producto_id: producto.id,
        descripcion: producto.descripcion,
        codigo_barras: producto.codigo_barras,
        contado: 0,
        existencia_al_contar: existenciaEn(fresco),
      };
      M.conteo.renglones.unshift(renglon);
    }
  } else {
    M.conteo.renglones = [renglon, ...M.conteo.renglones.filter((r) => r !== renglon)];
  }
  renglon.contado = redondear(renglon.contado + cantidad);
  pintarConteo(producto.id);
  if (Escaner.abierto()) {
    Escaner.informar(`${escaparHtml(producto.descripcion)}<br>Contadas <b>${cantidadTexto(renglon.contado)}</b> · sistema ${cantidadTexto(renglon.existencia_al_contar)}`, {
      boton: { texto: '+1', alPulsar: () => { Escaner.sonar('ok'); agregarConteo(producto, 1); } },
    });
  }
  return renglon;
}

function pintarConteo(nuevo = null) {
  const lista = M.conteo.renglones;
  $('con-lista').innerHTML = lista.map((r) => {
    const diferencia = redondear(r.contado - r.existencia_al_contar);
    const clase = diferencia > 0 ? 'mas' : diferencia < 0 ? 'menos' : 'igual';
    const texto = diferencia === 0 ? 'Cuadra' : diferencia > 0 ? `Sobran ${cantidadTexto(diferencia)}` : `Faltan ${cantidadTexto(-diferencia)}`;
    return `<li class="m-renglon ${r.producto_id === nuevo ? 'nuevo' : ''}" data-id="${r.producto_id}">
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
        <div class="m-renglon-dato">Sistema: ${cantidadTexto(r.existencia_al_contar)} · ${escaparHtml(r.codigo_barras || 'Sin código')}</div></div>
      <button class="m-quitar" data-accion="quitar" aria-label="Quitar"><svg class="icono"><use href="#i-x"/></svg></button>
      <div class="m-paso">
        <button data-accion="menos" aria-label="Una menos"><svg class="icono"><use href="#i-menos"/></svg></button>
        <input type="number" inputmode="decimal" min="0" step="any" value="${cantidadTexto(r.contado)}" data-accion="cantidad" aria-label="Contadas">
        <button data-accion="mas" aria-label="Una más"><svg class="icono"><use href="#i-mas"/></svg></button>
        <span class="m-diferencia ${clase}">${texto}</span>
      </div>
    </li>`;
  }).join('') || '<li class="m-vacio">Todavía no has contado nada. Toca <b>Escanear</b> y pasa el celular por cada pieza del estante.</li>';
  const conDiferencia = lista.filter((r) => Math.abs(r.contado - r.existencia_al_contar) > 0.0001).length;
  $('con-productos').textContent = lista.length;
  $('con-diferencias').textContent = conDiferencia;
  $('con-aplicar').disabled = conDiferencia === 0;
  $('nav-contar').hidden = lista.length === 0;
  $('nav-contar').textContent = lista.length;
  pintarNoEncontrados($('con-no-encontrados'), M.conteo);
  M.conteo.nota = $('con-nota').value;
  guardarBorrador('conteo', M.conteo);
}

$('con-lista').addEventListener('click', (e) => {
  if (e.target.closest('button[data-accion]')) cambiarRenglon(M.conteo, 'contado', e, pintarConteo);
});
$('con-lista').addEventListener('change', (e) => {
  if (e.target.matches('input[data-accion="cantidad"]')) cambiarRenglon(M.conteo, 'contado', e, pintarConteo);
});
$('con-nota').addEventListener('input', () => {
  M.conteo.nota = $('con-nota').value;
  guardarBorrador('conteo', M.conteo);
});

$('con-aplicar').addEventListener('click', async () => {
  const lista = M.conteo.renglones;
  const diferencias = lista.filter((r) => Math.abs(r.contado - r.existencia_al_contar) > 0.0001);
  if (!diferencias.length) return;
  const sobran = redondear(diferencias.reduce((t, r) => t + Math.max(0, r.contado - r.existencia_al_contar), 0));
  const faltan = redondear(diferencias.reduce((t, r) => t + Math.max(0, r.existencia_al_contar - r.contado), 0));
  const confirmado = await confirmarHoja({
    titulo: 'Aplicar ajustes del conteo',
    mensaje: `Se ajustarán <b>${diferencias.length} producto(s)</b> en <b>${escaparHtml(nombreSucursal())}</b>:
      ${sobran ? `se suman ${cantidadTexto(sobran)} pieza(s) que sobraban` : ''}${sobran && faltan ? ' y ' : ''}${faltan ? `se restan ${cantidadTexto(faltan)} que faltaban` : ''}.
      Los ${lista.length - diferencias.length} que cuadran no se tocan. Las ventas hechas mientras contabas se respetan.`,
    boton: 'Aplicar ajustes',
  });
  if (!confirmado) return;
  const boton = $('con-aplicar');
  boton.disabled = true;
  boton.textContent = 'Aplicando…';
  try {
    const r = await api('/api/productos/inventario/lote', {
      method: 'POST',
      body: {
        tipo: 'conteo',
        sucursal_id: M.sucursalId,
        nota: $('con-nota').value,
        renglones: lista.map((x) => ({ producto_id: x.producto_id, contado: x.contado, existencia_al_contar: x.existencia_al_contar })),
      },
    });
    M.conteo = { renglones: [], noEncontrados: [], nota: '' };
    $('con-nota').value = '';
    M.porCodigo.clear();
    aviso(`Conteo aplicado: ${r.aplicados} producto(s) ajustados, ${r.sin_diferencia} cuadraban`, 'exito');
  } catch (error) {
    aviso(error.message, 'error');
  } finally {
    boton.textContent = 'Aplicar ajustes';
    pintarConteo();
  }
});

$('con-vaciar').addEventListener('click', async () => {
  if (!M.conteo.renglones.length && !M.conteo.noEncontrados.length) return;
  const confirmado = await confirmarHoja({ titulo: 'Vaciar conteo', mensaje: 'Se borra lo contado sin tocar el inventario.', boton: 'Vaciar', peligro: true });
  if (!confirmado) return;
  M.conteo = { renglones: [], noEncontrados: [], nota: '' };
  $('con-nota').value = '';
  pintarConteo();
});

for (const id of ['rec-no-encontrados', 'con-no-encontrados']) {
  $(id).addEventListener('click', (e) => {
    const alta = e.target.closest('[data-alta]');
    if (alta) return altaProducto(alta.dataset.alta);
    if (e.target.closest('[data-limpiar-no-encontrados]')) {
      const lista = id === 'con-no-encontrados' ? M.conteo : M.recepcion;
      lista.noEncontrados = [];
      if (lista === M.conteo) pintarConteo();
      else pintarRecepcion();
    }
  });
}

// ---------- Cotizar (solo el administrador de la central) ----------
const cotizacionVacia = () => ({ renglones: [], cliente: '', nota: '', sucursal: M.cotizacion?.sucursal || '', usuario: '' });
const claveCotizacion = () => `farmacia.movil.${M.usuario.id}.cotizacion`;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function leerCotizacion() {
  try {
    const texto = localStorage.getItem(claveCotizacion());
    return texto ? { ...cotizacionVacia(), ...JSON.parse(texto) } : cotizacionVacia();
  } catch {
    return cotizacionVacia();
  }
}

function guardarCotizacion() {
  try { localStorage.setItem(claveCotizacion(), JSON.stringify(M.cotizacion)); } catch { /* sin almacenamiento */ }
}

function totalCotizacion() {
  return r2(M.cotizacion.renglones.reduce((t, r) => t + r2(r.precio * r.cantidad), 0));
}

function agregarCotizacion(producto, cantidad) {
  let renglon = M.cotizacion.renglones.find((r) => r.producto_id === producto.id);
  if (renglon) {
    renglon.cantidad = redondear(renglon.cantidad + cantidad);
    M.cotizacion.renglones = [renglon, ...M.cotizacion.renglones.filter((r) => r !== renglon)];
  } else {
    const precio = r2(producto.precio_venta);
    renglon = { producto_id: producto.id, descripcion: producto.descripcion, codigo_barras: producto.codigo_barras, cantidad: redondear(cantidad), precio, precio_lista: precio };
    M.cotizacion.renglones.unshift(renglon);
  }
  pintarCotizacion(producto.id);
  if (Escaner.abierto()) {
    Escaner.informar(`${escaparHtml(producto.descripcion)}<br><b>${cantidadTexto(renglon.cantidad)}</b> × ${dinero(renglon.precio)}`, {
      boton: { texto: '+1', alPulsar: () => { Escaner.sonar('ok'); agregarCotizacion(producto, 1); } },
    });
  }
  return renglon;
}

async function agregarACotizacionDesdeConsulta() {
  const p = M.producto;
  const r = await pedirCantidad({ titulo: p.descripcion, mensaje: `Precio de lista ${dinero(p.precio_venta)}. ¿Cuántas piezas se cotizan?`, boton: 'Agregar' });
  if (!r) return;
  agregarCotizacion(p, r.cantidad);
  aviso(`Agregado a la cotización (${M.cotizacion.renglones.length} producto(s), ${dinero(totalCotizacion())})`, 'exito');
}

function pintarCotizacion(nuevo = null) {
  const lista = M.cotizacion.renglones;
  $('cot-lista').innerHTML = lista.map((r) => `
    <li class="m-renglon ${r.producto_id === nuevo ? 'nuevo' : ''}" data-id="${r.producto_id}">
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
        <div class="m-renglon-dato">${escaparHtml(r.codigo_barras || 'Sin código')} · precio de lista ${dinero(r.precio_lista)}</div></div>
      <button class="m-quitar" data-accion="quitar" aria-label="Quitar"><svg class="icono"><use href="#i-x"/></svg></button>
      <div class="m-paso">
        <button data-accion="menos" aria-label="Una menos"><svg class="icono"><use href="#i-menos"/></svg></button>
        <input type="number" inputmode="decimal" min="0" step="any" value="${cantidadTexto(r.cantidad)}" data-accion="cantidad" aria-label="Cantidad">
        <button data-accion="mas" aria-label="Una más"><svg class="icono"><use href="#i-mas"/></svg></button>
      </div>
      <label class="m-precio-renglon">Precio c/u
        <input type="number" inputmode="decimal" min="0" step="0.01" value="${r2(r.precio).toFixed(2)}" data-accion="precio"
               class="${Math.abs(r.precio - r.precio_lista) > 0.004 ? 'cambiado' : ''}" aria-label="Precio unitario">
        <span class="m-importe">${dinero(r2(r.precio * r.cantidad))}</span>
      </label>
    </li>`).join('') || '<li class="m-vacio">Todavía no hay productos. Toca <b>Escanear</b> o escribe el nombre del producto.</li>';
  $('cot-productos').textContent = lista.length;
  $('cot-total').textContent = dinero(totalCotizacion());
  $('cot-enviar').disabled = lista.length === 0;
  $('nav-cotizar').hidden = lista.length === 0;
  $('nav-cotizar').textContent = lista.length;
  guardarCotizacion();
}

$('cot-lista').addEventListener('click', (e) => {
  if (e.target.closest('button[data-accion]')) cambiarRenglon(M.cotizacion, 'cantidad', e, pintarCotizacion);
});
$('cot-lista').addEventListener('change', (e) => {
  if (e.target.matches('input[data-accion="cantidad"]')) cambiarRenglon(M.cotizacion, 'cantidad', e, pintarCotizacion);
  if (e.target.matches('input[data-accion="precio"]')) {
    const renglon = M.cotizacion.renglones.find((r) => r.producto_id === Number(e.target.closest('li[data-id]').dataset.id));
    const valor = Number(String(e.target.value).replace(',', '.'));
    if (renglon && Number.isFinite(valor) && valor >= 0) renglon.precio = r2(valor);
    else aviso('Escribe un precio válido', 'error');
    pintarCotizacion();
  }
});
for (const campo of ['cliente', 'nota']) {
  $(`cot-${campo}`).addEventListener('input', (e) => {
    M.cotizacion[campo] = e.target.value;
    guardarCotizacion();
  });
}

async function cargarDestinos() {
  try {
    M.destinos = await api('/api/cotizaciones/destinos');
    pintarDestinos();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

function pintarDestinos() {
  const d = M.destinos;
  if (!d) return;
  const guardada = Number(M.cotizacion.sucursal);
  const elegida = d.sucursales.some((x) => x.id === guardada) ? guardada : (d.sucursales.find((x) => !x.es_central) || d.sucursales[0] || {}).id;
  $('cot-sucursal').innerHTML = d.sucursales.map((x) => `<option value="${x.id}" ${x.id === elegida ? 'selected' : ''}>${escaparHtml(x.nombre)}</option>`).join('');
  M.cotizacion.sucursal = Number($('cot-sucursal').value) || '';
  pintarUsuariosDestino();
}

function pintarUsuariosDestino() {
  const sucursal = Number($('cot-sucursal').value);
  const usuarios = (M.destinos?.usuarios || []).filter((u) => u.sucursal_id === sucursal);
  const elegido = Number(M.cotizacion.usuario);
  $('cot-usuario').innerHTML = '<option value="">Cualquiera de la sucursal</option>'
    + usuarios.map((u) => `<option value="${u.id}" ${u.id === elegido ? 'selected' : ''}>${escaparHtml(u.nombre)}${u.rol === 'admin' ? ' (administrador)' : ''}</option>`).join('');
  M.cotizacion.usuario = $('cot-usuario').value;
  guardarCotizacion();
}

$('cot-sucursal').addEventListener('change', () => {
  M.cotizacion.sucursal = Number($('cot-sucursal').value);
  M.cotizacion.usuario = '';
  pintarUsuariosDestino();
});
$('cot-usuario').addEventListener('change', () => {
  M.cotizacion.usuario = $('cot-usuario').value;
  guardarCotizacion();
});

$('cot-enviar').addEventListener('click', async () => {
  const lista = M.cotizacion.renglones;
  if (!lista.length) return;
  const sucursal = Number($('cot-sucursal').value);
  if (!sucursal) {
    aviso('Elige la sucursal a la que va la cotización', 'error');
    return;
  }
  const usuario = $('cot-usuario').value;
  const destino = $('cot-sucursal').selectedOptions[0]?.textContent || '';
  const para = usuario ? $('cot-usuario').selectedOptions[0].textContent : 'cualquier usuario de la sucursal';
  const confirmado = await confirmarHoja({
    titulo: 'Enviar cotización',
    mensaje: `Se manda a <b>${escaparHtml(destino)}</b> (para ${escaparHtml(para)}) una cotización de <b>${lista.length} producto(s)</b>
      por <b>${dinero(totalCotizacion())}</b>. Le aparecerá en la caja para cobrarla; el precio se respeta 7 días.`,
    boton: 'Enviar',
  });
  if (!confirmado) return;
  const boton = $('cot-enviar');
  boton.disabled = true;
  try {
    const c = await api('/api/cotizaciones', {
      method: 'POST',
      body: {
        destino_sucursal_id: sucursal,
        destino_usuario_id: usuario ? Number(usuario) : null,
        cliente: $('cot-cliente').value,
        nota: $('cot-nota').value,
        renglones: lista.map((r) => ({ producto_id: r.producto_id, cantidad: r.cantidad, precio_unitario: r.precio })),
      },
    });
    M.cotizacion = { ...cotizacionVacia(), sucursal, usuario };
    $('cot-cliente').value = '';
    $('cot-nota').value = '';
    pintarCotizacion();
    aviso(`Cotización folio ${c.folio} enviada a ${c.destino}`, 'exito');
    cargarEnviadas();
  } catch (error) {
    aviso(error.message, 'error');
  } finally {
    boton.disabled = M.cotizacion.renglones.length === 0;
  }
});

$('cot-vaciar').addEventListener('click', async () => {
  if (!M.cotizacion.renglones.length) return;
  const confirmado = await confirmarHoja({ titulo: 'Vaciar cotización', mensaje: 'Se borran los productos de la cotización que estás armando.', boton: 'Vaciar', peligro: true });
  if (!confirmado) return;
  M.cotizacion = { ...cotizacionVacia(), sucursal: M.cotizacion.sucursal, usuario: M.cotizacion.usuario };
  $('cot-cliente').value = '';
  $('cot-nota').value = '';
  pintarCotizacion();
});

function estadoCotizacion(c) {
  if (c.estado === 'vendida') return { clase: 'vendida', texto: c.vendida_folio ? `Cobrada · venta ${c.vendida_folio}` : 'Cobrada' };
  if (c.estado === 'cancelada') return { clase: 'cancelada', texto: 'Cancelada' };
  if (!c.vigente) return { clase: 'vencida', texto: 'Vencida' };
  return { clase: 'enviada', texto: 'Por cobrar' };
}

async function cargarEnviadas() {
  try {
    M.enviadas = await api('/api/cotizaciones?bandeja=enviadas');
    pintarEnviadas();
  } catch (error) {
    $('cot-enviadas').innerHTML = `<li class="m-vacio">${escaparHtml(error.message)}</li>`;
  }
}

function pintarEnviadas() {
  $('cot-enviadas').innerHTML = M.enviadas.slice(0, 30).map((c) => {
    const estado = estadoCotizacion(c);
    return `<li><button class="m-cotizacion" data-cot="${c.id}">
      <div class="m-cotizacion-fila"><b>Folio ${c.folio}${c.cliente ? ` · ${escaparHtml(c.cliente)}` : ''}</b><span class="m-chip ${estado.clase}">${estado.texto}</span></div>
      <div class="m-cotizacion-fila"><small>${escaparHtml(c.destino)}${c.destino_usuario ? ` · ${escaparHtml(c.destino_usuario)}` : ''} · ${c.productos} producto(s)</small><b>${dinero(c.total)}</b></div>
      <small>${escaparHtml(fechaCorta(c.creado))}${c.vigente ? ` · precio hasta el ${escaparHtml(fechaDia(c.vigente_hasta))}` : ''}</small>
    </button></li>`;
  }).join('') || '<li class="m-vacio">Todavía no has enviado cotizaciones.</li>';
}

$('cot-enviadas').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-cot]');
  if (boton) verCotizacion(Number(boton.dataset.cot));
});

async function verCotizacion(id) {
  let c;
  try {
    c = await api(`/api/cotizaciones/${id}`);
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  const estado = estadoCotizacion(c);
  const hoja = abrirHoja(`
    <h3>Cotización folio ${c.folio} <span class="m-chip ${estado.clase}">${estado.texto}</span></h3>
    <p>${c.cliente ? `Cliente: <b>${escaparHtml(c.cliente)}</b><br>` : ''}Para ${escaparHtml(c.destino)}${c.destino_usuario ? ` · ${escaparHtml(c.destino_usuario)}` : ''}<br>
      Enviada el ${escaparHtml(fechaCorta(c.creado))}${c.estado === 'enviada' ? ` · precio respetado hasta el ${escaparHtml(fechaDia(c.vigente_hasta))}` : ''}
      ${c.estado === 'vendida' ? `<br>Cobrada el ${escaparHtml(fechaCorta(c.vendida_fecha))}${c.vendedor ? ` por ${escaparHtml(c.vendedor)}` : ''}${c.vendida_folio ? ` (venta folio ${c.vendida_folio})` : ''}` : ''}
      ${c.nota ? `<br>Nota: ${escaparHtml(c.nota)}` : ''}</p>
    <ul class="m-tabla-hoja">
      ${c.renglones.map((r) => `<li><span>${cantidadTexto(r.cantidad)} × ${escaparHtml(r.descripcion)}</span><b>${dinero(r.importe)}</b>
        <small>${dinero(r.precio_unitario)} c/u${Math.abs(r.precio_unitario - r.precio_lista) > 0.004 ? ` (lista ${dinero(r.precio_lista)})` : ''}</small></li>`).join('')}
      <li class="total"><span>Total</span><span>${dinero(c.total)}</span></li>
    </ul>
    <div class="m-botones">
      <button class="m-boton secundario" data-r="copiar">Copiar a una nueva</button>
      ${c.estado === 'enviada' ? '<button class="m-boton peligro" data-r="cancelar">Cancelar</button>' : ''}
    </div>
    <button class="m-boton secundario" data-r="no">Cerrar</button>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelector('[data-r="copiar"]').addEventListener('click', async () => {
    cerrarHoja();
    if (M.cotizacion.renglones.length) {
      const reemplazar = await confirmarHoja({ titulo: 'Copiar cotización', mensaje: 'Se reemplazan los productos de la cotización que estás armando.', boton: 'Reemplazar' });
      if (!reemplazar) return;
    }
    M.cotizacion.renglones = c.renglones.map((r) => ({
      producto_id: r.producto_id, descripcion: r.descripcion, codigo_barras: r.codigo_barras,
      cantidad: r.cantidad, precio: r.precio_unitario, precio_lista: r.precio_lista,
    }));
    M.cotizacion.cliente = c.cliente;
    $('cot-cliente').value = c.cliente;
    pintarCotizacion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    aviso('Revisa los precios de hoy antes de enviarla');
  });
  hoja.querySelector('[data-r="cancelar"]')?.addEventListener('click', async () => {
    cerrarHoja();
    const confirmado = await confirmarHoja({
      titulo: `Cancelar la cotización folio ${c.folio}`,
      mensaje: 'La sucursal ya no la podrá cobrar.',
      boton: 'Cancelar cotización',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api(`/api/cotizaciones/${c.id}/cancelar`, { method: 'POST' });
      aviso(`Cotización folio ${c.folio} cancelada`, 'exito');
      cargarEnviadas();
    } catch (error) {
      aviso(error.message, 'error');
    }
  });
}

// ---------- Apoyos: revisar con palomitas lo que mandó la central ----------
const claveRevision = (id) => `farmacia.movil.${M.usuario.id}.apoyo.${id}`;

function leerRevision(id) {
  try { return JSON.parse(localStorage.getItem(claveRevision(id)) || 'null'); } catch { return null; }
}

function guardarRevision() {
  const rev = M.revision;
  if (!rev) return;
  try {
    localStorage.setItem(claveRevision(rev.apoyo.id), JSON.stringify({ contado: rev.contado, extras: rev.extras, noEncontrados: rev.noEncontrados }));
  } catch { /* sin almacenamiento */ }
}

function borrarRevision(id) {
  try { localStorage.removeItem(claveRevision(id)); } catch { /* sin almacenamiento */ }
}

async function cargarApoyos({ silencioso = false } = {}) {
  try {
    const lista = await api('/api/apoyos?estado=enviado');
    M.apoyos = lista.filter((a) => a.estado === 'enviado' && Number(a.destino_id) === Number(M.usuario.sucursal_id));
    pintarApoyos();
  } catch (error) {
    if (!silencioso) aviso(error.message, 'error');
    if (!M.apoyos) $('apo-lista').innerHTML = `<li class="m-vacio">${escaparHtml(error.message)}</li>`;
  }
}

function pintarApoyos() {
  const lista = M.apoyos || [];
  $('apo-lista').innerHTML = lista.map((a) => {
    const guardado = leerRevision(a.id);
    const enCurso = guardado && Object.values(guardado.contado || {}).some((n) => n > 0);
    return `<li><button class="m-apoyo" data-apoyo="${a.id}">
      <span><b>Apoyo folio ${a.folio}</b>
        <small>De ${escaparHtml(a.origen)}${a.enviado ? ` · ${escaparHtml(fechaCorta(a.enviado))}` : ''}</small>
        <small>${a.renglones} producto(s) · ${cantidadTexto(a.piezas)} pieza(s)${enCurso ? ' · <span class="m-en-curso">revisión a medias</span>' : ''}</small></span>
      <span class="m-accion principal">Revisar</span>
    </button></li>`;
  }).join('') || '<li class="m-vacio">No hay apoyos por recibir. Cuando la central mande uno, aparecerá aquí.</li>';
  $('nav-apoyos').hidden = lista.length === 0;
  $('nav-apoyos').textContent = lista.length;
}

$('apo-lista').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-apoyo]');
  if (boton) abrirApoyo(Number(boton.dataset.apoyo));
});
$('apo-actualizar').addEventListener('click', () => cargarApoyos());

async function abrirApoyo(id) {
  let apoyo;
  try {
    apoyo = await api(`/api/apoyos/${id}`);
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  if (apoyo.estado !== 'enviado') {
    aviso('Este apoyo ya no está pendiente de recibir', 'error');
    borrarRevision(id);
    cargarApoyos({ silencioso: true });
    return;
  }
  const guardado = leerRevision(id) || {};
  const ids = new Set(apoyo.renglones.map((r) => String(r.id)));
  const contado = Object.fromEntries(Object.entries(guardado.contado || {}).filter(([clave]) => ids.has(clave)));
  M.revision = { apoyo, contado, extras: guardado.extras || [], noEncontrados: guardado.noEncontrados || [] };
  mostrarRevision(true);
  pintarRevision();
  window.scrollTo({ top: 0 });
}

function mostrarRevision(abierta) {
  if (!abierta) M.revision = null;
  $('apo-inicio').hidden = abierta;
  $('apo-revision').hidden = !abierta;
  ajustarCaptura();
  if (!abierta) pintarApoyos();
}

$('apo-volver').addEventListener('click', () => mostrarRevision(false));

function renglonApoyoPorCodigo(codigo) {
  return M.revision ? M.revision.apoyo.renglones.find((r) => r.codigo_barras && r.codigo_barras === codigo) || null : null;
}

function contarRenglonApoyo(renglon, cantidad) {
  const rev = M.revision;
  const contado = redondear((rev.contado[renglon.id] || 0) + cantidad);
  rev.contado[renglon.id] = contado;
  pintarRevision(renglon.id);
  if (Escaner.abierto()) {
    const sobra = contado > renglon.cantidad + 1e-9;
    const completo = Math.abs(contado - renglon.cantidad) < 1e-9;
    Escaner.informar(`${escaparHtml(renglon.descripcion)}<br><b>${cantidadTexto(contado)} de ${cantidadTexto(renglon.cantidad)}</b>${completo ? ' ✓ completo' : ''}${sobra ? ' — llegaron de más' : ''}`, {
      error: sobra,
      boton: { texto: '+1', alPulsar: () => { Escaner.sonar('ok'); contarRenglonApoyo(renglon, 1); } },
    });
  }
  return renglon;
}

// Un producto escaneado: si viene en el apoyo se palomea; si no, queda como "no venía"
function contarApoyo(producto, cantidad = 1) {
  const rev = M.revision;
  if (!rev) return null;
  const renglon = rev.apoyo.renglones.find((r) => r.producto_id === producto.id);
  if (renglon) return contarRenglonApoyo(renglon, cantidad);
  let extra = rev.extras.find((x) => x.producto_id === producto.id);
  if (!extra) {
    extra = { producto_id: producto.id, descripcion: producto.descripcion, codigo_barras: producto.codigo_barras, cantidad: 0 };
    rev.extras.unshift(extra);
  }
  extra.cantidad = redondear(extra.cantidad + cantidad);
  pintarRevision();
  const texto = `"${producto.descripcion}" no venía en este apoyo (${cantidadTexto(extra.cantidad)})`;
  if (Escaner.abierto()) Escaner.informar(escaparHtml(texto), { error: true });
  else aviso(texto, 'error');
  return null;
}

function estadoRenglon(renglon, contado) {
  if (Math.abs(contado - renglon.cantidad) < 1e-9) return { clase: 'completo', texto: 'Completo' };
  if (contado > renglon.cantidad) return { clase: 'sobra', texto: `Sobran ${cantidadTexto(contado - renglon.cantidad)}` };
  return { clase: contado > 0 ? 'parcial' : '', texto: `Faltan ${cantidadTexto(renglon.cantidad - contado)}` };
}

function pintarRevision(nuevo = null) {
  const rev = M.revision;
  if (!rev) return;
  const { apoyo } = rev;
  $('apo-titulo').textContent = `Apoyo folio ${apoyo.folio}`;
  $('apo-subtitulo').textContent = `De ${apoyo.origen}${apoyo.enviado ? ` · ${fechaCorta(apoyo.enviado)}` : ''}`;
  let completos = 0;
  let llegaron = 0;
  $('apo-renglones').innerHTML = apoyo.renglones.map((r) => {
    const contado = rev.contado[r.id] || 0;
    const estado = estadoRenglon(r, contado);
    if (estado.clase === 'completo') completos += 1;
    llegaron += Math.min(contado, r.cantidad);
    return `<li class="m-renglon revision ${estado.clase} ${r.id === nuevo ? 'nuevo' : ''}" data-renglon="${r.id}">
      <span class="m-palomita"><svg class="icono"><use href="#i-check"/></svg></span>
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
        <div class="m-renglon-dato">Llegaron <b>${cantidadTexto(contado)}</b> de ${cantidadTexto(r.cantidad)} · ${escaparHtml(r.codigo_barras || 'Sin código')}</div></div>
      <div class="m-paso">
        <button data-accion="menos" aria-label="Una menos"><svg class="icono"><use href="#i-menos"/></svg></button>
        <input type="number" inputmode="decimal" min="0" step="any" value="${cantidadTexto(contado)}" data-accion="cantidad" aria-label="Piezas que llegaron">
        <button data-accion="mas" aria-label="Una más"><svg class="icono"><use href="#i-mas"/></svg></button>
        <span class="m-estado-renglon">${estado.texto}</span>
      </div>
    </li>`;
  }).join('');
  const total = redondear(apoyo.renglones.reduce((t, r) => t + r.cantidad, 0));
  $('apo-completos').textContent = completos;
  $('apo-renglones-total').textContent = apoyo.renglones.length;
  $('apo-piezas').textContent = cantidadTexto(llegaron);
  $('apo-piezas-total').textContent = cantidadTexto(total);
  $('apo-barra').style.width = `${total > 0 ? Math.min(100, (llegaron / total) * 100) : 0}%`;
  const extras = rev.extras.filter((x) => x.cantidad > 0);
  $('apo-extras').innerHTML = extras.length || rev.noEncontrados.length ? `<div class="m-no-encontrados">
    ${extras.length ? `<b>No venían en el apoyo:</b> ${extras.map((x) => `${escaparHtml(x.descripcion)} (${cantidadTexto(x.cantidad)})
      <button class="m-accion" data-quitar-extra="${x.producto_id}">Quitar</button>`).join(' ')}<br>` : ''}
    ${rev.noEncontrados.length ? `<b>No están en el catálogo:</b> ${rev.noEncontrados.map((c) => `<code>${escaparHtml(c)}</code>`).join(' ')}
      <button class="m-accion" data-quitar-codigos>Quitar</button>` : ''}
  </div>` : '';
  guardarRevision();
}

$('apo-renglones').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton || !M.revision) return;
  const id = Number(boton.closest('li[data-renglon]').dataset.renglon);
  const actual = M.revision.contado[id] || 0;
  M.revision.contado[id] = boton.dataset.accion === 'mas' ? redondear(actual + 1) : Math.max(0, redondear(actual - 1));
  pintarRevision();
});
$('apo-renglones').addEventListener('change', (e) => {
  if (!e.target.matches('input[data-accion="cantidad"]') || !M.revision) return;
  const id = Number(e.target.closest('li[data-renglon]').dataset.renglon);
  const valor = Number(String(e.target.value).replace(',', '.'));
  if (Number.isFinite(valor) && valor >= 0) M.revision.contado[id] = redondear(valor);
  pintarRevision();
});
$('apo-extras').addEventListener('click', (e) => {
  if (!M.revision) return;
  const extra = e.target.closest('[data-quitar-extra]');
  if (extra) M.revision.extras = M.revision.extras.filter((x) => x.producto_id !== Number(extra.dataset.quitarExtra));
  if (e.target.closest('[data-quitar-codigos]')) M.revision.noEncontrados = [];
  pintarRevision();
});

$('apo-reiniciar').addEventListener('click', async () => {
  if (!M.revision) return;
  const confirmado = await confirmarHoja({ titulo: 'Empezar de nuevo', mensaje: 'Se borra lo que llevas escaneado de este apoyo.', boton: 'Empezar de nuevo', peligro: true });
  if (!confirmado) return;
  M.revision.contado = {};
  M.revision.extras = [];
  M.revision.noEncontrados = [];
  pintarRevision();
});

// Al terminar: o llegó completo, o se muestran las diferencias antes de recibir
function diferenciasRevision() {
  const rev = M.revision;
  const faltan = [];
  const sobran = [];
  for (const r of rev.apoyo.renglones) {
    const contado = rev.contado[r.id] || 0;
    if (contado < r.cantidad - 1e-9) faltan.push({ descripcion: r.descripcion, cantidad: redondear(r.cantidad - contado) });
    else if (contado > r.cantidad + 1e-9) sobran.push({ descripcion: r.descripcion, cantidad: redondear(contado - r.cantidad) });
  }
  const extras = rev.extras.filter((x) => x.cantidad > 0);
  const piezas = redondear(rev.apoyo.renglones.reduce((t, r) => t + Math.min(rev.contado[r.id] || 0, r.cantidad), 0));
  return { faltan, sobran, extras, codigos: rev.noEncontrados, piezas, hay: Boolean(faltan.length || sobran.length || extras.length || rev.noEncontrados.length) };
}

const listaTexto = (lista) => lista.map((x) => `${cantidadTexto(x.cantidad)} ${x.descripcion}`).join(', ');

$('apo-terminar').addEventListener('click', () => {
  const rev = M.revision;
  if (!rev) return;
  const d = diferenciasRevision();
  if (!d.hay) {
    const hoja = abrirHoja(`
      <div class="m-completo">
        <span class="m-palomita"><svg class="icono"><use href="#i-check"/></svg></span>
        <h3>Apoyo completo</h3>
        <p>Llegó todo lo que mandó ${escaparHtml(rev.apoyo.origen)}: <b>${cantidadTexto(d.piezas)} pieza(s)</b> de <b>${rev.apoyo.renglones.length} producto(s)</b>.
          Al recibirlo se suman al inventario de <b>${escaparHtml(nombreSucursal())}</b> y el apoyo queda cerrado.</p>
      </div>
      <div class="m-botones">
        <button class="m-boton secundario" data-r="no">Seguir revisando</button>
        <button class="m-boton principal" data-r="si">Recibir apoyo</button>
      </div>`);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.querySelector('[data-r="si"]').addEventListener('click', (e) => recibirApoyo(e.currentTarget, ''));
    return;
  }
  const bloque = (titulo, lista) => (lista.length ? `<div><h4>${titulo}</h4><ul class="m-tabla-hoja">${lista.map((x) => `<li><span>${escaparHtml(x.descripcion)}</span><b>${cantidadTexto(x.cantidad)}</b></li>`).join('')}</ul></div>` : '');
  const hoja = abrirHoja(`
    <h3>El apoyo tiene diferencias</h3>
    <div class="m-diferencias">
      ${bloque('Faltan (llegaron menos)', d.faltan)}
      ${bloque('Sobran (llegaron de más)', d.sobran)}
      ${bloque('No venían en el apoyo', d.extras)}
      ${d.codigos.length ? `<div><h4>Códigos que no están en el catálogo</h4><p>${d.codigos.map((c) => `<code>${escaparHtml(c)}</code>`).join(' ')}</p></div>` : ''}
    </div>
    <p>Si lo recibes así, entra al inventario solo lo que sí llegó y venía en el apoyo (<b>${cantidadTexto(d.piezas)} pieza(s)</b>).
      Lo que sobra o no venía no se suma. Las diferencias quedan anotadas en el apoyo para que la central las revise.</p>
    <input id="apo-nota" type="text" maxlength="200" placeholder="Comentario (opcional)" aria-label="Comentario">
    <div class="m-botones">
      <button class="m-boton secundario" data-r="no">Seguir revisando</button>
      <button class="m-boton peligro" data-r="si">Recibir con diferencias</button>
    </div>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelector('[data-r="si"]').addEventListener('click', (e) => {
    const partes = [
      d.faltan.length ? `faltaron ${listaTexto(d.faltan)}` : '',
      d.sobran.length ? `sobraron ${listaTexto(d.sobran)}` : '',
      d.extras.length ? `no venían en el apoyo ${listaTexto(d.extras)}` : '',
      d.codigos.length ? `códigos fuera del catálogo ${d.codigos.join(', ')}` : '',
      hoja.querySelector('#apo-nota').value.trim(),
    ].filter(Boolean);
    recibirApoyo(e.currentTarget, `Revisado con el celular: ${partes.join('; ')}`);
  });
});

async function recibirApoyo(boton, diferencias) {
  const rev = M.revision;
  if (!rev) return;
  boton.disabled = true;
  boton.textContent = 'Recibiendo…';
  try {
    await api(`/api/apoyos/${rev.apoyo.id}/recibir`, {
      method: 'POST',
      body: {
        renglones: rev.apoyo.renglones.map((r) => ({ id: r.id, cantidad_recibida: Math.min(rev.contado[r.id] || 0, r.cantidad) })),
        nota_recepcion: diferencias,
      },
    });
    cerrarHoja();
    borrarRevision(rev.apoyo.id);
    M.porCodigo.clear();
    aviso(diferencias ? `Apoyo folio ${rev.apoyo.folio} recibido con diferencias (quedaron anotadas)` : `Apoyo folio ${rev.apoyo.folio} recibido completo`, 'exito');
    mostrarRevision(false);
    cargarApoyos({ silencioso: true });
  } catch (error) {
    cerrarHoja();
    aviso(error.message, 'error');
    if (/ya fue recibido|no está pendiente|cancelado/i.test(error.message)) {
      borrarRevision(rev.apoyo.id);
      mostrarRevision(false);
      cargarApoyos({ silencioso: true });
    }
  }
}

// ---------- Cámara ----------
const TITULOS_CAMARA = {
  consultar: 'Apunta al código del producto',
  movimientos: 'Escanea el producto para ver sus movimientos',
  recibir: 'Escanea lo que llegó',
  contar: 'Escanea cada pieza del estante',
  cotizar: 'Escanea los productos de la cotización',
  apoyos: 'Escanea cada pieza del apoyo',
};

async function manejarEscaneo(codigo) {
  if (M.vista === 'apoyos') {
    if (!M.revision) return false;
    const renglon = renglonApoyoPorCodigo(codigo);
    if (renglon) {
      contarRenglonApoyo(renglon, 1);
      return true;
    }
  }
  if (M.vista === 'contar' && diaAbierto()) return escaneoEnDia(codigo);
  if (M.vista === 'movimientos') {
    filtrarMovimientosPorProducto(codigo);
    return false;
  }
  let producto;
  try {
    producto = await productoPorCodigo(codigo, { fresco: M.vista === 'consultar' });
  } catch (error) {
    Escaner.informar(escaparHtml(error.message), { error: true });
    return true;
  }
  if (!producto) {
    if (M.vista === 'consultar') {
      setTimeout(() => noEncontrado(codigo), 50);
      return false;
    }
    registrarNoEncontrado(codigo);
    Escaner.informar(`El código <b>${escaparHtml(codigo)}</b> no está en el catálogo`, { error: true });
    return true;
  }
  if (M.vista === 'consultar') {
    mostrarProducto(producto);
    return false;
  }
  if (M.vista === 'recibir' && $('rec-preguntar').checked) {
    Escaner.pausar(true);
    const r = await pedirCantidad({ titulo: producto.descripcion, mensaje: '¿Cuántas piezas llegaron?', boton: 'Agregar' });
    if (r) agregarRecepcion(producto, r.cantidad);
    Escaner.pausar(false);
    return true;
  }
  if (M.vista === 'recibir') agregarRecepcion(producto, 1);
  else if (M.vista === 'cotizar') agregarCotizacion(producto, 1);
  else if (M.vista === 'apoyos') contarApoyo(producto, 1);
  else await agregarConteo(producto, 1);
  return true;
}

// Abre la cámara; el botón "atrás" del celular la cierra
async function abrirCamara(opciones, { alFallar } = {}) {
  Escaner.prepararSonido();
  const quitarCapa = () => {
    if (history.state && history.state.capa === 'camara') {
      ignorarPop = true;
      history.back();
    }
  };
  try {
    history.pushState({ capa: 'camara' }, '');
    await Escaner.abrir({ ...opciones, alCerrar: quitarCapa });
  } catch (error) {
    quitarCapa();
    if (alFallar) alFallar(error);
  }
}

function escanear() {
  if (M.vista === 'apoyos' && !M.revision) {
    aviso('Primero abre el apoyo que llegó', 'error');
    return null;
  }
  const enDia = M.vista === 'contar' && diaAbierto();
  return abrirCamara({
    titulo: enDia ? 'Escanea el producto que vas a contar' : TITULOS_CAMARA[M.vista],
    continuo: M.vista !== 'consultar' && M.vista !== 'movimientos',
    alLeer: manejarEscaneo,
    alTeclear: () => $('entrada-codigo').focus(),
  }, {
    alFallar: (error) => {
      aviso(error.message, 'error');
      $('entrada-codigo').focus();
    },
  });
}

$('boton-escanear').addEventListener('click', escanear);
$('form-codigo').addEventListener('submit', (e) => {
  e.preventDefault();
  const entrada = $('entrada-codigo');
  const texto = entrada.value;
  entrada.value = '';
  capturar(texto);
});

// ---------- Navegación, encabezado y menú ----------
function mostrarVista(vista) {
  const permitidas = vistasPermitidas();
  const enBarra = vistasEnBarra();
  M.vista = permitidas.includes(vista) ? vista : enBarra[0];
  for (const nombre of VISTAS) $(`vista-${nombre}`).hidden = nombre !== M.vista;
  // Recibir y contar del jefe viven en "Más"
  const activa = enBarra.includes(M.vista) ? M.vista : 'mas';
  document.querySelectorAll('.m-nav button').forEach((b) => {
    b.hidden = !enBarra.includes(b.dataset.vista);
    b.classList.toggle('activa', b.dataset.vista === activa);
  });
  $('texto-escanear').textContent = {
    inicio: 'Escanear', consultar: 'Escanear', recibir: 'Escanear lo que llegó', contar: 'Escanear para contar',
    cotizar: 'Escanear para cotizar', apoyos: 'Escanear lo que llegó', movimientos: 'Escanear un producto', mas: 'Escanear',
  }[M.vista];
  ajustarCaptura();
  if (M.vista === 'cotizar') {
    if (!M.destinos) cargarDestinos();
    cargarEnviadas();
  }
  if (M.vista === 'apoyos' && !M.revision) cargarApoyos({ silencioso: Boolean(M.apoyos) });
  if (M.vista === 'contar') cargarDia({ silencioso: true });
  if (M.vista === 'inicio') cargarInicio();
  if (M.vista === 'movimientos') abrirMovimientos();
  if (M.vista === 'mas') mostrarMenuMas();
  try { localStorage.setItem(`farmacia.movil.${M.usuario.id}.vista`, M.vista); } catch { /* sin almacenamiento */ }
}

// En la lista de apoyos no se escanea: primero se abre el apoyo. En Inicio y Más tampoco.
function ajustarCaptura() {
  document.querySelector('.m-captura').hidden = (M.vista === 'apoyos' && !M.revision) || M.vista === 'inicio' || M.vista === 'mas';
}

document.querySelectorAll('.m-nav button').forEach((b) => b.addEventListener('click', () => mostrarVista(b.dataset.vista)));

function pintarEncabezado() {
  const selector = $('m-sucursal');
  if (esAdminCentral()) {
    selector.innerHTML = M.sucursales.map((s) => `<option value="${s.id}" ${s.id === M.sucursalId ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('');
    selector.hidden = false;
    $('m-sucursal-texto').hidden = true;
  } else {
    $('m-sucursal-texto').textContent = `${nombreSucursal()} · ${M.usuario.nombre}`;
  }
}

$('m-sucursal').addEventListener('change', (e) => {
  M.sucursalId = Number(e.target.value);
  try { localStorage.setItem(`farmacia.movil.${M.usuario.id}.sucursal`, M.sucursalId); } catch { /* sin almacenamiento */ }
  cargarBorradores();
  if (M.producto) mostrarProducto(M.producto);
  if (M.vista === 'contar') cargarDia();
  aviso(`Trabajando con ${nombreSucursal()}`);
});

$('m-menu').addEventListener('click', () => {
  if (!M.usuario) return;
  const puedeInstalar = NUBE && !esInstalada() && (avisoInstalar || esIos());
  const hoja = abrirHoja(`
    <h3>${escaparHtml(M.usuario.nombre)}</h3>
    <p>${escaparHtml(M.usuario.sucursal)} · ${esJefe() ? 'Jefe' : M.usuario.rol === 'admin' ? 'Administrador' : 'Cajero'}</p>
    ${Escaner.disponible() ? '' : '<p class="m-error">La cámara necesita que el sistema se abra con https://. Mientras tanto puedes escribir el código o usar un lector Bluetooth.</p>'}
    ${puedeInstalar ? '<button class="m-boton principal" data-r="instalar">Instalar la app</button>' : ''}
    ${NUBE ? '' : '<a class="m-boton secundario" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/?escritorio=1">Ir a la versión de computadora</a>'}
    <button class="m-boton peligro" data-r="salir">${NUBE ? 'Desvincular este celular' : 'Cerrar sesión'}</button>
    <button class="m-boton secundario" data-r="no">Cerrar</button>
    <div class="m-creditos"><img src="img/swagit.png" alt=""><span>Desarrollado por <b>SwagIT</b> Technological Solutions</span></div>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelector('[data-r="instalar"]')?.addEventListener('click', () => instalarApp());
  hoja.querySelector('[data-r="salir"]').addEventListener('click', async () => {
    if (NUBE) {
      const confirmado = await confirmarHoja({
        titulo: 'Desvincular este celular',
        mensaje: 'La app dejará de entrar con tu cuenta en este celular. Para volver a usarla necesitarás un código nuevo de la computadora.',
        boton: 'Desvincular',
        peligro: true,
      });
      if (!confirmado) return;
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* igual se desvincula */ }
      olvidarSesion();
      mostrarVincular();
      return;
    }
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* igual se sale */ }
    location.href = '/login.html?volver=/movil.html';
  });
});

async function revisarSincronizacion() {
  const el = $('m-sync');
  if (M.usuario.modo !== 'central') return;
  try {
    const e = await api('/api/productos/sincronizacion');
    el.className = 'm-sync';
    if (e.disponible === false) { el.classList.add('error'); el.textContent = 'Sin conexión'; }
    else if (e.pendientes > 0) { el.classList.add('alerta'); el.textContent = `${e.pendientes} por subir`; }
    else el.textContent = 'En línea';
    el.hidden = false;
  } catch {
    el.hidden = true;
  }
}

// ---------- Arranque ----------
function leerPerfilGuardado() {
  try { return JSON.parse(localStorage.getItem(CLAVE_PERFIL) || 'null'); } catch { return null; }
}

function guardarPerfil() {
  try { localStorage.setItem(CLAVE_PERFIL, JSON.stringify({ usuario: M.usuario, sucursales: M.sucursales })); } catch { /* sin almacenamiento */ }
}

let revisionesIniciadas = false;
async function iniciar() {
  let sinInternet = false;
  try {
    M.usuario = await api('/api/auth/yo');
  } catch (error) {
    // En la nube, sin internet se arranca con el último perfil conocido (cada consulta avisa que no hay conexión)
    const guardado = NUBE && error.sinConexion ? leerPerfilGuardado() : null;
    if (!guardado) {
      if (NUBE && M.token && error.sinConexion) {
        mostrarVincular({ error: `${error.message} Se necesita internet para abrir la app.` });
        window.addEventListener('online', () => location.reload(), { once: true });
      }
      return; // sin sesión: api() ya mostró el inicio de sesión o la pantalla para vincular
    }
    sinInternet = true;
    M.usuario = guardado.usuario;
    M.sucursales = guardado.sucursales || [];
    aviso(error.message, 'error');
    // Al volver la conexión se recarga sola (la app instalada no tiene botón de recargar)
    window.addEventListener('online', () => location.reload(), { once: true });
    const reintentar = () => api('/api/auth/yo').then(() => location.reload()).catch((e) => {
      if (e.sinConexion) setTimeout(reintentar, 20000);
    });
    setTimeout(reintentar, 20000);
  }
  if (!sinInternet) {
    try {
      M.sucursales = await api('/api/admin/sucursales');
    } catch {
      M.sucursales = [{ id: M.usuario.sucursal_id, nombre: M.usuario.sucursal }];
    }
    if (NUBE) guardarPerfil();
  }
  let guardada = null;
  try { guardada = Number(localStorage.getItem(`farmacia.movil.${M.usuario.id}.sucursal`)); } catch { guardada = null; }
  M.sucursalId = esAdminCentral() && M.sucursales.some((s) => s.id === guardada) ? guardada : M.usuario.sucursal_id;
  pintarEncabezado();
  cargarBorradores();
  pintarRecientes();
  let vista = vistasEnBarra()[0];
  try { vista = localStorage.getItem(`farmacia.movil.${M.usuario.id}.vista`) || vista; } catch { /* sin almacenamiento */ }
  mostrarVista(vista);
  if (!Escaner.disponible()) {
    $('consulta-resultado').insertAdjacentHTML('afterbegin',
      '<div class="m-no-encontrados">Para usar la cámara abre el sistema con su dirección segura (https://). Mientras tanto escribe el código o usa un lector de código de barras Bluetooth.</div>');
  }
  if (esAdminCentral()) {
    $('consulta-ayuda').textContent = 'También ves los últimos movimientos, cambias el precio y lo agregas a una cotización.';
    if (esJefe() && M.vista !== 'inicio') revisarPorAutorizar();
  } else if (M.vista !== 'apoyos') {
    cargarApoyos({ silencioso: true }); // para el aviso de la pestaña
  }
  pintarAvisoInstalar();
  if (!revisionesIniciadas) {
    revisionesIniciadas = true;
    revisarSincronizacion();
    setInterval(revisarSincronizacion, 30000);
    // Aviso de apoyos que van llegando
    if (!esAdminCentral()) setInterval(() => { if (!M.revision) cargarApoyos({ silencioso: true }); }, 120000);
    // Aviso de los inventarios del día que falta autorizar
    if (esJefe()) setInterval(revisarPorAutorizar, 300000);
  }
}

// ---------- Vincular el celular (app en la nube) ----------
function leerSesion() {
  try { return localStorage.getItem(CLAVE_SESION) || ''; } catch { return ''; }
}

function guardarSesion(token) {
  M.token = token;
  try { localStorage.setItem(CLAVE_SESION, token); } catch { /* solo en memoria */ }
  // Pide al celular que no borre los datos de la app para liberar espacio
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

function olvidarSesion() {
  M.token = '';
  try {
    localStorage.removeItem(CLAVE_SESION);
    localStorage.removeItem(CLAVE_PERFIL);
  } catch { /* sin almacenamiento */ }
}

const esIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const esInstalada = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// Acepta "ABCD-2345", "abcd2345" o la dirección completa del código QR
function normalizarCodigo(texto) {
  let valor = String(texto || '').trim();
  const enDireccion = valor.match(/vincular=([A-Za-z0-9-]+)/);
  if (enDireccion) valor = enDireccion[1];
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const formatoCodigo = (codigo) => (codigo.length === 8 ? `${codigo.slice(0, 4)}-${codigo.slice(4)}` : codigo);

// El código llega en la dirección del QR (…/#vincular=ABCD2345); se quita para que no quede en el historial
function codigoEnDireccion() {
  const coincide = `${location.hash} ${location.search}`.match(/vincular=([A-Za-z0-9-]+)/);
  if (!coincide) return '';
  history.replaceState(null, '', location.pathname);
  return normalizarCodigo(coincide[1]);
}

async function describirDispositivo() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) {
    try {
      const datos = navigator.userAgentData && await navigator.userAgentData.getHighEntropyValues(['model']);
      if (datos && datos.model) return `Android · ${datos.model}`;
    } catch { /* sin el modelo */ }
    const modelo = ua.match(/Android [^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/);
    return modelo && modelo[1].trim() !== 'K' ? `Android · ${modelo[1].trim()}` : 'Android';
  }
  return 'Navegador';
}

async function vincular(codigo) {
  let r;
  try {
    r = await fetch(`${NUBE}/api/movil/vincular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo, dispositivo: await describirDispositivo() }),
    });
  } catch {
    throw new Error('Sin conexión a internet. Revisa los datos o el wifi del celular e intenta de nuevo.');
  }
  const datos = await r.json().catch(() => ({}));
  if (!r.ok || !datos.token) throw new Error(datos.error || 'No se pudo vincular el celular');
  // Si el celular ya tenía otra sesión, se cierra para que no quede abierta sin usarse
  const anterior = M.token;
  if (anterior && anterior !== datos.token) {
    fetch(`${NUBE}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${anterior}` } }).catch(() => {});
  }
  olvidarSesion();
  guardarSesion(datos.token);
  return datos.usuario;
}

function mostrarVincular({ codigo = '', instalar = false, error = '' } = {}) {
  if (Escaner.abierto()) Escaner.cerrar();
  cerrarHoja();
  document.body.classList.add('sin-vincular');
  $('vista-vincular').hidden = false;
  $('vincular-instalar').hidden = !instalar;
  $('vincular-formulario').hidden = instalar;
  const conCodigo = Boolean(codigo);
  $('vincular-codigo-ios').textContent = formatoCodigo(codigo);
  $('vincular-codigo-ios').hidden = !conCodigo;
  $('vincular-paso-codigo').innerHTML = conCodigo
    ? 'Abre <b>Inventario</b> desde la pantalla de inicio y escribe este código:'
    : 'Abre <b>Inventario</b> desde la pantalla de inicio y escribe el código que aparece en la computadora.';
  if (conCodigo) $('vincular-codigo').value = formatoCodigo(codigo);
  const caja = $('vincular-error');
  caja.textContent = error;
  caja.hidden = !error;
}

async function vincularDesdePantalla(texto) {
  const codigo = normalizarCodigo(texto);
  const caja = $('vincular-error');
  caja.hidden = true;
  if (codigo.length !== 8) {
    caja.textContent = 'Escribe las 8 letras y números del código (por ejemplo ABCD-2345).';
    caja.hidden = false;
    return;
  }
  const boton = $('vincular-form').querySelector('button');
  boton.disabled = true;
  boton.textContent = 'Vinculando…';
  try {
    await vincular(codigo);
    location.reload(); // arranca limpio con la sesión nueva
  } catch (error) {
    caja.textContent = error.message;
    caja.hidden = false;
    boton.disabled = false;
    boton.textContent = 'Vincular';
  }
}

$('vincular-form').addEventListener('submit', (e) => {
  e.preventDefault();
  vincularDesdePantalla($('vincular-codigo').value);
});

$('vincular-codigo').addEventListener('input', (e) => {
  const codigo = normalizarCodigo(e.target.value).slice(0, 8);
  const formateado = codigo.length > 4 ? `${codigo.slice(0, 4)}-${codigo.slice(4)}` : codigo;
  if (e.target.value !== formateado) e.target.value = formateado;
});

$('vincular-escanear').addEventListener('click', () => abrirCamara({
  titulo: 'Apunta al código QR de la computadora',
  formatos: 'qr',
  continuo: false,
  alLeer: (texto) => {
    const codigo = normalizarCodigo(texto);
    $('vincular-codigo').value = formatoCodigo(codigo);
    setTimeout(() => vincularDesdePantalla(codigo), 50);
    return false;
  },
  alTeclear: () => $('vincular-codigo').focus(),
}, {
  alFallar: (error) => {
    const caja = $('vincular-error');
    caja.textContent = `${error.message} Escribe el código a mano.`;
    caja.hidden = false;
    $('vincular-codigo').focus();
  },
}));

$('vincular-sin-instalar').addEventListener('click', () => {
  $('vincular-instalar').hidden = true;
  $('vincular-formulario').hidden = false;
  $('vincular-codigo').focus();
});

// ---------- Instalar la app (pantalla de inicio) ----------
let avisoInstalar = null; // Android: el navegador ofrece instalarla

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  avisoInstalar = e;
  pintarAvisoInstalar();
});

window.addEventListener('appinstalled', () => {
  avisoInstalar = null;
  pintarAvisoInstalar();
});

function pintarAvisoInstalar() {
  let descartado = false;
  try { descartado = localStorage.getItem('farmacia.movil.sin-aviso-instalar') === '1'; } catch { descartado = false; }
  $('m-instalar-aviso').hidden = !NUBE || !M.usuario || esInstalada() || descartado || !(avisoInstalar || esIos());
  $('m-instalar-boton').textContent = avisoInstalar ? 'Instalar' : 'Cómo instalar';
}

async function instalarApp() {
  if (avisoInstalar) {
    cerrarHoja();
    const solicitud = avisoInstalar;
    avisoInstalar = null;
    solicitud.prompt();
    try { await solicitud.userChoice; } catch { /* sin respuesta */ }
    pintarAvisoInstalar();
    return;
  }
  const hoja = abrirHoja(`
    <h3>Instalar la app</h3>
    <ol>
      <li>Toca <b>Compartir</b> <svg class="icono"><use href="#i-compartir"/></svg> en la barra de Safari.</li>
      <li>Elige <b>Agregar a pantalla de inicio</b> y toca <b>Agregar</b>.</li>
      <li>Abre <b>Inventario</b> desde la pantalla de inicio y vincúlala con un código nuevo de la computadora
          (la app instalada guarda su propia sesión).</li>
    </ol>
    <button class="m-boton secundario" data-r="no">Entendido</button>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
}

$('m-instalar-boton').addEventListener('click', () => instalarApp());
$('m-instalar-cerrar').addEventListener('click', () => {
  try { localStorage.setItem('farmacia.movil.sin-aviso-instalar', '1'); } catch { /* sin almacenamiento */ }
  $('m-instalar-aviso').hidden = true;
});

// ---------- Conexión (app en la nube) ----------
function pintarConexion() {
  if (!NUBE) return;
  const el = $('m-sync');
  const sinInternet = navigator.onLine === false;
  el.className = sinInternet ? 'm-sync error' : 'm-sync';
  el.textContent = 'Sin internet';
  el.hidden = !sinInternet;
}

window.addEventListener('online', pintarConexion);
window.addEventListener('offline', pintarConexion);

// Si la app ya estaba abierta cuando se abre el enlace del QR, solo cambia el "#": se arranca de nuevo
window.addEventListener('hashchange', () => {
  if (NUBE && /vincular=/.test(location.hash)) location.reload();
});

async function arrancar() {
  if (!NUBE) return iniciar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  pintarConexion();
  M.token = leerSesion();
  const codigo = codigoEnDireccion();
  if (codigo) {
    // En iPhone la app instalada no comparte datos con Safari: primero se instala y ahí se escribe el código
    if (esIos() && !esInstalada()) return mostrarVincular({ codigo, instalar: true });
    try {
      await vincular(codigo);
    } catch (error) {
      if (!M.token) return mostrarVincular({ codigo, error: error.message });
      aviso(error.message, 'error'); // ya estaba vinculado: sigue con su sesión
    }
  }
  if (!M.token) return mostrarVincular({ instalar: esIos() && !esInstalada() });
  return iniciar();
}

arrancar();
