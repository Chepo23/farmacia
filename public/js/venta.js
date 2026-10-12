// Pantalla de venta (estilo Eleventa)
const Venta = {
  carrito: [], // { producto, cantidad }
  filaSeleccionada: -1,
  mayoreo: false, // F11: cobrar con precio de mayoreo
};

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
function piezasDe(producto) {
  return Venta.carrito.filter((r) => r.producto.id === producto.id).reduce((t, r) => t + r.cantidad, 0);
}

// Mayoreo con F11, o automático al llegar a la cantidad de mayoreo del producto
function aplicaMayoreo(producto) {
  if (producto.comun || producto.precio_mayoreo == null) return false;
  if (Venta.mayoreo) return true;
  return Number(producto.cantidad_mayoreo) > 0 && piezasDe(producto) >= Number(producto.cantidad_mayoreo);
}

function precioUnitario(producto) {
  return aplicaMayoreo(producto) ? Number(producto.precio_mayoreo) : Number(producto.precio_venta);
}

function totalVenta() {
  return redondear2(Venta.carrito.reduce((suma, r) => suma + redondear2(precioUnitario(r.producto) * r.cantidad), 0));
}

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
      const mayoreo = aplicaMayoreo(r.producto);
      return `<tr data-indice="${i}" class="${i === Venta.filaSeleccionada ? 'seleccionado' : ''}">
        <td class="col-cant"><input type="number" class="cantidad" min="0.01" step="any" value="${r.cantidad}" data-indice="${i}" aria-label="Cantidad"></td>
        <td>${escaparHtml(r.producto.descripcion)}${mayoreo ? ' <span class="chip enviado">Mayoreo</span>' : ''}</td>
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
async function abrirCobro() {
  if (Venta.carrito.length === 0) {
    aviso('No hay artículos en la venta', 'error');
    return;
  }
  if (!App.apertura) {
    await pedirApertura();
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
      if (err.codigo === 'SIN_APERTURA') {
        App.apertura = null;
        cerrarModal();
        await pedirApertura();
        aviso('Caja abierta. Vuelve a cobrar la venta (F12).');
      }
    } finally {
      cobrando = false;
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

function mostrarVentaTerminada({ folio, cambio, inventarioPendiente, avisoSincronizacion }) {
  const modal = abrirModal(`
    <h3>Venta realizada — Folio ${folio}</h3>
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
