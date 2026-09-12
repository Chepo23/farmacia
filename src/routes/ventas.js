const express = require('express');
const db = require('../db');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');

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

async function buscarProductoLocalOCentral(id, sucursalId) {
  const local = db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1').get(id);
  if (!hasSupabase || !supabaseAdmin) return local;

  const { data, error } = await supabaseAdmin.from('productos')
    .select('*').eq('id', Number(id)).eq('activo', true).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  // Los IDs de SQLite pueden apuntar a otro producto; Supabase es la autoridad cuando hay internet.
  if (data.codigo_barras) {
    db.prepare('UPDATE productos SET codigo_barras = NULL, activo = 0 WHERE codigo_barras = ? AND id <> ?')
      .run(data.codigo_barras, data.id);
  }
  db.prepare(`INSERT INTO productos (id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,
    precio_mayoreo,cantidad_mayoreo,usa_inventario,es_comun,activo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET codigo_barras=excluded.codigo_barras,descripcion=excluded.descripcion,
      departamento=excluded.departamento,precio_costo=excluded.precio_costo,precio_venta=excluded.precio_venta,
      precio_mayoreo=excluded.precio_mayoreo,cantidad_mayoreo=excluded.cantidad_mayoreo,
      usa_inventario=excluded.usa_inventario,es_comun=excluded.es_comun,activo=excluded.activo`).run(
    data.id, data.codigo_barras, data.descripcion, data.departamento || '', data.precio_costo || 0,
    data.precio_venta || 0, data.precio_mayoreo, data.cantidad_mayoreo, data.usa_inventario ? 1 : 0,
    data.es_comun ? 1 : 0, 1
  );
  const { data: inventario, error: inventarioError } = await supabaseAdmin.from('inventario')
    .select('existencia,minimo').eq('producto_id', Number(id)).eq('sucursal_id', Number(sucursalId)).maybeSingle();
  if (inventarioError) throw inventarioError;
  if (inventario) {
    db.prepare(`INSERT INTO inventario (producto_id,sucursal_id,existencia,minimo) VALUES (?,?,?,?)
      ON CONFLICT(producto_id,sucursal_id) DO UPDATE SET existencia=excluded.existencia,minimo=excluded.minimo`)
      .run(id, sucursalId, inventario.existencia || 0, inventario.minimo || 0);
  }
  return db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1').get(id);
}

async function sincronizarDescuentoCentral(renglones, sucursalId, usuarioId) {
  if (!hasSupabase || !supabaseAdmin) return null;
  const cantidades = new Map();
  for (const renglon of renglones) {
    if (!renglon.usa_inventario) continue;
    cantidades.set(renglon.producto_id, (cantidades.get(renglon.producto_id) || 0) + renglon.cantidad);
  }
  for (const [productoId, cantidad] of cantidades) {
    const { data: inventario, error: consultaError } = await supabaseAdmin.from('inventario')
      .select('existencia,minimo').eq('producto_id', productoId).eq('sucursal_id', sucursalId).maybeSingle();
    if (consultaError) throw consultaError;
    const existencia = Number(inventario?.existencia || 0);
    if (!inventario || cantidad > existencia) {
      throw new Error(`El inventario central no tiene existencia suficiente para el producto ${productoId}`);
    }
    const { error: updateError } = await supabaseAdmin.from('inventario')
      .update({ existencia: existencia - cantidad, updated_at: new Date().toISOString() })
      .eq('producto_id', productoId).eq('sucursal_id', sucursalId);
    if (updateError) throw updateError;
    const { error: movimientoError } = await supabaseAdmin.from('movimientos_inventario').insert({
      producto_id: productoId, sucursal_id: sucursalId, tipo: 'venta', cantidad,
      usuario_id: usuarioId, nota: 'Venta local sincronizada',
    });
    if (movimientoError) throw movimientoError;
  }
  return true;
}

// Registrar una venta completa
router.post('/', async (req, res) => {
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

    let producto;
    try {
      producto = await buscarProductoLocalOCentral(p.producto_id, sucursalId);
    } catch (error) {
      return res.status(502).json({ error: 'No se pudo consultar el producto central: ' + error.message });
    }
    if (!producto) {
      return res.status(400).json({
        error: hasSupabase
          ? `El producto ${p.producto_id} no existe activo en Supabase o no se pudo sincronizar en esta computadora`
          : `El producto ${p.producto_id} no existe en SQLite y esta computadora no tiene Supabase configurado`,
      });
    }

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

  let inventarioSincronizado = true;
  let avisoSincronizacion = null;
  try {
    await sincronizarDescuentoCentral(renglones, sucursalId, req.usuario.id);
  } catch (error) {
    inventarioSincronizado = false;
    avisoSincronizacion = error.message;
    console.error('No se pudo sincronizar descuento de inventario:', error.message);
  }

  res.json({ ok: true, ...resultado, inventarioSincronizado, avisoSincronizacion });
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
