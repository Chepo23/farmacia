// Impresión: tickets para la impresora térmica (58, 80 mm u otro ancho) y documentos tamaño carta.
// Los datos del negocio (nombre, lema, RFC, mensajes y ancho del papel) vienen de
// Administración → Datos del ticket. En el programa de escritorio se imprime directo en la impresora
// elegida para esta computadora (sin ventana), con el ancho de papel de esa impresora.
const Impresion = (() => {
  const LOGO = 'img/logo-login.png';

  function config() {
    return App.config || { negocio_nombre: 'Farmacia', ticket_ancho: '80', ticket_mensaje: '', ticket_pie: '' };
  }

  // 'AAAA-MM-DD HH:MM:SS' -> { fecha: 'DD/MM/AAAA', hora: 'HH:MM' }
  function partesFecha(texto) {
    if (!texto) {
      const ahora = new Date();
      return {
        fecha: ahora.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        hora: ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    }
    const [dia, hora = ''] = String(texto).replace('T', ' ').split(' ');
    const [anio, mes, d] = dia.split('-');
    return { fecha: `${d}/${mes}/${anio}`, hora: hora.slice(0, 5) };
  }

  function fechaHora(texto) {
    const { fecha, hora } = partesFecha(texto);
    return `${fecha} ${hora}`.trim();
  }

  function cantidad(valor) {
    const n = Number(valor) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  function folio(numero) {
    return String(numero ?? '').padStart(6, '0');
  }

  // ---------- Importe con letra (pesos mexicanos) ----------
  const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
  const DIEZ_A_DIECINUEVE = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const VEINTES = ['VEINTE', 'VEINTIÚN', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
  const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function menorQueMil(n) {
    if (n === 0) return '';
    if (n === 100) return 'CIEN';
    const resto = n % 100;
    let parte = '';
    if (resto > 0 && resto < 10) parte = UNIDADES[resto];
    else if (resto >= 10 && resto < 20) parte = DIEZ_A_DIECINUEVE[resto - 10];
    else if (resto >= 20 && resto < 30) parte = VEINTES[resto - 20];
    else if (resto >= 30) parte = DECENAS[Math.floor(resto / 10)] + (resto % 10 ? ` Y ${UNIDADES[resto % 10]}` : '');
    return [CENTENAS[Math.floor(n / 100)], parte].filter(Boolean).join(' ');
  }

  function numeroALetras(monto) {
    const centavosTotales = Math.round((Number(monto) || 0) * 100);
    const entero = Math.floor(centavosTotales / 100);
    const centavos = centavosTotales % 100;
    let letras = 'CERO';
    if (entero > 0) {
      const millones = Math.floor(entero / 1e6);
      const miles = Math.floor((entero % 1e6) / 1000);
      const resto = entero % 1000;
      const partes = [];
      if (millones) partes.push(millones === 1 ? 'UN MILLÓN' : `${menorQueMil(millones)} MILLONES`);
      if (miles) partes.push(miles === 1 ? 'MIL' : `${menorQueMil(miles)} MIL`);
      if (resto) partes.push(menorQueMil(resto));
      letras = partes.join(' ');
      if (millones && !miles && !resto) letras += ' DE';
    }
    return `${letras} ${entero === 1 ? 'PESO' : 'PESOS'} ${String(centavos).padStart(2, '0')}/100 M.N.`;
  }

  // ---------- Piezas comunes ----------
  function datosSucursal(datos = {}) {
    const propia = (App.sucursales || []).find((s) => s.id === (datos.sucursal_id ?? App.usuario?.sucursal_id)) || {};
    return {
      sucursal: datos.sucursal || propia.nombre || App.usuario?.sucursal || '',
      direccion: datos.direccion ?? propia.direccion ?? '',
      telefono: datos.telefono ?? propia.telefono ?? '',
    };
  }

  function encabezadoTicket(datos = {}) {
    const c = config();
    const s = datosSucursal(datos);
    return `<img class="t-logo" src="${LOGO}" alt="">
      <div class="t-negocio">${escaparHtml(c.negocio_nombre)}</div>
      ${c.ticket_encabezado ? `<div class="t-lema">${escaparHtml(c.ticket_encabezado)}</div>` : ''}
      ${s.sucursal ? `<div class="t-sucursal">${escaparHtml(s.sucursal)}</div>` : ''}
      ${s.direccion ? `<div class="t-dato">${escaparHtml(s.direccion)}</div>` : ''}
      ${s.telefono ? `<div class="t-dato">Tel. ${escaparHtml(s.telefono)}</div>` : ''}
      ${c.negocio_rfc ? `<div class="t-dato">RFC: ${escaparHtml(c.negocio_rfc)}</div>` : ''}`;
  }

  function pieTicket({ conMensaje = true } = {}) {
    const c = config();
    return `${conMensaje && c.ticket_mensaje ? `<div class="t-mensaje">${escaparHtml(c.ticket_mensaje)}</div>` : ''}
      ${c.ticket_pie ? `<div class="t-pie">${escaparHtml(c.ticket_pie)}</div>` : ''}
      <div class="t-pie">Impreso el ${escaparHtml(fechaHora())}</div>`;
  }

  const fila = (etiqueta, valor, clase = '') => `<div class="t-fila ${clase}"><span>${etiqueta}</span><span>${valor}</span></div>`;

  function cabeceraDocumento(titulo, subtitulo, datos = {}) {
    const c = config();
    const s = datosSucursal(datos);
    return `<div class="doc-cabecera">
      <div class="doc-marca">
        <img src="${LOGO}" alt="">
        <div>
          <div class="doc-negocio">${escaparHtml(c.negocio_nombre)}</div>
          ${c.ticket_encabezado ? `<div class="doc-lema">${escaparHtml(c.ticket_encabezado)}</div>` : ''}
          <div class="doc-sucursal">${escaparHtml([s.sucursal, s.direccion, s.telefono ? `Tel. ${s.telefono}` : ''].filter(Boolean).join(' · '))}</div>
          ${c.negocio_rfc ? `<div class="doc-sucursal">RFC: ${escaparHtml(c.negocio_rfc)}</div>` : ''}
        </div>
      </div>
      <div class="doc-titulo"><h1>${titulo}</h1>${subtitulo}</div>
    </div>`;
  }

  // ---------- Mandar a la impresora ----------
  function estiloPagina(css) {
    let estilo = document.getElementById('estilo-pagina');
    if (!estilo) {
      estilo = document.createElement('style');
      estilo.id = 'estilo-pagina';
      document.head.appendChild(estilo);
    }
    estilo.textContent = css;
  }

  // Sin esperar el logo, la primera impresión sale sin imagen
  function esperarImagenes(contenedor) {
    return Promise.all([...contenedor.querySelectorAll('img')].map((img) => (img.complete
      ? null
      : new Promise((listo) => { img.onload = listo; img.onerror = listo; }))));
  }

  const escritorio = () => window.farmaciaEscritorio || null;

  // Ancho del papel de la impresora de tickets (mm): el del programa de esta computadora o el de
  // Datos del ticket
  function anchoTicket() {
    const programa = escritorio();
    const impresora = programa ? (programa.leerImpresion ? programa.leerImpresion() : programa.impresion) || {} : {};
    const valor = Number(impresora.anchoTicket || config().ticket_ancho) || 80;
    return Math.min(120, Math.max(40, Math.round(valor)));
  }

  // Alto real del ticket en mm (para no desperdiciar papel en la impresora térmica)
  function altoEnMm(contenedor) {
    contenedor.classList.add('midiendo');
    const alto = contenedor.getBoundingClientRect().height;
    contenedor.classList.remove('midiendo');
    return Math.ceil((alto * 25.4) / 96);
  }

  function terminarImpresion() {
    document.body.classList.remove('imprimir-ticket', 'imprimir-documento');
  }

  async function mandar(tipo, contenedor, anchoMm) {
    const programa = escritorio();
    if (!programa || !programa.imprimir) {
      window.print();
      return;
    }
    try {
      const r = await programa.imprimir({ tipo, anchoMm, altoMm: tipo === 'ticket' ? altoEnMm(contenedor) : null });
      if (r && r.ok === false && r.motivo !== 'cancelado') aviso(`No se pudo imprimir: ${r.motivo || 'revisa que la impresora esté encendida'}`, 'error');
    } catch (error) {
      aviso(`No se pudo imprimir: ${error.message}`, 'error');
    } finally {
      terminarImpresion();
    }
  }

  async function ticket(html) {
    const contenedor = document.getElementById('ticket');
    const ancho = anchoTicket();
    contenedor.className = `ticket ${ancho <= 60 ? 'ancho-58' : 'ancho-80'}`;
    // Ancho imprimible: el papel menos los márgenes que no alcanza a imprimir la impresora
    contenedor.style.width = ancho === 58 || ancho === 80 ? '' : `${ancho - (ancho <= 60 ? 10 : 8)}mm`;
    contenedor.innerHTML = html;
    estiloPagina(`@page { size: ${ancho}mm auto; margin: 0; }`);
    document.body.classList.remove('imprimir-documento');
    document.body.classList.add('imprimir-ticket');
    await esperarImagenes(contenedor);
    await mandar('ticket', contenedor, ancho);
  }

  async function documento(html) {
    const contenedor = document.getElementById('documento');
    contenedor.innerHTML = html;
    estiloPagina('@page { size: letter; margin: 12mm; }');
    document.body.classList.remove('imprimir-ticket');
    document.body.classList.add('imprimir-documento');
    await esperarImagenes(contenedor);
    await mandar('documento', contenedor, null);
  }

  window.addEventListener('afterprint', () => {
    document.body.classList.remove('imprimir-ticket', 'imprimir-documento');
  });

  // ---------- Ticket de venta ----------
  function pagosVenta(v) {
    if (v.forma_pago === 'efectivo') return fila('Efectivo recibido', dinero(v.pago)) + fila('Su cambio', dinero(v.cambio), 't-destacado');
    if (v.forma_pago === 'dolar') {
      return fila('Pagó con', `${(Number(v.pago_usd) || 0).toFixed(2)} USD`)
        + fila('Tipo de cambio', dinero(v.tipo_cambio))
        + fila('Equivale a', dinero(v.pago))
        + fila('Su cambio (pesos)', dinero(v.cambio), 't-destacado');
    }
    if (v.forma_pago === 'mixto') return fila('Efectivo', dinero(v.pago_efectivo)) + fila('Tarjeta', dinero(v.pago_tarjeta));
    if (v.forma_pago === 'tarjeta') return fila('Pagado con tarjeta', dinero(v.total));
    return fila('Venta a crédito', dinero(v.total))
      + (v.saldo_cliente != null ? fila('Saldo del cliente', dinero(v.saldo_cliente), 't-destacado') : '');
  }

  function ticketVenta(v) {
    const partidas = (v.partidas || []).map((p) => {
      const conMayoreo = p.precio_lista != null && Number(p.precio_lista) > Number(p.precio_unitario) + 0.001;
      const detalle = Number(p.cantidad) !== 1 || conMayoreo
        ? `<tr class="t-precio"><td></td><td colspan="2">${cantidad(p.cantidad)} x ${dinero(p.precio_unitario)}${conMayoreo ? ` (mayoreo, antes ${dinero(p.precio_lista)})` : ''}</td></tr>`
        : '';
      return `<tr><td class="t-cant">${cantidad(p.cantidad)}</td><td>${escaparHtml(p.descripcion)}</td><td class="num">${dinero(p.importe)}</td></tr>${detalle}`;
    }).join('');
    return `${encabezadoTicket(v)}
      <div class="t-titulo">TICKET DE VENTA</div>
      ${v.cancelada ? `<div class="t-cancelada">VENTA CANCELADA</div>` : ''}
      ${fila('Folio', `<b>${folio(v.folio)}</b>`)}
      ${fila('Fecha', escaparHtml(fechaHora(v.fecha)))}
      ${fila('Atendió', escaparHtml(v.cajero || ''))}
      ${v.cliente ? fila('Cliente', escaparHtml(v.cliente)) : ''}
      <hr class="t-sep">
      <table class="t-partidas">
        <thead><tr><th>Cant</th><th>Descripción</th><th class="num">Importe</th></tr></thead>
        <tbody>${partidas}</tbody>
      </table>
      <hr class="t-sep">
      ${fila('Artículos', cantidad(v.articulos ?? (v.partidas || []).reduce((t, p) => t + Number(p.cantidad), 0)))}
      ${v.ahorro > 0 ? fila('Usted ahorró', dinero(v.ahorro)) : ''}
      <div class="t-total"><span>TOTAL</span><span>${dinero(v.total)}</span></div>
      <div class="t-letra">${numeroALetras(v.total)}</div>
      <hr class="t-sep">
      ${pagosVenta(v)}
      ${v.nota ? `<div class="t-nota">${escaparHtml(v.nota)}</div>` : ''}
      ${v.cancelada ? `<div class="t-nota">Cancelada el ${escaparHtml(fechaHora(v.cancelada_fecha))}${v.cancelada_por_nombre ? ` por ${escaparHtml(v.cancelada_por_nombre)}` : ''}: ${escaparHtml(v.motivo_cancelacion || '')}</div>` : ''}
      ${v.forma_pago === 'credito' && !v.cancelada ? '<div class="t-firma">Firma del cliente (acepto el cargo a mi cuenta)</div>' : ''}
      <hr class="t-sep">
      ${pieTicket({ conMensaje: !v.cancelada })}`;
  }

  // ---------- Comprobante de abono ----------
  function comprobanteAbono(a) {
    return `${encabezadoTicket(a)}
      <div class="t-titulo">COMPROBANTE DE ABONO</div>
      ${fila('Folio del abono', `<b>${folio(a.id)}</b>`)}
      ${fila('Fecha', escaparHtml(fechaHora(a.fecha)))}
      ${fila('Cliente', escaparHtml(a.cliente))}
      ${fila('Atendió', escaparHtml(a.cajero || ''))}
      <hr class="t-sep">
      ${a.saldo_anterior != null ? fila('Saldo anterior', dinero(a.saldo_anterior)) : ''}
      <div class="t-total"><span>ABONO</span><span>${dinero(a.monto)}</span></div>
      <div class="t-letra">${numeroALetras(a.monto)}</div>
      ${fila('Forma de pago', a.forma_pago === 'tarjeta' ? 'Tarjeta' : 'Efectivo')}
      ${a.saldo_nuevo != null ? `<div class="t-caja">${fila('<b>SALDO PENDIENTE</b>', `<b>${dinero(a.saldo_nuevo)}</b>`)}</div>` : ''}
      ${a.nota ? `<div class="t-nota">${escaparHtml(a.nota)}</div>` : ''}
      <div class="t-firma">Recibí — ${escaparHtml(a.cajero || '')}</div>
      <hr class="t-sep">
      ${pieTicket({ conMensaje: false })}`;
  }

  // ---------- Estado de cuenta ----------
  function resumenCredito(c) {
    return {
      limite: c.limite_credito > 0 ? dinero(c.limite_credito) : 'Sin límite',
      disponible: c.limite_credito > 0 ? dinero(c.credito_disponible ?? Math.max(c.limite_credito - c.saldo, 0)) : 'Sin límite',
    };
  }

  function estadoCuentaCarta(c) {
    const r = resumenCredito(c);
    const filas = (c.movimientos || []).map((m) => `<tr class="${m.tipo === 'abono' ? 'doc-abono' : ''}">
        <td>${escaparHtml(fechaHora(m.fecha))}</td>
        <td>${escaparHtml(m.concepto)}${m.partidas && m.partidas.length
          ? `<div class="doc-partidas">${m.partidas.map((p) => `${cantidad(p.cantidad)} × ${escaparHtml(p.descripcion)} (${dinero(p.importe)})`).join(' · ')}</div>`
          : ''}</td>
        <td class="num">${m.cargo ? dinero(m.cargo) : ''}</td>
        <td class="num">${m.abono ? dinero(m.abono) : ''}</td>
        <td class="num"><b>${dinero(m.saldo)}</b></td>
      </tr>`).join('') || '<tr><td colspan="5">Sin movimientos</td></tr>';
    return `${cabeceraDocumento('Estado de cuenta', `<div>Emitido el ${escaparHtml(fechaHora())}</div><div>Cliente núm. ${folio(c.id)}</div>`)}
      <div class="doc-bloques">
        <div class="doc-bloque">
          <h3>Cliente</h3>
          <div><b style="font-size:14px">${escaparHtml(c.nombre)}</b></div>
          ${c.telefono ? `<div>Tel. ${escaparHtml(c.telefono)}</div>` : ''}
          ${c.sucursal ? `<div>Cliente de ${escaparHtml(c.sucursal)}</div>` : ''}
        </div>
        <div class="doc-bloque">
          <h3>Crédito</h3>
          <div class="doc-fila"><span>Límite de crédito</span><b>${r.limite}</b></div>
          <div class="doc-fila"><span>Crédito disponible</span><b>${r.disponible}</b></div>
          <div class="doc-fila"><span>Estado</span><b>${c.credito_autorizado ? 'Autorizado' : 'Suspendido'}</b></div>
        </div>
      </div>
      <div class="doc-resumen">
        <div class="doc-cifra"><small>Total de compras</small><b>${dinero(c.total_cargos)}</b></div>
        <div class="doc-cifra"><small>Total abonado</small><b>${dinero(c.total_abonos)}</b></div>
        <div class="doc-cifra principal"><small>Saldo pendiente</small><b>${dinero(c.saldo)}</b></div>
      </div>
      <table class="doc-tabla">
        <thead><tr><th style="width:105px">Fecha</th><th>Concepto</th><th class="num">Cargo</th><th class="num">Abono</th><th class="num">Saldo</th></tr></thead>
        <tbody>${filas}</tbody>
        <tfoot><tr><td colspan="2">Totales</td><td class="num">${dinero(c.total_cargos)}</td><td class="num">${dinero(c.total_abonos)}</td><td class="num">${dinero(c.saldo)}</td></tr></tfoot>
      </table>
      <div class="doc-nota">Documento informativo, no es un comprobante fiscal. Si tiene alguna duda sobre sus movimientos, acuda a la farmacia con este estado de cuenta.</div>
      <div class="doc-firmas"><div>Firma del cliente</div><div>Atendió — ${escaparHtml(App.usuario?.nombre || '')}</div></div>`;
  }

  // Versión corta para la impresora de tickets: los últimos movimientos con su saldo
  function estadoCuentaTicket(c) {
    const r = resumenCredito(c);
    const ultimos = (c.movimientos || []).slice(-15);
    const omitidos = (c.movimientos || []).length - ultimos.length;
    const filas = ultimos.map((m) => `<tr>
        <td>${escaparHtml(partesFecha(m.fecha).fecha.slice(0, 5))}</td>
        <td>${escaparHtml(m.tipo === 'cargo' ? `Compra ${folio(m.folio)}` : 'Abono')}</td>
        <td class="num">${m.tipo === 'cargo' ? dinero(m.cargo) : `-${dinero(m.abono)}`}</td>
        <td class="num">${dinero(m.saldo)}</td>
      </tr>`).join('');
    return `${encabezadoTicket()}
      <div class="t-titulo">ESTADO DE CUENTA</div>
      ${fila('Cliente', `<b>${escaparHtml(c.nombre)}</b>`)}
      ${c.telefono ? fila('Teléfono', escaparHtml(c.telefono)) : ''}
      ${fila('Límite de crédito', r.limite)}
      ${fila('Crédito disponible', r.disponible)}
      <hr class="t-sep">
      ${omitidos > 0 ? `<div class="t-pie">(${omitidos} movimiento(s) anteriores no se muestran)</div>` : ''}
      <table class="t-partidas">
        <thead><tr><th>Fecha</th><th>Concepto</th><th class="num">Importe</th><th class="num">Saldo</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="4">Sin movimientos</td></tr>'}</tbody>
      </table>
      <hr class="t-sep">
      ${fila('Total de compras', dinero(c.total_cargos))}
      ${fila('Total abonado', dinero(c.total_abonos))}
      <div class="t-total"><span>DEBE</span><span>${dinero(c.saldo)}</span></div>
      <div class="t-pie">Documento informativo, no es comprobante fiscal</div>
      <hr class="t-sep">
      ${pieTicket({ conMensaje: false })}`;
  }

  // ---------- Corte de caja ----------
  function ticketCorte(co) {
    const diferencia = Number(co.diferencia) || 0;
    const textoDiferencia = Math.abs(diferencia) < 0.005 ? 'Cuadra' : diferencia > 0 ? 'Sobrante' : 'Faltante';
    const movimientos = (co.movimientos_caja || []).map((m) => fila(
      `${m.tipo === 'entrada' ? '+' : '−'} ${escaparHtml(m.concepto)}`, dinero(m.monto)
    )).join('');
    const cajeros = (co.por_cajero || []).map((c) => fila(`${escaparHtml(c.cajero)} (${c.num_ventas})`, dinero(c.total))).join('');
    return `${encabezadoTicket(co)}
      <div class="t-titulo">CORTE DE CAJA</div>
      ${fila('Corte núm.', `<b>${folio(co.id)}</b>`)}
      ${co.apertura ? fila('Apertura', escaparHtml(fechaHora(co.apertura.fecha))) : ''}
      ${fila('Corte', escaparHtml(fechaHora(co.fecha)))}
      ${fila('Realizó', escaparHtml(co.usuario || ''))}
      <hr class="t-sep">
      ${fila('Ventas realizadas', String(co.num_ventas))}
      ${fila('Efectivo', dinero(co.total_efectivo))}
      ${fila('Tarjeta', dinero(co.total_tarjeta))}
      ${fila('Crédito (fiado)', dinero(co.total_credito))}
      ${fila('Dólares (en pesos)', dinero(co.total_dolares))}
      ${fila('Abonos de clientes', dinero(co.total_abonos))}
      ${co.abonos_tarjeta ? fila('&nbsp;&nbsp;de ellos con tarjeta', dinero(co.abonos_tarjeta)) : ''}
      ${co.num_canceladas ? fila(`Canceladas (${co.num_canceladas})`, dinero(co.total_canceladas)) : ''}
      ${cajeros ? `<hr class="t-sep"><div class="t-pie"><b>VENTAS POR CAJERO</b></div>${cajeros}` : ''}
      <hr class="t-sep">
      <div class="t-pie"><b>EFECTIVO EN CAJA</b></div>
      ${fila('Fondo inicial', dinero(co.fondo_caja))}
      ${fila('+ Ventas en efectivo', dinero(co.total_efectivo))}
      ${fila('+ Abonos en efectivo', dinero((co.total_abonos || 0) - (co.abonos_tarjeta || 0)))}
      ${co.entradas_efectivo ? fila('+ Entradas', dinero(co.entradas_efectivo)) : ''}
      ${co.salidas_efectivo ? fila('− Salidas', dinero(co.salidas_efectivo)) : ''}
      ${co.cambio_dolares ? fila('− Cambio de ventas en dólares', dinero(co.cambio_dolares)) : ''}
      ${movimientos ? `<div class="t-pie" style="text-align:left">${movimientos}</div>` : ''}
      <div class="t-caja">
        ${fila('<b>Esperado</b>', `<b>${dinero(co.efectivo_esperado)}</b>`)}
        ${fila('<b>Contado</b>', `<b>${dinero(co.efectivo_contado)}</b>`)}
        ${fila(`<b>${textoDiferencia}</b>`, `<b>${dinero(Math.abs(diferencia))}</b>`)}
      </div>
      ${co.total_usd ? `<div class="t-caja">${fila('Dólares esperados', `${Number(co.total_usd).toFixed(2)} USD`)}${fila('Dólares contados', `${Number(co.usd_contado).toFixed(2)} USD`)}</div>` : ''}
      ${co.nota ? `<div class="t-nota">${escaparHtml(co.nota)}</div>` : ''}
      <div class="t-firma">Entregó — ${escaparHtml(co.usuario || '')}</div>
      <div class="t-firma">Recibió</div>
      <hr class="t-sep">
      ${pieTicket({ conMensaje: false })}`;
  }

  return {
    ticket,
    documento,
    numeroALetras,
    partesFecha,
    fechaHora,
    imprimirVenta: (venta) => ticket(ticketVenta(venta)),
    imprimirAbono: (abono) => ticket(comprobanteAbono(abono)),
    imprimirEstadoCuenta: (cliente, formato = 'carta') => (formato === 'ticket'
      ? ticket(estadoCuentaTicket(cliente))
      : documento(estadoCuentaCarta(cliente))),
    imprimirCorte: (corte) => ticket(ticketCorte(corte)),
  };
})();
