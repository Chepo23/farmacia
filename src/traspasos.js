// Apoyos (mercancía que la central manda a una sucursal) y pedidos (lo que la sucursal solicita):
// acceso a datos compartido por las rutas de apoyos y pedidos.
//
// - Modo central (con Supabase): la central es la autoridad. Toda escritura va PRIMERO a la
//   central (así los ids son únicos entre computadoras y un apoyo no se puede recibir dos
//   veces) y después se refleja en la copia local, que es la que consultan las pantallas.
// - Modo local: todo vive en SQLite.
const db = require('./db');
const catalogo = require('./catalogo');
const inventario = require('./inventario');
const { ErrorApp, modoCentral, centralDisponible, consultar, sb } = require('./central');

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const numeroONulo = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const TAMANO_LOTE = 150;

function lotes(lista, tamano = TAMANO_LOTE) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function idsValidos(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

// Los cambios pueden traer fechas (Date): a la central van en ISO y a SQLite en hora local
function paraCentral(cambios) {
  const salida = {};
  for (const [campo, valor] of Object.entries(cambios)) salida[campo] = valor instanceof Date ? valor.toISOString() : valor;
  return salida;
}

function paraLocal(cambios) {
  const salida = {};
  for (const [campo, valor] of Object.entries(cambios)) {
    salida[campo] = valor instanceof Date ? inventario.fechaLocal(valor.toISOString()) : valor;
  }
  return salida;
}

function existeUsuario(id) {
  return Boolean(id && db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(id));
}

// Para las llaves foráneas: el usuario si existe en esta computadora; si no, el primero que haya
function usuarioLocal(id, { opcional = false } = {}) {
  if (existeUsuario(Number(id))) return Number(id);
  if (opcional && (id === null || id === undefined)) return null;
  return db.prepare('SELECT MIN(id) AS id FROM usuarios').get().id;
}

// Copia a SQLite los usuarios de la central que faltan (para mostrar quién armó, envió o recibió)
async function asegurarUsuarios(ids) {
  const faltan = idsValidos(ids).filter((id) => !existeUsuario(id));
  if (!faltan.length || !modoCentral()) return;
  try {
    const { data } = await consultar(
      sb().from('usuarios_central').select('id,nombre,usuario,password_hash,rol,sucursal_id,activo').in('id', faltan)
    );
    await inventario.asegurarSucursales((data || []).map((u) => u.sucursal_id));
    const guardar = db.prepare(
      `INSERT INTO usuarios (id, nombre, usuario, password_hash, rol, sucursal_id, activo) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, rol = excluded.rol,
         sucursal_id = excluded.sucursal_id, activo = excluded.activo`
    );
    for (const u of data || []) {
      if (!db.prepare('SELECT 1 FROM sucursales WHERE id = ?').get(u.sucursal_id)) continue;
      try {
        guardar.run(Number(u.id), u.nombre, u.usuario, u.password_hash || '!', u.rol === 'admin' ? 'admin' : 'cajero',
          Number(u.sucursal_id), u.activo === false ? 0 : 1);
      } catch {
        // El nombre de usuario ya lo usa otro registro local: se muestra el usuario de respaldo
      }
    }
  } catch (error) {
    if (!error.sinConexion) console.error('No se pudieron copiar usuarios de la central:', error.message);
  }
}

// ---------- Espejo local ----------
const espejo = {
  apoyo: db.prepare(
    `INSERT INTO apoyos (id, folio, origen_id, destino_id, pedido_id, estado, nota, creado_por, creado,
       enviado_por, enviado, recibido_por, recibido, cancelado_por, cancelado, motivo_cancelacion)
     VALUES (@id, @folio, @origen_id, @destino_id, @pedido_id, @estado, @nota, @creado_por, @creado,
       @enviado_por, @enviado, @recibido_por, @recibido, @cancelado_por, @cancelado, @motivo_cancelacion)
     ON CONFLICT(id) DO UPDATE SET folio = excluded.folio, origen_id = excluded.origen_id,
       destino_id = excluded.destino_id, pedido_id = excluded.pedido_id, estado = excluded.estado,
       nota = excluded.nota, creado_por = excluded.creado_por, creado = excluded.creado,
       enviado_por = excluded.enviado_por, enviado = excluded.enviado, recibido_por = excluded.recibido_por,
       recibido = excluded.recibido, cancelado_por = excluded.cancelado_por, cancelado = excluded.cancelado,
       motivo_cancelacion = excluded.motivo_cancelacion`
  ),
  apoyoDetalle: db.prepare(
    `INSERT INTO apoyo_detalle (id, apoyo_id, producto_id, codigo_barras, descripcion, cantidad, cantidad_recibida,
       precio_costo, precio_venta, precio_mayoreo, importe)
     VALUES (@id, @apoyo_id, @producto_id, @codigo_barras, @descripcion, @cantidad, @cantidad_recibida,
       @precio_costo, @precio_venta, @precio_mayoreo, @importe)
     ON CONFLICT(id) DO UPDATE SET apoyo_id = excluded.apoyo_id, producto_id = excluded.producto_id,
       codigo_barras = excluded.codigo_barras, descripcion = excluded.descripcion, cantidad = excluded.cantidad,
       cantidad_recibida = excluded.cantidad_recibida, precio_costo = excluded.precio_costo,
       precio_venta = excluded.precio_venta, precio_mayoreo = excluded.precio_mayoreo, importe = excluded.importe`
  ),
  pedido: db.prepare(
    `INSERT INTO pedidos (id, folio, sucursal_id, estado, nota, creado_por, creado, enviado_por, enviado)
     VALUES (@id, @folio, @sucursal_id, @estado, @nota, @creado_por, @creado, @enviado_por, @enviado)
     ON CONFLICT(id) DO UPDATE SET folio = excluded.folio, sucursal_id = excluded.sucursal_id,
       estado = excluded.estado, nota = excluded.nota, creado_por = excluded.creado_por,
       creado = excluded.creado, enviado_por = excluded.enviado_por, enviado = excluded.enviado`
  ),
  pedidoDetalle: db.prepare(
    `INSERT INTO pedido_detalle (id, pedido_id, producto_id, codigo_barras, descripcion, cantidad, cantidad_surtida)
     VALUES (@id, @pedido_id, @producto_id, @codigo_barras, @descripcion, @cantidad, @cantidad_surtida)
     ON CONFLICT(id) DO UPDATE SET pedido_id = excluded.pedido_id, producto_id = excluded.producto_id,
       codigo_barras = excluded.codigo_barras, descripcion = excluded.descripcion, cantidad = excluded.cantidad,
       cantidad_surtida = excluded.cantidad_surtida`
  ),
};

function filaApoyo(a) {
  return {
    id: Number(a.id),
    folio: Number(a.folio),
    origen_id: Number(a.origen_id),
    destino_id: Number(a.destino_id),
    pedido_id: numeroONulo(a.pedido_id),
    estado: a.estado,
    nota: a.nota || '',
    creado_por: usuarioLocal(a.creado_por),
    creado: inventario.fechaLocal(a.creado) || inventario.fechaLocal(new Date().toISOString()),
    enviado_por: a.enviado_por == null ? null : usuarioLocal(a.enviado_por),
    enviado: a.enviado ? inventario.fechaLocal(a.enviado) : null,
    recibido_por: a.recibido_por == null ? null : usuarioLocal(a.recibido_por),
    recibido: a.recibido ? inventario.fechaLocal(a.recibido) : null,
    cancelado_por: a.cancelado_por == null ? null : usuarioLocal(a.cancelado_por),
    cancelado: a.cancelado ? inventario.fechaLocal(a.cancelado) : null,
    motivo_cancelacion: a.motivo_cancelacion || '',
  };
}

function filaApoyoDetalle(d) {
  return {
    id: Number(d.id),
    apoyo_id: Number(d.apoyo_id),
    producto_id: Number(d.producto_id),
    codigo_barras: d.codigo_barras || null,
    descripcion: d.descripcion || '',
    cantidad: Number(d.cantidad) || 0,
    cantidad_recibida: numeroONulo(d.cantidad_recibida),
    precio_costo: Number(d.precio_costo) || 0,
    precio_venta: Number(d.precio_venta) || 0,
    precio_mayoreo: numeroONulo(d.precio_mayoreo),
    importe: Number(d.importe) || 0,
  };
}

function filaPedido(p) {
  return {
    id: Number(p.id),
    folio: Number(p.folio),
    sucursal_id: Number(p.sucursal_id),
    estado: p.estado,
    nota: p.nota || '',
    creado_por: usuarioLocal(p.creado_por),
    creado: inventario.fechaLocal(p.creado) || inventario.fechaLocal(new Date().toISOString()),
    enviado_por: p.enviado_por == null ? null : usuarioLocal(p.enviado_por),
    enviado: p.enviado ? inventario.fechaLocal(p.enviado) : null,
  };
}

function filaPedidoDetalle(d) {
  return {
    id: Number(d.id),
    pedido_id: Number(d.pedido_id),
    producto_id: Number(d.producto_id),
    codigo_barras: d.codigo_barras || null,
    descripcion: d.descripcion || '',
    cantidad: Number(d.cantidad) || 0,
    cantidad_surtida: Number(d.cantidad_surtida) || 0,
  };
}

const existe = (tabla, id) => Boolean(db.prepare(`SELECT 1 FROM ${tabla} WHERE id = ?`).get(id));

// Quita los renglones locales de un pedido/apoyo que la central ya no tiene
function borrarRenglonesAusentes(tabla, campo, padreId, ids) {
  if (ids.length === 0) {
    db.prepare(`DELETE FROM ${tabla} WHERE ${campo} = ?`).run(padreId);
    return;
  }
  db.prepare(`DELETE FROM ${tabla} WHERE ${campo} = ? AND id NOT IN (${ids.map(() => '?').join(',')})`).run(padreId, ...ids);
}

// Refleja en SQLite pedidos y apoyos de la central con sus renglones (mismos ids)
const reflejar = db.transaction(({ pedidos = [], detallesPedido = [], apoyos = [], detallesApoyo = [] }) => {
  for (const p of pedidos) {
    if (!existe('sucursales', Number(p.sucursal_id))) continue;
    espejo.pedido.run(filaPedido(p));
    const ids = detallesPedido.filter((d) => Number(d.pedido_id) === Number(p.id)).map((d) => Number(d.id));
    borrarRenglonesAusentes('pedido_detalle', 'pedido_id', Number(p.id), ids);
  }
  for (const d of detallesPedido) {
    if (!existe('pedidos', Number(d.pedido_id)) || !existe('productos', Number(d.producto_id))) continue;
    db.prepare('DELETE FROM pedido_detalle WHERE pedido_id = ? AND producto_id = ? AND id <> ?')
      .run(Number(d.pedido_id), Number(d.producto_id), Number(d.id));
    espejo.pedidoDetalle.run(filaPedidoDetalle(d));
  }
  for (const a of apoyos) {
    if (!existe('sucursales', Number(a.origen_id)) || !existe('sucursales', Number(a.destino_id))) continue;
    const fila = filaApoyo(a);
    if (fila.pedido_id && !existe('pedidos', fila.pedido_id)) fila.pedido_id = null;
    espejo.apoyo.run(fila);
    const ids = detallesApoyo.filter((d) => Number(d.apoyo_id) === Number(a.id)).map((d) => Number(d.id));
    borrarRenglonesAusentes('apoyo_detalle', 'apoyo_id', Number(a.id), ids);
  }
  for (const d of detallesApoyo) {
    if (!existe('apoyos', Number(d.apoyo_id)) || !existe('productos', Number(d.producto_id))) continue;
    db.prepare('DELETE FROM apoyo_detalle WHERE apoyo_id = ? AND producto_id = ? AND id <> ?')
      .run(Number(d.apoyo_id), Number(d.producto_id), Number(d.id));
    espejo.apoyoDetalle.run(filaApoyoDetalle(d));
  }
});

async function prepararEspejo({ pedidos = [], detallesPedido = [], apoyos = [], detallesApoyo = [] }) {
  await inventario.asegurarSucursales([
    ...pedidos.map((p) => p.sucursal_id),
    ...apoyos.flatMap((a) => [a.origen_id, a.destino_id]),
  ]);
  await asegurarUsuarios([
    ...pedidos.flatMap((p) => [p.creado_por, p.enviado_por]),
    ...apoyos.flatMap((a) => [a.creado_por, a.enviado_por, a.recibido_por, a.cancelado_por]),
  ]);
  await catalogo.asegurarLocales([
    ...detallesPedido.map((d) => d.producto_id),
    ...detallesApoyo.map((d) => d.producto_id),
  ]);
  reflejar({ pedidos, detallesPedido, apoyos, detallesApoyo });
}

async function detallesDe(tabla, campo, ids) {
  const PAGINA = 1000;
  const filas = [];
  for (const lote of lotes(idsValidos(ids))) {
    for (let desde = 0; ; desde += PAGINA) {
      const { data } = await consultar(
        sb().from(tabla).select('*').in(campo, lote).order('id').range(desde, desde + PAGINA - 1)
      );
      filas.push(...(data || []));
      if (!data || data.length < PAGINA) break;
    }
  }
  return filas;
}

// Trae de la central pedidos (por ids, o los visibles para la sucursal) y los refleja en SQLite
async function traerPedidos({ ids = null, sucursalId = null, esCentral = false, limite = 200 } = {}) {
  if (!modoCentral() || !centralDisponible()) return false;
  try {
    let consulta = sb().from('pedidos').select('*');
    if (ids) consulta = consulta.in('id', idsValidos(ids));
    else if (esCentral) consulta = consulta.or(`sucursal_id.eq.${Number(sucursalId)},estado.neq.borrador`);
    else consulta = consulta.eq('sucursal_id', Number(sucursalId));
    const { data: pedidos } = await consultar(consulta.order('id', { ascending: false }).limit(limite));
    const detallesPedido = await detallesDe('pedido_detalle', 'pedido_id', (pedidos || []).map((p) => p.id));
    await prepararEspejo({ pedidos: pedidos || [], detallesPedido });
    return true;
  } catch (error) {
    if (error.sinConexion) return false;
    throw error;
  }
}

// Trae de la central apoyos (por ids, o los de la sucursal como origen o destino) y los refleja
async function traerApoyos({ ids = null, sucursalId = null, limite = 200 } = {}) {
  if (!modoCentral() || !centralDisponible()) return false;
  try {
    let consulta = sb().from('apoyos').select('*');
    if (ids) consulta = consulta.in('id', idsValidos(ids));
    else consulta = consulta.or(`origen_id.eq.${Number(sucursalId)},destino_id.eq.${Number(sucursalId)}`);
    const { data: apoyos } = await consultar(consulta.order('id', { ascending: false }).limit(limite));
    const detallesApoyo = await detallesDe('apoyo_detalle', 'apoyo_id', (apoyos || []).map((a) => a.id));
    const idsPedidos = idsValidos((apoyos || []).map((a) => a.pedido_id)).filter((id) => !existe('pedidos', id));
    let pedidos = [];
    let detallesPedido = [];
    if (idsPedidos.length) {
      const { data } = await consultar(sb().from('pedidos').select('*').in('id', idsPedidos));
      pedidos = data || [];
      detallesPedido = await detallesDe('pedido_detalle', 'pedido_id', pedidos.map((p) => p.id));
    }
    await prepararEspejo({ pedidos, detallesPedido, apoyos: apoyos || [], detallesApoyo });
    return true;
  } catch (error) {
    if (error.sinConexion) return false;
    throw error;
  }
}

// Avisos de la pestaña: apoyos por recibir y pedidos por surtir
async function contarPendientes(usuario) {
  const sucursalId = Number(usuario.sucursal_id);
  const esCentral = Boolean(usuario.es_central);
  if (modoCentral() && centralDisponible()) {
    try {
      const { count: porRecibir } = await consultar(
        sb().from('apoyos').select('id', { count: 'exact', head: true }).eq('destino_id', sucursalId).eq('estado', 'enviado')
      );
      let porSurtir = 0;
      if (esCentral) {
        const { count } = await consultar(sb().from('pedidos').select('id', { count: 'exact', head: true }).eq('estado', 'enviado'));
        porSurtir = count || 0;
      }
      return { por_recibir: porRecibir || 0, pedidos_por_surtir: porSurtir };
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  const porRecibir = db.prepare("SELECT COUNT(*) AS n FROM apoyos WHERE destino_id = ? AND estado = 'enviado'").get(sucursalId).n;
  const porSurtir = esCentral ? db.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE estado = 'enviado'").get().n : 0;
  return { por_recibir: porRecibir, pedidos_por_surtir: porSurtir };
}

// ---------- Escrituras ----------
// Inserta en la central. Si la secuencia de ids quedó atrás (registros subidos antes con id
// explícito), usa el siguiente id libre.
async function insertarCentral(tabla, fila) {
  try {
    const { data } = await consultar(sb().from(tabla).insert(fila).select('*'));
    return data[0];
  } catch (error) {
    if (error.codigo !== '23505' || !/_pkey/i.test(error.message)) throw error;
    for (let intento = 0; intento < 6; intento += 1) {
      const { data: ultimo } = await consultar(sb().from(tabla).select('id').order('id', { ascending: false }).limit(1));
      const id = (ultimo && ultimo[0] ? Number(ultimo[0].id) : 0) + 1 + intento;
      try {
        const { data } = await consultar(sb().from(tabla).insert({ ...fila, id }).select('*'));
        return data[0];
      } catch (otro) {
        if (otro.codigo !== '23505' || !/_pkey/i.test(otro.message)) throw otro;
      }
    }
    throw error;
  }
}

async function siguienteFolio(tabla, campo, valor) {
  if (modoCentral()) {
    const { data } = await consultar(
      sb().from(tabla).select('folio').eq(campo, Number(valor)).order('folio', { ascending: false }).limit(1)
    );
    const central = data && data[0] ? Number(data[0].folio) : 0;
    const localMax = db.prepare(`SELECT COALESCE(MAX(folio), 0) AS f FROM ${tabla} WHERE ${campo} = ?`).get(Number(valor)).f;
    return Math.max(central, localMax) + 1;
  }
  return db.prepare(`SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM ${tabla} WHERE ${campo} = ?`).get(Number(valor)).f;
}

// Actualiza un apoyo o pedido. Con estadoEsperado solo cambia si sigue en ese estado
// (así dos computadoras no pueden procesar lo mismo). Devuelve true si lo cambió.
async function actualizar(tabla, id, cambios, { estadoEsperado = null } = {}) {
  const estados = estadoEsperado ? [].concat(estadoEsperado) : null;
  if (modoCentral()) {
    let consulta = sb().from(tabla).update({ ...paraCentral(cambios), updated_at: new Date().toISOString() }).eq('id', Number(id));
    if (estados) consulta = consulta.in('estado', estados);
    const { data } = await consultar(consulta.select('id'));
    if (!data || data.length === 0) return false;
    if (tabla === 'apoyos') await traerApoyos({ ids: [id] });
    else await traerPedidos({ ids: [id] });
    return true;
  }
  const locales = paraLocal(cambios);
  const campos = Object.keys(locales);
  const info = db
    .prepare(
      `UPDATE ${tabla} SET ${campos.map((c) => `${c} = @${c}`).join(', ')}
       WHERE id = @__id ${estados ? `AND estado IN (${estados.map((_, i) => `@__e${i}`).join(', ')})` : ''}`
    )
    .run({ ...locales, __id: Number(id), ...Object.fromEntries((estados || []).map((e, i) => [`__e${i}`, e])) });
  return info.changes > 0;
}

async function crearPedido({ sucursalId, usuarioId }) {
  const folio = await siguienteFolio('pedidos', 'sucursal_id', sucursalId);
  if (modoCentral()) {
    const fila = await insertarCentral('pedidos', {
      folio, sucursal_id: Number(sucursalId), estado: 'borrador', nota: '', creado_por: usuarioId,
      creado: new Date().toISOString(),
    });
    await prepararEspejo({ pedidos: [fila] });
    return Number(fila.id);
  }
  return Number(db.prepare('INSERT INTO pedidos (folio, sucursal_id, creado_por) VALUES (?, ?, ?)')
    .run(folio, sucursalId, usuarioId).lastInsertRowid);
}

async function crearApoyo({ origenId, destinoId, pedidoId = null, usuarioId }) {
  const folio = await siguienteFolio('apoyos', 'origen_id', origenId);
  if (modoCentral()) {
    const fila = await insertarCentral('apoyos', {
      folio, origen_id: Number(origenId), destino_id: Number(destinoId), pedido_id: pedidoId ? Number(pedidoId) : null,
      estado: 'borrador', nota: '', creado_por: usuarioId, creado: new Date().toISOString(),
    });
    await traerApoyos({ ids: [fila.id] });
    return Number(fila.id);
  }
  return Number(db
    .prepare('INSERT INTO apoyos (folio, origen_id, destino_id, pedido_id, creado_por) VALUES (?, ?, ?, ?, ?)')
    .run(folio, origenId, destinoId, pedidoId || null, usuarioId).lastInsertRowid);
}

// Agrega (o suma a) el renglón de un producto en un apoyo en borrador, con los precios de hoy
async function sumarRenglonApoyo(apoyoId, producto, cantidad) {
  const existente = db.prepare('SELECT * FROM apoyo_detalle WHERE apoyo_id = ? AND producto_id = ?').get(apoyoId, producto.id);
  if (existente) return cambiarCantidadApoyo(apoyoId, existente.id, redondear(existente.cantidad + cantidad));
  const fila = {
    apoyo_id: Number(apoyoId),
    producto_id: producto.id,
    codigo_barras: producto.codigo_barras,
    descripcion: producto.descripcion,
    cantidad: redondear(cantidad),
    precio_costo: producto.precio_costo,
    precio_venta: producto.precio_venta,
    precio_mayoreo: producto.precio_mayoreo,
    importe: redondear(producto.precio_costo * cantidad),
  };
  if (modoCentral()) {
    try {
      await insertarCentral('apoyo_detalle', fila);
    } catch (error) {
      if (error.codigo !== '23505') throw error;
      // Ya estaba en la central (la copia local no lo tenía): se suma ahí
      const { data } = await consultar(
        sb().from('apoyo_detalle').select('id,cantidad').eq('apoyo_id', Number(apoyoId)).eq('producto_id', producto.id).limit(1)
      );
      if (!data || !data[0]) throw error;
      await consultar(sb().from('apoyo_detalle').update({
        cantidad: redondear(Number(data[0].cantidad) + cantidad),
        importe: redondear(producto.precio_costo * (Number(data[0].cantidad) + cantidad)),
      }).eq('id', data[0].id));
    }
    await traerApoyos({ ids: [apoyoId] });
    return;
  }
  db.prepare(
    `INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad, precio_costo,
       precio_venta, precio_mayoreo, importe)
     VALUES (@apoyo_id, @producto_id, @codigo_barras, @descripcion, @cantidad, @precio_costo, @precio_venta,
       @precio_mayoreo, @importe)`
  ).run(fila);
}

async function cambiarCantidadApoyo(apoyoId, renglonId, cantidad) {
  const renglon = db.prepare('SELECT * FROM apoyo_detalle WHERE id = ? AND apoyo_id = ?').get(renglonId, apoyoId);
  if (!renglon) throw new ErrorApp('Renglón no encontrado', { status: 404 });
  const cambios = { cantidad: redondear(cantidad), importe: redondear(renglon.precio_costo * cantidad) };
  if (modoCentral()) {
    await consultar(sb().from('apoyo_detalle').update(cambios).eq('id', Number(renglonId)).eq('apoyo_id', Number(apoyoId)));
    await traerApoyos({ ids: [apoyoId] });
    return;
  }
  db.prepare('UPDATE apoyo_detalle SET cantidad = ?, importe = ? WHERE id = ?').run(cambios.cantidad, cambios.importe, renglonId);
}

async function quitarRenglonApoyo(apoyoId, renglonId) {
  if (modoCentral()) {
    await consultar(sb().from('apoyo_detalle').delete().eq('id', Number(renglonId)).eq('apoyo_id', Number(apoyoId)));
    await traerApoyos({ ids: [apoyoId] });
    return;
  }
  db.prepare('DELETE FROM apoyo_detalle WHERE id = ? AND apoyo_id = ?').run(renglonId, apoyoId);
}

async function marcarRecibido(apoyoId, recibidas) {
  if (modoCentral()) {
    for (const { renglon, cantidad } of recibidas) {
      await consultar(sb().from('apoyo_detalle').update({ cantidad_recibida: cantidad }).eq('id', renglon.id));
    }
    await traerApoyos({ ids: [apoyoId] });
    return;
  }
  const marcar = db.prepare('UPDATE apoyo_detalle SET cantidad_recibida = ? WHERE id = ?');
  db.transaction(() => {
    for (const { renglon, cantidad } of recibidas) marcar.run(cantidad, renglon.id);
  })();
}

// Agrega (o suma a) un producto en un pedido
async function sumarRenglonPedido(pedidoId, producto, cantidad) {
  const existente = db.prepare('SELECT * FROM pedido_detalle WHERE pedido_id = ? AND producto_id = ?').get(pedidoId, producto.id);
  if (existente) return cambiarCantidadPedido(pedidoId, existente.id, redondear(existente.cantidad + cantidad));
  const fila = {
    pedido_id: Number(pedidoId),
    producto_id: producto.id,
    codigo_barras: producto.codigo_barras,
    descripcion: producto.descripcion,
    cantidad: redondear(cantidad),
  };
  if (modoCentral()) {
    try {
      await insertarCentral('pedido_detalle', fila);
    } catch (error) {
      if (error.codigo !== '23505') throw error;
      const { data } = await consultar(
        sb().from('pedido_detalle').select('id,cantidad').eq('pedido_id', Number(pedidoId)).eq('producto_id', producto.id).limit(1)
      );
      if (!data || !data[0]) throw error;
      await consultar(sb().from('pedido_detalle').update({ cantidad: redondear(Number(data[0].cantidad) + cantidad) }).eq('id', data[0].id));
    }
    await traerPedidos({ ids: [pedidoId] });
    return;
  }
  db.prepare(
    `INSERT INTO pedido_detalle (pedido_id, producto_id, codigo_barras, descripcion, cantidad)
     VALUES (@pedido_id, @producto_id, @codigo_barras, @descripcion, @cantidad)`
  ).run(fila);
}

async function cambiarCantidadPedido(pedidoId, renglonId, cantidad) {
  const renglon = db.prepare('SELECT * FROM pedido_detalle WHERE id = ? AND pedido_id = ?').get(renglonId, pedidoId);
  if (!renglon) throw new ErrorApp('Renglón no encontrado', { status: 404 });
  if (modoCentral()) {
    await consultar(sb().from('pedido_detalle').update({ cantidad: redondear(cantidad) }).eq('id', Number(renglonId)).eq('pedido_id', Number(pedidoId)));
    await traerPedidos({ ids: [pedidoId] });
    return;
  }
  db.prepare('UPDATE pedido_detalle SET cantidad = ? WHERE id = ?').run(redondear(cantidad), renglonId);
}

async function quitarRenglonPedido(pedidoId, renglonId) {
  if (modoCentral()) {
    await consultar(sb().from('pedido_detalle').delete().eq('id', Number(renglonId)).eq('pedido_id', Number(pedidoId)));
    await traerPedidos({ ids: [pedidoId] });
    return;
  }
  db.prepare('DELETE FROM pedido_detalle WHERE id = ? AND pedido_id = ?').run(renglonId, pedidoId);
}

// Suma (signo 1) o regresa (signo -1) lo surtido de un pedido por los renglones de un apoyo
async function ajustarSurtido(pedidoId, renglones, signo) {
  if (!pedidoId || !renglones.length) return;
  if (modoCentral()) {
    const { data } = await consultar(sb().from('pedido_detalle').select('id,producto_id,cantidad_surtida').eq('pedido_id', Number(pedidoId)));
    const porProducto = new Map((data || []).map((d) => [Number(d.producto_id), d]));
    for (const r of renglones) {
      const fila = porProducto.get(Number(r.producto_id));
      if (!fila) continue;
      await consultar(sb().from('pedido_detalle')
        .update({ cantidad_surtida: Math.max(redondear(Number(fila.cantidad_surtida) + signo * r.cantidad), 0) })
        .eq('id', fila.id));
    }
    await traerPedidos({ ids: [pedidoId] });
    return;
  }
  const cambiar = db.prepare(
    `UPDATE pedido_detalle SET cantidad_surtida = MAX(ROUND(cantidad_surtida + ?, 2), 0)
     WHERE pedido_id = ? AND producto_id = ?`
  );
  db.transaction(() => {
    for (const r of renglones) cambiar.run(signo * r.cantidad, pedidoId, r.producto_id);
  })();
}

// ¿El pedido tiene otros apoyos que no estén cancelados?
async function otrosApoyosActivos(pedidoId, apoyoId) {
  if (modoCentral() && centralDisponible()) {
    try {
      const { count } = await consultar(
        sb().from('apoyos').select('id', { count: 'exact', head: true })
          .eq('pedido_id', Number(pedidoId)).neq('id', Number(apoyoId)).neq('estado', 'cancelado')
      );
      return (count || 0) > 0;
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  return db
    .prepare("SELECT COUNT(*) AS n FROM apoyos WHERE pedido_id = ? AND id <> ? AND estado <> 'cancelado'")
    .get(pedidoId, apoyoId).n > 0;
}

module.exports = {
  otrosApoyosActivos,
  asegurarUsuarios,
  traerPedidos,
  traerApoyos,
  contarPendientes,
  actualizar,
  crearPedido,
  crearApoyo,
  sumarRenglonApoyo,
  cambiarCantidadApoyo,
  quitarRenglonApoyo,
  marcarRecibido,
  sumarRenglonPedido,
  cambiarCantidadPedido,
  quitarRenglonPedido,
  ajustarSurtido,
};
