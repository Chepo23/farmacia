// Lo del jefe en el celular: Inicio (lo vendido hoy en cada sucursal, lo que falta autorizar y las
// alertas), Movimientos como en Eleventa y "Más" (ventas y utilidad, cortes de caja, créditos,
// inventario de las sucursales, inventarios del día con su autorización, registro de cambios y
// productos por día). Los administradores también usan Movimientos (de su sucursal). Usa las
// funciones de movil.js.
M.jefe = {
  movs: { filtros: null, lista: [], siguiente: 0, hayMas: false, q: '', cargando: false },
  cambios: { lista: [], siguiente: 0, hayMas: false },
  conteo: null,
  pantalla: '', // la que está abierta en "Más"
};

const CLASES_MOVIMIENTO = {
  venta: 'Venta', entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste', apoyo: 'Apoyo', conteo: 'Conteo',
  cancelacion: 'Venta cancelada', recepcion: 'Recepción', alta: 'Alta de producto',
};
const LISTAS_INVENTARIO = {
  bajo_minimo: 'Bajo mínimo', agotados: 'Agotados', negativos: 'Existencia negativa', sin_movimiento: 'Sin movimiento', valor: 'De más valor',
};

// 'AAAA-MM-DD' en la hora del celular
function diaLocal(dias = 0) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + dias);
  return fecha.toLocaleDateString('en-CA');
}

const piezas = (n) => `${cantidadTexto(n)} pza${Math.abs(Number(n)) === 1 ? '' : 's'}`;

// ---------- Inicio ----------
async function cargarInicio({ fresco = false } = {}) {
  const caja = $('ini-sucursales');
  $('ini-saludo').textContent = `Hola, ${String(M.usuario.nombre || '').split(' ')[0]}`;
  const hoy = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  $('ini-fecha').textContent = hoy.charAt(0).toUpperCase() + hoy.slice(1);
  if (!caja.children.length || fresco) caja.innerHTML = '<div class="m-cargando">Cargando…</div>';
  try {
    pintarInicio(await api(`/api/supervision/inicio${fresco ? '?fresco=1' : ''}`));
  } catch (error) {
    caja.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

function textoConteoHoy(c) {
  if (!c) return '<span class="m-suave">Inventario del día: todavía no lo empiezan</span>';
  if (c.estado === 'abierto') return `Inventario del día: <b>${c.contados} de ${c.productos}</b> contados${c.contados ? ` · ${c.sin_diferencia} cuadran` : ''}`;
  return `Inventario del día terminado: <b>${c.exactitud ?? 0}%</b> cuadró${c.por_autorizar ? ` · <b class="m-rojo">${c.por_autorizar} por autorizar</b>` : ''}`;
}

function chipInventario(s, lista, cantidad, extra = '') {
  const clase = !cantidad ? '' : lista === 'negativos' ? 'peligro' : 'alerta';
  return `<button class="m-chip-boton ${clase}" data-lista="${lista}" data-sucursal="${s.sucursal_id}">${LISTAS_INVENTARIO[lista]} <b>${cantidad}</b>${extra}</button>`;
}

// Lo vendido hoy en la sucursal (lo que ya subieron sus cajas)
function ventasHoyTarjeta(s) {
  const v = s.ventas_hoy;
  if (!v) {
    return `<div class="m-sucursal-fila"><b>${escaparHtml(s.sucursal)}</b><span>$0.00<small>vendido hoy</small></span></div>
      <div class="m-conteo-hoy m-suave">Todavía sin ventas hoy</div>`;
  }
  const cambio = v.cambio_semana == null ? ''
    : ` · <span class="${v.cambio_semana >= 0 ? 'm-verde' : 'm-rojo'}">${v.cambio_semana >= 0 ? '+' : ''}${v.cambio_semana}% vs. el ${escaparHtml(new Date(Date.now() - 7 * 86400000).toLocaleDateString('es-MX', { weekday: 'long' }))} pasado</span>`;
  const corte = v.ultimo_corte;
  return `<div class="m-sucursal-fila"><b>${escaparHtml(s.sucursal)}</b><span>${dinero(v.total)}<small>vendido hoy</small></span></div>
    <div class="m-conteo-hoy">${v.num_ventas} venta(s) · utilidad <b>${dinero(v.ganancia)}</b> · ticket ${dinero(v.ticket_promedio)}${cambio}${v.canceladas ? ` · <b class="m-rojo">${v.canceladas} cancelada(s)</b>` : ''}</div>
    ${corte ? `<button class="m-linea-boton" data-corte="${corte.id}">Último corte: ${escaparHtml(fechaCorta(corte.fecha))} ·
      ${Math.abs(corte.diferencia) < 0.005 ? 'cuadró' : `<b class="${corte.diferencia < 0 ? 'm-rojo' : ''}">${corte.diferencia < 0 ? 'faltaron' : 'sobraron'} ${dinero(Math.abs(corte.diferencia))}</b>`}</button>` : ''}
    ${v.creditos ? `<div class="m-conteo-hoy">Créditos por cobrar: <b>${dinero(v.creditos)}</b> (${v.clientes_con_saldo} cliente(s))</div>` : ''}`;
}

function pintarInicio(r) {
  pintarGlobosAutorizar(r.por_autorizar.length);
  $('ini-autorizar').innerHTML = r.por_autorizar.length ? `<div class="m-alerta-tarjeta">
    <b>${r.por_autorizar.length === 1 ? 'Un inventario del día por autorizar' : `${r.por_autorizar.length} inventarios del día por autorizar`}</b>
    ${r.por_autorizar.map((c) => `<button data-conteo="${c.id}"><span>${escaparHtml(c.sucursal)} · ${escaparHtml(fechaDia(`${c.fecha} 12:00:00`))}</span>
      <small>${c.por_autorizar} diferencia(s) · faltan ${dinero(c.faltante)} · sobran ${dinero(c.sobrante)}</small></button>`).join('')}
  </div>` : '';
  $('ini-sucursales').innerHTML = r.sucursales.map((s) => `
    <div class="m-sucursal-tarjeta">
      ${r.ventas_disponibles ? `${ventasHoyTarjeta(s)}<div class="m-separador"></div>
      <div class="m-conteo-hoy">Inventario: <b>${dinero(s.valor_costo)}</b> a costo · ${piezas(s.piezas)}</div>`
    : `<div class="m-sucursal-fila"><b>${escaparHtml(s.sucursal)}</b><span>${dinero(s.valor_costo)}<small>a costo · ${piezas(s.piezas)}</small></span></div>`}
      <div class="m-conteo-hoy">${textoConteoHoy(s.conteo_hoy)}</div>
      <div class="m-chips">
        ${chipInventario(s, 'bajo_minimo', s.bajo_minimo)}
        ${chipInventario(s, 'agotados', s.agotados)}
        ${chipInventario(s, 'negativos', s.negativos)}
        ${chipInventario(s, 'sin_movimiento', s.sin_movimiento, s.sin_movimiento ? ` · ${dinero(s.valor_sin_movimiento)}` : '')}
      </div>
    </div>`).join('') || '<div class="m-vacio">No hay sucursales activas.</div>';
  $('ini-alertas').innerHTML = r.alertas.map(filaCambio).join('') || '<li class="m-sin-datos">Sin alertas en los últimos 7 días.</li>';
}

function pintarGlobosAutorizar(n) {
  for (const id of ['nav-inicio', 'nav-mas', 'mas-globo-conteos']) {
    const globo = $(id);
    if (!globo) continue;
    globo.hidden = !n;
    globo.textContent = n;
  }
}

async function revisarPorAutorizar() {
  if (!esJefe()) return;
  try {
    pintarGlobosAutorizar((await api('/api/conteos?estado=por_autorizar&limite=20')).length);
  } catch { /* se intenta de nuevo más tarde */ }
}

async function verListaInventario(sucursalId, lista) {
  const sucursal = nombreSucursal(sucursalId);
  try {
    const r = await api(`/api/supervision/inventario/lista?sucursal_id=${sucursalId}&lista=${lista}`);
    const hoja = abrirHoja(`
      <h3>${escaparHtml(LISTAS_INVENTARIO[lista])} — ${escaparHtml(sucursal)}</h3>
      ${lista === 'sin_movimiento' ? '<p>Productos con piezas que no se han movido en 60 días: dinero detenido.</p>' : ''}
      <ul class="m-tabla-hoja">${r.productos.map((p) => `<li data-producto="${p.producto_id}">
        <span>${escaparHtml(p.descripcion)}</span><b>${cantidadTexto(p.existencia)}</b>
        <small>${escaparHtml(p.codigo_barras || 'Sin código')}${p.minimo > 0 ? ` · mínimo ${cantidadTexto(p.minimo)}` : ''}${p.valor_costo ? ` · ${dinero(p.valor_costo)}` : ''}${p.actualizado && lista === 'sin_movimiento' ? ` · último cambio ${escaparHtml(fechaDia(p.actualizado))}` : ''}</small>
      </li>`).join('') || '<li><span>No hay productos en esta lista.</span></li>'}</ul>
      ${r.total > r.productos.length ? `<p>Se muestran ${r.productos.length} de ${r.total}.</p>` : ''}
      <button class="m-boton secundario" data-r="no">Cerrar</button>`);
    hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
    hoja.querySelectorAll('li[data-producto]').forEach((li) => li.addEventListener('click', async () => {
      cerrarHoja();
      try {
        const producto = await productoPorId(Number(li.dataset.producto));
        mostrarVista('consultar');
        mostrarProducto(producto);
      } catch (error) {
        aviso(error.message, 'error');
      }
    }));
  } catch (error) {
    aviso(error.message, 'error');
  }
}

$('ini-actualizar').addEventListener('click', () => cargarInicio({ fresco: true }));
$('ini-autorizar').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-conteo]');
  if (boton) abrirConteoJefe(Number(boton.dataset.conteo));
});
$('ini-sucursales').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-lista]');
  if (chip) verListaInventario(Number(chip.dataset.sucursal), chip.dataset.lista);
  const corte = e.target.closest('[data-corte]');
  if (corte) verCorteJefe(Number(corte.dataset.corte));
});

// ---------- Movimientos ----------
function filaMovimientoJefe(m) {
  const cantidad = m.delta == null ? `= ${cantidadTexto(m.cantidad)}` : `${m.delta > 0 ? '+' : '−'}${cantidadTexto(Math.abs(m.delta))}`;
  const saldo = m.hay == null ? '' : `había ${m.habia == null ? '—' : cantidadTexto(m.habia)} → hay ${cantidadTexto(m.hay)}`;
  return `<li>
    <span><b>${escaparHtml(CLASES_MOVIMIENTO[m.clase] || m.clase)}</b>${M.jefe.movs.filtros?.sucursales.length > 1 ? ` · ${escaparHtml(m.sucursal)}` : ''}</span>
    <span class="${m.delta == null ? '' : m.delta > 0 ? 'mas' : 'menos'}">${cantidad}</span>
    <small class="m-mov-producto">${escaparHtml(m.producto)}</small>
    <small>${saldo ? `${saldo} · ` : ''}${escaparHtml(fechaCorta(m.fecha))} · ${escaparHtml(m.usuario || '')}${m.nota ? ` · ${escaparHtml(m.nota)}` : ''}</small>
  </li>`;
}

async function abrirMovimientos() {
  const m = M.jefe.movs;
  if (!m.filtros) {
    try {
      m.filtros = await api('/api/movimientos/filtros');
    } catch (error) {
      $('mov-lista').innerHTML = `<li class="m-sin-datos">${escaparHtml(error.message)}</li>`;
      return;
    }
    const selector = $('mov-sucursal');
    selector.innerHTML = (m.filtros.jefe ? '<option value="">Todas las sucursales</option>' : '')
      + m.filtros.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('');
    selector.hidden = !m.filtros.jefe;
  }
  cargarMovimientos();
}

function rangoMovimientos() {
  const dias = $('mov-dias').value;
  if (dias === 'ayer') return { desde: diaLocal(-1), hasta: diaLocal(-1) };
  return { desde: diaLocal(1 - Number(dias || 1)), hasta: diaLocal(0) };
}

async function cargarMovimientos({ mas = false } = {}) {
  const m = M.jefe.movs;
  if (m.cargando) return;
  m.cargando = true;
  const { desde, hasta } = rangoMovimientos();
  const parametros = new URLSearchParams({ desde, hasta, desde_fila: mas ? m.siguiente : 0 });
  if ($('mov-sucursal').value) parametros.set('sucursal_id', $('mov-sucursal').value);
  if ($('mov-tipo').value) parametros.set('tipo', $('mov-tipo').value);
  if (m.q) parametros.set('q', m.q);
  if (!mas) $('mov-lista').innerHTML = '<li class="m-sin-datos">Cargando…</li>';
  $('mov-producto').innerHTML = m.q ? `<button class="m-chip-boton activo" id="mov-quitar-producto">Producto: ${escaparHtml(m.q)} <b>✕</b></button>` : '';
  try {
    const r = await api(`/api/movimientos?${parametros}`);
    m.lista = mas ? [...m.lista, ...r.movimientos] : r.movimientos;
    m.siguiente = r.siguiente;
    m.hayMas = r.hay_mas;
    if (r.resumen) {
      const clases = Object.entries(r.resumen.por_clase).sort((a, b) => b[1].movimientos - a[1].movimientos);
      $('mov-resumen').innerHTML = clases.map(([clase, d]) => `<span class="m-chip">${escaparHtml(CLASES_MOVIMIENTO[clase] || clase)} <b>${d.movimientos}</b> · ${piezas(d.piezas)}</span>`).join('')
        + (r.fuente === 'local' ? '<span class="m-chip vencida">Sin conexión: solo lo de esta computadora</span>' : '');
    }
    $('mov-lista').innerHTML = m.lista.map(filaMovimientoJefe).join('')
      || '<li class="m-sin-datos">No hay movimientos con estos filtros. Escanea o escribe un producto para ver solo los suyos.</li>';
    $('mov-mas').hidden = !m.hayMas;
  } catch (error) {
    $('mov-lista').innerHTML = `<li class="m-sin-datos">${escaparHtml(error.message)}</li>`;
  } finally {
    m.cargando = false;
  }
}

function filtrarMovimientosPorProducto(texto) {
  M.jefe.movs.q = String(texto || '').trim();
  cargarMovimientos();
}

for (const id of ['mov-dias', 'mov-sucursal', 'mov-tipo']) $(id).addEventListener('change', () => cargarMovimientos());
$('mov-mas').addEventListener('click', () => cargarMovimientos({ mas: true }));
$('mov-producto').addEventListener('click', (e) => {
  if (e.target.closest('#mov-quitar-producto')) filtrarMovimientosPorProducto('');
});

// ---------- Registro de cambios ----------
function filaCambio(c) {
  return `<li class="${c.alerta ? 'alerta' : ''}">
    <span><b>${escaparHtml(c.titulo)}</b>${c.sucursal ? ` · ${escaparHtml(c.sucursal)}` : ''}</span>
    <span>${c.alerta ? '<svg class="icono"><use href="#i-alerta"/></svg>' : ''}</span>
    <small class="m-mov-producto">${escaparHtml(c.descripcion)}</small>
    <small>${escaparHtml(fechaCorta(c.fecha))}${c.usuario ? ` · ${escaparHtml(c.usuario)}` : ''}${c.origen === 'celular' ? ' · desde el celular' : ''}${c.por_subir ? ' · por subir' : ''}</small>
  </li>`;
}

// ---------- Más ----------
function mostrarMenuMas() {
  M.jefe.pantalla = '';
  $('mas-menu').hidden = false;
  $('mas-detalle').hidden = true;
  revisarPorAutorizar();
}

function pantallaMas(titulo, subtitulo = '', pantalla = '') {
  if (M.vista !== 'mas') mostrarVista('mas');
  M.jefe.pantalla = pantalla;
  $('mas-menu').hidden = true;
  $('mas-detalle').hidden = false;
  $('mas-titulo').textContent = titulo;
  $('mas-subtitulo').textContent = subtitulo;
  const contenido = $('mas-contenido');
  contenido.innerHTML = '<div class="m-cargando">Cargando…</div>';
  window.scrollTo({ top: 0 });
  return contenido;
}

async function pantallaInventario() {
  const caja = pantallaMas('Inventario de las sucursales', 'Toca un número para ver los productos');
  try {
    const r = await api('/api/supervision/inventario?fresco=1');
    caja.innerHTML = r.sucursales.map((s) => `
      <div class="m-sucursal-tarjeta">
        <div class="m-sucursal-fila"><b>${escaparHtml(s.sucursal)}</b><span>${dinero(s.valor_costo)}<small>a costo · a la venta ${dinero(s.valor_venta)}</small></span></div>
        <div class="m-conteo-hoy">${s.productos} productos con existencia · ${piezas(s.piezas)}</div>
        <div class="m-chips">
          ${chipInventario(s, 'bajo_minimo', s.bajo_minimo)}
          ${chipInventario(s, 'agotados', s.agotados)}
          ${chipInventario(s, 'negativos', s.negativos)}
          ${chipInventario(s, 'sin_movimiento', s.sin_movimiento, s.sin_movimiento ? ` · ${dinero(s.valor_sin_movimiento)}` : '')}
          <button class="m-chip-boton" data-lista="valor" data-sucursal="${s.sucursal_id}">De más valor</button>
        </div>
      </div>`).join('');
  } catch (error) {
    caja.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

const ESTADOS_CONTEO = { abierto: ['Contando', 'enviada'], por_autorizar: ['Por autorizar', 'vencida'], cerrado: ['Revisado', 'vendida'], cancelado: ['Cancelado', 'cancelada'] };

async function pantallaConteos() {
  const caja = pantallaMas('Inventario del día', 'Avance, exactitud y diferencias de cada sucursal');
  try {
    const conteos = await api('/api/conteos?limite=40');
    pintarGlobosAutorizar(conteos.filter((c) => c.estado === 'por_autorizar').length);
    caja.innerHTML = `<ul class="m-lista">${conteos.map((c) => {
      const [texto, clase] = ESTADOS_CONTEO[c.estado] || [c.estado, ''];
      return `<li><button class="m-cotizacion" data-conteo="${c.id}">
        <span class="m-cotizacion-fila"><b>${escaparHtml(c.sucursal)} · ${escaparHtml(fechaDia(`${c.fecha} 12:00:00`))}</b><span class="m-chip ${clase}">${texto}</span></span>
        <small>${c.contados} de ${c.productos} contados${c.contados ? ` · ${c.exactitud}% cuadró` : ''}${c.con_diferencia ? ` · faltan ${dinero(c.faltante)} · sobran ${dinero(c.sobrante)}` : ''}${c.por_autorizar ? ` · <b class="m-rojo">${c.por_autorizar} por autorizar</b>` : ''}</small>
      </button></li>`;
    }).join('') || '<li class="m-vacio">Todavía no hay inventarios del día. Se arman solos cuando una sucursal abre <b>Contar</b>.</li>'}</ul>`;
  } catch (error) {
    caja.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

function filaConteoJefe(r, conteo) {
  const propio = r.contado_por === M.usuario.id;
  const elegible = conteo.estado === 'por_autorizar' && r.decision === 'pendiente' && r.contado != null;
  const decision = { aprobado: 'Ajuste aprobado', rechazado: 'No se ajustó', cuadra: 'Cuadró', no_contado: 'No se contó', pendiente: '' }[r.decision] || '';
  const recuento = r.reconteos && r.primer_conteo != null && r.primer_conteo !== r.contado ? `contó ${cantidadTexto(r.primer_conteo)} y luego ${cantidadTexto(r.contado)}` : `contó ${cantidadTexto(r.contado)}`;
  return `<li class="m-renglon m-conteo-renglon ${r.diferencia < 0 ? 'faltan' : 'sobran'}">
    ${elegible ? `<input type="checkbox" class="m-elegir" data-renglon="${r.id}" ${propio ? 'disabled' : 'checked'} aria-label="Elegir">` : '<span></span>'}
    <div>
      <div class="m-renglon-nombre">${escaparHtml(r.descripcion)}</div>
      <div class="m-renglon-dato">Sistema ${cantidadTexto(r.existencia_sistema)} · ${recuento}${r.motivo ? ` · ${escaparHtml(r.motivo)}` : ''}</div>
      <div class="m-renglon-dato">${escaparHtml(r.contador)}${r.razon_texto ? ` · ${escaparHtml(r.razon_texto)}` : ''}${propio && elegible ? ' · <b>lo contaste tú: otro jefe lo autoriza</b>' : ''}${decision ? ` · <b>${decision}</b>${r.decisor ? ` (${escaparHtml(r.decisor)})` : ''}` : ''}</div>
    </div>
    <span class="m-diferencia ${r.diferencia < 0 ? 'menos' : 'mas'}">${r.diferencia > 0 ? '+' : '−'}${cantidadTexto(Math.abs(r.diferencia))}<small>${dinero(Math.abs(r.valor))}</small></span>
  </li>`;
}

async function abrirConteoJefe(id) {
  const caja = pantallaMas('Inventario del día', '', 'conteo');
  try {
    M.jefe.conteo = await api(`/api/conteos/${id}`);
    pintarConteoJefe();
  } catch (error) {
    caja.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

function pintarConteoJefe() {
  const c = M.jefe.conteo;
  const caja = $('mas-contenido');
  $('mas-titulo').textContent = `${c.sucursal} · ${fechaDia(`${c.fecha} 12:00:00`)}`;
  $('mas-subtitulo').textContent = `${c.contados} de ${c.productos} contados · ${c.exactitud ?? 0}% cuadró${c.terminador ? ` · terminó ${c.terminador}` : ''}`;
  const diferencias = c.renglones.filter((r) => r.contado != null && r.estado !== 'cuadra');
  const cuadran = c.renglones.filter((r) => r.estado === 'cuadra');
  const sinContar = c.renglones.filter((r) => r.contado == null);
  const elegibles = diferencias.filter((r) => c.estado === 'por_autorizar' && r.decision === 'pendiente');
  caja.innerHTML = `
    <div class="m-resumen"><span>Faltan <b>${dinero(c.faltante)}</b></span><span>Sobran <b>${dinero(c.sobrante)}</b></span></div>
    ${c.estado === 'abierto' ? '<div class="m-explicacion">Todavía lo están contando. Cuando lo terminen podrás autorizar las diferencias.</div>' : ''}
    ${elegibles.length ? '<div class="m-explicacion">Al <b>aprobar</b>, el inventario se ajusta por la diferencia (se respetan las ventas hechas después de contar). Al <b>rechazar</b> no se toca y el producto se vuelve a contar otro día.</div>' : ''}
    <div class="m-titulo-seccion">Con diferencia (${diferencias.length})</div>
    <ul class="m-lista">${diferencias.map((r) => filaConteoJefe(r, c)).join('') || '<li class="m-sin-datos">Ninguna: todo cuadró.</li>'}</ul>
    ${elegibles.length ? `<div class="m-botones-fila">
      <button class="m-boton principal" data-autorizar="aprobar">Aprobar ajuste</button>
      <button class="m-boton secundario" data-autorizar="rechazar">Rechazar</button>
    </div>` : ''}
    <div class="m-titulo-seccion">Cuadraron (${cuadran.length})</div>
    <ul class="m-tabla-hoja">${cuadran.map((r) => `<li><span>${escaparHtml(r.descripcion)}</span><b>${cantidadTexto(r.contado)}</b><small>${escaparHtml(r.contador)}</small></li>`).join('') || '<li><span>Ninguno</span></li>'}</ul>
    ${sinContar.length ? `<div class="m-titulo-seccion">Sin contar (${sinContar.length})</div>
      <ul class="m-tabla-hoja">${sinContar.map((r) => `<li><span>${escaparHtml(r.descripcion)}</span><small>${escaparHtml(r.razon_texto || '')}</small></li>`).join('')}</ul>` : ''}`;
}

async function autorizarConteo(decision) {
  const c = M.jefe.conteo;
  const ids = [...$('mas-contenido').querySelectorAll('.m-elegir:checked')].map((x) => Number(x.dataset.renglon));
  if (!ids.length) {
    aviso('Elige al menos una diferencia', 'error');
    return;
  }
  const elegidos = c.renglones.filter((r) => ids.includes(r.id));
  const valor = elegidos.reduce((t, r) => t + r.valor, 0);
  const confirmado = await confirmarHoja({
    titulo: decision === 'aprobar' ? 'Aprobar ajuste' : 'Rechazar diferencias',
    mensaje: decision === 'aprobar'
      ? `Se ajusta el inventario de <b>${elegidos.length} producto(s)</b> en ${escaparHtml(c.sucursal)} (${valor < 0 ? 'faltan' : 'sobran'} ${dinero(Math.abs(valor))}).`
      : `No se toca el inventario de <b>${elegidos.length} producto(s)</b>; se volverán a contar otro día.`,
    boton: decision === 'aprobar' ? 'Aprobar' : 'Rechazar',
    peligro: decision === 'rechazar',
  });
  if (!confirmado) return;
  try {
    M.jefe.conteo = await api(`/api/conteos/${c.id}/autorizar`, { method: 'POST', body: { [decision]: ids } });
    pintarConteoJefe();
    aviso(decision === 'aprobar' ? 'Ajuste aplicado al inventario' : 'Diferencias rechazadas', 'exito');
    revisarPorAutorizar();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function pantallaCambios({ mas = false } = {}) {
  const caja = mas ? $('mas-contenido') : pantallaMas('Registro de cambios', 'Quién cambió qué y cuándo');
  if (!mas) {
    caja.innerHTML = `<div class="m-filtros">
        <select id="cam-dias" aria-label="Días"><option value="7">Últimos 7 días</option><option value="1">Hoy</option><option value="30">Últimos 30 días</option></select>
        <select id="cam-grupo" aria-label="Qué cambios">
          <option value="">Todo</option><option value="alertas">Solo alertas</option><option value="productos">Productos y precios</option>
          <option value="caja">Caja: cancelaciones, cortes y efectivo</option><option value="usuarios">Usuarios y sucursales</option>
          <option value="apoyos">Apoyos</option><option value="cotizaciones">Cotizaciones</option><option value="conteos">Inventario del día</option>
        </select>
        <select id="cam-sucursal" aria-label="Sucursal"><option value="">Todas las sucursales</option>
          ${M.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('')}</select>
      </div>
      <ul id="cam-lista" class="m-historial m-cambios"><li class="m-sin-datos">Cargando…</li></ul>
      <button id="cam-mas" class="m-boton secundario" hidden>Ver más</button>`;
    for (const id of ['cam-dias', 'cam-grupo', 'cam-sucursal']) caja.querySelector(`#${id}`).addEventListener('change', () => pantallaCambios({ mas: 'recargar' }));
    caja.querySelector('#cam-mas').addEventListener('click', () => pantallaCambios({ mas: true }));
  }
  const estado = M.jefe.cambios;
  const continuar = mas === true;
  const dias = Number(caja.querySelector('#cam-dias').value);
  const parametros = new URLSearchParams({ desde: diaLocal(1 - dias), hasta: diaLocal(0), desde_fila: continuar ? estado.siguiente : 0 });
  if (caja.querySelector('#cam-grupo').value) parametros.set('grupo', caja.querySelector('#cam-grupo').value);
  if (caja.querySelector('#cam-sucursal').value) parametros.set('sucursal_id', caja.querySelector('#cam-sucursal').value);
  try {
    const r = await api(`/api/bitacora?${parametros}`);
    estado.lista = continuar ? [...estado.lista, ...r.cambios] : r.cambios;
    estado.siguiente = r.siguiente;
    caja.querySelector('#cam-lista').innerHTML = estado.lista.map(filaCambio).join('') || '<li class="m-sin-datos">No hay cambios con estos filtros.</li>';
    caja.querySelector('#cam-mas').hidden = !r.hay_mas;
  } catch (error) {
    caja.querySelector('#cam-lista').innerHTML = `<li class="m-sin-datos">${escaparHtml(error.message)}</li>`;
  }
}

async function pantallaConfig() {
  const caja = pantallaMas('Productos por día', 'Cuántos productos cuenta cada sucursal en el inventario del día');
  try {
    const config = await api('/api/conteos/config');
    caja.innerHTML = `<div class="m-explicacion">Con más productos se revisa todo más seguido, pero el conteo tarda más (unos 20 minutos por cada 40).
        El cambio se nota en la lista de mañana.</div>
      <ul class="m-lista">${config.map((c) => `<li class="m-renglon m-config-renglon">
        <div class="m-renglon-nombre">${escaparHtml(c.sucursal)}</div>
        <div class="m-paso"><input type="number" inputmode="numeric" min="5" max="500" step="1" value="${c.productos_por_dia}" data-cuota="${c.sucursal_id}" aria-label="Productos por día">
          <button class="m-accion chica" data-guardar-cuota="${c.sucursal_id}">Guardar</button></div>
      </li>`).join('')}</ul>`;
    caja.querySelectorAll('[data-guardar-cuota]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.guardarCuota);
      const valor = caja.querySelector(`[data-cuota="${id}"]`).value;
      try {
        await api('/api/conteos/config', { method: 'PUT', body: { sucursal_id: id, productos_por_dia: Number(valor) } });
        aviso(`Listo: ${nombreSucursal(id)} contará ${valor} productos al día`, 'exito');
      } catch (error) {
        aviso(error.message, 'error');
      }
    }));
  } catch (error) {
    caja.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

// ---------- Ventas, cortes y créditos de todas las farmacias ----------
const NOMBRES_FORMA = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', credito: 'Crédito', dolar: 'Dólares', mixto: 'Mixto' };

function filtrosVentas(prefijo, { dias = [['1', 'Hoy'], ['ayer', 'Ayer'], ['7', 'Últimos 7 días'], ['30', 'Últimos 30 días']] } = {}) {
  return `<div class="m-filtros">
    <select id="${prefijo}-dias" aria-label="Días">${dias.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    <select id="${prefijo}-sucursal" aria-label="Sucursal"><option value="">Todas las sucursales</option>
      ${M.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('')}</select>
  </div>`;
}

function parametrosVentas(prefijo) {
  const dias = $(`${prefijo}-dias`).value;
  const parametros = dias === 'ayer'
    ? new URLSearchParams({ desde: diaLocal(-1), hasta: diaLocal(-1) })
    : new URLSearchParams({ desde: diaLocal(1 - Number(dias || 1)), hasta: diaLocal(0) });
  if ($(`${prefijo}-sucursal`).value) parametros.set('sucursal_id', $(`${prefijo}-sucursal`).value);
  return parametros;
}

const listaHoja = (filas, vacio = 'Sin datos') => `<ul class="m-tabla-hoja">${filas.join('') || `<li><span>${vacio}</span></li>`}</ul>`;

async function pantallaVentas({ recargar = false } = {}) {
  const caja = recargar ? $('mas-contenido') : pantallaMas('Ventas y utilidad', 'De todas las farmacias', 'ventas');
  if (!recargar) {
    caja.innerHTML = `${filtrosVentas('ven')}<div id="ven-contenido" class="m-vista"><div class="m-cargando">Cargando…</div></div>`;
    for (const id of ['ven-dias', 'ven-sucursal']) $(id).addEventListener('change', () => pantallaVentas({ recargar: true }));
  }
  const contenido = $('ven-contenido');
  contenido.innerHTML = '<div class="m-cargando">Cargando…</div>';
  let r;
  try {
    r = await api(`/api/ventas-central/reporte?${parametrosVentas('ven')}`);
  } catch (error) {
    contenido.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
    return;
  }
  const dato = (titulo, valor, clase = '') => `<div class="m-dato ${clase}"><small>${titulo}</small><b>${valor}</b></div>`;
  contenido.innerHTML = `
    <div class="m-datos">
      ${dato('Vendido', dinero(r.total_vendido), 'grande')}
      ${dato('Utilidad', dinero(r.ganancia), 'grande')}
      ${dato('Ventas', r.num_ventas)}
      ${dato('Ticket promedio', dinero(r.ticket_promedio))}
      ${dato('Efectivo', dinero(r.efectivo))}
      ${dato('Tarjeta', dinero(r.tarjeta))}
      ${dato('Crédito', dinero(r.credito))}
      ${dato('Dólares', dinero(r.dolares))}
      ${dato('Abonos cobrados', dinero(r.abonos.total))}
      ${dato('Canceladas', r.canceladas.num ? `${r.canceladas.num} · ${dinero(r.canceladas.total)}` : '0', r.canceladas.num ? 'alerta' : '')}
    </div>
    <div class="m-titulo-seccion">Por sucursal</div>
    ${listaHoja(r.por_sucursal.map((s) => `<li><span>${escaparHtml(s.sucursal)}</span><b>${dinero(s.total)}</b><small>${s.num_ventas} venta(s)</small></li>`), 'Sin ventas')}
    <div class="m-titulo-seccion">Por cajero</div>
    ${listaHoja(r.por_cajero.map((c) => `<li><span>${escaparHtml(c.cajero)}</span><b>${dinero(c.total)}</b><small>${c.num_ventas} venta(s)</small></li>`), 'Sin ventas')}
    <div class="m-titulo-seccion">Por forma de pago</div>
    ${listaHoja(r.por_forma_pago.map((f) => `<li><span>${escaparHtml(NOMBRES_FORMA[f.forma_pago] || f.forma_pago)}</span><b>${dinero(f.total)}</b><small>${f.num_ventas} venta(s)</small></li>`), 'Sin ventas')}
    <div class="m-titulo-seccion">Por departamento</div>
    ${listaHoja(r.por_departamento.map((d) => `<li><span>${escaparHtml(d.departamento)}</span><b>${dinero(d.importe)}</b><small>${piezas(d.cantidad)} · utilidad ${dinero(d.ganancia)}</small></li>`), 'Sin ventas')}
    <div class="m-titulo-seccion">Lo más vendido</div>
    ${listaHoja(r.mas_vendidos.slice(0, 10).map((p, i) => `<li><span>${i + 1}. ${escaparHtml(p.descripcion)}</span><b>${piezas(p.cantidad)}</b><small>${dinero(p.importe)} · utilidad ${dinero(p.ganancia)}</small></li>`), 'Sin ventas')}
    ${r.canceladas_detalle.length ? `<div class="m-titulo-seccion">Ventas canceladas</div>
      ${listaHoja(r.canceladas_detalle.map((v) => `<li><span>${escaparHtml(v.sucursal)} · ${v.caja ? `${escaparHtml(v.caja)} · ` : ''}folio ${v.folio}</span><b class="m-rojo">${dinero(v.total)}</b>
        <small>${escaparHtml(fechaCorta(v.cancelada_fecha || v.fecha))} · vendió ${escaparHtml(v.vendio)} · canceló ${escaparHtml(v.cancelo)}${v.motivo ? ` · ${escaparHtml(v.motivo)}` : ''}</small></li>`))}` : ''}`;
}

const textoDiferencia = (d) => (Math.abs(d) < 0.005 ? ['Cuadró', 'vendida'] : d < 0 ? [`Faltaron ${dinero(-d)}`, 'cancelada'] : [`Sobraron ${dinero(d)}`, 'vencida']);

async function pantallaCortes({ recargar = false } = {}) {
  const caja = recargar ? $('mas-contenido') : pantallaMas('Cortes de caja', 'De todas las farmacias', 'cortes');
  if (!recargar) {
    caja.innerHTML = `${filtrosVentas('cor', { dias: [['7', 'Últimos 7 días'], ['1', 'Hoy'], ['ayer', 'Ayer'], ['30', 'Últimos 30 días']] })}
      <ul id="cor-lista" class="m-lista"><li class="m-cargando">Cargando…</li></ul>`;
    for (const id of ['cor-dias', 'cor-sucursal']) $(id).addEventListener('change', () => pantallaCortes({ recargar: true }));
  }
  try {
    const r = await api(`/api/ventas-central/cortes?${parametrosVentas('cor')}`);
    $('cor-lista').innerHTML = r.cortes.map((c) => {
      const [texto, clase] = textoDiferencia(c.diferencia);
      return `<li><button class="m-cotizacion" data-corte="${c.id}">
        <span class="m-cotizacion-fila"><b>${escaparHtml(c.sucursal)}${c.caja ? ` · ${escaparHtml(c.caja)}` : ''}</b><span class="m-chip ${clase}">${texto}</span></span>
        <small>${escaparHtml(fechaCorta(c.fecha))} · ${escaparHtml(c.usuario)} · ${c.num_ventas} venta(s) · vendido ${dinero(c.total_vendido)}${c.num_canceladas ? ` · ${c.num_canceladas} cancelada(s)` : ''}</small>
      </button></li>`;
    }).join('') || '<li class="m-vacio">No hay cortes en estos días.</li>';
  } catch (error) {
    $('cor-lista').innerHTML = `<li class="m-no-encontrados">${escaparHtml(error.message)}</li>`;
  }
}

async function verCorteJefe(id) {
  let c;
  try {
    c = await api(`/api/ventas-central/cortes/${id}`);
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  const [texto] = textoDiferencia(Number(c.diferencia) || 0);
  const e = c.estadisticas || {};
  const hoja = abrirHoja(`
    <h3>Corte · ${escaparHtml(c.sucursal)}</h3>
    <p>${escaparHtml(fechaCorta(c.fecha))} · ${escaparHtml(c.usuario || '')}</p>
    <ul class="m-tabla-hoja">
      <li><span>Vendido</span><b>${dinero(e.vendido ?? 0)}</b><small>${c.num_ventas} venta(s)${e.utilidad_bruta != null ? ` · utilidad ${dinero(e.utilidad_bruta)}` : ''}</small></li>
      <li><span>Efectivo esperado</span><b>${dinero(c.efectivo_esperado)}</b></li>
      <li><span>Efectivo contado</span><b>${dinero(c.efectivo_contado)}</b></li>
      <li class="total"><span>${texto}</span><b>${dinero(c.diferencia)}</b></li>
      <li><span>Tarjeta</span><b>${dinero(c.total_tarjeta)}</b></li>
      <li><span>Crédito</span><b>${dinero(c.total_credito)}</b></li>
      ${c.num_canceladas ? `<li><span>Canceladas</span><b>${c.num_canceladas}</b><small>${dinero(c.total_canceladas)}</small></li>` : ''}
    </ul>
    ${(c.por_cajero || []).length ? `<div class="m-titulo-seccion">Por cajero</div>${listaHoja(c.por_cajero.map((x) => `<li><span>${escaparHtml(x.cajero)}</span><b>${dinero(x.total)}</b><small>${x.num_ventas} venta(s)</small></li>`))}` : ''}
    ${(c.movimientos_caja || []).length ? `<div class="m-titulo-seccion">Entradas y salidas de efectivo</div>${listaHoja(c.movimientos_caja.map((m) => `<li><span>${m.tipo === 'salida' ? 'Salida' : 'Entrada'}: ${escaparHtml(m.concepto)}</span><b>${dinero(m.monto)}</b><small>${escaparHtml(m.usuario || '')}</small></li>`))}` : ''}
    ${(c.departamentos || []).length ? `<div class="m-titulo-seccion">Por departamento</div>${listaHoja(c.departamentos.map((d) => `<li><span>${escaparHtml(d.departamento)}</span><b>${dinero(d.total)}</b></li>`))}` : ''}
    <button class="m-boton secundario" data-r="no">Cerrar</button>`);
  hoja.querySelector('[data-r="no"]').addEventListener('click', () => cerrarHoja());
}

async function pantallaCreditos({ recargar = false } = {}) {
  const caja = recargar ? $('mas-contenido') : pantallaMas('Créditos de clientes', 'Lo que deben los clientes en cada farmacia', 'creditos');
  if (!recargar) {
    caja.innerHTML = `<div class="m-filtros"><select id="cre-sucursal" aria-label="Sucursal"><option value="">Todas las sucursales</option>
        ${M.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('')}</select></div>
      <div id="cre-contenido" class="m-vista"><div class="m-cargando">Cargando…</div></div>`;
    $('cre-sucursal').addEventListener('change', () => pantallaCreditos({ recargar: true }));
  }
  const contenido = $('cre-contenido');
  try {
    const sucursal = $('cre-sucursal').value;
    const r = await api(`/api/ventas-central/creditos${sucursal ? `?sucursal_id=${sucursal}` : ''}`);
    contenido.innerHTML = `
      <div class="m-datos"><div class="m-dato grande"><small>Por cobrar</small><b>${dinero(r.total)}</b></div>
        <div class="m-dato grande"><small>Clientes</small><b>${r.clientes.length}</b></div></div>
      ${r.por_sucursal.length > 1 ? listaHoja(r.por_sucursal.map((s) => `<li><span>${escaparHtml(s.sucursal)}</span><b>${dinero(s.saldo)}</b><small>${s.clientes} cliente(s)</small></li>`)) : ''}
      <div class="m-titulo-seccion">Clientes que deben</div>
      ${listaHoja(r.clientes.map((c) => `<li><span>${escaparHtml(c.nombre)}${c.excedido ? ' <b class="m-rojo">(pasó su límite)</b>' : ''}</span><b>${dinero(c.saldo)}</b>
        <small>${escaparHtml(c.sucursal)}${c.telefono ? ` · ${escaparHtml(c.telefono)}` : ''}${c.limite_credito ? ` · límite ${dinero(c.limite_credito)}` : ''}
          ${c.ultima_compra ? ` · compró ${escaparHtml(fechaDia(c.ultima_compra))}` : ''}${c.ultimo_abono ? ` · abonó ${escaparHtml(fechaDia(c.ultimo_abono))}` : ' · sin abonos'}</small></li>`), 'Nadie debe nada')}`;
  } catch (error) {
    contenido.innerHTML = `<div class="m-no-encontrados">${escaparHtml(error.message)}</div>`;
  }
}

$('mas-menu').addEventListener('click', (e) => {
  const opcion = e.target.closest('[data-mas]')?.dataset.mas;
  if (opcion === 'ventas') pantallaVentas();
  if (opcion === 'cortes') pantallaCortes();
  if (opcion === 'creditos') pantallaCreditos();
  if (opcion === 'inventario') pantallaInventario();
  if (opcion === 'conteos') pantallaConteos();
  if (opcion === 'cambios') pantallaCambios();
  if (opcion === 'config') pantallaConfig();
  if (opcion === 'recibir' || opcion === 'contar') mostrarVista(opcion);
});
$('mas-volver').addEventListener('click', () => {
  // Del detalle de un conteo se regresa a la lista; de lo demás, al menú
  if (M.jefe.pantalla === 'conteo') {
    M.jefe.conteo = null;
    pantallaConteos();
    return;
  }
  mostrarMenuMas();
});
$('mas-contenido').addEventListener('click', (e) => {
  const corte = e.target.closest('[data-corte]');
  if (corte) return verCorteJefe(Number(corte.dataset.corte));
  const conteo = e.target.closest('[data-conteo]');
  if (conteo) return abrirConteoJefe(Number(conteo.dataset.conteo));
  const lista = e.target.closest('[data-lista]');
  if (lista) return verListaInventario(Number(lista.dataset.sucursal), lista.dataset.lista);
  const autorizar = e.target.closest('[data-autorizar]');
  if (autorizar) autorizarConteo(autorizar.dataset.autorizar);
  return null;
});

// ---------- Productos importantes (se cuentan seguido en el inventario del día) ----------
async function pintarImportante(p) {
  try {
    const r = await api(`/api/conteos/importante/${p.id}`);
    const boton = $('consulta-importante');
    if (!boton || !M.producto || M.producto.id !== p.id) return;
    boton.disabled = false;
    boton.dataset.importante = r.importante ? '1' : '';
    boton.classList.toggle('principal', r.importante);
    boton.querySelector('span').textContent = r.importante ? 'Importante: se cuenta seguido (quitar)' : 'Marcar como importante para contarlo seguido';
  } catch {
    $('consulta-importante')?.remove();
  }
}

async function cambiarImportante(boton) {
  const marcar = !boton.dataset.importante;
  boton.disabled = true;
  try {
    await api('/api/conteos/importante', { method: 'POST', body: { producto_id: M.producto.id, importante: marcar } });
    aviso(marcar ? 'Se contará seguido en el inventario del día' : 'Vuelve a contarse por turno', 'exito');
  } catch (error) {
    aviso(error.message, 'error');
  }
  pintarImportante(M.producto);
}
