// Inventario del día en el celular: cada día el sistema arma una lista corta de productos de la
// sucursal (ordenada por departamento). Se escanea cada uno y se escribe cuántas piezas hay, sin ver
// lo que dice el sistema. Si no cuadra se recuenta una vez; si sigue sin cuadrar se anota el motivo.
// Al terminar, un jefe (nunca quien contó) autoriza las diferencias. Usa las funciones de movil.js.
M.dia = { conteo: null, abierto: false, cargando: false, error: '' };

const MOTIVOS_FALTAN = ['Caducado', 'Dañado', 'No se encontró', 'Se vendió sin registrar', 'Error al recibir'];
const MOTIVOS_SOBRAN = ['Llegó mercancía sin registrar', 'Error al recibir', 'Estaba en otro lugar'];
const ESTADOS_DIA = {
  por_contar: 'Por contar',
  recontar: 'No cuadró: vuelve a contarlo',
  falta_motivo: 'Sigue sin cuadrar: falta el motivo',
  no_contado: 'No se contó',
};

const diaAbierto = () => Boolean(M.dia.abierto && M.dia.conteo && M.dia.conteo.estado === 'abierto');

async function cargarDia({ silencioso = false } = {}) {
  if (!M.usuario) return;
  M.dia.cargando = !silencioso || !M.dia.conteo;
  M.dia.error = '';
  pintarDia();
  try {
    M.dia.conteo = await api(`/api/conteos/hoy?sucursal_id=${M.sucursalId}`);
  } catch (error) {
    M.dia.error = error.message;
  } finally {
    M.dia.cargando = false;
  }
  if (!diaAbierto()) M.dia.abierto = false;
  pintarDia();
}

function textoRenglonDia(r) {
  if (r.estado === 'cuadra') return `Cuadró (${cantidadTexto(r.contado)})`;
  if (r.estado === 'con_diferencia') return `${r.sentido === 'faltan' ? 'Faltan' : 'Sobran'} piezas · ${r.motivo}`;
  return ESTADOS_DIA[r.estado] || r.estado;
}

function pintarTarjetaDia() {
  const caja = $('dia-tarjeta');
  const c = M.dia.conteo;
  if (M.dia.cargando) {
    caja.innerHTML = '<div class="m-dia-tarjeta"><div class="m-cargando">Cargando el inventario del día…</div></div>';
    return;
  }
  if (M.dia.error) {
    caja.innerHTML = `<div class="m-dia-tarjeta"><b>Inventario del día</b><p class="m-error-texto">${escaparHtml(M.dia.error)}</p>
      <button class="m-boton secundario" data-dia-accion="recargar">Intentar de nuevo</button></div>`;
    return;
  }
  if (!c) {
    caja.innerHTML = '';
    return;
  }
  if (!c.productos) {
    caja.innerHTML = '<div class="m-dia-tarjeta"><b>Inventario del día</b><p>Hoy no hay productos en la lista de esta sucursal.</p></div>';
    return;
  }
  if (c.estado === 'abierto') {
    const empezado = c.contados > 0;
    caja.innerHTML = `<div class="m-dia-tarjeta activa">
      <div class="m-dia-fila"><b>Inventario del día</b><span class="m-chip enviada">${c.contados} de ${c.productos}</span></div>
      <p>${empezado ? 'Sigue donde te quedaste.' : `Hoy toca contar ${c.productos} productos de ${escaparHtml(c.sucursal)}, ordenados por departamento.`}</p>
      <div class="m-progreso" aria-hidden="true"><span style="width:${Math.round((c.contados / c.productos) * 100)}%"></span></div>
      <button class="m-boton principal con-icono" data-dia-accion="abrir"><svg class="icono"><use href="#i-contar"/></svg>${empezado ? 'Seguir contando' : 'Empezar'}</button>
    </div>`;
    return;
  }
  const revisado = c.estado === 'cerrado';
  caja.innerHTML = `<div class="m-dia-tarjeta hecha">
    <div class="m-dia-fila"><b>Inventario del día terminado</b><span class="m-chip ${revisado ? 'vendida' : 'vencida'}">${revisado ? 'Revisado' : 'Por autorizar'}</span></div>
    <p>${c.sin_diferencia} de ${c.contados} productos cuadraron${c.exactitud != null ? ` (exactitud ${c.exactitud}%)` : ''}.
      ${revisado ? '' : 'Las diferencias las revisa el jefe.'}</p>
  </div>`;
}

function pintarDia() {
  const abierto = diaAbierto();
  $('dia-vista').hidden = !abierto;
  $('con-libre').hidden = abierto;
  $('dia-tarjeta').hidden = abierto;
  if (!abierto) {
    pintarTarjetaDia();
    return;
  }
  const c = M.dia.conteo;
  $('dia-subtitulo').textContent = `${c.sucursal} · ${fechaDia(`${c.fecha} 12:00:00`)}`;
  $('dia-contados').textContent = c.contados;
  $('dia-total').textContent = c.productos;
  $('dia-cuadran').textContent = c.sin_diferencia;
  $('dia-barra').style.width = `${c.productos ? Math.round((c.contados / c.productos) * 100) : 0}%`;
  let departamento = null;
  $('dia-lista').innerHTML = c.renglones.map((r) => {
    let encabezado = '';
    if (r.departamento !== departamento) {
      departamento = r.departamento;
      encabezado = `<li class="m-dia-departamento">${escaparHtml(departamento || 'Sin departamento')}</li>`;
    }
    const pendiente = ['por_contar', 'recontar', 'falta_motivo'].includes(r.estado);
    return `${encabezado}<li class="m-renglon m-dia-renglon ${r.estado}" data-dia="${r.id}">
      <span class="m-palomita"><svg class="icono"><use href="#${r.estado === 'cuadra' ? 'i-check' : r.estado === 'por_contar' ? 'i-contar' : 'i-alerta'}"/></svg></span>
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
        <div class="m-renglon-dato">${escaparHtml(r.codigo_barras || 'Sin código')} · ${escaparHtml(textoRenglonDia(r))}</div></div>
      ${pendiente ? `<button class="m-accion chica" data-dia-contar="${r.id}">${r.estado === 'falta_motivo' ? 'Motivo' : r.estado === 'recontar' ? 'Recontar' : 'Contar'}</button>` : ''}
    </li>`;
  }).join('');
}

function actualizarRenglonDia(renglon) {
  const c = M.dia.conteo;
  const i = c.renglones.findIndex((r) => r.id === renglon.id);
  if (i >= 0) c.renglones[i] = { ...c.renglones[i], ...renglon };
  c.contados = c.renglones.filter((r) => r.contado != null).length;
  c.sin_diferencia = c.renglones.filter((r) => r.estado === 'cuadra').length;
  pintarDia();
}

function informarDia(texto, { error = false } = {}) {
  if (Escaner.abierto()) Escaner.informar(texto, { error });
  else aviso(texto.replace(/<[^>]+>/g, ''), error ? 'error' : 'exito');
}

const renglonDiaPorCodigo = (codigo) => (M.dia.conteo?.renglones || []).find((r) => r.codigo_barras && r.codigo_barras === codigo);

function pedirMotivoDia(renglon) {
  return new Promise((resolver) => {
    const motivos = renglon.sentido === 'sobran' ? MOTIVOS_SOBRAN : MOTIVOS_FALTAN;
    const hoja = abrirHoja(`
      <h3>¿Por qué no cuadra?</h3>
      <p>${renglon.sentido === 'sobran' ? 'Sobran' : 'Faltan'} piezas de <b>${escaparHtml(renglon.descripcion)}</b>. Elige el motivo o escríbelo.</p>
      <div class="m-motivos">${motivos.map((m) => `<button type="button" data-motivo="${escaparHtml(m)}">${escaparHtml(m)}</button>`).join('')}</div>
      <input id="hoja-motivo" type="text" maxlength="200" placeholder="Otro motivo" aria-label="Motivo">
      <div id="hoja-error" class="m-error" hidden></div>
      <div class="m-botones">
        <button class="m-boton secundario" data-r="no">Después</button>
        <button class="m-boton principal" data-r="si">Guardar</button>
      </div>`);
    let listo = false;
    alCerrarHoja = () => resolver(listo);
    const entrada = hoja.querySelector('#hoja-motivo');
    hoja.querySelectorAll('[data-motivo]').forEach((b) => b.addEventListener('click', () => {
      hoja.querySelectorAll('[data-motivo]').forEach((x) => x.classList.toggle('elegido', x === b));
      entrada.value = b.dataset.motivo;
    }));
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.querySelector('[data-r="si"]').addEventListener('click', async () => {
      const error = hoja.querySelector('#hoja-error');
      error.hidden = true;
      try {
        const r = await api(`/api/conteos/${M.dia.conteo.id}/motivo`, { method: 'POST', body: { renglon_id: renglon.id, motivo: entrada.value } });
        listo = true;
        cerrarHoja();
        actualizarRenglonDia(r.renglon);
        informarDia(`Anotado: ${escaparHtml(renglon.descripcion)}`);
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
      }
    });
  });
}

// Pide cuántas piezas hay y lo registra; si no cuadra, pide el recuento y después el motivo
async function contarRenglonDia(renglon) {
  if (renglon.estado === 'falta_motivo') return pedirMotivoDia(renglon);
  if (!['por_contar', 'recontar'].includes(renglon.estado)) {
    informarDia(`${escaparHtml(renglon.descripcion)} ya quedó contado`);
    return null;
  }
  const recuento = renglon.estado === 'recontar';
  const r = await pedirCantidad({
    titulo: escaparHtml(renglon.descripcion),
    mensaje: recuento
      ? '<b>No cuadró con el sistema.</b> Cuéntalo otra vez con calma: revisa la bodega, otros estantes y las cajas abiertas.'
      : 'Cuenta todas las piezas (estante y bodega) y escribe cuántas hay.',
    valor: '',
    boton: recuento ? 'Guardar recuento' : 'Guardar',
    permitirCero: true,
  });
  if (!r) return null;
  let respuesta;
  try {
    respuesta = await api(`/api/conteos/${M.dia.conteo.id}/contar`, { method: 'POST', body: { renglon_id: renglon.id, contado: r.cantidad } });
  } catch (error) {
    informarDia(escaparHtml(error.message), { error: true });
    if (['CONTEO_CERRADO', 'YA_CONTADO'].includes(error.codigo)) cargarDia({ silencioso: true });
    return null;
  }
  actualizarRenglonDia(respuesta.renglon);
  if (respuesta.resultado === 'cuadra') {
    informarDia(`✓ <b>${escaparHtml(renglon.descripcion)}</b> cuadró`);
    return respuesta;
  }
  // La hoja del recuento y la del motivo ya lo explican; con la cámara abierta también se avisa abajo
  if (respuesta.resultado === 'recontar') {
    if (Escaner.abierto()) Escaner.informar(`<b>${escaparHtml(renglon.descripcion)}</b> no cuadró: vuelve a contarlo`, { error: true });
    return contarRenglonDia(respuesta.renglon);
  }
  if (Escaner.abierto()) Escaner.informar(`<b>${escaparHtml(renglon.descripcion)}</b> sigue sin cuadrar`, { error: true });
  return pedirMotivoDia(respuesta.renglon);
}

// Escaneo con la cámara abierta: si el producto está en la lista, se pregunta cuántos hay
async function escaneoEnDia(codigo) {
  const renglon = renglonDiaPorCodigo(codigo);
  if (!renglon) {
    Escaner.informar(`El código <b>${escaparHtml(codigo)}</b> no está en la lista de hoy`, { error: true });
    return true;
  }
  Escaner.pausar(true);
  try {
    await contarRenglonDia(renglon);
  } finally {
    Escaner.pausar(false);
  }
  return true;
}

// Escrito o con lector Bluetooth: por código o por parte del nombre
async function capturarEnDia(texto) {
  const porCodigo = renglonDiaPorCodigo(texto);
  if (porCodigo) return contarRenglonDia(porCodigo);
  const buscado = texto.toLowerCase();
  const coinciden = M.dia.conteo.renglones.filter((r) => r.descripcion.toLowerCase().includes(buscado));
  if (coinciden.length === 1) return contarRenglonDia(coinciden[0]);
  if (!coinciden.length) {
    aviso(`"${texto}" no está en la lista de hoy`, 'error');
    return null;
  }
  const hoja = abrirHoja(`
    <h3>Elige el producto</h3>
    <ul class="m-resultados">${coinciden.map((r) => `<li><button data-dia-elegir="${r.id}">
      <span>${escaparHtml(r.descripcion)}<small>${escaparHtml(r.codigo_barras || 'Sin código')}</small></span>
      <span><small>${escaparHtml(textoRenglonDia(r))}</small></span></button></li>`).join('')}</ul>
    <button class="m-boton secundario" data-r="no">Cerrar</button>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
  hoja.querySelectorAll('[data-dia-elegir]').forEach((b) => b.addEventListener('click', () => {
    const renglon = coinciden.find((r) => r.id === Number(b.dataset.diaElegir));
    cerrarHoja();
    setTimeout(() => contarRenglonDia(renglon), 80);
  }));
  return null;
}

async function terminarDia({ dejarPendientes = false } = {}) {
  const c = M.dia.conteo;
  if (!dejarPendientes && c.contados === c.productos) {
    const confirmado = await confirmarHoja({
      titulo: 'Terminar el inventario del día',
      mensaje: `Se contaron los <b>${c.productos}</b> productos; <b>${c.sin_diferencia}</b> cuadraron. Las diferencias pasan al jefe para que las autorice.`,
      boton: 'Terminar',
    });
    if (!confirmado) return;
  }
  const boton = $('dia-terminar');
  boton.disabled = true;
  try {
    M.dia.conteo = await api(`/api/conteos/${c.id}/terminar`, { method: 'POST', body: { dejar_pendientes: dejarPendientes } });
    M.dia.abierto = false;
    pintarDia();
    aviso(`Listo: ${M.dia.conteo.sin_diferencia} de ${M.dia.conteo.contados} cuadraron`, 'exito');
  } catch (error) {
    if (error.codigo === 'FALTAN_POR_CONTAR') {
      const seguir = await confirmarHoja({
        titulo: 'Faltan productos',
        mensaje: `${escaparHtml(error.message)}. Si terminas ahora, esos productos quedan para otro día.`,
        boton: 'Terminar así',
      });
      if (seguir) await terminarDia({ dejarPendientes: true });
    } else {
      aviso(error.message, 'error');
    }
  } finally {
    boton.disabled = false;
  }
}

$('dia-tarjeta').addEventListener('click', (e) => {
  const accion = e.target.closest('[data-dia-accion]')?.dataset.diaAccion;
  if (accion === 'recargar') cargarDia();
  if (accion === 'abrir' && M.dia.conteo) {
    M.dia.abierto = true;
    pintarDia();
    window.scrollTo({ top: 0 });
  }
});

$('dia-volver').addEventListener('click', () => {
  M.dia.abierto = false;
  pintarDia();
});

$('dia-lista').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-dia-contar]') || e.target.closest('li[data-dia]');
  if (!boton || !M.dia.conteo) return;
  const id = Number(boton.dataset.diaContar || boton.dataset.dia);
  const renglon = M.dia.conteo.renglones.find((r) => r.id === id);
  if (renglon) contarRenglonDia(renglon);
});

$('dia-terminar').addEventListener('click', () => terminarDia());
