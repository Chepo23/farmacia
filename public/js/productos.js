// Catálogo de productos e inventario multi-sucursal
const Productos = { lista: [] };

function pintarEncabezadoProductos() {
  document.getElementById('encabezado-productos').innerHTML = `<tr>
    <th>Código</th><th>Descripción</th><th class="num">Costo</th><th class="num">Precio</th>
    ${App.sucursales.map((s) => `<th class="num" title="Existencia en ${escaparHtml(s.nombre)}">${escaparHtml(s.nombre)}</th>`).join('')}
    <th></th>
  </tr>`;
}

async function cargarProductos() {
  const q = document.getElementById('buscar-productos').value;
  Productos.lista = await api('/api/productos?q=' + encodeURIComponent(q));
  pintarEncabezadoProductos();
  document.getElementById('cuerpo-productos').innerHTML = Productos.lista
    .map((p) => {
      const celdas = App.sucursales
        .map((s) => {
          const e = p.existencias.find((x) => x.sucursal_id === s.id) || { existencia: 0, minimo: 0 };
          const bajo = p.usa_inventario && e.minimo > 0 && e.existencia <= e.minimo;
          return `<td class="num ${bajo ? 'texto-rojo' : ''}">${p.usa_inventario ? e.existencia : '—'}</td>`;
        })
        .join('');
      return `<tr>
        <td>${escaparHtml(p.codigo_barras || '')}</td>
        <td>${escaparHtml(p.descripcion)}</td>
        <td class="num">${dinero(p.precio_costo)}</td>
        <td class="num">${dinero(p.precio_venta)}</td>
        ${celdas}
        <td style="white-space:nowrap">
          <button class="boton chico" data-accion="inventario" data-id="${p.id}">Inventario</button>
          <button class="boton chico" data-accion="editar" data-id="${p.id}">Editar</button>
          <button class="boton chico peligro-suave" data-accion="eliminar" data-id="${p.id}">✕</button>
        </td>
      </tr>`;
    })
    .join('');
}

function formularioProducto(p = {}) {
  const esNuevo = !p.id;
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo producto' : 'Editar producto'}</h3>
    <div class="fila">
      <label>Código de barras
        <input type="text" id="prod-codigo" value="${escaparHtml(p.codigo_barras || '')}" placeholder="Escanéalo aquí">
      </label>
      <label>Departamento
        <input type="text" id="prod-departamento" value="${escaparHtml(p.departamento || '')}" placeholder="Ej. Analgésicos">
      </label>
    </div>
    <label>Descripción
      <input type="text" id="prod-descripcion" value="${escaparHtml(p.descripcion || '')}" placeholder="Ej. Paracetamol 500mg c/10 tabs">
    </label>
    <div class="fila">
      <label>Precio de costo <input type="number" id="prod-costo" step="0.01" min="0" value="${p.precio_costo ?? ''}"></label>
      <label>Precio de venta <input type="number" id="prod-venta" step="0.01" min="0" value="${p.precio_venta ?? ''}"></label>
    </div>
    <div class="fila">
      <label>Precio de mayoreo (opcional) <input type="number" id="prod-mayoreo" step="0.01" min="0" value="${p.precio_mayoreo ?? ''}"></label>
      <label>A partir de (piezas) <input type="number" id="prod-cant-mayoreo" step="any" min="0" value="${p.cantidad_mayoreo ?? ''}"></label>
    </div>
    <label style="flex-direction:row; align-items:center; gap:8px">
      <input type="checkbox" id="prod-inventario" ${p.usa_inventario === 0 ? '' : 'checked'} style="width:auto">
      Controlar inventario de este producto
    </label>
    <div id="prod-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="prod-cancelar">Cancelar</button>
      <button class="boton exito" id="prod-guardar">Guardar</button>
    </div>
  `);

  modal.querySelector('#prod-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#prod-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#prod-error');
    errorEl.hidden = true;
    try {
      await api(esNuevo ? '/api/productos' : '/api/productos/' + p.id, {
        method: esNuevo ? 'POST' : 'PUT',
        body: {
          codigo_barras: modal.querySelector('#prod-codigo').value,
          descripcion: modal.querySelector('#prod-descripcion').value,
          departamento: modal.querySelector('#prod-departamento').value,
          precio_costo: modal.querySelector('#prod-costo').value,
          precio_venta: modal.querySelector('#prod-venta').value,
          precio_mayoreo: modal.querySelector('#prod-mayoreo').value,
          cantidad_mayoreo: modal.querySelector('#prod-cant-mayoreo').value,
          usa_inventario: modal.querySelector('#prod-inventario').checked,
        },
      });
      cerrarModal();
      aviso('Producto guardado', 'exito');
      cargarProductos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function formularioInventario(p) {
  const local = p.existencias.find((e) => e.sucursal_id === App.usuario.sucursal_id) || { existencia: 0, minimo: 0 };
  const otras = p.existencias.filter((e) => e.sucursal_id !== App.usuario.sucursal_id);
  const modal = abrirModal(`
    <h3>Inventario — ${escaparHtml(p.descripcion)}</h3>
    <p>Existencia en <b>${escaparHtml(App.usuario.sucursal)}</b>: <b>${local.existencia}</b></p>
    ${otras.length ? `<p>Otras sucursales: ${otras.map((e) => `${escaparHtml(e.sucursal)}: <b>${e.existencia}</b>`).join(' · ')}</p>` : ''}
    <div class="fila">
      <label>Movimiento
        <select id="inv-tipo">
          <option value="entrada">Entrada (llegó mercancía)</option>
          <option value="salida">Salida (merma, caducado)</option>
          <option value="ajuste">Ajuste (fijar existencia exacta)</option>
        </select>
      </label>
      <label>Cantidad <input type="number" id="inv-cantidad" step="any" min="0"></label>
      <label>Mínimo para avisar <input type="number" id="inv-minimo" step="any" min="0" value="${local.minimo}"></label>
    </div>
    <label>Nota (opcional) <input type="text" id="inv-nota" placeholder="Ej. Pedido proveedor X"></label>
    <div id="inv-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="inv-cancelar">Cancelar</button>
      <button class="boton exito" id="inv-guardar">Aplicar</button>
    </div>
  `);
  modal.querySelector('#inv-cantidad').focus();
  modal.querySelector('#inv-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#inv-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#inv-error');
    errorEl.hidden = true;
    try {
      await api(`/api/productos/${p.id}/inventario`, {
        method: 'POST',
        body: {
          tipo: modal.querySelector('#inv-tipo').value,
          cantidad: modal.querySelector('#inv-cantidad').value,
          minimo: modal.querySelector('#inv-minimo').value,
          nota: modal.querySelector('#inv-nota').value,
        },
      });
      cerrarModal();
      aviso('Inventario actualizado', 'exito');
      cargarProductos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

async function mostrarBajoMinimo() {
  const filas = await api('/api/productos/bajo-minimo');
  abrirModal(`
    <h3>Productos bajo mínimo — ${escaparHtml(App.usuario.sucursal)}</h3>
    ${filas.length === 0 ? '<p>Ningún producto está por debajo de su mínimo. 👍</p>' : `
    <div class="contenedor-tabla">
      <table class="tabla">
        <thead><tr><th>Código</th><th>Descripción</th><th class="num">Existencia</th><th class="num">Mínimo</th></tr></thead>
        <tbody>${filas
          .map((f) => `<tr><td>${escaparHtml(f.codigo_barras || '')}</td><td>${escaparHtml(f.descripcion)}</td>
            <td class="num texto-rojo">${f.existencia}</td><td class="num">${f.minimo}</td></tr>`)
          .join('')}</tbody>
      </table>
    </div>`}
    <div class="pie"><button class="boton" onclick="cerrarModal()">Cerrar</button></div>
  `);
}

document.getElementById('boton-nuevo-producto').addEventListener('click', () => formularioProducto());
document.getElementById('boton-bajo-minimo').addEventListener('click', mostrarBajoMinimo);

let temporizadorBusquedaProductos = null;
document.getElementById('buscar-productos').addEventListener('input', () => {
  clearTimeout(temporizadorBusquedaProductos);
  temporizadorBusquedaProductos = setTimeout(cargarProductos, 250);
});

document.getElementById('cuerpo-productos').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const producto = Productos.lista.find((p) => p.id === Number(boton.dataset.id));
  if (!producto) return;
  if (boton.dataset.accion === 'editar') formularioProducto(producto);
  if (boton.dataset.accion === 'inventario') formularioInventario(producto);
  if (boton.dataset.accion === 'eliminar') {
    if (confirm(`¿Eliminar el producto "${producto.descripcion}"?`)) {
      await api('/api/productos/' + producto.id, { method: 'DELETE' });
      aviso('Producto eliminado');
      cargarProductos();
    }
  }
});

App.alMostrarSeccion.productos = cargarProductos;
