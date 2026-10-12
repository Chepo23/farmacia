const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword } = require('./passwords');

// FARMACIA_DB permite abrir otra base (por ejemplo una copia para hacer pruebas)
const db = new Database(process.env.FARMACIA_DB || path.join(__dirname, '..', 'farmacia.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sucursales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  direccion TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  es_central INTEGER NOT NULL DEFAULT 0,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin', 'cajero')),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creada TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS departamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barras TEXT UNIQUE,
  descripcion TEXT NOT NULL,
  departamento TEXT DEFAULT '',
  precio_costo REAL NOT NULL DEFAULT 0,
  precio_venta REAL NOT NULL DEFAULT 0,
  precio_mayoreo REAL,
  cantidad_mayoreo REAL,
  usa_inventario INTEGER NOT NULL DEFAULT 1,
  es_comun INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventario (
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  existencia REAL NOT NULL DEFAULT 0,
  minimo REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (producto_id, sucursal_id)
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida', 'ajuste', 'venta')),
  cantidad REAL NOT NULL,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nota TEXT DEFAULT '',
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  telefono TEXT DEFAULT '',
  limite_credito REAL NOT NULL DEFAULT 0,
  notas TEXT DEFAULT '',
  credito_autorizado INTEGER NOT NULL DEFAULT 0,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS aperturas_caja (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fondo_caja REAL NOT NULL DEFAULT 0,
  tipo_cambio REAL NOT NULL DEFAULT 0,
  corte_id INTEGER REFERENCES cortes(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  cliente_id INTEGER REFERENCES clientes(id),
  forma_pago TEXT NOT NULL CHECK (forma_pago IN ('efectivo', 'tarjeta', 'credito', 'dolar', 'mixto')),
  total REAL NOT NULL,
  pago REAL NOT NULL DEFAULT 0,
  cambio REAL NOT NULL DEFAULT 0,
  pago_usd REAL,
  tipo_cambio REAL,
  pago_efectivo REAL,
  pago_tarjeta REAL,
  nota TEXT DEFAULT '',
  corte_id INTEGER,
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ventas_sucursal_fecha ON ventas(sucursal_id, fecha);

CREATE TABLE IF NOT EXISTS venta_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL,
  precio_unitario REAL NOT NULL,
  costo_unitario REAL NOT NULL DEFAULT 0,
  importe REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS abonos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  monto REAL NOT NULL,
  nota TEXT DEFAULT '',
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS cortes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  fondo_caja REAL NOT NULL DEFAULT 0,
  total_efectivo REAL NOT NULL DEFAULT 0,
  total_tarjeta REAL NOT NULL DEFAULT 0,
  total_credito REAL NOT NULL DEFAULT 0,
  num_ventas INTEGER NOT NULL DEFAULT 0,
  efectivo_contado REAL NOT NULL DEFAULT 0,
  diferencia REAL NOT NULL DEFAULT 0,
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------- Apoyos entre farmacias ----------
-- Pedido: lo que una sucursal le solicita a la central (sustituye la foto del cuaderno)
CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  estado TEXT NOT NULL DEFAULT 'borrador'
    CHECK (estado IN ('borrador', 'enviado', 'surtido', 'cancelado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  creado TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  enviado_por INTEGER REFERENCES usuarios(id),
  enviado TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado, sucursal_id);

CREATE TABLE IF NOT EXISTS pedido_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  codigo_barras TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL,
  cantidad_surtida REAL NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedido_detalle_producto
  ON pedido_detalle(pedido_id, producto_id);

-- Apoyo: la mercancía que la central le manda a una sucursal
CREATE TABLE IF NOT EXISTS apoyos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio INTEGER NOT NULL,
  origen_id INTEGER NOT NULL REFERENCES sucursales(id),
  destino_id INTEGER NOT NULL REFERENCES sucursales(id),
  pedido_id INTEGER REFERENCES pedidos(id),
  estado TEXT NOT NULL DEFAULT 'borrador'
    CHECK (estado IN ('borrador', 'enviado', 'recibido', 'cancelado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  creado TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  enviado_por INTEGER REFERENCES usuarios(id),
  enviado TEXT,
  recibido_por INTEGER REFERENCES usuarios(id),
  recibido TEXT,
  cancelado_por INTEGER REFERENCES usuarios(id),
  cancelado TEXT,
  motivo_cancelacion TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apoyos_destino ON apoyos(destino_id, estado);
CREATE INDEX IF NOT EXISTS idx_apoyos_origen ON apoyos(origen_id, estado);

-- Los precios se guardan como copia: si mañana cambia el catálogo,
-- el apoyo sigue mostrando con qué precios se mandó la mercancía
CREATE TABLE IF NOT EXISTS apoyo_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apoyo_id INTEGER NOT NULL REFERENCES apoyos(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  codigo_barras TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL,
  cantidad_recibida REAL,
  precio_costo REAL NOT NULL DEFAULT 0,
  precio_venta REAL NOT NULL DEFAULT 0,
  precio_mayoreo REAL,
  importe REAL NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apoyo_detalle_producto
  ON apoyo_detalle(apoyo_id, producto_id);

-- ---------- Inventario compartido / sincronización ----------
CREATE TABLE IF NOT EXISTS sync_estado (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  accion TEXT NOT NULL CHECK (accion IN ('create', 'update', 'delete')),
  payload TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'sincronizado', 'conflicto')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sync_estado_entidad ON sync_estado(entidad, estado, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_estado_sucursal ON sync_estado(sucursal_id, estado);

CREATE TABLE IF NOT EXISTS sync_resumen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  ultima_sync TEXT,
  ultimo_evento_id INTEGER,
  estado TEXT NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'pendiente', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_resumen_sucursal ON sync_resumen(sucursal_id);

CREATE TABLE IF NOT EXISTS sync_conflictos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  detalle TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'resuelto')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Mini apoyo: cuando una sucursal tiene un producto que la central no tiene o no tiene suficiente.
CREATE TABLE IF NOT EXISTS mini_apoyos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origen_sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  destino_sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad REAL NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('faltante', 'redistribucion', 'apoyo', 'reconciliacion')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aceptado', 'enviado', 'recibido', 'rechazado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER NOT NULL REFERENCES usuarios(id),
  creado TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mini_apoyos_origen ON mini_apoyos(origen_sucursal_id, estado);
CREATE INDEX IF NOT EXISTS idx_mini_apoyos_destino ON mini_apoyos(destino_sucursal_id, estado);

CREATE TABLE IF NOT EXISTS sync_config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL DEFAULT ''
);

-- Cola de movimientos de inventario que no se pudieron aplicar en la central (sin internet).
-- estado 'delta': falta aplicar la cantidad en la central y registrar el movimiento.
-- estado 'movimiento': la existencia ya se aplicó en la central, solo falta registrar el movimiento.
-- estado 'error': se intentó demasiadas veces; requiere revisión.
CREATE TABLE IF NOT EXISTS inventario_pendiente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  cantidad REAL NOT NULL,
  delta REAL NOT NULL DEFAULT 0,
  usuario_id INTEGER,
  nota TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'delta' CHECK (estado IN ('delta', 'movimiento', 'error')),
  existencia_resultante REAL,
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_inventario_pendiente ON inventario_pendiente(estado, producto_id, sucursal_id);

-- Entradas y salidas de efectivo de la caja que no son ventas (pago a proveedor, retiro, cambio)
CREATE TABLE IF NOT EXISTS movimientos_caja (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  monto REAL NOT NULL,
  concepto TEXT NOT NULL DEFAULT '',
  corte_id INTEGER REFERENCES cortes(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja ON movimientos_caja(sucursal_id, corte_id);
`);

// Reconstruir la tabla ventas si fue creada con el CHECK viejo de formas de pago
// (SQLite no permite modificar un CHECK con ALTER TABLE). Va antes de agregar columnas
// nuevas para que la reconstrucción no las borre.
const defVentas = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ventas'")
  .get().sql;
if (!defVentas.includes('mixto')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE ventas_nueva (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folio INTEGER NOT NULL,
      sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      cliente_id INTEGER REFERENCES clientes(id),
      forma_pago TEXT NOT NULL CHECK (forma_pago IN ('efectivo', 'tarjeta', 'credito', 'dolar', 'mixto')),
      total REAL NOT NULL,
      pago REAL NOT NULL DEFAULT 0,
      cambio REAL NOT NULL DEFAULT 0,
      pago_usd REAL,
      tipo_cambio REAL,
      pago_efectivo REAL,
      pago_tarjeta REAL,
      nota TEXT DEFAULT '',
      corte_id INTEGER,
      fecha TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    INSERT INTO ventas_nueva (id, folio, sucursal_id, usuario_id, cliente_id, forma_pago, total, pago, cambio, corte_id, fecha)
      SELECT id, folio, sucursal_id, usuario_id, cliente_id, forma_pago, total, pago, cambio, corte_id, fecha FROM ventas;
    DROP TABLE ventas;
    ALTER TABLE ventas_nueva RENAME TO ventas;
    CREATE INDEX IF NOT EXISTS idx_ventas_sucursal_fecha ON ventas(sucursal_id, fecha);
    COMMIT;
  `);
  db.pragma('foreign_keys = ON');
}

function columnasDe(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}

// Agrega la columna si no existe; devuelve true cuando la acaba de crear
function agregarColumna(tabla, columna, definicion) {
  if (columnasDe(tabla).includes(columna)) return false;
  db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  return true;
}

// Migraciones para bases de datos creadas antes de estas columnas
agregarColumna('clientes', 'notas', "TEXT DEFAULT ''");
agregarColumna('clientes', 'credito_autorizado', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('sesiones', 'apertura_id', 'INTEGER REFERENCES aperturas_caja(id)');
agregarColumna('productos', 'es_comun', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('cortes', 'total_dolares', 'REAL NOT NULL DEFAULT 0');
agregarColumna('apoyos', 'cancelado_por', 'INTEGER REFERENCES usuarios(id)');
agregarColumna('apoyos', 'cancelado', 'TEXT');
agregarColumna('apoyos', 'motivo_cancelacion', "TEXT DEFAULT ''");

// Sesiones con vencimiento por inactividad
agregarColumna('sesiones', 'ultimo_uso', 'TEXT');

// Kardex: existencia que quedó después de cada movimiento
agregarColumna('movimientos_inventario', 'existencia_resultante', 'REAL');

// Si el renglón descontó inventario al venderse (para regresarlo igual al cancelar)
agregarColumna('venta_detalle', 'descuenta_inventario', 'INTEGER');
// Precio normal del producto al momento de la venta (para mostrar el ahorro por mayoreo)
agregarColumna('venta_detalle', 'precio_lista', 'REAL');

// Cancelación de ventas (solo ventas que todavía no entran a un corte)
agregarColumna('ventas', 'cancelada', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('ventas', 'cancelada_por', 'INTEGER REFERENCES usuarios(id)');
agregarColumna('ventas', 'cancelada_fecha', 'TEXT');
agregarColumna('ventas', 'motivo_cancelacion', "TEXT DEFAULT ''");

// Abonos: forma de pago, saldo antes/después (para el comprobante) y corte al que pertenecen
agregarColumna('abonos', 'forma_pago', "TEXT NOT NULL DEFAULT 'efectivo'");
agregarColumna('abonos', 'saldo_anterior', 'REAL');
agregarColumna('abonos', 'saldo_nuevo', 'REAL');
if (agregarColumna('abonos', 'corte_id', 'INTEGER REFERENCES cortes(id)')) {
  // Antes los abonos se ligaban al corte por fecha: se asigna cada abono al primer corte posterior
  db.exec(`UPDATE abonos SET corte_id = (
             SELECT c.id FROM cortes c
             WHERE c.sucursal_id = abonos.sucursal_id AND c.fecha >= abonos.fecha
             ORDER BY c.fecha, c.id LIMIT 1)
           WHERE corte_id IS NULL`);
}

// Corte de caja completo: efectivo contado contra esperado, dólares, entradas/salidas y cancelaciones
agregarColumna('cortes', 'total_abonos', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'abonos_tarjeta', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'total_usd', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'cambio_dolares', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'entradas_efectivo', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'salidas_efectivo', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'efectivo_esperado', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'usd_contado', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'num_canceladas', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('cortes', 'total_canceladas', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'tipo_cambio', 'REAL NOT NULL DEFAULT 0');
agregarColumna('cortes', 'nota', "TEXT DEFAULT ''");

// Apoyos y pedidos descargados antes con fechas de la central en UTC ('2026-09-12T18:26:55+00:00'):
// se pasan a hora local 'AAAA-MM-DD HH:MM:SS' como el resto del sistema
for (const [tabla, columnas] of [
  ['apoyos', ['creado', 'enviado', 'recibido', 'cancelado']],
  ['pedidos', ['creado', 'enviado']],
]) {
  for (const columna of columnas) {
    db.prepare(
      `UPDATE ${tabla} SET ${columna} = COALESCE(datetime(${columna}, 'localtime'), ${columna})
       WHERE ${columna} LIKE '____-__-__T%'`
    ).run();
  }
}

for (const indice of [
  'CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos_inventario(producto_id, sucursal_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_venta_detalle_venta ON venta_detalle(venta_id)',
  'CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id, forma_pago)',
  'CREATE INDEX IF NOT EXISTS idx_ventas_corte ON ventas(sucursal_id, corte_id)',
  'CREATE INDEX IF NOT EXISTS idx_abonos_cliente ON abonos(cliente_id)',
  'CREATE INDEX IF NOT EXISTS idx_abonos_corte ON abonos(sucursal_id, corte_id)',
  'CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id)',
]) {
  db.exec(indice);
}

// Las bases locales antiguas podían guardar la sucursal directamente en productos.
// Conserva esa asignación como una fila de inventario antes de dejar de usarla.
const columnasProducto = db.prepare('PRAGMA table_info(productos)').all().map((columna) => columna.name);
if (columnasProducto.includes('sucursal_id')) {
  db.prepare("INSERT OR REPLACE INTO sync_config (clave, valor) VALUES ('aplicando', '1')").run();
  try {
    db.prepare(
      `INSERT INTO inventario (producto_id, sucursal_id, existencia, minimo)
       SELECT id, sucursal_id, 0, 0 FROM productos
       WHERE sucursal_id IS NOT NULL
       ON CONFLICT(producto_id, sucursal_id) DO NOTHING`
    ).run();
  } finally {
    db.prepare("DELETE FROM sync_config WHERE clave = 'aplicando'").run();
  }
}

// Estos triggers pertenecen al sincronizador SQLite anterior y generan claves
// invalidas o duplicadas al reflejar datos desde Supabase.
for (const trigger of [
  'sync_inventario_alta',
  'sync_inventario_cambio',
  'sync_producto_alta',
  'sync_producto_cambio',
  'sync_sucursal_alta',
  'sync_sucursal_cambio',
]) {
  db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

// El "Artículo común" (algo que se vende sin estar en el catálogo) vive solo en esta
// computadora con el id reservado 0, para que nunca choque con los ids de la central.
function asegurarArticuloComun() {
  db.transaction(() => {
    const existe = db.prepare('SELECT id FROM productos WHERE id = 0').get();
    if (existe) {
      db.prepare(
        `UPDATE productos SET codigo_barras = NULL, descripcion = 'Artículo común', usa_inventario = 0,
           es_comun = 1, activo = 1 WHERE id = 0`
      ).run();
    } else {
      db.prepare(
        `INSERT INTO productos (id, codigo_barras, descripcion, departamento, precio_costo, precio_venta,
           usa_inventario, es_comun, activo)
         VALUES (0, NULL, 'Artículo común', '', 0, 0, 0, 1, 1)`
      ).run();
    }
    // Ventas de artículos comunes colgadas de un producto genérico anterior
    const anteriores = db
      .prepare(
        `SELECT id FROM productos
         WHERE id <> 0 AND es_comun = 1 AND codigo_barras IS NULL AND descripcion = 'Artículo común'`
      )
      .all();
    for (const anterior of anteriores) {
      db.prepare('UPDATE venta_detalle SET producto_id = 0 WHERE producto_id = ?').run(anterior.id);
      db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(anterior.id);
    }
    // Ningún producto del catálogo es "común": esa marca llegó por error con los productos de ejemplo
    db.prepare('UPDATE productos SET es_comun = 0 WHERE id <> 0 AND es_comun = 1').run();
  })();
}

asegurarArticuloComun();

function seed() {
  const haySucursales = db.prepare('SELECT COUNT(*) AS n FROM sucursales').get().n;
  if (haySucursales > 0) return;

  const insSucursal = db.prepare(
    'INSERT INTO sucursales (nombre, es_central) VALUES (?, ?)'
  );
  const central = insSucursal.run('Farmacia Central', 1).lastInsertRowid;
  insSucursal.run('Farmacia Sucursal 2', 0);
  insSucursal.run('Farmacia Sucursal 3', 0);

  db.prepare(
    'INSERT INTO usuarios (nombre, usuario, password_hash, rol, sucursal_id) VALUES (?, ?, ?, ?, ?)'
  ).run('Administrador', 'admin', hashPassword('admin'), 'admin', central);
}

seed();

module.exports = db;
