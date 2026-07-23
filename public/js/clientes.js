// Clientes y crédito (fiado)
const Clientes = { lista: [] };

async function cargarClientes() {
  const q = document.getElementById('buscar-clientes').value;
  Clientes.lista = await api('/api/clientes?q=' + encodeURIComponent(q));
  document.getElementById('cuerpo-clientes').innerHTML = Clientes.lista
    .map(
      (c) => `<tr>
        <td>${escaparHtml(c.nombre)}</td>
        <td>${escaparHtml(c.telefono)}</td>
        <td>${escaparHtml(c.sucursal)}</td>
        <td class="${c.credito_autorizado ? 'texto-verde' : 'texto-rojo'}">${c.credito_autorizado ? 'Sí' : 'No'}</td>
        <td class="num">${c.limite_credito > 0 ? dinero(c.limite_credito) : 'Sin límite'}</td>
        <td class="num ${c.saldo > 0 ? 'texto-rojo' : ''}">${dinero(c.saldo)}</td>
        <td style="white-space:nowrap">
          <button class="boton chico" data-accion="estado" data-id="${c.id}">Estado de cuenta</button>
          <button class="boton chico" data-accion="editar" data-id="${c.id}">Editar</button>
        </td>
      </tr>`
    )
    .join('');
}

function formularioCliente(c = {}) {
  const esNuevo = !c.id;
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo cliente' : 'Editar cliente'}</h3>
    <label>Nombre <input type="text" id="cli-nombre" value="${escaparHtml(c.nombre || '')}"></label>
    <div class="fila">
      <label>Teléfono <input type="text" id="cli-telefono" value="${escaparHtml(c.telefono || '')}"></label>
      <label>Límite de crédito (0 = sin límite) <input type="number" id="cli-limite" step="0.01" min="0" value="${c.limite_credito ?? 0}"></label>
    </div>
    <label>Notas
      <textarea id="cli-notas" rows="3" placeholder="Observaciones sobre el cliente…">${escaparHtml(c.notas || '')}</textarea>
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
  const c = await api(`/api/clientes/${clienteId}/estado`);
  const modal = abrirModal(`
    <h3>Estado de cuenta — ${escaparHtml(c.nombre)}</h3>
    <div class="tarjetas-resumen">
      <div class="tarjeta-dato"><small>Debe</small><b class="${c.saldo > 0 ? 'texto-rojo' : ''}">${dinero(c.saldo)}</b></div>
      <div class="tarjeta-dato"><small>Límite</small><b>${c.limite_credito > 0 ? dinero(c.limite_credito) : 'Sin límite'}</b></div>
    </div>
    <div class="fila">
      <label>Abonar <input type="number" id="abono-monto" step="0.01" min="0" placeholder="0.00"></label>
      <label>Nota <input type="text" id="abono-nota" placeholder="Opcional"></label>
      <button class="boton exito" id="abono-guardar" style="align-self:flex-end">Registrar abono</button>
    </div>
    <div id="abono-error" class="mensaje-error" hidden></div>
    <div class="fila">
      <div style="flex:1.4">
        <h4>Compras a crédito</h4>
        <div class="contenedor-tabla">
          <table class="tabla"><thead><tr><th>Fecha</th><th class="num">Folio</th><th>Productos</th><th class="num">Total</th></tr></thead>
          <tbody>${c.cargos
            .map(
              (v) => `<tr>
                <td>${escaparHtml(v.fecha)}</td>
                <td class="num">${v.folio}</td>
                <td>${v.partidas.map((p) => `${p.cantidad} x ${escaparHtml(p.descripcion)} (${dinero(p.importe)})`).join('<br>')}</td>
                <td class="num">${dinero(v.total)}</td>
              </tr>`
            )
            .join('') || '<tr><td colspan="4">Sin compras a crédito</td></tr>'}</tbody></table>
        </div>
      </div>
      <div style="flex:1">
        <h4>Abonos</h4>
        <div class="contenedor-tabla">
          <table class="tabla"><thead><tr><th>Fecha</th><th class="num">Monto</th></tr></thead>
          <tbody>${c.abonos.map((a) => `<tr><td>${escaparHtml(a.fecha)}</td><td class="num">${dinero(a.monto)}</td></tr>`).join('') || '<tr><td colspan="2">Sin abonos</td></tr>'}</tbody></table>
        </div>
      </div>
    </div>
    <div class="pie">
      <button class="boton primario" id="estado-imprimir"><svg class="icono"><use href="#i-imprimir"/></svg>Imprimir estado de cuenta</button>
      <button class="boton" onclick="cerrarModal()">Cerrar</button>
    </div>
  `);
  modal.querySelector('#estado-imprimir').addEventListener('click', () => imprimirEstadoDeCuenta(c));
  modal.querySelector('#abono-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#abono-error');
    errorEl.hidden = true;
    try {
      await api(`/api/clientes/${clienteId}/abonos`, {
        method: 'POST',
        body: {
          monto: modal.querySelector('#abono-monto').value,
          nota: modal.querySelector('#abono-nota').value,
        },
      });
      aviso('Abono registrado', 'exito');
      cargarClientes();
      estadoDeCuenta(clienteId);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// Imprime el estado de cuenta del cliente en formato de ticket
function imprimirEstadoDeCuenta(c) {
  const ticket = document.getElementById('ticket');
  ticket.innerHTML = `
    <h4>ESTADO DE CUENTA</h4>
    <div class="centro">${escaparHtml(App.usuario.sucursal)}</div>
    <div class="centro">${new Date().toLocaleString('es-MX')}</div>
    <hr>
    <table>
      <tr><td>Cliente</td><td class="num">${escaparHtml(c.nombre)}</td></tr>
      ${c.telefono ? `<tr><td>Teléfono</td><td class="num">${escaparHtml(c.telefono)}</td></tr>` : ''}
      <tr><td>Límite de crédito</td><td class="num">${c.limite_credito > 0 ? dinero(c.limite_credito) : 'Sin límite'}</td></tr>
      <tr class="total"><td>SALDO PENDIENTE</td><td class="num">${dinero(c.saldo)}</td></tr>
    </table>
    <hr>
    <div>COMPRAS A CRÉDITO:</div>
    ${c.cargos
      .map(
        (v) => `
        <div>${escaparHtml(v.fecha)} — Folio ${v.folio}</div>
        <table>
          ${v.partidas.map((p) => `<tr><td>${p.cantidad} x ${escaparHtml(p.descripcion)}</td><td class="num">${dinero(p.importe)}</td></tr>`).join('')}
          <tr class="total"><td>Total</td><td class="num">${dinero(v.total)}</td></tr>
        </table>`
      )
      .join('<hr>') || '<div>Sin compras a crédito</div>'}
    <hr>
    <div>ABONOS:</div>
    <table>
      ${c.abonos.map((a) => `<tr><td>${escaparHtml(a.fecha)}</td><td class="num">${dinero(a.monto)}</td></tr>`).join('') || '<tr><td>Sin abonos</td></tr>'}
    </table>
    <hr>
    <div class="centro">Documento informativo — no es comprobante fiscal</div>
  `;
  window.print();
}

document.getElementById('boton-nuevo-cliente').addEventListener('click', () => formularioCliente());

let temporizadorBusquedaClientes = null;
document.getElementById('buscar-clientes').addEventListener('input', () => {
  clearTimeout(temporizadorBusquedaClientes);
  temporizadorBusquedaClientes = setTimeout(cargarClientes, 250);
});

document.getElementById('cuerpo-clientes').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const cliente = Clientes.lista.find((c) => c.id === Number(boton.dataset.id));
  if (!cliente) return;
  if (boton.dataset.accion === 'editar') formularioCliente(cliente);
  if (boton.dataset.accion === 'estado') estadoDeCuenta(cliente.id);
});

App.alMostrarSeccion.clientes = cargarClientes;
