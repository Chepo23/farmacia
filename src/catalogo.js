// Catálogo de productos.
// - Modo central (con Supabase): la central es la autoridad y esta computadora guarda una
//   copia con los MISMOS ids (así ventas, apoyos y pedidos apuntan siempre al mismo producto).
// - Modo local (sin Supabase): SQLite es la autoridad.
// Si la central no responde, las lecturas usan la copia local.
const db = require('./db');
const { ErrorApp, modoCentral, centralDisponible, consultar, sb } = require('./central');

const COLUMNAS_CENTRAL =
  'id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,precio_mayoreo,cantidad_mayoreo,usa_inventario,activo';
const CAMPOS_LOCAL = `p.id, p.codigo_barras, p.descripcion, p.departamento, p.precio_costo, p.precio_venta,
  p.precio_mayoreo, p.cantidad_mayoreo, p.usa_inventario, p.activo`;
const ID_ARTICULO_COMUN = 0;
const TAMANO_LOTE = 150; // ids por consulta .in() para no pasar el límite de la URL

function numeroONulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function normalizar(p) {
  if (!p) return null;
  return {
    id: Number(p.id),
    codigo_barras: p.codigo_barras ? String(p.codigo_barras) : null,
    descripcion: p.descripcion || '',
    departamento: p.departamento || '',
    precio_costo: Number(p.precio_costo) || 0,
    precio_venta: Number(p.precio_venta) || 0,
    precio_mayoreo: numeroONulo(p.precio_mayoreo),
    cantidad_mayoreo: numeroONulo(p.cantidad_mayoreo),
    usa_inventario: p.usa_inventario === false || p.usa_inventario === 0 ? 0 : 1,
    activo: p.activo === false || p.activo === 0 ? 0 : 1,
  };
}

function lotes(lista, tamano = TAMANO_LOTE) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

// ---------- Copia local ----------
const upsertLocal = db.prepare(
  `INSERT INTO productos (id, codigo_barras, descripcion, departamento, precio_costo, precio_venta,
     precio_mayoreo, cantidad_mayoreo, usa_inventario, es_comun, activo)
   VALUES (@id, @codigo_barras, @descripcion, @departamento, @precio_costo, @precio_venta,
     @precio_mayoreo, @cantidad_mayoreo, @usa_inventario, 0, @activo)
   ON CONFLICT(id) DO UPDATE SET codigo_barras = excluded.codigo_barras, descripcion = excluded.descripcion,
     departamento = excluded.departamento, precio_costo = excluded.precio_costo,
     precio_venta = excluded.precio_venta, precio_mayoreo = excluded.precio_mayoreo,
     cantidad_mayoreo = excluded.cantidad_mayoreo, usa_inventario = excluded.usa_inventario,
     es_comun = 0, activo = excluded.activo`
);
const liberarCodigo = db.prepare('UPDATE productos SET codigo_barras = NULL WHERE codigo_barras = ? AND id <> ?');

// Refleja en SQLite productos que vienen de la central (mismo id)
const guardarLocal = db.transaction((productos) => {
  for (const crudo of productos || []) {
    const p = normalizar(crudo);
    if (!p || !p.id) continue; // el id 0 está reservado para el artículo común local
    if (p.codigo_barras) liberarCodigo.run(p.codigo_barras, p.id);
    upsertLocal.run(p);
  }
});

function buscarLocal(texto, limite, incluirInactivos) {
  const like = `%${texto}%`;
  return db
    .prepare(
      `SELECT ${CAMPOS_LOCAL} FROM productos p
       WHERE p.id <> ${ID_ARTICULO_COMUN} ${incluirInactivos ? '' : 'AND p.activo = 1'}
         AND (p.descripcion LIKE @like OR p.codigo_barras LIKE @like)
       ORDER BY (p.codigo_barras = @texto) DESC, p.descripcion
       LIMIT @limite`
    )
    .all({ like, texto, limite })
    .map(normalizar);
}

function porIdsLocal(ids, incluirInactivos) {
  const mapa = new Map();
  for (const lote of lotes(ids, 500)) {
    const filas = db
      .prepare(
        `SELECT ${CAMPOS_LOCAL} FROM productos p
         WHERE p.id IN (${lote.map(() => '?').join(',')}) ${incluirInactivos ? '' : 'AND p.activo = 1'}`
      )
      .all(...lote);
    for (const fila of filas) mapa.set(Number(fila.id), normalizar(fila));
  }
  return mapa;
}

// Valor para un filtro or() de PostgREST: entre comillas para admitir comas, puntos y paréntesis
function patronIlike(texto) {
  return `"*${texto.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}*"`;
}

// ---------- Lectura ----------
async function buscar({ q = '', limite = 50, incluirInactivos = false } = {}) {
  const texto = String(q || '').trim();
  if (modoCentral() && centralDisponible()) {
    try {
      let consulta = sb().from('productos').select(COLUMNAS_CENTRAL);
      if (!incluirInactivos) consulta = consulta.eq('activo', true);
      if (texto) {
        const patron = patronIlike(texto);
        consulta = consulta.or(`descripcion.ilike.${patron},codigo_barras.ilike.${patron}`);
      }
      const { data } = await consultar(consulta.order('descripcion').limit(limite));
      guardarLocal(data);
      const productos = (data || []).map(normalizar);
      // El código exacto primero (lo que se escaneó)
      productos.sort((a, b) => (b.codigo_barras === texto) - (a.codigo_barras === texto));
      return { productos, fuente: 'central' };
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  return { productos: buscarLocal(texto, limite, incluirInactivos), fuente: 'local' };
}

async function porCodigo(codigo) {
  const texto = String(codigo || '').trim();
  if (!texto) return null;
  if (modoCentral() && centralDisponible()) {
    try {
      const { data } = await consultar(
        sb().from('productos').select(COLUMNAS_CENTRAL).eq('codigo_barras', texto).eq('activo', true).limit(1)
      );
      guardarLocal(data);
      return data && data[0] ? normalizar(data[0]) : null;
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  const fila = db
    .prepare(`SELECT ${CAMPOS_LOCAL} FROM productos p WHERE p.codigo_barras = ? AND p.activo = 1 AND p.id <> 0`)
    .get(texto);
  return normalizar(fila);
}

// Productos por id (Map id -> producto). En modo central consulta la central y refresca la copia.
async function porIds(ids, { incluirInactivos = false } = {}) {
  const unicos = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (unicos.length === 0) return new Map();
  if (modoCentral() && centralDisponible()) {
    try {
      const mapa = new Map();
      for (const lote of lotes(unicos)) {
        let consulta = sb().from('productos').select(COLUMNAS_CENTRAL).in('id', lote);
        if (!incluirInactivos) consulta = consulta.eq('activo', true);
        const { data } = await consultar(consulta);
        guardarLocal(data);
        for (const fila of data || []) mapa.set(Number(fila.id), normalizar(fila));
      }
      return mapa;
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  return porIdsLocal(unicos, incluirInactivos);
}

async function porId(id, opciones = {}) {
  return (await porIds([id], opciones)).get(Number(id)) || null;
}

// Garantiza que existan en SQLite (por las llaves foráneas) los productos indicados.
// Devuelve los ids que siguen sin existir localmente.
async function asegurarLocales(ids) {
  const unicos = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const faltan = unicos.filter((id) => !db.prepare('SELECT 1 FROM productos WHERE id = ?').get(id));
  if (faltan.length && modoCentral()) {
    try {
      await porIds(faltan, { incluirInactivos: true });
    } catch (error) {
      if (!error.sinConexion) throw error;
    }
  }
  return unicos.filter((id) => !db.prepare('SELECT 1 FROM productos WHERE id = ?').get(id));
}

function articuloComun() {
  return db.prepare('SELECT * FROM productos WHERE id = ?').get(ID_ARTICULO_COMUN);
}

// ---------- Escritura ----------
function validar(body) {
  const descripcion = String(body.descripcion || '').trim();
  if (!descripcion) return { error: 'La descripción es obligatoria' };
  if (descripcion.length > 200) return { error: 'La descripción es demasiado larga (máximo 200 caracteres)' };
  const precioVenta = Number(body.precio_venta);
  if (body.precio_venta === '' || body.precio_venta === null || body.precio_venta === undefined
    || !Number.isFinite(precioVenta) || precioVenta < 0) {
    return { error: 'Precio de venta no válido' };
  }
  const precioCosto = body.precio_costo === '' || body.precio_costo == null ? 0 : Number(body.precio_costo);
  if (!Number.isFinite(precioCosto) || precioCosto < 0) return { error: 'Precio de costo no válido' };
  const precioMayoreo = numeroONulo(body.precio_mayoreo);
  if (precioMayoreo !== null && precioMayoreo < 0) return { error: 'Precio de mayoreo no válido' };
  const cantidadMayoreo = numeroONulo(body.cantidad_mayoreo);
  if (cantidadMayoreo !== null && cantidadMayoreo <= 0) return { error: 'La cantidad para mayoreo debe ser mayor a cero' };
  return {
    codigo_barras: String(body.codigo_barras || '').trim() || null,
    descripcion,
    departamento: String(body.departamento || '').trim(),
    precio_costo: Math.round(precioCosto * 100) / 100,
    precio_venta: Math.round(precioVenta * 100) / 100,
    precio_mayoreo: precioMayoreo === null ? null : Math.round(precioMayoreo * 100) / 100,
    cantidad_mayoreo: cantidadMayoreo,
    usa_inventario: body.usa_inventario === false || body.usa_inventario === 0 || body.usa_inventario === '0' ? 0 : 1,
  };
}

function errorCodigoDuplicado() {
  return new ErrorApp('Ya existe un producto con ese código de barras', { status: 400, codigo: 'CODIGO_DUPLICADO' });
}

function esDuplicado(error) {
  return /UNIQUE|duplicate key|unique constraint|23505/i.test(`${error.codigo || ''} ${error.message || ''}`);
}

function paraCentral(datos) {
  return { ...datos, usa_inventario: Boolean(datos.usa_inventario) };
}

async function crear(datos) {
  if (modoCentral()) {
    if (datos.codigo_barras) {
      const { data: existente } = await consultar(
        sb().from('productos').select('id').eq('codigo_barras', datos.codigo_barras).limit(1)
      );
      if (existente && existente.length) throw errorCodigoDuplicado();
    }
    try {
      const { data } = await consultar(
        sb().from('productos').insert({ ...paraCentral(datos), activo: true }).select(COLUMNAS_CENTRAL).single()
      );
      guardarLocal([data]);
      return normalizar(data);
    } catch (error) {
      if (esDuplicado(error)) throw errorCodigoDuplicado();
      throw error;
    }
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO productos (codigo_barras, descripcion, departamento, precio_costo, precio_venta,
           precio_mayoreo, cantidad_mayoreo, usa_inventario)
         VALUES (@codigo_barras, @descripcion, @departamento, @precio_costo, @precio_venta,
           @precio_mayoreo, @cantidad_mayoreo, @usa_inventario)`
      )
      .run(datos);
    return porIdsLocal([Number(info.lastInsertRowid)], true).get(Number(info.lastInsertRowid));
  } catch (error) {
    if (esDuplicado(error)) throw errorCodigoDuplicado();
    throw error;
  }
}

async function actualizar(id, datos) {
  const productoId = Number(id);
  if (!productoId) throw new ErrorApp('Producto no encontrado', { status: 404 });
  if (modoCentral()) {
    try {
      const { data } = await consultar(
        sb().from('productos')
          .update({ ...paraCentral(datos), updated_at: new Date().toISOString() })
          .eq('id', productoId).eq('activo', true)
          .select(COLUMNAS_CENTRAL)
      );
      if (!data || data.length === 0) throw new ErrorApp('Producto no encontrado', { status: 404 });
      guardarLocal(data);
      return normalizar(data[0]);
    } catch (error) {
      if (esDuplicado(error)) throw errorCodigoDuplicado();
      throw error;
    }
  }
  try {
    const info = db
      .prepare(
        `UPDATE productos SET codigo_barras = @codigo_barras, descripcion = @descripcion,
           departamento = @departamento, precio_costo = @precio_costo, precio_venta = @precio_venta,
           precio_mayoreo = @precio_mayoreo, cantidad_mayoreo = @cantidad_mayoreo,
           usa_inventario = @usa_inventario
         WHERE id = @id AND activo = 1 AND id <> 0`
      )
      .run({ ...datos, id: productoId });
    if (info.changes === 0) throw new ErrorApp('Producto no encontrado', { status: 404 });
    return porIdsLocal([productoId], true).get(productoId);
  } catch (error) {
    if (esDuplicado(error)) throw errorCodigoDuplicado();
    throw error;
  }
}

async function darDeBaja(id) {
  const productoId = Number(id);
  if (!productoId) throw new ErrorApp('Producto no encontrado', { status: 404 });
  if (modoCentral()) {
    const { data } = await consultar(
      sb().from('productos')
        .update({ activo: false, codigo_barras: null, updated_at: new Date().toISOString() })
        .eq('id', productoId)
        .select('id')
    );
    if (!data || data.length === 0) throw new ErrorApp('Producto no encontrado', { status: 404 });
  }
  const info = db.prepare('UPDATE productos SET activo = 0, codigo_barras = NULL WHERE id = ? AND id <> 0').run(productoId);
  if (!modoCentral() && info.changes === 0) throw new ErrorApp('Producto no encontrado', { status: 404 });
}

// Descarga todo el catálogo de la central a la copia local (al arrancar y cada cierto tiempo)
async function sincronizarCatalogoCompleto() {
  if (!modoCentral()) return { productos: 0 };
  const PAGINA = 1000;
  const ids = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data } = await consultar(
      sb().from('productos').select(COLUMNAS_CENTRAL).order('id').range(desde, desde + PAGINA - 1)
    );
    guardarLocal(data);
    for (const fila of data || []) ids.push(Number(fila.id));
    if (!data || data.length < PAGINA) break;
  }
  // Productos locales que ya no existen en la central (restos de versiones anteriores): fuera de venta
  db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS ids_central (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM ids_central');
    const insertar = db.prepare('INSERT OR IGNORE INTO ids_central (id) VALUES (?)');
    for (const id of ids) insertar.run(id);
    db.prepare(
      'UPDATE productos SET activo = 0 WHERE id <> 0 AND activo = 1 AND id NOT IN (SELECT id FROM ids_central)'
    ).run();
  })();
  return { productos: ids.length };
}

module.exports = {
  ID_ARTICULO_COMUN,
  normalizar,
  guardarLocal,
  buscar,
  porCodigo,
  porIds,
  porId,
  asegurarLocales,
  articuloComun,
  validar,
  crear,
  actualizar,
  darDeBaja,
  sincronizarCatalogoCompleto,
};
