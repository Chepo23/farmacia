// Corte de caja: lo vendido en el turno, el efectivo que debe haber y el que se contó
const Corte = { pendiente: null };

function pintarDiferencia() {
  const el = document.getElementById('corte-diferencia');
  const campo = document.getElementById('corte-contado');
  if (!Corte.pendiente || campo.value === '') {
    el.hidden = true;
    return;
  }
  const diferencia = Math.round((Number(campo.value) - Corte.pendiente.efectivo_esperado) * 100) / 100;
  el.hidden = false;
  el.className = 'diferencia-corte';
  if (Math.abs(diferencia) < 0.005) {
    el.classList.add('cuadra');
    el.textContent = 'La caja cuadra exacto ✔';
  } else if (diferencia > 0) {
    el.classList.add('sobrante');
    el.textContent = `Sobran ${dinero(diferencia)}`;
  } else {
    el.classList.add('faltante');
    el.textContent = `Faltan ${dinero(-diferencia)}`;
  }
}

async function cargarCorte() {
  try {
    const [pendiente, movimientos, cortes] = await Promise.all([
      api('/api/cortes/pendiente'),
      api('/api/cortes/movimientos'),
      api('/api/cortes'),
    ]);
    Corte.pendiente = pendiente;
    const p = pendiente;
    const poner = (id, texto) => { document.getElementById(id).textContent = texto; };
    poner('corte-apertura', p.apertura_fecha ? `Caja abierta desde ${p.apertura_fecha.slice(0, 16)}` : 'Sin apertura de caja');
    poner('corte-num', p.num_ventas);
    poner('corte-efectivo', dinero(p.efectivo));
    poner('corte-tarjeta', dinero(p.tarjeta));
    poner('corte-credito', dinero(p.credito));
    poner('corte-dolares', dinero(p.dolares));
    poner('corte-usd', p.usd_recibidos ? `(${p.usd_recibidos.toFixed(2)} USD)` : '');
    poner('corte-abonos', dinero(p.abonos));
    poner('corte-canceladas', p.num_canceladas ? `${p.num_canceladas} (${dinero(p.total_canceladas)})` : '0');
    poner('corte-fondo', dinero(p.fondo_caja));
    poner('corte-efectivo-caja', dinero(p.efectivo));
    poner('corte-abonos-efectivo', dinero(p.abonos_efectivo));
    poner('corte-entradas', dinero(p.entradas_efectivo));
    poner('corte-salidas', dinero(p.salidas_efectivo));
    poner('corte-cambio-dolares', dinero(p.cambio_dolares));
    poner('corte-esperado', dinero(p.efectivo_esperado));
    const usd = document.getElementById('etiqueta-usd-contado');
    usd.hidden = !(p.usd_recibidos > 0);
    if (!usd.hidden && document.getElementById('corte-usd-contado').value === '') {
      document.getElementById('corte-usd-contado').placeholder = `Se esperan ${p.usd_recibidos.toFixed(2)} USD`;
    }
    pintarDiferencia();

    document.getElementById('cuerpo-movimientos-caja').innerHTML = movimientos
      .map((m) => `<tr>
        <td>${escaparHtml(String(m.fecha).slice(11, 16))}</td>
        <td>${m.tipo === 'entrada' ? '<span class="chip ok">Entrada</span>' : '<span class="chip cancelada">Salida</span>'}</td>
        <td>${escaparHtml(m.concepto)}</td>
        <td>${escaparHtml(m.usuario)}</td>
        <td class="num">${dinero(m.monto)}</td>
      </tr>`)
      .join('') || '<tr><td colspan="5" class="vacio">Sin entradas ni salidas de efectivo en este turno</td></tr>';

    document.getElementById('cuerpo-por-cajero').innerHTML = (p.por_cajero || [])
      .map((c) => `<tr><td>${escaparHtml(c.cajero)}</td><td class="num">${c.num_ventas}</td><td class="num">${dinero(c.total)}</td></tr>`)
      .join('') || '<tr><td colspan="3" class="vacio">Sin ventas en este turno</td></tr>';

    document.getElementById('cuerpo-cortes').innerHTML = cortes
      .map((c) => {
        const contado = c.efectivo_esperado || c.efectivo_contado ? dinero(c.efectivo_contado) : '—';
        const diferencia = Number(c.diferencia) || 0;
        return `<tr>
          <td>${escaparHtml(String(c.fecha).slice(0, 16))}</td>
          <td>${escaparHtml(c.usuario)}</td>
          <td class="num">${c.num_ventas}</td>
          <td class="num">${c.efectivo_esperado ? dinero(c.efectivo_esperado) : '—'}</td>
          <td class="num">${contado}</td>
          <td class="num ${diferencia < -0.005 ? 'texto-rojo' : diferencia > 0.005 ? 'texto-verde' : ''}">${c.efectivo_esperado ? dinero(diferencia) : '—'}</td>
          <td><button class="boton chico" data-corte="${c.id}" title="Reimprimir corte"><svg class="icono"><use href="#i-imprimir"/></svg></button></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7" class="vacio">Todavía no hay cortes</td></tr>';
  } catch (err) {
    aviso(err.message, 'error');
  }
}

async function movimientoDeCaja(tipo) {
  const concepto = await pedirTexto({
    titulo: tipo === 'entrada' ? 'Entrada de efectivo' : 'Salida de efectivo',
    mensaje: tipo === 'entrada'
      ? 'Dinero que entra a la caja y no es una venta (por ejemplo, cambio que trajeron).'
      : 'Dinero que sale de la caja y no es una devolución (por ejemplo, pago a un proveedor).',
    etiqueta: 'Concepto',
    boton: 'Continuar',
    peligro: false,
  });
  if (concepto === null) return;
  const montoTexto = await pedirTexto({
    titulo: `${tipo === 'entrada' ? 'Entrada' : 'Salida'}: ${concepto}`,
    etiqueta: 'Monto ($)',
    boton: 'Registrar',
    peligro: false,
  });
  if (montoTexto === null) return;
  try {
    await api('/api/cortes/movimientos', {
      method: 'POST',
      body: { tipo, concepto, monto: Number(montoTexto.replace(/[$,\s]/g, '')) },
    });
    aviso(`${tipo === 'entrada' ? 'Entrada' : 'Salida'} de efectivo registrada`, 'exito');
    cargarCorte();
  } catch (err) {
    aviso(err.message, 'error');
  }
}

document.getElementById('corte-contado').addEventListener('input', pintarDiferencia);
document.getElementById('boton-entrada-efectivo').addEventListener('click', () => movimientoDeCaja('entrada'));
document.getElementById('boton-salida-efectivo').addEventListener('click', () => movimientoDeCaja('salida'));

document.getElementById('cuerpo-cortes').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-corte]');
  if (!boton) return;
  try {
    Impresion.imprimirCorte(await api('/api/cortes/' + boton.dataset.corte));
  } catch (err) {
    aviso(err.message, 'error');
  }
});

document.getElementById('boton-hacer-corte').addEventListener('click', async () => {
  const contado = document.getElementById('corte-contado').value;
  if (contado === '') {
    aviso('Cuenta el efectivo de la caja y escribe cuánto hay antes de hacer el corte', 'error');
    document.getElementById('corte-contado').focus();
    return;
  }
  const diferencia = Number(contado) - (Corte.pendiente?.efectivo_esperado || 0);
  const confirmado = await confirmar({
    titulo: 'Realizar el corte de caja',
    mensaje: `Efectivo esperado ${dinero(Corte.pendiente?.efectivo_esperado)}, contado ${dinero(Number(contado))}`
      + `${Math.abs(diferencia) >= 0.005 ? ` (${diferencia > 0 ? 'sobran' : 'faltan'} ${dinero(Math.abs(diferencia))})` : ''}. `
      + 'Las ventas del turno quedarán cerradas y se pedirá una nueva apertura de caja.',
    boton: 'Hacer corte e imprimir',
  });
  if (!confirmado) return;
  try {
    const r = await api('/api/cortes', {
      method: 'POST',
      body: {
        efectivo_contado: contado,
        usd_contado: document.getElementById('corte-usd-contado').value,
        nota: document.getElementById('corte-nota').value,
      },
    });
    aviso(`Corte realizado. ${Math.abs(r.diferencia) < 0.005 ? 'La caja cuadra.' : `${r.diferencia > 0 ? 'Sobrante' : 'Faltante'}: ${dinero(Math.abs(r.diferencia))}`}`, 'exito');
    document.getElementById('corte-contado').value = '';
    document.getElementById('corte-usd-contado').value = '';
    document.getElementById('corte-nota').value = '';
    await Impresion.imprimirCorte(r.corte);
    App.apertura = null;
    await cargarCorte();
    await pedirApertura();
    cargarCorte();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

App.alMostrarSeccion.corte = cargarCorte;
