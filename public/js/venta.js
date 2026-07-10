// Pantalla de venta (estilo Eleventa)
const Venta = {
  carrito: [], // { producto, cantidad }
  filaSeleccionada: -1,
};

function precioUnitario(producto, cantidad) {
  if (
    producto.precio_mayoreo != null &&
    producto.cantidad_mayoreo != null &&
    cantidad >= producto.cantidad_mayoreo
  ) {
    return producto.precio_mayoreo;
  }
  return producto.precio_venta;
}

function totalVenta() {
  return Venta.carrito.reduce(
    (suma, r) => suma + Math.round(precioUnitario(r.producto, r.cantidad) * r.cantidad * 100) / 100,
    0
  );
}

function pintarVenta() {
  const cuerpo = document.getElementById('cuerpo-venta');
  cuerpo.innerHTML = Venta.carrito
    .map((r, i) => {
      const precio = precioUnitario(r.producto, r.cantidad);
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
  document.getElementById('total-venta').textContent = dinero(totalVenta());
  document.getElementById('articulos-venta').textContent =
    `${articulos} artículo${articulos === 1 ? '' : 's'}`;
}

function agregarProducto(producto, cantidad) {
  const existente = Venta.carrito.find((r) => r.producto.id === producto.id);
  if (existente) {
    existente.cantidad += cantidad;
    Venta.filaSeleccionada = Venta.carrito.indexOf(existente);
  } else {
    Venta.carrito.push({ producto, cantidad });
    Venta.filaSeleccionada = Venta.carrito.length - 1;
  }
  pintarVenta();
}

// ---------- Captura con escáner / teclado ----------
const entradaCodigo = document.getElementById('entrada-codigo');

entradaCodigo.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  let texto = entradaCodigo.value.trim();
  if (!texto) return;

  // "3*7501001234" = cantidad 3 del código 7501001234
  let cantidad = 1;
  const partes = texto.match(/^([\d.]+)\*(.+)$/);
  if (partes) {
    cantidad = Number(partes[1]) || 1;
    texto = partes[2].trim();
  }

  try {
    const producto = await api('/api/productos/codigo/' + encodeURIComponent(texto));
    agregarProducto(producto, cantidad);
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
    Venta.carrito[i].cantidad = nueva;
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
  const clientes = await api('/api/clientes');
  const modal = abrirModal(`
    <h3>Cobrar</h3>
    <div class="total-cobro">${dinero(total)}</div>
    <div class="fila">
      <label>Forma de pago
        <select id="cobro-forma">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
          <option value="credito">Crédito (fiado)</option>
        </select>
      </label>
      <label id="etiqueta-pago">Pago recibido
        <input type="number" id="cobro-pago" step="0.01" min="0" value="${total.toFixed(2)}">
      </label>
      <label id="etiqueta-cliente" hidden>Cliente
        <select id="cobro-cliente">
          ${clientes.map((c) => `<option value="${c.id}">${escaparHtml(c.nombre)} (debe ${dinero(c.saldo)})</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="fila-esperado">Cambio: <b id="cobro-cambio">$0.00</b></div>
    <div id="cobro-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="cobro-cancelar">Cancelar (Esc)</button>
      <button class="boton exito grande" id="cobro-aceptar">Cobrar (Enter)</button>
    </div>
  `);

  const forma = modal.querySelector('#cobro-forma');
  const pago = modal.querySelector('#cobro-pago');
  const cambioEl = modal.querySelector('#cobro-cambio');

  function actualizar() {
    const esEfectivo = forma.value === 'efectivo';
    modal.querySelector('#etiqueta-pago').hidden = !esEfectivo;
    modal.querySelector('#etiqueta-cliente').hidden = forma.value !== 'credito';
    const cambio = esEfectivo ? Number(pago.value) - total : 0;
    cambioEl.textContent = dinero(Math.max(cambio, 0));
    cambioEl.className = cambio < 0 && esEfectivo ? 'texto-rojo' : 'texto-verde';
  }
  forma.addEventListener('change', actualizar);
  pago.addEventListener('input', actualizar);
  pago.focus();
  pago.select();
  actualizar();

  async function confirmar() {
    const errorEl = modal.querySelector('#cobro-error');
    errorEl.hidden = true;
    try {
      const respuesta = await api('/api/ventas', {
        method: 'POST',
        body: {
          partidas: Venta.carrito.map((r) => ({ producto_id: r.producto.id, cantidad: r.cantidad })),
          forma_pago: forma.value,
          pago: forma.value === 'efectivo' ? Number(pago.value) : totalVenta(),
          cliente_id: forma.value === 'credito' ? Number(modal.querySelector('#cobro-cliente').value) : null,
        },
      });
      Venta.carrito = [];
      Venta.filaSeleccionada = -1;
      pintarVenta();
      mostrarVentaTerminada(respuesta);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  modal.querySelector('#cobro-aceptar').addEventListener('click', confirmar);
  modal.querySelector('#cobro-cancelar').addEventListener('click', cerrarModal);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      confirmar();
    }
  });
}

function mostrarVentaTerminada({ ventaId, folio, cambio }) {
  const modal = abrirModal(`
    <h3>Venta realizada — Folio ${folio}</h3>
    <div>CAMBIO:</div>
    <div class="cambio-grande">${dinero(cambio)}</div>
    <div class="pie">
      <button class="boton" id="terminada-cerrar">Cerrar (Esc)</button>
      <button class="boton primario grande" id="terminada-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir ticket (Enter)</button>
    </div>
  `);
  modal.querySelector('#terminada-cerrar').addEventListener('click', cerrarModal);
  modal.querySelector('#terminada-imprimir').addEventListener('click', () => imprimirTicket(ventaId));
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); imprimirTicket(ventaId); }
  });
}

async function imprimirTicket(ventaId) {
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
      ${venta.forma_pago === 'efectivo'
        ? `<tr><td>Su pago</td><td class="num">${dinero(venta.pago)}</td></tr>
           <tr><td>Su cambio</td><td class="num">${dinero(venta.cambio)}</td></tr>`
        : `<tr><td>Forma de pago</td><td class="num">${venta.forma_pago}</td></tr>`}
      ${venta.cliente ? `<tr><td>Cliente</td><td class="num">${escaparHtml(venta.cliente)}</td></tr>` : ''}
    </table>
    <hr>
    <div class="centro">¡Gracias por su compra!</div>
  `;
  window.print();
  cerrarModal();
}

// ---------- Botones y teclas de la venta ----------
document.getElementById('boton-cobrar').addEventListener('click', abrirCobro);
document.getElementById('boton-buscar').addEventListener('click', abrirBusquedaProducto);
document.getElementById('boton-cancelar-venta').addEventListener('click', cancelarVenta);

document.addEventListener('keydown', (e) => {
  const ventaActiva = document.getElementById('seccion-venta').classList.contains('activa');
  if (!ventaActiva || hayModalAbierto()) return;
  if (e.key === 'F3') { e.preventDefault(); abrirBusquedaProducto(); }
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
