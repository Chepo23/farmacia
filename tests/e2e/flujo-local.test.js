'use strict';
// Prueba de punta a punta en modo local (una computadora, sin Supabase): administración,
// apoyos dentro del mismo servidor, ventas con todas las formas de pago, cancelación,
// crédito, abonos, corte de caja y reportes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioLocal, entrar, abrirCaja } = require('../helpers/escenario');

const CODIGO = '7502000000010';

function existencia(producto, sucursalId) {
  return producto.existencias.find((e) => e.sucursal_id === sucursalId)?.existencia;
}

test('flujo completo en una sola computadora sin Supabase', async (t) => {
  const { servidor, cerrarTodo } = await escenarioLocal();
  t.after(cerrarTodo);
  const admin = await entrar(servidor.base, 'admin', 'admin');
  let cajero;
  let productoId;

  await t.test('administración sin Supabase: alta de usuario y departamento', async () => {
    const usuario = await admin.post('/api/admin/usuarios', { nombre: 'Cajero Dos', usuario: 'cajero2', password: '1234', rol: 'cajero', sucursal_id: 2 });
    assert.equal(usuario.status, 200, JSON.stringify(usuario.body));
    const repetido = await admin.post('/api/admin/usuarios', { nombre: 'Otro', usuario: 'cajero2', password: '1234', rol: 'cajero', sucursal_id: 2 });
    assert.equal(repetido.status, 400);
    const departamento = await admin.post('/api/departamentos', { nombre: 'Analgésicos' });
    assert.equal(departamento.status, 200, JSON.stringify(departamento.body));
    cajero = await entrar(servidor.base, 'cajero2', '1234');
    const yo = await cajero.get('/api/auth/yo');
    assert.equal(yo.body.sucursal_id, 2);
    assert.equal(yo.body.modo, 'local');
  });

  await t.test('apoyo dentro del mismo servidor con el mismo stock en todas las pantallas', async () => {
    const alta = await admin.post('/api/productos', {
      codigo_barras: CODIGO, descripcion: 'Naproxeno 250 mg', departamento: 'Analgésicos',
      precio_costo: 20, precio_venta: 45, precio_mayoreo: 40, cantidad_mayoreo: 3, existencia_inicial: 10,
    });
    assert.equal(alta.status, 200, JSON.stringify(alta.body));
    productoId = alta.body.id;
    const apoyo = await admin.post('/api/apoyos', { destino_id: 2 });
    await admin.post(`/api/apoyos/${apoyo.body.id}/renglones`, { codigo_barras: CODIGO, cantidad: 8 });
    const enviado = await admin.post(`/api/apoyos/${apoyo.body.id}/enviar`, {});
    assert.equal(enviado.status, 200, JSON.stringify(enviado.body));
    const recibido = await cajero.post(`/api/apoyos/${apoyo.body.id}/recibir`, {});
    assert.equal(recibido.status, 200, JSON.stringify(recibido.body));
    for (const caja of [admin, cajero]) {
      const [lista, escaner, busqueda] = await Promise.all([
        caja.get(`/api/productos?q=${CODIGO}`), caja.get(`/api/productos/codigo/${CODIGO}`), caja.get(`/api/productos/buscar?q=Naproxeno`),
      ]);
      for (const producto of [lista.body[0], escaner.body, busqueda.body[0]]) {
        assert.equal(existencia(producto, 1), 2);
        assert.equal(existencia(producto, 2), 8);
      }
    }
  });

  let clienteId;
  let ventaCancelada;
  await t.test('ventas con todas las formas de pago y una cancelada', async () => {
    const cliente = await cajero.post('/api/clientes', { nombre: 'Juan Pérez', telefono: '6531112233', limite_credito: 100, credito_autorizado: true });
    clienteId = cliente.body.id;
    const venta = (forma, extra = {}) => cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: forma, ...extra });
    const efectivo = await venta('efectivo', { pago: 100 });
    assert.equal(efectivo.body.cambio, 55, JSON.stringify(efectivo.body));
    const dolar = await venta('dolar', { pago_usd: 5 }); // 5 USD x 18 = 90 pesos -> cambio 45 pesos
    assert.equal(dolar.body.cambio, 45, JSON.stringify(dolar.body));
    assert.equal((await venta('tarjeta')).status, 200);
    const credito = await venta('credito', { cliente_id: clienteId });
    assert.equal(credito.status, 200, JSON.stringify(credito.body));
    const mixto = await venta('mixto', { pago_efectivo: 20 });
    assert.equal(mixto.status, 200, JSON.stringify(mixto.body));
    const rebasa = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 2 }], forma_pago: 'credito', cliente_id: clienteId });
    assert.equal(rebasa.status, 400, 'no debe rebasar el límite de crédito');
    assert.match(rebasa.body.error, /límite de crédito/);
    ventaCancelada = await venta('efectivo', { pago: 45 });
    const cancelar = await cajero.post(`/api/ventas/${ventaCancelada.body.ventaId}/cancelar`, { motivo: 'error de captura' });
    assert.equal(cancelar.status, 200, JSON.stringify(cancelar.body));
    const producto = await cajero.get(`/api/productos/codigo/${CODIGO}`);
    assert.equal(existencia(producto.body, 2), 3, '8 - 5 vendidas (la cancelada regresó)');
  });

  await t.test('mayoreo automático al llegar a la cantidad de mayoreo', async () => {
    const r = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 3 }], forma_pago: 'efectivo', pago: 120 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 120, '3 x 40 de mayoreo');
    const detalle = await cajero.get(`/api/ventas/${r.body.ventaId}`);
    assert.equal(detalle.body.ahorro, 15);
    const cancelar = await cajero.post(`/api/ventas/${r.body.ventaId}/cancelar`, { motivo: 'prueba de mayoreo' });
    assert.equal(cancelar.status, 200);
  });

  await t.test('crédito: abonos validados y estado de cuenta con saldo acumulado', async () => {
    const demasiado = await cajero.post(`/api/clientes/${clienteId}/abonos`, { monto: 100 });
    assert.equal(demasiado.status, 400, 'no se puede abonar más de lo que debe');
    const abono = await cajero.post(`/api/clientes/${clienteId}/abonos`, { monto: 20, nota: 'primer pago' });
    assert.equal(abono.status, 200, JSON.stringify(abono.body));
    assert.equal(abono.body.abono.saldo_anterior, 45);
    assert.equal(abono.body.abono.saldo_nuevo, 25);
    const estado = await cajero.get(`/api/clientes/${clienteId}/estado`);
    assert.equal(estado.body.saldo, 25);
    assert.deepEqual(estado.body.movimientos.map((m) => [m.tipo, m.saldo]), [['cargo', 45], ['abono', 25]]);
    const baja = await cajero.del(`/api/clientes/${clienteId}`);
    assert.equal(baja.status, 400, 'no se da de baja un cliente con deuda');
  });

  await t.test('corte de caja: efectivo esperado con dólares, abonos y salidas', async () => {
    const salida = await cajero.post('/api/cortes/movimientos', { tipo: 'salida', monto: 30, concepto: 'Pago a proveedor' });
    assert.equal(salida.status, 200, JSON.stringify(salida.body));
    const pendiente = await cajero.get('/api/cortes/pendiente');
    const p = pendiente.body;
    assert.equal(p.num_ventas, 5);
    assert.equal(p.num_canceladas, 2);
    assert.equal(p.efectivo, 65, 'efectivo 45 + parte en efectivo de la mixta 20');
    assert.equal(p.tarjeta, 70, 'tarjeta 45 + parte con tarjeta de la mixta 25');
    assert.equal(p.credito, 45);
    assert.equal(p.usd_recibidos, 5);
    assert.equal(p.cambio_dolares, 45);
    assert.equal(p.abonos_efectivo, 20);
    // 500 de fondo + 65 efectivo + 20 abono - 30 salida - 45 de cambio de la venta en dólares
    assert.equal(p.efectivo_esperado, 510);
    const sinContar = await cajero.post('/api/cortes', {});
    assert.equal(sinContar.status, 400, 'pide el efectivo contado');
    const corte = await cajero.post('/api/cortes', { efectivo_contado: 500, usd_contado: 5 });
    assert.equal(corte.status, 200, JSON.stringify(corte.body));
    assert.equal(corte.body.diferencia, -10);
    assert.equal(corte.body.corte.num_canceladas, 2);
    const vendeSinCaja = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo', pago: 45 });
    assert.equal(vendeSinCaja.status, 400, 'después del corte se necesita una nueva apertura');
    assert.equal(vendeSinCaja.body.codigo, 'SIN_APERTURA');
    const despues = await cajero.get('/api/cortes/pendiente');
    assert.equal(despues.body.num_ventas, 0);
    const noCancelable = await cajero.post(`/api/ventas/${ventaCancelada.body.ventaId}/cancelar`, { motivo: 'x' });
    assert.equal(noCancelable.status, 400);
    await abrirCaja(cajero, { fondo: 300 });
    const otra = await cajero.post('/api/ventas', { partidas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo', pago: 45 });
    assert.equal(otra.status, 200, JSON.stringify(otra.body));
  });

  await t.test('reportes: sin canceladas y con desgloses', async () => {
    const hoy = new Date().toLocaleDateString('sv-SE');
    const r = await admin.get(`/api/reportes/ventas?desde=${hoy}&hasta=${hoy}&sucursal_id=2`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.num_ventas, 6);
    assert.equal(r.body.canceladas.num, 2);
    assert.equal(r.body.total_vendido, 270);
    assert.equal(r.body.dolares, 45);
    assert.ok(r.body.por_cajero.length === 1 && r.body.por_cajero[0].cajero === 'Cajero Dos');
    const inv = await admin.get('/api/reportes/inventario?sucursal_id=todas');
    const norte = inv.body.por_sucursal.find((s) => s.unidades !== undefined && s.sucursal === 'Farmacia Sucursal 2');
    assert.equal(norte.unidades, 2);
    const cajeroVeTodas = await cajero.get('/api/reportes/ventas?sucursal_id=todas');
    assert.equal(cajeroVeTodas.body.por_sucursal.length, 1, 'el cajero solo ve su sucursal');
  });
});
