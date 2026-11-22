// Préstamos de medicamento a otras farmacias (que no son del jefe): se dan de alta como clientes.
// "Prestar" saca la mercancía del inventario; "Regresaron" la vuelve a meter; "Lo van a pagar" la cobra
// en la caja (a costo, al contado o a crédito) sin volver a sacarla del inventario. Cada préstamo se
// sube a la central para que el jefe vea lo que está prestado en todas las farmacias.
const express = require('express');
const db = require('../db');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const bitacora = require('../bitacora');
const { manejar, ErrorApp } = require('../central');

const router = express.Router();

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const redondearCantidad = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const pesos = (n) => `$${redondear(n).toFixed(2)}`;
const pendienteDe = (d) => redondearCantidad(Number(d.cantidad) - Number(d.devuelto) - Number(d.cobrado));

const AVISO_SIN_CONEXION = 'Se registró sin conexión con la central: el inventario se actualizará solo en cuanto vuelva el internet.';

function clienteDeLaSucursal(req, clienteId) {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND activo = 1').get(Number(clienteId));
  if (!cliente) throw new ErrorApp('Cliente no encontrado', { status: 404 });
  if (Number(cliente.sucursal_id) !== Number(req.usuario.sucursal_id)) {
    throw new ErrorApp('Ese cliente es de otra sucursal', { status: 403 });
  }
  return cliente;
}

// Un préstamo con sus renglones, lo que falta y su historial
function cargarPrestamo(id) {
  const p = db
    .prepare(
      `SELECT p.*, c.nombre AS cliente, u.nombre AS usuario
       FROM prestamos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.usuario_id
       WHERE p.id = ?`
    )
    .get(Number(id));
  if (!p) return null;
  p.renglones = db.prepare('SELECT * FROM prestamo_detalle WHERE prestamo_id = ? ORDER BY id').all(p.id)
    .map((d) => ({ ...d, pendiente: pendienteDe(d) }));
  p.historial = db
    .prepare(
      `SELECT m.*, d.descripcion, u.nombre AS usuario, v.folio AS venta_folio
       FROM prestamo_movimientos m JOIN prestamo_detalle d ON d.id = m.detalle_id
       JOIN usuarios u ON u.id = m.usuario_id LEFT JOIN ventas v ON v.id = m.venta_id
       WHERE m.prestamo_id = ? ORDER BY m.id`
    )
    .all(p.id);
  p.piezas_pendientes = redondearCantidad(p.renglones.reduce((t, d) => t + d.pendiente, 0));
  p.valor_pendiente = redondear(p.renglones.reduce((t, d) => t + d.pendiente * Number(d.costo), 0));
  p.estado = p.piezas_pendientes > 0.0005 ? 'pendiente' : 'cerrado';
  return p;
}

// Préstamos de la sucursal (de un cliente, o solo los que tienen algo pendiente)
router.get('/', (req, res) => {
  const filtros = ['p.sucursal_id = @sucursal'];
  const valores = { sucursal: Number(req.usuario.sucursal_id) };
  if (Number(req.query.cliente_id)) {
    filtros.push('p.cliente_id = @cliente');
    valores.cliente = Number(req.query.cliente_id);
  }
  if (req.query.estado === 'pendiente') {
    filtros.push('EXISTS (SELECT 1 FROM prestamo_detalle d WHERE d.prestamo_id = p.id AND d.cantidad - d.devuelto - d.cobrado > 0.0005)');
  }
  const ids = db.prepare(`SELECT p.id FROM prestamos p WHERE ${filtros.join(' AND ')} ORDER BY p.id DESC LIMIT 100`).all(valores);
  res.json(ids.map((f) => cargarPrestamo(f.id)));
});

router.get('/:id(\\d+)', (req, res) => {
  const p = cargarPrestamo(req.params.id);
  if (!p || Number(p.sucursal_id) !== Number(req.usuario.sucursal_id)) return res.status(404).json({ error: 'Préstamo no encontrado' });
  res.json(p);
});

// Prestar: la mercancía sale del inventario de la sucursal
router.post('/', manejar(async (req, res) => {
  const cliente = clienteDeLaSucursal(req, req.body?.cliente_id);
  const partidas = Array.isArray(req.body?.partidas) ? req.body.partidas : [];
  if (!partidas.length) throw new ErrorApp('Agrega lo que se lleva prestado');
  const porProducto = new Map();
  for (const p of partidas) {
    const cantidad = redondearCantidad(p.cantidad);
    if (!(cantidad > 0)) throw new ErrorApp('Cantidad no válida');
    const id = Number(p.producto_id);
    porProducto.set(id, redondearCantidad((porProducto.get(id) || 0) + cantidad));
  }
  const productos = await catalogo.porIds([...porProducto.keys()]);
  for (const id of porProducto.keys()) {
    const producto = productos.get(id);
    if (!producto) throw new ErrorApp(`El producto ${id} ya no está en el catálogo`);
    if (!producto.usa_inventario || producto.es_coctel) throw new ErrorApp(`"${producto.descripcion}" no lleva inventario: no se presta`);
  }
  const nota = String(req.body?.nota || '').trim().slice(0, 300);
  const sucursalId = Number(req.usuario.sucursal_id);
  // Se guarda primero (así queda apartado el folio); si el inventario falla, se borra
  const prestamoId = db.transaction(() => {
    const folio = db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM prestamos WHERE sucursal_id = ?').get(sucursalId).f;
    const id = Number(db.prepare(
      'INSERT INTO prestamos (folio, sucursal_id, cliente_id, usuario_id, nota) VALUES (?, ?, ?, ?, ?)'
    ).run(folio, sucursalId, cliente.id, req.usuario.id, nota).lastInsertRowid);
    const renglon = db.prepare('INSERT INTO prestamo_detalle (prestamo_id, producto_id, descripcion, cantidad, costo) VALUES (?, ?, ?, ?, ?)');
    for (const [productoId, cantidad] of porProducto) {
      const producto = productos.get(productoId);
      renglon.run(id, productoId, producto.descripcion, cantidad, redondear(producto.precio_costo));
    }
    return id;
  })();
  const borrar = () => db.transaction(() => {
    db.prepare('DELETE FROM prestamo_detalle WHERE prestamo_id = ?').run(prestamoId);
    db.prepare('DELETE FROM prestamos WHERE id = ?').run(prestamoId);
  })();
  const prestamo = cargarPrestamo(prestamoId);
  let plan;
  try {
    plan = await inventario.preparar(
      prestamo.renglones.map((d) => ({
        producto_id: d.producto_id, sucursal_id: sucursalId, tipo: 'salida', cantidad: d.cantidad,
        nota: `Préstamo P-${prestamo.folio} a ${cliente.nombre}`,
      })),
      { usuarioId: req.usuario.id, permitirSinConexion: true }
    );
    db.transaction(() => plan.aplicarLocal())();
  } catch (error) {
    if (plan) await plan.revertir().catch(() => {});
    borrar();
    throw error;
  }
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: sucursalId, tipo: 'prestamo',
    descripcion: `Préstamo P-${prestamo.folio} a ${cliente.nombre}: ${prestamo.renglones.map((d) => `${redondearCantidad(d.cantidad)} ${d.descripcion}`).join(', ')}`
      + ` (${pesos(prestamo.valor_pendiente)} a costo)`,
    detalle: { prestamo_id: prestamo.id, folio: prestamo.folio, cliente: cliente.nombre, valor: prestamo.valor_pendiente },
  });
  res.json({ ...prestamo, inventarioPendiente: plan.pendiente, avisoSincronizacion: plan.pendiente ? AVISO_SIN_CONEXION : null });
}));

// Regresaron (todo o una parte): la mercancía vuelve al inventario
router.post('/:id(\\d+)/devolver', manejar(async (req, res) => {
  const prestamo = cargarPrestamo(req.params.id);
  if (!prestamo || Number(prestamo.sucursal_id) !== Number(req.usuario.sucursal_id)) throw new ErrorApp('Préstamo no encontrado', { status: 404 });
  const pedidos = (Array.isArray(req.body?.renglones) ? req.body.renglones : [])
    .map((r) => ({ detalle_id: Number(r.detalle_id), cantidad: redondearCantidad(r.cantidad) }))
    .filter((r) => r.cantidad > 0);
  if (!pedidos.length) throw new ErrorApp('Escribe cuánto regresaron');
  for (const r of pedidos) {
    const d = prestamo.renglones.find((x) => x.id === r.detalle_id);
    if (!d) throw new ErrorApp('Ese producto no está en el préstamo');
    if (r.cantidad > d.pendiente + 0.0005) throw new ErrorApp(`De "${d.descripcion}" solo faltan ${d.pendiente}`);
  }
  // Se aparta en la base de esta computadora antes de mover el inventario (dos clics no lo regresan dos veces)
  const apartar = db.prepare(
    'UPDATE prestamo_detalle SET devuelto = devuelto + @cantidad WHERE id = @id AND cantidad - devuelto - cobrado >= @cantidad - 0.0005'
  );
  const registrarMovimiento = db.prepare(
    "INSERT INTO prestamo_movimientos (prestamo_id, detalle_id, tipo, cantidad, usuario_id) VALUES (?, ?, 'devolucion', ?, ?)"
  );
  db.transaction(() => {
    for (const r of pedidos) {
      if (!apartar.run({ id: r.detalle_id, cantidad: r.cantidad }).changes) throw new ErrorApp('El préstamo cambió; actualiza la pantalla');
      registrarMovimiento.run(prestamo.id, r.detalle_id, r.cantidad, req.usuario.id);
    }
    db.prepare('UPDATE prestamos SET subir = 1 WHERE id = ?').run(prestamo.id);
  })();
  const deshacer = () => db.transaction(() => {
    for (const r of pedidos) {
      db.prepare('UPDATE prestamo_detalle SET devuelto = devuelto - ? WHERE id = ?').run(r.cantidad, r.detalle_id);
      db.prepare(
        "DELETE FROM prestamo_movimientos WHERE id = (SELECT MAX(id) FROM prestamo_movimientos WHERE detalle_id = ? AND tipo = 'devolucion')"
      ).run(r.detalle_id);
    }
  })();
  let plan;
  try {
    plan = await inventario.preparar(
      pedidos.map((r) => ({
        producto_id: prestamo.renglones.find((x) => x.id === r.detalle_id).producto_id, sucursal_id: Number(prestamo.sucursal_id),
        tipo: 'entrada', cantidad: r.cantidad, nota: `Devolución del préstamo P-${prestamo.folio} de ${prestamo.cliente}`,
      })),
      { usuarioId: req.usuario.id, permitirSinConexion: true }
    );
    db.transaction(() => plan.aplicarLocal())();
  } catch (error) {
    if (plan) await plan.revertir().catch(() => {});
    deshacer();
    throw error;
  }
  const actualizado = cargarPrestamo(prestamo.id);
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: prestamo.sucursal_id, tipo: 'prestamo_devuelto',
    descripcion: `Préstamo P-${prestamo.folio} de ${prestamo.cliente}: regresaron ${pedidos.map((r) => `${r.cantidad} ${prestamo.renglones.find((x) => x.id === r.detalle_id).descripcion}`).join(', ')}`
      + `${actualizado.estado === 'cerrado' ? ' (ya no debe nada del préstamo)' : `; falta ${actualizado.piezas_pendientes} pieza(s)`}`,
    detalle: { prestamo_id: prestamo.id, folio: prestamo.folio },
  });
  res.json({ ...actualizado, inventarioPendiente: plan.pendiente, avisoSincronizacion: plan.pendiente ? AVISO_SIN_CONEXION : null });
}));

module.exports = router;
module.exports.cargarPrestamo = cargarPrestamo;
module.exports.pendienteDe = pendienteDe;
