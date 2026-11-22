// Clientes y crédito (fiado)
const Clientes = { lista: [] };

async function cargarClientes() {
  const q = document.getElementById('buscar-clientes').value;
  try {
    Clientes.lista = await api('/api/clientes?q=' + encodeURIComponent(q));
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  document.getElementById('cuerpo-clientes').innerHTML = Clientes.lista
    .map(
      (c) => `<tr>
        <td>${escaparHtml(c.nombre)}${c.notas ? `<br><small class="texto-suave">${escaparHtml(c.notas)}</small>` : ''}</td>
        <td>${escaparHtml(c.telefono)}</td>
        <td>${escaparHtml(c.sucursal)}</td>
        <td class="${c.credito_autorizado ? 'texto-verde' : 'texto-rojo'}">${c.credito_autorizado ? 'Sí' : 'No'}</td>
        <td class="num">${c.limite_credito > 0 ? `${dinero(c.limite_credito)}<br><small>disponible ${dinero(c.credito_disponible)}</small>` : 'Sin límite'}</td>
        <td class="num ${c.saldo > 0 ? 'texto-rojo' : ''}">${dinero(c.saldo)}</td>
        <td style="white-space:nowrap">
          <button class="boton chico primario" data-accion="estado" data-id="${c.id}">Estado de cuenta</button>
          <button class="boton chico ${c.prestamos_pendientes ? 'advertencia' : ''}" data-accion="prestamos" data-id="${c.id}"
            title="Medicamento prestado (por ejemplo, a otra farmacia)">Préstamos${c.prestamos_pendientes ? ` (${c.prestamos_pendientes})` : ''}</button>
          <button class="boton chico" data-accion="editar" data-id="${c.id}">Editar</button>
          <button class="boton chico peligro-suave" data-accion="baja" data-id="${c.id}" title="Dar de baja"><svg class="icono"><use href="#i-basura"/></svg></button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="7" class="vacio">No hay clientes registrados.</td></tr>';
}

function formularioCliente(c = {}) {
  const esNuevo = !c.id;
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo cliente' : 'Editar cliente'}</h3>
    <label>Nombre <input type="text" id="cli-nombre" value="${escaparHtml(c.nombre || '')}" maxlength="120"></label>
    <div class="fila">
      <label>Teléfono <input type="text" id="cli-telefono" value="${escaparHtml(c.telefono || '')}" maxlength="40"></label>
      <label>Límite de crédito (0 = sin límite) <input type="number" id="cli-limite" step="0.01" min="0" value="${c.limite_credito ?? 0}"></label>
    </div>
    <label>Notas
      <textarea id="cli-notas" rows="3" placeholder="Observaciones sobre el cliente…" maxlength="500">${escaparHtml(c.notas || '')}</textarea>
    </label>
    <label style="flex-direction:row; align-items:center; gap:8px">
      <input type="checkbox" id="cli-credito" ${c.credito_autorizado ? 'checked' : ''} style="width:auto">
      Crédito autorizado (puede comprar fiado)
    </label>
    <div id="cli-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="cli-cancelar">Cancelar</button>
      <button class="boton exito" id="cli-guardar">Guardar</button>
    </div>
  `);
  modal.querySelector('#cli-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#cli-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#cli-error');
    errorEl.hidden = true;
    try {
      await api(esNuevo ? '/api/clientes' : '/api/clientes/' + c.id, {
        method: esNuevo ? 'POST' : 'PUT',
        body: {
          nombre: modal.querySelector('#cli-nombre').value,
          telefono: modal.querySelector('#cli-telefono').value,
          limite_credito: modal.querySelector('#cli-limite').value,
          notas: modal.querySelector('#cli-notas').value,
          credito_autorizado: modal.querySelector('#cli-credito').checked,
        },
      });
      cerrarModal();
      aviso('Cliente guardado', 'exito');
      cargarClientes();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

async function estadoDeCuenta(clienteId) {
  let c;
  try {
    c = await api(`/api/clientes/${clienteId}/estado`);
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  // Más reciente arriba en pantalla; el impreso va en orden cronológico
  const movimientos = [...c.movimientos].reverse();
  const modal = abrirModal(`
    <h3>Estado de cuenta — ${escaparHtml(c.nombre)}</h3>
    <div class="tarjetas-resumen">
      <div class="tarjeta-dato"><small>Debe</small><b class="${c.saldo > 0 ? 'texto-rojo' : ''}">${dinero(c.saldo)}</b></div>
      <div class="tarjeta-dato"><small>Límite</small><b>${c.limite_credito > 0 ? dinero(c.limite_credito) : 'Sin límite'}</b></div>
      <div class="tarjeta-dato"><small>Disponible</small><b>${c.credito_disponible != null ? dinero(c.credito_disponible) : 'Sin límite'}</b></div>
      <div class="tarjeta-dato"><small>Total abonado</small><b>${dinero(c.total_abonos)}</b></div>
    </div>
    ${c.saldo > 0 ? `
    <div class="fila">
      <label>Abonar ($) <input type="number" id="abono-monto" step="0.01" min="0" max="${c.saldo}" placeholder="0.00"></label>
      <label>Forma de pago
        <select id="abono-forma"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option></select>
      </label>
      <label>Nota <input type="text" id="abono-nota" placeholder="Opcional" maxlength="200"></label>
    </div>
    <div class="acciones">
      <button class="boton" id="abono-todo">Liquidar todo (${dinero(c.saldo)})</button>
      <button class="boton exito" id="abono-guardar"><svg class="icono"><use href="#i-imprimir"/></svg>Registrar abono e imprimir comprobante</button>
    </div>` : '<div class="franja-aviso info">El cliente no tiene saldo pendiente.</div>'}
    <div id="abono-error" class="mensaje-error" hidden></div>
    <div class="contenedor-tabla estado-cuenta-tabla">
      <table class="tabla">
        <thead><tr><th>Fecha</th><th>Concepto</th><th class="num">Cargo</th><th class="num">Abono</th><th class="num">Saldo</th><th></th></tr></thead>
        <tbody>${movimientos.map((m) => `<tr class="${m.tipo === 'abono' ? 'fila-abono' : ''}">
          <td style="white-space:nowrap">${escaparHtml(m.fecha)}</td>
          <td>${escaparHtml(m.concepto)}${m.partidas ? `<span class="partidas-cargo">${m.partidas.map((p) => `${p.cantidad} × ${escaparHtml(p.descripcion)} (${dinero(p.importe)})`).join(' · ')}</span>` : ''}</td>
          <td class="num">${m.cargo ? dinero(m.cargo) : ''}</td>
          <td class="num">${m.abono ? dinero(m.abono) : ''}</td>
          <td class="num"><b>${dinero(m.saldo)}</b></td>
          <td>${m.abono_id ? `<button class="boton chico" data-abono="${m.abono_id}" title="Reimprimir comprobante"><svg class="icono"><use href="#i-imprimir"/></svg></button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="vacio">Sin compras a crédito ni abonos</td></tr>'}</tbody>
      </table>
    </div>
    <div class="pie">
      <button class="boton" id="estado-ticket"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir en ticket</button>
      <button class="boton primario" id="estado-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir en hoja carta</button>
      <button class="boton" onclick="cerrarModal()">Cerrar</button>
    </div>
  `);
  modal.classList.add('grande');
  modal.querySelector('#estado-imprimir').addEventListener('click', () => Impresion.imprimirEstadoCuenta(c, 'carta'));
  modal.querySelector('#estado-ticket').addEventListener('click', () => Impresion.imprimirEstadoCuenta(c, 'ticket'));
  modal.querySelectorAll('button[data-abono]').forEach((boton) => {
    boton.addEventListener('click', async () => {
      try {
        Impresion.imprimirAbono(await api(`/api/clientes/${clienteId}/abonos/${boton.dataset.abono}`));
      } catch (err) {
        aviso(err.message, 'error');
      }
    });
  });
  modal.querySelector('#abono-todo')?.addEventListener('click', () => {
    modal.querySelector('#abono-monto').value = c.saldo.toFixed(2);
    modal.querySelector('#abono-monto').focus();
  });
  modal.querySelector('#abono-guardar')?.addEventListener('click', async () => {
    const errorEl = modal.querySelector('#abono-error');
    errorEl.hidden = true;
    try {
      const r = await api(`/api/clientes/${clienteId}/abonos`, {
        method: 'POST',
        body: {
          monto: modal.querySelector('#abono-monto').value,
          forma_pago: modal.querySelector('#abono-forma').value,
          nota: modal.querySelector('#abono-nota').value,
        },
      });
      aviso(`Abono de ${dinero(r.abono.monto)} registrado. Saldo: ${dinero(r.abono.saldo_nuevo)}`, 'exito');
      cargarClientes();
      await Impresion.imprimirAbono(r.abono);
      estadoDeCuenta(clienteId);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------- Préstamos de medicamento (por ejemplo, a farmacias que no son del jefe) ----------
// Prestar saca la mercancía del inventario; "Regresaron" la vuelve a meter; "Lo van a pagar" la cobra
// en la caja (a costo, o al precio que se acuerde) sin volver a sacarla del inventario.
function tarjetaPrestamo(p) {
  const pendiente = p.estado === 'pendiente';
  return `<div class="tarjeta-prestamo ${pendiente ? '' : 'cerrado'}">
    <div class="fila-prestamo"><b>P-${p.folio}</b><span>${escaparHtml(fechaHora(p.fecha))} · prestó ${escaparHtml(p.usuario)}${p.nota ? ` · ${escaparHtml(p.nota)}` : ''}</span>
      ${pendiente ? `<span class="chip pendiente">Falta ${p.piezas_pendientes} pza(s) · ${dinero(p.valor_pendiente)} a costo</span>` : '<span class="chip ok">Cerrado</span>'}</div>
    <table class="tabla"><thead><tr><th>Producto</th><th class="num">Prestado</th><th class="num">Regresaron</th><th class="num">Pagaron</th><th class="num">Falta</th></tr></thead>
      <tbody>${p.renglones.map((d) => `<tr><td>${escaparHtml(d.descripcion)}</td><td class="num">${d.cantidad}</td><td class="num">${d.devuelto || '—'}</td>
        <td class="num">${d.cobrado || '—'}</td><td class="num"><b>${d.pendiente || '—'}</b></td></tr>`).join('')}</tbody></table>
    ${pendiente ? `<div class="acciones"><button class="boton" data-devolver="${p.id}">Regresaron</button>
      <button class="boton exito" data-cobrar="${p.id}">Lo van a pagar</button></div>` : ''}
  </div>`;
}

async function abrirPrestamos(cliente) {
  let lista = [];
  try {
    lista = await api(`/api/prestamos?cliente_id=${cliente.id}`);
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  const pendientes = lista.filter((p) => p.estado === 'pendiente');
  const cerrados = lista.filter((p) => p.estado !== 'pendiente');
  const modal = abrirModal(`
    <h3>Préstamos · ${escaparHtml(cliente.nombre)}</h3>
    <p>Lo que se lleva prestado sale del inventario. Cuando lo regresan vuelve a entrar; si mejor lo pagan, se cobra en la caja (a costo o al precio que acuerden) sin volver a sacarlo.</p>
    <div class="acciones"><button class="boton primario" id="pre-nuevo"><svg class="icono"><use href="#i-mas"/></svg>Prestar medicamento</button></div>
    <h4>Pendientes (${pendientes.length})</h4>
    ${pendientes.map(tarjetaPrestamo).join('') || '<p class="vacio">No tiene préstamos pendientes.</p>'}
    ${cerrados.length ? `<details class="prestamos-cerrados"><summary>Ya cerrados (${cerrados.length})</summary>${cerrados.map(tarjetaPrestamo).join('')}</details>` : ''}
    <div class="pie"><button class="boton" id="pre-cerrar">Cerrar (Esc)</button></div>
  `);
  modal.classList.add('grande');
  modal.querySelector('#pre-cerrar').addEventListener('click', () => { cerrarModal(); cargarClientes(); });
  modal.querySelector('#pre-nuevo').addEventListener('click', () => nuevoPrestamo(cliente));
  modal.addEventListener('click', (e) => {
    const devolver = e.target.closest('[data-devolver]');
    if (devolver) devolverPrestamo(lista.find((p) => p.id === Number(devolver.dataset.devolver)), cliente);
    const cobrar = e.target.closest('[data-cobrar]');
    if (cobrar) cobrarPrestamo(lista.find((p) => p.id === Number(cobrar.dataset.cobrar)), cliente);
  });
}

function nuevoPrestamo(cliente) {
  const renglones = [];
  let resultados = [];
  const modal = abrirModal(`
    <h3>Prestar medicamento · ${escaparHtml(cliente.nombre)}</h3>
    <input type="text" id="pre-buscar" class="entrada" placeholder="Escanea el código o escribe el nombre y presiona Enter…" autocomplete="off">
    <div class="resultados-busqueda" id="pre-resultados-caja" hidden><table class="tabla"><tbody id="pre-resultados"></tbody></table></div>
    <div class="resultados-busqueda"><table class="tabla">
      <thead><tr><th>Se lleva</th><th class="num">Hay</th><th class="num">Cantidad</th><th></th></tr></thead>
      <tbody id="pre-renglones"></tbody></table></div>
    <label>Nota (opcional) <input type="text" id="pre-nota" maxlength="300" placeholder="Ej. Lo regresan el viernes"></label>
    <div id="pre-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="pre-cancelar">Cancelar (Esc)</button>
      <button class="boton exito" id="pre-prestar">Prestar (sale del inventario)</button>
    </div>
  `);
  modal.classList.add('grande');
  const errorEl = modal.querySelector('#pre-error');
  const mostrarError = (texto) => { errorEl.textContent = texto; errorEl.hidden = !texto; };
  function pintar() {
    modal.querySelector('#pre-renglones').innerHTML = renglones.map((r, k) => `<tr>
      <td>${escaparHtml(r.producto.descripcion)}</td><td class="num">${r.producto.existencia_local ?? '—'}</td>
      <td class="num"><input type="number" class="pre-cantidad" data-k="${k}" min="0.01" step="any" value="${r.cantidad}" style="width:90px" aria-label="Cantidad"></td>
      <td><button class="boton-quitar" data-quitar="${k}" title="Quitar"><svg class="icono"><use href="#i-x"/></svg></button></td></tr>`).join('')
      || '<tr><td colspan="4" class="vacio">Escanea o busca lo que se lleva prestado.</td></tr>';
  }
  function agregar(p) {
    mostrarError('');
    if (!p.usa_inventario || p.es_coctel) {
      mostrarError(`"${p.descripcion}" no lleva inventario: no se presta`);
      return;
    }
    const r = renglones.find((x) => x.producto.id === p.id);
    if (r) r.cantidad = Math.round((r.cantidad + 1) * 1000) / 1000;
    else renglones.push({ producto: p, cantidad: 1 });
    modal.querySelector('#pre-resultados-caja').hidden = true;
    pintar();
  }
  async function buscar() {
    const entrada = modal.querySelector('#pre-buscar');
    const texto = entrada.value.trim();
    if (!texto) return;
    mostrarError('');
    try {
      agregar(await api('/api/productos/codigo/' + encodeURIComponent(texto)));
      entrada.value = '';
      return;
    } catch (err) {
      if (err.status !== 404) { mostrarError(err.message); return; }
    }
    try {
      resultados = await api('/api/productos/buscar?q=' + encodeURIComponent(texto));
    } catch (err) {
      mostrarError(err.message);
      return;
    }
    modal.querySelector('#pre-resultados').innerHTML = resultados.map((p, k) => `<tr class="fila-clic" data-resultado="${k}">
      <td>${escaparHtml(p.descripcion)}${p.codigo_barras ? `<br><small>${escaparHtml(p.codigo_barras)}</small>` : ''}</td>
      <td class="num">${p.usa_inventario ? p.existencia_local ?? '' : '—'}</td></tr>`).join('') || '<tr><td class="vacio">Sin resultados</td></tr>';
    modal.querySelector('#pre-resultados-caja').hidden = false;
  }
  modal.querySelector('#pre-buscar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscar(); }
  });
  modal.querySelector('#pre-resultados').addEventListener('click', (e) => {
    const fila = e.target.closest('tr[data-resultado]');
    if (fila) {
      agregar(resultados[Number(fila.dataset.resultado)]);
      modal.querySelector('#pre-buscar').value = '';
      modal.querySelector('#pre-buscar').focus();
    }
  });
  modal.querySelector('#pre-renglones').addEventListener('change', (e) => {
    if (!e.target.classList.contains('pre-cantidad')) return;
    const r = renglones[Number(e.target.dataset.k)];
    const valor = Number(e.target.value);
    if (r && valor > 0) r.cantidad = Math.round(valor * 1000) / 1000;
    pintar();
  });
  modal.querySelector('#pre-renglones').addEventListener('click', (e) => {
    const quitar = e.target.closest('[data-quitar]');
    if (quitar) {
      renglones.splice(Number(quitar.dataset.quitar), 1);
      pintar();
    }
  });
  modal.querySelector('#pre-cancelar').addEventListener('click', () => abrirPrestamos(cliente));
  modal.querySelector('#pre-prestar').addEventListener('click', async () => {
    if (!renglones.length) {
      mostrarError('Agrega lo que se lleva prestado');
      return;
    }
    try {
      const p = await api('/api/prestamos', {
        method: 'POST',
        body: { cliente_id: cliente.id, nota: modal.querySelector('#pre-nota').value, partidas: renglones.map((r) => ({ producto_id: r.producto.id, cantidad: r.cantidad })) },
      });
      aviso(`Préstamo P-${p.folio} a ${cliente.nombre}: salió del inventario`, 'exito');
      if (p.avisoSincronizacion) aviso(p.avisoSincronizacion);
      abrirPrestamos(cliente);
    } catch (err) {
      mostrarError(err.message);
    }
  });
  pintar();
}

function devolverPrestamo(p, cliente) {
  const pendientes = p.renglones.filter((d) => d.pendiente > 0);
  const modal = abrirModal(`
    <h3>Regresaron · préstamo P-${p.folio}</h3>
    <p>Escribe cuánto regresó ${escaparHtml(cliente.nombre)} de cada producto: vuelve a entrar al inventario.</p>
    <table class="tabla"><thead><tr><th>Producto</th><th class="num">Falta</th><th class="num">Regresaron</th></tr></thead>
      <tbody>${pendientes.map((d) => `<tr><td>${escaparHtml(d.descripcion)}</td><td class="num">${d.pendiente}</td>
        <td class="num"><input type="number" class="pre-devuelto" data-detalle="${d.id}" min="0" max="${d.pendiente}" step="any" value="${d.pendiente}" style="width:90px" aria-label="Regresaron"></td></tr>`).join('')}</tbody></table>
    <div id="pre-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="pre-cancelar">Cancelar (Esc)</button>
      <button class="boton exito" id="pre-devolver">Regresar al inventario</button>
    </div>
  `);
  modal.querySelector('#pre-cancelar').addEventListener('click', () => abrirPrestamos(cliente));
  modal.querySelector('#pre-devolver').addEventListener('click', async () => {
    const renglones = [...modal.querySelectorAll('.pre-devuelto')]
      .map((x) => ({ detalle_id: Number(x.dataset.detalle), cantidad: Number(x.value) }))
      .filter((r) => r.cantidad > 0);
    const errorEl = modal.querySelector('#pre-error');
    if (!renglones.length) {
      errorEl.textContent = 'Escribe cuánto regresaron';
      errorEl.hidden = false;
      return;
    }
    try {
      const actualizado = await api(`/api/prestamos/${p.id}/devolver`, { method: 'POST', body: { renglones } });
      aviso(actualizado.estado === 'cerrado' ? `Préstamo P-${p.folio} completo: ya regresaron todo` : `Regresó al inventario; del P-${p.folio} falta ${actualizado.piezas_pendientes} pza(s)`, 'exito');
      abrirPrestamos(cliente);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// Lo van a pagar: pasa a un ticket de la caja, a costo (doble clic en el precio para cambiarlo)
async function cobrarPrestamo(p, cliente) {
  const pendientes = p.renglones.filter((d) => d.pendiente > 0);
  let frescos;
  try {
    frescos = new Map((await api(`/api/productos?ids=${pendientes.map((d) => d.producto_id).join(',')}`)).map((x) => [x.id, x]));
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  const fuera = pendientes.filter((d) => !frescos.get(d.producto_id));
  if (fuera.length) {
    aviso(`Ya no están en el catálogo: ${fuera.map((d) => d.descripcion).join(', ')}. Regístralos como regresados o cóbralos como artículo común.`, 'error');
    return;
  }
  cerrarModal();
  mostrarSeccion('venta');
  if (!ticketVacio(Venta) && !nuevoTicket()) return;
  Venta.nombre = cliente.nombre;
  Venta.clienteSugerido = cliente.id;
  Venta.carrito = pendientes.map((d) => {
    const producto = frescos.get(d.producto_id);
    const costo = Number(producto.precio_costo) || 0;
    return { producto, cantidad: d.pendiente, ...(costo > 0 ? { precioManual: costo } : {}), prestamo: { detalle_id: d.id, prestamo_id: p.id, folio: p.folio, pendiente: d.pendiente } };
  });
  Venta.filaSeleccionada = Venta.carrito.length - 1;
  pintarVenta();
  aviso(`Préstamo P-${p.folio}: va a costo (doble clic en el precio para cambiarlo). Cobra con F12; para fiado, elige Crédito.`, 'exito');
}

document.getElementById('boton-nuevo-cliente').addEventListener('click', () => formularioCliente());

let temporizadorBusquedaClientes = null;
document.getElementById('buscar-clientes').addEventListener('input', () => {
  clearTimeout(temporizadorBusquedaClientes);
  temporizadorBusquedaClientes = setTimeout(cargarClientes, 250);
});

document.getElementById('cuerpo-clientes').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const cliente = Clientes.lista.find((c) => c.id === Number(boton.dataset.id));
  if (!cliente) return;
  if (boton.dataset.accion === 'editar') formularioCliente(cliente);
  if (boton.dataset.accion === 'prestamos') abrirPrestamos(cliente);
  if (boton.dataset.accion === 'estado') estadoDeCuenta(cliente.id);
  if (boton.dataset.accion === 'baja') {
    const confirmado = await confirmar({
      titulo: 'Dar de baja al cliente',
      mensaje: `¿Dar de baja a "${cliente.nombre}"? Solo se puede si no debe nada. Su historial se conserva.`,
      boton: 'Dar de baja',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api('/api/clientes/' + cliente.id, { method: 'DELETE' });
      aviso('Cliente dado de baja', 'exito');
      cargarClientes();
    } catch (err) {
      aviso(err.message, 'error');
    }
  }
});

App.alMostrarSeccion.clientes = cargarClientes;
