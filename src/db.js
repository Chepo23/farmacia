const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword } = require('./passwords');

const db = new Database(path.join(__dirname, '..', 'farmacia.db'));
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
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  cliente_id INTEGER REFERENCES clientes(id),
  forma_pago TEXT NOT NULL CHECK (forma_pago IN ('efectivo', 'tarjeta', 'credito')),
  total REAL NOT NULL,
  pago REAL NOT NULL DEFAULT 0,
  cambio REAL NOT NULL DEFAULT 0,
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
`);

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
