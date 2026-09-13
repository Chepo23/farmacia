// Apoyos entre farmacias.
// La central arma la lista escaneando códigos y la envía; la sucursal que recibe
// la revisa pieza por pieza. Cada paso mueve inventario y queda con nombre y hora.
const Apoyos = {
  apoyos: [],
  pedidos: [],
  actual: null,       // apoyo abierto en el editor
  pedidoActual: null, // pedido abierto en el editor
};

const soyCentral = () => App.usuario && App.usuario.es_central === 1;

const ETIQUETA_ESTADO = {
  borrador: 'Borrador',
  enviado: 'Enviado',
  recibido: 'Recibido',
  cancelado: 'Cancelado',
  surtido: 'Surtido',
};

function chip(estado, texto) {
  return `<span class="chip ${estado}">${escaparHtml(texto || ETIQUETA_ESTADO[estado] || estado)}</span>`;
}

// Fecha en formato corto para las tablas ("2026-08-03 21:14" -> "03/08 21:14")
function fechaCorta(texto) {
  if (!texto) return '';
  const [dia, hora = ''] = texto.split(' ');
  const partes = dia.split('-');
  return `${partes[2]}/${partes[1]} ${hora.slice(0, 5)}`;
}

// ============================================================
//  Vista de inicio: farmacias, historial de apoyos y pedidos
// ============================================================
function mostrarInicioApoyos() {
  document.getElementById('apoyos-editor').hidden = true;
  document.getElementById('apoyos-editor').innerHTML = '';
  document.getElementById('apoyos-inicio').hidden = false;
  Apoyos.actual = null;
  Apoyos.pedidoActual = null;
  cargarApoyosInicio();
}

function mostrarEditorApoyos(html) {
  document.getElementById('apoyos-inicio').hidden = true;
  const editor = document.getElementById('apoyos-editor');
  editor.innerHTML = html;
  editor.hidden = false;
  return editor;
}

async function cargarApoyosInicio() {
  let apoyos;
  let pedidos;
  try {
    App.sucursales = await api('/api/admin/sucursales');
    [apoyos, pedidos] = await Promise.all([api('/api/apoyos'), api('/api/pedidos')]);
  } catch (err) {
    // Si esto falla, lo más común es que el servidor esté corriendo con una versión
    // vieja del programa: hay que reiniciarlo (cerrar la ventana negra y `npm start`)
    const franja = document.getElementById('apoyos-por-recibir');
    franja.innerHTML = `<span>No se pudo cargar la sección de apoyos: ${escaparHtml(err.message)}.
      Si el problema sigue, cierra el programa y vuelve a iniciarlo.</span>
      <button class="boton" data-accion="reintentar">Reintentar</button>`;
    franja.hidden = false;
    aviso('No se pudo cargar la sección de apoyos', 'error');
    return;
  }
  Apoyos.apoyos = apoyos;
  Apoyos.pedidos = pedidos;

  document.getElementById('boton-pedir-apoyo').hidden = soyCentral();
  document.getElementById('titulo-pedidos').textContent = soyCentral()
    ? 'Pedidos que mandaron las farmacias'
    : 'Mis pedidos a la central';

  pintarFranjaAvisos();
  pintarFarmacias();
  pintarTablaApoyos();
  pintarTablaPedidos();
  revisarPendientes();
}

function pintarFranjaAvisos() {
  const franja = document.getElementById('apoyos-por-recibir');
  const porRecibir = Apoyos.apoyos.filter(
    (a) => a.estado === 'enviado' && a.destino_id === App.usuario.sucursal_id
  );
  const pedidosPendientes = soyCentral()
    ? Apoyos.pedidos.filter((p) => p.estado === 'enviado')
    : [];

  if (porRecibir.length > 0) {
    franja.innerHTML = `
      <span><svg class="icono"><use href="#i-recibir"/></svg>
        Tienes ${porRecibir.length} apoyo${porRecibir.length > 1 ? 's' : ''} esperando que confirmes la
        recepción. La mercancía no entra a tu inventario hasta que la revises.</span>
      <button class="boton exito" data-accion="recibir" data-id="${porRecibir[0].id}">Revisar y recibir</button>`;
    franja.hidden = false;
  } else if (pedidosPendientes.length > 0) {
    const nombres = [...new Set(pedidosPendientes.map((p) => p.sucursal))].join(', ');
    franja.innerHTML = `
      <span><svg class="icono"><use href="#i-lista"/></svg>
        ${pedidosPendientes.length} pedido${pedidosPendientes.length > 1 ? 's' : ''} esperando apoyo: ${escaparHtml(nombres)}</span>`;
    franja.hidden = false;
  } else {
    franja.hidden = true;
  }
}

function pintarFarmacias() {
  const contenedor = document.getElementById('apoyos-farmacias');
  if (!soyCentral()) {
    const porRecibir = Apoyos.apoyos.filter(
      (a) => a.estado === 'enviado' && a.destino_id === App.usuario.sucursal_id
    ).length;
    const miPedido = Apoyos.pedidos.find(
      (p) => p.sucursal_id === App.usuario.sucursal_id && p.estado === 'borrador'
    );
    contenedor.innerHTML = `
      <button class="tarjeta-farmacia" data-accion="pedir">
        <b>Pedir apoyo a la central</b>
        <small>${miPedido
          ? `<span class="con-borrador">Tienes un pedido a medias con ${miPedido.renglones} producto(s)</span>`
          : 'Escanea lo que se te acabó y mándalo'}</small>
      </button>
      <button class="tarjeta-farmacia" data-accion="recibir-primero" ${porRecibir ? '' : 'disabled'}>
        <b>Apoyos por recibir</b>
        <small>${porRecibir ? `${porRecibir} pendiente(s) de revisar` : 'Nada pendiente'}</small>
      </button>`;
    return;
  }

  const otras = App.sucursales.filter((s) => s.id !== App.usuario.sucursal_id);
  contenedor.innerHTML =
    otras
      .map((s) => {
        const borrador = Apoyos.apoyos.find((a) => a.destino_id === s.id && a.estado === 'borrador');
        const pedido = Apoyos.pedidos.find((p) => p.sucursal_id === s.id && p.estado === 'enviado');
        return `<button class="tarjeta-farmacia" data-accion="abrir-apoyo" data-id="${s.id}">
          <b>${escaparHtml(s.nombre)}</b>
          <small>${borrador
            ? `<span class="con-borrador">Apoyo a medias: ${borrador.renglones} producto(s)</span>`
            : 'Escanear y armar apoyo'}</small>
          <small>${pedido ? `Pidió ${pedido.renglones} producto(s)` : '&nbsp;'}</small>
        </button>`;
      })
      .join('') +
    (App.usuario.rol === 'admin'
      ? `<button class="tarjeta-farmacia nueva" data-accion="nueva-farmacia">
           <b>+ Agregar farmacia</b><small>Da de alta una sucursal nueva</small>
         </button>`
      : '');
}

function pintarTablaApoyos() {
  const cuerpo = document.getElementById('cuerpo-apoyos');
  if (Apoyos.apoyos.length === 0) {
    cuerpo.innerHTML = '<tr><td colspan="9" class="vacio">Todavía no hay apoyos registrados.</td></tr>';
    return;
  }
  cuerpo.innerHTML = Apoyos.apoyos
    .map((a) => {
      const puedeRecibir = a.estado === 'enviado' && a.destino_id === App.usuario.sucursal_id;
      const faltantes = a.estado === 'recibido' && a.faltantes > 0;
      return `<tr>
        <td class="num">${a.folio}</td>
        <td>${escaparHtml(a.origen)}</td>
        <td>${escaparHtml(a.destino)}</td>
        <td>${chip(a.estado)}${faltantes ? ' ' + chip('faltante', `Faltaron ${a.faltantes}`) : ''}</td>
        <td class="num">${a.renglones}</td>
        <td class="num">${a.piezas}</td>
        <td class="num">${dinero(a.total_costo)}</td>
        <td>${fechaCorta(a.enviado || a.creado)}</td>
        <td style="white-space:nowrap">
          <button class="boton chico" data-accion="ver-apoyo" data-id="${a.id}">Ver</button>
          ${puedeRecibir ? `<button class="boton chico exito" data-accion="recibir" data-id="${a.id}">Recibir</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');
}

function pintarTablaPedidos() {
  const cuerpo = document.getElementById('cuerpo-pedidos');
  if (Apoyos.pedidos.length === 0) {
    cuerpo.innerHTML = `<tr><td colspan="7" class="vacio">${soyCentral()
      ? 'Ninguna farmacia ha mandado pedido.'
      : 'Todavía no has mandado pedidos.'}</td></tr>`;
    return;
  }
  cuerpo.innerHTML = Apoyos.pedidos
    .map((p) => {
      const mio = p.sucursal_id === App.usuario.sucursal_id;
      const etiqueta = p.estado === 'enviado' ? 'Esperando apoyo' : null;
      let acciones = `<button class="boton chico" data-accion="ver-pedido" data-id="${p.id}">Ver</button>`;
      if (mio && (p.estado === 'borrador' || p.estado === 'enviado')) {
        acciones = `<button class="boton chico primario" data-accion="editar-pedido" data-id="${p.id}">${p.estado === 'enviado' ? 'Editar' : 'Continuar'}</button>`;
      } else if (soyCentral() && p.estado === 'enviado') {
        acciones += ` <button class="boton chico exito" data-accion="armar-apoyo"
          data-id="${p.id}" data-sucursal="${p.sucursal_id}">Armar apoyo</button>`;
      } else if (soyCentral() && p.estado === 'surtido' && p.apoyo_id) {
        acciones += ` <button class="boton chico" data-accion="ver-apoyo" data-id="${p.apoyo_id}">Ver apoyo</button>`;
      }
      return `<tr>
        <td class="num">${p.folio}</td>
        <td>${escaparHtml(p.sucursal)}</td>
        <td>${chip(p.estado, etiqueta)}</td>
        <td class="num">${p.renglones}</td>
        <td class="num">${p.piezas}</td>
        <td>${fechaCorta(p.enviado || p.creado)}</td>
        <td style="white-space:nowrap">${acciones}</td>
      </tr>`;
    })
    .join('');
}

// ============================================================
//  Editor de apoyo (escaneo)
// ============================================================
async function abrirApoyoHacia(destinoId, pedidoId = null) {
  const cuerpo = { destino_id: destinoId };
  if (pedidoId) cuerpo.pedido_id = pedidoId;
  pintarApoyo(await api('/api/apoyos', { method: 'POST', body: cuerpo }));
}

async function verApoyo(id) {
  pintarApoyo(await api('/api/apoyos/' + id));
}

function filasApoyo(apoyo, editable) {
  if (apoyo.renglones.length === 0) {
    return '<tr><td colspan="9" class="vacio">Escanea el código de barras del primer producto.</td></tr>';
  }
  const mostrarRecibido = apoyo.estado === 'recibido';
  return apoyo.renglones
    .map((r) => {
      const falta = editable && r.usa_inventario && r.cantidad > r.existencia_origen;
      const diferencia = mostrarRecibido && r.cantidad_recibida !== r.cantidad;
      return `<tr data-renglon="${r.id}" class="${falta ? 'sin-existencia' : ''}">
        <td>${escaparHtml(r.codigo_barras || '—')}</td>
        <td>${escaparHtml(r.descripcion)}
          ${falta ? `<br><small class="texto-rojo">Solo hay ${r.existencia_origen} en ${escaparHtml(apoyo.origen)}</small>` : ''}</td>
        <td class="num">${editable
          ? `<input type="number" class="cantidad" step="any" min="0" value="${r.cantidad}" aria-label="Cantidad">`
          : r.cantidad}</td>
        ${mostrarRecibido
          ? `<td class="num ${diferencia ? 'texto-rojo' : 'texto-verde'}">${r.cantidad_recibida ?? 0}</td>`
          : ''}
        <td class="num">${dinero(r.precio_costo)}</td>
        <td class="num">${dinero(r.precio_venta)}</td>
        <td class="num">${r.precio_mayoreo != null ? dinero(r.precio_mayoreo) : '—'}</td>
        <td class="num col-importe">${dinero(r.importe)}</td>
        ${editable
          ? `<td><button class="boton-quitar" data-accion="quitar-renglon" data-id="${r.id}" title="Quitar">
               <svg class="icono"><use href="#i-basura"/></svg></button></td>`
          : ''}
      </tr>`;
    })
    .join('');
}

function panelApoyo(apoyo, editable) {
  const soyDestino = apoyo.destino_id === App.usuario.sucursal_id;
  const soyOrigen = apoyo.origen_id === App.usuario.sucursal_id;
  let botones = '';
  if (editable) {
    botones = `
      <button class="boton exito grande" data-accion="enviar-apoyo">
        <svg class="icono"><use href="#i-enviar"/></svg>Enviar a ${escaparHtml(apoyo.destino)}</button>
      <button class="boton primario" data-accion="imprimir-apoyo">
        <svg class="icono"><use href="#i-imprimir"/></svg>Imprimir lista</button>
      <button class="boton peligro-suave" data-accion="cancelar-apoyo">
        <svg class="icono"><use href="#i-x"/></svg>Cancelar este apoyo</button>`;
  } else {
    botones = `
      ${soyDestino && apoyo.estado === 'enviado'
        ? `<button class="boton exito grande" data-accion="recibir" data-id="${apoyo.id}">
             <svg class="icono"><use href="#i-recibir"/></svg>Revisar y recibir</button>`
        : ''}
      <button class="boton primario" data-accion="imprimir-apoyo">
        <svg class="icono"><use href="#i-imprimir"/></svg>Imprimir</button>
      ${soyOrigen && apoyo.estado === 'enviado'
        ? `<button class="boton peligro-suave" data-accion="cancelar-apoyo">Cancelar el envío</button>`
        : ''}`;
  }

  const seguimiento = `
    <div class="dato-secundario"><span>Armó</span><b>${escaparHtml(apoyo.creador)}</b></div>
    ${apoyo.enviado ? `<div class="dato-secundario"><span>Envió</span><b>${escaparHtml(apoyo.remitente || '')}</b></div>
      <div class="dato-secundario"><span>Fecha de envío</span><b>${escaparHtml(apoyo.enviado)}</b></div>` : ''}
    ${apoyo.recibido ? `<div class="dato-secundario"><span>Recibió</span><b>${escaparHtml(apoyo.receptor || '')}</b></div>
      <div class="dato-secundario"><span>Fecha de recepción</span><b>${escaparHtml(apoyo.recibido)}</b></div>` : ''}
    ${apoyo.estado === 'recibido' && apoyo.faltantes > 0
      ? `<div class="mensaje-error">Faltaron ${apoyo.faltantes} pieza(s) de lo que se mandó.
         Revísalo con ${escaparHtml(apoyo.destino)}; si aparecen, corrige la existencia desde Productos.</div>`
      : ''}
    ${apoyo.motivo_cancelacion ? `<div class="mensaje-error">Cancelado: ${escaparHtml(apoyo.motivo_cancelacion)}</div>` : ''}`;

  return `
    <div class="etiqueta-total">TOTAL A COSTO</div>
    <div class="total-grande" id="apoyo-total">${dinero(apoyo.total_costo)}</div>
    <div class="dato-secundario"><span>Valor a precio público</span><b>${dinero(apoyo.total_publico)}</b></div>
    <div class="dato-secundario"><span>Productos distintos</span><b>${apoyo.renglones.length}</b></div>
    <div class="dato-secundario"><span>Piezas en total</span><b>${apoyo.piezas}</b></div>
    ${apoyo.estado === 'recibido'
      ? `<div class="dato-secundario"><span>Piezas recibidas</span><b>${apoyo.piezas_recibidas}</b></div>`
      : ''}
    <hr>
    ${editable
      ? `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">Nota para la farmacia
           <input type="text" class="entrada" id="apoyo-nota" value="${escaparHtml(apoyo.nota || '')}"
                  placeholder="Ej. van 2 cajas en la bolsa azul"></label>`
      : apoyo.nota ? `<div class="dato-secundario"><span>Nota</span><b>${escaparHtml(apoyo.nota)}</b></div>` : ''}
    ${seguimiento}
    <div class="empuje"></div>
    ${botones}
    <button class="boton" data-accion="volver-inicio">Volver a la lista</button>`;
}

function pintarApoyo(apoyo) {
  Apoyos.actual = apoyo;
  Apoyos.pedidoActual = null;
  const editable = apoyo.estado === 'borrador' && apoyo.origen_id === App.usuario.sucursal_id;
  const mostrarRecibido = apoyo.estado === 'recibido';

  mostrarEditorApoyos(`
    <div class="encabezado-apoyo">
      <button class="boton" data-accion="volver-inicio"><svg class="icono"><use href="#i-atras"/></svg>Volver</button>
      <h2>Apoyo folio ${apoyo.folio}</h2>
      <span class="rumbo">De <b>${escaparHtml(apoyo.origen)}</b> para <b>${escaparHtml(apoyo.destino)}</b></span>
      ${chip(apoyo.estado)}
      ${apoyo.pedido_folio ? `<span class="rumbo">Surte el pedido #${apoyo.pedido_folio} de ${escaparHtml(apoyo.destino)}</span>` : ''}
    </div>
    <div class="zona-apoyo">
      <div class="captura-apoyo">
        ${editable
          ? `<input type="text" id="apoyo-codigo" class="entrada-codigo" autocomplete="off"
                    aria-label="Código del producto"
                    placeholder="Escanea el código de barras del producto…">
             <div class="ayuda-teclas">
               <span><b>Enter</b> Agrega el producto</span>
               <span><b>F3</b> Buscar por nombre</span>
               <span>Si vuelves a escanear el mismo producto, se suma la cantidad</span>
             </div>`
          : ''}
        <div class="contenedor-tabla">
          <table class="tabla tabla-apoyo">
            <thead><tr>
              <th>Código</th><th>Descripción</th><th class="num">Cantidad</th>
              ${mostrarRecibido ? '<th class="num">Recibido</th>' : ''}
              <th class="num">Costo</th><th class="num">Público</th><th class="num">Mayoreo</th>
              <th class="num">Importe</th>${editable ? '<th></th>' : ''}
            </tr></thead>
            <tbody id="apoyo-cuerpo">${filasApoyo(apoyo, editable)}</tbody>
          </table>
        </div>
      </div>
      <aside class="panel-apoyo" id="apoyo-panel">${panelApoyo(apoyo, editable)}</aside>
    </div>
  `);

  const codigo = document.getElementById('apoyo-codigo');
  if (codigo) codigo.focus();
}

// Redibuja solo la tabla y el panel para no perder el foco del escáner
function refrescarApoyo(apoyo, renglonNuevo = null) {
  Apoyos.actual = apoyo;
  const editable = apoyo.estado === 'borrador' && apoyo.origen_id === App.usuario.sucursal_id;
  document.getElementById('apoyo-cuerpo').innerHTML = filasApoyo(apoyo, editable);
  document.getElementById('apoyo-panel').innerHTML = panelApoyo(apoyo, editable);
  if (renglonNuevo) {
    const fila = document.querySelector(`#apoyo-cuerpo tr[data-renglon="${renglonNuevo}"]`);
    if (fila) {
      fila.classList.add('recien-agregado');
      const entrada = fila.querySelector('input.cantidad');
      if (entrada) { entrada.focus(); entrada.select(); }
    }
  }
}

async function agregarAlApoyo(codigo, cantidad = 1) {
  try {
    const apoyo = await api(`/api/apoyos/${Apoyos.actual.id}/renglones`, {
      method: 'POST',
      body: { codigo_barras: codigo, cantidad },
    });
    const renglon = apoyo.renglones.find((r) => (r.codigo_barras || '') === codigo.trim());
    refrescarApoyo(apoyo, renglon ? renglon.id : null);
    if (renglon) aviso(`${renglon.descripcion} — escribe la cantidad y presiona Enter`);
  } catch (err) {
    if (/Producto no encontrado/i.test(err.message)) return ofrecerAltaProducto(codigo);
    aviso(err.message, 'error');
  }
}

// El código no está en el catálogo: se ofrece darlo de alta sin salir del apoyo
function ofrecerAltaProducto(codigo) {
  const modal = abrirModal(`
    <h3>Ese código no está en el catálogo</h3>
    <p>El código <b>${escaparHtml(codigo)}</b> no existe todavía. Si lo das de alta ahora,
       podrás escanearlo otra vez para agregarlo al apoyo.</p>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">Cerrar</button>
      <button class="boton exito" id="alta-producto">Dar de alta el producto</button>
    </div>`);
  modal.querySelector('#alta-producto').addEventListener('click', () => {
    formularioProducto({ codigo_barras: codigo });
  });
}

// Buscar por nombre cuando el producto no tiene código legible (F3)
async function buscarProductoParaApoyo() {
  const modal = abrirModal(`
    <h3>Buscar producto</h3>
    <input type="text" id="ba-texto" class="entrada" placeholder="Escribe parte del nombre…" autocomplete="off">
    <div class="resultados-busqueda">
      <table class="tabla">
        <thead><tr><th>Código</th><th>Descripción</th><th class="num">Existencia aquí</th><th class="num">Costo</th></tr></thead>
        <tbody id="ba-cuerpo"></tbody>
      </table>
    </div>
    <div class="pie"><button class="boton" onclick="cerrarModal()">Cerrar (Esc)</button></div>`);

  const cuerpo = modal.querySelector('#ba-cuerpo');
  let encontrados = [];
  async function buscar() {
    const q = modal.querySelector('#ba-texto').value.trim();
    if (q.length < 2) { cuerpo.innerHTML = ''; return; }
    encontrados = await api('/api/productos/buscar?q=' + encodeURIComponent(q));
    cuerpo.innerHTML = encontrados
      .map((p) => `<tr data-id="${p.id}">
        <td>${escaparHtml(p.codigo_barras || '')}</td>
        <td>${escaparHtml(p.descripcion)}</td>
        <td class="num">${p.existencia_local}</td>
        <td class="num">${dinero(p.precio_costo)}</td>
      </tr>`)
      .join('') || '<tr><td colspan="4" class="vacio">Sin resultados</td></tr>';
  }
  let temporizador = null;
  modal.querySelector('#ba-texto').addEventListener('input', () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(buscar, 250);
  });
  cuerpo.addEventListener('click', async (e) => {
    const fila = e.target.closest('tr[data-id]');
    if (!fila) return;
    const producto = encontrados.find((p) => p.id === Number(fila.dataset.id));
    cerrarModal();
    const apoyo = await api(`/api/apoyos/${Apoyos.actual.id}/renglones`, {
      method: 'POST',
      body: { producto_id: producto.id, cantidad: 1 },
    });
    const renglon = apoyo.renglones.find((r) => r.producto_id === producto.id);
    refrescarApoyo(apoyo, renglon ? renglon.id : null);
  });
}

async function cambiarCantidadApoyo(renglonId, cantidad) {
  try {
    const apoyo = await api(`/api/apoyos/${Apoyos.actual.id}/renglones/${renglonId}`, {
      method: 'PUT',
      body: { cantidad },
    });
    refrescarApoyo(apoyo);
  } catch (err) {
    aviso(err.message, 'error');
    refrescarApoyo(Apoyos.actual);
  }
}

async function guardarNotaApoyo() {
  const entrada = document.getElementById('apoyo-nota');
  if (!entrada || !Apoyos.actual || Apoyos.actual.estado !== 'borrador') return;
  if ((Apoyos.actual.nota || '') === entrada.value.trim()) return;
  Apoyos.actual = await api('/api/apoyos/' + Apoyos.actual.id, {
    method: 'PUT',
    body: { nota: entrada.value },
  });
}

// ---------- Enviar ----------
function confirmarEnvioApoyo() {
  const apoyo = Apoyos.actual;
  if (apoyo.renglones.length === 0) return aviso('El apoyo no tiene productos', 'error');
  const modal = abrirModal(`
    <h3>Enviar apoyo a ${escaparHtml(apoyo.destino)}</h3>
    <p>Se van a mandar <b>${apoyo.piezas} pieza(s)</b> de <b>${apoyo.renglones.length} producto(s)</b>
       por un costo de <b>${dinero(apoyo.total_costo)}</b>.</p>
    <p>Al enviarlo, la mercancía <b>sale del inventario de ${escaparHtml(apoyo.origen)}</b> y le aparece a
       ${escaparHtml(apoyo.destino)} como pendiente de recibir. Ya no podrás modificar la lista.</p>
    <div id="envio-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">Cancelar</button>
      <button class="boton primario" id="envio-solo">Enviar</button>
      <button class="boton exito grande" id="envio-imprimir">
        <svg class="icono"><use href="#i-imprimir"/></svg>Enviar e imprimir</button>
    </div>`);

  async function enviar(imprimir) {
    const errorEl = modal.querySelector('#envio-error');
    errorEl.hidden = true;
    try {
      await guardarNotaApoyo();
      const enviado = await api(`/api/apoyos/${apoyo.id}/enviar`, { method: 'POST' });
      cerrarModal();
      aviso(`Apoyo folio ${enviado.folio} enviado a ${enviado.destino}`, 'exito');
      pintarApoyo(enviado);
      if (imprimir) imprimirApoyo(enviado);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }
  modal.querySelector('#envio-solo').addEventListener('click', () => enviar(false));
  modal.querySelector('#envio-imprimir').addEventListener('click', () => enviar(true));
}

function cancelarApoyo() {
  const apoyo = Apoyos.actual;
  const yaEnviado = apoyo.estado === 'enviado';
  const modal = abrirModal(`
    <h3>Cancelar el apoyo folio ${apoyo.folio}</h3>
    <p>${yaEnviado
      ? `Este apoyo ya se había enviado. Al cancelarlo, las ${apoyo.piezas} pieza(s) <b>regresan al
         inventario de ${escaparHtml(apoyo.origen)}</b> y ${escaparHtml(apoyo.destino)} ya no podrá recibirlo.`
      : 'Se borrará esta lista. Todavía no ha movido inventario.'}</p>
    ${yaEnviado ? '<label>Motivo <input type="text" id="cancel-motivo" placeholder="Ej. no salió el reparto"></label>' : ''}
    <div id="cancel-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">No cancelar</button>
      <button class="boton peligro" id="cancel-confirmar">Sí, cancelar el apoyo</button>
    </div>`);
  modal.querySelector('#cancel-confirmar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#cancel-error');
    errorEl.hidden = true;
    try {
      await api(`/api/apoyos/${apoyo.id}/cancelar`, {
        method: 'POST',
        body: { motivo: modal.querySelector('#cancel-motivo')?.value || '' },
      });
      cerrarModal();
      aviso('Apoyo cancelado');
      mostrarInicioApoyos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------- Recibir ----------
async function abrirRecepcion(id) {
  const apoyo = await api('/api/apoyos/' + id);
  const modal = abrirModal(`
    <h3>Recibir apoyo folio ${apoyo.folio} de ${escaparHtml(apoyo.origen)}</h3>
    <p>Cuenta la mercancía y confirma cuánto llegó de cada producto. Solo lo que confirmes
       entra a tu inventario.</p>
    <div class="contenedor-tabla" style="max-height:44vh;overflow-y:auto">
      <table class="tabla">
        <thead><tr><th>Código</th><th>Descripción</th><th class="num">Enviado</th><th class="num">Recibido</th></tr></thead>
        <tbody>
          ${apoyo.renglones
            .map((r) => `<tr data-renglon="${r.id}">
              <td>${escaparHtml(r.codigo_barras || '—')}</td>
              <td>${escaparHtml(r.descripcion)}</td>
              <td class="num">${r.cantidad}</td>
              <td class="num"><input type="number" class="recibido" step="any" min="0" max="${r.cantidad}"
                    value="${r.cantidad}" style="width:90px;text-align:center" aria-label="Cantidad recibida"></td>
            </tr>`)
            .join('')}
        </tbody>
      </table>
    </div>
    ${apoyo.nota ? `<p><b>Nota de ${escaparHtml(apoyo.origen)}:</b> ${escaparHtml(apoyo.nota)}</p>` : ''}
    <div id="recibir-resumen" class="dato-secundario"></div>
    <div id="recibir-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">Cerrar</button>
      <button class="boton" id="recibir-completo">Llegó todo completo</button>
      <button class="boton exito grande" id="recibir-confirmar">Confirmar recepción</button>
    </div>`);
  modal.classList.add('grande');

  const resumen = modal.querySelector('#recibir-resumen');
  function actualizarResumen() {
    let recibidas = 0;
    let faltantes = 0;
    modal.querySelectorAll('tr[data-renglon]').forEach((fila) => {
      const enviado = Number(fila.children[2].textContent);
      const recibido = Number(fila.querySelector('.recibido').value) || 0;
      recibidas += recibido;
      faltantes += Math.max(enviado - recibido, 0);
    });
    resumen.innerHTML = `<span>Vas a meter <b>${recibidas}</b> pieza(s) a tu inventario</span>
      ${faltantes > 0 ? `<b class="texto-rojo">Faltan ${faltantes} pieza(s)</b>` : '<b class="texto-verde">Completo</b>'}`;
  }
  modal.addEventListener('input', actualizarResumen);
  actualizarResumen();

  modal.querySelector('#recibir-completo').addEventListener('click', () => {
    modal.querySelectorAll('tr[data-renglon]').forEach((fila) => {
      fila.querySelector('.recibido').value = Number(fila.children[2].textContent);
    });
    actualizarResumen();
  });

  modal.querySelector('#recibir-confirmar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#recibir-error');
    errorEl.hidden = true;
    const renglones = [...modal.querySelectorAll('tr[data-renglon]')].map((fila) => ({
      id: Number(fila.dataset.renglon),
      cantidad_recibida: Number(fila.querySelector('.recibido').value) || 0,
    }));
    try {
      const recibido = await api(`/api/apoyos/${apoyo.id}/recibir`, { method: 'POST', body: { renglones } });
      cerrarModal();
      aviso(`Apoyo recibido: ${recibido.piezas_recibidas} pieza(s) entraron a tu inventario`, 'exito');
      pintarApoyo(recibido);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ============================================================
//  Pedidos (lo que la sucursal le solicita a la central)
// ============================================================
async function abrirPedido(id = null) {
  const pedido = id ? await api('/api/pedidos/' + id) : await api('/api/pedidos', { method: 'POST' });
  pintarPedido(pedido);
}

function filasPedido(pedido, editable) {
  if (pedido.renglones.length === 0) {
    return '<tr><td colspan="5" class="vacio">Escanea lo que se te acabó o usa el botón de sugerencias.</td></tr>';
  }
  return pedido.renglones
    .map((r) => `<tr data-renglon="${r.id}">
      <td>${escaparHtml(r.codigo_barras || '—')}</td>
      <td>${escaparHtml(r.descripcion)}</td>
      <td class="num">${editable
        ? `<input type="number" class="cantidad" step="any" min="0" value="${r.cantidad}" aria-label="Cantidad">`
        : r.cantidad}</td>
      <td class="num ${r.cantidad_surtida >= r.cantidad ? 'texto-verde' : ''}">${r.cantidad_surtida}</td>
      ${editable
        ? `<td><button class="boton-quitar" data-accion="quitar-renglon-pedido" data-id="${r.id}" title="Quitar">
             <svg class="icono"><use href="#i-basura"/></svg></button></td>`
        : '<td></td>'}
    </tr>`)
    .join('');
}

function pintarPedido(pedido) {
  Apoyos.pedidoActual = pedido;
  Apoyos.actual = null;
  const editable = (pedido.estado === 'borrador' || pedido.estado === 'enviado') && pedido.sucursal_id === App.usuario.sucursal_id;

  mostrarEditorApoyos(`
    <div class="encabezado-apoyo">
      <button class="boton" data-accion="volver-inicio"><svg class="icono"><use href="#i-atras"/></svg>Volver</button>
      <h2>Pedido folio ${pedido.folio}</h2>
      <span class="rumbo">De <b>${escaparHtml(pedido.sucursal)}</b> para la central</span>
      ${chip(pedido.estado, pedido.estado === 'enviado' ? 'Esperando apoyo' : null)}
    </div>
    <div class="zona-apoyo">
      <div class="captura-apoyo">
        ${editable
          ? `<input type="text" id="pedido-codigo" class="entrada-codigo" autocomplete="off"
                    aria-label="Código del producto"
                    placeholder="Escanea el código de lo que se te acabó…">
             <div class="ayuda-teclas">
               <span><b>Enter</b> Agrega el producto</span>
               <span>El sistema ya sabe qué tienes en cero: usa <b>Sugerencias</b></span>
             </div>`
          : ''}
        <div class="contenedor-tabla">
          <table class="tabla tabla-apoyo">
            <thead><tr>
              <th>Código</th><th>Descripción</th><th class="num">Pedido</th><th class="num">Ya surtido</th><th></th>
            </tr></thead>
            <tbody id="pedido-cuerpo">${filasPedido(pedido, editable)}</tbody>
          </table>
        </div>
      </div>
      <aside class="panel-apoyo" id="pedido-panel">
        <div class="etiqueta-total">PIEZAS PEDIDAS</div>
        <div class="total-grande" id="pedido-piezas">${pedido.piezas}</div>
        <div class="dato-secundario"><span>Productos distintos</span><b id="pedido-productos">${pedido.renglones.length}</b></div>
        <div class="dato-secundario"><span>Lo armó</span><b>${escaparHtml(pedido.creador)}</b></div>
        ${pedido.enviado ? `<div class="dato-secundario"><span>Enviado</span><b>${escaparHtml(pedido.enviado)}</b></div>` : ''}
        <hr>
        ${editable
          ? `<button class="boton advertencia" data-accion="sugerencias">
               <svg class="icono"><use href="#i-alerta"/></svg>Sugerencias (lo que está en cero)</button>
             <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">Nota
               <input type="text" class="entrada" id="pedido-nota" value="${escaparHtml(pedido.nota || '')}"
                      placeholder="Ej. lo del turno de la noche"></label>`
          : pedido.nota ? `<div class="dato-secundario"><span>Nota</span><b>${escaparHtml(pedido.nota)}</b></div>` : ''}
        <div class="empuje"></div>
        ${editable
          ? `<button class="boton exito grande" data-accion="enviar-pedido" ${pedido.estado === 'enviado' ? 'title="El pedido ya se había enviado; solo se actualizan cantidades y nota"' : ''}>
               <svg class="icono"><use href="#i-enviar"/></svg>${pedido.estado === 'enviado' ? 'Actualizar pedido' : 'Mandar pedido a la central'}</button>
             <button class="boton peligro-suave" data-accion="cancelar-pedido">
               <svg class="icono"><use href="#i-x"/></svg>Cancelar pedido</button>`
          : ''}
        <button class="boton primario" data-accion="imprimir-pedido">
          <svg class="icono"><use href="#i-imprimir"/></svg>Imprimir</button>
        <button class="boton" data-accion="volver-inicio">Volver a la lista</button>
      </aside>
    </div>`);

  const codigo = document.getElementById('pedido-codigo');
  if (codigo) codigo.focus();
}

function refrescarPedido(pedido, renglonNuevo = null) {
  Apoyos.pedidoActual = pedido;
  const editable = (pedido.estado === 'borrador' || pedido.estado === 'enviado') && pedido.sucursal_id === App.usuario.sucursal_id;
  document.getElementById('pedido-cuerpo').innerHTML = filasPedido(pedido, editable);
  document.getElementById('pedido-piezas').textContent = pedido.piezas;
  document.getElementById('pedido-productos').textContent = pedido.renglones.length;
  if (renglonNuevo) {
    const fila = document.querySelector(`#pedido-cuerpo tr[data-renglon="${renglonNuevo}"]`);
    if (fila) {
      fila.classList.add('recien-agregado');
      const entrada = fila.querySelector('input.cantidad');
      if (entrada) { entrada.focus(); entrada.select(); }
    }
  }
}

async function agregarAlPedido(codigo) {
  try {
    const pedido = await api(`/api/pedidos/${Apoyos.pedidoActual.id}/renglones`, {
      method: 'POST',
      body: { codigo_barras: codigo, cantidad: 1 },
    });
    const renglon = pedido.renglones.find((r) => (r.codigo_barras || '') === codigo.trim());
    refrescarPedido(pedido, renglon ? renglon.id : null);
  } catch (err) {
    if (/Producto no encontrado/i.test(err.message)) return ofrecerAltaProducto(codigo);
    aviso(err.message, 'error');
  }
}

async function mostrarSugerencias() {
  const filas = await api('/api/pedidos/sugerencias');
  const modal = abrirModal(`
    <h3>Lo que conviene pedir</h3>
    <p>Productos que están en cero o por debajo de su mínimo en ${escaparHtml(App.usuario.sucursal)},
       con lo que se vendió en los últimos 7 días.</p>
    ${filas.length === 0
      ? '<p class="vacio">No hay nada en cero ni bajo mínimo. 👍</p>'
      : `<div class="contenedor-tabla" style="max-height:46vh;overflow-y:auto">
          <table class="tabla">
            <thead><tr><th><input type="checkbox" id="sug-todos" aria-label="Seleccionar todos"></th>
              <th>Descripción</th><th class="num">Tengo</th><th class="num">Vendí (7 días)</th><th class="num">Pedir</th></tr></thead>
            <tbody>
              ${filas.map((f) => `<tr>
                <td><input type="checkbox" class="sug-marca" data-id="${f.producto_id}"
                     ${f.existencia <= 0 ? 'checked' : ''} aria-label="Incluir"></td>
                <td>${escaparHtml(f.descripcion)}</td>
                <td class="num ${f.existencia <= 0 ? 'texto-rojo' : ''}">${f.existencia}</td>
                <td class="num">${f.vendidos_semana}</td>
                <td class="num"><input type="number" class="sug-cantidad" step="any" min="0"
                     value="${f.cantidad_sugerida}" style="width:80px;text-align:center" aria-label="Cantidad"></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
    <div id="sug-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">Cerrar</button>
      ${filas.length ? '<button class="boton exito" id="sug-agregar">Agregar los marcados</button>' : ''}
    </div>`);
  modal.classList.add('grande');

  modal.querySelector('#sug-todos')?.addEventListener('change', (e) => {
    modal.querySelectorAll('.sug-marca').forEach((c) => { c.checked = e.target.checked; });
  });

  modal.querySelector('#sug-agregar')?.addEventListener('click', async () => {
    const errorEl = modal.querySelector('#sug-error');
    errorEl.hidden = true;
    const elegidos = [...modal.querySelectorAll('.sug-marca')]
      .filter((c) => c.checked)
      .map((c) => ({
        producto_id: Number(c.dataset.id),
        cantidad: Number(c.closest('tr').querySelector('.sug-cantidad').value) || 0,
      }))
      .filter((r) => r.cantidad > 0);
    if (elegidos.length === 0) {
      errorEl.textContent = 'No marcaste ningún producto con cantidad';
      errorEl.hidden = false;
      return;
    }
    let pedido = Apoyos.pedidoActual;
    for (const renglon of elegidos) {
      pedido = await api(`/api/pedidos/${pedido.id}/renglones`, { method: 'POST', body: renglon });
    }
    cerrarModal();
    refrescarPedido(pedido);
    aviso(`${elegidos.length} producto(s) agregados al pedido`, 'exito');
  });
}

async function cancelarPedido() {
  const pedido = Apoyos.pedidoActual;
  const modal = abrirModal(`
    <h3>Cancelar el pedido folio ${pedido.folio}</h3>
    <p>Se va a cancelar este pedido. La central dejará de surtirlo y ya no se podrá recibir en apoyo.</p>
    <div id="pedido-cancel-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">No cancelar</button>
      <button class="boton peligro" id="pedido-cancel-confirmar">Sí, cancelar</button>
    </div>`);

  modal.querySelector('#pedido-cancel-confirmar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#pedido-cancel-error');
    errorEl.hidden = true;
    try {
      await api(`/api/pedidos/${pedido.id}/cancelar`, { method: 'POST' });
      cerrarModal();
      aviso('Pedido cancelado', 'exito');
      mostrarInicioApoyos();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

async function enviarPedido() {
  const pedido = Apoyos.pedidoActual;
  if (pedido.renglones.length === 0) return aviso('El pedido no tiene productos', 'error');
  const nota = document.getElementById('pedido-nota')?.value || '';
  const modal = abrirModal(`
    <h3>${pedido.estado === 'enviado' ? 'Actualizar pedido' : 'Mandar el pedido a la central'}</h3>
    <p>Se van a pedir <b>${pedido.piezas} pieza(s)</b> de <b>${pedido.renglones.length} producto(s)</b>.
       ${pedido.estado === 'enviado'
         ? 'Los cambios se guardan para que la central los tome en el siguiente surtido.'
         : 'La central lo verá al momento y armará el apoyo desde este mismo pedido.'}</p>
    <div id="pedido-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" onclick="cerrarModal()">Todavía no</button>
      <button class="boton exito grande" id="pedido-confirmar">${pedido.estado === 'enviado' ? 'Guardar cambios' : 'Mandar pedido'}</button>
    </div>`);
  modal.querySelector('#pedido-confirmar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#pedido-error');
    errorEl.hidden = true;
    try {
      const enviado = await api(`/api/pedidos/${pedido.id}/enviar`, { method: 'POST', body: { nota } });
      cerrarModal();
      aviso(pedido.estado === 'enviado' ? 'Pedido actualizado' : 'Pedido enviado a la central', 'exito');
      pintarPedido(enviado);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ============================================================
//  Impresión (hoja normal, no ticket)
// ============================================================
window.addEventListener('afterprint', () => {
  document.body.classList.remove('imprimir-documento');
  document.getElementById('documento').innerHTML = '';
});

function imprimirDocumento(html) {
  const documento = document.getElementById('documento');
  documento.innerHTML = html;
  document.body.classList.add('imprimir-documento');
  window.print();
}

function imprimirApoyo(apoyo) {
  const mostrarRecibido = apoyo.estado === 'recibido';
  imprimirDocumento(`
    <div class="doc-encabezado">
      <div>
        <h2>APOYO DE MERCANCÍA</h2>
        <div class="doc-datos">
          <b>Folio ${apoyo.folio}</b> — ${ETIQUETA_ESTADO[apoyo.estado] || apoyo.estado}<br>
          Manda: <b>${escaparHtml(apoyo.origen)}</b><br>
          Recibe: <b>${escaparHtml(apoyo.destino)}</b>
          ${apoyo.pedido_folio ? `<br>Surte el pedido #${apoyo.pedido_folio}` : ''}
        </div>
      </div>
      <div class="doc-datos" style="text-align:right">
        Armó: ${escaparHtml(apoyo.creador)}<br>
        ${apoyo.enviado ? `Enviado: ${escaparHtml(apoyo.enviado)}<br>` : `Impreso: ${new Date().toLocaleString('es-MX')}<br>`}
        ${apoyo.recibido ? `Recibido: ${escaparHtml(apoyo.recibido)} por ${escaparHtml(apoyo.receptor || '')}` : ''}
      </div>
    </div>
    <table>
      <thead><tr>
        <th>#</th><th>Código de barras</th><th>Descripción</th><th class="num">Cant.</th>
        ${mostrarRecibido ? '<th class="num">Recibido</th>' : ''}
        <th class="num">Costo</th><th class="num">Público</th><th class="num">Mayoreo</th><th class="num">Total</th>
      </tr></thead>
      <tbody>
        ${apoyo.renglones
          .map((r, i) => `<tr>
            <td>${i + 1}</td>
            <td>${escaparHtml(r.codigo_barras || '')}</td>
            <td>${escaparHtml(r.descripcion)}</td>
            <td class="num">${r.cantidad}</td>
            ${mostrarRecibido ? `<td class="num">${r.cantidad_recibida ?? 0}</td>` : ''}
            <td class="num">${dinero(r.precio_costo)}</td>
            <td class="num">${dinero(r.precio_venta)}</td>
            <td class="num">${r.precio_mayoreo != null ? dinero(r.precio_mayoreo) : ''}</td>
            <td class="num">${dinero(r.importe)}</td>
          </tr>`)
          .join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">TOTALES — ${apoyo.renglones.length} producto(s)</td>
          <td class="num">${apoyo.piezas}</td>
          ${mostrarRecibido ? `<td class="num">${apoyo.piezas_recibidas}</td>` : ''}
          <td colspan="2"></td>
          <td class="num">Costo</td>
          <td class="num">${dinero(apoyo.total_costo)}</td>
        </tr>
      </tfoot>
    </table>
    ${apoyo.nota ? `<p style="margin-top:8px;font-size:11px"><b>Nota:</b> ${escaparHtml(apoyo.nota)}</p>` : ''}
    <p style="margin-top:6px;font-size:11px">Valor a precio público: <b>${dinero(apoyo.total_publico)}</b></p>
    <div class="doc-firmas">
      <div>Entregó — ${escaparHtml(apoyo.origen)}</div>
      <div>Recibió — ${escaparHtml(apoyo.destino)}</div>
    </div>`);
}

function imprimirPedido(pedido) {
  imprimirDocumento(`
    <div class="doc-encabezado">
      <div>
        <h2>PEDIDO DE APOYO</h2>
        <div class="doc-datos">
          <b>Folio ${pedido.folio}</b> — ${ETIQUETA_ESTADO[pedido.estado] || pedido.estado}<br>
          Pide: <b>${escaparHtml(pedido.sucursal)}</b>
        </div>
      </div>
      <div class="doc-datos" style="text-align:right">
        Lo armó: ${escaparHtml(pedido.creador)}<br>
        ${pedido.enviado ? `Enviado: ${escaparHtml(pedido.enviado)}` : `Impreso: ${new Date().toLocaleString('es-MX')}`}
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Código de barras</th><th>Descripción</th>
        <th class="num">Pedido</th><th class="num">Surtido</th></tr></thead>
      <tbody>
        ${pedido.renglones
          .map((r, i) => `<tr>
            <td>${i + 1}</td>
            <td>${escaparHtml(r.codigo_barras || '')}</td>
            <td>${escaparHtml(r.descripcion)}</td>
            <td class="num">${r.cantidad}</td>
            <td class="num">${r.cantidad_surtida}</td>
          </tr>`)
          .join('')}
      </tbody>
      <tfoot><tr><td colspan="3">TOTAL — ${pedido.renglones.length} producto(s)</td>
        <td class="num">${pedido.piezas}</td><td></td></tr></tfoot>
    </table>
    ${pedido.nota ? `<p style="margin-top:8px;font-size:11px"><b>Nota:</b> ${escaparHtml(pedido.nota)}</p>` : ''}`);
}

// ============================================================
//  Avisos en la pestaña
// ============================================================
async function revisarPendientes() {
  try {
    const { por_recibir: porRecibir, pedidos_por_surtir: pedidos } = await api('/api/apoyos/pendientes');
    const globo = document.getElementById('aviso-apoyos');
    const total = porRecibir + pedidos;
    globo.textContent = total;
    globo.hidden = total === 0;
    globo.title = porRecibir
      ? `${porRecibir} apoyo(s) por recibir`
      : `${pedidos} pedido(s) por surtir`;
  } catch { /* sin sesión o sin red: no molestar */ }
}

// ============================================================
//  Eventos
// ============================================================
document.getElementById('apoyos-farmacias').addEventListener('click', (e) => {
  const tarjeta = e.target.closest('button[data-accion]');
  if (!tarjeta) return;
  const accion = tarjeta.dataset.accion;
  if (accion === 'abrir-apoyo') abrirApoyoHacia(Number(tarjeta.dataset.id));
  if (accion === 'pedir') abrirPedido();
  if (accion === 'nueva-farmacia') formularioSucursal({}, cargarApoyosInicio);
  if (accion === 'recibir-primero') {
    const pendiente = Apoyos.apoyos.find(
      (a) => a.estado === 'enviado' && a.destino_id === App.usuario.sucursal_id
    );
    if (pendiente) abrirRecepcion(pendiente.id);
  }
});

document.getElementById('apoyos-inicio').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton || boton.closest('#apoyos-farmacias')) return;
  const id = Number(boton.dataset.id);
  switch (boton.dataset.accion) {
    case 'reintentar': cargarApoyosInicio(); break;
    case 'ver-apoyo': verApoyo(id); break;
    case 'recibir': abrirRecepcion(id); break;
    case 'ver-pedido':
    case 'editar-pedido': abrirPedido(id); break;
    case 'armar-apoyo': abrirApoyoHacia(Number(boton.dataset.sucursal), id); break;
  }
});

// Un solo manejador para el editor: su contenido se redibuja constantemente
document.getElementById('apoyos-editor').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  switch (boton.dataset.accion) {
    case 'volver-inicio': mostrarInicioApoyos(); break;
    case 'enviar-apoyo': confirmarEnvioApoyo(); break;
    case 'cancelar-apoyo': cancelarApoyo(); break;
    case 'cancelar-pedido': cancelarPedido(); break;
    case 'imprimir-apoyo': imprimirApoyo(Apoyos.actual); break;
    case 'recibir': abrirRecepcion(Number(boton.dataset.id)); break;
    case 'quitar-renglon':
      api(`/api/apoyos/${Apoyos.actual.id}/renglones/${boton.dataset.id}`, { method: 'DELETE' })
        .then(refrescarApoyo)
        .catch((err) => aviso(err.message, 'error'));
      break;
    case 'enviar-pedido': enviarPedido(); break;
    case 'sugerencias': mostrarSugerencias(); break;
    case 'imprimir-pedido': imprimirPedido(Apoyos.pedidoActual); break;
    case 'quitar-renglon-pedido':
      api(`/api/pedidos/${Apoyos.pedidoActual.id}/renglones/${boton.dataset.id}`, { method: 'DELETE' })
        .then(refrescarPedido)
        .catch((err) => aviso(err.message, 'error'));
      break;
  }
});

document.getElementById('apoyos-editor').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'apoyo-codigo') {
    e.preventDefault();
    const codigo = e.target.value.trim();
    e.target.value = '';
    if (codigo) agregarAlApoyo(codigo);
  } else if (e.target.id === 'pedido-codigo') {
    e.preventDefault();
    const codigo = e.target.value.trim();
    e.target.value = '';
    if (codigo) agregarAlPedido(codigo);
  } else if (e.target.classList.contains('cantidad')) {
    e.preventDefault();
    e.target.blur(); // dispara el change y guarda
    document.getElementById('apoyo-codigo')?.focus();
    document.getElementById('pedido-codigo')?.focus();
  }
});

document.getElementById('apoyos-editor').addEventListener('change', (e) => {
  if (!e.target.classList.contains('cantidad')) return;
  const renglon = e.target.closest('tr[data-renglon]').dataset.renglon;
  const cantidad = Number(e.target.value);
  if (!(cantidad > 0)) {
    aviso('La cantidad debe ser mayor a cero', 'error');
    if (Apoyos.actual) refrescarApoyo(Apoyos.actual);
    else refrescarPedido(Apoyos.pedidoActual);
    return;
  }
  if (Apoyos.actual) {
    cambiarCantidadApoyo(renglon, cantidad);
  } else if (Apoyos.pedidoActual) {
    api(`/api/pedidos/${Apoyos.pedidoActual.id}/renglones/${renglon}`, {
      method: 'PUT',
      body: { cantidad },
    })
      .then((p) => refrescarPedido(p))
      .catch((err) => aviso(err.message, 'error'));
  }
});

// La nota se guarda al salir del campo
document.getElementById('apoyos-editor').addEventListener('focusout', (e) => {
  if (e.target.id === 'apoyo-nota') guardarNotaApoyo();
});

// F3 busca por nombre cuando el código no se puede escanear
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F3' || hayModalAbierto()) return;
  if (!document.getElementById('seccion-apoyos').classList.contains('activa')) return;
  if (!Apoyos.actual || Apoyos.actual.estado !== 'borrador') return;
  e.preventDefault();
  buscarProductoParaApoyo();
});

document.getElementById('boton-pedir-apoyo').addEventListener('click', () => abrirPedido());
document.getElementById('boton-refrescar-apoyos').addEventListener('click', mostrarInicioApoyos);

App.alMostrarSeccion.apoyos = () => {
  if (Apoyos.actual || Apoyos.pedidoActual) return; // no interrumpir una captura a medias
  mostrarInicioApoyos();
};

// Avisar de apoyos nuevos sin tener que entrar a la pestaña
document.addEventListener('app:listo', () => {
  revisarPendientes();
  setInterval(revisarPendientes, 45000);
});
