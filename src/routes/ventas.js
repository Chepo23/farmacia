const express = require('express');
const db = require('../db');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const cotizaciones = require('../cotizaciones');
const { pendienteDe } = require('./prestamos');
const bitacora = require('../bitacora');
const { manejar, ErrorApp } = require('../central');
const { aperturaVigente } = require('../caja');

const router = express.Router();

const FORMAS_PAGO = ['efectivo', 'tarjeta', 'credito', 'dolar', 'mixto'];
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const redondearCantidad = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const pesos = (n) => `$${redondear(n).toFixed(2)}`;
const conPrecioManual = (p) => p.precio_manual !== undefined && p.precio_manual !== null && p.precio_manual !== '';
const abajoDelCosto = (descripcion, costo) => ({
  error: `"${descripcion}": no se puede vender abajo del costo (${pesos(costo)})`,
  codigo: 'ABAJO_DEL_COSTO',
});

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
  // Lo que se ahorró: por mayoreo o cotización, o lo que se descontó al cambiar el precio en la venta
  venta.ahorro = redondear(
    venta.partidas.reduce((t, p) => t + Math.max(0, Number(p.precio_manual) === 1
      ? Number(p.descuento) || 0
      : ((p.precio_lista ?? p.precio_unitario) - p.precio_unitario) * p.cantidad), 0)
  );
  if (venta.cliente_id && venta.forma_pago === 'credito') venta.saldo_cliente = saldoCliente(venta.cliente_id);
  return venta;
}

// Sin conexión con la central no se puede usar la cotización (la venta normal sí se puede hacer)
async function conCotizacion(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!error.sinConexion) throw error;
    throw new ErrorApp(
      'Sin conexión con la central no se puede usar la cotización. Quítala de la venta para cobrar con los precios de hoy, o intenta de nuevo.',
      { status: 503, codigo: 'COTIZACION_SIN_CONEXION' }
    );
  }
}

// Precios del cóctel que se arma en la caja (botón Cóctel): lo que lleva se cobra junto a uno de estos
const PRECIOS_COCTEL = [150, 200, 250];
const coctelValido = (c) => Number.isInteger(Number(c.grupo))
  && (Number(c.id) > 0 || PRECIOS_COCTEL.includes(Number(c.precio)));

// Registrar una venta completa
router.post('/', manejar(async (req, res) => {
  const { partidas, forma_pago, pago, cliente_id, mayoreo, nota, pago_usd, pago_efectivo, cotizacion_id } = req.body || {};
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

  // Cantidades válidas y total de piezas sueltas por producto (para el precio de mayoreo por cantidad).
  // caja: se vende la caja completa (cantidad = cajas). coctel: { id, grupo } = ese renglón va en un
  // cóctel (las ampolletas de un mismo grupo se cobran juntas al precio del cóctel).
  const cantidadPorProducto = new Map();
  const ids = new Set();
  for (const p of partidas) {
    const cantidad = Number(p.cantidad);
    if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Cantidad no válida' });
    if (p.caja && !Number.isInteger(cantidad)) return res.status(400).json({ error: 'Las cajas se venden completas' });
    if (p.coctel && (p.comun || p.caja)) return res.status(400).json({ error: 'En un cóctel solo van productos sueltos del catálogo' });
    if (p.coctel && !coctelValido(p.coctel)) {
      return res.status(400).json({ error: 'Cóctel no válido' });
    }
    if (p.prestamo_detalle_id != null && (p.comun || p.caja || p.coctel)) {
      return res.status(400).json({ error: 'Lo de un préstamo se cobra por pieza' });
    }
    // Precio cambiado solo en esta venta (doble clic en el precio)
    if (conPrecioManual(p)) {
      if (p.comun || p.coctel) return res.status(400).json({ error: 'Ese renglón no lleva un precio especial' });
      if (!Number.isFinite(Number(p.precio_manual)) || !(Number(p.precio_manual) > 0)) return res.status(400).json({ error: 'Precio no válido' });
    }
    if (!p.comun) {
      const id = Number(p.producto_id);
      ids.add(id);
      if (!p.caja && !p.coctel && p.prestamo_detalle_id == null) cantidadPorProducto.set(id, (cantidadPorProducto.get(id) || 0) + cantidad);
    }
    if (p.coctel && Number(p.coctel.id) > 0) ids.add(Number(p.coctel.id)); // cóctel de antes (producto del catálogo)
  }
  const productos = await catalogo.porIds([...ids]);

  // Cotización: mientras esté vigente se respeta su precio (o el de hoy, si es más bajo), siempre
  // que no se lleven más piezas de las cotizadas
  let cotizacion = null;
  if (cotizacion_id) {
    cotizacion = await conCotizacion(() => cotizaciones.paraVenta(cotizacion_id, req.usuario));
  }

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
    if (producto.es_coctel) {
      return res.status(400).json({ error: 'Para cobrar un cóctel toca el botón Cóctel (F10) en la venta' });
    }
    // Caja completa: su precio, y se descuentan todas sus piezas (el inventario va en piezas)
    if (p.caja) {
      if (!(producto.piezas_caja >= 2 && producto.precio_caja > 0)) {
        return res.status(400).json({ error: `"${producto.descripcion}" no se vende por caja` });
      }
      const piezas = redondearCantidad(cantidad * producto.piezas_caja);
      const porPieza = redondear(producto.precio_caja / producto.piezas_caja);
      const manual = conPrecioManual(p);
      const precioCaja = manual ? redondear(p.precio_manual) : producto.precio_caja;
      const costoCaja = redondear((Number(producto.precio_costo) || 0) * producto.piezas_caja);
      if (manual && costoCaja > 0 && precioCaja + 0.005 < costoCaja) {
        return res.status(400).json(abajoDelCosto(`${producto.descripcion} (caja)`, costoCaja));
      }
      renglones.push({
        producto_id: producto.id,
        descripcion: `${producto.descripcion} (caja c/${producto.piezas_caja})`,
        cantidad: piezas,
        precio_unitario: manual ? redondear(precioCaja / producto.piezas_caja) : porPieza,
        precio_lista: porPieza,
        costo_unitario: producto.precio_costo,
        importe: redondear(cantidad * precioCaja),
        usa_inventario: producto.usa_inventario ? 1 : 0,
        cajas: cantidad,
        precio_manual: manual ? 1 : 0,
        descuento: manual ? redondear((producto.precio_caja - precioCaja) * cantidad) : 0,
        cambio_precio: manual ? { normal: redondear(producto.precio_caja), cobrado: precioCaja, unidad: 'caja' } : null,
      });
      continue;
    }
    // En un cóctel cada ampolleta entra a su precio normal; después se reparte el precio del cóctel
    if (p.coctel) {
      renglones.push({
        producto_id: producto.id,
        descripcion: producto.descripcion,
        cantidad,
        precio_unitario: producto.precio_venta,
        precio_lista: producto.precio_venta,
        costo_unitario: producto.precio_costo,
        importe: redondear(producto.precio_venta * cantidad),
        usa_inventario: producto.usa_inventario ? 1 : 0,
        coctel_id: Number(p.coctel.id) > 0 ? Number(p.coctel.id) : 0,
        coctel_precio: Number(p.coctel.id) > 0 ? null : Number(p.coctel.precio),
        coctel_grupo: Number(p.coctel.grupo),
      });
      continue;
    }
    // Lo que se llevaron prestado y ahora pagan: ya salió del inventario al prestarlo
    let prestamo = null;
    if (p.prestamo_detalle_id != null) {
      const d = db.prepare(
        `SELECT d.*, pr.sucursal_id, pr.folio FROM prestamo_detalle d JOIN prestamos pr ON pr.id = d.prestamo_id WHERE d.id = ?`
      ).get(Number(p.prestamo_detalle_id));
      if (!d || Number(d.sucursal_id) !== Number(sucursalId) || Number(d.producto_id) !== Number(producto.id)) {
        return res.status(400).json({ error: `"${producto.descripcion}" ya no está en ese préstamo` });
      }
      if (cantidad > pendienteDe(d) + 0.0005) {
        return res.status(400).json({ error: `Del préstamo P-${d.folio} solo faltan ${pendienteDe(d)} de "${producto.descripcion}"` });
      }
      prestamo = { detalle_id: Number(d.id), prestamo_id: Number(d.prestamo_id), folio: d.folio };
    }
    // Mayoreo: con F11 en el renglón (o en toda la venta, como antes), o automático al llegar a la
    // cantidad de mayoreo del producto. Un renglón con F11 pone en mayoreo todas las piezas sueltas de ese producto.
    const totalProducto = cantidadPorProducto.get(producto.id) || cantidad;
    const conF11 = Boolean(mayoreo) || partidas.some((x) => Number(x.producto_id) === Number(producto.id) && x.mayoreo
      && !x.caja && !x.coctel && x.prestamo_detalle_id == null);
    const aplicaMayoreo = producto.precio_mayoreo != null
      && (conF11 || (producto.cantidad_mayoreo > 0 && totalProducto >= producto.cantidad_mayoreo));
    let precio = aplicaMayoreo ? producto.precio_mayoreo : producto.precio_venta;
    const cotizado = cotizacion && cotizacion.vigente ? cotizacion.precios.get(producto.id) : null;
    if (cotizado && totalProducto <= cotizado.cantidad + 1e-9) precio = Math.min(precio, cotizado.precio);
    const manual = conPrecioManual(p);
    const normal = precio;
    if (manual) {
      precio = redondear(p.precio_manual);
      if (Number(producto.precio_costo) > 0 && precio + 0.005 < Number(producto.precio_costo)) {
        return res.status(400).json(abajoDelCosto(producto.descripcion, producto.precio_costo));
      }
    }
    const importe = redondear(precio * cantidad);
    renglones.push({
      producto_id: producto.id,
      descripcion: producto.descripcion,
      cantidad,
      precio_unitario: precio,
      precio_lista: producto.precio_venta,
      costo_unitario: producto.precio_costo,
      importe,
      usa_inventario: producto.usa_inventario && !prestamo ? 1 : 0,
      prestamo,
      precio_manual: manual ? 1 : 0,
      descuento: manual ? redondear((normal - precio) * cantidad) : 0,
      cambio_precio: manual ? { normal: redondear(normal), cobrado: precio, unidad: 'pieza' } : null,
    });
  }

  // Cócteles: las ampolletas (y la jeringa) de un grupo se cobran juntas al precio del cóctel, repartido
  // entre ellas según su precio normal. El inventario descuenta exactamente lo que se usó.
  const grupos = new Map();
  for (const r of renglones) {
    if (!r.coctel_grupo && r.coctel_grupo !== 0) continue;
    if (!grupos.has(r.coctel_grupo)) grupos.set(r.coctel_grupo, { coctelId: r.coctel_id, precio: r.coctel_precio, renglones: [] });
    const g = grupos.get(r.coctel_grupo);
    if (g.coctelId !== r.coctel_id || g.precio !== r.coctel_precio) return res.status(400).json({ error: 'Un cóctel tiene renglones de otro cóctel' });
    g.renglones.push(r);
  }
  for (const g of grupos.values()) {
    // Cóctel armado en la caja (precio elegido: 150, 200 o 250) o, como antes, un producto cóctel del catálogo
    const coctel = g.coctelId ? productos.get(g.coctelId) : { descripcion: 'Cóctel', precio_venta: g.precio, es_coctel: 1 };
    if (!coctel || !coctel.es_coctel) return res.status(400).json({ error: 'Ese cóctel ya no está disponible' });
    if (g.renglones.length < 2) return res.status(400).json({ error: 'Un cóctel lleva por lo menos dos productos' });
    const precioCoctel = redondear(coctel.precio_venta);
    const normal = g.renglones.reduce((t, r) => t + r.importe, 0);
    let repartido = 0;
    g.renglones.forEach((r, i) => {
      const ultimo = i === g.renglones.length - 1;
      const parte = ultimo
        ? redondear(precioCoctel - repartido)
        : redondear(normal > 0 ? (precioCoctel * r.importe) / normal : precioCoctel / g.renglones.length);
      repartido = redondear(repartido + parte);
      r.importe = parte;
      r.precio_unitario = redondear(parte / r.cantidad);
      r.precio_lista = r.precio_unitario;
      r.coctel = coctel.descripcion;
    });
  }
  const total = redondear(renglones.reduce((t, r) => t + r.importe, 0));

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

  // La cotización se aparta antes de guardar la venta, así dos cajas no la cobran dos veces
  if (cotizacion) await conCotizacion(() => cotizaciones.apartar(cotizacion.id, req.usuario));
  const notaVenta = [cotizacion ? `Cotización folio ${cotizacion.folio}${cotizacion.cliente ? ` · ${cotizacion.cliente}` : ''}` : '',
    String(nota || '').trim()].filter(Boolean).join(' · ').slice(0, 300);

  // 1) Se guarda la venta (así queda apartado el folio)
  let guardada;
  try {
    guardada = db.transaction(() => {
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
          forma_pago, total, pagoNum, cambio, pagoUsd, tipoCambio, pagoEfectivo, pagoTarjeta, notaVenta
        ).lastInsertRowid;
      const insDetalle = db.prepare(
        `INSERT INTO venta_detalle (venta_id, producto_id, descripcion, cantidad, precio_unitario, costo_unitario,
           importe, descuenta_inventario, precio_lista, coctel, coctel_grupo, cajas, precio_manual, descuento, prestamo_detalle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const cobrarPrestamo = db.prepare(
        'UPDATE prestamo_detalle SET cobrado = cobrado + @cantidad WHERE id = @id AND cantidad - devuelto - cobrado >= @cantidad - 0.0005'
      );
      const anotarCobro = db.prepare(
        "INSERT INTO prestamo_movimientos (prestamo_id, detalle_id, tipo, cantidad, venta_id, usuario_id) VALUES (?, ?, 'cobro', ?, ?, ?)"
      );
      for (const r of renglones) {
        insDetalle.run(id, r.producto_id, r.descripcion, r.cantidad, r.precio_unitario, r.costo_unitario, r.importe,
          r.usa_inventario, r.precio_lista, r.coctel || '', r.coctel ? r.coctel_grupo : null, r.cajas ?? null, r.precio_manual || 0,
          r.descuento || 0, r.prestamo ? r.prestamo.detalle_id : null);
        if (r.prestamo) {
          if (!cobrarPrestamo.run({ id: r.prestamo.detalle_id, cantidad: r.cantidad }).changes) {
            throw new ErrorApp(`El préstamo P-${r.prestamo.folio} cambió (¿ya lo regresaron o lo cobraron?): vuelve a cargarlo`);
          }
          anotarCobro.run(r.prestamo.prestamo_id, r.prestamo.detalle_id, r.cantidad, id, req.usuario.id);
          db.prepare('UPDATE prestamos SET subir = 1 WHERE id = ?').run(r.prestamo.prestamo_id);
        }
      }
      return { ventaId: id, folio: siguiente };
    })();
  } catch (error) {
    if (cotizacion) await cotizaciones.liberar(cotizacion.id);
    throw error;
  }
  const { ventaId, folio } = guardada;

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
    if (cotizacion) await cotizaciones.liberar(cotizacion.id);
    throw error;
  }
  try {
    db.transaction(() => plan.aplicarLocal())();
  } catch (error) {
    borrarVenta(ventaId);
    await plan.revertir();
    if (cotizacion) await cotizaciones.liberar(cotizacion.id);
    throw error;
  }
  // Los precios cambiados en la venta quedan en el registro de cambios (el jefe los ve)
  const cambiados = renglones.filter((r) => r.cambio_precio);
  if (cambiados.length) {
    const cajasDe = (r) => (r.cajas ? r.cajas : r.cantidad);
    const descuento = redondear(cambiados.reduce((t, r) => t + r.descuento, 0));
    bitacora.registrar({
      usuario: req.usuario,
      sucursal_id: sucursalId,
      tipo: 'precio_en_venta',
      descripcion: `Folio ${folio}: ${cambiados.map((r) => `${r.descripcion} ${pesos(r.cambio_precio.normal)} → ${pesos(r.cambio_precio.cobrado)}`
        + `${r.cambio_precio.unidad === 'caja' ? ' la caja' : ''}${cajasDe(r) !== 1 ? ` (${cajasDe(r)})` : ''}`).join(', ')}`
        + `${descuento > 0 ? `; descuento ${pesos(descuento)}` : descuento < 0 ? `; ${pesos(-descuento)} más caro` : ''}`,
      detalle: {
        venta_id: ventaId,
        folio,
        descuento,
        renglones: cambiados.map((r) => ({ producto: r.descripcion, cantidad: cajasDe(r), ...r.cambio_precio })),
      },
      alerta: descuento > 0.005,
    });
  }

  if (cotizacion) {
    // La venta ya quedó: si no se puede anotar el folio, la cotización igual queda como vendida
    await cotizaciones.confirmarVenta(cotizacion.id, folio).catch((error) => {
      console.error('No se pudo anotar el folio de venta en la cotización:', error.message);
    });
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
    cotizacion: cotizacion ? { id: cotizacion.id, folio: cotizacion.folio, vigente: cotizacion.vigente } : null,
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
  const deUnPrestamo = db.prepare('SELECT cantidad, prestamo_detalle_id FROM venta_detalle WHERE venta_id = ? AND prestamo_detalle_id IS NOT NULL').all(venta.id);
  if (deUnPrestamo.length) {
    db.transaction(() => {
      for (const l of deUnPrestamo) {
        db.prepare('UPDATE prestamo_detalle SET cobrado = MAX(0, cobrado - ?) WHERE id = ?').run(l.cantidad, l.prestamo_detalle_id);
        db.prepare("UPDATE prestamo_movimientos SET anulado = 1 WHERE venta_id = ? AND detalle_id = ? AND tipo = 'cobro'").run(venta.id, l.prestamo_detalle_id);
        db.prepare('UPDATE prestamos SET subir = 1 WHERE id = (SELECT prestamo_id FROM prestamo_detalle WHERE id = ?)').run(l.prestamo_detalle_id);
      }
    })();
  }
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: venta.sucursal_id, tipo: 'venta_cancelada',
    descripcion: `Folio ${venta.folio} por $${Number(venta.total).toFixed(2)} (${venta.forma_pago}): ${motivo}`,
    detalle: { venta_id: venta.id, folio: venta.folio, total: venta.total, forma_pago: venta.forma_pago, motivo, vendio: venta.usuario_id },
    alerta: true,
  });
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
