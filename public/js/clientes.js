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
