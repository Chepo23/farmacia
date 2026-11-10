// Cotizaciones: el administrador de la central las arma (normalmente desde el celular) y las manda
// a una sucursal, o a un usuario de esa sucursal, para que ahí se cobre la venta en la caja.
// - Con Supabase viven solo en la central: la caja las consulta al momento. Sin internet no se
//   pueden cargar, pero se puede vender igual con los precios de hoy.
// - Sin central viven en SQLite.
// El precio cotizado se respeta DIAS_VIGENCIA días; después se cobran los precios de hoy.
// Al cobrarla, la cotización se aparta primero (enviada -> vendida) para que dos cajas no la
// cobren dos veces; si la venta falla, se libera.
const db = require('./db');
const catalogo = require('./catalogo');
const { ErrorApp, modoCentral, consultar, sb } = require('./central');

const DIAS_VIGENCIA = 7;
const MAX_RENGLONES = 200;
const ESTADOS = ['enviada', 'vendida', 'cancelada'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const numeroONulo = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const idsValidos = (ids) => [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
const esAdminCentral = (u) => Boolean(u) && u.rol === 'admin' && Number(u.es_central) === 1;

// SQLite responde "2026-10-14T18:00:00.000Z"; la central, "2026-10-14T18:00:00+00:00": ambas sirven a Date
const vigente = (c, ahora = Date.now()) => c.estado === 'enviada' && new Date(c.vigente_hasta).getTime() >= ahora;

// ---------- Lectura ----------
async function nombres({ sucursales = [], usuarios = [] }) {
  const s = idsValidos(sucursales);
  const u = idsValidos(usuarios);
  const mapaS = new Map();
  const mapaU = new Map();
  if (modoCentral()) {
    if (s.length) {
      const { data } = await consultar(sb().from('sucursales').select('id,nombre').in('id', s));
      for (const f of data || []) mapaS.set(Number(f.id), f.nombre);
    }
    if (u.length) {
      const { data } = await consultar(sb().from('usuarios_central').select('id,nombre').in('id', u));
      for (const f of data || []) mapaU.set(Number(f.id), f.nombre);
    }
  } else {
    for (const id of s) mapaS.set(id, db.prepare('SELECT nombre FROM sucursales WHERE id = ?').get(id)?.nombre || '');
    for (const id of u) mapaU.set(id, db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(id)?.nombre || '');
  }
  return {
    sucursal: (id) => mapaS.get(Number(id)) || (id ? `Sucursal ${id}` : ''),
    usuario: (id) => mapaU.get(Number(id)) || (id ? `Usuario ${id}` : ''),
  };
}

async function filaPorId(id) {
  if (modoCentral()) {
    const { data } = await consultar(sb().from('cotizaciones').select('*').eq('id', Number(id)).limit(1));
    return data && data[0] ? data[0] : null;
  }
  return db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(Number(id)) || null;
}

async function detallesDe(ids) {
  const lista = idsValidos(ids);
  if (!lista.length) return [];
  if (modoCentral()) {
    const filas = [];
    for (let i = 0; i < lista.length; i += 100) {
      const { data } = await consultar(
        sb().from('cotizacion_detalle').select('*').in('cotizacion_id', lista.slice(i, i + 100)).order('id').limit(5000)
      );
      filas.push(...(data || []));
    }
    return filas;
  }
  return db
    .prepare(`SELECT * FROM cotizacion_detalle WHERE cotizacion_id IN (${lista.map(() => '?').join(',')}) ORDER BY id`)
    .all(...lista);
}

function formatear(c, n, renglones) {
  const lineas = renglones.map((d) => ({
    id: Number(d.id),
    producto_id: Number(d.producto_id),
    codigo_barras: d.codigo_barras || null,
    descripcion: d.descripcion || '',
    cantidad: r2(d.cantidad),
    precio_unitario: r2(d.precio_unitario),
    precio_lista: r2(d.precio_lista),
    importe: r2(d.importe),
  }));
  return {
    id: Number(c.id),
    folio: Number(c.folio),
    estado: c.estado,
    cliente: c.cliente || '',
    nota: c.nota || '',
    total: r2(c.total),
    creado: c.creado,
    vigente_hasta: c.vigente_hasta,
    vigente: vigente(c),
    creado_por: Number(c.creado_por),
    creador: n.usuario(c.creado_por),
    origen_sucursal_id: Number(c.origen_sucursal_id),
    destino_sucursal_id: Number(c.destino_sucursal_id),
    destino: n.sucursal(c.destino_sucursal_id),
    destino_usuario_id: numeroONulo(c.destino_usuario_id),
    destino_usuario: c.destino_usuario_id ? n.usuario(c.destino_usuario_id) : '',
    vendida_folio: numeroONulo(c.vendida_folio),
    vendida_fecha: c.vendida_fecha || null,
    vendida_por: numeroONulo(c.vendida_por),
    vendedor: c.vendida_por ? n.usuario(c.vendida_por) : '',
    cancelada_fecha: c.cancelada_fecha || null,
    productos: lineas.length,
    articulos: r2(lineas.reduce((t, d) => t + d.cantidad, 0)),
    renglones: lineas,
  };
}

async function completar(filas) {
  const detalles = await detallesDe(filas.map((c) => c.id));
  const n = await nombres({
    sucursales: filas.map((c) => c.destino_sucursal_id),
    usuarios: filas.flatMap((c) => [c.creado_por, c.destino_usuario_id, c.vendida_por]),
  });
  return filas.map((c) => formatear(c, n, detalles.filter((d) => Number(d.cotizacion_id) === Number(c.id))));
}

// bandeja 'recibidas': las que llegaron a la sucursal del usuario. 'enviadas': todas (solo el
// administrador de la central, que es quien las arma).
async function listar(usuario, { bandeja = 'recibidas', estado = '' } = {}) {
  const todas = bandeja === 'enviadas';
  if (todas && !esAdminCentral(usuario)) {
    throw new ErrorApp('Solo el administrador de la central ve todas las cotizaciones', { status: 403 });
  }
  const filtro = ESTADOS.includes(estado) ? estado : '';
  let filas;
  if (modoCentral()) {
    let consulta = sb().from('cotizaciones').select('*');
    if (!todas) consulta = consulta.eq('destino_sucursal_id', Number(usuario.sucursal_id));
    if (filtro) consulta = consulta.eq('estado', filtro);
    ({ data: filas } = await consultar(consulta.order('id', { ascending: false }).limit(100)));
  } else {
    filas = db
      .prepare(
        `SELECT * FROM cotizaciones
         WHERE (@todas = 1 OR destino_sucursal_id = @suc) AND (@estado = '' OR estado = @estado)
         ORDER BY id DESC LIMIT 100`
      )
      .all({ todas: todas ? 1 : 0, suc: Number(usuario.sucursal_id), estado: filtro });
  }
  return completar(filas || []);
}

async function cargar(id, usuario) {
  const c = await filaPorId(id);
  if (!c) throw new ErrorApp('Cotización no encontrada', { status: 404 });
  if (!esAdminCentral(usuario) && Number(c.destino_sucursal_id) !== Number(usuario.sucursal_id)) {
    throw new ErrorApp('Esa cotización es de otra sucursal', { status: 403 });
  }
  const [cotizacion] = await completar([c]);
  return cotizacion;
}

// Para el aviso del botón en la caja: cuántas esperan cobro en la sucursal y cuántas son para el usuario
async function pendientes(usuario) {
  const sucursalId = Number(usuario.sucursal_id);
  let filas;
  if (modoCentral()) {
    ({ data: filas } = await consultar(
      sb().from('cotizaciones').select('id,destino_usuario_id').eq('destino_sucursal_id', sucursalId).eq('estado', 'enviada').limit(500)
    ));
  } else {
    filas = db.prepare("SELECT id, destino_usuario_id FROM cotizaciones WHERE destino_sucursal_id = ? AND estado = 'enviada'").all(sucursalId);
  }
  const lista = filas || [];
  return {
    pendientes: lista.length,
    para_mi: lista.filter((f) => Number(f.destino_usuario_id) === Number(usuario.id)).length,
  };
}

// Sucursales y usuarios a los que se puede mandar una cotización
async function destinos(usuario) {
  if (!esAdminCentral(usuario)) throw new ErrorApp('Solo el administrador de la central arma cotizaciones', { status: 403 });
  if (modoCentral()) {
    const { data: sucursales } = await consultar(sb().from('sucursales').select('id,nombre,es_central').eq('activa', true).order('id'));
    const { data: usuarios } = await consultar(
      sb().from('usuarios_central').select('id,nombre,usuario,rol,sucursal_id').eq('activo', true).order('nombre')
    );
    return {
      sucursales: (sucursales || []).map((s) => ({ id: Number(s.id), nombre: s.nombre, es_central: s.es_central ? 1 : 0 })),
      usuarios: (usuarios || []).map((u) => ({ id: Number(u.id), nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursal_id: Number(u.sucursal_id) })),
    };
  }
  return {
    sucursales: db.prepare('SELECT id, nombre, es_central FROM sucursales WHERE activa = 1 ORDER BY id').all(),
    usuarios: db.prepare('SELECT id, nombre, usuario, rol, sucursal_id FROM usuarios WHERE activo = 1 ORDER BY nombre').all(),
  };
}

// ---------- Escritura ----------
async function validarDestino(sucursalId, usuarioId) {
  const sucursal = Number(sucursalId);
  const usuario = numeroONulo(usuarioId);
  if (!(sucursal > 0)) throw new ErrorApp('Elige la sucursal a la que va la cotización');
  if (modoCentral()) {
    const { data } = await consultar(sb().from('sucursales').select('id').eq('id', sucursal).eq('activa', true).limit(1));
    if (!data || !data.length) throw new ErrorApp('Sucursal de destino no válida');
    if (usuario) {
      const { data: u } = await consultar(
        sb().from('usuarios_central').select('id,sucursal_id').eq('id', usuario).eq('activo', true).limit(1)
      );
      if (!u || !u.length) throw new ErrorApp('El usuario de destino no existe o está dado de baja');
      if (Number(u[0].sucursal_id) !== sucursal) throw new ErrorApp('Ese usuario es de otra sucursal');
    }
  } else {
    if (!db.prepare('SELECT 1 FROM sucursales WHERE id = ? AND activa = 1').get(sucursal)) throw new ErrorApp('Sucursal de destino no válida');
    if (usuario) {
      const u = db.prepare('SELECT sucursal_id FROM usuarios WHERE id = ? AND activo = 1').get(usuario);
      if (!u) throw new ErrorApp('El usuario de destino no existe o está dado de baja');
      if (Number(u.sucursal_id) !== sucursal) throw new ErrorApp('Ese usuario es de otra sucursal');
    }
  }
  return { sucursal, usuario };
}

// Junta renglones repetidos del mismo producto y revisa cantidades y precios
function normalizarRenglones(renglones) {
  if (!Array.isArray(renglones) || renglones.length === 0) throw new ErrorApp('La cotización no tiene productos');
  if (renglones.length > MAX_RENGLONES) throw new ErrorApp(`La cotización tiene demasiados productos (máximo ${MAX_RENGLONES})`);
  const porProducto = new Map();
  for (const r of renglones) {
    const id = Number(r.producto_id);
    if (!(id > 0)) throw new ErrorApp('Producto no válido en la cotización');
    const cantidad = Number(r.cantidad);
    if (!Number.isFinite(cantidad) || !(cantidad > 0)) throw new ErrorApp('Hay una cantidad no válida en la cotización');
    let precio = null;
    if (r.precio_unitario !== undefined && r.precio_unitario !== null && r.precio_unitario !== '') {
      precio = Number(r.precio_unitario);
      if (!Number.isFinite(precio) || precio < 0) throw new ErrorApp('Hay un precio no válido en la cotización');
    }
    const previo = porProducto.get(id);
    porProducto.set(id, { cantidad: r2((previo?.cantidad || 0) + cantidad), precio: precio ?? previo?.precio ?? null });
  }
  return porProducto;
}

async function siguienteFolio() {
  if (modoCentral()) {
    const { data } = await consultar(sb().from('cotizaciones').select('folio').order('folio', { ascending: false }).limit(1));
    return (data && data[0] ? Number(data[0].folio) : 0) + 1;
  }
  return db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM cotizaciones').get().f;
}

async function crear(usuario, cuerpo = {}) {
  if (!esAdminCentral(usuario)) throw new ErrorApp('Solo el administrador de la central arma cotizaciones', { status: 403 });
  const destino = await validarDestino(cuerpo.destino_sucursal_id, cuerpo.destino_usuario_id);
  const porProducto = normalizarRenglones(cuerpo.renglones);
  const productos = await catalogo.porIds([...porProducto.keys()]);
  const faltan = [...porProducto.keys()].filter((id) => !productos.has(id));
  if (faltan.length) throw new ErrorApp(`Hay productos que ya no están en el catálogo (${faltan.join(', ')})`, { status: 404 });

  const detalle = [...porProducto].map(([id, r]) => {
    const p = productos.get(id);
    const precio = r2(r.precio ?? p.precio_venta);
    return {
      producto_id: id,
      codigo_barras: p.codigo_barras || null,
      descripcion: p.descripcion,
      cantidad: r.cantidad,
      precio_unitario: precio,
      precio_lista: r2(p.precio_venta),
      importe: r2(precio * r.cantidad),
    };
  });
  const ahora = new Date();
  const base = {
    creado_por: Number(usuario.id),
    origen_sucursal_id: Number(usuario.sucursal_id),
    destino_sucursal_id: destino.sucursal,
    destino_usuario_id: destino.usuario,
    cliente: String(cuerpo.cliente || '').trim().slice(0, 120),
    nota: String(cuerpo.nota || '').trim().slice(0, 300),
    estado: 'enviada',
    total: r2(detalle.reduce((t, d) => t + d.importe, 0)),
    vigente_hasta: new Date(ahora.getTime() + DIAS_VIGENCIA * 86400000).toISOString(),
    creado: ahora.toISOString(),
  };

  if (!modoCentral()) {
    const id = db.transaction(() => {
      const folio = db.prepare('SELECT COALESCE(MAX(folio), 0) + 1 AS f FROM cotizaciones').get().f;
      const nuevo = db
        .prepare(
          `INSERT INTO cotizaciones (folio, creado_por, origen_sucursal_id, destino_sucursal_id, destino_usuario_id,
             cliente, nota, estado, total, vigente_hasta, creado)
           VALUES (@folio, @creado_por, @origen_sucursal_id, @destino_sucursal_id, @destino_usuario_id,
             @cliente, @nota, @estado, @total, @vigente_hasta, @creado)`
        )
        .run({ ...base, folio }).lastInsertRowid;
      const insertar = db.prepare(
        `INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, codigo_barras, descripcion, cantidad, precio_unitario, precio_lista, importe)
         VALUES (@cotizacion_id, @producto_id, @codigo_barras, @descripcion, @cantidad, @precio_unitario, @precio_lista, @importe)`
      );
      for (const d of detalle) insertar.run({ ...d, cotizacion_id: nuevo });
      return nuevo;
    })();
    return cargar(id, usuario);
  }

  // En la central el folio es único: si dos celulares cotizan al mismo tiempo, se toma el siguiente
  let fila = null;
  for (let intento = 0; intento < 6 && !fila; intento += 1) {
    try {
      const { data } = await consultar(sb().from('cotizaciones').insert({ ...base, folio: (await siguienteFolio()) + intento }).select('*'));
      fila = data[0];
    } catch (error) {
      if (error.codigo !== '23505' || intento === 5) throw error;
    }
  }
  try {
    await consultar(sb().from('cotizacion_detalle').insert(detalle.map((d) => ({ ...d, cotizacion_id: Number(fila.id) }))));
  } catch (error) {
    await consultar(sb().from('cotizaciones').delete().eq('id', Number(fila.id))).catch(() => {});
    throw error;
  }
  return cargar(fila.id, usuario);
}

// Cambia el estado solo si sigue en el esperado; devuelve true si lo cambió
async function cambiarEstado(id, cambios, esperado, { sinFolioDeVenta = false } = {}) {
  if (modoCentral()) {
    let consulta = sb().from('cotizaciones').update({ ...cambios, updated_at: new Date().toISOString() })
      .eq('id', Number(id)).eq('estado', esperado);
    if (sinFolioDeVenta) consulta = consulta.is('vendida_folio', null);
    const { data } = await consultar(consulta.select('id'));
    return Boolean(data && data.length);
  }
  const campos = Object.keys(cambios);
  return db
    .prepare(
      `UPDATE cotizaciones SET ${campos.map((c) => `${c} = @${c}`).join(', ')}
       WHERE id = @__id AND estado = @__esperado ${sinFolioDeVenta ? 'AND vendida_folio IS NULL' : ''}`
    )
    .run({ ...cambios, __id: Number(id), __esperado: esperado }).changes > 0;
}

async function cancelar(id, usuario) {
  if (!esAdminCentral(usuario)) throw new ErrorApp('Solo el administrador de la central cancela cotizaciones', { status: 403 });
  const c = await filaPorId(id);
  if (!c) throw new ErrorApp('Cotización no encontrada', { status: 404 });
  if (c.estado === 'cancelada') return cargar(id, usuario);
  if (c.estado !== 'enviada') throw new ErrorApp('Esa cotización ya se cobró; no se puede cancelar');
  const hecho = await cambiarEstado(id, { estado: 'cancelada', cancelada_por: Number(usuario.id), cancelada_fecha: new Date().toISOString() }, 'enviada');
  if (!hecho) throw new ErrorApp('La cotización cambió mientras tanto; actualiza la pantalla');
  return cargar(id, usuario);
}

// ---------- Venta ----------
// Revisa que la cotización se pueda cobrar en la sucursal y devuelve sus precios por producto
async function paraVenta(id, usuario) {
  const c = await filaPorId(id);
  if (!c) throw new ErrorApp('La cotización ya no existe', { status: 404 });
  if (Number(c.destino_sucursal_id) !== Number(usuario.sucursal_id)) throw new ErrorApp('Esa cotización es de otra sucursal', { status: 403 });
  if (c.estado === 'vendida') throw new ErrorApp(`La cotización folio ${c.folio} ya se cobró${c.vendida_folio ? ` (venta folio ${c.vendida_folio})` : ''}`, { codigo: 'COTIZACION_USADA' });
  if (c.estado === 'cancelada') throw new ErrorApp(`La cotización folio ${c.folio} fue cancelada`, { codigo: 'COTIZACION_USADA' });
  const precios = new Map();
  for (const d of await detallesDe([c.id])) {
    precios.set(Number(d.producto_id), { precio: r2(d.precio_unitario), cantidad: r2(d.cantidad) });
  }
  return { id: Number(c.id), folio: Number(c.folio), cliente: c.cliente || '', vigente: vigente(c), precios };
}

// enviada -> vendida (antes de guardar la venta)
async function apartar(id, usuario) {
  const hecho = await cambiarEstado(id, {
    estado: 'vendida', vendida_por: Number(usuario.id), vendida_fecha: new Date().toISOString(), vendida_folio: null,
  }, 'enviada');
  if (!hecho) throw new ErrorApp('Otra caja acaba de cobrar o cancelar esta cotización', { codigo: 'COTIZACION_USADA' });
}

async function confirmarVenta(id, folioVenta) {
  await cambiarEstado(id, { vendida_folio: Number(folioVenta) }, 'vendida', { sinFolioDeVenta: true });
}

// Si la venta no se pudo guardar, la cotización vuelve a quedar disponible
async function liberar(id) {
  try {
    await cambiarEstado(id, { estado: 'enviada', vendida_por: null, vendida_fecha: null }, 'vendida', { sinFolioDeVenta: true });
  } catch (error) {
    console.error('No se pudo liberar la cotización', id, error.message);
  }
}

module.exports = {
  DIAS_VIGENCIA,
  esAdminCentral,
  listar,
  cargar,
  pendientes,
  destinos,
  crear,
  cancelar,
  paraVenta,
  apartar,
  confirmarVenta,
  liberar,
};
