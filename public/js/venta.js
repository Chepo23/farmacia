// Pantalla de venta (estilo Eleventa)
const Venta = {
  carrito: [], // { producto, cantidad }
  filaSeleccionada: -1,
  mayoreo: false, // F11: cobrar con precio de mayoreo
};

function precioUnitario(producto) {
  if (Venta.mayoreo && producto.precio_mayoreo != null) return producto.precio_mayoreo;
  return producto.precio_venta;
}

function totalVenta() {
  return Venta.carrito.reduce(
    (suma, r) => suma + Math.round(precioUnitario(r.producto) * r.cantidad * 100) / 100,
    0
  );
}

// Existencia del producto en la sucursal del usuario
function existenciaLocal(producto) {
  if (!producto.usa_inventario) return Infinity;
  if (producto.existencias) {
    const e = producto.existencias.find((x) => x.sucursal_id === App.usuario.sucursal_id);
    return e ? e.existencia : 0;
  }
  if (producto.existencia_local != null) return producto.existencia_local;
  return Infinity;
}

function pintarVenta() {
  const cuerpo = document.getElementById('cuerpo-venta');
  cuerpo.innerHTML = Venta.carrito
    .map((r, i) => {
      const precio = precioUnitario(r.producto);
      const importe = Math.round(precio * r.cantidad * 100) / 100;
      return `<tr data-indice="${i}" class="${i === Venta.filaSeleccionada ? 'seleccionado' : ''}">
        <td class="col-cant"><input type="number" class="cantidad" min="0.01" step="any" value="${r.cantidad}" data-indice="${i}"></td>
        <td>${escaparHtml(r.producto.descripcion)}</td>
        <td class="num">${dinero(precio)}</td>
        <td class="num col-importe">${dinero(importe)}</td>
        <td><button class="boton-quitar" data-indice="${i}" title="Quitar renglón"><svg class="icono"><use href="#i-x"/></svg></button></td>
      </tr>`;
    })
    .join('');
  const articulos = Venta.carrito.reduce((s, r) => s + r.cantidad, 0);
  const total = totalVenta();
  document.getElementById('total-venta').textContent = dinero(total);
  document.getElementById('articulos-venta').textContent =
    `${articulos} artículo${articulos === 1 ? '' : 's'}`;
  const tipoCambio = App.apertura?.tipo_cambio || 0;
  document.getElementById('total-dolares').textContent =
    tipoCambio > 0 ? `≈ ${(total / tipoCambio).toFixed(2)} USD (T.C. $${tipoCambio.toFixed(2)})` : '';
  document.getElementById('indicador-mayoreo').hidden = !Venta.mayoreo;
}

function agregarProducto(producto, cantidad) {
  const existente = Venta.carrito.find((r) => r.producto.id === producto.id);
  const cantidadFinal = (existente ? existente.cantidad : 0) + cantidad;
  const existencia = existenciaLocal(producto);
  if (cantidadFinal > existencia) {
    aviso(`No hay suficiente existencia de "${producto.descripcion}" (hay ${existencia})`, 'error');
    return;
  }
  if (existente) {
    existente.cantidad = cantidadFinal;
    Venta.filaSeleccionada = Venta.carrito.indexOf(existente);
  } else {
    Venta.carrito.push({ producto, cantidad });
    Venta.filaSeleccionada = Venta.carrito.length - 1;
  }
  pintarVenta();
}

// ---------- Artículo común (Ins): algo que no está en el catálogo ----------
let contadorComun = 0;
function abrirArticuloComun() {
  const modal = abrirModal(`
    <h3>Artículo común</h3>
    <p>Agrega a la venta un artículo que no está en el catálogo.</p>
    <label>Nombre <input type="text" id="com-nombre" placeholder="Ej. Jeringa suelta"></label>
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

entradaCodigo.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const texto = entradaCodigo.value.trim();
  if (!texto) return;

  try {
    const producto = await api('/api/productos/codigo/' + encodeURIComponent(texto));
    agregarProducto(producto, 1);
    entradaCodigo.value = '';
  } catch (err) {
    aviso(`No se encontró el código "${texto}"`, 'error');
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
    if (nueva > existencia) {
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

function cancelarVenta() {
  if (Venta.carrito.length === 0) return;
  Venta.carrito = [];
  Venta.filaSeleccionada = -1;
  Venta.mayoreo = false;
  pintarVenta();
  aviso('Venta cancelada');
  entradaCodigo.focus();
}

// ---------- Búsqueda de productos (F3) ----------
function abrirBusquedaProducto() {
  const modal = abrirModal(`
    <h3>Buscar producto</h3>
    <input type="text" id="entrada-busqueda" class="entrada" placeholder="Escribe el nombre del producto…" autocomplete="off">
    <div class="resultados-busqueda">
      <table class="tabla">
        <thead><tr><th>Descripción</th><th class="num">Precio</th><th class="num">Existencia</th></tr></thead>
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
      .map(
        (p, i) => `<tr data-indice="${i}" class="${i === seleccion ? 'seleccionado' : ''}">
          <td>${escaparHtml(p.descripcion)}</td>
          <td class="num">${dinero(p.precio_venta)}</td>
          <td class="num">${p.usa_inventario ? p.existencia_local : '—'}</td>
        </tr>`
      )
      .join('');
  }

  let temporizador = null;
  entrada.addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      resultados = await api('/api/productos/buscar?q=' + encodeURIComponent(entrada.value));
      seleccion = 0;
      pintarResultados();
    }, 200);
  });

  function elegir(i) {
    if (!resultados[i]) return;
    agregarProducto(resultados[i], 1);
    cerrarModal();
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
async function abrirCobro() {
  if (Venta.carrito.length === 0) {
    aviso('No hay artículos en la venta', 'error');
    return;
  }
  const total = totalVenta();
  const tipoCambio = App.apertura?.tipo_cambio || 0;
  // Solo se puede fiar a clientes con crédito autorizado
  const clientes = (await api('/api/clientes')).filter((c) => c.credito_autorizado);
  const modal = abrirModal(`
    <h3>Cobrar</h3>
    <div class="total-cobro">${dinero(total)}</div>
    ${tipoCambio > 0 ? `<div class="conteo-articulos" style="text-align:center">≈ ${(total / tipoCambio).toFixed(2)} USD (T.C. $${tipoCambio.toFixed(2)})</div>` : ''}
    <div class="fila">
      <label>Forma de pago
        <select id="cobro-forma">
          <option value="efectivo">Efectivo</option>
          <option value="dolar">Dólares</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="mixto">Mixto (efectivo + tarjeta)</option>
          <option value="credito">Crédito (fiado)</option>
        </select>
      </label>
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
          ${clientes.map((c) => `<option value="${c.id}">${escaparHtml(c.nombre)} (debe ${dinero(c.saldo)})</option>`).join('') ||
            '<option value="" disabled selected>No hay clientes con crédito autorizado</option>'}
        </select>
      </label>
    </div>
    <div class="fila-esperado" id="fila-cambio">Cambio (pesos): <b id="cobro-cambio">$0.00</b></div>
    <div class="fila-esperado" id="fila-tarjeta" hidden>Se cobra a tarjeta: <b id="cobro-tarjeta">$0.00</b></div>
    <label>Notas del ticket (opcional)
      <input type="text" id="cobro-nota" placeholder="Ej. Se entrega en la tarde" autocomplete="off">
    </label>
    <div id="cobro-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="cobro-cancelar">Cancelar (Esc)</button>
      <button class="boton primario" id="cobro-sin-imprimir">Cobrar sin imprimir</button>
      <button class="boton exito grande" id="cobro-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Cobrar e imprimir (Enter)</button>
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
    const visible = { efectivo: pago, dolar: pagoUsd, mixto: mixtoEfectivo }[forma.value];
    if (visible) { visible.focus(); visible.select(); }
  });
  pago.addEventListener('input', actualizar);
  pagoUsd.addEventListener('input', actualizar);
  mixtoEfectivo.addEventListener('input', actualizar);
  pago.focus();
  pago.select();
  actualizar();

  async function confirmar(imprimir) {
    const errorEl = modal.querySelector('#cobro-error');
    errorEl.hidden = true;
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
        },
      });
      Venta.carrito = [];
      Venta.filaSeleccionada = -1;
      Venta.mayoreo = false;
      pintarVenta();
      if (imprimir) await imprimirTicket(respuesta.ventaId, false);
      mostrarVentaTerminada(respuesta);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  modal.querySelector('#cobro-sin-imprimir').addEventListener('click', () => confirmar(false));
  modal.querySelector('#cobro-imprimir').addEventListener('click', () => confirmar(true));
  modal.querySelector('#cobro-cancelar').addEventListener('click', cerrarModal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      confirmar(true);
    }
  });
}

function mostrarVentaTerminada({ folio, cambio }) {
  const modal = abrirModal(`
    <h3>Venta realizada — Folio ${folio}</h3>
    <div>CAMBIO:</div>
    <div class="cambio-grande">${dinero(cambio)}</div>
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
  return venta.forma_pago;
}

// Renglones del ticket según la forma de pago
function formaPagoTicket(venta) {
  if (venta.forma_pago === 'efectivo') {
    return `<tr><td>Su pago</td><td class="num">${dinero(venta.pago)}</td></tr>
      <tr><td>Su cambio</td><td class="num">${dinero(venta.cambio)}</td></tr>`;
  }
  if (venta.forma_pago === 'dolar') {
    return `<tr><td>Su pago (USD)</td><td class="num">${(venta.pago_usd || 0).toFixed(2)} USD</td></tr>
      <tr><td>Tipo de cambio</td><td class="num">${dinero(venta.tipo_cambio)}</td></tr>
      <tr><td>Su cambio (pesos)</td><td class="num">${dinero(venta.cambio)}</td></tr>`;
  }
  if (venta.forma_pago === 'mixto') {
    return `<tr><td>Efectivo</td><td class="num">${dinero(venta.pago_efectivo)}</td></tr>
      <tr><td>Tarjeta</td><td class="num">${dinero(venta.pago_tarjeta)}</td></tr>`;
  }
  return `<tr><td>Forma de pago</td><td class="num">${venta.forma_pago}</td></tr>`;
}

async function imprimirTicket(ventaId, cerrarAlTerminar = true) {
  const venta = await api('/api/ventas/' + ventaId);
  const ticket = document.getElementById('ticket');
  ticket.innerHTML = `
    <h4>${escaparHtml(venta.sucursal)}</h4>
    ${venta.direccion ? `<div class="centro">${escaparHtml(venta.direccion)}</div>` : ''}
    ${venta.telefono ? `<div class="centro">Tel: ${escaparHtml(venta.telefono)}</div>` : ''}
    <div class="centro">${escaparHtml(venta.fecha)} — Folio ${venta.folio}</div>
    <div class="centro">Le atendió: ${escaparHtml(venta.cajero)}</div>
    <hr>
    <table>
      ${venta.partidas
        .map(
          (p) => `<tr>
            <td>${p.cantidad} x ${escaparHtml(p.descripcion)}</td>
            <td class="num">${dinero(p.importe)}</td>
          </tr>`
        )
        .join('')}
    </table>
    <hr>
    <table>
      <tr class="total"><td>TOTAL</td><td class="num">${dinero(venta.total)}</td></tr>
      ${formaPagoTicket(venta)}
      ${venta.cliente ? `<tr><td>Cliente</td><td class="num">${escaparHtml(venta.cliente)}</td></tr>` : ''}
    </table>
    ${venta.nota ? `<hr><div>Nota: ${escaparHtml(venta.nota)}</div>` : ''}
    <hr>
    <div class="centro">¡Gracias por su compra!</div>
  `;
  window.print();
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
            <thead><tr><th class="num">Folio</th><th class="num">Arts.</th><th>Hora</th><th class="num">Total</th></tr></thead>
            <tbody id="hv-cuerpo"></tbody>
          </table>
        </div>
        <div class="fila historial-filtros">
          <label>Del día <input type="date" id="hv-fecha" value="${hoy}"></label>
          <button class="boton" id="hv-hoy" style="align-self:flex-end">Hoy</button>
          <label>Cajero <select id="hv-cajero"><option value="">Todos</option></select></label>
        </div>
        <small><span class="muestra-credito"></span> Ventas a crédito</small>
      </div>
      <div class="historial-detalle">
        <div id="hv-sin-seleccion">Selecciona una venta para ver su detalle</div>
        <div id="hv-detalle" hidden>
          <p><b>Folio:</b> <span id="hv-d-folio">-</span><br>
             <b>Cajero:</b> <span id="hv-d-cajero">-</span><br>
             <b>Cliente:</b> <span id="hv-d-cliente">-</span><br>
             <b>Fecha:</b> <span id="hv-d-fecha">-</span></p>
          <div class="resultados-busqueda historial-tabla">
            <table class="tabla">
              <thead><tr><th class="num">Cant.</th><th>Descripción</th><th class="num">Importe</th></tr></thead>
              <tbody id="hv-d-partidas"></tbody>
            </table>
          </div>
          <table class="tabla-simple">
            <tr><td>Pagó con:</td><td class="num" id="hv-d-pago">$0.00</td></tr>
            <tr><td>Cambio:</td><td class="num" id="hv-d-cambio">$0.00</td></tr>
            <tr><td><b>Total:</b></td><td class="num"><b id="hv-d-total">$0.00</b></td></tr>
          </table>
          <button class="boton primario" id="hv-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir copia</button>
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
        (v) => `<tr data-venta="${v.id}" class="${v.forma_pago === 'credito' ? 'venta-credito' : ''} ${v.id === ventaSeleccionada ? 'seleccionado' : ''}">
          <td class="num">${v.folio}</td>
          <td class="num">${v.articulos}</td>
          <td>${escaparHtml(v.fecha.slice(11, 16))}</td>
          <td class="num">${dinero(v.total)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="4">Sin ventas ese día</td></tr>';
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
    modal.querySelector('#hv-d-cajero').textContent = venta.cajero;
    modal.querySelector('#hv-d-cliente').textContent = venta.cliente || '—';
    modal.querySelector('#hv-d-fecha').textContent = venta.fecha;
    modal.querySelector('#hv-d-partidas').innerHTML = venta.partidas
      .map(
        (p) => `<tr><td class="num">${p.cantidad}</td><td>${escaparHtml(p.descripcion)}</td><td class="num">${dinero(p.importe)}</td></tr>`
      )
      .join('');
    modal.querySelector('#hv-d-pago').textContent = descripcionPago(venta);
    modal.querySelector('#hv-d-cambio').textContent = dinero(venta.cambio);
    modal.querySelector('#hv-d-total').textContent = dinero(venta.total);
    pintarLista();
  }

  cuerpo.addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-venta]');
    if (fila) mostrarDetalle(Number(fila.dataset.venta));
  });
  modal.querySelector('#hv-imprimir').addEventListener('click', () => {
    if (ventaSeleccionada) imprimirTicket(ventaSeleccionada, false);
  });
  modal.querySelector('#hv-fecha').addEventListener('change', cargarVentas);
  modal.querySelector('#hv-hoy').addEventListener('click', () => {
    modal.querySelector('#hv-fecha').value = new Date().toLocaleDateString('sv-SE');
    cargarVentas();
  });
  modal.querySelector('#hv-buscar').addEventListener('input', pintarLista);
  modal.querySelector('#hv-cajero').addEventListener('change', pintarLista);
  cargarVentas();
}

// ---------- Botones y teclas de la venta ----------
document.getElementById('boton-cobrar').addEventListener('click', abrirCobro);
document.getElementById('boton-buscar').addEventListener('click', abrirBusquedaProducto);
document.getElementById('boton-cancelar-venta').addEventListener('click', cancelarVenta);
document.getElementById('boton-reimprimir').addEventListener('click', reimprimirUltimoTicket);
document.getElementById('boton-ventas-dia').addEventListener('click', abrirVentasDelDia);
document.getElementById('boton-articulo-comun').addEventListener('click', abrirArticuloComun);

document.addEventListener('keydown', (e) => {
  const ventaActiva = document.getElementById('seccion-venta').classList.contains('activa');
  if (!ventaActiva || hayModalAbierto()) return;
  if (e.key === 'F3') { e.preventDefault(); abrirBusquedaProducto(); }
  if (e.key === 'Insert') { e.preventDefault(); abrirArticuloComun(); }
  if (e.key === 'F11') { e.preventDefault(); alternarMayoreo(); }
  if (e.key === 'F12') { e.preventDefault(); abrirCobro(); }
  if (e.key === 'F4') { e.preventDefault(); cancelarVenta(); }
  if (e.key === 'Delete' && document.activeElement === entradaCodigo && Venta.filaSeleccionada >= 0) {
    e.preventDefault();
    Venta.carrito.splice(Venta.filaSeleccionada, 1);
    Venta.filaSeleccionada = Math.min(Venta.filaSeleccionada, Venta.carrito.length - 1);
    pintarVenta();
  }
});

App.alMostrarSeccion.venta = () => entradaCodigo.focus();
