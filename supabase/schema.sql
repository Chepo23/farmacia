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

create index if not exists idx_productos_descripcion on public.productos (descripcion);
create index if not exists idx_inventario_sucursal on public.inventario (sucursal_id, producto_id);

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

-- Sucursal central inicial: solo si la base está vacía (antes se duplicaba cada vez que se ejecutaba)
insert into public.sucursales (nombre, direccion, telefono, es_central, activa)
select 'Central', 'Oficina central', '', true, true
where not exists (select 1 from public.sucursales);

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

-- ========================================================
-- Inventario unificado (octubre 2026). Se puede ejecutar varias veces.
-- ========================================================

-- Kardex: existencia que quedó después de cada movimiento
-- (la app funciona sin esta columna, pero con ella el historial muestra el saldo)
alter table public.movimientos_inventario
  add column if not exists existencia_resultante numeric(12,2);
create index if not exists idx_movimientos_producto
  on public.movimientos_inventario (producto_id, sucursal_id, id);

-- Los productos de ejemplo se sembraron marcados como "artículo común" por error.
-- El artículo común solo existe en cada computadora; en la central ningún producto lo es.
update public.productos set es_comun = false where es_comun = true;

-- Versiones anteriores subían apoyos y pedidos con el id de cada computadora, así que los
-- contadores de ids quedaron atrás. Esto los pone al día (la app también lo resuelve sola).
select setval(pg_get_serial_sequence('public.pedidos', 'id'), coalesce((select max(id) from public.pedidos), 0) + 1, false);
select setval(pg_get_serial_sequence('public.pedido_detalle', 'id'), coalesce((select max(id) from public.pedido_detalle), 0) + 1, false);
select setval(pg_get_serial_sequence('public.apoyos', 'id'), coalesce((select max(id) from public.apoyos), 0) + 1, false);
select setval(pg_get_serial_sequence('public.apoyo_detalle', 'id'), coalesce((select max(id) from public.apoyo_detalle), 0) + 1, false);

-- ========================================================
-- App del celular (vinculación por código y sesiones de larga duración)
-- Solo las usa la función "movil" con la llave secreta; los celulares nunca leen estas tablas.
-- ========================================================
create table if not exists public.vinculos_movil (
  id bigserial primary key,
  codigo_hash text not null unique,          -- SHA-256 del código; el código nunca se guarda
  usuario_id bigint not null references public.usuarios_central(id) on delete cascade,
  creado_por bigint,
  expira timestamptz not null,
  usado timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sesiones_movil (
  id bigserial primary key,
  token_hash text not null unique,           -- SHA-256 del token que guarda el celular
  usuario_id bigint not null references public.usuarios_central(id) on delete cascade,
  dispositivo text not null default '',
  creada timestamptz not null default now(),
  ultimo_uso timestamptz not null default now(),
  revocada timestamptz
);
create index if not exists idx_sesiones_movil_usuario on public.sesiones_movil (usuario_id);

-- ========================================================
-- Cotizaciones (octubre 2026): el administrador de la central las arma desde el celular y las
-- manda a una sucursal (o a un usuario de esa sucursal) para que ahí se cobre la venta.
-- El precio cotizado se respeta hasta "vigente_hasta" (7 días).
-- ========================================================
create table if not exists public.cotizaciones (
  id bigserial primary key,
  folio bigint not null unique,
  creado_por bigint not null references public.usuarios_central(id),
  origen_sucursal_id bigint not null references public.sucursales(id),
  destino_sucursal_id bigint not null references public.sucursales(id),
  destino_usuario_id bigint references public.usuarios_central(id),
  cliente text not null default '',
  nota text not null default '',
  estado text not null default 'enviada' check (estado in ('enviada', 'vendida', 'cancelada')),
  total numeric(12,2) not null default 0,
  vigente_hasta timestamptz not null,
  creado timestamptz not null default now(),
  vendida_por bigint,
  vendida_fecha timestamptz,
  vendida_folio bigint,
  cancelada_por bigint,
  cancelada_fecha timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_cotizaciones_destino on public.cotizaciones (destino_sucursal_id, estado);

create table if not exists public.cotizacion_detalle (
  id bigserial primary key,
  cotizacion_id bigint not null references public.cotizaciones(id) on delete cascade,
  producto_id bigint not null references public.productos(id),
  codigo_barras text,
  descripcion text not null,
  cantidad numeric(12,2) not null,
  precio_unitario numeric(12,2) not null,
  precio_lista numeric(12,2) not null default 0,
  importe numeric(12,2) not null default 0
);
create index if not exists idx_cotizacion_detalle on public.cotizacion_detalle (cotizacion_id);

-- ========================================================
-- Jefe, registro de cambios e inventario del día (noviembre 2026)
-- ========================================================
-- Jefe: administrador de la central que además ve los movimientos, los cambios y el inventario de
-- todas las sucursales, y autoriza las diferencias del inventario del día. Una cuenta por persona.
alter table public.usuarios_central
  add column if not exists jefe boolean not null default false;

-- Registro de cambios: quién cambió qué y cuándo (precios, altas, usuarios, cancelaciones, cortes,
-- salidas de efectivo, apoyos, conteos). Lo escriben las computadoras y la función del celular;
-- solo los jefes lo ven. "clave" la pone quien registra, así un reintento no lo duplica.
create table if not exists public.bitacora (
  id bigserial primary key,
  clave text not null unique,
  fecha timestamptz not null default now(),
  sucursal_id bigint,
  usuario_id bigint,
  tipo text not null,
  descripcion text not null default '',
  detalle jsonb,
  alerta boolean not null default false,
  origen text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_bitacora_fecha on public.bitacora (fecha desc);
create index if not exists idx_bitacora_sucursal on public.bitacora (sucursal_id, fecha desc);

-- Inventario del día: cada día el sistema arma una lista corta por sucursal, se cuenta con el
-- celular sin ver lo que dice el sistema y el jefe autoriza las diferencias.
create table if not exists public.conteos (
  id bigserial primary key,
  sucursal_id bigint not null references public.sucursales(id),
  fecha date not null,
  estado text not null default 'abierto' check (estado in ('abierto', 'por_autorizar', 'cerrado', 'cancelado')),
  productos integer not null default 0,
  contados integer not null default 0,
  sin_diferencia integer not null default 0,
  nota text not null default '',
  creado timestamptz not null default now(),
  terminado timestamptz,
  terminado_por bigint,
  cerrado timestamptz,
  cerrado_por bigint,
  updated_at timestamptz not null default now(),
  unique (sucursal_id, fecha)
);
create index if not exists idx_conteos_estado on public.conteos (estado, fecha);

create table if not exists public.conteo_detalle (
  id bigserial primary key,
  conteo_id bigint not null references public.conteos(id) on delete cascade,
  sucursal_id bigint not null references public.sucursales(id),
  producto_id bigint not null references public.productos(id) on delete cascade,
  codigo_barras text,
  descripcion text not null,
  departamento text not null default '',
  orden integer not null default 0,
  razon text not null default '',
  costo numeric(12,2) not null default 0,
  existencia_sistema numeric(12,2),
  primer_conteo numeric(12,2),
  contado numeric(12,2),
  diferencia numeric(12,2),
  reconteos integer not null default 0,
  motivo text not null default '',
  contado_por bigint,
  contado_fecha timestamptz,
  decision text not null default 'pendiente' check (decision in ('pendiente', 'cuadra', 'aprobado', 'rechazado', 'no_contado')),
  decidido_por bigint,
  decidido timestamptz,
  unique (conteo_id, producto_id)
);
create index if not exists idx_conteo_detalle_conteo on public.conteo_detalle (conteo_id, orden);

-- Cuándo se contó por última vez cada producto en cada sucursal (para armar la lista del día)
create table if not exists public.conteo_ultimos (
  sucursal_id bigint not null references public.sucursales(id) on delete cascade,
  producto_id bigint not null references public.productos(id) on delete cascade,
  contado timestamptz not null,
  diferencia numeric(12,2) not null default 0,
  primary key (sucursal_id, producto_id)
);

-- Cuántos productos se cuentan al día en cada sucursal (sin fila: 40)
create table if not exists public.conteo_config (
  sucursal_id bigint primary key references public.sucursales(id) on delete cascade,
  productos_por_dia integer not null default 40 check (productos_por_dia between 5 and 500),
  updated_at timestamptz not null default now()
);

-- Productos que el jefe marca como importantes (controlados, antibióticos, los más caros): se cuentan seguido
create table if not exists public.conteo_importantes (
  producto_id bigint primary key references public.productos(id) on delete cascade,
  creado_por bigint,
  creado timestamptz not null default now()
);

-- ========================================================
-- Ventas en la central (noviembre 2026): cada computadora (caja) cobra con su propia base, aunque
-- no haya internet, y sube sola sus ventas, cortes, clientes con crédito y abonos para que el jefe
-- vea todas las farmacias. "clave" = clave de la caja + id en esa computadora: subir dos veces no duplica.
-- ========================================================
create table if not exists public.cajas (
  id bigserial primary key,
  clave text not null unique,
  sucursal_id bigint not null references public.sucursales(id),
  numero integer not null default 1,
  nombre text not null default '',
  creada timestamptz not null default now(),
  ultima_subida timestamptz
);

create table if not exists public.ventas (
  id bigserial primary key,
  clave text not null unique,
  caja_id bigint not null references public.cajas(id),
  sucursal_id bigint not null references public.sucursales(id),
  venta_local_id bigint not null,
  folio integer not null,
  usuario_id bigint,
  cliente_clave text,
  cliente_nombre text not null default '',
  forma_pago text not null,
  total numeric(12,2) not null default 0,
  costo numeric(12,2) not null default 0,
  piezas numeric(12,3) not null default 0,
  pago numeric(12,2) not null default 0,
  cambio numeric(12,2) not null default 0,
  pago_usd numeric(12,2),
  tipo_cambio numeric(12,4),
  pago_efectivo numeric(12,2),
  pago_tarjeta numeric(12,2),
  nota text not null default '',
  fecha timestamptz not null,
  cancelada boolean not null default false,
  cancelada_por bigint,
  cancelada_fecha timestamptz,
  motivo_cancelacion text not null default '',
  corte_clave text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_ventas_fecha on public.ventas (fecha);
create index if not exists idx_ventas_sucursal_fecha on public.ventas (sucursal_id, fecha);

-- Con la fecha y la sucursal de su venta, para leer lo vendido de un periodo sin cruzar tablas
create table if not exists public.venta_detalle (
  id bigserial primary key,
  venta_id bigint not null references public.ventas(id) on delete cascade,
  sucursal_id bigint not null,
  fecha timestamptz not null,
  producto_id bigint,
  descripcion text not null,
  departamento text not null default '',
  cantidad numeric(12,3) not null,
  precio_unitario numeric(12,2) not null,
  precio_lista numeric(12,2),
  costo_unitario numeric(12,2) not null default 0,
  importe numeric(12,2) not null
);
create index if not exists idx_venta_detalle_fecha on public.venta_detalle (fecha);
create index if not exists idx_venta_detalle_venta on public.venta_detalle (venta_id);

-- El corte completo (como su ticket) va en "detalle" para consultarlo y reimprimirlo
create table if not exists public.cortes (
  id bigserial primary key,
  clave text not null unique,
  caja_id bigint not null references public.cajas(id),
  sucursal_id bigint not null references public.sucursales(id),
  corte_local_id bigint not null,
  usuario_id bigint,
  fecha timestamptz not null,
  num_ventas integer not null default 0,
  total_vendido numeric(12,2) not null default 0,
  efectivo_esperado numeric(12,2) not null default 0,
  efectivo_contado numeric(12,2) not null default 0,
  diferencia numeric(12,2) not null default 0,
  num_canceladas integer not null default 0,
  total_canceladas numeric(12,2) not null default 0,
  salidas_efectivo numeric(12,2) not null default 0,
  detalle jsonb
);
create index if not exists idx_cortes_fecha on public.cortes (sucursal_id, fecha desc);

-- Clientes con crédito de cada caja, con el saldo que llevan
create table if not exists public.clientes (
  id bigserial primary key,
  clave text not null unique,
  caja_id bigint not null references public.cajas(id),
  sucursal_id bigint not null references public.sucursales(id),
  cliente_local_id bigint not null,
  nombre text not null,
  telefono text not null default '',
  limite_credito numeric(12,2) not null default 0,
  credito_autorizado boolean not null default false,
  notas text not null default '',
  activo boolean not null default true,
  saldo numeric(12,2) not null default 0,
  ultima_compra timestamptz,
  ultimo_abono timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.abonos (
  id bigserial primary key,
  clave text not null unique,
  caja_id bigint not null references public.cajas(id),
  sucursal_id bigint not null references public.sucursales(id),
  abono_local_id bigint not null,
  cliente_clave text not null,
  cliente_nombre text not null default '',
  usuario_id bigint,
  monto numeric(12,2) not null,
  forma_pago text not null default 'efectivo',
  saldo_anterior numeric(12,2),
  saldo_nuevo numeric(12,2),
  fecha timestamptz not null,
  corte_clave text
);
create index if not exists idx_abonos_fecha on public.abonos (sucursal_id, fecha);

-- ========================================================
-- Seguridad (igual que supabase/seguridad.sql): la llave pública no puede leer ni modificar nada.
-- Las computadoras usan la llave secreta, que no se ve afectada.
-- ========================================================
do $$
declare
  tabla record;
begin
  for tabla in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', tabla.tablename);
  end loop;
end $$;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
