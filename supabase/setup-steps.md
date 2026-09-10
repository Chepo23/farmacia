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

## 5) Próximo paso

Con esto ya puedes integrar `@supabase/supabase-js` y empezar a enviar eventos de sincronización desde cada sucursal a la central.
