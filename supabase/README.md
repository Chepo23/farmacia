# Supabase para la farmacia central

## 1) Crear proyecto en Supabase

1. Entra a https://supabase.com
2. Crea un nuevo proyecto
3. Guarda la URL del proyecto y la `anon key` / `service role key`

## 2) Ejecutar esquema

En el panel de SQL editor de Supabase, pega el contenido de `supabase/schema.sql`.

## 3) Variables de entorno para la app

Crea un `.env` con algo como:

```env
PORT=3000
FARMACIA_DB=./farmacia.db
APP_MODE=local
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_ANON_KEY=tu-anon-key
SUPABASE_SERVICE_ROLE_KEY=tu-service-role
```

## 4) Uso recomendado

- La central usa Supabase/PostgreSQL.
- Cada sucursal usa SQLite local.
- Cuando hay internet, cada sucursal sincroniza cambios pendientes con la central.
- La central se encarga de validar stock y gestionar mini-apoyos entre sucursales.

## 5) Flows que soporta de entrada

- consulta de inventario global entre sucursales
- mini apoyos / redistribución de stock
- validación del stock por la central
- tracking de movimientos y conflictos

## 6) Siguiente paso real

Una vez que tengas Supabase listo, debes crear la API de sincronización de la sucursal hacia la central. Eso puede hacerse con endpoints tipo:

- POST /api/sync/push
- GET /api/sync/pull
- GET /api/inventario/global
- POST /api/mini-apoyo
- POST /api/mini-apoyos/:id/aceptar
- POST /api/mini-apoyos/:id/rechazar

Eso te permite separar el trabajo local de la sucursal del trabajo central.
