// Pantalla de venta (estilo Eleventa)
//
// Varias ventas abiertas a la vez, en pestañas ("tickets"), como en Eleventa: mientras un cliente
// busca su dinero se puede atender al siguiente. Las ventas sin cobrar se guardan en esta
// computadora: si se cierra el programa (o se va la luz), siguen ahí al volver a abrirlo.
const MAX_TICKETS = 10;
const Tickets = { lista: [], actual: 0 };

function ticketNuevo() {
  const usados = new Set(Tickets.lista.map((t) => t.numero));
  let numero = 1;
  while (usados.has(numero)) numero += 1;
  return {
    numero,
    nombre: '', // opcional, por ejemplo el nombre del cliente
    carrito: [], // { producto, cantidad }
    filaSeleccionada: -1,
    mayoreo: false, // F11: cobrar con precio de mayoreo
    // Cotización cargada desde "Cotizaciones": { id, folio, cliente, vigente, vigente_hasta, precios: Map(producto -> { precio, cantidad }) }
    cotizacion: null,
  };
}

Tickets.lista.push(ticketNuevo());
let Venta = Tickets.lista[0]; // la venta de la pestaña que se está viendo

const NOMBRES_FORMA_PAGO = {
  efectivo: 'Efectivo',
  dolar: 'Dólares',
  tarjeta: 'Tarjeta',
  mixto: 'Mixto',
  credito: 'Crédito',
};

function redondear2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Piezas del mismo producto en toda la venta (para el mayoreo por cantidad)
function piezasDe(producto, t = Venta) {
  return t.carrito.filter((r) => r.producto.id === producto.id).reduce((s, r) => s + r.cantidad, 0);
}

// Mayoreo con F11, o automático al llegar a la cantidad de mayoreo del producto
function aplicaMayoreo(producto, t = Venta) {
  if (producto.comun || producto.precio_mayoreo == null) return false;
  if (t.mayoreo) return true;
  return Number(producto.cantidad_mayoreo) > 0 && piezasDe(producto, t) >= Number(producto.cantidad_mayoreo);
}

function precioNormal(producto, t = Venta) {
  return aplicaMayoreo(producto, t) ? Number(producto.precio_mayoreo) : Number(producto.precio_venta);
}

// Con una cotización vigente se respeta su precio (o el de hoy, si es más bajo), siempre que no se
// lleven más piezas de las cotizadas. El servidor aplica la misma regla al cobrar.
function precioCotizado(producto, t = Venta) {
  const c = t.cotizacion;
  if (!c || !c.vigente || producto.comun) return null;
  const cotizado = c.precios.get(producto.id);
  if (!cotizado || piezasDe(producto, t) > cotizado.cantidad + 1e-9) return null;
  return cotizado.precio;
}

function precioUnitario(producto, t = Venta) {
  const normal = precioNormal(producto, t);
  const cotizado = precioCotizado(producto, t);
  return cotizado != null ? Math.min(normal, cotizado) : normal;
}

function totalVenta(t = Venta) {
  return redondear2(t.carrito.reduce((suma, r) => suma + redondear2(precioUnitario(r.producto, t) * r.cantidad), 0));
}

const articulosDe = (t) => Math.round(t.carrito.reduce((s, r) => s + r.cantidad, 0) * 1000) / 1000;
const ticketVacio = (t) => t.carrito.length === 0 && !t.cotizacion;
const nombreTicket = (t) => t.nombre || `Ticket ${t.numero}`;

// Existencia del producto en la sucursal del usuario
function existenciaLocal(producto) {
  if (!producto.usa_inventario || producto.comun) return Infinity;
  if (producto.existencia_local != null) return Number(producto.existencia_local);
  if (producto.existencias) {
    const e = producto.existencias.find((x) => x.sucursal_id === App.usuario.sucursal_id);
    return e ? e.existencia : 0;
  }
  return Infinity;
}

function pintarVenta() {
  const cuerpo = document.getElementById('cuerpo-venta');
  cuerpo.innerHTML = Venta.carrito
    .map((r, i) => {
      const precio = precioUnitario(r.producto);
      const importe = redondear2(precio * r.cantidad);
      const cotizado = precioCotizado(r.producto);
      const mayoreo = cotizado == null && aplicaMayoreo(r.producto);
      const cotizadoAqui = Venta.cotizacion && Venta.cotizacion.precios.get(r.producto.id);
      const pasado = Venta.cotizacion && Venta.cotizacion.vigente && cotizadoAqui && cotizado == null;
      return `<tr data-indice="${i}" class="${i === Venta.filaSeleccionada ? 'seleccionado' : ''}">
        <td class="col-cant"><input type="number" class="cantidad" min="0.01" step="any" value="${r.cantidad}" data-indice="${i}" aria-label="Cantidad"></td>
        <td>${escaparHtml(r.producto.descripcion)}${mayoreo ? ' <span class="chip enviado">Mayoreo</span>' : ''}${cotizado != null ? ' <span class="chip ok">Precio cotizado</span>' : ''}${pasado ? ` <span class="chip pendiente" title="Se cotizaron ${cotizadoAqui.cantidad}">Más de lo cotizado: precio normal</span>` : ''}</td>
        <td class="num">${dinero(precio)}</td>
        <td class="num col-importe">${dinero(importe)}</td>
        <td><button class="boton-quitar" data-indice="${i}" title="Quitar renglón"><svg class="icono"><use href="#i-x"/></svg></button></td>
      </tr>`;
    })
    .join('');
  const articulos = Math.round(Venta.carrito.reduce((s, r) => s + r.cantidad, 0) * 1000) / 1000;
  const total = totalVenta();
  document.getElementById('total-venta').textContent = dinero(total);
  document.getElementById('articulos-venta').textContent = `${articulos} artículo${articulos === 1 ? '' : 's'}`;
  const tipoCambio = App.apertura?.tipo_cambio || 0;
  document.getElementById('total-dolares').textContent =
    tipoCambio > 0 ? `≈ ${(total / tipoCambio).toFixed(2)} USD (T.C. $${tipoCambio.toFixed(2)})` : '';
  document.getElementById('indicador-mayoreo').hidden = !Venta.mayoreo;
  pintarFranjaCotizacion();
  pintarPestanas();
  // Después del corte la caja queda cerrada: se pueden armar ventas y cobrarlas al abrirla
  document.getElementById('franja-caja').hidden = !(App.usuario && !App.apertura);
  guardarTickets();
}

// ---------- Pestañas de venta (tickets) ----------
function pintarPestanas() {
  const contenedor = document.getElementById('pestanas-venta');
  contenedor.innerHTML = Tickets.lista.map((t, i) => `
    <div class="pestana-venta ${i === Tickets.actual ? 'activa' : ''}" role="tab" aria-selected="${i === Tickets.actual}">
      <button type="button" class="pestana-venta-boton" data-ticket="${i}" title="Doble clic para ponerle nombre (por ejemplo, el del cliente)">
        <b>${escaparHtml(nombreTicket(t))}</b>
        <small>${t.carrito.length ? `${articulosDe(t)} art. · ${dinero(totalVenta(t))}` : 'Vacío'}</small>
      </button>
      ${Tickets.lista.length > 1 ? `<button type="button" class="pestana-venta-cerrar" data-cerrar="${i}" title="Cerrar este ticket" aria-label="Cerrar ${escaparHtml(nombreTicket(t))}"><svg class="icono"><use href="#i-x"/></svg></button>` : ''}
    </div>`).join('')
    + (Tickets.lista.length < MAX_TICKETS
      ? '<button type="button" class="pestana-nueva" id="ticket-nuevo" title="Atender a otro cliente sin cobrar esta venta"><svg class="icono"><use href="#i-mas"/></svg>Nuevo ticket <small>Ctrl+N</small></button>'
      : '');
}

function cambiarTicket(i) {
  if (!Tickets.lista[i]) return;
  Tickets.actual = i;
  Venta = Tickets.lista[i];
  pintarVenta();
  entradaCodigo.focus();
}

function nuevoTicket() {
  if (Tickets.lista.length >= MAX_TICKETS) {
    aviso(`Se pueden tener hasta ${MAX_TICKETS} tickets abiertos: cobra o cierra alguno`, 'error');
    return false;
  }
  Tickets.lista.push(ticketNuevo());
  cambiarTicket(Tickets.lista.length - 1);
  return true;
}

// Quita una pestaña (siempre queda al menos una) y muestra la de junto
function quitarTicket(i) {
  Tickets.lista.splice(i, 1);
  if (!Tickets.lista.length) Tickets.lista.push(ticketNuevo());
  if (i < Tickets.actual) Tickets.actual -= 1;
  else if (i === Tickets.actual) Tickets.actual = Math.max(0, i - 1);
  Tickets.actual = Math.min(Tickets.actual, Tickets.lista.length - 1);
  Venta = Tickets.lista[Tickets.actual];
  pintarVenta();
}

// La venta de la pestaña se cobró o se canceló: si hay más tickets se cierra; si no, queda vacío
function terminarTicketActual() {
  if (Tickets.lista.length > 1) {
    quitarTicket(Tickets.actual);
    return;
  }
  Tickets.lista = [];
  Tickets.lista.push(ticketNuevo());
  Tickets.actual = 0;
  Venta = Tickets.lista[0];
  pintarVenta();
}

async function cerrarTicket(i) {
  const t = Tickets.lista[i];
  if (!t) return;
  if (!ticketVacio(t)) {
    const cerrar = await confirmar({
      titulo: `Cerrar ${nombreTicket(t)}`,
      mensaje: `Se borra esta venta sin cobrar (${articulosDe(t)} artículo(s), ${dinero(totalVenta(t))}).`,
      boton: 'Cerrar ticket',
      peligro: true,
    });
    if (!cerrar) return;
  }
  quitarTicket(i);
  entradaCodigo.focus();
}

async function renombrarTicket(i) {
  const t = Tickets.lista[i];
  if (!t) return;
  const nombre = await pedirTexto({
    titulo: `Nombre de ${nombreTicket(t)}`,
    mensaje: 'Para reconocer la venta de cada cliente. Déjalo vacío para quitarlo.',
    etiqueta: 'Nombre',
    boton: 'Guardar',
    obligatorio: false,
    peligro: false,
  });
  if (nombre === null) return;
  t.nombre = nombre.trim().slice(0, 30);
  pintarVenta();
  entradaCodigo.focus();
}

document.getElementById('pestanas-venta').addEventListener('click', (e) => {
  const cerrar = e.target.closest('[data-cerrar]');
  if (cerrar) {
    cerrarTicket(Number(cerrar.dataset.cerrar));
    return;
  }
  const pestana = e.target.closest('[data-ticket]');
  // La pestaña que ya se ve no se vuelve a dibujar (así funciona el doble clic para el nombre).
  // El cursor siempre regresa al código: el lector de barras escribe donde esté el cursor.
  if (pestana && Number(pestana.dataset.ticket) === Tickets.actual) entradaCodigo.focus();
  else if (pestana) cambiarTicket(Number(pestana.dataset.ticket));
  else if (e.target.closest('#ticket-nuevo')) nuevoTicket();
});
document.getElementById('pestanas-venta').addEventListener('dblclick', (e) => {
  const pestana = e.target.closest('[data-ticket]');
  if (pestana) renombrarTicket(Number(pestana.dataset.ticket));
});

// ---------- Ventas sin cobrar guardadas en esta computadora ----------
let ticketsListos = false; // no se guarda nada hasta haber leído lo que ya estaba guardado
const claveTickets = () => `farmacia.ventas-abiertas.${App.usuario ? App.usuario.sucursal_id : 0}`;

function guardarTickets() {
  if (!ticketsListos) return;
  try {
    localStorage.setItem(claveTickets(), JSON.stringify({
      actual: Tickets.actual,
      lista: Tickets.lista.map((t) => ({ ...t, cotizacion: t.cotizacion ? { ...t.cotizacion, precios: [...t.cotizacion.precios] } : null })),
    }));
  } catch { /* sin almacenamiento: las ventas abiertas solo duran mientras el programa esté abierto */ }
}

// Al entrar: recupera las ventas que se dejaron sin cobrar, con los precios y existencias de hoy
async function restaurarTickets() {
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem(claveTickets()) || 'null'); } catch { guardado = null; }
  const recuperados = (guardado && Array.isArray(guardado.lista) ? guardado.lista : [])
    .filter((t) => t && Array.isArray(t.carrito))
    .map((t) => ({
      ...ticketNuevo(),
      numero: Number(t.numero) || 1,
      nombre: String(t.nombre || ''),
      carrito: t.carrito.filter((r) => r && r.producto && Number(r.cantidad) > 0),
      mayoreo: Boolean(t.mayoreo),
      cotizacion: t.cotizacion ? { ...t.cotizacion, precios: new Map(t.cotizacion.precios || []) } : null,
    }))
    .filter((t) => !ticketVacio(t));
  const actuales = Tickets.lista.filter((t) => !ticketVacio(t));
  ticketsListos = true;
  if (!recuperados.length) {
    pintarVenta();
    return;
  }
  // Datos de hoy de cada producto (precio y existencia); los que ya no se venden se quitan
  const ids = [...new Set(recuperados.flatMap((t) => t.carrito.filter((r) => !r.producto.comun).map((r) => Number(r.producto.id))))];
  const quitados = [];
  if (ids.length) {
    try {
      const frescos = new Map((await api(`/api/productos?ids=${ids.join(',')}`)).map((p) => [p.id, p]));
      for (const t of recuperados) {
        t.carrito = t.carrito.filter((r) => {
          if (r.producto.comun) return true;
          const fresco = frescos.get(Number(r.producto.id));
          if (!fresco) quitados.push(r.producto.descripcion);
          else r.producto = fresco;
          return Boolean(fresco);
        });
      }
    } catch { /* sin conexión: se usan los datos guardados; el servidor revisa todo al cobrar */ }
  }
  for (const t of recuperados) {
    for (const r of t.carrito) {
      const n = Number(String(r.producto.id).replace('comun-', ''));
      if (r.producto.comun && n > contadorComun) contadorComun = n;
    }
  }
  Tickets.lista = [...recuperados, ...actuales].slice(0, MAX_TICKETS);
  if (!Tickets.lista.length) Tickets.lista.push(ticketNuevo());
  Tickets.actual = Math.min(Math.max(Number(guardado.actual) || 0, 0), Tickets.lista.length - 1);
  Venta = Tickets.lista[Tickets.actual];
  pintarVenta();
  const pendientes = Tickets.lista.filter((t) => t.carrito.length).length;
  aviso(`${pendientes === 1 ? 'Hay 1 venta' : `Hay ${pendientes} ventas`} sin cobrar de la vez pasada${quitados.length ? `. Ya no están en el catálogo: ${quitados.join(', ')}` : ''}`, quitados.length ? 'error' : '');
}

// Para el programa de escritorio: al cerrar pregunta si se dejan las ventas sin cobrar
window.ventasSinCobrar = () => {
  const conArticulos = Tickets.lista.filter((t) => t.carrito.length > 0);
  return {
    tickets: conArticulos.length,
    articulos: Math.round(conArticulos.reduce((s, t) => s + articulosDe(t), 0) * 1000) / 1000,
    total: redondear2(conArticulos.reduce((s, t) => s + totalVenta(t), 0)),
  };
};
window.descartarVentasSinCobrar = () => {
  Tickets.lista = [];
  Tickets.lista.push(ticketNuevo());
  Tickets.actual = 0;
  Venta = Tickets.lista[0];
  pintarVenta();
  return true;
};

function pintarFranjaCotizacion() {
  const franja = document.getElementById('franja-cotizacion');
  const c = Venta.cotizacion;
  franja.hidden = !c;
  if (!c) {
    franja.innerHTML = '';
    return;
  }
  franja.innerHTML = `<span><svg class="icono"><use href="#i-cotizar"/></svg>
      Cotización folio ${c.folio}${c.cliente ? ` · ${escaparHtml(c.cliente)}` : ''} ·
      ${c.vigente ? `precios respetados hasta el ${escaparHtml(fechaDiaCorta(c.vigente_hasta))}` : 'ya venció: se cobra con los precios de hoy'}</span>
    <button class="boton" id="quitar-cotizacion">Quitar cotización</button>`;
  franja.querySelector('#quitar-cotizacion').addEventListener('click', () => {
    Venta.cotizacion = null;
    pintarVenta();
    aviso('Se quitó la cotización: la venta se cobra con los precios de hoy');
    entradaCodigo.focus();
  });
}

function fechaDiaCorta(iso) {
  const fecha = new Date(String(iso || '').replace(' ', 'T'));
  return Number.isNaN(fecha.getTime()) ? '' : fecha.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

function agregarProducto(producto, cantidad) {
  const existente = Venta.carrito.find((r) => r.producto.id === producto.id);
  const cantidadFinal = Math.round(((existente ? existente.cantidad : 0) + cantidad) * 1000) / 1000;
  const existencia = existenciaLocal(producto);
  if (cantidadFinal > existencia + 1e-9) {
    aviso(`No hay suficiente existencia de "${producto.descripcion}" (hay ${existencia})`, 'error');
    return false;
  }
  if (existente) {
    existente.cantidad = cantidadFinal;
    existente.producto = producto; // datos frescos (precio y existencia)
    Venta.filaSeleccionada = Venta.carrito.indexOf(existente);
  } else {
    Venta.carrito.push({ producto, cantidad });
    Venta.filaSeleccionada = Venta.carrito.length - 1;
  }
  pintarVenta();
  return true;
}

// ---------- Artículo común (Ins): algo que no está en el catálogo ----------
let contadorComun = 0;
function abrirArticuloComun() {
  const modal = abrirModal(`
    <h3>Artículo común</h3>
    <p>Agrega a la venta un artículo que no está en el catálogo.</p>
    <label>Nombre <input type="text" id="com-nombre" placeholder="Ej. Jeringa suelta" maxlength="200"></label>
    <div class="fila">
      <label>Cantidad <input type="number" id="com-cantidad" step="any" min="0.01" value="1"></label>
      <label>Precio ($) <input type="number" id="com-precio" step="0.01" min="0" placeholder="0.00"></label>
    </div>
    <div id="com-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="com-cancelar">Cancelar (Esc)</button>
      <button class="boton exito" id="com-agregar">Agregar (Enter)</button>
    </div>
  `);
  function agregar() {
    const nombre = modal.querySelector('#com-nombre').value.trim();
    const cantidad = Number(modal.querySelector('#com-cantidad').value);
    const precio = Number(modal.querySelector('#com-precio').value);
    const errorEl = modal.querySelector('#com-error');
    errorEl.hidden = true;
    if (!nombre || !(cantidad > 0) || !(precio > 0)) {
      errorEl.textContent = 'Escribe el nombre, una cantidad y un precio válidos';
      errorEl.hidden = false;
      return;
    }
    contadorComun += 1;
    Venta.carrito.push({
      producto: { id: 'comun-' + contadorComun, comun: true, descripcion: nombre, precio_venta: precio, usa_inventario: 0 },
      cantidad,
    });
    Venta.filaSeleccionada = Venta.carrito.length - 1;
    pintarVenta();
    cerrarModal();
  }
  modal.querySelector('#com-agregar').addEventListener('click', agregar);
  modal.querySelector('#com-cancelar').addEventListener('click', cerrarModal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); agregar(); }
  });
}

// F11: alternar entre precio normal y precio de mayoreo
function alternarMayoreo() {
  Venta.mayoreo = !Venta.mayoreo;
  pintarVenta();
  aviso(Venta.mayoreo ? 'Precio de MAYOREO activado' : 'Precio normal activado');
}

// ---------- Captura con escáner / teclado ----------
const entradaCodigo = document.getElementById('entrada-codigo');

// "3*7501234567890" agrega 3 piezas de golpe
function leerCaptura(texto) {
  const partes = texto.match(/^\s*(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/);
  if (!partes) return { cantidad: 1, codigo: texto.trim() };
  return { cantidad: Number(partes[1].replace(',', '.')), codigo: partes[2].trim() };
}

entradaCodigo.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const texto = entradaCodigo.value.trim();
  if (!texto) return;
  const { cantidad, codigo } = leerCaptura(texto);
  if (!(cantidad > 0) || !codigo) {
    aviso('Escribe la cantidad, un asterisco y el código. Ej. 3*7501234567890', 'error');
    return;
  }

  try {
    const producto = await api('/api/productos/codigo/' + encodeURIComponent(codigo));
    if (agregarProducto(producto, cantidad)) entradaCodigo.value = '';
    else entradaCodigo.select();
  } catch (err) {
    aviso(err.status === 404 ? `No se encontró el código "${codigo}"` : err.message, 'error');
    entradaCodigo.select();
  }
});

// Cambios de cantidad y quitar renglones
document.getElementById('cuerpo-venta').addEventListener('change', (e) => {
  if (!e.target.classList.contains('cantidad')) return;
  const i = Number(e.target.dataset.indice);
  const nueva = Number(e.target.value);
  if (nueva > 0) {
    const existencia = existenciaLocal(Venta.carrito[i].producto);
    if (nueva > existencia + 1e-9) {
      aviso(`No hay suficiente existencia de "${Venta.carrito[i].producto.descripcion}" (hay ${existencia})`, 'error');
    } else {
      Venta.carrito[i].cantidad = nueva;
    }
  } else {
    Venta.carrito.splice(i, 1);
  }
  pintarVenta();
  entradaCodigo.focus();
});

document.getElementById('cuerpo-venta').addEventListener('click', (e) => {
  const boton = e.target.closest('.boton-quitar');
  if (boton) {
    Venta.carrito.splice(Number(boton.dataset.indice), 1);
    if (Venta.filaSeleccionada >= Venta.carrito.length) Venta.filaSeleccionada = Venta.carrito.length - 1;
    pintarVenta();
    entradaCodigo.focus();
    return;
  }
  const fila = e.target.closest('tr[data-indice]');
  if (fila) {
    Venta.filaSeleccionada = Number(fila.dataset.indice);
    pintarVenta();
  }
});

document.addEventListener('keydown', (e) => {
  if (!['+', '-'].includes(e.key) || hayModalAbierto() || Venta.filaSeleccionada < 0) return;
  if (!document.getElementById('seccion-venta').classList.contains('activa')) return;
  const renglon = Venta.carrito[Venta.filaSeleccionada];
  if (!renglon) return;
  e.preventDefault();
  if (e.key === '+') {
    agregarProducto(renglon.producto, 1);
    return;
  }
  renglon.cantidad = Math.round((renglon.cantidad - 1) * 1000) / 1000;
  if (renglon.cantidad <= 0) {
    Venta.carrito.splice(Venta.filaSeleccionada, 1);
    Venta.filaSeleccionada = Math.min(Venta.filaSeleccionada, Venta.carrito.length - 1);
  }
  pintarVenta();
});

// F4: borra la venta de la pestaña (si hay más tickets, la pestaña se cierra)
function cancelarVenta() {
  if (ticketVacio(Venta)) {
    if (Tickets.lista.length > 1) quitarTicket(Tickets.actual);
    entradaCodigo.focus();
    return;
  }
  terminarTicketActual();
  aviso('Venta cancelada');
  entradaCodigo.focus();
}

// ---------- Cotizaciones que mandó la central para cobrarse aquí ----------
async function revisarCotizaciones() {
  try {
    const { pendientes, para_mi: paraMi } = await api('/api/cotizaciones/pendientes');
    const globo = document.getElementById('aviso-cotizaciones');
    globo.textContent = pendientes;
    globo.hidden = pendientes === 0;
    document.getElementById('boton-cotizaciones').title = pendientes
      ? `${pendientes} cotización(es) por cobrar${paraMi ? ` (${paraMi} para ti)` : ''}`
      : 'No hay cotizaciones por cobrar';
  } catch { /* sin conexión: no molestar */ }
}

async function abrirCotizaciones() {
  const modal = abrirModal(`
    <h3>Cotizaciones por cobrar</h3>
    <p>Las manda la central para que se cobren en esta sucursal. El precio cotizado se respeta hasta la fecha indicada.</p>
    <div class="resultados-busqueda">
      <table class="tabla">
        <thead><tr><th class="num">Folio</th><th>Cliente</th><th>Para</th><th>Enviada</th><th>Precio hasta</th><th class="num">Productos</th><th class="num">Total</th><th></th></tr></thead>
        <tbody id="cotizaciones-cuerpo"><tr><td colspan="8" class="vacio">Cargando…</td></tr></tbody>
      </table>
    </div>
    <div class="pie"><button class="boton" id="cotizaciones-cerrar">Cerrar (Esc)</button></div>
  `);
  modal.classList.add('grande');
  modal.querySelector('#cotizaciones-cerrar').addEventListener('click', cerrarModal);
  const cuerpo = modal.querySelector('#cotizaciones-cuerpo');
  let lista = [];
  try {
    lista = await api('/api/cotizaciones?estado=enviada');
  } catch (err) {
    cuerpo.innerHTML = `<tr><td colspan="8" class="vacio">${escaparHtml(err.message)}</td></tr>`;
    return;
  }
  // Primero las que son para este usuario
  lista.sort((a, b) => (b.destino_usuario_id === App.usuario.id) - (a.destino_usuario_id === App.usuario.id) || b.id - a.id);
  cuerpo.innerHTML = lista.map((c) => `
    <tr class="${c.destino_usuario_id === App.usuario.id ? 'fila-destacada' : ''}">
      <td class="num">${c.folio}</td>
      <td>${escaparHtml(c.cliente || '—')}${c.nota ? `<br><small>${escaparHtml(c.nota)}</small>` : ''}</td>
      <td>${c.destino_usuario ? escaparHtml(c.destino_usuario) : 'Toda la sucursal'}</td>
      <td>${escaparHtml(fechaHora(c.creado))}<br><small>${escaparHtml(c.creador)}</small></td>
      <td>${c.vigente ? escaparHtml(fechaDiaCorta(c.vigente_hasta)) : '<span class="chip pendiente">Vencida</span>'}</td>
      <td class="num">${c.productos}</td>
      <td class="num">${dinero(c.total)}</td>
      <td><button class="boton primario" data-cotizacion="${c.id}">Cargar en la venta</button></td>
    </tr>`).join('') || '<tr><td colspan="8" class="vacio">No hay cotizaciones por cobrar en esta sucursal.</td></tr>';
  cuerpo.addEventListener('click', (e) => {
    const boton = e.target.closest('button[data-cotizacion]');
    if (boton) cargarCotizacion(Number(boton.dataset.cotizacion), boton);
  });
  cuerpo.querySelector('button[data-cotizacion]')?.focus();
}

async function cargarCotizacion(id, boton) {
  let c;
  if (boton) boton.disabled = true;
  try {
    c = await api(`/api/cotizaciones/${id}?productos=1`);
  } catch (err) {
    aviso(err.message, 'error');
    if (boton) boton.disabled = false;
    return;
  }
  if (c.estado !== 'enviada') {
    aviso('Esa cotización ya se cobró o se canceló', 'error');
    cerrarModal();
    revisarCotizaciones();
    return;
  }
  // La venta que ya se estaba armando no se pierde: la cotización va en otro ticket
  if (!ticketVacio(Venta) && !nuevoTicket()) {
    if (boton) boton.disabled = false;
    return;
  }
  const productos = new Map((c.productos_actuales || []).map((p) => [p.id, p]));
  const carrito = [];
  const avisos = [];
  for (const r of c.renglones) {
    const producto = productos.get(r.producto_id);
    if (!producto) {
      avisos.push(`"${r.descripcion}" ya no está en el catálogo`);
      continue;
    }
    const existencia = existenciaLocal(producto);
    const cantidad = Math.min(r.cantidad, existencia);
    if (!(cantidad > 0)) {
      avisos.push(`No hay existencia de "${r.descripcion}"`);
      continue;
    }
    if (cantidad < r.cantidad) avisos.push(`De "${r.descripcion}" solo hay ${cantidad} (se cotizaron ${r.cantidad})`);
    carrito.push({ producto, cantidad });
  }
  Venta.carrito = carrito;
  Venta.filaSeleccionada = carrito.length - 1;
  Venta.mayoreo = false;
  Venta.cotizacion = {
    id: c.id,
    folio: c.folio,
    cliente: c.cliente,
    vigente: c.vigente,
    vigente_hasta: c.vigente_hasta,
    precios: new Map(c.renglones.map((r) => [r.producto_id, { precio: r.precio_unitario, cantidad: r.cantidad }])),
  };
  cerrarModal();
  pintarVenta();
  if (avisos.length) aviso(avisos.join(' · '), 'error');
  else aviso(`Cotización folio ${c.folio} cargada en ${nombreTicket(Venta)}: revisa y cobra (F12)`, 'exito');
  entradaCodigo.focus();
}

// ---------- Búsqueda de productos (F3) ----------
function abrirBusquedaProducto() {
  const modal = abrirModal(`
    <h3>Buscar producto</h3>
    <input type="text" id="entrada-busqueda" class="entrada" placeholder="Escribe el nombre del producto…" autocomplete="off">
    <div class="resultados-busqueda">
      <table class="tabla">
        <thead><tr><th>Descripción</th><th class="num">Precio</th><th class="num">Mayoreo</th><th class="num">Existencia</th></tr></thead>
        <tbody id="resultados-productos"></tbody>
      </table>
    </div>
    <div class="pie"><small>↑↓ para moverse, Enter para agregar, Esc para cerrar</small></div>
  `);

  let resultados = [];
  let seleccion = 0;
  const entrada = modal.querySelector('#entrada-busqueda');
  const cuerpo = modal.querySelector('#resultados-productos');

  function pintarResultados() {
    cuerpo.innerHTML = resultados
      .map((p, i) => {
        const existencia = existenciaLocal(p);
        return `<tr data-indice="${i}" class="${i === seleccion ? 'seleccionado' : ''}">
          <td>${escaparHtml(p.descripcion)}${p.codigo_barras ? `<br><small>${escaparHtml(p.codigo_barras)}</small>` : ''}</td>
          <td class="num">${dinero(p.precio_venta)}</td>
          <td class="num">${p.precio_mayoreo != null ? dinero(p.precio_mayoreo) + (p.cantidad_mayoreo ? `<br><small>desde ${p.cantidad_mayoreo}</small>` : '') : '—'}</td>
          <td class="num ${p.usa_inventario && existencia <= 0 ? 'texto-rojo' : ''}">${p.usa_inventario ? existencia : '—'}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="4" class="vacio">Sin resultados</td></tr>';
  }

  let temporizador = null;
  entrada.addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      try {
        resultados = await api('/api/productos/buscar?q=' + encodeURIComponent(entrada.value));
      } catch (err) {
        aviso(err.message, 'error');
        resultados = [];
      }
      seleccion = 0;
      pintarResultados();
    }, 200);
  });

  function elegir(i) {
    if (!resultados[i]) return;
    if (agregarProducto(resultados[i], 1)) cerrarModal();
  }

  entrada.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); seleccion = Math.min(seleccion + 1, resultados.length - 1); pintarResultados(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); seleccion = Math.max(seleccion - 1, 0); pintarResultados(); }
    if (e.key === 'Enter') { e.preventDefault(); elegir(seleccion); }
  });
  cuerpo.addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-indice]');
    if (fila) elegir(Number(fila.dataset.indice));
  });
}

// ---------- Cobro (F12) ----------
// Formas de pago con ícono (como en Eleventa); la letra también la elige desde el teclado
const FORMAS_COBRO = [
  { valor: 'efectivo', nombre: 'Efectivo', tecla: 'E', icono: 'i-pago-efectivo' },
  { valor: 'tarjeta', nombre: 'Tarjeta', tecla: 'T', icono: 'i-pago-tarjeta' },
  { valor: 'dolar', nombre: 'Dólares', tecla: 'D', icono: 'i-pago-dolar' },
  { valor: 'mixto', nombre: 'Mixto', detalle: 'Efectivo + tarjeta', tecla: 'M', icono: 'i-pago-mixto' },
  { valor: 'credito', nombre: 'Crédito', detalle: 'Fiado', tecla: 'C', icono: 'i-pago-credito' },
];

async function abrirCobro() {
  if (Venta.carrito.length === 0) {
    aviso('No hay artículos en la venta', 'error');
    return;
  }
  if (!App.apertura) {
    await pedirApertura({ cancelable: true });
    if (!App.apertura) return;
  }
  const total = totalVenta();
  const tipoCambio = App.apertura?.tipo_cambio || 0;
  // Solo se puede fiar a clientes con crédito autorizado
  let clientes = [];
  try {
    clientes = (await api('/api/clientes')).filter((c) => c.credito_autorizado);
  } catch { /* sin clientes, el crédito no estará disponible */ }
  const modal = abrirModal(`
    <h3>Cobrar</h3>
    <div class="total-cobro">${dinero(total)}</div>
    ${tipoCambio > 0 ? `<div class="conteo-articulos" style="text-align:center">≈ ${(total / tipoCambio).toFixed(2)} USD (T.C. $${tipoCambio.toFixed(2)})</div>` : ''}
    <div class="formas-pago" role="radiogroup" aria-label="Forma de pago">
      ${FORMAS_COBRO.map((f) => `<button type="button" class="forma-pago ${f.valor === 'efectivo' ? 'activa' : ''}" data-forma="${f.valor}"
          role="radio" aria-checked="${f.valor === 'efectivo'}" title="${f.nombre} (tecla ${f.tecla})">
          <small class="tecla-forma">${f.tecla}</small>
          <svg class="icono"><use href="#${f.icono}"/></svg>
          <b>${f.nombre}</b>${f.detalle ? `<span>${f.detalle}</span>` : ''}
        </button>`).join('')}
    </div>
    <input type="hidden" id="cobro-forma" value="efectivo">
    <div class="fila">
      <label id="etiqueta-pago">Pago recibido ($)
        <input type="number" id="cobro-pago" step="0.01" min="0" value="${total.toFixed(2)}">
      </label>
      <label id="etiqueta-pago-usd" hidden>Pago recibido (USD)
        <input type="number" id="cobro-pago-usd" step="0.01" min="0" value="${tipoCambio > 0 ? Math.ceil((total / tipoCambio) * 100) / 100 : ''}">
      </label>
      <label id="etiqueta-mixto" hidden>Efectivo recibido ($)
        <input type="number" id="cobro-mixto-efectivo" step="0.01" min="0" placeholder="0.00">
      </label>
      <label id="etiqueta-cliente" hidden>Cliente
        <select id="cobro-cliente">
          ${clientes.map((c) => `<option value="${c.id}">${escaparHtml(c.nombre)} (debe ${dinero(c.saldo)}${c.credito_disponible != null ? `, disponible ${dinero(c.credito_disponible)}` : ''})</option>`).join('') ||
            '<option value="" disabled selected>No hay clientes con crédito autorizado</option>'}
        </select>
      </label>
    </div>
    <div class="fila-esperado" id="fila-cambio">Cambio (pesos): <b id="cobro-cambio">$0.00</b></div>
    <div class="fila-esperado" id="fila-tarjeta" hidden>Se cobra a tarjeta: <b id="cobro-tarjeta">$0.00</b></div>
    <label>Notas del ticket (opcional)
      <input type="text" id="cobro-nota" placeholder="Ej. Se entrega en la tarde" autocomplete="off" maxlength="300">
    </label>
    <div id="cobro-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="cobro-cancelar">Cancelar (Esc)</button>
      <button class="boton primario" id="cobro-sin-imprimir">Cobrar sin imprimir (F2)</button>
      <button class="boton exito grande" id="cobro-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Cobrar e imprimir (F1 o Enter)</button>
    </div>
  `);

  const forma = modal.querySelector('#cobro-forma');
  const pago = modal.querySelector('#cobro-pago');
  const pagoUsd = modal.querySelector('#cobro-pago-usd');
  const mixtoEfectivo = modal.querySelector('#cobro-mixto-efectivo');
  const cambioEl = modal.querySelector('#cobro-cambio');

  function actualizar() {
    const f = forma.value;
    modal.querySelector('#etiqueta-pago').hidden = f !== 'efectivo';
    modal.querySelector('#etiqueta-pago-usd').hidden = f !== 'dolar';
    modal.querySelector('#etiqueta-mixto').hidden = f !== 'mixto';
    modal.querySelector('#etiqueta-cliente').hidden = f !== 'credito';
    modal.querySelector('#fila-cambio').hidden = f !== 'efectivo' && f !== 'dolar';
    modal.querySelector('#fila-tarjeta').hidden = f !== 'mixto';

    let cambio = 0;
    if (f === 'efectivo') cambio = Number(pago.value) - total;
    if (f === 'dolar') cambio = Number(pagoUsd.value) * tipoCambio - total;
    cambioEl.textContent = dinero(Math.max(cambio, 0));
    cambioEl.className = cambio < -0.005 ? 'texto-rojo' : 'texto-verde';

    if (f === 'mixto') {
      const restante = total - (Number(mixtoEfectivo.value) || 0);
      modal.querySelector('#cobro-tarjeta').textContent = dinero(Math.max(restante, 0));
    }
  }
  forma.addEventListener('change', () => {
    actualizar();
    // Donde se escribe el pago de esa forma; con tarjeta no hay nada que escribir: listo para cobrar
    const visible = { efectivo: pago, dolar: pagoUsd, mixto: mixtoEfectivo, credito: modal.querySelector('#cobro-cliente') }[forma.value];
    if (visible) {
      visible.focus();
      if (visible.tagName === 'INPUT') visible.select();
    } else {
      modal.querySelector('#cobro-imprimir').focus();
    }
  });
  function elegirForma(valor) {
    forma.value = valor;
    modal.querySelectorAll('.forma-pago').forEach((b) => {
      const activa = b.dataset.forma === valor;
      b.classList.toggle('activa', activa);
      b.setAttribute('aria-checked', String(activa));
    });
    forma.dispatchEvent(new Event('change'));
  }
  modal.querySelector('.formas-pago').addEventListener('click', (e) => {
    const boton = e.target.closest('[data-forma]');
    if (boton) elegirForma(boton.dataset.forma);
  });
  pago.addEventListener('input', actualizar);
  pagoUsd.addEventListener('input', actualizar);
  mixtoEfectivo.addEventListener('input', actualizar);
  pago.focus();
  pago.select();
  actualizar();

  let cobrando = false;
  async function confirmar(imprimir) {
    if (cobrando) return; // evita cobrar dos veces con doble Enter
    const errorEl = modal.querySelector('#cobro-error');
    errorEl.hidden = true;
    cobrando = true;
    try {
      const respuesta = await api('/api/ventas', {
        method: 'POST',
        body: {
          partidas: Venta.carrito.map((r) =>
            r.producto.comun
              ? { comun: true, descripcion: r.producto.descripcion, cantidad: r.cantidad, precio: r.producto.precio_venta }
              : { producto_id: r.producto.id, cantidad: r.cantidad }
          ),
          forma_pago: forma.value,
          pago: forma.value === 'efectivo' ? Number(pago.value) : totalVenta(),
          pago_usd: forma.value === 'dolar' ? Number(pagoUsd.value) : null,
          pago_efectivo: forma.value === 'mixto' ? Number(mixtoEfectivo.value) : null,
          cliente_id: forma.value === 'credito' ? Number(modal.querySelector('#cobro-cliente').value) : null,
          mayoreo: Venta.mayoreo,
          nota: modal.querySelector('#cobro-nota').value,
          cotizacion_id: Venta.cotizacion ? Venta.cotizacion.id : null,
        },
      });
      terminarTicketActual();
      if (respuesta.cotizacion) revisarCotizaciones();
      if (imprimir) await imprimirTicket(respuesta.ventaId, false);
      mostrarVentaTerminada(respuesta);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      if (err.codigo === 'COTIZACION_USADA') {
        // Ya se cobró en otra caja o la cancelaron: la venta sigue, pero con los precios de hoy
        Venta.cotizacion = null;
        pintarVenta();
        revisarCotizaciones();
        errorEl.textContent = `${err.message}. Se quitó de la venta: revisa el total y vuelve a cobrar.`;
        cerrarModal();
        aviso(errorEl.textContent, 'error');
      }
      if (err.codigo === 'SIN_APERTURA') {
        App.apertura = null;
        cerrarModal();
        await pedirApertura({ cancelable: true });
        if (App.apertura) aviso('Caja abierta. Vuelve a cobrar la venta (F12).');
      }
    } finally {
      cobrando = false;
    }
  }

  modal.querySelector('#cobro-sin-imprimir').addEventListener('click', () => confirmar(false));
  modal.querySelector('#cobro-imprimir').addEventListener('click', () => confirmar(true));
  modal.querySelector('#cobro-cancelar').addEventListener('click', cerrarModal);
  const teclasForma = Object.fromEntries(FORMAS_COBRO.map((f) => [f.tecla.toLowerCase(), f.valor]));
  modal.addEventListener('keydown', (e) => {
    // E, T, D, M, C eligen la forma de pago (salvo al escribir la nota o elegir el cliente)
    const escribiendo = e.target.id === 'cobro-nota' || e.target.tagName === 'SELECT';
    const formaDeTecla = teclasForma[String(e.key).toLowerCase()];
    if (formaDeTecla && !escribiendo && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      elegirForma(formaDeTecla);
      return;
    }
    if (e.key === 'F1') { e.preventDefault(); confirmar(true); return; }
    if (e.key === 'F2') { e.preventDefault(); confirmar(false); return; }
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      confirmar(true);
    }
  });
}

function mostrarVentaTerminada({ folio, cambio, inventarioPendiente, avisoSincronizacion, cotizacion }) {
  const modal = abrirModal(`
    <h3>Venta realizada — Folio ${folio}</h3>
    ${cotizacion ? `<div class="franja-aviso info">Se cobró la cotización folio ${cotizacion.folio}${cotizacion.vigente ? ' con sus precios' : ' (vencida: con los precios de hoy)'}.</div>` : ''}
    <div>CAMBIO:</div>
    <div class="cambio-grande">${dinero(cambio)}</div>
    ${inventarioPendiente ? `<div class="franja-aviso info">${escaparHtml(avisoSincronizacion || 'El inventario se actualizará en la central cuando vuelva el internet.')}</div>` : ''}
    <div class="pie">
      <button class="boton primario grande" id="terminada-cerrar">Cerrar (Enter/Esc)</button>
    </div>
  `);
  modal.querySelector('#terminada-cerrar').addEventListener('click', cerrarModal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); cerrarModal(); }
  });
}

// Texto corto de cómo se pagó una venta (para el historial)
function descripcionPago(venta) {
  if (venta.forma_pago === 'efectivo') return dinero(venta.pago);
  if (venta.forma_pago === 'dolar') return `${(venta.pago_usd || 0).toFixed(2)} USD`;
  if (venta.forma_pago === 'mixto') {
    return `${dinero(venta.pago_efectivo)} efectivo + ${dinero(venta.pago_tarjeta)} tarjeta`;
  }
  return NOMBRES_FORMA_PAGO[venta.forma_pago] || venta.forma_pago;
}

async function imprimirTicket(ventaId, cerrarAlTerminar = true) {
  try {
    const venta = await api('/api/ventas/' + ventaId);
    await Impresion.imprimirVenta(venta);
  } catch (err) {
    aviso('No se pudo imprimir el ticket: ' + err.message, 'error');
  }
  if (cerrarAlTerminar) cerrarModal();
}

// ---------- Reimprimir el último ticket ----------
async function reimprimirUltimoTicket() {
  try {
    const ultima = await api('/api/ventas/ultima');
    await imprimirTicket(ultima.id, false);
  } catch (err) {
    aviso(err.message, 'error');
  }
}

// ---------- Historial de ventas (estilo Eleventa) ----------
async function abrirVentasDelDia() {
  const hoy = new Date().toLocaleDateString('sv-SE');
  const modal = abrirModal(`
    <h3>Historial de ventas</h3>
    <div class="historial">
      <div class="historial-lista">
        <input type="text" id="hv-buscar" class="entrada" placeholder="Puedes buscar por folio o nombre del cliente…" autocomplete="off">
        <div class="resultados-busqueda historial-tabla">
          <table class="tabla">
            <thead><tr><th class="num">Folio</th><th class="num">Arts.</th><th>Hora</th><th>Pago</th><th class="num">Total</th></tr></thead>
            <tbody id="hv-cuerpo"></tbody>
          </table>
        </div>
        <div class="fila historial-filtros">
          <label>Del día <input type="date" id="hv-fecha" value="${hoy}"></label>
          <button class="boton" id="hv-hoy" style="align-self:flex-end">Hoy</button>
          <label>Cajero <select id="hv-cajero"><option value="">Todos</option></select></label>
        </div>
        <small><span class="muestra-credito"></span> Ventas a crédito · las canceladas aparecen tachadas</small>
        <div id="hv-resumen" class="dato-secundario"></div>
      </div>
      <div class="historial-detalle">
        <div id="hv-sin-seleccion">Selecciona una venta para ver su detalle</div>
        <div id="hv-detalle" hidden>
          <p><b>Folio:</b> <span id="hv-d-folio">-</span> <span id="hv-d-estado"></span><br>
             <b>Cajero:</b> <span id="hv-d-cajero">-</span><br>
             <b>Cliente:</b> <span id="hv-d-cliente">-</span><br>
             <b>Fecha:</b> <span id="hv-d-fecha">-</span></p>
          <div id="hv-d-cancelacion" class="mensaje-error" hidden></div>
          <div class="resultados-busqueda historial-tabla">
            <table class="tabla">
              <thead><tr><th class="num">Cant.</th><th>Descripción</th><th class="num">Importe</th></tr></thead>
              <tbody id="hv-d-partidas"></tbody>
            </table>
          </div>
          <table class="tabla-simple">
            <tr><td>Forma de pago:</td><td class="num" id="hv-d-forma">-</td></tr>
            <tr><td>Pagó con:</td><td class="num" id="hv-d-pago">$0.00</td></tr>
            <tr><td>Cambio:</td><td class="num" id="hv-d-cambio">$0.00</td></tr>
            <tr><td><b>Total:</b></td><td class="num"><b id="hv-d-total">$0.00</b></td></tr>
          </table>
          <div class="acciones">
            <button class="boton primario" id="hv-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir copia</button>
            <button class="boton peligro-suave" id="hv-cancelar" hidden><svg class="icono"><use href="#i-x"/></svg>Cancelar venta</button>
          </div>
        </div>
      </div>
    </div>
    <div class="pie"><button class="boton" onclick="cerrarModal()">Cerrar ventana (Esc)</button></div>
  `);
  modal.classList.add('grande');

  const cuerpo = modal.querySelector('#hv-cuerpo');
  let ventas = [];
  let ventaSeleccionada = null;

  function pintarLista() {
    const filtro = modal.querySelector('#hv-buscar').value.trim().toLowerCase();
    const cajero = modal.querySelector('#hv-cajero').value;
    const visibles = ventas.filter(
      (v) =>
        (!cajero || v.cajero === cajero) &&
        (!filtro || String(v.folio).includes(filtro) || (v.cliente || '').toLowerCase().includes(filtro))
    );
    cuerpo.innerHTML = visibles
      .map(
        (v) => `<tr data-venta="${v.id}" class="${v.forma_pago === 'credito' ? 'venta-credito' : ''} ${v.cancelada ? 'venta-cancelada' : ''} ${v.id === ventaSeleccionada ? 'seleccionado' : ''}">
          <td class="num">${v.folio}</td>
          <td class="num">${v.articulos}</td>
          <td>${escaparHtml(String(v.fecha).slice(11, 16))}</td>
          <td>${escaparHtml(NOMBRES_FORMA_PAGO[v.forma_pago] || v.forma_pago)}</td>
          <td class="num">${dinero(v.total)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5">Sin ventas ese día</td></tr>';
    const activas = visibles.filter((v) => !v.cancelada);
    modal.querySelector('#hv-resumen').innerHTML = `<span>${activas.length} venta(s)</span><b>${dinero(activas.reduce((t, v) => t + v.total, 0))}</b>`;
  }

  async function cargarVentas() {
    const fecha = modal.querySelector('#hv-fecha').value;
    ventas = await api('/api/ventas?fecha=' + encodeURIComponent(fecha));
    // El filtro de cajero se arma con los cajeros que vendieron ese día
    const cajeros = [...new Set(ventas.map((v) => v.cajero))];
    modal.querySelector('#hv-cajero').innerHTML =
      '<option value="">Todos</option>' +
      cajeros.map((c) => `<option value="${escaparHtml(c)}">${escaparHtml(c)}</option>`).join('');
    ventaSeleccionada = null;
    modal.querySelector('#hv-detalle').hidden = true;
    modal.querySelector('#hv-sin-seleccion').hidden = false;
    pintarLista();
  }

  async function mostrarDetalle(ventaId) {
    const venta = await api('/api/ventas/' + ventaId);
    ventaSeleccionada = venta.id;
    modal.querySelector('#hv-sin-seleccion').hidden = true;
    modal.querySelector('#hv-detalle').hidden = false;
    modal.querySelector('#hv-d-folio').textContent = venta.folio;
    modal.querySelector('#hv-d-estado').innerHTML = venta.cancelada ? '<span class="chip cancelada">Cancelada</span>' : '';
    modal.querySelector('#hv-d-cajero').textContent = venta.cajero;
    modal.querySelector('#hv-d-cliente').textContent = venta.cliente || '—';
    modal.querySelector('#hv-d-fecha').textContent = venta.fecha;
    const cancelacion = modal.querySelector('#hv-d-cancelacion');
    cancelacion.hidden = !venta.cancelada;
    cancelacion.textContent = venta.cancelada
      ? `Cancelada el ${venta.cancelada_fecha} por ${venta.cancelada_por_nombre || ''}: ${venta.motivo_cancelacion || ''}`
      : '';
    modal.querySelector('#hv-d-partidas').innerHTML = venta.partidas
      .map((p) => `<tr><td class="num">${p.cantidad}</td><td>${escaparHtml(p.descripcion)}</td><td class="num">${dinero(p.importe)}</td></tr>`)
      .join('');
    modal.querySelector('#hv-d-forma').textContent = NOMBRES_FORMA_PAGO[venta.forma_pago] || venta.forma_pago;
    modal.querySelector('#hv-d-pago').textContent = descripcionPago(venta);
    modal.querySelector('#hv-d-cambio').textContent = dinero(venta.cambio);
    modal.querySelector('#hv-d-total').textContent = dinero(venta.total);
    // Solo se cancelan ventas del turno actual (todavía sin corte de caja)
    modal.querySelector('#hv-cancelar').hidden = Boolean(venta.cancelada || venta.corte_id);
    pintarLista();
  }

  async function cancelarSeleccionada() {
    const venta = ventas.find((v) => v.id === ventaSeleccionada);
    if (!venta) return;
    const motivo = await pedirTexto({
      titulo: `Cancelar la venta folio ${venta.folio}`,
      mensaje: `Se cancelará la venta por ${dinero(venta.total)}. La mercancía regresa al inventario${venta.forma_pago === 'credito' ? ' y se quita el cargo de la cuenta del cliente' : ''}. Devuelve el dinero al cliente.`,
      etiqueta: 'Motivo de la cancelación',
      boton: 'Sí, cancelar la venta',
    });
    if (motivo === null) return;
    try {
      await api(`/api/ventas/${venta.id}/cancelar`, { method: 'POST', body: { motivo } });
      aviso(`Venta folio ${venta.folio} cancelada`, 'exito');
      await cargarVentas();
      await mostrarDetalle(venta.id);
    } catch (err) {
      aviso(err.message, 'error');
    }
  }

  cuerpo.addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-venta]');
    if (fila) mostrarDetalle(Number(fila.dataset.venta)).catch((err) => aviso(err.message, 'error'));
  });
  modal.querySelector('#hv-imprimir').addEventListener('click', () => {
    if (ventaSeleccionada) imprimirTicket(ventaSeleccionada, false);
  });
  modal.querySelector('#hv-cancelar').addEventListener('click', cancelarSeleccionada);
  modal.querySelector('#hv-fecha').addEventListener('change', cargarVentas);
  modal.querySelector('#hv-hoy').addEventListener('click', () => {
    modal.querySelector('#hv-fecha').value = new Date().toLocaleDateString('sv-SE');
    cargarVentas();
  });
  modal.querySelector('#hv-buscar').addEventListener('input', pintarLista);
  modal.querySelector('#hv-cajero').addEventListener('change', pintarLista);
  cargarVentas().catch((err) => aviso(err.message, 'error'));
}

// ---------- Botones y teclas de la venta ----------
document.getElementById('boton-cobrar').addEventListener('click', abrirCobro);
document.getElementById('boton-buscar').addEventListener('click', abrirBusquedaProducto);
document.getElementById('boton-cancelar-venta').addEventListener('click', cancelarVenta);
document.getElementById('boton-reimprimir').addEventListener('click', reimprimirUltimoTicket);
document.getElementById('boton-ventas-dia').addEventListener('click', abrirVentasDelDia);
document.getElementById('boton-articulo-comun').addEventListener('click', abrirArticuloComun);
document.getElementById('boton-cotizaciones').addEventListener('click', abrirCotizaciones);

document.getElementById('boton-abrir-caja').addEventListener('click', () => pedirApertura({ cancelable: true }));

document.addEventListener('app:listo', () => {
  restaurarTickets();
  revisarCotizaciones();
  setInterval(revisarCotizaciones, 60000);
});

document.addEventListener('keydown', (e) => {
  const ventaActiva = document.getElementById('seccion-venta').classList.contains('activa');
  if (!ventaActiva || hayModalAbierto()) return;
  if (e.key === 'F3') { e.preventDefault(); abrirBusquedaProducto(); }
  if (e.key === 'Insert') { e.preventDefault(); abrirArticuloComun(); }
  if (e.key === 'F11') { e.preventDefault(); alternarMayoreo(); }
  if (e.key === 'F12') { e.preventDefault(); abrirCobro(); }
  if (e.key === 'F4') { e.preventDefault(); cancelarVenta(); }
  // Tickets: Ctrl+N abre otro; Ctrl+Tab (o Ctrl+Shift+Tab) pasa al siguiente (o al anterior)
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); nuevoTicket(); }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cambiarTicket((Tickets.actual + (e.shiftKey ? Tickets.lista.length - 1 : 1)) % Tickets.lista.length);
  }
  if (e.key === 'Delete' && document.activeElement === entradaCodigo && Venta.filaSeleccionada >= 0) {
    e.preventDefault();
    Venta.carrito.splice(Venta.filaSeleccionada, 1);
    Venta.filaSeleccionada = Math.min(Venta.filaSeleccionada, Venta.carrito.length - 1);
    pintarVenta();
  }
});

App.alMostrarSeccion.venta = () => entradaCodigo.focus();

pintarVenta();
