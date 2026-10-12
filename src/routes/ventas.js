const express = require('express');
const db = require('../db');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const { manejar } = require('../central');
const { aperturaVigente } = require('../caja');

const router = express.Router();

const FORMAS_PAGO = ['efectivo', 'tarjeta', 'credito', 'dolar', 'mixto'];
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const redondearCantidad = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const AVISO_SIN_CONEXION =
  'Se vendió sin conexión con la central: el descuento de inventario se subirá solo en cuanto vuelva el internet.';

// Lo que debe un cliente: ventas a crédito no canceladas menos abonos
function saldoCliente(clienteId) {
  return redondear(
    db
      .prepare(
        `SELECT COALESCE((SELECT SUM(total) FROM ventas
                          WHERE cliente_id = ? AND forma_pago = 'credito' AND cancelada = 0), 0)
              - COALESCE((SELECT SUM(monto) FROM abonos WHERE cliente_id = ?), 0) AS saldo`
      )
      .get(clienteId, clienteId).saldo
  );
}

function borrarVenta(ventaId) {
  db.transaction(() => {
    db.prepare('DELETE FROM venta_detalle WHERE venta_id = ?').run(ventaId);
    db.prepare('DELETE FROM ventas WHERE id = ?').run(ventaId);
  })();
}

function cargarVenta(id) {
  const venta = db
    .prepare(
      `SELECT v.*, s.nombre AS sucursal, s.direccion, s.telefono, u.nombre AS cajero,
              c.nombre AS cliente, c.telefono AS cliente_telefono, uc.nombre AS cancelada_por_nombre
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN usuarios uc ON uc.id = v.cancelada_por
       WHERE v.id = ?`
    )
    .get(id);
  if (!venta) return null;
  venta.partidas = db
    .prepare(
      `SELECT d.*, p.codigo_barras FROM venta_detalle d
       LEFT JOIN productos p ON p.id = d.producto_id
       WHERE d.venta_id = ? ORDER BY d.id`
    )
    .all(venta.id);
  venta.articulos = redondearCantidad(venta.partidas.reduce((t, p) => t + p.cantidad, 0));
  venta.ahorro = redondear(
    venta.partidas.reduce((t, p) => t + Math.max(0, ((p.precio_lista ?? p.precio_unitario) - p.precio_unitario) * p.cantidad), 0)
  );
  if (venta.cliente_id && venta.forma_pago === 'credito') venta.saldo_cliente = saldoCliente(venta.cliente_id);
  return venta;
}

// Registrar una venta completa
router.post('/', manejar(async (req, res) => {
  const { partidas, forma_pago, pago, cliente_id, mayoreo, nota, pago_usd, pago_efectivo } = req.body || {};
  const sucursalId = Number(req.usuario.sucursal_id);

  if (!Array.isArray(partidas) || partidas.length === 0) {
    return res.status(400).json({ error: 'La venta no tiene artículos' });
  }
  if (partidas.length > 500) return res.status(400).json({ error: 'La venta tiene demasiados renglones' });
  if (!FORMAS_PAGO.includes(forma_pago)) {
    return res.status(400).json({ error: 'Forma de pago no válida' });
  }
  if (forma_pago === 'credito' && !cliente_id) {
    return res.status(400).json({ error: 'Una venta a crédito necesita un cliente' });
  }
  const apertura = aperturaVigente(req.sesionToken, sucursalId);
  if (!apertura) {
    return res.status(400).json({ error: 'Registra la apertura de caja antes de vender', codigo: 'SIN_APERTURA' });
  }

  // Cantidades válidas y total por producto (para el precio de mayoreo por cantidad)
  const cantidadPorProducto = new Map();
  for (const p of partidas) {
    const cantidad = Number(p.cantidad);
    if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });
    if (!p.comun) {
      const id = Number(p.producto_id);
      cantidadPorProducto.set(id, (cantidadPorProducto.get(id) || 0) + cantidad);
    }
  }
  const productos = await catalogo.porIds([...cantidadPorProducto.keys()]);

  let total = 0;
  const renglones = [];
  for (const p of partidas) {
    const cantidad = redondearCantidad(p.cantidad);
    // Artículo común: no está en el catálogo, trae su propio nombre y precio
    if (p.comun) {
      const descripcion = String(p.descripcion || '').trim().slice(0, 200);
      const precio = Number(p.precio);
      if (!descripcion) return res.status(400).json({ error: 'El artículo común necesita un nombre' });
      if (!Number.isFinite(precio) || !(precio > 0)) {
        return res.status(400).json({ error: 'Precio del artículo común no válido' });
      }
      const importe = redondear(precio * cantidad);
      total += importe;
      renglones.push({
        producto_id: catalogo.ID_ARTICULO_COMUN,
        descripcion,
        cantidad,
        precio_unitario: redondear(precio),
        precio_lista: redondear(precio),
        costo_unitario: 0,
        importe,
        usa_inventario: 0,
      });
      continue;
    }

    const producto = productos.get(Number(p.producto_id));
    if (!producto) {
      return res.status(400).json({ error: `El producto ${p.producto_id} ya no está disponible en el catálogo` });
    }
    // Mayoreo: con F11, o automático al llegar a la cantidad de mayoreo del producto
    const totalProducto = cantidadPorProducto.get(producto.id) || cantidad;
    const aplicaMayoreo = producto.precio_mayoreo != null
      && (Boolean(mayoreo) || (producto.cantidad_mayoreo > 0 && totalProducto >= producto.cantidad_mayoreo));
    const precio = aplicaMayoreo ? producto.precio_mayoreo : producto.precio_venta;
    const importe = redondear(precio * cantidad);
    total += importe;
    renglones.push({
      producto_id: producto.id,
      descripcion: producto.descripcion,
      cantidad,
      precio_unitario: precio,
      precio_lista: producto.precio_venta,
      costo_unitario: producto.precio_costo,
      importe,
      usa_inventario: producto.usa_inventario ? 1 : 0,
    });
  }
  total = redondear(total);

  // Cálculo del pago según la forma elegida
  let pagoNum = Number(pago) || 0;
  let cambio = 0;
  let pagoUsd = null;
  let tipoCambio = null;
  let pagoEfectivo = null;
  let pagoTarjeta = null;

  if (forma_pago === 'efectivo') {
    if (!Number.isFinite(pagoNum) || pagoNum + 0.005 < total) {
      return res.status(400).json({ error: 'El pago es menor que el total' });
    }
    pagoNum = redondear(pagoNum);
    cambio = Math.max(redondear(pagoNum - total), 0);
  } else if (forma_pago === 'dolar') {
    tipoCambio = Number(apertura.tipo_cambio) || 0;
    if (!(tipoCambio > 0)) {
      return res.status(400).json({ error: 'No hay tipo de cambio registrado; captura la apertura de caja' });
    }
    pagoUsd = Number(pago_usd);
    if (!Number.isFinite(pagoUsd) || !(pagoUsd > 0)) return res.status(400).json({ error: 'Pago en dólares no válido' });
    pagoUsd = redondear(pagoUsd);
    pagoNum = redondear(pagoUsd * tipoCambio);
    if (pagoNum + 0.005 < total) return res.status(400).json({ error: 'El pago es menor que el total' });
    cambio = Math.max(redondear(pagoNum - total), 0); // el cambio se da en pesos
  } else if (forma_pago === 'mixto') {
    pagoEfectivo = Number(pago_efectivo);
    if (!Number.isFinite(pagoEfectivo) || !(pagoEfectivo > 0) || pagoEfectivo >= total) {
      return res.status(400).json({ error: 'En pago mixto el efectivo debe ser mayor a 0 y menor que el total' });
    }
    pagoEfectivo = redondear(pagoEfectivo);
    pagoTarjeta = redondear(total - pagoEfectivo);
    pagoNum = total;
  } else {
    pagoNum = total; // tarjeta y crédito se cobran exactos
  }

  if (forma_pago === 'credito') {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND activo = 1').get(cliente_id);
    if (!cliente) return res.status(400).json({ error: 'Cliente no encontrado' });
    if (!cliente.credito_autorizado) {
      return res.status(400).json({ error: 'El cliente no tiene crédito autorizado' });
    }
    const saldo = saldoCliente(cliente.id);
    if (cliente.limite_credito > 0 && saldo + total > cliente.limite_credito + 0.005) {
      return res.status(400).json({
        error: `Se rebasa el límite de crédito del cliente (debe $${saldo.toFixed(2)}, límite $${Number(cliente.limite_credito).toFixed(2)}, disponible $${Math.max(cliente.limite_credito - saldo, 0).toFixed(2)})`,
      });
    }
  }

  // 1) Se guarda la venta (así queda apartado el folio)
  const { ventaId, folio } = db.transaction(() => {
    const siguiente = db
      .prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM ventas WHERE sucursal_id = ?')
      .get(sucursalId).f;
    const id = db
      .prepare(
        `INSERT INTO ventas (folio, sucursal_id, usuario_id, cliente_id, forma_pago, total, pago, cambio,
           pago_usd, tipo_cambio, pago_efectivo, pago_tarjeta, nota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        siguiente, sucursalId, req.usuario.id, forma_pago === 'credito' ? Number(cliente_id) : null,
        forma_pago, total, pagoNum, cambio, pagoUsd, tipoCambio, pagoEfectivo, pagoTarjeta,
        String(nota || '').trim().slice(0, 300)
      ).lastInsertRowid;
    const insDetalle = db.prepare(
      `INSERT INTO venta_detalle (venta_id, producto_id, descripcion, cantidad, precio_unitario, costo_unitario,
         importe, descuenta_inventario, precio_lista)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of renglones) {
      insDetalle.run(id, r.producto_id, r.descripcion, r.cantidad, r.precio_unitario, r.costo_unitario, r.importe,
        r.usa_inventario, r.precio_lista);
    }
    return { ventaId: id, folio: siguiente };
  })();

  // 2) Se descuenta el inventario (en la central si hay internet; si no, queda en cola)
  const porProducto = new Map();
  for (const r of renglones) {
    if (!r.usa_inventario) continue;
    porProducto.set(r.producto_id, redondearCantidad((porProducto.get(r.producto_id) || 0) + r.cantidad));
  }
  const movimientos = [...porProducto].map(([productoId, cantidad]) => ({
    producto_id: productoId,
    sucursal_id: sucursalId,
    tipo: 'venta',
    cantidad,
    nota: `Venta folio ${folio}`,
  }));
  let plan;
  try {
    plan = await inventario.preparar(movimientos, { usuarioId: req.usuario.id, permitirSinConexion: true });
  } catch (error) {
    borrarVenta(ventaId);
    throw error;
  }
  try {
    db.transaction(() => plan.aplicarLocal())();
  } catch (error) {
    borrarVenta(ventaId);
    await plan.revertir();
    throw error;
  }

  res.json({
    ok: true,
    ventaId,
    folio,
    total,
    cambio,
    inventarioPendiente: plan.pendiente,
    inventarioSincronizado: !plan.pendiente,
    avisoSincronizacion: plan.pendiente ? AVISO_SIN_CONEXION : null,
  });
}));

// Última venta de la sucursal (para reimprimir el último ticket)
router.get('/ultima', (req, res) => {
  const venta = db
    .prepare('SELECT id FROM ventas WHERE sucursal_id = ? ORDER BY id DESC LIMIT 1')
    .get(req.usuario.sucursal_id);
  if (!venta) return res.status(404).json({ error: 'Todavía no hay ventas en esta sucursal' });
  res.json(venta);
});

// Datos completos de una venta (para reimprimir ticket o consultar)
router.get('/:id', (req, res) => {
  const venta = cargarVenta(req.params.id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  if (venta.sucursal_id !== Number(req.usuario.sucursal_id) && !(req.usuario.rol === 'admin' && req.usuario.es_central)) {
    return res.status(403).json({ error: 'Esa venta es de otra sucursal' });
  }
  res.json(venta);
});

// Cancelar una venta del turno (todavía sin corte): la mercancía regresa al inventario
router.post('/:id/cancelar', manejar(async (req, res) => {
  const venta = db.prepare('SELECT * FROM ventas WHERE id = ?').get(req.params.id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  if (venta.sucursal_id !== Number(req.usuario.sucursal_id)) {
    return res.status(403).json({ error: 'Solo se pueden cancelar ventas de tu sucursal' });
  }
  if (venta.cancelada) return res.status(400).json({ error: 'Esta venta ya estaba cancelada' });
  if (venta.corte_id) {
    return res.status(400).json({ error: 'Esta venta ya entró en un corte de caja; ya no se puede cancelar' });
  }
  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  if (!motivo) return res.status(400).json({ error: 'Escribe el motivo de la cancelación' });

  // Se marca primero para que dos clics no regresen la mercancía dos veces
  const tomada = db
    .prepare(
      `UPDATE ventas SET cancelada = 1, cancelada_por = ?, cancelada_fecha = datetime('now', 'localtime'),
         motivo_cancelacion = ?
       WHERE id = ? AND cancelada = 0 AND corte_id IS NULL`
    )
    .run(req.usuario.id, motivo, venta.id).changes;
  if (!tomada) return res.status(400).json({ error: 'La venta ya fue cancelada o ya entró en un corte' });

  const partidas = db
    .prepare(
      `SELECT d.producto_id, SUM(d.cantidad) AS cantidad
       FROM venta_detalle d LEFT JOIN productos p ON p.id = d.producto_id
       WHERE d.venta_id = ? AND d.producto_id <> 0 AND COALESCE(d.descuenta_inventario, p.usa_inventario, 0) = 1
       GROUP BY d.producto_id`
    )
    .all(venta.id);
  try {
    await inventario.aplicar(
      partidas.map((p) => ({
        producto_id: p.producto_id,
        sucursal_id: venta.sucursal_id,
        tipo: 'entrada',
        cantidad: p.cantidad,
        nota: `Cancelación de la venta folio ${venta.folio}`,
      })),
      { usuarioId: req.usuario.id, permitirSinConexion: true }
    );
  } catch (error) {
    db.prepare(
      "UPDATE ventas SET cancelada = 0, cancelada_por = NULL, cancelada_fecha = NULL, motivo_cancelacion = '' WHERE id = ?"
    ).run(venta.id);
    throw error;
  }
  res.json({ ok: true, venta: cargarVenta(venta.id) });
}));

// Ventas del día de la sucursal del usuario
router.get('/', (req, res) => {
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : new Date().toLocaleDateString('sv-SE');
  const ventas = db
    .prepare(
      `SELECT v.id, v.folio, v.fecha, v.forma_pago, v.total, v.pago, v.cambio, v.pago_usd, v.pago_efectivo,
              v.pago_tarjeta, v.cancelada, v.corte_id, v.nota,
              u.nombre AS cajero, c.nombre AS cliente,
              (SELECT COALESCE(SUM(d.cantidad), 0) FROM venta_detalle d WHERE d.venta_id = v.id) AS articulos
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.sucursal_id = ? AND date(v.fecha) = ?
       ORDER BY v.id DESC`
    )
    .all(req.usuario.sucursal_id, fecha);
  res.json(ventas);
});

module.exports = router;
module.exports.saldoCliente = saldoCliente;
