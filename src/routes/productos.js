const express = require('express');
const db = require('../db');
const { requiereAdmin } = require('../auth');
const { supabaseAdmin, hasSupabase } = require('../sync/supabase-client');

const router = express.Router();

async function consultarInventarioCentral() {
  if (!hasSupabase || !supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('inventario')
    .select('*, sucursales:sucursal_id(id,nombre,es_central)');

  if (error) throw error;
  return data || [];
}

function mapearInventarioCentral(rows) {
  const grupos = new Map();
  for (const row of rows || []) {
    const productoId = row.producto_id;
    if (!grupos.has(productoId)) {
      grupos.set(productoId, []);
    }
    const sucursal = row.sucursales || {};
    grupos.get(productoId).push({
      sucursal_id: sucursal.id ?? row.sucursal_id,
      sucursal: sucursal.nombre ?? 'Sucursal',
      es_central: Boolean(sucursal.es_central ?? false),
      existencia: Number(row.existencia ?? 0),
      minimo: Number(row.minimo ?? 0),
    });
  }
  return grupos;
}

async function obtenerProductosCentral(q = '') {
  if (!hasSupabase || !supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.from('productos').select('*').eq('activo', true);
  if (error) throw error;
  const texto = (q || '').trim().toLowerCase();
  if (!texto) return data || [];
  return (data || []).filter((p) => {
    const descripcion = (p.descripcion || '').toLowerCase();
    const codigo = (p.codigo_barras || '').toLowerCase();
    return descripcion.includes(texto) || codigo.includes(texto);
  });
}

const camposProducto = `
  p.id, p.codigo_barras, p.descripcion, p.departamento, p.precio_costo,
  p.precio_venta, p.precio_mayoreo, p.usa_inventario`;

function conExistencias(producto) {
  const existencias = db
    .prepare(
      `SELECT s.id AS sucursal_id, s.nombre AS sucursal, i.existencia, i.minimo
       FROM sucursales s
       LEFT JOIN inventario i ON i.sucursal_id = s.id AND i.producto_id = ?
       WHERE s.activa = 1
       ORDER BY s.id`
    )
    .all(producto.id)
    .map((e) => ({ ...e, existencia: e.existencia ?? 0, minimo: e.minimo ?? 0 }));
  return { ...producto, existencias };
}

// Buscar por código de barras exacto (pantalla de venta / escáner)
router.get('/codigo/:codigo', async (req, res) => {
  if (hasSupabase && supabaseAdmin) {
    try {
      const productos = await obtenerProductosCentral(req.params.codigo.trim());
      const producto = productos.find((fila) => fila.codigo_barras === req.params.codigo.trim());
      if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
      const inventario = await consultarInventarioCentral();
      const grupos = mapearInventarioCentral(inventario);
      return res.json({
        ...producto,
        existencias: grupos.get(producto.id) || [],
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Error al consultar producto central' });
    }
  }

  const producto = db
    .prepare(`SELECT ${camposProducto} FROM productos p
      WHERE p.codigo_barras = ? AND p.activo = 1`)
    .get(req.params.codigo.trim());
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(conExistencias(producto));
});

// Buscar por descripción o código (F3)
router.get('/buscar', async (req, res) => {
  if (hasSupabase && supabaseAdmin) {
    try {
      const productos = await obtenerProductosCentral(req.query.q || '');
      const inventario = await consultarInventarioCentral();
      const grupos = mapearInventarioCentral(inventario);
      return res.json(
        productos.slice(0, 50).map((producto) => ({
          ...producto,
          existencias: grupos.get(producto.id) || [],
        }))
      );
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Error al consultar inventario central' });
    }
  }

  const q = `%${(req.query.q || '').trim()}%`;
  const productos = db
    .prepare(
      `SELECT ${camposProducto},
              COALESCE((SELECT existencia FROM inventario i
                        WHERE i.producto_id = p.id AND i.sucursal_id = ?), 0) AS existencia_local
       FROM productos p
      WHERE p.activo = 1 AND p.es_comun = 0
        AND (p.descripcion LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY p.descripcion LIMIT 50`
    )
    .all(q, q);
  res.json(productos);
});

// Listado completo con existencias de todas las sucursales
router.get('/', async (req, res) => {
  if (hasSupabase && supabaseAdmin) {
    try {
      const productos = await obtenerProductosCentral(req.query.q || '');
      const inventario = await consultarInventarioCentral();
      const grupos = mapearInventarioCentral(inventario);
      return res.json(
        productos.slice(0, 200).map((producto) => ({
          ...producto,
          existencias: grupos.get(producto.id) || [],
          total_disponible: (grupos.get(producto.id) || []).reduce((sum, item) => sum + Number(item.existencia || 0), 0),
        }))
      );
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Error al consultar catálogo central' });
    }
  }

  const q = `%${(req.query.q || '').trim()}%`;
  const productos = db
    .prepare(
      `SELECT ${camposProducto} FROM productos p
      WHERE p.activo = 1 AND p.es_comun = 0
        AND (p.descripcion LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY p.descripcion LIMIT 200`
    )
    .all(q, q);
  res.json(productos.map(conExistencias));
});

function validarProducto(body) {
  const descripcion = (body.descripcion || '').trim();
  if (!descripcion) return { error: 'La descripción es obligatoria' };
  const precioVenta = Number(body.precio_venta);
  if (!(precioVenta >= 0)) return { error: 'Precio de venta no válido' };
  return {
    codigo_barras: (body.codigo_barras || '').trim() || null,
    descripcion,
    departamento: (body.departamento || '').trim(),
    precio_costo: Number(body.precio_costo) || 0,
    precio_venta: precioVenta,
    precio_mayoreo: body.precio_mayoreo ? Number(body.precio_mayoreo) : null,
    usa_inventario: body.usa_inventario === false ? 0 : 1,
  };
}

function guardarProductoLocal(producto) {
  db.transaction(() => {
    if (producto.codigo_barras) {
      db.prepare('UPDATE productos SET codigo_barras = NULL, activo = 0 WHERE codigo_barras = ? AND id <> ?')
        .run(producto.codigo_barras, producto.id);
    }
    db.prepare(`INSERT INTO productos (id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,
      precio_mayoreo,cantidad_mayoreo,usa_inventario,es_comun,activo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET codigo_barras=excluded.codigo_barras,descripcion=excluded.descripcion,
      departamento=excluded.departamento,precio_costo=excluded.precio_costo,precio_venta=excluded.precio_venta,
      precio_mayoreo=excluded.precio_mayoreo,cantidad_mayoreo=excluded.cantidad_mayoreo,
      usa_inventario=excluded.usa_inventario,es_comun=excluded.es_comun,activo=excluded.activo`).run(
      producto.id, producto.codigo_barras, producto.descripcion, producto.departamento || '', producto.precio_costo || 0,
      producto.precio_venta || 0, producto.precio_mayoreo, producto.cantidad_mayoreo,
      producto.usa_inventario ? 1 : 0, producto.es_comun ? 1 : 0, producto.activo === false ? 0 : 1
    );
  })();
}

router.post('/', async (req, res) => {
  const datos = validarProducto(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  const sucursalId = Number(req.body?.sucursal_id || req.usuario.sucursal_id);
  const existenciaInicial = Number(req.body?.existencia_inicial || 0);
  const minimoInicial = Number(req.body?.minimo_inicial || 0);
  if (!sucursalId) return res.status(400).json({ error: 'Sucursal no válida' });
  if (req.usuario.rol !== 'admin' && sucursalId !== Number(req.usuario.sucursal_id)) {
    return res.status(403).json({ error: 'Solo puedes registrar inventario en tu sucursal' });
  }
  if (!Number.isFinite(existenciaInicial) || existenciaInicial < 0) {
    return res.status(400).json({ error: 'Existencia inicial no válida' });
  }
  if (!Number.isFinite(minimoInicial) || minimoInicial < 0) {
    return res.status(400).json({ error: 'Mínimo inicial no válido' });
  }
  try {
    if (hasSupabase && supabaseAdmin) {
      if (datos.codigo_barras) {
        const existente = await supabaseAdmin.from('productos').select('id')
          .eq('codigo_barras', datos.codigo_barras).maybeSingle();
        if (existente.error) throw existente.error;
        if (existente.data) return res.status(400).json({ error: 'Ya existe un producto con ese código de barras' });
      }
      const { data, error } = await supabaseAdmin.from('productos').insert(datos).select().single();
      if (error) throw error;
      const { error: inventarioError } = await supabaseAdmin.from('inventario').upsert({
        producto_id: data.id, sucursal_id: sucursalId, existencia: existenciaInicial, minimo: minimoInicial,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'producto_id,sucursal_id' });
      if (inventarioError) throw inventarioError;
      guardarProductoLocal(data);
      db.prepare(`INSERT INTO inventario (producto_id,sucursal_id,existencia,minimo) VALUES (?,?,?,?)
        ON CONFLICT(producto_id,sucursal_id) DO UPDATE SET existencia=excluded.existencia,minimo=excluded.minimo`)
        .run(data.id, sucursalId, existenciaInicial, minimoInicial);
      return res.json({ ok: true, id: data.id });
    }
    const resultado = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO productos (codigo_barras, descripcion, departamento, precio_costo,
           precio_venta, precio_mayoreo, usa_inventario)
         VALUES (@codigo_barras, @descripcion, @departamento, @precio_costo,
           @precio_venta, @precio_mayoreo, @usa_inventario)`
      ).run(datos);
      db.prepare(`INSERT INTO inventario (producto_id,sucursal_id,existencia,minimo) VALUES (?,?,?,?)
        ON CONFLICT(producto_id,sucursal_id) DO UPDATE SET existencia=excluded.existencia,minimo=excluded.minimo`)
        .run(info.lastInsertRowid, sucursalId, existenciaInicial, minimoInicial);
      return info.lastInsertRowid;
    })();
    res.json({ ok: true, id: resultado });
  } catch (e) {
    if (/UNIQUE|duplicate key|unique constraint/i.test(String(e.message))) {
      return res.status(400).json({ error: 'Ya existe un producto con ese código de barras' });
    }
    throw e;
  }
});

router.put('/:id', async (req, res) => {
  const datos = validarProducto(req.body || {});
  if (datos.error) return res.status(400).json({ error: datos.error });
  try {
    if (hasSupabase && supabaseAdmin) {
      let consulta = supabaseAdmin.from('productos').update(datos).eq('id', req.params.id);
      const { data, error } = await consulta.select().single();
      if (error) throw error;
      guardarProductoLocal(data);
      return res.json({ ok: true });
    }
    const info = db
      .prepare(
        `UPDATE productos SET codigo_barras = @codigo_barras, descripcion = @descripcion,
           departamento = @departamento, precio_costo = @precio_costo, precio_venta = @precio_venta,
           precio_mayoreo = @precio_mayoreo, usa_inventario = @usa_inventario
         WHERE id = @id AND activo = 1`
      )
      .run({ ...datos, id: req.params.id });
    if (info.changes === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ya existe un producto con ese código de barras' });
    }
    throw e;
  }
});

router.delete('/:id', requiereAdmin, async (req, res) => {
  try {
    if (hasSupabase && supabaseAdmin) {
      const { data, error } = await supabaseAdmin.from('productos')
        .update({ activo: false, codigo_barras: null })
        .eq('id', req.params.id)
        .select('id,activo')
        .single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const info = db.prepare('UPDATE productos SET activo = 0, codigo_barras = NULL WHERE id = ?').run(req.params.id);
    if (info.changes === 0 && !hasSupabase) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, eliminado: 'baja_logica' });
  } catch (error) {
    res.status(502).json({ error: 'No se pudo eliminar el producto: ' + error.message });
  }
});

// Movimiento de inventario: entrada, salida o ajuste (fija existencia exacta)
router.post('/:id/inventario', async (req, res) => {
  const { tipo, cantidad, minimo, nota } = req.body || {};
  const productoId = Number(req.params.id);
  const sucursalId = Number(req.body?.sucursal_id || req.usuario.sucursal_id);
  const cant = Number(cantidad);

  const productoLocal = db.prepare('SELECT id FROM productos WHERE id = ? AND activo = 1').get(productoId);
  if (!productoLocal && !(hasSupabase && supabaseAdmin)) {
    return res.status(404).json({ error: 'Producto no encontrado' });
  }
  if (!sucursalId) return res.status(400).json({ error: 'Sucursal no válida' });
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido' });
  }
  if (!Number.isFinite(cant) || (tipo !== 'ajuste' && cant <= 0)) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }

  if (hasSupabase && supabaseAdmin) {
    try {
      if (req.usuario.rol !== 'admin' && sucursalId !== Number(req.usuario.sucursal_id)) {
        return res.status(403).json({ error: 'Solo puedes modificar el inventario de tu sucursal' });
      }
      const { data: productoCentral, error: productoError } = await supabaseAdmin
        .from('productos').select('*').eq('id', productoId).eq('activo', true).maybeSingle();
      if (productoError) throw productoError;
      if (!productoCentral) return res.status(404).json({ error: 'Producto no encontrado en Supabase' });
      const { data: actual, error: consultaError } = await supabaseAdmin
        .from('inventario').select('existencia,minimo').eq('producto_id', productoId)
        .eq('sucursal_id', sucursalId).maybeSingle();
      if (consultaError) throw consultaError;
      const existenciaActual = Number(actual?.existencia || 0);
      const existencia = tipo === 'entrada'
        ? existenciaActual + cant
        : tipo === 'salida' ? existenciaActual - cant : cant;
      const minimoCentral = minimo === undefined || minimo === null || minimo === ''
        ? Number(actual?.minimo || 0) : Number(minimo) || 0;
      const { error: inventarioError } = await supabaseAdmin.from('inventario').upsert({
        producto_id: productoId,
        sucursal_id: sucursalId,
        existencia,
        minimo: minimoCentral,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'producto_id,sucursal_id' });
      if (inventarioError) throw inventarioError;
      const { error: movimientoError } = await supabaseAdmin.from('movimientos_inventario').insert({
        producto_id: productoId, sucursal_id: sucursalId, tipo, cantidad: cant,
        usuario_id: req.usuario.id, nota: (nota || '').trim(),
      });
      if (movimientoError) throw movimientoError;
      db.prepare("INSERT OR REPLACE INTO sync_config (clave, valor) VALUES ('aplicando', '1')").run();
      try {
        db.prepare(`INSERT INTO productos (id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,
          precio_mayoreo,cantidad_mayoreo,usa_inventario,es_comun,activo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET codigo_barras=excluded.codigo_barras,descripcion=excluded.descripcion,
            departamento=excluded.departamento,precio_costo=excluded.precio_costo,precio_venta=excluded.precio_venta,
            precio_mayoreo=excluded.precio_mayoreo,usa_inventario=excluded.usa_inventario,activo=excluded.activo`).run(
          productoCentral.id, productoCentral.codigo_barras, productoCentral.descripcion, productoCentral.departamento || '',
          productoCentral.precio_costo || 0, productoCentral.precio_venta || 0, productoCentral.precio_mayoreo,
          productoCentral.cantidad_mayoreo, productoCentral.usa_inventario ? 1 : 0, productoCentral.es_comun ? 1 : 0, 1);
        db.prepare(`INSERT INTO inventario (producto_id,sucursal_id,existencia,minimo) VALUES (?,?,?,?)
          ON CONFLICT(producto_id,sucursal_id) DO UPDATE SET existencia=excluded.existencia,minimo=excluded.minimo`)
          .run(productoId, sucursalId, existencia, minimoCentral);
      } finally {
        db.prepare("DELETE FROM sync_config WHERE clave = 'aplicando'").run();
      }
      return res.json({ ok: true, existencia, minimo: minimoCentral });
    } catch (error) {
      return res.status(502).json({ error: 'No se pudo actualizar el inventario central: ' + error.message });
    }
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0) ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    ).run(productoId, sucursalId);
    if (tipo === 'entrada') {
      db.prepare(
        'UPDATE inventario SET existencia = existencia + ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    } else if (tipo === 'salida') {
      db.prepare(
        'UPDATE inventario SET existencia = existencia - ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    } else {
      db.prepare(
        'UPDATE inventario SET existencia = ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(cant, productoId, sucursalId);
    }
    if (minimo !== undefined && minimo !== null && minimo !== '') {
      db.prepare(
        'UPDATE inventario SET minimo = ? WHERE producto_id = ? AND sucursal_id = ?'
      ).run(Number(minimo) || 0, productoId, sucursalId);
    }
    db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(productoId, sucursalId, tipo, cant, req.usuario.id, (nota || '').trim());
  })();

  res.json({ ok: true });
});

// Productos con existencia por debajo del mínimo en la sucursal del usuario
router.get('/bajo-minimo', async (req, res) => {
  if (hasSupabase && supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('inventario')
        .select('*, productos:producto_id(id,codigo_barras,descripcion,usa_inventario), sucursales:sucursal_id(id,nombre)')
        .eq('sucursal_id', Number(req.usuario.sucursal_id));

      if (error) throw error;
      const filas = (data || [])
        .filter((row) => row.productos && row.productos.usa_inventario
          && (req.usuario.rol === 'admin' || Number(row.sucursal_id) === Number(req.usuario.sucursal_id))
          && Number(row.existencia) <= Number(row.minimo) && Number(row.minimo) > 0)
        .map((row) => ({
          id: row.productos.id,
          codigo_barras: row.productos.codigo_barras,
          descripcion: row.productos.descripcion,
          existencia: Number(row.existencia || 0),
          minimo: Number(row.minimo || 0),
        }));
      return res.json(filas);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Error al consultar mínimo central' });
    }
  }

  const filas = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.descripcion, i.existencia, i.minimo
       FROM inventario i JOIN productos p ON p.id = i.producto_id
       WHERE i.sucursal_id = ? AND p.activo = 1 AND p.usa_inventario = 1
         AND i.existencia <= i.minimo AND i.minimo > 0
       ORDER BY p.descripcion`
    )
    .all(req.usuario.sucursal_id);
  res.json(filas);
});

// Consulta global del inventario para revisar disponibilidad en otras sucursales o central.
router.get('/inventario-global', async (req, res) => {
  if (hasSupabase && supabaseAdmin) {
    try {
      const q = (req.query.q || '').trim();
      const productos = await obtenerProductosCentral(q);
      const inventario = await consultarInventarioCentral();
      const grupos = mapearInventarioCentral(inventario);
      const salida = productos.map((producto) => {
        const existencias = grupos.get(producto.id) || [];
        return {
          ...producto,
          existencias,
          total_disponible: existencias.reduce((sum, item) => sum + Number(item.existencia || 0), 0),
        };
      });
      return res.json(salida);
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Error al consultar inventario global central' });
    }
  }

  const q = `%${(req.query.q || '').trim()}%`;
  const productos = db
    .prepare(
      `SELECT p.id, p.codigo_barras, p.descripcion, p.departamento, p.precio_costo, p.precio_venta,
              p.precio_mayoreo, p.usa_inventario
       FROM productos p
       WHERE p.activo = 1 AND p.es_comun = 0 AND (p.descripcion LIKE ? OR p.codigo_barras LIKE ?)
       ORDER BY p.descripcion LIMIT 200`
    )
    .all(q, q);

  const salida = productos.map((producto) => ({
    ...producto,
    existencias: db
      .prepare(
        `SELECT s.id AS sucursal_id, s.nombre AS sucursal, s.es_central,
                COALESCE(i.existencia, 0) AS existencia, COALESCE(i.minimo, 0) AS minimo
         FROM sucursales s
         LEFT JOIN inventario i ON i.sucursal_id = s.id AND i.producto_id = ?
         WHERE s.activa = 1
         ORDER BY s.es_central DESC, s.id`
      )
      .all(producto.id),
    total_disponible: db
      .prepare('SELECT COALESCE(SUM(existencia), 0) AS total FROM inventario WHERE producto_id = ?')
      .get(producto.id).total,
  }));

  res.json(salida);
});

// Mini apoyo: cuando la central no tiene disponibilidad y otra sucursal sí.
router.post('/mini-apoyo', (req, res) => {
  const origenId = Number(req.usuario.sucursal_id);
  const destinoId = Number(req.body?.destino_id || 0);
  const productoId = Number(req.body?.producto_id || 0);
  const cantidad = Number(req.body?.cantidad || 0);
  const tipo = (req.body?.tipo || 'reconciliacion').trim();
  const nota = (req.body?.nota || '').trim();

  if (!productoId || !destinoId || !(cantidad > 0)) {
    return res.status(400).json({ error: 'Falta producto, destino o cantidad válida' });
  }
  if (!['reconciliacion', 'apoyo', 'redistribucion', 'faltante'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de apoyo no válido' });
  }

  const producto = db.prepare('SELECT * FROM productos WHERE id = ? AND activo = 1').get(productoId);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

  const destino = db.prepare('SELECT * FROM sucursales WHERE id = ? AND activa = 1').get(destinoId);
  if (!destino) return res.status(404).json({ error: 'Sucursal destino no válida' });

  const registro = db
    .prepare(
      `INSERT INTO mini_apoyos (origen_sucursal_id, destino_sucursal_id, producto_id, cantidad, tipo, nota, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(origenId, destinoId, productoId, cantidad, tipo, nota, req.usuario.id);

  db.prepare(
    `INSERT INTO sync_estado (entidad, entidad_id, sucursal_id, accion, payload, estado)
     VALUES (?, ?, ?, 'create', ?, 'pendiente')`
  ).run('mini_apoyos', registro.lastInsertRowid, origenId, JSON.stringify({
    id: registro.lastInsertRowid,
    origen_sucursal_id: origenId,
    destino_sucursal_id: destinoId,
    producto_id: productoId,
    cantidad,
    tipo,
    nota,
    creado_por: req.usuario.id,
  }));

  res.json({ ok: true, id: registro.lastInsertRowid, tipo, producto: producto.descripcion, cantidad });
});

router.get('/mini-apoyos', (req, res) => {
  const filas = db
    .prepare(
      `SELECT m.id, m.producto_id, p.descripcion, p.codigo_barras, m.cantidad, m.tipo, m.estado, m.nota,
              m.origen_sucursal_id, o.nombre AS origen, m.destino_sucursal_id, d.nombre AS destino,
              m.creado, m.actualizado
       FROM mini_apoyos m
       JOIN productos p ON p.id = m.producto_id
       JOIN sucursales o ON o.id = m.origen_sucursal_id
       JOIN sucursales d ON d.id = m.destino_sucursal_id
       WHERE (m.origen_sucursal_id = ? OR m.destino_sucursal_id = ?)
       ORDER BY m.id DESC LIMIT 200`
    )
    .all(req.usuario.sucursal_id, req.usuario.sucursal_id);
  res.json(filas);
});

router.get('/mini-apoyos/:id', (req, res) => {
  const mini = db
    .prepare(
      `SELECT m.*, p.descripcion, p.codigo_barras,
              o.nombre AS origen, d.nombre AS destino,
              u.nombre AS creador
       FROM mini_apoyos m
       JOIN productos p ON p.id = m.producto_id
       JOIN sucursales o ON o.id = m.origen_sucursal_id
       JOIN sucursales d ON d.id = m.destino_sucursal_id
       JOIN usuarios u ON u.id = m.creado_por
       WHERE m.id = ?`
    )
    .get(req.params.id);

  if (!mini) return res.status(404).json({ error: 'Mini apoyo no encontrado' });
  if (mini.origen_sucursal_id !== req.usuario.sucursal_id && mini.destino_sucursal_id !== req.usuario.sucursal_id && !req.usuario.es_central) {
    return res.status(403).json({ error: 'No tienes acceso a ese mini apoyo' });
  }
  res.json(mini);
});

router.post('/mini-apoyos/:id/aceptar', (req, res) => {
  if (!req.usuario.es_central) {
    return res.status(403).json({ error: 'Solo la farmacia central puede aceptar mini apoyos' });
  }

  const mini = db
    .prepare(
      `SELECT m.*, p.descripcion, p.codigo_barras,
              o.nombre AS origen, d.nombre AS destino
       FROM mini_apoyos m
       JOIN productos p ON p.id = m.producto_id
       JOIN sucursales o ON o.id = m.origen_sucursal_id
       JOIN sucursales d ON d.id = m.destino_sucursal_id
       WHERE m.id = ?`
    )
    .get(req.params.id);

  if (!mini) return res.status(404).json({ error: 'Mini apoyo no encontrado' });
  if (mini.estado !== 'pendiente') {
    return res.status(400).json({ error: 'Este mini apoyo ya fue procesado' });
  }

  const cantidad = Number(req.body?.cantidad ?? mini.cantidad);
  if (!(cantidad > 0)) {
    return res.status(400).json({ error: 'Cantidad no válida' });
  }

  const origenId = Number(mini.origen_sucursal_id);
  const destinoId = Number(mini.destino_sucursal_id);
  const productoId = Number(mini.producto_id);

  const origenStock = db
    .prepare('SELECT COALESCE(existencia, 0) AS existencia FROM inventario WHERE producto_id = ? AND sucursal_id = ?')
    .get(productoId, origenId)?.existencia ?? 0;

  if (origenStock < cantidad) {
    return res.status(400).json({ error: `La sucursal origen no tiene suficiente stock para este producto. Disponible: ${origenStock}` });
  }

  db.transaction(() => {
    db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    ).run(productoId, destinoId);

    db.prepare('UPDATE inventario SET existencia = existencia - ? WHERE producto_id = ? AND sucursal_id = ?')
      .run(cantidad, productoId, origenId);
    db.prepare('UPDATE inventario SET existencia = existencia + ? WHERE producto_id = ? AND sucursal_id = ?')
      .run(cantidad, productoId, destinoId);

    db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, 'salida', ?, ?, ?)`
    ).run(productoId, origenId, cantidad, req.usuario.id, `Mini apoyo aceptado #${mini.id}`);

    db.prepare(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, usuario_id, nota)
       VALUES (?, ?, 'entrada', ?, ?, ?)`
    ).run(productoId, destinoId, cantidad, req.usuario.id, `Mini apoyo aceptado #${mini.id}`);

    db.prepare(
      `UPDATE mini_apoyos SET estado = 'aceptado', actualizado = datetime('now', 'localtime') WHERE id = ?`
    ).run(mini.id);
  })();

  res.json({ ok: true, id: mini.id, estado: 'aceptado', cantidad });
});

router.post('/mini-apoyos/:id/rechazar', (req, res) => {
  if (!req.usuario.es_central) {
    return res.status(403).json({ error: 'Solo la farmacia central puede rechazar mini apoyos' });
  }

  const mini = db.prepare('SELECT * FROM mini_apoyos WHERE id = ?').get(req.params.id);
  if (!mini) return res.status(404).json({ error: 'Mini apoyo no encontrado' });
  if (mini.estado !== 'pendiente') {
    return res.status(400).json({ error: 'Este mini apoyo ya fue procesado' });
  }

  db.prepare(
    `UPDATE mini_apoyos SET estado = 'rechazado', actualizado = datetime('now', 'localtime') WHERE id = ?`
  ).run(mini.id);

  res.json({ ok: true, id: mini.id, estado: 'rechazado' });
});

module.exports = router;
