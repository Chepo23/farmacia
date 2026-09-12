-- ========================================================
-- Supabase / PostgreSQL schema para la farmacia central
-- ========================================================
-- Este esquema reemplaza la base local como autoridad del inventario
-- compartido entre sucursales.

create extension if not exists pgcrypto;

create table if not exists public.sucursales (
  id bigserial primary key,
  nombre text not null,
  direccion text default '',
  telefono text default '',
  es_central boolean not null default false,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.productos (
  id bigserial primary key,
  codigo_barras text unique,
  descripcion text not null,
  departamento text default '',
  precio_costo numeric(12,2) not null default 0,
  precio_venta numeric(12,2) not null default 0,
  precio_mayoreo numeric(12,2),
  cantidad_mayoreo numeric(12,2),
  usa_inventario boolean not null default true,
  es_comun boolean not null default false,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventario (
  id bigserial primary key,
  producto_id bigint not null references public.productos(id) on delete cascade,
  sucursal_id bigint not null references public.sucursales(id) on delete cascade,
  existencia numeric(12,2) not null default 0,
  minimo numeric(12,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (producto_id, sucursal_id)
);

create table if not exists public.movimientos_inventario (
  id bigserial primary key,
  producto_id bigint not null references public.productos(id) on delete cascade,
  sucursal_id bigint not null references public.sucursales(id) on delete cascade,
  tipo text not null check (tipo in ('entrada', 'salida', 'ajuste', 'venta')),
  cantidad numeric(12,2) not null,
  usuario_id bigint,
  nota text default '',
  fecha timestamptz not null default now()
);

create table if not exists public.pedidos (
  id bigserial primary key,
  folio integer not null,
  sucursal_id bigint not null references public.sucursales(id),
  estado text not null default 'borrador' check (estado in ('borrador', 'enviado', 'surtido', 'cancelado')),
  nota text default '',
  creado_por bigint,
  creado timestamptz not null default now(),
  enviado_por bigint,
  enviado timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.pedido_detalle (
  id bigserial primary key,
  pedido_id bigint not null references public.pedidos(id) on delete cascade,
  producto_id bigint not null references public.productos(id) on delete cascade,
  codigo_barras text,
  descripcion text not null,
  cantidad numeric(12,2) not null,
  cantidad_surtida numeric(12,2) not null default 0,
  unique (pedido_id, producto_id)
);

create table if not exists public.apoyos (
  id bigserial primary key,
  folio integer not null,
  origen_id bigint not null references public.sucursales(id),
  destino_id bigint not null references public.sucursales(id),
  pedido_id bigint references public.pedidos(id),
  estado text not null default 'borrador' check (estado in ('borrador', 'enviado', 'recibido', 'cancelado')),
  nota text default '',
  creado_por bigint,
  creado timestamptz not null default now(),
  enviado_por bigint,
  enviado timestamptz,
  recibido_por bigint,
  recibido timestamptz,
  cancelado_por bigint,
  cancelado timestamptz,
  motivo_cancelacion text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.apoyo_detalle (
  id bigserial primary key,
  apoyo_id bigint not null references public.apoyos(id) on delete cascade,
  producto_id bigint not null references public.productos(id) on delete cascade,
  codigo_barras text,
  descripcion text not null,
  cantidad numeric(12,2) not null,
  cantidad_recibida numeric(12,2),
  precio_costo numeric(12,2) not null default 0,
  precio_venta numeric(12,2) not null default 0,
  precio_mayoreo numeric(12,2),
  importe numeric(12,2) not null default 0,
  unique (apoyo_id, producto_id)
);

create table if not exists public.mini_apoyos (
  id bigserial primary key,
  origen_sucursal_id bigint not null references public.sucursales(id),
  destino_sucursal_id bigint not null references public.sucursales(id),
  producto_id bigint not null references public.productos(id),
  cantidad numeric(12,2) not null default 0,
  tipo text not null check (tipo in ('faltante', 'redistribucion', 'apoyo', 'reconciliacion')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aceptado', 'enviado', 'recibido', 'rechazado')),
  nota text default '',
  creado_por bigint,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

create table if not exists public.sync_estado (
  id bigserial primary key,
  entidad text not null,
  entidad_id bigint not null,
  sucursal_id bigint not null references public.sucursales(id),
  accion text not null check (accion in ('create', 'update', 'delete')),
  payload jsonb not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'sincronizado', 'conflicto')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_conflictos (
  id bigserial primary key,
  entidad text not null,
  entidad_id bigint not null,
  sucursal_id bigint not null references public.sucursales(id),
  detalle text not null,
  estado text not null default 'abierto' check (estado in ('abierto', 'resuelto')),
  created_at timestamptz not null default now()
);

create table if not exists public.sync_resumen (
  id bigserial primary key,
  sucursal_id bigint not null references public.sucursales(id),
  ultima_sync timestamptz,
  ultimo_evento_id bigint,
  estado text not null default 'ok' check (estado in ('ok', 'pendiente', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sucursal_id)
);

create index if not exists idx_productos_descripcion on public.productos (descripcion);
create index if not exists idx_inventario_sucursal on public.inventario (sucursal_id, producto_id);
create index if not exists idx_mini_apoyos_estado on public.mini_apoyos (estado, destino_sucursal_id);
create index if not exists idx_sync_estado_estado on public.sync_estado (entidad, estado, updated_at);

create table if not exists public.departamentos (
  id bigserial primary key,
  nombre text not null unique,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_departamentos_activo_nombre
  on public.departamentos (activo, nombre);

-- Tabla central de usuarios alineada con el esquema real: solo sincronizamos
-- los campos que de verdad existen en Supabase para evitar errores de esquema.
create table if not exists public.usuarios_central (
  id bigserial primary key,
  nombre text not null,
  usuario text not null unique,
  password_hash text not null,
  rol text not null default 'admin' check (rol in ('admin', 'cajero')),
  sucursal_id bigint not null references public.sucursales(id),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.usuarios_central
  add column if not exists password_hash text;
alter table public.usuarios_central
  add column if not exists sucursal_id bigint references public.sucursales(id);
alter table public.usuarios_central
  add column if not exists updated_at timestamptz not null default now();

-- ejemplo inicial de sucursal central
insert into public.sucursales (nombre, direccion, telefono, es_central, activa)
values ('Central', 'Oficina central', '', true, true)
on conflict do nothing;

-- Migracion de productos por sucursal a inventario por sucursal.
-- Ejecutar antes de eliminar la columna legacy si ya existia en Supabase.
alter table public.productos
  add column if not exists sucursal_id bigint references public.sucursales(id);

insert into public.inventario (producto_id, sucursal_id, existencia, minimo)
select id, sucursal_id, 0, 0
from public.productos
where sucursal_id is not null
on conflict (producto_id, sucursal_id) do nothing;

drop index if exists public.idx_productos_sucursal;
alter table public.productos drop column if exists sucursal_id;
