// Corte de caja
const Corte = { pendiente: null };

async function cargarCorte() {
  Corte.pendiente = await api('/api/cortes/pendiente');
  document.getElementById('corte-efectivo').textContent = dinero(Corte.pendiente.efectivo);
  document.getElementById('corte-abonos').textContent = dinero(Corte.pendiente.abonos);
  document.getElementById('corte-tarjeta').textContent = dinero(Corte.pendiente.tarjeta);
  document.getElementById('corte-credito').textContent = dinero(Corte.pendiente.credito);
  document.getElementById('corte-num').textContent = Corte.pendiente.num_ventas;
  actualizarEsperado();

  const cortes = await api('/api/cortes');
  document.getElementById('cuerpo-cortes').innerHTML = cortes
    .map(
      (c) => `<tr>
        <td>${escaparHtml(c.fecha)}</td>
        <td>${escaparHtml(c.usuario)}</td>
        <td class="num">${dinero(c.total_efectivo)}</td>
        <td class="num">${dinero(c.total_tarjeta)}</td>
        <td class="num">${dinero(c.total_credito)}</td>
        <td class="num">${dinero(c.efectivo_contado)}</td>
        <td class="num ${c.diferencia < 0 ? 'texto-rojo' : 'texto-verde'}">${dinero(c.diferencia)}</td>
      </tr>`
    )
    .join('');
}

function actualizarEsperado() {
  if (!Corte.pendiente) return;
  const fondo = Number(document.getElementById('corte-fondo').value) || 0;
  const esperado = fondo + Corte.pendiente.efectivo + Corte.pendiente.abonos;
  document.getElementById('corte-esperado').textContent = dinero(esperado);
}

document.getElementById('corte-fondo').addEventListener('input', actualizarEsperado);

document.getElementById('boton-hacer-corte').addEventListener('click', async () => {
  const fondo = Number(document.getElementById('corte-fondo').value) || 0;
  const contado = Number(document.getElementById('corte-contado').value) || 0;
  if (!confirm('¿Realizar el corte de caja? Las ventas pendientes quedarán cerradas en este corte.')) return;
  try {
    const r = await api('/api/cortes', {
      method: 'POST',
      body: { fondo_caja: fondo, efectivo_contado: contado },
    });
    const dif = r.diferencia;
    aviso(
      dif === 0
        ? 'Corte realizado. La caja cuadró exacta. ✔'
        : `Corte realizado. Diferencia: ${dinero(dif)} (${dif > 0 ? 'sobrante' : 'faltante'})`,
      dif < 0 ? 'error' : 'exito'
    );
    document.getElementById('corte-contado').value = 0;
    cargarCorte();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

App.alMostrarSeccion.corte = cargarCorte;
