-- Esquema recomendado para la farmacia central en PostgreSQL
-- Reemplaza la idea de una sola base local y sirve como autoridad del inventario compartido.

CREATE TABLE IF NOT EXISTS sucursales (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  direccion TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  es_central BOOLEAN NOT NULL DEFAULT FALSE,
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS productos (
  id SERIAL PRIMARY KEY,
  codigo_barras TEXT UNIQUE,
  descripcion TEXT NOT NULL,
  departamento TEXT DEFAULT '',
  precio_costo NUMERIC(12,2) NOT NULL DEFAULT 0,
  precio_venta NUMERIC(12,2) NOT NULL DEFAULT 0,
  precio_mayoreo NUMERIC(12,2),
  cantidad_mayoreo NUMERIC(12,2),
  usa_inventario BOOLEAN NOT NULL DEFAULT TRUE,
  es_comun BOOLEAN NOT NULL DEFAULT FALSE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventario (
  id SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  existencia NUMERIC(12,2) NOT NULL DEFAULT 0,
  minimo NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(producto_id, sucursal_id)
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'salida', 'ajuste', 'venta')),
  cantidad NUMERIC(12,2) NOT NULL,
  usuario_id INTEGER,
  nota TEXT DEFAULT '',
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  folio INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviado', 'surtido', 'cancelado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER,
  creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_por INTEGER,
  enviado TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedido_detalle (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  codigo_barras TEXT,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(12,2) NOT NULL,
  cantidad_surtida NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE(pedido_id, producto_id)
);

CREATE TABLE IF NOT EXISTS apoyos (
  id SERIAL PRIMARY KEY,
  folio INTEGER NOT NULL,
  origen_id INTEGER NOT NULL REFERENCES sucursales(id),
  destino_id INTEGER NOT NULL REFERENCES sucursales(id),
  pedido_id INTEGER REFERENCES pedidos(id),
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviado', 'recibido', 'cancelado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER,
  creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enviado_por INTEGER,
  enviado TIMESTAMPTZ,
  recibido_por INTEGER,
  recibido TIMESTAMPTZ,
  cancelado_por INTEGER,
  cancelado TIMESTAMPTZ,
  motivo_cancelacion TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS apoyo_detalle (
  id SERIAL PRIMARY KEY,
  apoyo_id INTEGER NOT NULL REFERENCES apoyos(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  codigo_barras TEXT,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(12,2) NOT NULL,
  cantidad_recibida NUMERIC(12,2),
  precio_costo NUMERIC(12,2) NOT NULL DEFAULT 0,
  precio_venta NUMERIC(12,2) NOT NULL DEFAULT 0,
  precio_mayoreo NUMERIC(12,2),
  importe NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE(apoyo_id, producto_id)
);

CREATE TABLE IF NOT EXISTS mini_apoyos (
  id SERIAL PRIMARY KEY,
  origen_sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  destino_sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad NUMERIC(12,2) NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('faltante', 'redistribucion', 'apoyo', 'reconciliacion')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aceptado', 'enviado', 'recibido', 'rechazado')),
  nota TEXT DEFAULT '',
  creado_por INTEGER,
  creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_estado (
  id SERIAL PRIMARY KEY,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  accion TEXT NOT NULL CHECK (accion IN ('create', 'update', 'delete')),
  payload JSONB NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'sincronizado', 'conflicto')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_conflictos (
  id SERIAL PRIMARY KEY,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  detalle TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'resuelto')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_resumen (
  id SERIAL PRIMARY KEY,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  ultima_sync TIMESTAMPTZ,
  ultimo_evento_id INTEGER,
  estado TEXT NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'pendiente', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sucursal_id)
);

CREATE INDEX IF NOT EXISTS idx_productos_descripcion ON productos(descripcion);
CREATE INDEX IF NOT EXISTS idx_inventario_sucursal ON inventario(sucursal_id, producto_id);
CREATE INDEX IF NOT EXISTS idx_mini_apoyos_estado ON mini_apoyos(estado, destino_sucursal_id);
CREATE INDEX IF NOT EXISTS idx_sync_estado_estado ON sync_estado(entidad, estado, updated_at);
