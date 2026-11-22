// Movimientos (administradores y jefe): los movimientos de inventario como en Eleventa y el
// inventario del día. El jefe además ve el resumen de todas las sucursales (con lo vendido hoy),
// autoriza las diferencias del inventario del día, consulta y reimprime los cortes de todas las
// farmacias, ve los créditos de clientes y el registro de cambios. Sus reportes de ventas de todas
// las farmacias están en la pestaña Reportes.
const Sup = {
  vista: null,
  filtros: null,
  movs: { lista: [], siguiente: 0 },
  cambios: { lista: [], siguiente: 0 },
  conteo: null,
};

const SUP_CLASES = {
  venta: 'Venta', entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste', apoyo: 'Apoyo', conteo: 'Conteo',
  cancelacion: 'Venta cancelada', recepcion: 'Recepción', alta: 'Alta de producto', prestamo: 'Préstamo',
};
const SUP_LISTAS = {
  bajo_minimo: 'Bajo mínimo', agotados: 'Agotados', negativos: 'Existencia negativa', sin_movimiento: 'Sin movimiento (60 días)', valor: 'De más valor',
};
const SUP_ESTADOS_CONTEO = { abierto: ['Contando', 'enviado'], por_autorizar: ['Falta ajustar', 'faltante'], cerrado: ['Terminado', 'recibido'], cancelado: ['Cancelado', 'cancelado'] };

const supEsJefe = () => Number(App.usuario?.jefe) === 1;
const supNumero = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);
const supDia = (dias = 0) => {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + dias);
  return fecha.toLocaleDateString('en-CA');
};
// "2026-11-08T18:30:00Z" (central) o "2026-11-08 12:30:00" (esta computadora)
function supFecha(texto) {
  const valor = String(texto || '');
  const fecha = new Date(valor.includes('T') ? valor : valor.replace(' ', 'T'));
  if (Number.isNaN(fecha.getTime())) return valor;
  return fecha.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
const supDiaCorto = (dia) => new Date(`${dia}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });

function mostrarVistaSup(vista) {
  const permitidas = supEsJefe() ? ['resumen', 'movimientos', 'conteos', 'semana', 'cortes', 'creditos', 'cambios'] : ['movimientos', 'conteos'];
  Sup.vista = permitidas.includes(vista) ? vista : permitidas[0];
  document.querySelectorAll('.vista-sup').forEach((v) => { v.hidden = v.id !== `sup-${Sup.vista}`; });
  document.querySelectorAll('[data-vista-sup]').forEach((b) => b.classList.toggle('primario', b.dataset.vistaSup === Sup.vista));
  if (Sup.vista === 'resumen') cargarResumenSup();
  if (Sup.vista === 'movimientos') cargarMovimientosSup();
  if (Sup.vista === 'conteos') cargarConteosSup();
  if (Sup.vista === 'semana') cargarSemanaSup();
  if (Sup.vista === 'cambios') cargarCambiosSup();
  if (Sup.vista === 'cortes') cargarCortesSup();
  if (Sup.vista === 'creditos') cargarCreditosSup();
}

async function prepararFiltrosSup() {
  if (Sup.filtros) return;
  Sup.filtros = await api('/api/movimientos/filtros');
  const opcionesSucursal = (Sup.filtros.jefe ? '<option value="">Todas las sucursales</option>' : '')
    + Sup.filtros.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('');
  const opcionesUsuario = '<option value="">Todas las personas</option>'
    + Sup.filtros.usuarios.map((u) => `<option value="${u.id}">${escaparHtml(u.nombre)}${u.activo ? '' : ' (baja)'}</option>`).join('');
  for (const id of ['sup-mov-sucursal', 'sup-cam-sucursal', 'sup-cor-sucursal', 'sup-cre-sucursal']) document.getElementById(id).innerHTML = opcionesSucursal;
  for (const id of ['sup-mov-usuario', 'sup-cam-usuario']) document.getElementById(id).innerHTML = opcionesUsuario;
  document.getElementById('sup-mov-sucursal').hidden = !Sup.filtros.jefe;
  document.getElementById('sup-mov-desde').value = supDia(0);
  document.getElementById('sup-mov-hasta').value = supDia(0);
  document.getElementById('sup-cam-desde').value = supDia(-6);
  document.getElementById('sup-cam-hasta').value = supDia(0);
  document.getElementById('sup-cor-desde').value = supDia(-6);
  document.getElementById('sup-cor-hasta').value = supDia(0);
}

async function abrirSupervision() {
  document.getElementById('sup-titulo').textContent = supEsJefe() ? 'Supervisión' : 'Movimientos';
  try {
    await prepararFiltrosSup();
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  mostrarVistaSup(Sup.vista || (supEsJefe() ? 'resumen' : 'movimientos'));
}

// ---------- Resumen del jefe ----------
function supChip(s, lista, cantidad, extra = '') {
  const clase = !cantidad ? '' : lista === 'negativos' ? 'peligro' : 'alerta';
  return `<button class="sup-chip ${clase}" type="button" data-lista="${lista}" data-sucursal="${s.sucursal_id}">${SUP_LISTAS[lista]} <b>${cantidad}</b>${extra}</button>`;
}

function supTurno(c, nombre) {
  if (!c) return `${nombre}: <span class="texto-suave">por empezar</span>`;
  if (c.estado === 'abierto') return `${nombre}: <b>${c.contados} de ${c.productos}</b> contados`;
  if (c.estado === 'cancelado') return `${nombre}: cancelado`;
  return `${nombre}: <b>${c.exactitud ?? 0}%</b> cuadró${c.por_autorizar ? ` · <b class="texto-peligro">${c.por_autorizar} por autorizar</b>` : ''}`;
}

// Los dos turnos de hoy (y el inventario completo, si hay uno abierto)
function supInventarioHoy(s) {
  const i = s.inventario_hoy;
  if (!i) return supTurno(s.conteo_hoy, 'Inventario');
  if (!i.en_lista && !i.manana && !i.tarde) return '<span class="texto-suave">Inventario: sin lista (ármala en Inventarios → Lista del inventario)</span>';
  return `${supTurno(i.manana, 'Mañana')} · ${supTurno(i.tarde, 'Tarde')}${i.completo ? ` · Completo: <b>${i.completo.contados} de ${i.completo.productos}</b>` : ''}`;
}

function supVentasHoy(v) {
  if (!v) return '<div class="texto-suave">Todavía sin ventas hoy.</div>';
  const corte = v.ultimo_corte;
  const diferencia = corte ? (Math.abs(corte.diferencia) < 0.005 ? 'cuadró'
    : `<b class="${corte.diferencia < 0 ? 'texto-peligro' : ''}">${corte.diferencia < 0 ? 'faltaron' : 'sobraron'} ${dinero(Math.abs(corte.diferencia))}</b>`) : '';
  return `<div class="sup-datos">
      <span><small>Ventas hoy</small><b>${v.num_ventas}</b></span>
      <span><small>Utilidad hoy</small><b>${dinero(v.ganancia)}</b></span>
      <span><small>Ticket promedio</small><b>${dinero(v.ticket_promedio)}</b></span>
    </div>
    <div class="texto-suave">${v.cambio_semana == null ? 'Sin ventas el mismo día de la semana pasada' : `${v.cambio_semana >= 0 ? '+' : ''}${v.cambio_semana}% contra el mismo día de la semana pasada (a esta hora)`}${v.canceladas ? ` · <b class="texto-peligro">${v.canceladas} cancelada(s)</b>` : ''}</div>
    ${corte ? `<div>Último corte: ${escaparHtml(supFecha(corte.fecha))} (${escaparHtml(corte.usuario)}), ${diferencia}
      <button class="boton chico" type="button" data-ver-corte="${corte.id}">Ver</button></div>` : ''}
    ${v.creditos ? `<div>Créditos por cobrar: <b>${dinero(v.creditos)}</b> (${v.clientes_con_saldo} cliente(s))</div>` : ''}`;
}

function filaCambioSup(c) {
  return `<tr class="${c.alerta ? 'fila-alerta' : ''}">
    <td style="white-space:nowrap">${escaparHtml(supFecha(c.fecha))}</td>
    <td>${escaparHtml(c.sucursal || '')}</td>
    <td>${escaparHtml(c.usuario || '')}${c.origen === 'celular' ? ' <small class="texto-suave">(celular)</small>' : ''}${c.por_subir ? ' <small class="texto-suave">(por subir)</small>' : ''}</td>
    <td><b>${c.alerta ? '⚠ ' : ''}${escaparHtml(c.titulo)}</b></td>
    <td>${escaparHtml(c.descripcion)}</td>
  </tr>`;
}

async function cargarResumenSup({ fresco = false } = {}) {
  const caja = document.getElementById('sup-sucursales');
  if (!caja.children.length || fresco) caja.innerHTML = '<p class="texto-suave">Cargando…</p>';
  let r;
  try {
    r = await api(`/api/supervision/inicio${fresco ? '?fresco=1' : ''}`);
  } catch (error) {
    caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
    return;
  }
  pintarAvisoSup(r.por_autorizar.length);
  document.getElementById('sup-resumen-fecha').textContent = `Inventario leído de la central: ${fechaHora(r.inventario_leido)}`;
  document.getElementById('sup-por-autorizar').innerHTML = r.por_autorizar.length ? `<div class="franja-aviso sup-autorizar">
    <b>${r.por_autorizar.length === 1 ? 'Un inventario por autorizar' : `${r.por_autorizar.length} inventarios por autorizar`}:</b>
    ${r.por_autorizar.map((c) => `<button class="boton chico" type="button" data-conteo="${c.id}">${escaparHtml(c.sucursal)} · ${escaparHtml(c.titulo || 'Inventario')} · ${escaparHtml(supDiaCorto(c.fecha))}
      (${c.por_autorizar} diferencia(s), faltan ${dinero(c.faltante)}, sobran ${dinero(c.sobrante)})</button>`).join(' ')}
  </div>` : '';
  caja.innerHTML = r.sucursales.map((s) => `
    <div class="tarjeta sup-sucursal">
      <h3>${escaparHtml(s.sucursal)} <span>${r.ventas_disponibles ? `${dinero(s.ventas_hoy ? s.ventas_hoy.total : 0)} <small>vendido hoy</small>` : `${dinero(s.valor_costo)} <small>a costo</small>`}</span></h3>
      ${r.ventas_disponibles ? supVentasHoy(s.ventas_hoy) : ''}
      <div class="sup-datos">
        ${r.ventas_disponibles ? `<span><small>Inventario a costo</small><b>${dinero(s.valor_costo)}</b></span>` : ''}
        <span><small>Productos con existencia</small><b>${s.productos}</b></span>
        <span><small>Piezas</small><b>${supNumero(s.piezas)}</b></span>
        <span><small>A precio de venta</small><b>${dinero(s.valor_venta)}</b></span>
      </div>
      <div>${supInventarioHoy(s)}</div>
      <div class="sup-chips">
        ${supChip(s, 'bajo_minimo', s.bajo_minimo)}
        ${supChip(s, 'agotados', s.agotados)}
        ${supChip(s, 'negativos', s.negativos)}
        ${supChip(s, 'sin_movimiento', s.sin_movimiento, s.sin_movimiento ? ` · ${dinero(s.valor_sin_movimiento)}` : '')}
        <button class="sup-chip" type="button" data-lista="valor" data-sucursal="${s.sucursal_id}">De más valor</button>
      </div>
    </div>`).join('');
  document.getElementById('sup-alertas').innerHTML = r.alertas.map((c) => `<tr>
      <td style="white-space:nowrap">${escaparHtml(supFecha(c.fecha))}</td><td>${escaparHtml(c.sucursal || '')}</td>
      <td><b>${escaparHtml(c.titulo)}</b></td><td>${escaparHtml(c.descripcion)}</td><td>${escaparHtml(c.usuario || '')}</td></tr>`).join('')
    || '<tr><td colspan="5">Sin alertas en los últimos 7 días.</td></tr>';
}

async function verListaSup(sucursalId, lista) {
  const sucursal = (App.sucursales.find((s) => Number(s.id) === sucursalId) || {}).nombre || '';
  let r;
  try {
    r = await api(`/api/supervision/inventario/lista?sucursal_id=${sucursalId}&lista=${lista}`);
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  const modal = abrirModal(`
    <h3>${escaparHtml(SUP_LISTAS[lista])} — ${escaparHtml(sucursal)}</h3>
    ${lista === 'sin_movimiento' ? '<p class="texto-suave">Productos con piezas que no se han movido en 60 días: dinero detenido.</p>' : ''}
    <div class="contenedor-tabla"><table class="tabla"><thead><tr><th>Producto</th><th>Código</th><th class="num">Existencia</th><th class="num">Mínimo</th><th class="num">Valor a costo</th><th>Último cambio</th></tr></thead>
      <tbody>${r.productos.map((p) => `<tr><td>${escaparHtml(p.descripcion)}</td><td>${escaparHtml(p.codigo_barras || '')}</td>
        <td class="num">${supNumero(p.existencia)}</td><td class="num">${supNumero(p.minimo)}</td><td class="num">${dinero(p.valor_costo)}</td>
        <td>${p.actualizado ? escaparHtml(supFecha(p.actualizado)) : ''}</td></tr>`).join('') || '<tr><td colspan="6">No hay productos en esta lista.</td></tr>'}</tbody></table></div>
    ${r.total > r.productos.length ? `<p class="texto-suave">Se muestran ${r.productos.length} de ${r.total}.</p>` : ''}
    <div class="pie"><button class="boton" data-cerrar>Cerrar</button></div>`);
  modal.classList.add('grande');
  modal.querySelector('[data-cerrar]').addEventListener('click', cerrarModal);
}

function pintarAvisoSup(n) {
  const globo = document.getElementById('aviso-supervision');
  globo.hidden = !n;
  globo.textContent = n;
}

async function revisarAvisoSup() {
  if (!supEsJefe()) return;
  try {
    pintarAvisoSup((await api('/api/conteos?estado=por_autorizar&limite=20')).length);
  } catch { /* sin conexión: se intenta más tarde */ }
}

// ---------- Movimientos ----------
function filaMovimientoSup(m) {
  const cantidad = m.delta == null ? `= ${supNumero(m.cantidad)}` : `${m.delta > 0 ? '+' : '−'}${supNumero(Math.abs(m.delta))}`;
  return `<tr>
    <td style="white-space:nowrap">${escaparHtml(supFecha(m.fecha))}</td>
    <td>${escaparHtml(m.sucursal)}</td>
    <td>${escaparHtml(m.producto)}<small class="texto-suave sup-codigo">${escaparHtml(m.codigo_barras || '')}</small></td>
    <td><span class="sup-clase" data-clase="${escaparHtml(m.clase)}">${escaparHtml(SUP_CLASES[m.clase] || m.clase)}</span></td>
    <td class="num ${m.delta == null ? '' : m.delta > 0 ? 'texto-exito' : 'texto-peligro'}"><b>${cantidad}</b></td>
    <td class="num">${m.habia == null ? '—' : supNumero(m.habia)}</td>
    <td class="num"><b>${m.hay == null ? '—' : supNumero(m.hay)}</b></td>
    <td>${escaparHtml(m.usuario || '')}</td>
    <td class="sup-nota">${escaparHtml(m.nota || '')}</td>
  </tr>`;
}

async function cargarMovimientosSup({ mas = false } = {}) {
  const parametros = new URLSearchParams({
    desde: document.getElementById('sup-mov-desde').value,
    hasta: document.getElementById('sup-mov-hasta').value,
    desde_fila: mas ? Sup.movs.siguiente : 0,
  });
  for (const [campo, id] of [['sucursal_id', 'sup-mov-sucursal'], ['tipo', 'sup-mov-tipo'], ['usuario_id', 'sup-mov-usuario'], ['q', 'sup-mov-producto']]) {
    const valor = document.getElementById(id).value.trim();
    if (valor) parametros.set(campo, valor);
  }
  const cuerpo = document.getElementById('sup-mov-cuerpo');
  if (!mas) cuerpo.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>';
  let r;
  try {
    r = await api(`/api/movimientos?${parametros}`);
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="9">${escaparHtml(error.message)}</td></tr>`;
    return;
  }
  Sup.movs.lista = mas ? [...Sup.movs.lista, ...r.movimientos] : r.movimientos;
  Sup.movs.siguiente = r.siguiente;
  if (r.resumen) {
    const clases = Object.entries(r.resumen.por_clase).sort((a, b) => b[1].movimientos - a[1].movimientos);
    document.getElementById('sup-mov-resumen').innerHTML = `<span class="sup-chip">Movimientos <b>${r.resumen.total}${r.resumen.parcial ? '+' : ''}</b></span>`
      + clases.map(([clase, d]) => `<span class="sup-chip">${escaparHtml(SUP_CLASES[clase] || clase)} <b>${d.movimientos}</b> · ${supNumero(d.piezas)} pzas</span>`).join('');
  }
  const avisoLocal = document.getElementById('sup-mov-aviso');
  avisoLocal.hidden = r.fuente !== 'local';
  avisoLocal.textContent = App.usuario.modo === 'central'
    ? 'Sin conexión con la central: solo se ven los movimientos hechos en esta computadora.'
    : 'Movimientos de esta computadora.';
  cuerpo.innerHTML = Sup.movs.lista.map(filaMovimientoSup).join('') || '<tr><td colspan="9">No hay movimientos con estos filtros.</td></tr>';
  document.getElementById('sup-mov-mas').hidden = !r.hay_mas;
}

// ---------- Inventarios (turnos de mañana y tarde, completos) ----------
async function cargarConteosSup() {
  const cuerpo = document.getElementById('sup-conteos-cuerpo');
  cuerpo.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>';
  try {
    const conteos = await api('/api/conteos?limite=40');
    if (supEsJefe()) pintarAvisoSup(conteos.filter((c) => c.estado === 'por_autorizar').length);
    cuerpo.innerHTML = conteos.map((c) => {
      const [texto, clase] = SUP_ESTADOS_CONTEO[c.estado] || [c.estado, ''];
      return `<tr class="fila-clic ${Sup.conteo && Sup.conteo.id === c.id ? 'fila-destacada' : ''}" data-conteo="${c.id}">
        <td style="white-space:nowrap">${escaparHtml(supDiaCorto(c.fecha))}</td><td>${escaparHtml(c.sucursal)}</td><td>${escaparHtml(c.titulo || 'Inventario')}</td><td><span class="chip ${clase}">${texto}</span></td>
        <td class="num">${c.contados} de ${c.productos}</td><td class="num">${c.contados ? `${c.exactitud}%` : '—'}</td>
        <td class="num">${c.faltante ? dinero(c.faltante) : '—'}</td><td class="num">${c.sobrante ? dinero(c.sobrante) : '—'}</td>
        <td class="num">${c.por_autorizar ? `<b class="texto-peligro">${c.por_autorizar}</b>` : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="9">Todavía no hay inventarios: se arman solos cuando una sucursal con lista abre <b>Contar</b> en el celular.</td></tr>';
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="9">${escaparHtml(error.message)}</td></tr>`;
  }
  if (supEsJefe()) cargarListaSup();
}

// ---------- Lista del inventario de cada farmacia (la arma el jefe) ----------
async function cargarListaSup(sucursalId = null) {
  const caja = document.getElementById('sup-lista');
  if (!caja) return;
  try {
    const id = sucursalId || (Sup.lista && Sup.lista.sucursal_id) || '';
    const [lista, departamentos] = await Promise.all([
      api(`/api/conteos/lista${id ? `?sucursal_id=${id}` : ''}`),
      Sup.departamentos ? Promise.resolve(Sup.departamentos) : api('/api/departamentos').catch(() => []),
    ]);
    Sup.lista = lista;
    Sup.departamentos = departamentos;
    pintarListaSup();
  } catch (error) {
    caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
  }
}

function pintarListaSup() {
  const l = Sup.lista;
  const caja = document.getElementById('sup-lista');
  const deptos = (Sup.departamentos || []).map((d) => `<option value="${escaparHtml(d.nombre)}">${escaparHtml(d.nombre)}</option>`).join('');
  const otras = l.sucursales.filter((s) => s.id !== l.sucursal_id);
  const c = l.completo;
  caja.innerHTML = `
    <div class="sup-lista-fila">
      <label>Farmacia <select class="entrada" id="sup-lista-sucursal">${l.sucursales.map((s) => `<option value="${s.id}" ${s.id === l.sucursal_id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('')}</select></label>
      <label>La tarde empieza a las <input class="entrada" type="time" id="sup-lista-hora" value="${escaparHtml(l.hora_tarde)}"></label>
      <button class="boton chico" type="button" data-lista-sup="hora">Guardar hora</button>
    </div>
    <p class="texto-suave"><b>${l.total}</b> producto(s) en la lista${l.total ? ` · unos ${l.minutos_por_turno} minutos por turno` : ''}.</p>
    <div class="sup-lista-fila">
      <input class="entrada" id="sup-lista-buscar" type="search" placeholder="Busca un producto por nombre o código para agregarlo" autocomplete="off">
      <button class="boton chico" type="button" data-lista-sup="buscar">Buscar</button>
    </div>
    <div id="sup-lista-resultados"></div>
    <div class="sup-lista-fila">
      <select class="entrada" id="sup-lista-depto"><option value="">Un departamento completo…</option>${deptos}</select>
      <button class="boton chico" type="button" data-lista-sup="depto">Agregar departamento</button>
      ${otras.length ? `<select class="entrada" id="sup-lista-copiar">${otras.map((s) => `<option value="${s.id}">La lista de ${escaparHtml(s.nombre)}</option>`).join('')}</select>
      <button class="boton chico" type="button" data-lista-sup="copiar">Copiar</button>` : ''}
    </div>
    <div class="contenedor-tabla sup-lista-tabla"><table class="tabla">
      <thead><tr><th>Producto</th><th>Código</th><th>Departamento</th><th></th></tr></thead>
      <tbody>${l.productos.map((p) => `<tr><td>${escaparHtml(p.descripcion)}</td><td>${escaparHtml(p.codigo_barras || '')}</td><td>${escaparHtml(p.departamento || '')}</td>
        <td><button class="boton chico" type="button" data-lista-quitar-sup="${p.producto_id}">Quitar</button></td></tr>`).join('')
        || '<tr><td colspan="4">Todavía no hay productos. Búscalos arriba, agrega un departamento o márcalos al consultarlos en el celular.</td></tr>'}</tbody>
    </table></div>
    ${l.total ? '<button class="boton chico peligro-suave" type="button" data-lista-sup="vaciar">Quitar todos</button>' : ''}
    <h4>Inventario completo</h4>
    ${c ? `<p>Hay uno abierto: <b>${escaparHtml(c.titulo)}</b>, ${c.contados} de ${c.productos} contados. La farmacia lo cuenta en el celular (Contar).</p>
      <button class="boton chico" type="button" data-lista-sup="cancelar-completo" data-conteo-id="${c.id}">Cancelar el inventario completo</button>`
    : `<p class="texto-suave">Para contar todos los productos (o un departamento) una sola vez. Se cuenta en el celular igual que la lista y queda abierto hasta que se termine.</p>
      <div class="sup-lista-fila"><select class="entrada" id="sup-lista-completo"><option value="">Todos los productos</option>${deptos}</select>
        <button class="boton chico primario" type="button" data-lista-sup="completo">Empezar inventario completo</button></div>`}`;
}

async function buscarListaSup() {
  const texto = document.getElementById('sup-lista-buscar').value.trim();
  const caja = document.getElementById('sup-lista-resultados');
  if (!texto) {
    caja.innerHTML = '';
    return;
  }
  caja.innerHTML = '<p class="texto-suave">Buscando…</p>';
  try {
    const enLista = new Set(Sup.lista.productos.map((p) => p.producto_id));
    const encontrados = (await api(`/api/productos/buscar?q=${encodeURIComponent(texto)}`)).filter((p) => p.usa_inventario !== false).slice(0, 20);
    caja.innerHTML = encontrados.length ? `<div class="contenedor-tabla"><table class="tabla"><tbody>${encontrados.map((p) => `<tr>
      <td>${escaparHtml(p.descripcion)}</td><td>${escaparHtml(p.codigo_barras || '')}</td><td>${escaparHtml(p.departamento || '')}</td>
      <td>${enLista.has(p.id) ? '<span class="texto-suave">Ya está</span>' : `<button class="boton chico exito" type="button" data-lista-agregar-sup="${p.id}">Agregar</button>`}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="texto-suave">No se encontró ningún producto que use inventario.</p>';
  } catch (error) {
    caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
  }
}

async function accionListaSup(boton) {
  const l = Sup.lista;
  const sucursal = l.sucursal_id;
  const accion = boton.dataset.listaSup;
  const agregados = (r) => aviso(`Se agregaron ${r.agregados} producto(s)${r.ya_estaban ? ` (${r.ya_estaban} ya estaban)` : ''}`, 'exito');
  try {
    if (boton.dataset.listaAgregarSup) {
      Sup.lista = await api('/api/conteos/lista', { method: 'POST', body: { sucursal_id: sucursal, producto_ids: [Number(boton.dataset.listaAgregarSup)] } });
      const buscado = document.getElementById('sup-lista-buscar').value;
      pintarListaSup();
      document.getElementById('sup-lista-buscar').value = buscado;
      buscarListaSup();
      aviso('Agregado a la lista', 'exito');
      return;
    }
    if (boton.dataset.listaQuitarSup) {
      Sup.lista = await api('/api/conteos/lista/quitar', { method: 'POST', body: { sucursal_id: sucursal, producto_ids: [Number(boton.dataset.listaQuitarSup)] } });
      pintarListaSup();
      aviso('Se quitó de la lista', 'exito');
      return;
    }
    if (accion === 'buscar') {
      buscarListaSup();
      return;
    }
    if (accion === 'hora') {
      const hora = document.getElementById('sup-lista-hora').value;
      await api('/api/conteos/config', { method: 'PUT', body: { sucursal_id: sucursal, hora_tarde: hora } });
      aviso(`Listo: en ${l.sucursal} la tarde empieza a las ${hora}`, 'exito');
      cargarListaSup(sucursal);
      return;
    }
    if (accion === 'depto') {
      const depto = document.getElementById('sup-lista-depto').value;
      if (!depto) {
        aviso('Elige un departamento', 'error');
        return;
      }
      Sup.lista = await api('/api/conteos/lista', { method: 'POST', body: { sucursal_id: sucursal, departamento: depto } });
      agregados(Sup.lista);
      pintarListaSup();
      return;
    }
    if (accion === 'copiar') {
      Sup.lista = await api('/api/conteos/lista', { method: 'POST', body: { sucursal_id: sucursal, copiar_de: Number(document.getElementById('sup-lista-copiar').value) } });
      agregados(Sup.lista);
      pintarListaSup();
      return;
    }
    if (accion === 'vaciar') {
      const seguro = await confirmar({ titulo: 'Quitar todos', mensaje: `Se queda vacía la lista de ${l.sucursal}: no se contará nada en los turnos hasta que agregues productos.`, boton: 'Quitar todos', peligro: true });
      if (!seguro) return;
      Sup.lista = await api('/api/conteos/lista/quitar', { method: 'POST', body: { sucursal_id: sucursal, todo: true } });
      pintarListaSup();
      return;
    }
    if (accion === 'completo') {
      const depto = document.getElementById('sup-lista-completo').value;
      const seguro = await confirmar({
        titulo: 'Empezar inventario completo',
        mensaje: `${l.sucursal} contará ${depto ? `todo el departamento ${depto}` : 'todos los productos que usan inventario'} en el celular (Contar), a ciegas como la lista. Las diferencias las autoriza un jefe.`,
        boton: 'Empezar',
      });
      if (!seguro) return;
      const c = await api('/api/conteos/completo', { method: 'POST', body: { sucursal_id: sucursal, departamento: depto } });
      aviso(`Listo: ${c.productos} productos por contar`, 'exito');
      cargarListaSup(sucursal);
      cargarConteosSup();
      return;
    }
    if (accion === 'cancelar-completo') {
      const seguro = await confirmar({ titulo: 'Cancelar el inventario completo', mensaje: 'Lo que ya se contó no ajusta el inventario.', boton: 'Cancelarlo', peligro: true });
      if (!seguro) return;
      await api(`/api/conteos/${Number(boton.dataset.conteoId)}/cancelar`, { method: 'POST', body: {} });
      aviso('Inventario completo cancelado', 'exito');
      cargarListaSup(sucursal);
      cargarConteosSup();
    }
  } catch (error) {
    aviso(error.message, 'error');
  }
}

async function abrirConteoSup(id) {
  const caja = document.getElementById('sup-conteo-detalle');
  caja.innerHTML = '<h3>Detalle</h3><p class="texto-suave">Cargando…</p>';
  try {
    Sup.conteo = await api(`/api/conteos/${id}`);
  } catch (error) {
    caja.innerHTML = `<h3>Detalle</h3><div class="mensaje-error">${escaparHtml(error.message)}</div>`;
    return;
  }
  pintarConteoSup();
  document.querySelectorAll('#sup-conteos-cuerpo tr').forEach((tr) => tr.classList.toggle('fila-destacada', Number(tr.dataset.conteo) === id));
}

function pintarConteoSup() {
  const c = Sup.conteo;
  const caja = document.getElementById('sup-conteo-detalle');
  const completo = c.completo;
  const diferencias = c.renglones.filter((r) => r.contado != null && r.estado !== 'cuadra');
  const resto = c.renglones.filter((r) => r.contado == null || r.estado === 'cuadra');
  const puedeAutorizar = completo && c.estado === 'por_autorizar';
  const estadoTexto = (r) => ({
    cuadra: 'Cuadró', no_contado: 'No se contó', por_contar: 'Por contar', recontar: 'Falta recontar', falta_motivo: 'Falta el motivo',
  })[r.estado] || '';
  const decisionTexto = (r) => ({ aprobado: r.decisor ? 'Ajuste aprobado' : 'Se ajustó al terminar', rechazado: 'No se ajustó' })[r.decision] || '';
  caja.innerHTML = `
    <h3>${escaparHtml(c.sucursal)} · ${escaparHtml(c.titulo || 'Inventario')} · ${escaparHtml(supDiaCorto(c.fecha))} <span class="chip ${(SUP_ESTADOS_CONTEO[c.estado] || [])[1] || ''}">${(SUP_ESTADOS_CONTEO[c.estado] || [c.estado])[0]}</span></h3>
    <div class="sup-datos">
      <span><small>Contados</small><b>${c.contados} de ${c.productos}</b></span>
      <span><small>Cuadró</small><b>${c.exactitud ?? 0}%</b></span>
      <span><small>Faltan</small><b class="texto-peligro">${dinero(c.faltante)}</b></span>
      <span><small>Sobran</small><b>${dinero(c.sobrante)}</b></span>
    </div>
    ${c.terminador ? `<p class="texto-suave">Terminó ${escaparHtml(c.terminador)}${c.cerrador ? ` · revisó ${escaparHtml(c.cerrador)}` : ''}${c.nota ? ` · ${escaparHtml(c.nota)}` : ''}</p>` : ''}
    ${puedeAutorizar ? '<p class="texto-suave">Al <b>aprobar</b> el inventario se ajusta por la diferencia (se respetan las ventas hechas después de contar). Al <b>rechazar</b> no se toca. Nadie autoriza lo que él mismo contó.</p>' : ''}
    ${completo && c.turno === 'completo' && c.estado === 'abierto' ? `<button class="boton chico" type="button" data-lista-sup="cancelar-completo" data-conteo-id="${c.id}">Cancelar el inventario completo</button>` : ''}
    <div class="contenedor-tabla"><table class="tabla">
      <thead><tr>${puedeAutorizar ? '<th></th>' : ''}<th>Producto</th>${completo ? '<th class="num">Sistema</th>' : ''}<th class="num">Contado</th>${completo ? '<th class="num">Diferencia</th><th class="num">Valor</th>' : ''}<th>Motivo</th><th>Contó</th><th>Estado</th></tr></thead>
      <tbody>${[...diferencias, ...resto].map((r) => {
        const elegible = puedeAutorizar && r.decision === 'pendiente' && r.contado != null;
        const propio = r.contado_por === App.usuario.id;
        return `<tr>
          ${puedeAutorizar ? `<td>${elegible ? `<input type="checkbox" class="sup-elegir" data-renglon="${r.id}" ${propio ? 'disabled title="Lo contaste tú: otro jefe lo autoriza"' : 'checked'}>` : ''}</td>` : ''}
          <td>${escaparHtml(r.descripcion)}${completo && r.razon_texto ? `<small class="texto-suave sup-codigo">${escaparHtml(r.razon_texto)}</small>` : ''}</td>
          ${completo ? `<td class="num">${r.existencia_sistema == null ? '—' : supNumero(r.existencia_sistema)}</td>` : ''}
          <td class="num">${r.contado == null ? '—' : `${r.reconteos && r.primer_conteo != null && r.primer_conteo !== r.contado ? `<small class="texto-suave">${supNumero(r.primer_conteo)} → </small>` : ''}${supNumero(r.contado)}`}</td>
          ${completo ? `<td class="num ${r.diferencia < 0 ? 'texto-peligro' : r.diferencia > 0 ? 'texto-exito' : ''}">${r.diferencia ? `${r.diferencia > 0 ? '+' : '−'}${supNumero(Math.abs(r.diferencia))}` : '—'}</td>
            <td class="num">${r.valor ? `${r.valor < 0 ? '−' : '+'}${dinero(Math.abs(r.valor))}` : '—'}</td>` : ''}
          <td>${escaparHtml(r.motivo || '')}</td>
          <td>${escaparHtml(r.contador || '')}</td>
          <td>${escaparHtml(decisionTexto(r) || estadoTexto(r))}${r.decisor ? ` <small class="texto-suave">(${escaparHtml(r.decisor)})</small>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    ${puedeAutorizar ? `<div class="acciones">
      <button class="boton exito" type="button" data-autorizar="aprobar">Aprobar ajuste de lo marcado</button>
      <button class="boton peligro" type="button" data-autorizar="rechazar">Rechazar lo marcado</button>
    </div>` : ''}`;
}

async function autorizarConteoSup(decision) {
  const c = Sup.conteo;
  const ids = [...document.querySelectorAll('#sup-conteo-detalle .sup-elegir:checked')].map((x) => Number(x.dataset.renglon));
  if (!ids.length) {
    aviso('Marca al menos una diferencia', 'error');
    return;
  }
  const elegidos = c.renglones.filter((r) => ids.includes(r.id));
  const valor = elegidos.reduce((t, r) => t + r.valor, 0);
  const confirmado = await confirmar({
    titulo: decision === 'aprobar' ? 'Aprobar ajuste del inventario' : 'Rechazar diferencias',
    mensaje: decision === 'aprobar'
      ? `Se ajusta el inventario de ${elegidos.length} producto(s) en ${c.sucursal} (${valor < 0 ? 'faltan' : 'sobran'} ${dinero(Math.abs(valor))}).`
      : `No se toca el inventario de ${elegidos.length} producto(s); se volverán a contar otro día.`,
    boton: decision === 'aprobar' ? 'Aprobar' : 'Rechazar',
    peligro: decision === 'rechazar',
  });
  if (!confirmado) return;
  try {
    Sup.conteo = await api(`/api/conteos/${c.id}/autorizar`, { method: 'POST', body: { [decision]: ids } });
    pintarConteoSup();
    aviso(decision === 'aprobar' ? 'Ajuste aplicado al inventario' : 'Diferencias rechazadas', 'exito');
    cargarConteosSup();
  } catch (error) {
    aviso(error.message, 'error');
  }
}

// ---------- Revisión semanal del inventario (como la hoja de Excel de antes) ----------
// Los productos de la lista en renglones y cada turno de la semana en columnas, con lo que se contó.
const SUP_TURNO = { manana: 'Mañana', tarde: 'Tarde', completo: 'Completo', dia: 'Del día' };
const supSumarDias = (dia, n) => {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const supHoraDe = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }) : '');
const supCon = (n) => `${n > 0 ? '+' : '−'}${supNumero(Math.abs(n))}`;

// Las columnas: los dos turnos de cada día (hasta hoy) y los inventarios completos
function columnasSemana(h) {
  const columnas = [];
  for (let i = 0; i < 7; i += 1) {
    const dia = supSumarDias(h.desde, i);
    for (const turno of ['manana', 'tarde']) {
      const t = h.turnos.find((x) => x.fecha === dia && x.turno === turno);
      if (!t || t.estado === 'por_venir') continue;
      columnas.push({ dia, turno, estado: t.estado, conteo: h.conteos.find((c) => c.fecha === dia && c.turno === turno) || null });
    }
    for (const c of h.conteos.filter((x) => x.fecha === dia && !['manana', 'tarde'].includes(x.turno))) {
      columnas.push({ dia, turno: c.turno, estado: 'hecho', conteo: c });
    }
  }
  return columnas;
}

function celdaSemanaSup(x, col) {
  if (col.estado !== 'hecho' || !col.conteo) return '<td class="sem-celda vacia"></td>';
  if (!x) return '<td class="sem-celda vacia" title="No estaba en la lista ese día"></td>';
  if (x.estado === 'no_contado') return '<td class="sem-celda no-contado" title="No se contó">—</td>';
  const titulo = [
    `Sistema ${supNumero(x.sistema)}`, `contado ${supNumero(x.contado)}`,
    x.primer_conteo != null && x.primer_conteo !== x.contado ? `(la primera vez contó ${supNumero(x.primer_conteo)})` : '',
    x.motivo ? `motivo: ${x.motivo}` : '', x.contador ? `contó ${x.contador} ${x.hora}` : '',
  ].filter(Boolean).join(' · ');
  if (x.estado === 'cuadra') return `<td class="sem-celda cuadra" title="${escaparHtml(titulo)}">${supNumero(x.contado)}</td>`;
  return `<td class="sem-celda ${x.estado === 'faltan' ? 'falta' : 'sobra'}" title="${escaparHtml(titulo)}">${supNumero(x.contado)}<small>${supCon(x.diferencia)}</small></td>`;
}

async function cargarSemanaSup({ desde = Sup.semanaDesde || '' } = {}) {
  const caja = document.getElementById('sup-sem-contenido');
  const selector = document.getElementById('sup-sem-sucursal');
  caja.innerHTML = '<p class="texto-suave">Cargando…</p>';
  try {
    Sup.semana = await api(`/api/conteos/semana?sucursal_id=${selector.value || ''}${desde ? `&desde=${desde}` : ''}`);
  } catch (error) {
    caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
    return;
  }
  const h = Sup.semana;
  Sup.semanaDesde = h.desde;
  selector.innerHTML = h.sucursales.map((s) => `<option value="${s.id}" ${s.id === h.sucursal_id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('');
  pintarSemanaSup();
}

function pintarSemanaSup() {
  const h = Sup.semana;
  const t = h.totales;
  const caja = document.getElementById('sup-sem-contenido');
  const columnas = columnasSemana(h);
  const esperados = h.turnos.filter((x) => x.estado !== 'por_venir' && x.estado !== 'pendiente').length;
  const sinHacer = h.turnos.filter((x) => x.estado === 'no_se_hizo');
  document.getElementById('sup-sem-rango').textContent = `${supDiaCorto(h.desde)} al ${supDiaCorto(h.hasta)}`;
  document.getElementById('sup-sem-siguiente').disabled = h.hasta >= h.hoy;
  const revisar = document.getElementById('sup-sem-revisar');
  revisar.hidden = Boolean(h.revisada) || !h.conteos.length;
  const pieFila = (titulo, celda) => `<tr><th class="sem-producto">${titulo}</th>${columnas.map((c) => `<td>${c.estado === 'hecho' && c.conteo ? celda(c.conteo) : ''}</td>`).join('')}<td></td></tr>`;
  const diferencias = [];
  for (const c of columnas) {
    if (!c.conteo || c.estado !== 'hecho') continue;
    for (const p of h.productos) {
      const x = p.celdas[c.conteo.id];
      if (x && (x.estado === 'faltan' || x.estado === 'sobran')) diferencias.push({ c, p, x });
    }
  }
  caja.innerHTML = `
    <div class="sup-datos">
      <span><small>Turnos contados</small><b>${t.turnos_hechos} de ${esperados}</b></span>
      <span><small>Faltaron</small><b class="texto-peligro">${supNumero(t.piezas_faltan)} pza(s) · ${dinero(t.faltante)}</b></span>
      <span><small>Sobraron</small><b>${supNumero(t.piezas_sobran)} pza(s) · ${dinero(t.sobrante)}</b></span>
      <span><small>Revisión</small><b>${h.revisada ? `Revisada por ${escaparHtml(h.revisada.por)} el ${escaparHtml(supFecha(h.revisada.fecha))}` : 'Sin revisar'}</b></span>
    </div>
    ${sinHacer.length ? `<div class="franja-aviso error sup-sem-sin-hacer"><b>No se contó:</b> ${sinHacer.map((x) => `${escaparHtml(supDiaCorto(x.fecha))} ${SUP_TURNO[x.turno].toLowerCase()}`).join(' · ')}</div>` : ''}
    ${h.conteos.length ? `
    <div class="contenedor-tabla sup-semana-tabla"><table class="tabla tabla-semana">
      <thead><tr><th class="sem-producto">Producto</th>${columnas.map((c) => `<th class="sem-col ${c.estado}">${escaparHtml(supDiaCorto(c.dia))}<b>${SUP_TURNO[c.turno] || c.turno}</b>
        <small>${c.estado === 'hecho' && c.conteo ? `${escaparHtml(supHoraDe(c.conteo.inicio))} · ${escaparHtml(c.conteo.contaron.join(', '))}` : c.estado === 'pendiente' ? 'Pendiente' : 'No se hizo'}</small></th>`).join('')}
        <th class="sem-col">Semana</th></tr></thead>
      <tbody>${h.productos.map((p) => `<tr><td class="sem-producto">${escaparHtml(p.descripcion)}<small>${escaparHtml(p.departamento || '')}</small></td>
        ${columnas.map((c) => celdaSemanaSup(c.conteo ? p.celdas[c.conteo.id] : null, c)).join('')}
        <td class="sem-celda ${p.diferencia_semana < 0 ? 'falta' : p.diferencia_semana > 0 ? 'sobra' : 'cuadra'}">${p.diferencia_semana ? `${supCon(p.diferencia_semana)}<small>${dinero(Math.abs(p.valor_semana))}</small>` : '✓'}</td></tr>`).join('')}</tbody>
      <tfoot>
        ${pieFila('Faltaron', (c) => (c.piezas_faltan ? `<b class="texto-peligro">${supNumero(c.piezas_faltan)}</b><br><small>${dinero(c.faltante)}</small>` : '—'))}
        ${pieFila('Sobraron', (c) => (c.piezas_sobran ? `<b>${supNumero(c.piezas_sobran)}</b><br><small>${dinero(c.sobrante)}</small>` : '—'))}
        ${pieFila('Cobraron desde el conteo anterior', (c) => (c.cobraron == null ? '<small>sin datos</small>'
          : c.cobraron.map((x) => `<small>${escaparHtml(x.usuario)} (${x.ventas})</small>`).join('<br>') || '<small>nadie</small>'))}
        ${pieFila('Desde', (c) => `<small>${c.periodo_desde ? escaparHtml(supFecha(c.periodo_desde)) : '—'}</small>`)}
      </tfoot>
    </table></div>
    <p class="texto-suave">Verde: cuadró · rojo: faltaron (el número chico es la diferencia) · azul: sobraron · —: no se contó. Pasa el mouse sobre una casilla para ver lo que decía el sistema, el motivo y quién contó.
      Cada conteo revisa lo que pasó desde el conteo anterior; la existencia ya quedó ajustada a lo contado.</p>
    <h3>Diferencias de la semana (${diferencias.length})</h3>
    <div class="contenedor-tabla"><table class="tabla">
      <thead><tr><th>Turno</th><th>Producto</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferencia</th><th class="num">Valor</th><th>Motivo</th><th>Contó</th><th>Cobraron en ese tiempo</th></tr></thead>
      <tbody>${diferencias.map(({ c, p, x }) => `<tr>
        <td style="white-space:nowrap">${escaparHtml(supDiaCorto(c.dia))} ${(SUP_TURNO[c.turno] || '').toLowerCase()}</td><td>${escaparHtml(p.descripcion)}</td>
        <td class="num">${supNumero(x.sistema)}</td><td class="num">${supNumero(x.contado)}</td>
        <td class="num ${x.diferencia < 0 ? 'texto-peligro' : 'texto-exito'}">${supCon(x.diferencia)}</td><td class="num">${dinero(Math.abs(x.valor))}</td>
        <td>${escaparHtml(x.motivo || '')}</td><td>${escaparHtml(x.contador || '')}</td>
        <td>${c.conteo.cobraron ? escaparHtml(c.conteo.cobraron.map((v) => `${v.usuario} (${v.ventas})`).join(', ') || 'nadie') : 'sin datos'}</td></tr>`).join('')
        || '<tr><td colspan="9" class="vacio">Todo cuadró esta semana.</td></tr>'}</tbody>
    </table></div>`
    : '<p class="vacio">Esta semana no hay inventarios de esta farmacia.</p>'}`;
}

// La misma hoja para abrirla en Excel
function descargarSemanaSup() {
  const h = Sup.semana;
  if (!h) return;
  const columnas = columnasSemana(h);
  const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const titulos = columnas.map((c) => `${supDiaCorto(c.dia)} ${SUP_TURNO[c.turno] || c.turno}`);
  const lineas = [
    [`Inventario de ${h.sucursal}`, `semana del ${h.desde} al ${h.hasta}`],
    [],
    ['Producto', 'Departamento', ...titulos, 'Diferencia de la semana', 'Valor de la diferencia'],
    ...h.productos.map((p) => [p.descripcion, p.departamento, ...columnas.map((c) => {
      const x = c.conteo && c.estado === 'hecho' ? p.celdas[c.conteo.id] : null;
      if (!x) return c.estado === 'hecho' ? '' : 'no se hizo';
      if (x.estado === 'no_contado') return 'no se contó';
      return x.diferencia ? `${supNumero(x.contado)} (${x.diferencia > 0 ? '+' : '-'}${supNumero(Math.abs(x.diferencia))})` : supNumero(x.contado);
    }), p.diferencia_semana, p.valor_semana.toFixed(2)]),
    [],
    ['Faltaron (piezas)', '', ...columnas.map((c) => (c.conteo && c.estado === 'hecho' ? c.conteo.piezas_faltan : ''))],
    ['Faltaron ($)', '', ...columnas.map((c) => (c.conteo && c.estado === 'hecho' ? c.conteo.faltante.toFixed(2) : ''))],
    ['Sobraron (piezas)', '', ...columnas.map((c) => (c.conteo && c.estado === 'hecho' ? c.conteo.piezas_sobran : ''))],
    ['Contó', '', ...columnas.map((c) => (c.conteo && c.estado === 'hecho' ? c.conteo.contaron.join(' / ') : ''))],
    ['Cobraron desde el conteo anterior', '', ...columnas.map((c) => (c.conteo && c.estado === 'hecho' && c.conteo.cobraron
      ? c.conteo.cobraron.map((v) => `${v.usuario} (${v.ventas})`).join(' / ') : ''))],
  ];
  const texto = `\ufeff${lineas.map((l) => l.map(celda).join(',')).join('\r\n')}`;
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  enlace.download = `inventario-${h.sucursal.replace(/[^\w]+/g, '-').toLowerCase()}-${h.desde}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  setTimeout(() => { URL.revokeObjectURL(enlace.href); enlace.remove(); }, 1000);
}

async function revisarSemanaSup() {
  const h = Sup.semana;
  if (!h) return;
  const confirmado = await confirmar({
    titulo: 'Marcar la semana como revisada',
    mensaje: `${h.sucursal}, del ${supDiaCorto(h.desde)} al ${supDiaCorto(h.hasta)}: faltaron ${supNumero(h.totales.piezas_faltan)} pieza(s) (${dinero(h.totales.faltante)}). Queda anotado en el registro de cambios.`,
    boton: 'Marcar como revisada',
  });
  if (!confirmado) return;
  try {
    Sup.semana = await api('/api/conteos/semana/revisar', { method: 'POST', body: { sucursal_id: h.sucursal_id, semana: h.desde } });
    pintarSemanaSup();
    aviso('Semana marcada como revisada', 'exito');
  } catch (error) {
    aviso(error.message, 'error');
  }
}

// ---------- Registro de cambios ----------
async function cargarCambiosSup({ mas = false } = {}) {
  const parametros = new URLSearchParams({
    desde: document.getElementById('sup-cam-desde').value,
    hasta: document.getElementById('sup-cam-hasta').value,
    desde_fila: mas ? Sup.cambios.siguiente : 0,
  });
  for (const [campo, id] of [['sucursal_id', 'sup-cam-sucursal'], ['usuario_id', 'sup-cam-usuario'], ['grupo', 'sup-cam-grupo']]) {
    const valor = document.getElementById(id).value;
    if (valor) parametros.set(campo, valor);
  }
  const cuerpo = document.getElementById('sup-cam-cuerpo');
  if (!mas) cuerpo.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
  let r;
  try {
    r = await api(`/api/bitacora?${parametros}`);
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="5">${escaparHtml(error.message)}</td></tr>`;
    return;
  }
  Sup.cambios.lista = mas ? [...Sup.cambios.lista, ...r.cambios] : r.cambios;
  Sup.cambios.siguiente = r.siguiente;
  const avisoLocal = document.getElementById('sup-cam-aviso');
  avisoLocal.hidden = r.fuente !== 'local';
  avisoLocal.textContent = 'Sin conexión con la central: solo se ven los cambios hechos en esta computadora.';
  cuerpo.innerHTML = Sup.cambios.lista.map(filaCambioSup).join('') || '<tr><td colspan="5">No hay cambios con estos filtros.</td></tr>';
  document.getElementById('sup-cam-mas').hidden = !r.hay_mas;
}

// ---------- Cortes de todas las farmacias ----------
function supTextoDiferencia(d) {
  if (Math.abs(d) < 0.005) return 'Cuadró';
  return d < 0 ? `<b class="texto-peligro">Faltaron ${dinero(-d)}</b>` : `Sobraron ${dinero(d)}`;
}

async function cargarCortesSup() {
  const parametros = new URLSearchParams({ desde: document.getElementById('sup-cor-desde').value, hasta: document.getElementById('sup-cor-hasta').value });
  const sucursal = document.getElementById('sup-cor-sucursal').value;
  if (sucursal) parametros.set('sucursal_id', sucursal);
  const cuerpo = document.getElementById('sup-cor-cuerpo');
  cuerpo.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>';
  try {
    const r = await api(`/api/ventas-central/cortes?${parametros}`);
    cuerpo.innerHTML = r.cortes.map((c) => `<tr>
      <td style="white-space:nowrap">${escaparHtml(supFecha(c.fecha))}</td><td>${escaparHtml(c.sucursal)}${c.caja ? ` <small class="texto-suave">${escaparHtml(c.caja)}</small>` : ''}</td>
      <td>${escaparHtml(c.usuario)}</td><td class="num">${c.num_ventas}</td><td class="num">${dinero(c.total_vendido)}</td>
      <td class="num">${dinero(c.efectivo_esperado)}</td><td class="num">${dinero(c.efectivo_contado)}</td><td class="num">${supTextoDiferencia(c.diferencia)}</td>
      <td style="white-space:nowrap"><button class="boton chico" type="button" data-ver-corte="${c.id}">Ver</button>
        <button class="boton chico" type="button" data-imprimir-corte="${c.id}"><svg class="icono"><use href="#i-imprimir"/></svg>Reimprimir</button></td></tr>`).join('')
      || '<tr><td colspan="9">No hay cortes en estas fechas.</td></tr>';
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="9">${escaparHtml(error.message)}</td></tr>`;
  }
}

async function verCorteSup(id, { imprimir = false } = {}) {
  let c;
  try {
    c = await api(`/api/ventas-central/cortes/${id}`);
  } catch (error) {
    aviso(error.message, 'error');
    return;
  }
  if (imprimir) {
    await Impresion.imprimirCorte(c);
    return;
  }
  const e = c.estadisticas || {};
  const fila = (texto, valor) => `<tr><td>${texto}</td><td class="num">${valor}</td></tr>`;
  const modal = abrirModal(`
    <h3>Corte de caja · ${escaparHtml(c.sucursal)}</h3>
    <p class="texto-suave">${escaparHtml(supFecha(c.fecha))} · ${escaparHtml(c.usuario || '')}</p>
    <div class="zona-reportes">
      <div class="tarjeta"><h3>Caja</h3><table class="tabla-simple">
        ${fila('Fondo de caja', dinero(c.fondo_caja))}${fila('Ventas en efectivo', dinero(c.total_efectivo))}
        ${fila('Abonos en efectivo', dinero((c.total_abonos || 0) - (c.abonos_tarjeta || 0)))}${fila('Entradas de efectivo', dinero(c.entradas_efectivo))}
        ${fila('Salidas de efectivo', dinero(c.salidas_efectivo))}${fila('<b>Efectivo esperado</b>', `<b>${dinero(c.efectivo_esperado)}</b>`)}
        ${fila('Efectivo contado', dinero(c.efectivo_contado))}${fila('<b>Diferencia</b>', supTextoDiferencia(Number(c.diferencia) || 0))}
      </table></div>
      <div class="tarjeta"><h3>Ventas</h3><table class="tabla-simple">
        ${fila('Vendido', dinero(e.vendido))}${fila('Utilidad bruta', dinero(e.utilidad_bruta))}${fila('Ventas', c.num_ventas)}
        ${fila('Tarjeta', dinero(c.total_tarjeta))}${fila('Crédito', dinero(c.total_credito))}${fila('Dólares', dinero(c.total_dolares))}
        ${fila('Canceladas', `${c.num_canceladas || 0} (${dinero(c.total_canceladas)})`)}
        ${(c.por_cajero || []).map((x) => fila(`${escaparHtml(x.cajero)} (${x.num_ventas})`, dinero(x.total))).join('')}
      </table></div>
    </div>
    ${(c.movimientos_caja || []).length ? `<h4>Entradas y salidas de efectivo</h4><table class="tabla-simple">${c.movimientos_caja.map((m) => fila(`${m.tipo === 'salida' ? 'Salida' : 'Entrada'}: ${escaparHtml(m.concepto)} <small class="texto-suave">${escaparHtml(m.usuario || '')}</small>`, dinero(m.monto))).join('')}</table>` : ''}
    <div class="pie">
      <button class="boton" data-cerrar>Cerrar</button>
      <button class="boton exito" data-imprimir><svg class="icono"><use href="#i-imprimir"/></svg>Reimprimir</button>
    </div>`);
  modal.classList.add('grande');
  modal.querySelector('[data-cerrar]').addEventListener('click', cerrarModal);
  modal.querySelector('[data-imprimir]').addEventListener('click', () => Impresion.imprimirCorte(c));
}

// ---------- Créditos de clientes de todas las farmacias ----------
async function cargarCreditosSup() {
  const sucursal = document.getElementById('sup-cre-sucursal').value;
  const cuerpo = document.getElementById('sup-cre-cuerpo');
  cuerpo.innerHTML = '<tr><td colspan="7">Cargando…</td></tr>';
  try {
    const r = await api(`/api/ventas-central/creditos${sucursal ? `?sucursal_id=${sucursal}` : ''}`);
    document.getElementById('sup-cre-resumen').innerHTML = `<div class="tarjeta-dato"><small>Por cobrar</small><b>${dinero(r.total)}</b></div>`
      + r.por_sucursal.map((s) => `<div class="tarjeta-dato"><small>${escaparHtml(s.sucursal)} (${s.clientes})</small><b>${dinero(s.saldo)}</b></div>`).join('');
    document.getElementById('sup-cre-prestamos').innerHTML = r.prestamos == null ? '' : `
      <h3>Préstamos a otras farmacias ${r.prestamos.length ? `· ${dinero(r.valor_prestado)} a costo` : ''}</h3>
      <div class="contenedor-tabla"><table class="tabla"><thead><tr><th>Farmacia</th><th>Sucursal</th><th>Folio</th><th>Desde</th><th>Falta que regresen o paguen</th><th class="num">Piezas</th><th class="num">A costo</th></tr></thead>
        <tbody>${r.prestamos.map((p) => `<tr><td>${escaparHtml(p.farmacia)}${p.nota ? `<br><small class="texto-suave">${escaparHtml(p.nota)}</small>` : ''}</td>
          <td>${escaparHtml(p.sucursal)}</td><td>P-${p.folio}</td><td>${escaparHtml(supFecha(p.fecha))}</td>
          <td>${p.productos.map((x) => `${supNumero(x.pendiente)} ${escaparHtml(x.descripcion)}`).join('<br>')}</td>
          <td class="num">${supNumero(p.piezas)}</td><td class="num"><b>${dinero(p.valor)}</b></td></tr>`).join('')
          || '<tr><td colspan="7">No hay nada prestado.</td></tr>'}</tbody></table></div>`;
    cuerpo.innerHTML = r.clientes.map((c) => `<tr class="${c.excedido ? 'fila-alerta' : ''}">
      <td>${escaparHtml(c.nombre)}${c.excedido ? ' <small class="texto-peligro">(pasó su límite)</small>' : ''}</td><td>${escaparHtml(c.sucursal)}</td>
      <td>${escaparHtml(c.telefono)}</td><td class="num"><b>${dinero(c.saldo)}</b></td><td class="num">${c.limite_credito ? dinero(c.limite_credito) : '—'}</td>
      <td>${c.ultima_compra ? escaparHtml(supFecha(c.ultima_compra)) : ''}</td><td>${c.ultimo_abono ? escaparHtml(supFecha(c.ultimo_abono)) : 'Sin abonos'}</td></tr>`).join('')
      || '<tr><td colspan="7">Nadie debe nada.</td></tr>';
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="7">${escaparHtml(error.message)}</td></tr>`;
  }
}

// ---------- Eventos ----------
document.getElementById('sup-cor-buscar').addEventListener('click', () => cargarCortesSup());
for (const id of ['sup-cor-desde', 'sup-cor-hasta', 'sup-cor-sucursal']) document.getElementById(id).addEventListener('change', () => cargarCortesSup());
document.getElementById('sup-cre-buscar').addEventListener('click', () => cargarCreditosSup());
document.getElementById('sup-cre-sucursal').addEventListener('change', () => cargarCreditosSup());
document.querySelectorAll('[data-vista-sup]').forEach((b) => b.addEventListener('click', () => mostrarVistaSup(b.dataset.vistaSup)));
document.getElementById('sup-resumen-actualizar').addEventListener('click', () => cargarResumenSup({ fresco: true }));
document.getElementById('sup-mov-buscar').addEventListener('click', () => cargarMovimientosSup());
document.getElementById('sup-mov-producto').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); cargarMovimientosSup(); }
});
for (const id of ['sup-mov-desde', 'sup-mov-hasta', 'sup-mov-sucursal', 'sup-mov-tipo', 'sup-mov-usuario']) {
  document.getElementById(id).addEventListener('change', () => cargarMovimientosSup());
}
document.getElementById('sup-mov-mas').addEventListener('click', () => cargarMovimientosSup({ mas: true }));
document.getElementById('sup-cam-buscar').addEventListener('click', () => cargarCambiosSup());
for (const id of ['sup-cam-desde', 'sup-cam-hasta', 'sup-cam-sucursal', 'sup-cam-usuario', 'sup-cam-grupo']) {
  document.getElementById(id).addEventListener('change', () => cargarCambiosSup());
}
document.getElementById('sup-cam-mas').addEventListener('click', () => cargarCambiosSup({ mas: true }));
document.getElementById('sup-conteos-actualizar').addEventListener('click', () => cargarConteosSup());
document.getElementById('sup-sem-sucursal').addEventListener('change', () => cargarSemanaSup());
document.getElementById('sup-sem-anterior').addEventListener('click', () => Sup.semana && cargarSemanaSup({ desde: supSumarDias(Sup.semana.desde, -7) }));
document.getElementById('sup-sem-siguiente').addEventListener('click', () => Sup.semana && cargarSemanaSup({ desde: supSumarDias(Sup.semana.desde, 7) }));
document.getElementById('sup-sem-hoy').addEventListener('click', () => cargarSemanaSup({ desde: supDia(0) }));
document.getElementById('sup-sem-descargar').addEventListener('click', descargarSemanaSup);
document.getElementById('sup-sem-revisar').addEventListener('click', revisarSemanaSup);

document.getElementById('seccion-movimientos').addEventListener('click', async (e) => {
  const verCorte = e.target.closest('[data-ver-corte]');
  if (verCorte) {
    verCorteSup(Number(verCorte.dataset.verCorte));
    return;
  }
  const imprimirCorte = e.target.closest('[data-imprimir-corte]');
  if (imprimirCorte) {
    verCorteSup(Number(imprimirCorte.dataset.imprimirCorte), { imprimir: true });
    return;
  }
  const conteo = e.target.closest('[data-conteo]');
  if (conteo) {
    if (Sup.vista !== 'conteos') mostrarVistaSup('conteos');
    abrirConteoSup(Number(conteo.dataset.conteo));
    return;
  }
  const lista = e.target.closest('[data-lista]');
  if (lista) {
    verListaSup(Number(lista.dataset.sucursal), lista.dataset.lista);
    return;
  }
  const autorizar = e.target.closest('[data-autorizar]');
  if (autorizar) {
    autorizarConteoSup(autorizar.dataset.autorizar);
    return;
  }
  const deLista = e.target.closest('[data-lista-sup], [data-lista-quitar-sup], [data-lista-agregar-sup]');
  if (deLista && !deLista.disabled) {
    if (!Sup.lista) await cargarListaSup();
    accionListaSup(deLista);
  }
});

document.getElementById('sup-lista').addEventListener('change', (e) => {
  if (e.target.id === 'sup-lista-sucursal') cargarListaSup(Number(e.target.value));
});
document.getElementById('sup-lista').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'sup-lista-buscar') {
    e.preventDefault();
    buscarListaSup();
  }
});

App.alMostrarSeccion.movimientos = abrirSupervision;

document.addEventListener('app:listo', () => {
  if (!supEsJefe()) return;
  revisarAvisoSup();
  setInterval(revisarAvisoSup, 300000);
});
