// Reportes de ventas e inventario
const NOMBRE_FORMA = { efectivo: 'Efectivo', dolar: 'Dólares', tarjeta: 'Tarjeta', mixto: 'Mixto', credito: 'Crédito' };

function fechaHoy() {
  return new Date().toLocaleDateString('sv-SE');
}

function filasReporte(filas, columnas, vacio = 'Sin ventas en el periodo') {
  return filas.map((f) => `<tr>${columnas.map((c) => `<td class="${c.num ? 'num' : ''}">${c.valor(f)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${columnas.length}" class="vacio">${vacio}</td></tr>`;
}

function filtroSucursal() {
  return App.usuario.rol === 'admin' && App.usuario.es_central === 1
    ? '&sucursal_id=' + document.getElementById('reporte-sucursal').value
    : '';
}

async function generarReporte() {
  const desde = document.getElementById('reporte-desde').value || fechaHoy();
  const hasta = document.getElementById('reporte-hasta').value || fechaHoy();
  let r;
  try {
    r = await api(`/api/reportes/ventas?desde=${desde}&hasta=${hasta}${filtroSucursal()}`);
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  const poner = (id, texto) => { document.getElementById(id).textContent = texto; };
  poner('rep-total', dinero(r.total_vendido));
  poner('rep-ganancia', dinero(r.ganancia));
  poner('rep-num', r.num_ventas);
  poner('rep-promedio', dinero(r.ticket_promedio));
  poner('rep-efectivo', dinero(r.efectivo));
  poner('rep-dolares', dinero(r.dolares));
  poner('rep-tarjeta', dinero(r.tarjeta));
  poner('rep-credito', dinero(r.credito));
  poner('rep-abonos', dinero(r.abonos.total));
  document.getElementById('rep-canceladas').innerHTML = r.canceladas.num
    ? `${r.canceladas.num} <small>${dinero(r.canceladas.total)}</small>`
    : '0';

  const franjaModo = document.getElementById('rep-aviso-modo');
  franjaModo.hidden = !r.ventas_solo_de_esta_computadora;
  franjaModo.className = 'franja-aviso info';
  franjaModo.textContent = 'Cada farmacia guarda sus ventas en su propia computadora: este reporte muestra las ventas registradas aquí. El inventario sí es el de todas las sucursales.';

  document.getElementById('rep-por-dia').innerHTML = filasReporte(r.por_dia, [
    { valor: (d) => escaparHtml(d.dia) },
    { num: true, valor: (d) => d.num_ventas },
    { num: true, valor: (d) => dinero(d.total) },
  ]);
  document.getElementById('rep-por-sucursal').innerHTML = filasReporte(r.por_sucursal, [
    { valor: (s) => escaparHtml(s.sucursal) },
    { num: true, valor: (s) => s.num_ventas },
    { num: true, valor: (s) => dinero(s.total) },
  ]);
  document.getElementById('rep-por-cajero').innerHTML = filasReporte(r.por_cajero, [
    { valor: (c) => escaparHtml(c.cajero) },
    { num: true, valor: (c) => c.num_ventas },
    { num: true, valor: (c) => dinero(c.total) },
  ]);
  document.getElementById('rep-por-forma').innerHTML = filasReporte(r.por_forma_pago, [
    { valor: (f) => escaparHtml(NOMBRE_FORMA[f.forma_pago] || f.forma_pago) },
    { num: true, valor: (f) => f.num_ventas },
    { num: true, valor: (f) => dinero(f.total) },
  ]);
  document.getElementById('rep-por-departamento').innerHTML = filasReporte(r.por_departamento, [
    { valor: (d) => escaparHtml(d.departamento) },
    { num: true, valor: (d) => d.cantidad },
    { num: true, valor: (d) => dinero(d.importe) },
    { num: true, valor: (d) => dinero(d.ganancia) },
  ]);
  document.getElementById('rep-mas-vendidos').innerHTML = filasReporte(r.mas_vendidos, [
    { valor: (p) => escaparHtml(p.descripcion) },
    { num: true, valor: (p) => p.cantidad },
    { num: true, valor: (p) => dinero(p.importe) },
    { num: true, valor: (p) => dinero(p.ganancia) },
  ]);
}

async function generarReporteInventario() {
  let r;
  try {
    const filtro = filtroSucursal();
    r = await api(`/api/reportes/inventario${filtro ? `?${filtro.slice(1)}` : ''}`);
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  const poner = (id, texto) => { document.getElementById(id).textContent = texto; };
  poner('rep-inv-total', r.total_productos ?? 0);
  poner('rep-inv-unidades', Number(r.total_unidades || 0).toLocaleString('es-MX'));
  poner('rep-inv-bajo', r.bajo_minimo ?? 0);
  poner('rep-inv-agotados', r.agotados ?? 0);
  poner('rep-inv-costo', dinero(r.valor_costo));
  poner('rep-inv-venta', dinero(r.valor_venta));

  document.getElementById('rep-inv-por-sucursal').innerHTML = filasReporte(r.por_sucursal || [], [
    { valor: (s) => escaparHtml(s.sucursal) },
    { num: true, valor: (s) => s.productos || 0 },
    { num: true, valor: (s) => Number(s.unidades || 0).toLocaleString('es-MX') },
    { num: true, valor: (s) => s.agotados || 0 },
    { num: true, valor: (s) => s.bajo_minimo || 0 },
    { num: true, valor: (s) => dinero(s.valor_costo) },
  ], 'Sin inventario');

  document.getElementById('rep-inv-bajo-minimo').innerHTML = filasReporte(r.bajo_minimo_detalle || [], [
    { valor: (p) => escaparHtml(p.sucursal) },
    { valor: (p) => escaparHtml(p.descripcion) },
    { num: true, valor: (p) => p.existencia },
    { num: true, valor: (p) => p.minimo },
  ], 'No hay productos bajo mínimo');
}

document.getElementById('boton-generar-reporte').addEventListener('click', generarReporte);
document.getElementById('boton-generar-reporte-inventario').addEventListener('click', generarReporteInventario);

document.addEventListener('app:listo', () => {
  document.getElementById('reporte-desde').value = fechaHoy();
  document.getElementById('reporte-hasta').value = fechaHoy();
  if (App.usuario.rol === 'admin' && App.usuario.es_central === 1) {
    const selector = document.getElementById('reporte-sucursal');
    selector.innerHTML =
      '<option value="todas">Todas las sucursales</option>' +
      App.sucursales.map((s) => `<option value="${s.id}" ${s.id === App.usuario.sucursal_id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('');
  }
});

App.alMostrarSeccion.reportes = async () => {
  await generarReporte();
  await generarReporteInventario();
};
