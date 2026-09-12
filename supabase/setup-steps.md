# Setup rápido para tu Supabase

## 1) Crear la base central

Usa esta URL como endpoint origen:

https://hnjshjnwgyczajiiytin.supabase.co

## 2) Ejecutar schema

Abre el SQL editor de Supabase y pega el contenido de:

- supabase/schema.sql

## 3) Configurar variables

Crea un archivo `.env` en la raíz del proyecto con este contenido:

```env
PORT=3000
FARMACIA_DB=./farmacia.db
APP_MODE=local
SUPABASE_URL=https://hnjshjnwgyczajiiytin.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuanNoam53Z3ljemFqaWl5dGluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MjQwMTMsImV4cCI6MjEwNDUwMDAxM30.jKA19bdMJQpPgx71sRP-7v-22xABgO5_azG7HvR-V3c
SUPABASE_SERVICE_ROLE_KEY=REEMPLAZA_POR_LA_SERVICE_ROLE_KEY
DATABASE_URL=postgres://postgres:postgres@localhost:5432/farmacia_central
DB_CLIENT=sqlite
SYNC_API_URL=http://localhost:3000/api/sync
SYNC_TOKEN=change-me
```

## 4) Importante

- La anon key sirve para consultas públicas.
- La service role key es la que te permite escribir desde el backend con permisos completos.
- Nunca la expongas al frontend si no es necesario.

## 5) Activar usuarios y sucursales centrales

Vuelve a ejecutar `supabase/schema.sql` en el SQL Editor. El script agrega a
`usuarios_central` las columnas `password_hash` y `sucursal_id`, necesarias para
el login y la relación con `sucursales`.

Las cuentas antiguas que ya estaban en `usuarios_central` deben editarse desde
Administración para asignarles sucursal y contraseña. No se puede recuperar una
contraseña anterior desde Supabase.

Desde ese momento:

- el login valida primero contra `usuarios_central` y guarda una copia local;
- usuarios y sucursales se administran en Supabase;
- apoyos y pedidos se publican y descargan desde Supabase;
- ventas, clientes, crédito, caja y sesiones locales siguen en SQLite para poder
	trabajar sin internet;
- una sesión ya iniciada puede continuar vendiendo sin conexión; para iniciar
	sesión por primera vez hace falta conexión o una copia local previamente
	sincronizada.

## 6) Seguridad

Si la `SUPABASE_SERVICE_ROLE_KEY` fue compartida o subida a un repositorio,
regénérala en Supabase y actualiza el `.env` de cada instalación.
