// Inventario en el celular: cada farmacia cuenta en el turno de la mañana y en el de la tarde los
// productos de su lista (la arma el jefe), ordenados por departamento. Se escanea cada uno y se escribe
// cuántas piezas hay, sin ver lo que dice el sistema. Si no cuadra se recuenta una vez; si sigue sin
// cuadrar se anota el motivo. Al terminar, la existencia se ajusta a lo contado (así el siguiente turno
// empieza con lo que de verdad hay) y el jefe lo revisa cada semana en la Revisión semanal.
// Si el jefe empezó un inventario completo (todo o un departamento), también se cuenta aquí.
// Usa las funciones de movil.js.
M.dia = { turno: null, completo: null, conteo: null, abierto: false, cargando: false, error: '', departamento: '' };

const MOTIVOS_FALTAN = ['Caducado', 'Dañado', 'No se encontró', 'Se vendió sin registrar', 'Error al recibir'];
const MOTIVOS_SOBRAN = ['Llegó mercancía sin registrar', 'Error al recibir', 'Estaba en otro lugar'];
const ESTADOS_DIA = {
  por_contar: 'Por contar',
  recontar: 'No cuadró: vuelve a contarlo',
  falta_motivo: 'Sigue sin cuadrar: falta el motivo',
  no_contado: 'No se contó',
};
// Con listas largas (un inventario completo) se muestra un departamento a la vez
const RENGLONES_A_LA_VEZ = 150;

const diaAbierto = () => Boolean(M.dia.abierto && M.dia.conteo && M.dia.conteo.estado === 'abierto');

async function cargarDia({ silencioso = false } = {}) {
  if (!M.usuario) return;
  M.dia.cargando = !silencioso || !M.dia.turno;
  M.dia.error = '';
  pintarDia();
  try {
    const hoy = await api(`/api/conteos/hoy?sucursal_id=${M.sucursalId}`);
    M.dia.turno = hoy;
    M.dia.completo = hoy.completo || null;
    // Lo que se está contando se refresca: el del turno o el inventario completo
    if (M.dia.abierto && M.dia.conteo) {
      M.dia.conteo = M.dia.conteo.turno === 'completo'
        ? await api(`/api/conteos/${M.dia.conteo.id}`)
        : (hoy.id === M.dia.conteo.id ? hoy : M.dia.conteo);
    }
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

function tarjetaConteo(c, accion) {
  const titulo = escaparHtml(c.titulo || 'Inventario');
  if (c.estado === 'abierto') {
    const empezado = c.contados > 0;
    const que = c.turno === 'completo'
      ? `Inventario completo de ${escaparHtml(c.sucursal)}${c.departamento ? ` (${escaparHtml(c.departamento)})` : ''}: ${c.productos} productos.`
      : `Toca contar ${c.productos} productos de ${escaparHtml(c.sucursal)}, ordenados por departamento.`;
    return `<div class="m-dia-tarjeta activa">
      <div class="m-dia-fila"><b>${titulo}</b><span class="m-chip enviada">${c.contados} de ${c.productos}</span></div>
      <p>${empezado ? 'Sigue donde te quedaste.' : que}</p>
      <div class="m-progreso" aria-hidden="true"><span style="width:${c.productos ? Math.round((c.contados / c.productos) * 100) : 0}%"></span></div>
      <button class="m-boton principal con-icono" data-dia-accion="${accion}"><svg class="icono"><use href="#i-contar"/></svg>${empezado ? 'Seguir contando' : 'Empezar'}</button>
    </div>`;
  }
  const ajustado = c.estado === 'cerrado';
  return `<div class="m-dia-tarjeta hecha">
    <div class="m-dia-fila"><b>${titulo} terminado</b><span class="m-chip ${ajustado ? 'vendida' : 'vencida'}">${ajustado ? 'Terminado' : 'Falta ajustar'}</span></div>
    <p>${c.sin_diferencia} de ${c.contados} productos cuadraron${c.exactitud != null ? ` (exactitud ${c.exactitud}%)` : ''}.
      ${c.con_diferencia ? (ajustado ? 'La existencia ya quedó en lo que se contó; el jefe lo revisa en la semana.' : 'El jefe ajusta las diferencias.') : ''}</p>
  </div>`;
}

function pintarTarjetaDia() {
  const caja = $('dia-tarjeta');
  const c = M.dia.turno;
  if (M.dia.cargando) {
    caja.innerHTML = '<div class="m-dia-tarjeta"><div class="m-cargando">Cargando el inventario…</div></div>';
    return;
  }
  if (M.dia.error) {
    caja.innerHTML = `<div class="m-dia-tarjeta"><b>Inventario</b><p class="m-error-texto">${escaparHtml(M.dia.error)}</p>
      <button class="m-boton secundario" data-dia-accion="recargar">Intentar de nuevo</button></div>`;
    return;
  }
  if (!c) {
    caja.innerHTML = '';
    return;
  }
  let html = '';
  if (c.sin_lista) {
    html = `<div class="m-dia-tarjeta"><b>${escaparHtml(c.titulo || 'Inventario')}</b>
      <p>El jefe todavía no arma la lista de productos que se cuentan en ${escaparHtml(c.sucursal || 'esta farmacia')}.</p></div>`;
  } else if (!c.productos) {
    html = `<div class="m-dia-tarjeta"><b>${escaparHtml(c.titulo || 'Inventario')}</b><p>La lista de esta farmacia no tiene productos.</p></div>`;
  } else {
    html = tarjetaConteo(c, 'abrir');
  }
  if (M.dia.completo && M.dia.completo.estado === 'abierto') html += tarjetaConteo(M.dia.completo, 'abrir-completo');
  caja.innerHTML = html;
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
  $('dia-titulo').textContent = c.titulo || 'Inventario';
  $('dia-subtitulo').textContent = `${c.sucursal} · ${fechaDia(`${c.fecha} 12:00:00`)}`;
  $('dia-terminar-texto').textContent = `Terminar el ${String(c.titulo || 'inventario').toLowerCase()}`;
  $('dia-contados').textContent = c.contados;
  $('dia-total').textContent = c.productos;
  $('dia-cuadran').textContent = c.sin_diferencia;
  $('dia-barra').style.width = `${c.productos ? Math.round((c.contados / c.productos) * 100) : 0}%`;

  // Lista larga: un departamento a la vez (con cuántos faltan de cada uno)
  const selector = $('dia-departamento');
  const largo = c.renglones.length > RENGLONES_A_LA_VEZ;
  selector.hidden = !largo;
  let renglones = c.renglones;
  if (largo) {
    const departamentos = new Map();
    for (const r of c.renglones) {
      const d = departamentos.get(r.departamento) || { total: 0, pendientes: 0 };
      d.total += 1;
      if (['por_contar', 'recontar', 'falta_motivo'].includes(r.estado)) d.pendientes += 1;
      departamentos.set(r.departamento, d);
    }
    if (!departamentos.has(M.dia.departamento)) {
      M.dia.departamento = [...departamentos.entries()].find(([, d]) => d.pendientes)?.[0] ?? [...departamentos.keys()][0];
    }
    selector.innerHTML = [...departamentos.entries()].map(([nombre, d]) => `<option value="${escaparHtml(nombre)}" ${nombre === M.dia.departamento ? 'selected' : ''}>
      ${escaparHtml(nombre || 'Sin departamento')} (${d.pendientes ? `faltan ${d.pendientes} de ${d.total}` : `listo, ${d.total}`})</option>`).join('');
    renglones = c.renglones.filter((r) => r.departamento === M.dia.departamento);
  }
  let departamento = null;
  $('dia-lista').innerHTML = renglones.map((r) => {
    let encabezado = '';
    if (r.departamento !== departamento) {
      departamento = r.departamento;
      encabezado = `<li class="m-dia-departamento">${escaparHtml(departamento || 'Sin departamento')}</li>`;
    }
    const pendiente = ['por_contar', 'recontar', 'falta_motivo'].includes(r.estado);
    return `${encabezado}<li class="m-renglon m-dia-renglon ${r.estado}" data-dia="${r.id}">
      <span class="m-palomita"><svg class="icono"><use href="#${r.estado === 'cuadra' ? 'i-check' : r.estado === 'por_contar' ? 'i-contar' : 'i-alerta'}"/></svg></span>
      <div><div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
        <div class="m-renglon-dato">${escaparHtml(r.codigo_barras || 'Sin código')} · ${escaparHtml(textoRenglonDia(r))}${r.piezas_caja ? ` · <b>caja c/${r.piezas_caja}: cuenta piezas</b>` : ''}</div></div>
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
  // Al escanear un producto de otro departamento, la lista salta a ese departamento
  if (c.renglones.length > RENGLONES_A_LA_VEZ && i >= 0) M.dia.departamento = c.renglones[i].departamento;
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
    mensaje: (recuento
      ? '<b>No cuadró con el sistema.</b> Cuéntalo otra vez con calma: revisa la bodega, otros estantes y las cajas abiertas.'
      : 'Cuenta todas las piezas (estante y bodega) y escribe cuántas hay.')
      + (renglon.piezas_caja
        ? `<br><b>Va en piezas, no en cajas:</b> cada caja cerrada trae ${renglon.piezas_caja}. Ej. 2 cajas y 1 suelta = ${2 * renglon.piezas_caja + 1}.`
        : ''),
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
    Escaner.informar(`El código <b>${escaparHtml(codigo)}</b> no está en esta lista`, { error: true });
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
    aviso(`"${texto}" no está en esta lista`, 'error');
    return null;
  }
  const hoja = abrirHoja(`
    <h3>Elige el producto</h3>
    <ul class="m-resultados">${coinciden.slice(0, 50).map((r) => `<li><button data-dia-elegir="${r.id}">
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
  const titulo = String(c.titulo || 'inventario').toLowerCase();
  if (!dejarPendientes && c.contados === c.productos) {
    const confirmado = await confirmarHoja({
      titulo: `Terminar el ${escaparHtml(titulo)}`,
      mensaje: `Se contaron los <b>${c.productos}</b> productos; <b>${c.sin_diferencia}</b> cuadraron. Lo que no cuadró queda con lo que contaste y el jefe lo ve en su revisión semanal.`,
      boton: 'Terminar',
    });
    if (!confirmado) return;
  }
  const boton = $('dia-terminar');
  boton.disabled = true;
  try {
    const terminado = await api(`/api/conteos/${c.id}/terminar`, { method: 'POST', body: { dejar_pendientes: dejarPendientes } });
    M.dia.abierto = false;
    aviso(`Listo: ${terminado.sin_diferencia} de ${terminado.contados} cuadraron`, 'exito');
    await cargarDia({ silencioso: true });
  } catch (error) {
    if (error.codigo === 'FALTAN_POR_CONTAR') {
      const seguir = await confirmarHoja({
        titulo: 'Faltan productos',
        mensaje: `${escaparHtml(error.message)}. Si terminas ahora, esos productos quedan sin contar.`,
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

async function abrirConteoDia(accion) {
  if (accion === 'abrir' && M.dia.turno && !M.dia.turno.sin_lista) {
    M.dia.conteo = M.dia.turno;
  } else if (accion === 'abrir-completo' && M.dia.completo) {
    try {
      M.dia.conteo = await api(`/api/conteos/${M.dia.completo.id}`);
    } catch (error) {
      aviso(error.message, 'error');
      return;
    }
  } else {
    return;
  }
  M.dia.departamento = '';
  M.dia.abierto = true;
  pintarDia();
  window.scrollTo({ top: 0 });
}

$('dia-tarjeta').addEventListener('click', (e) => {
  const accion = e.target.closest('[data-dia-accion]')?.dataset.diaAccion;
  if (accion === 'recargar') cargarDia();
  else if (accion) abrirConteoDia(accion);
});

$('dia-volver').addEventListener('click', () => {
  M.dia.abierto = false;
  pintarDia();
});

$('dia-departamento').addEventListener('change', (e) => {
  M.dia.departamento = e.target.value;
  pintarDia();
  window.scrollTo({ top: 0 });
});

$('dia-lista').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-dia-contar]') || e.target.closest('li[data-dia]');
  if (!boton || !M.dia.conteo) return;
  const id = Number(boton.dataset.diaContar || boton.dataset.dia);
  const renglon = M.dia.conteo.renglones.find((r) => r.id === id);
  if (renglon) contarRenglonDia(renglon);
});

$('dia-terminar').addEventListener('click', () => terminarDia());
