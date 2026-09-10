-- Esquema base para sincronización offline-first
-- Este archivo no reemplaza a la estructura actual, solo complementa la lógica de inventario compartido.

CREATE TABLE IF NOT EXISTS sync_estado (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  sucursal_id INTEGER NOT NULL,
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
  sucursal_id INTEGER NOT NULL,
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
  sucursal_id INTEGER NOT NULL,
  detalle TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'resuelto')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Recomendación de uso:
-- - cada sucursal escribe a sync_estado con los cambios que deben subirse,
-- - la central consume esos cambios y actualiza stock/estado de sincronización,
-- - cualquier conflicto se registra en sync_conflictos,
-- - la actualización se marca en sync_resumen para seguimiento.
