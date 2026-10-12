# Configuración de Supabase (la central)

## 1) Crear la base central

1. Crea el proyecto en https://supabase.com.
2. En **SQL Editor** pega y ejecuta el contenido de `supabase/schema.sql`
   (se puede volver a ejecutar sin riesgo: crea lo que falte, corrige datos y deja las tablas protegidas).

## 2) Configurar cada computadora

Copia `.env.example` como `.env` en la carpeta del sistema y llena:

```env
PORT=3000
FARMACIA_DB=./farmacia.db
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...   (Project Settings → API Keys → Secret keys)
```

- La **llave secreta** solo va en el `.env` de las computadoras de las farmacias.
  Nunca en GitHub, en un celular ni en un mensaje.
- El archivo `.env` está excluido del repositorio (`.gitignore`).

## 3) Seguridad: si una llave secreta se filtró (por ejemplo, quedó en GitHub)

Hazlo en este orden para que ninguna farmacia se quede sin conexión:

1. **Repositorio privado:** GitHub → el repositorio → Settings → General → *Danger Zone* →
   *Change repository visibility* → **Private**.
2. **Llave nueva:** Supabase → Project Settings → **API Keys** → *Secret keys* → **Create new secret key**.
   Copia la llave (empieza con `sb_secret_`).
3. **Actualiza cada computadora:** en su `.env` cambia `SUPABASE_SERVICE_ROLE_KEY=` por la llave nueva
   y reinicia el sistema. Revisa que la barra superior diga **En línea**.
4. **Desactiva las llaves viejas:** cuando todas las computadoras ya usen la llave nueva, en
   Supabase → API Keys → *Legacy API Keys* → **Disable JWT-based API keys**
   (la `service_role` y la `anon` antiguas dejan de servir). Si antes habías creado otra llave secreta
   que se filtró, bórrala en *Secret keys*.
5. **Protege las tablas:** en SQL Editor ejecuta `supabase/seguridad.sql`. Al final debe mostrar
   `rowsecurity = true` en todas las tablas.
6. **Cambia las contraseñas** de los administradores desde Administración → Usuarios
   (las contraseñas cifradas estuvieron visibles mientras las tablas no estaban protegidas).

## 4) App del celular

La app del celular habla con la función `movil` de Supabase (no con las computadoras), así funciona
aunque las farmacias estén cerradas. Para publicarla (función en Supabase + app en Cloudflare Pages)
sigue [docs/celular.md](../docs/celular.md). La función usa su propia llave secreta, guardada en
*Edge Functions → Secrets* como `FARMACIA_SECRET_KEY`.

## 5) Cómo trabaja el sistema con la central

- El inicio de sesión valida contra `usuarios_central` y guarda una copia en la computadora.
- Usuarios, sucursales, productos, existencias, apoyos y pedidos viven en Supabase.
- Ventas, clientes, crédito, caja y cortes viven en cada computadora (cada farmacia tiene sus propias
  estadísticas) para poder vender sin internet.
- Una sesión ya iniciada puede seguir vendiendo sin conexión; el inventario se sube solo al volver.
