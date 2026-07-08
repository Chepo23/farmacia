// Reportes de ventas
function fechaHoy() {
  return new Date().toLocaleDateString('sv-SE');
}

async function generarReporte() {
  const desde = document.getElementById('reporte-desde').value || fechaHoy();
  const hasta = document.getElementById('reporte-hasta').value || fechaHoy();
  let url = `/api/reportes/ventas?desde=${desde}&hasta=${hasta}`;
  if (App.usuario.rol === 'admin') {
    url += '&sucursal_id=' + document.getElementById('reporte-sucursal').value;
  }
  const r = await api(url);

  document.getElementById('rep-total').textContent = dinero(r.total_vendido);
  document.getElementById('rep-ganancia').textContent = dinero(r.ganancia);
  document.getElementById('rep-num').textContent = r.num_ventas;
  document.getElementById('rep-efectivo').textContent = dinero(r.efectivo);
  document.getElementById('rep-tarjeta').textContent = dinero(r.tarjeta);
  document.getElementById('rep-credito').textContent = dinero(r.credito);

  document.getElementById('rep-por-dia').innerHTML = r.por_dia
    .map((d) => `<tr><td>${d.dia}</td><td class="num">${d.num_ventas}</td><td class="num">${dinero(d.total)}</td></tr>`)
    .join('') || '<tr><td colspan="3">Sin ventas en el periodo</td></tr>';

  document.getElementById('rep-por-sucursal').innerHTML = r.por_sucursal
    .map((s) => `<tr><td>${escaparHtml(s.sucursal)}</td><td class="num">${s.num_ventas}</td><td class="num">${dinero(s.total)}</td></tr>`)
    .join('') || '<tr><td colspan="3">Sin ventas en el periodo</td></tr>';

  document.getElementById('rep-mas-vendidos').innerHTML = r.mas_vendidos
    .map((p) => `<tr><td>${escaparHtml(p.descripcion)}</td><td class="num">${p.cantidad}</td><td class="num">${dinero(p.importe)}</td></tr>`)
    .join('') || '<tr><td colspan="3">Sin ventas en el periodo</td></tr>';
}

document.getElementById('boton-generar-reporte').addEventListener('click', generarReporte);

document.addEventListener('app:listo', () => {
  document.getElementById('reporte-desde').value = fechaHoy();
  document.getElementById('reporte-hasta').value = fechaHoy();
  if (App.usuario.rol === 'admin') {
    const selector = document.getElementById('reporte-sucursal');
    selector.innerHTML =
      '<option value="todas">Todas las sucursales</option>' +
      App.sucursales.map((s) => `<option value="${s.id}">${escaparHtml(s.nombre)}</option>`).join('');
  }
});

App.alMostrarSeccion.reportes = generarReporte;
