-- ========================================================
-- Seguridad: nadie puede leer ni modificar la base con la llave pública
-- ========================================================
-- Ejecútalo en Supabase → SQL Editor. Se puede ejecutar varias veces.
--
-- Sin esto, cualquiera que tenga la llave pública (anon / publishable) puede leer y modificar
-- todas las tablas, incluidas las contraseñas cifradas de los usuarios.
-- Las computadoras de las farmacias usan la llave secreta (service_role / sb_secret_…), que no
-- se ve afectada por estas reglas: el sistema sigue funcionando igual.

-- 1) Protección por renglón (RLS) en todas las tablas: sin reglas explícitas, nadie entra
do $$
declare
  tabla record;
begin
  for tabla in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', tabla.tablename);
  end loop;
end $$;

-- 2) Además, la llave pública pierde cualquier permiso sobre tablas, secuencias y funciones
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- 3) Comprobación: todas las tablas deben decir rowsecurity = true
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
