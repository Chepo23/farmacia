// Catálogo de productos e inventario multi-sucursal.
// Todas las existencias vienen del mismo inventario que usan Venta, Apoyos y Reportes.
const Productos = { lista: [] };

const ETIQUETA_MOVIMIENTO = {
  entrada: 'Entrada',
  salida: 'Salida',
  venta: 'Venta',
  ajuste: 'Ajuste',
};

function pintarEncabezadoProductos() {
  document.getElementById('encabezado-productos').innerHTML = `<tr>
    <th>Código</th><th>Descripción</th><th class="num">Costo</th><th class="num">Precio</th>
    ${App.sucursales.map((s) => `<th class="num" title="Existencia en ${escaparHtml(s.nombre)}">${escaparHtml(s.nombre)}</th>`).join('')}
    <th></th>
  </tr>`;
}

async function cargarProductos() {
  const q = document.getElementById('buscar-productos').value;
  try {
    Productos.lista = await api('/api/productos?q=' + encodeURIComponent(q));
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  pintarEncabezadoProductos();
  document.getElementById('cuerpo-productos').innerHTML = Productos.lista
    .map((p) => {
      const celdas = App.sucursales
        .map((s) => {
          const e = p.existencias.find((x) => x.sucursal_id === s.id) || { existencia: 0, minimo: 0 };
          const bajo = p.usa_inventario && e.minimo > 0 && e.existencia <= e.minimo;
          return `<td class="num ${bajo || (p.usa_inventario && e.existencia < 0) ? 'texto-rojo' : ''}" title="Mínimo: ${e.minimo}">${p.usa_inventario ? e.existencia : '—'}</td>`;
        })
        .join('');
      return `<tr>
        <td>${escaparHtml(p.codigo_barras || '')}</td>
        <td>${escaparHtml(p.descripcion)}${p.departamento ? `<br><small class="texto-suave">${escaparHtml(p.departamento)}</small>` : ''}</td>
        <td class="num">${dinero(p.precio_costo)}</td>
        <td class="num">${dinero(p.precio_venta)}${p.precio_mayoreo != null ? `<br><small title="Precio de mayoreo">${dinero(p.precio_mayoreo)}${p.cantidad_mayoreo ? ` desde ${p.cantidad_mayoreo}` : ''}</small>` : ''}</td>
        ${celdas}
        <td style="white-space:nowrap">
          ${p.usa_inventario ? `<button class="boton chico" data-accion="inventario" data-id="${p.id}">Inventario</button>` : ''}
          <button class="boton chico" data-accion="kardex" data-id="${p.id}" title="Historial de movimientos"><svg class="icono"><use href="#i-historial"/></svg>Historial</button>
          <button class="boton chico" data-accion="editar" data-id="${p.id}">Editar</button>
          ${App.usuario.rol === 'admin' ? '<button class="boton chico peligro-suave" data-accion="eliminar" data-id="' + p.id + '" title="Dar de baja"><svg class="icono"><use href="#i-basura"/></svg></button>' : ''}
        </td>
      </tr>`;
    })
    .join('') || `<tr><td colspan="${5 + App.sucursales.length}" class="vacio">No hay productos${q ? ' que coincidan con la búsqueda' : ''}.</td></tr>`;
}

async function formularioProducto(p = {}) {
  const esNuevo = !p.id;
  const departamentos = await api('/api/departamentos').catch(() => []);
  const esAdminCentral = App.usuario.rol === 'admin' && App.usuario.es_central === 1;
  const sucursalesInventario = esAdminCentral
    ? App.sucursales
    : App.sucursales.filter((s) => s.id === App.usuario.sucursal_id);
  // Si el producto trae un departamento que ya no está en la lista, se conserva como opción
  const nombres = departamentos.map((d) => d.nombre);
  if (p.departamento && !nombres.includes(p.departamento)) nombres.unshift(p.departamento);
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo producto' : 'Editar producto'}</h3>
    <div class="fila">
      <label>Código de barras
        <input type="text" id="prod-codigo" value="${escaparHtml(p.codigo_barras || '')}" placeholder="Escanéalo aquí" autocomplete="off">
      </label>
      <label>Departamento
        <select id="prod-departamento">
          <option value="">Sin departamento</option>
          ${nombres
            .map((n) => `<option value="${escaparHtml(n)}" ${n === p.departamento ? 'selected' : ''}>${escaparHtml(n)}</option>`)
            .join('')}
        </select>
      </label>
    </div>
    <label>Descripción
      <input type="text" id="prod-descripcion" value="${escaparHtml(p.descripcion || '')}" placeholder="Ej. Paracetamol 500mg c/10 tabs" maxlength="200">
    </label>
    ${esAdminCentral ? '' : '<div class="franja-aviso info">Los precios los fija el administrador de la central y se aplican en todas las sucursales.</div>'}
    <div class="fila">
      <label>Precio de costo <input type="number" id="prod-costo" step="0.01" min="0" value="${p.precio_costo ?? ''}" ${esAdminCentral ? '' : 'disabled'}></label>
      <label>Precio de venta <input type="number" id="prod-venta" step="0.01" min="0" value="${p.precio_venta ?? ''}" ${esAdminCentral ? '' : 'disabled'}></label>
    </div>
    <div class="fila">
      <label>Precio de mayoreo (opcional) <input type="number" id="prod-mayoreo" step="0.01" min="0" value="${p.precio_mayoreo ?? ''}" ${esAdminCentral ? '' : 'disabled'}></label>
      <label>A partir de (piezas) <input type="number" id="prod-cantidad-mayoreo" step="any" min="0" value="${p.cantidad_mayoreo ?? ''}" placeholder="Solo con F11 si se deja vacío" ${esAdminCentral ? '' : 'disabled'}></label>
    </div>
    <div id="prod-margen" class="dato-secundario"></div>
    ${esNuevo ? `<div class="fila">
      ${esAdminCentral ? `<label>Sucursal del inventario
        <select id="prod-sucursal">${sucursalesInventario.map((s) => `<option value="${s.id}" ${s.id === App.usuario.sucursal_id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('')}</select>
      </label>` : ''}
      <label>Existencia inicial
        <input type="number" id="prod-existencia" step="any" min="0" value="0">
      </label>
      <label>Mínimo inicial
        <input type="number" id="prod-minimo" step="any" min="0" value="0">
      </label>
    </div>` : ''}
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

  // Margen de ganancia mientras se capturan los precios
  const margen = () => {
    const costo = Number(modal.querySelector('#prod-costo').value) || 0;
    const venta = Number(modal.querySelector('#prod-venta').value) || 0;
    const el = modal.querySelector('#prod-margen');
    if (!(costo > 0 && venta > 0)) { el.innerHTML = ''; return; }
    const porcentaje = ((venta - costo) / costo) * 100;
    el.innerHTML = `<span>Ganancia por pieza</span><b class="${venta < costo ? 'texto-rojo' : ''}">${dinero(venta - costo)} (${porcentaje.toFixed(0)}%)</b>`;
  };
  modal.querySelector('#prod-costo').addEventListener('input', margen);
  modal.querySelector('#prod-venta').addEventListener('input', margen);
  margen();

  modal.querySelector('#prod-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#prod-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#prod-error');
    errorEl.hidden = true;
    try {
      const respuesta = await api(esNuevo ? '/api/productos' : '/api/productos/' + p.id, {
        method: esNuevo ? 'POST' : 'PUT',
        body: {
          codigo_barras: modal.querySelector('#prod-codigo').value,
          descripcion: modal.querySelector('#prod-descripcion').value,
          departamento: modal.querySelector('#prod-departamento').value,
          precio_costo: modal.querySelector('#prod-costo').value,
          precio_venta: modal.querySelector('#prod-venta').value,
          precio_mayoreo: modal.querySelector('#prod-mayoreo').value,
          cantidad_mayoreo: modal.querySelector('#prod-cantidad-mayoreo').value,
          usa_inventario: modal.querySelector('#prod-inventario').checked,
          sucursal_id: modal.querySelector('#prod-sucursal')?.value || App.usuario.sucursal_id,
          existencia_inicial: modal.querySelector('#prod-existencia')?.value || 0,
          minimo_inicial: modal.querySelector('#prod-minimo')?.value || 0,
        },
      });
      cerrarModal();
      aviso(respuesta.aviso || 'Producto guardado', respuesta.aviso ? 'error' : 'exito');
      cargarProductos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function formularioInventario(p) {
  const esAdminCentral = App.usuario.rol === 'admin' && App.usuario.es_central === 1;
  const sucursalesInventario = esAdminCentral
    ? App.sucursales
    : App.sucursales.filter((s) => s.id === App.usuario.sucursal_id);
  const sucursalInicial = App.usuario.sucursal_id;
  const buscarExistencia = (sucursalId) => p.existencias.find((e) => e.sucursal_id === Number(sucursalId)) || { existencia: 0, minimo: 0 };
  const local = buscarExistencia(sucursalInicial);
  const modal = abrirModal(`
    <h3>Inventario — ${escaparHtml(p.descripcion)}</h3>
    <div class="existencias-sucursales">
      ${p.existencias.map((e) => `<span>${escaparHtml(e.sucursal)}: <b>${e.existencia}</b></span>`).join('')}
    </div>
    ${esAdminCentral ? `<label>Sucursal
      <select id="inv-sucursal">${sucursalesInventario.map((s) => `<option value="${s.id}" ${s.id === Number(sucursalInicial) ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('')}</select>
    </label>` : ''}
    <p>Existencia actual: <b id="inv-existencia">${local.existencia}</b> · Mínimo: <b id="inv-minimo-actual">${local.minimo}</b></p>
    <div class="fila">
      <label>Movimiento
        <select id="inv-tipo">
          <option value="entrada">Entrada (llegó mercancía)</option>
          <option value="salida">Salida (merma, caducado, daño)</option>
          <option value="ajuste">Ajuste (conteo físico: fijar la existencia exacta)</option>
          <option value="minimo">Solo cambiar el mínimo</option>
        </select>
      </label>
      <label id="inv-etiqueta-cantidad">Cantidad <input type="number" id="inv-cantidad" step="any" min="0"></label>
      <label>Mínimo para avisar <input type="number" id="inv-minimo" step="any" min="0" value="${local.minimo}"></label>
    </div>
    <div id="inv-resultado" class="dato-secundario"></div>
    <label>Nota (opcional) <input type="text" id="inv-nota" placeholder="Ej. Factura 1234 del proveedor X" maxlength="300"></label>
    <div id="inv-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="inv-cancelar">Cancelar</button>
      <button class="boton exito" id="inv-guardar">Aplicar</button>
    </div>
  `);
  const selectorSucursal = modal.querySelector('#inv-sucursal');
  const tipo = modal.querySelector('#inv-tipo');
  const cantidad = modal.querySelector('#inv-cantidad');
  const actual = () => buscarExistencia(selectorSucursal ? selectorSucursal.value : sucursalInicial);

  // Muestra cómo quedará la existencia antes de aplicar
  function vistaPrevia() {
    const existencia = Number(actual().existencia) || 0;
    const n = Number(cantidad.value);
    modal.querySelector('#inv-etiqueta-cantidad').hidden = tipo.value === 'minimo';
    const el = modal.querySelector('#inv-resultado');
    if (tipo.value === 'minimo' || cantidad.value === '' || !Number.isFinite(n)) { el.innerHTML = ''; return; }
    const queda = tipo.value === 'entrada' ? existencia + n : tipo.value === 'salida' ? existencia - n : n;
    el.innerHTML = `<span>La existencia quedará en</span><b class="${queda < 0 ? 'texto-rojo' : ''}">${Math.round(queda * 100) / 100}</b>`;
  }
  tipo.addEventListener('change', vistaPrevia);
  cantidad.addEventListener('input', vistaPrevia);
  if (selectorSucursal) {
    selectorSucursal.addEventListener('change', () => {
      const existencia = actual();
      modal.querySelector('#inv-existencia').textContent = existencia.existencia;
      modal.querySelector('#inv-minimo-actual').textContent = existencia.minimo;
      modal.querySelector('#inv-minimo').value = existencia.minimo;
      vistaPrevia();
    });
  }
  cantidad.focus();
  modal.querySelector('#inv-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#inv-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#inv-error');
    errorEl.hidden = true;
    try {
      const soloMinimo = tipo.value === 'minimo';
      const r = await api(`/api/productos/${p.id}/inventario`, {
        method: 'POST',
        body: {
          tipo: soloMinimo ? '' : tipo.value,
          cantidad: soloMinimo ? '' : cantidad.value,
          minimo: modal.querySelector('#inv-minimo').value,
          nota: modal.querySelector('#inv-nota').value,
          sucursal_id: selectorSucursal ? selectorSucursal.value : App.usuario.sucursal_id,
        },
      });
      cerrarModal();
      aviso(`Inventario actualizado: existencia ${r.existencia}, mínimo ${r.minimo}`, 'exito');
      cargarProductos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------- Kardex: historial de movimientos de un producto ----------
async function mostrarKardex(p) {
  const modal = abrirModal(`
    <h3>Historial de movimientos — ${escaparHtml(p.descripcion)}</h3>
    <div class="kardex-filtros">
      <label>Sucursal
        <select id="kx-sucursal" class="entrada">
          <option value="">Todas</option>
          ${App.sucursales.map((s) => `<option value="${s.id}" ${s.id === App.usuario.sucursal_id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('')}
        </select>
      </label>
      <div class="existencias-sucursales" id="kx-existencias"></div>
    </div>
    <div class="resultados-busqueda">
      <table class="tabla">
        <thead><tr><th>Fecha</th><th>Sucursal</th><th>Movimiento</th><th class="num">Cantidad</th><th class="num">Quedó</th><th>Usuario</th><th>Nota</th></tr></thead>
        <tbody id="kx-cuerpo"><tr><td colspan="7" class="vacio">Cargando…</td></tr></tbody>
      </table>
    </div>
    <div class="pie"><button class="boton" onclick="cerrarModal()">Cerrar (Esc)</button></div>
  `);
  modal.classList.add('grande');

  async function cargar() {
    const sucursal = modal.querySelector('#kx-sucursal').value;
    try {
      const r = await api(`/api/productos/${p.id}/kardex${sucursal ? `?sucursal_id=${sucursal}` : ''}`);
      modal.querySelector('#kx-existencias').innerHTML = r.producto.existencias
        .map((e) => `<span>${escaparHtml(e.sucursal)}: <b>${e.existencia}</b></span>`).join('');
      modal.querySelector('#kx-cuerpo').innerHTML = r.movimientos.map((m) => {
        const cantidadTexto = m.delta == null ? `= ${m.cantidad}` : `${m.delta > 0 ? '+' : '−'}${Math.abs(m.delta)}`;
        const clase = m.delta == null ? '' : m.delta > 0 ? 'cantidad-mas' : 'cantidad-menos';
        return `<tr>
          <td style="white-space:nowrap">${escaparHtml(m.fecha)}</td>
          <td>${escaparHtml(m.sucursal)}</td>
          <td>${escaparHtml(ETIQUETA_MOVIMIENTO[m.tipo] || m.tipo)}${m.pendiente ? ` <span class="chip pendiente" title="Hecho sin conexión; se subirá a la central">${m.error ? 'Con error' : 'Por subir'}</span>` : ''}</td>
          <td class="num ${clase}">${cantidadTexto}</td>
          <td class="num">${m.existencia_resultante ?? '—'}</td>
          <td>${escaparHtml(m.usuario || '')}</td>
          <td>${escaparHtml(m.nota || '')}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" class="vacio">Sin movimientos registrados</td></tr>';
    } catch (err) {
      modal.querySelector('#kx-cuerpo').innerHTML = `<tr><td colspan="7" class="vacio">${escaparHtml(err.message)}</td></tr>`;
    }
  }
  modal.querySelector('#kx-sucursal').addEventListener('change', cargar);
  cargar();
}

async function mostrarBajoMinimo() {
  let filas;
  try {
    filas = await api('/api/productos/bajo-minimo');
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
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
  if (boton.dataset.accion === 'kardex') mostrarKardex(producto);
  if (boton.dataset.accion === 'eliminar') {
    if (App.usuario.rol !== 'admin') return;
    const confirmado = await confirmar({
      titulo: 'Dar de baja el producto',
      mensaje: `¿Dar de baja "${producto.descripcion}"? Deja de aparecer para vender; sus ventas y movimientos se conservan.`,
      boton: 'Dar de baja',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api('/api/productos/' + producto.id, { method: 'DELETE' });
      aviso('Producto dado de baja', 'exito');
      cargarProductos();
    } catch (err) {
      aviso(err.message, 'error');
    }
  }
});

App.alMostrarSeccion.productos = cargarProductos;
