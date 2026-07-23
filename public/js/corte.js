// Corte de caja
const Corte = { pendiente: null };

async function cargarCorte() {
  Corte.pendiente = await api('/api/cortes/pendiente');
  document.getElementById('corte-efectivo').textContent = dinero(Corte.pendiente.efectivo);
  document.getElementById('corte-abonos').textContent = dinero(Corte.pendiente.abonos);
  document.getElementById('corte-tarjeta').textContent = dinero(Corte.pendiente.tarjeta);
  document.getElementById('corte-dolares').textContent = dinero(Corte.pendiente.dolares);
  document.getElementById('corte-credito').textContent = dinero(Corte.pendiente.credito);
  document.getElementById('corte-num').textContent = Corte.pendiente.num_ventas;
  document.getElementById('corte-fondo').textContent = dinero(Corte.pendiente.fondo_caja);
  document.getElementById('corte-esperado').textContent = dinero(
    Corte.pendiente.fondo_caja + Corte.pendiente.efectivo + Corte.pendiente.abonos
  );

  const cortes = await api('/api/cortes');
  document.getElementById('cuerpo-cortes').innerHTML = cortes
    .map(
      (c) => `<tr>
        <td>${escaparHtml(c.fecha)}</td>
        <td>${escaparHtml(c.usuario)}</td>
        <td class="num">${dinero(c.fondo_caja)}</td>
        <td class="num">${dinero(c.total_efectivo)}</td>
        <td class="num">${dinero(c.total_tarjeta)}</td>
        <td class="num">${dinero(c.total_credito)}</td>
        <td class="num">${c.num_ventas}</td>
      </tr>`
    )
    .join('');
}

document.getElementById('boton-hacer-corte').addEventListener('click', async () => {
  if (!confirm('¿Realizar el corte de caja? Las ventas pendientes quedarán cerradas en este corte y al volver a entrar se pedirá una nueva apertura.')) return;
  try {
    const r = await api('/api/cortes', { method: 'POST' });
    aviso(`Corte realizado. Efectivo esperado en caja: ${dinero(r.esperado)}`, 'exito');
    cargarCorte();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

App.alMostrarSeccion.corte = cargarCorte;
