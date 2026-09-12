const db = require('../db');
const { supabaseAdmin, hasSupabase } = require('./supabase-client');

async function publicarApoyo(id) {
  if (!hasSupabase || !supabaseAdmin) return;
  const apoyo = db.prepare('SELECT * FROM apoyos WHERE id = ?').get(id);
  if (!apoyo) return;
  const { error } = await supabaseAdmin.from('apoyos').upsert({
    id: apoyo.id,
    folio: apoyo.folio,
    origen_id: apoyo.origen_id,
    destino_id: apoyo.destino_id,
    pedido_id: apoyo.pedido_id,
    estado: apoyo.estado,
    nota: apoyo.nota || '',
    creado_por: apoyo.creado_por,
    creado: apoyo.creado,
    enviado_por: apoyo.enviado_por,
    enviado: apoyo.enviado,
    recibido_por: apoyo.recibido_por,
    recibido: apoyo.recibido,
    cancelado_por: apoyo.cancelado_por,
    cancelado: apoyo.cancelado,
    motivo_cancelacion: apoyo.motivo_cancelacion || '',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw error;

  const renglones = db.prepare('SELECT * FROM apoyo_detalle WHERE apoyo_id = ?').all(id);
  if (renglones.length) {
    const { error: detalleError } = await supabaseAdmin.from('apoyo_detalle').upsert(
      renglones.map((r) => ({
        id: r.id,
        apoyo_id: r.apoyo_id,
        producto_id: r.producto_id,
        codigo_barras: r.codigo_barras,
        descripcion: r.descripcion,
        cantidad: r.cantidad,
        cantidad_recibida: r.cantidad_recibida,
        precio_costo: r.precio_costo,
        precio_venta: r.precio_venta,
        precio_mayoreo: r.precio_mayoreo,
        importe: r.importe,
      })), { onConflict: 'id' }
    );
    if (detalleError) throw detalleError;
  }
}

async function descargarApoyos() {
  if (!hasSupabase || !supabaseAdmin) return;
  const { data: sucursales, error: sucursalesError } = await supabaseAdmin.from('sucursales').select('*').eq('activa', true);
  if (sucursalesError) throw sucursalesError;
  const { data: usuarios, error: usuariosError } = await supabaseAdmin
    .from('usuarios_central').select('id,nombre,usuario,password_hash,rol,sucursal_id,activo').eq('activo', true);
  if (usuariosError) throw usuariosError;
  const { data: apoyos, error } = await supabaseAdmin.from('apoyos').select('*').order('id', { ascending: false }).limit(500);
  if (error) throw error;
  const { data: detalles, error: detalleError } = await supabaseAdmin.from('apoyo_detalle').select('*').limit(5000);
  if (detalleError) throw detalleError;
  const idsProductos = [...new Set((detalles || []).map((r) => r.producto_id))];
  const { data: productos, error: productosError } = idsProductos.length
    ? await supabaseAdmin.from('productos').select('*').in('id', idsProductos)
    : { data: [], error: null };
  if (productosError) throw productosError;

  const upsertSucursal = db.prepare(`INSERT INTO sucursales (id,nombre,direccion,telefono,es_central,activa) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre,direccion=excluded.direccion,telefono=excluded.telefono,
      es_central=excluded.es_central,activa=excluded.activa`);
  const upsertUsuario = db.prepare(`INSERT INTO usuarios (id,nombre,usuario,password_hash,rol,sucursal_id,activo) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre,usuario=excluded.usuario,password_hash=excluded.password_hash,
      rol=excluded.rol,sucursal_id=excluded.sucursal_id,activo=excluded.activo`);
  const upsertProducto = db.prepare(`INSERT INTO productos (id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,
    precio_mayoreo,cantidad_mayoreo,usa_inventario,es_comun,activo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET codigo_barras=excluded.codigo_barras,descripcion=excluded.descripcion,
      precio_costo=excluded.precio_costo,precio_venta=excluded.precio_venta,activo=excluded.activo`);
  const upsertApoyo = db.prepare(`INSERT INTO apoyos
    (id,folio,origen_id,destino_id,pedido_id,estado,nota,creado_por,creado,enviado_por,enviado,recibido_por,recibido,cancelado_por,cancelado,motivo_cancelacion)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET folio=excluded.folio,origen_id=excluded.origen_id,destino_id=excluded.destino_id,
      pedido_id=excluded.pedido_id,estado=excluded.estado,nota=excluded.nota,creado_por=excluded.creado_por,
      creado=excluded.creado,enviado_por=excluded.enviado_por,enviado=excluded.enviado,recibido_por=excluded.recibido_por,
      recibido=excluded.recibido,cancelado_por=excluded.cancelado_por,cancelado=excluded.cancelado,
      motivo_cancelacion=excluded.motivo_cancelacion`);
  const upsertDetalle = db.prepare(`INSERT INTO apoyo_detalle
    (id,apoyo_id,producto_id,codigo_barras,descripcion,cantidad,cantidad_recibida,precio_costo,precio_venta,precio_mayoreo,importe)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET apoyo_id=excluded.apoyo_id,producto_id=excluded.producto_id,descripcion=excluded.descripcion,
      cantidad=excluded.cantidad,cantidad_recibida=excluded.cantidad_recibida,precio_costo=excluded.precio_costo,
      precio_venta=excluded.precio_venta,precio_mayoreo=excluded.precio_mayoreo,importe=excluded.importe`);

  const sincronizar = db.transaction(() => {
    for (const s of sucursales || []) upsertSucursal.run(s.id, s.nombre, s.direccion || '', s.telefono || '', s.es_central ? 1 : 0, 1);
    for (const u of usuarios || []) {
      if (u.password_hash) upsertUsuario.run(u.id, u.nombre, u.usuario, u.password_hash, u.rol, u.sucursal_id, 1);
    }
    for (const p of productos || []) upsertProducto.run(p.id, p.codigo_barras, p.descripcion, p.departamento || '',
      p.precio_costo || 0, p.precio_venta || 0, p.precio_mayoreo, p.cantidad_mayoreo, p.usa_inventario ? 1 : 0,
      p.es_comun ? 1 : 0, p.activo ? 1 : 0);
    for (const a of apoyos || []) {
      upsertApoyo.run(a.id, a.folio, a.origen_id, a.destino_id, a.pedido_id, a.estado, a.nota || '', a.creado_por,
        a.creado, a.enviado_por, a.enviado, a.recibido_por, a.recibido, a.cancelado_por, a.cancelado, a.motivo_cancelacion || '');
    }
    for (const r of detalles || []) {
      upsertDetalle.run(r.id, r.apoyo_id, r.producto_id, r.codigo_barras, r.descripcion, r.cantidad,
        r.cantidad_recibida, r.precio_costo, r.precio_venta, r.precio_mayoreo, r.importe);
    }
  });
  db.prepare("INSERT OR REPLACE INTO sync_config (clave, valor) VALUES ('aplicando', '1')").run();
  try {
    sincronizar();
  } finally {
    db.prepare("DELETE FROM sync_config WHERE clave = 'aplicando'").run();
  }
}

async function publicarSinBloquear(id) {
  try {
    await publicarApoyo(id);
  } catch (error) {
    console.error('No se pudo sincronizar el apoyo con Supabase:', error.message);
  }
}

async function publicarPedidoSinBloquear(id) {
  if (!hasSupabase || !supabaseAdmin) return;
  try {
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
    if (!pedido) return;
    const { error } = await supabaseAdmin.from('pedidos').upsert({
      id: pedido.id, folio: pedido.folio, sucursal_id: pedido.sucursal_id, estado: pedido.estado,
      nota: pedido.nota || '', creado_por: pedido.creado_por, creado: pedido.creado,
      enviado_por: pedido.enviado_por, enviado: pedido.enviado, updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) throw error;
    const detalles = db.prepare('SELECT * FROM pedido_detalle WHERE pedido_id = ?').all(id);
    if (detalles.length) {
      const { error: detalleError } = await supabaseAdmin.from('pedido_detalle').upsert(detalles.map((r) => ({
        id: r.id, pedido_id: r.pedido_id, producto_id: r.producto_id, codigo_barras: r.codigo_barras,
        descripcion: r.descripcion, cantidad: r.cantidad, cantidad_surtida: r.cantidad_surtida,
      })), { onConflict: 'id' });
      if (detalleError) throw detalleError;
    }
  } catch (error) {
    console.error('No se pudo sincronizar el pedido con Supabase:', error.message);
  }
}

async function descargarPedidos() {
  if (!hasSupabase || !supabaseAdmin) return;
  const [{ data: pedidos, error }, { data: detalles, error: detalleError }] = await Promise.all([
    supabaseAdmin.from('pedidos').select('*').order('id', { ascending: false }).limit(500),
    supabaseAdmin.from('pedido_detalle').select('*').limit(5000),
  ]);
  if (error) throw error;
  if (detalleError) throw detalleError;
  const upsertPedido = db.prepare(`INSERT INTO pedidos (id,folio,sucursal_id,estado,nota,creado_por,creado,enviado_por,enviado)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET folio=excluded.folio,sucursal_id=excluded.sucursal_id,
      estado=excluded.estado,nota=excluded.nota,creado_por=excluded.creado_por,creado=excluded.creado,
      enviado_por=excluded.enviado_por,enviado=excluded.enviado`);
  const upsertDetalle = db.prepare(`INSERT INTO pedido_detalle (id,pedido_id,producto_id,codigo_barras,descripcion,cantidad,cantidad_surtida)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pedido_id=excluded.pedido_id,producto_id=excluded.producto_id,
      descripcion=excluded.descripcion,cantidad=excluded.cantidad,cantidad_surtida=excluded.cantidad_surtida`);
  db.transaction(() => {
    for (const p of pedidos || []) upsertPedido.run(p.id, p.folio, p.sucursal_id, p.estado, p.nota || '', p.creado_por,
      p.creado, p.enviado_por, p.enviado);
    for (const d of detalles || []) upsertDetalle.run(d.id, d.pedido_id, d.producto_id, d.codigo_barras, d.descripcion,
      d.cantidad, d.cantidad_surtida);
  })();
}

module.exports = { publicarSinBloquear, descargarApoyos, publicarPedidoSinBloquear, descargarPedidos };
