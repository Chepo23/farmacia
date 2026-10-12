// Inventario desde el celular: consultar precio y existencias, recibir mercancía y contar
// (toma de inventario). Usa los mismos permisos y el mismo inventario que la computadora.
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
  mostrarProducto(producto);
}

function noEncontrado(codigo, { pareceCodigo = true } = {}) {
  if (M.vista === 'consultar' || !pareceCodigo) {
    const puedeAlta = esAdminCentral() && pareceCodigo;
    const hoja = abrirHoja(`
      <h3>No se encontró</h3>
      <p>${pareceCodigo ? `El código <b>${escaparHtml(codigo)}</b> no está en el catálogo.` : `No hay productos que coincidan con "<b>${escaparHtml(codigo)}</b>".`}
         ${pareceCodigo && !puedeAlta ? 'Pide a la farmacia central que lo dé de alta.' : ''}</p>
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
    <b>No están en el catálogo:</b> ${lista.noEncontrados.map((c) => esAdminCentral()
      ? `<button class="m-accion" data-alta="${escaparHtml(c)}">Dar de alta ${escaparHtml(c)}</button>`
      : `<code>${escaparHtml(c)}</code>`).join(' ')}
    ${esAdminCentral() ? '' : '<br>Pide a la farmacia central que los dé de alta y vuelve a escanearlos.'}
    <br><button class="m-accion" data-limpiar-no-encontrados>Quitar de la lista</button>
  </div>`;
}

// Alta rápida de un producto que llegó y no está en el catálogo (solo la central)
function altaProducto(codigo) {
  const hoja = abrirHoja(`
    <h3>Nuevo producto</h3>
    <label>Código de barras <input id="alta-codigo" type="text" value="${escaparHtml(codigo)}" readonly></label>
    <label>Descripción <input id="alta-descripcion" type="text" maxlength="200" placeholder="Ej. Paracetamol 500 mg c/10"></label>
    <div class="m-fila">
      <label>Costo <input id="alta-costo" type="number" inputmode="decimal" step="0.01" min="0"></label>
      <label>Precio de venta <input id="alta-venta" type="number" inputmode="decimal" step="0.01" min="0"></label>
    </div>
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
          existencia_inicial: 0,
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
      <div class="m-acciones">
        ${p.usa_inventario ? `
          <button class="m-accion principal" data-accion="entrada">Entrada</button>
          <button class="m-accion" data-accion="salida">Merma / salida</button>
          <button class="m-accion" data-accion="ajuste">Ajustar existencia</button>
          <button class="m-accion" data-accion="minimo">Mínimo</button>` : ''}
        <button class="m-accion" data-accion="historial"><svg class="icono"><use href="#i-historial"/></svg>Historial</button>
        ${esAdminCentral() ? '<button class="m-accion" data-accion="precio"><svg class="icono"><use href="#i-precio"/></svg>Cambiar precio</button>' : ''}
      </div>
    </div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

async function verHistorial() {
  const p = M.producto;
  try {
    const r = await api(`/api/productos/${p.id}/kardex?sucursal_id=${M.sucursalId}&limite=40`);
    const hoja = abrirHoja(`
      <h3>Historial — ${escaparHtml(p.descripcion)}</h3>
      <p>${escaparHtml(nombreSucursal())}</p>
      <ul class="m-historial">
        ${r.movimientos.map((m) => {
          const cantidad = m.delta == null ? `= ${cantidadTexto(m.cantidad)}` : `${m.delta > 0 ? '+' : '−'}${cantidadTexto(Math.abs(m.delta))}`;
          return `<li>
            <span>${escaparHtml({ entrada: 'Entrada', salida: 'Salida', venta: 'Venta', ajuste: 'Ajuste' }[m.tipo] || m.tipo)}${m.pendiente ? ' (por subir)' : ''}</span>
            <span class="${m.delta == null ? '' : m.delta > 0 ? 'mas' : 'menos'}">${cantidad}${m.existencia_resultante != null ? ` → ${cantidadTexto(m.existencia_resultante)}` : ''}</span>
            <small>${escaparHtml(fechaCorta(m.fecha))} · ${escaparHtml(m.usuario || '')}${m.nota ? ` · ${escaparHtml(m.nota)}` : ''}</small>
          </li>`;
        }).join('') || '<li>Sin movimientos</li>'}
      </ul>
      <button class="m-boton secundario" data-r="no">Cerrar</button>`);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
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

// ---------- Cámara ----------
const TITULOS_CAMARA = {
  consultar: 'Apunta al código del producto',
  recibir: 'Escanea lo que llegó',
  contar: 'Escanea cada pieza del estante',
};

async function manejarEscaneo(codigo) {
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
  return abrirCamara({
    titulo: TITULOS_CAMARA[M.vista],
    continuo: M.vista !== 'consultar',
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
  M.vista = ['consultar', 'recibir', 'contar'].includes(vista) ? vista : 'consultar';
  for (const nombre of ['consultar', 'recibir', 'contar']) $(`vista-${nombre}`).hidden = nombre !== M.vista;
  document.querySelectorAll('.m-nav button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === M.vista));
  $('texto-escanear').textContent = { consultar: 'Escanear', recibir: 'Escanear lo que llegó', contar: 'Escanear para contar' }[M.vista];
  try { localStorage.setItem(`farmacia.movil.${M.usuario.id}.vista`, M.vista); } catch { /* sin almacenamiento */ }
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
  aviso(`Trabajando con ${nombreSucursal()}`);
});

$('m-menu').addEventListener('click', () => {
  if (!M.usuario) return;
  const puedeInstalar = NUBE && !esInstalada() && (avisoInstalar || esIos());
  const hoja = abrirHoja(`
    <h3>${escaparHtml(M.usuario.nombre)}</h3>
    <p>${escaparHtml(M.usuario.sucursal)} · ${M.usuario.rol === 'admin' ? 'Administrador' : 'Cajero'}</p>
    ${Escaner.disponible() ? '' : '<p class="m-error">La cámara necesita que el sistema se abra con https://. Mientras tanto puedes escribir el código o usar un lector Bluetooth.</p>'}
    ${puedeInstalar ? '<button class="m-boton principal" data-r="instalar">Instalar la app</button>' : ''}
    ${NUBE ? '' : '<a class="m-boton secundario" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="/?escritorio=1">Ir a la versión de computadora</a>'}
    <button class="m-boton peligro" data-r="salir">${NUBE ? 'Desvincular este celular' : 'Cerrar sesión'}</button>
    <button class="m-boton secundario" data-r="no">Cerrar</button>`);
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
  let vista = 'consultar';
  try { vista = localStorage.getItem(`farmacia.movil.${M.usuario.id}.vista`) || 'consultar'; } catch { vista = 'consultar'; }
  mostrarVista(vista);
  if (!Escaner.disponible()) {
    $('consulta-resultado').insertAdjacentHTML('afterbegin',
      '<div class="m-no-encontrados">Para usar la cámara abre el sistema con su dirección segura (https://). Mientras tanto escribe el código o usa un lector de código de barras Bluetooth.</div>');
  }
  pintarAvisoInstalar();
  if (!revisionesIniciadas) {
    revisionesIniciadas = true;
    revisarSincronizacion();
    setInterval(revisarSincronizacion, 30000);
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
