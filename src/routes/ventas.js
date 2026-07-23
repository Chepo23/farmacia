const express = require('express');
const db = require('../db');

const router = express.Router();

// Producto genérico al que se cuelgan los "artículos comunes" (sin catálogo)
function productoComun() {
  let p = db.prepare('SELECT * FROM productos WHERE es_comun = 1').get();
  if (!p) {
    const id = db
      .prepare(
        "INSERT INTO productos (descripcion, usa_inventario, es_comun, activo) VALUES ('Artículo común', 0, 1, 1)"
      )
      .run().lastInsertRowid;
    p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  }
  return p;
}

// Registrar una venta completa
router.post('/', (req, res) => {
  const { partidas, forma_pago, pago, cliente_id, mayoreo, nota, pago_usd, pago_efectivo } = req.body || {};
  const sucursalId = req.usuario.sucursal_id;

  if (!Array.isArray(partidas) || partidas.length === 0) {
    return res.status(400).json({ error: 'La venta no tiene artículos' });
  }
  if (!['efectivo', 'tarjeta', 'credito', 'dolar', 'mixto'].includes(forma_pago)) {
    return res.status(400).json({ error: 'Forma de pago no válida' });
  }
  if (forma_pago === 'credito' && !cliente_id) {
    return res.status(400).json({ error: 'Una venta a crédito necesita un cliente' });
  }

  const buscarProducto = db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1');
  const buscarExistencia = db.prepare(
    'SELECT existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?'
  );
  let total = 0;
  const renglones = [];
  for (const p of partidas) {
    const cantidad = Number(p.cantidad);
    if (!(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });

    // Artículo común: no está en el catálogo, trae su propio nombre y precio
    if (p.comun) {
      const descripcion = (p.descripcion || '').trim();
      const precio = Number(p.precio);
      if (!descripcion) return res.status(400).json({ error: 'El artículo común necesita un nombre' });
      if (!(precio > 0)) return res.status(400).json({ error: 'Precio del artículo común no válido' });
      const importe = Math.round(precio * cantidad * 100) / 100;
      total += importe;
      renglones.push({
        producto_id: productoComun().id,
        descripcion,
        cantidad,
        precio_unitario: precio,
        costo_unitario: 0,
        importe,
        usa_inventario: 0,
      });
      continue;
    }

    const producto = buscarProducto.get(p.producto_id);
    if (!producto) return res.status(400).json({ error: `Producto ${p.producto_id} no existe` });

    // No permitir vender más de lo que hay en existencia
    if (producto.usa_inventario) {
      const existencia = buscarExistencia.get(producto.id, sucursalId)?.existencia ?? 0;
      if (cantidad > existencia) {
        return res.status(400).json({
          error: `No hay suficiente existencia de "${producto.descripcion}" (hay ${existencia} y se piden ${cantidad})`,
        });
      }
    }

    const precio =
      mayoreo && producto.precio_mayoreo != null ? producto.precio_mayoreo : producto.precio_venta;
    const importe = Math.round(precio * cantidad * 100) / 100;
    total += importe;
    renglones.push({
      producto_id: producto.id,
      descripcion: producto.descripcion,
      cantidad,
      precio_unitario: precio,
      costo_unitario: producto.precio_costo,
      importe,
      usa_inventario: producto.usa_inventario,
    });
  }
  total = Math.round(total * 100) / 100;

  // Cálculo del pago según la forma elegida
  let pagoNum = Number(pago) || 0;
  let cambio = 0;
  let pagoUsd = null;
  let tipoCambio = null;
  let pagoEfectivo = null;
  let pagoTarjeta = null;

  if (forma_pago === 'efectivo') {
    if (pagoNum < total) return res.status(400).json({ error: 'El pago es menor que el total' });
    cambio = Math.round((pagoNum - total) * 100) / 100;
  } else if (forma_pago === 'dolar') {
    tipoCambio = db
      .prepare(
        `SELECT a.tipo_cambio FROM sesiones se
         JOIN aperturas_caja a ON a.id = se.apertura_id
         WHERE se.token = ?`
      )
      .get(req.sesionToken)?.tipo_cambio;
    if (!tipoCambio) {
      return res.status(400).json({ error: 'No hay tipo de cambio registrado; captura la apertura de caja' });
    }
    pagoUsd = Number(pago_usd);
    if (!(pagoUsd > 0)) return res.status(400).json({ error: 'Pago en dólares no válido' });
    pagoNum = Math.round(pagoUsd * tipoCambio * 100) / 100;
    if (pagoNum + 0.005 < total) return res.status(400).json({ error: 'El pago es menor que el total' });
    cambio = Math.max(Math.round((pagoNum - total) * 100) / 100, 0); // el cambio se da en pesos
  } else if (forma_pago === 'mixto') {
    pagoEfectivo = Number(pago_efectivo);
    if (!(pagoEfectivo > 0) || pagoEfectivo >= total) {
      return res.status(400).json({ error: 'En pago mixto el efectivo debe ser mayor a 0 y menor que el total' });
    }
    pagoEfectivo = Math.round(pagoEfectivo * 100) / 100;
    pagoTarjeta = Math.round((total - pagoEfectivo) * 100) / 100;
    pagoNum = total;
  } else {
    pagoNum = total; // tarjeta y crédito se cobran exactos
  }

  if (forma_pago === 'credito') {
    const cliente = db
      .prepare('SELECT * FROM clientes WHERE id = ? AND activo = 1')
      .get(cliente_id);
    if (!cliente) return res.status(400).json({ error: 'Cliente no encontrado' });
    if (!cliente.credito_autorizado) {
      return res.status(400).json({ error: 'El cliente no tiene crédito autorizado' });
    }
    const saldo = db
      .prepare(
        `SELECT COALESCE((SELECT SUM(total) FROM ventas WHERE cliente_id = ? AND forma_pago = 'credito'), 0)
              - COALESCE((SELECT SUM(monto) FROM abonos WHERE cliente_id = ?), 0) AS saldo`
      )
      .get(cliente_id, cliente_id).saldo;
    if (cliente.limite_credito > 0 && saldo + total > cliente.limite_credito) {
      return res.status(400).json({
        error: `Se rebasa el límite de crédito del cliente (debe $${saldo.toFixed(2)}, límite $${cliente.limite_credito.toFixed(2)})`,
      });
    }
  }

  const resultado = db.transaction(() => {
    const folio =
      db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM ventas WHERE sucursal_id = ?').get(sucursalId).f;
    const ventaId = db
      .prepare(
        `INSERT INTO ventas (folio, sucursal_id, usuario_id, cliente_id, forma_pago, total, pago, cambio,
           pago_usd, tipo_cambio, pago_efectivo, pago_tarjeta, nota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        folio, sucursalId, req.usuario.id, cliente_id || null, forma_pago, total, pagoNum, cambio,
        pagoUsd, tipoCambio, pagoEfectivo, pagoTarjeta, (nota || '').trim()
      )
      .lastInsertRowid;

    const insDetalle = db.prepare(
      `INSERT INTO venta_detalle (venta_id, producto_id, descripcion, cantidad, precio_unitario, costo_unitario, importe)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const asegurarInv = db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0) ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    );
    const descontar = db.prepare(
      'UPDATE inventario SET existencia = existencia - ? WHERE producto_id = ? AND sucursal_id = ?'
    );
    const movimiento = db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, 'venta', ?, ?, ?)`
    );
    for (const r of renglones) {
      insDetalle.run(ventaId, r.producto_id, r.descripcion, r.cantidad, r.precio_unitario, r.costo_unitario, r.importe);
      if (r.usa_inventario) {
        asegurarInv.run(r.producto_id, sucursalId);
        descontar.run(r.cantidad, r.producto_id, sucursalId);
        movimiento.run(r.producto_id, sucursalId, r.cantidad, req.usuario.id, `Venta folio ${folio}`);
      }
    }
    return { ventaId, folio, total, cambio };
  })();

  res.json({ ok: true, ...resultado });
});

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
  const venta = db
    .prepare(
      `SELECT v.*, s.nombre AS sucursal, s.direccion, s.telefono, u.nombre AS cajero,
              c.nombre AS cliente
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.id = ?`
    )
    .get(req.params.id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
  venta.partidas = db
    .prepare('SELECT * FROM venta_detalle WHERE venta_id = ?')
    .all(venta.id);
  res.json(venta);
});

// Ventas del día de la sucursal del usuario
router.get('/', (req, res) => {
  const fecha = req.query.fecha || new Date().toLocaleDateString('sv-SE');
  const ventas = db
    .prepare(
      `SELECT v.id, v.folio, v.fecha, v.forma_pago, v.total, v.pago, v.cambio,
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
