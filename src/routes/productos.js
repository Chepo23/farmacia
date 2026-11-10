// Catálogo e inventario. Todas las existencias salen del módulo de inventario unificado,
// así Productos, Venta, la búsqueda F3, Bajo mínimo, Apoyos y Reportes muestran lo mismo.
const express = require('express');
const db = require('../db');
const { requiereAdmin } = require('../auth');
const catalogo = require('../catalogo');
const inventario = require('../inventario');
const bitacora = require('../bitacora');
const { ErrorApp, manejar } = require('../central');
const { describirCambiosProducto } = require('../../supabase/functions/movil/supervision.mjs');

const router = express.Router();

const esAdminCentral = (usuario) => usuario.rol === 'admin' && Number(usuario.es_central) === 1;

// Los precios son los mismos en todas las sucursales: solo el administrador de la central los fija
const CAMPOS_PRECIO = ['precio_costo', 'precio_venta', 'precio_mayoreo', 'cantidad_mayoreo'];
const mismoValor = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);

// Los cajeros solo mueven el inventario de su sucursal; el administrador de la central, el de cualquiera
function sucursalPermitida(req, sucursalId) {
  const sucursal = Number(sucursalId || req.usuario.sucursal_id);
  if (!sucursal) throw new ErrorApp('Sucursal no válida');
  if (sucursal !== Number(req.usuario.sucursal_id) && !esAdminCentral(req.usuario)) {
    throw new ErrorApp('Solo puedes modificar el inventario de tu sucursal', { status: 403 });
  }
  if (!db.prepare('SELECT 1 FROM sucursales WHERE id = ? AND activa = 1').get(sucursal)) {
    throw new ErrorApp('Sucursal no válida');
  }
  return sucursal;
}

function limiteDe(valor, porDefecto, maximo) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? Math.min(Math.floor(numero), maximo) : porDefecto;
}

async function listar(req, limitePorDefecto) {
  // ?ids=1,2,3: esos productos con sus datos de hoy (las ventas que quedaron abiertas se actualizan así)
  if (req.query.ids !== undefined) {
    const ids = String(req.query.ids).split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 500);
    const mapa = await catalogo.porIds(ids);
    const { productos: conStock, fuente } = await inventario.conExistencias([...mapa.values()], { sucursalId: req.usuario.sucursal_id });
    return { conStock, fuente };
  }
  const { productos } = await catalogo.buscar({
    q: req.query.q || '',
    limite: limiteDe(req.query.limite, limitePorDefecto, 1000),
  });
  const { productos: conStock, fuente } = await inventario.conExistencias(productos, { sucursalId: req.usuario.sucursal_id });
  return { conStock, fuente };
}

// Buscar por código de barras exacto (pantalla de venta / escáner)
router.get('/codigo/:codigo', manejar(async (req, res) => {
  const producto = await catalogo.porCodigo(req.params.codigo);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const { productos } = await inventario.conExistencias([producto], { sucursalId: req.usuario.sucursal_id });
  res.json(productos[0]);
}));

// Buscar por descripción o código (F3 en venta y en apoyos)
router.get('/buscar', manejar(async (req, res) => {
  const { conStock, fuente } = await listar(req, 50);
  res.set('X-Fuente-Inventario', fuente);
  res.json(conStock);
}));

// Listado del catálogo con existencias en todas las sucursales
router.get('/', manejar(async (req, res) => {
  const { conStock, fuente } = await listar(req, 300);
  res.set('X-Fuente-Inventario', fuente);
  res.json(conStock);
}));

// Productos en o por debajo del mínimo (la central puede consultar otra sucursal)
router.get('/bajo-minimo', manejar(async (req, res) => {
  const sucursal = req.query.sucursal_id && esAdminCentral(req.usuario)
    ? Number(req.query.sucursal_id)
    : Number(req.usuario.sucursal_id);
  const { filas, fuente } = await inventario.bajoMinimo(sucursal);
  res.set('X-Fuente-Inventario', fuente);
  res.json(filas);
}));

// Estado de la sincronización con la central (para el aviso de la barra superior)
router.get('/sincronizacion', manejar(async (req, res) => {
  res.json(inventario.estadoSincronizacion());
}));

router.post('/sincronizacion/reintentar', requiereAdmin, manejar(async (req, res) => {
  const reactivados = inventario.reintentarErrores();
  const resultado = await inventario.sincronizarPendientes();
  res.json({ ok: true, reactivados, ...resultado, estado: inventario.estadoSincronizacion() });
}));

router.post('/sincronizacion/:id/descartar', requiereAdmin, manejar(async (req, res) => {
  const descartados = inventario.descartarError(Number(req.params.id));
  if (!descartados) return res.status(404).json({ error: 'Movimiento no encontrado' });
  res.json({ ok: true, estado: inventario.estadoSincronizacion() });
}));

// Varios movimientos de una sola vez (recepción de mercancía y conteo físico desde el celular).
//   tipo 'entrada': renglones [{ producto_id, cantidad }] — lo que llegó se suma
//   tipo 'conteo':  renglones [{ producto_id, contado, existencia_al_contar }] — se aplica la
//     diferencia entre lo contado y lo que decía el sistema AL CONTAR, así las ventas hechas
//     mientras se contaba no se pierden.
// Todo o nada: si un producto falla, no se aplica ninguno.
router.post('/inventario/lote', manejar(async (req, res) => {
  const tipo = String(req.body?.tipo || '');
  if (!['entrada', 'conteo'].includes(tipo)) return res.status(400).json({ error: 'Tipo de operación no válido' });
  const sucursalId = sucursalPermitida(req, req.body?.sucursal_id);
  const renglones = Array.isArray(req.body?.renglones) ? req.body.renglones : [];
  if (renglones.length === 0) return res.status(400).json({ error: 'No hay productos en la lista' });
  if (renglones.length > 500) return res.status(400).json({ error: 'La lista es demasiado grande (máximo 500 productos)' });
  const nota = String(req.body?.nota || '').trim().slice(0, 200);

  // Un renglón por producto
  const porProducto = new Map();
  for (const r of renglones) {
    const id = Number(r.producto_id);
    if (!(id > 0)) return res.status(400).json({ error: 'Producto no válido en la lista' });
    if (tipo === 'entrada') {
      const cantidad = Number(r.cantidad);
      if (!Number.isFinite(cantidad) || !(cantidad > 0)) return res.status(400).json({ error: 'Hay una cantidad no válida en la lista' });
      porProducto.set(id, { cantidad: (porProducto.get(id)?.cantidad || 0) + cantidad });
    } else {
      const contado = Number(r.contado);
      const alContar = Number(r.existencia_al_contar);
      if (!Number.isFinite(contado) || contado < 0 || !Number.isFinite(alContar)) {
        return res.status(400).json({ error: 'Hay un conteo no válido en la lista' });
      }
      porProducto.set(id, { contado, alContar });
    }
  }
  const productos = await catalogo.porIds([...porProducto.keys()], { incluirInactivos: true });
  const faltan = [...porProducto.keys()].filter((id) => !productos.has(id));
  if (faltan.length) return res.status(404).json({ error: `Hay productos que ya no existen en el catálogo (${faltan.join(', ')})` });

  const movimientos = [];
  const omitidos = [];
  let sinDiferencia = 0;
  for (const [id, r] of porProducto) {
    const producto = productos.get(id);
    if (!producto.usa_inventario) {
      omitidos.push(producto.descripcion);
      continue;
    }
    if (tipo === 'entrada') {
      movimientos.push({
        producto_id: id, sucursal_id: sucursalId, tipo: 'entrada', cantidad: r.cantidad,
        nota: nota ? `Recepción de mercancía: ${nota}` : 'Recepción de mercancía',
      });
      continue;
    }
    const diferencia = Math.round((r.contado - r.alContar) * 1000) / 1000;
    if (Math.abs(diferencia) < 0.001) {
      sinDiferencia += 1;
      continue;
    }
    movimientos.push({
      producto_id: id, sucursal_id: sucursalId, tipo: diferencia > 0 ? 'entrada' : 'salida',
      cantidad: Math.abs(diferencia), validar: false,
      nota: `Conteo físico: el sistema tenía ${r.alContar} y se contaron ${r.contado}${nota ? ` — ${nota}` : ''}`,
    });
  }
  const resultados = movimientos.length ? await inventario.aplicar(movimientos, { usuarioId: req.usuario.id }) : [];
  res.json({ ok: true, aplicados: movimientos.length, sin_diferencia: sinDiferencia, omitidos, existencias: resultados });
}));

// Cualquier usuario da de alta un producto nuevo (por ejemplo, al recibir mercancía con el celular)
// con su existencia en su sucursal. Cambiar los precios de uno que ya existe sigue siendo de la central.
router.post('/', manejar(async (req, res) => {
  const datos = catalogo.validar(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  const sucursalId = sucursalPermitida(req, req.body?.sucursal_id);
  const existenciaInicial = req.body?.existencia_inicial === '' || req.body?.existencia_inicial == null
    ? 0 : Number(req.body.existencia_inicial);
  const minimoInicial = req.body?.minimo_inicial === '' || req.body?.minimo_inicial == null
    ? 0 : Number(req.body.minimo_inicial);
  if (!Number.isFinite(existenciaInicial) || existenciaInicial < 0) {
    return res.status(400).json({ error: 'Existencia inicial no válida' });
  }
  if (!Number.isFinite(minimoInicial) || minimoInicial < 0) {
    return res.status(400).json({ error: 'Mínimo inicial no válido' });
  }

  const producto = await catalogo.crear(datos);
  bitacora.registrar({
    usuario: req.usuario, sucursal_id: sucursalId, tipo: 'producto_alta',
    descripcion: `${producto.descripcion} (${producto.codigo_barras || 'sin código'}) a $${Number(producto.precio_venta).toFixed(2)}`
      + `${existenciaInicial > 0 ? `, con ${existenciaInicial} pieza(s)` : ''}`,
    detalle: { producto_id: producto.id, precio_venta: producto.precio_venta, precio_costo: producto.precio_costo, existencia_inicial: existenciaInicial },
  });
  let aviso = null;
  if (producto.usa_inventario && (existenciaInicial > 0 || minimoInicial > 0)) {
    try {
      if (existenciaInicial > 0) {
        await inventario.aplicar([{
          producto_id: producto.id,
          sucursal_id: sucursalId,
          tipo: 'entrada',
          cantidad: existenciaInicial,
          minimo: minimoInicial,
          nota: 'Existencia inicial al dar de alta el producto',
        }], { usuarioId: req.usuario.id });
      } else {
        await inventario.fijarMinimo(producto.id, sucursalId, minimoInicial);
      }
    } catch (error) {
      aviso = `El producto se guardó, pero no se pudo registrar la existencia inicial: ${error.message}`;
    }
  }
  res.json({ ok: true, id: producto.id, aviso });
}));

router.put('/:id', manejar(async (req, res) => {
  const datos = catalogo.validar(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  const actual = await catalogo.porId(req.params.id);
  if (!esAdminCentral(req.usuario)) {
    if (!actual) return res.status(404).json({ error: 'Producto no encontrado' });
    if (CAMPOS_PRECIO.some((campo) => !mismoValor(actual[campo], datos[campo]))) {
      return res.status(403).json({
        error: 'Solo el administrador de la central puede cambiar los precios; el cambio se refleja en todas las sucursales',
        codigo: 'SOLO_CENTRAL',
      });
    }
  }
  await catalogo.actualizar(req.params.id, datos);
  if (actual) {
    const cambios = describirCambiosProducto(actual, datos);
    if (cambios.lista.length) {
      bitacora.registrar({
        usuario: req.usuario, tipo: 'producto_cambio', descripcion: `${datos.descripcion}: ${cambios.texto}`,
        detalle: { producto_id: Number(actual.id), cambios: cambios.lista }, alerta: cambios.precio,
      });
    }
  }
  res.json({ ok: true });
}));

router.delete('/:id', requiereAdmin, manejar(async (req, res) => {
  const actual = await catalogo.porId(req.params.id);
  await catalogo.darDeBaja(req.params.id);
  if (actual) {
    bitacora.registrar({
      usuario: req.usuario, tipo: 'producto_baja',
      descripcion: `${actual.descripcion} (${actual.codigo_barras || 'sin código'})`,
      detalle: { producto_id: Number(actual.id) },
    });
  }
  res.json({ ok: true, eliminado: 'baja_logica' });
}));

// Movimiento de inventario: entrada, salida o ajuste (fija la existencia exacta).
// Si solo se manda el mínimo (sin tipo ni cantidad), únicamente se actualiza el mínimo.
router.post('/:id/inventario', manejar(async (req, res) => {
  const { tipo, cantidad, minimo, nota } = req.body || {};
  const productoId = Number(req.params.id);
  const sucursalId = sucursalPermitida(req, req.body?.sucursal_id);
  const producto = await catalogo.porId(productoId);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  if (!producto.usa_inventario) {
    return res.status(400).json({ error: 'Este producto no controla inventario (actívalo en Editar)' });
  }

  const soloMinimo = (tipo === undefined || tipo === '' || tipo === 'minimo')
    && (cantidad === undefined || cantidad === '' || cantidad === null);
  if (soloMinimo) {
    if (minimo === undefined || minimo === '' || minimo === null) {
      return res.status(400).json({ error: 'Indica la cantidad del movimiento o el nuevo mínimo' });
    }
    const resultado = await inventario.fijarMinimo(productoId, sucursalId, minimo);
    const actual = await inventario.existenciaDe(productoId, sucursalId);
    return res.json({ ok: true, existencia: actual.existencia, minimo: resultado.minimo });
  }

  const [resultado] = await inventario.aplicar([{
    producto_id: productoId,
    sucursal_id: sucursalId,
    tipo,
    cantidad,
    minimo,
    nota: (nota || '').trim(),
  }], { usuarioId: req.usuario.id });
  res.json({ ok: true, existencia: resultado.existencia, minimo: resultado.minimo });
}));

// Kardex: historial de movimientos del producto (todas las sucursales o una)
router.get('/:id/kardex', manejar(async (req, res) => {
  const producto = await catalogo.porId(req.params.id, { incluirInactivos: true });
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const resultado = await inventario.kardex(producto.id, {
    sucursalId: req.query.sucursal_id || null,
    limite: req.query.limite,
  });
  const { productos } = await inventario.conExistencias([producto], { sucursalId: req.usuario.sucursal_id });
  res.json({ producto: productos[0], ...resultado });
}));

module.exports = router;
