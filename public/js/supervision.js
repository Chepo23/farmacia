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
  cancelacion: 'Venta cancelada', recepcion: 'Recepción', alta: 'Alta de producto',
};
const SUP_LISTAS = {
  bajo_minimo: 'Bajo mínimo', agotados: 'Agotados', negativos: 'Existencia negativa', sin_movimiento: 'Sin movimiento (60 días)', valor: 'De más valor',
};
const SUP_ESTADOS_CONTEO = { abierto: ['Contando', 'enviado'], por_autorizar: ['Por autorizar', 'faltante'], cerrado: ['Revisado', 'recibido'], cancelado: ['Cancelado', 'cancelado'] };

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
  const permitidas = supEsJefe() ? ['resumen', 'movimientos', 'conteos', 'cortes', 'creditos', 'cambios'] : ['movimientos', 'conteos'];
  Sup.vista = permitidas.includes(vista) ? vista : permitidas[0];
  document.querySelectorAll('.vista-sup').forEach((v) => { v.hidden = v.id !== `sup-${Sup.vista}`; });
  document.querySelectorAll('[data-vista-sup]').forEach((b) => b.classList.toggle('primario', b.dataset.vistaSup === Sup.vista));
  if (Sup.vista === 'resumen') cargarResumenSup();
  if (Sup.vista === 'movimientos') cargarMovimientosSup();
  if (Sup.vista === 'conteos') cargarConteosSup();
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

function supConteoHoy(c) {
  if (!c) return '<span class="texto-suave">Inventario del día: todavía no lo empiezan</span>';
  if (c.estado === 'abierto') return `Inventario del día: <b>${c.contados} de ${c.productos}</b> contados`;
  return `Inventario del día terminado: <b>${c.exactitud ?? 0}%</b> cuadró${c.por_autorizar ? ` · <b class="texto-peligro">${c.por_autorizar} por autorizar</b>` : ''}`;
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
    <b>${r.por_autorizar.length === 1 ? 'Un inventario del día por autorizar' : `${r.por_autorizar.length} inventarios del día por autorizar`}:</b>
    ${r.por_autorizar.map((c) => `<button class="boton chico" type="button" data-conteo="${c.id}">${escaparHtml(c.sucursal)} · ${escaparHtml(supDiaCorto(c.fecha))}
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
      <div>${supConteoHoy(s.conteo_hoy)}</div>
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

// ---------- Inventario del día ----------
async function cargarConteosSup() {
  const cuerpo = document.getElementById('sup-conteos-cuerpo');
  cuerpo.innerHTML = '<tr><td colspan="8">Cargando…</td></tr>';
  try {
    const conteos = await api('/api/conteos?limite=40');
    if (supEsJefe()) pintarAvisoSup(conteos.filter((c) => c.estado === 'por_autorizar').length);
    cuerpo.innerHTML = conteos.map((c) => {
      const [texto, clase] = SUP_ESTADOS_CONTEO[c.estado] || [c.estado, ''];
      return `<tr class="fila-clic ${Sup.conteo && Sup.conteo.id === c.id ? 'fila-destacada' : ''}" data-conteo="${c.id}">
        <td style="white-space:nowrap">${escaparHtml(supDiaCorto(c.fecha))}</td><td>${escaparHtml(c.sucursal)}</td><td><span class="chip ${clase}">${texto}</span></td>
        <td class="num">${c.contados} de ${c.productos}</td><td class="num">${c.contados ? `${c.exactitud}%` : '—'}</td>
        <td class="num">${c.faltante ? dinero(c.faltante) : '—'}</td><td class="num">${c.sobrante ? dinero(c.sobrante) : '—'}</td>
        <td class="num">${c.por_autorizar ? `<b class="texto-peligro">${c.por_autorizar}</b>` : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="8">Todavía no hay inventarios del día: se arman solos cuando una sucursal abre <b>Contar</b> en el celular.</td></tr>';
  } catch (error) {
    cuerpo.innerHTML = `<tr><td colspan="8">${escaparHtml(error.message)}</td></tr>`;
  }
  if (supEsJefe()) pintarConfigSup();
}

async function pintarConfigSup() {
  const caja = document.getElementById('sup-config');
  try {
    const config = await api('/api/conteos/config');
    caja.innerHTML = config.map((c) => `<label>${escaparHtml(c.sucursal)}
      <input type="number" class="entrada sup-cuota" min="5" max="500" step="1" value="${c.productos_por_dia}" data-cuota="${c.sucursal_id}" aria-label="Productos por día">
      <button class="boton chico" type="button" data-guardar-cuota="${c.sucursal_id}">Guardar</button></label>`).join('');
  } catch (error) {
    caja.innerHTML = `<div class="mensaje-error">${escaparHtml(error.message)}</div>`;
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
  const decisionTexto = (r) => ({ aprobado: 'Ajuste aprobado', rechazado: 'No se ajustó' })[r.decision] || '';
  caja.innerHTML = `
    <h3>${escaparHtml(c.sucursal)} · ${escaparHtml(supDiaCorto(c.fecha))} <span class="chip ${(SUP_ESTADOS_CONTEO[c.estado] || [])[1] || ''}">${(SUP_ESTADOS_CONTEO[c.estado] || [c.estado])[0]}</span></h3>
    <div class="sup-datos">
      <span><small>Contados</small><b>${c.contados} de ${c.productos}</b></span>
      <span><small>Cuadró</small><b>${c.exactitud ?? 0}%</b></span>
      <span><small>Faltan</small><b class="texto-peligro">${dinero(c.faltante)}</b></span>
      <span><small>Sobran</small><b>${dinero(c.sobrante)}</b></span>
    </div>
    ${c.terminador ? `<p class="texto-suave">Terminó ${escaparHtml(c.terminador)}${c.cerrador ? ` · revisó ${escaparHtml(c.cerrador)}` : ''}${c.nota ? ` · ${escaparHtml(c.nota)}` : ''}</p>` : ''}
    ${puedeAutorizar ? '<p class="texto-suave">Al <b>aprobar</b> el inventario se ajusta por la diferencia (se respetan las ventas hechas después de contar). Al <b>rechazar</b> no se toca y el producto se vuelve a contar otro día. Nadie autoriza lo que él mismo contó.</p>' : ''}
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
  const guardar = e.target.closest('[data-guardar-cuota]');
  if (guardar) {
    const id = Number(guardar.dataset.guardarCuota);
    const valor = Number(document.querySelector(`[data-cuota="${id}"]`).value);
    try {
      await api('/api/conteos/config', { method: 'PUT', body: { sucursal_id: id, productos_por_dia: valor } });
      aviso('Productos por día guardados', 'exito');
    } catch (error) {
      aviso(error.message, 'error');
    }
  }
});

App.alMostrarSeccion.movimientos = abrirSupervision;

document.addEventListener('app:listo', () => {
  if (!supEsJefe()) return;
  revisarAvisoSup();
  setInterval(revisarAvisoSup, 300000);
});
