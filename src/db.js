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
`);

// Migraciones para bases de datos creadas antes de estas columnas
for (const columna of [
  "ALTER TABLE clientes ADD COLUMN notas TEXT DEFAULT ''",
  'ALTER TABLE clientes ADD COLUMN credito_autorizado INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sesiones ADD COLUMN apertura_id INTEGER REFERENCES aperturas_caja(id)',
  'ALTER TABLE productos ADD COLUMN es_comun INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE cortes ADD COLUMN total_dolares REAL NOT NULL DEFAULT 0',
  "ALTER TABLE apoyos ADD COLUMN cancelado_por INTEGER REFERENCES usuarios(id)",
  "ALTER TABLE apoyos ADD COLUMN cancelado TEXT",
  "ALTER TABLE apoyos ADD COLUMN motivo_cancelacion TEXT DEFAULT ''",
]) {
  try { db.exec(columna); } catch { /* la columna ya existe */ }
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

// Reconstruir la tabla ventas si fue creada con el CHECK viejo de formas de pago
// (SQLite no permite modificar un CHECK con ALTER TABLE)
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
