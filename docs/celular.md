# App del inventario en el celular

Una app para el celular (Android y iPhone) que se instala en la pantalla de inicio y se abre como
cualquier aplicación, sin barra del navegador. Sirve para:

- **Consultar** precio, precio de mayoreo, costo, cuántas piezas hay en **cada farmacia** y los
  **últimos movimientos** del producto (por ejemplo, para que el jefe consulte sin estar preguntando por mensajes).
- **Recibir mercancía** escaneando con la cámara donde está la mercancía, sin cargarla a la computadora.
- **Contar**: el **inventario del día** (una lista corta que arma el sistema cada día, se cuenta sin ver
  lo que dice el sistema y el jefe autoriza las diferencias) y el conteo libre de un estante. En los
  dos se respetan las ventas que se hagan mientras se cuenta.
- **Revisar los apoyos** que manda la central: cada pieza escaneada se palomea y al final dice si el
  apoyo llegó completo o qué diferencias hubo.
- **Cotizar** (solo el administrador de la central): arma una cotización y la manda a una sucursal
  para que ahí se cobre.
- Entradas, mermas, ajustes, mínimos e historial de cada producto. El administrador de la central
  también cambia precios (se aplican en todas las farmacias).
- **Dar de alta productos nuevos** (cualquier usuario): si un código no está en el catálogo, toca
  **Dar de alta**, escribe nombre, costo, precio y las piezas que hay. El precio vale para todas las
  sucursales; después solo la central lo puede cambiar.

**Qué ve cada quien:**

| Cuenta | Pestañas en el celular |
|---|---|
| Jefe | **Inicio** (con lo vendido hoy en cada farmacia), **Consultar**, **Movimientos**, **Cotizar** y **Más** (ventas y utilidad, cortes de caja, créditos, inventario de las sucursales, inventarios del día, registro de cambios, productos por día, recibir y contar). Ver [jefe.md](jefe.md) |
| Administrador de la central | **Consultar** (con últimos movimientos, historial y cambiar precio), **Cotizar** y **Movimientos** de la central |
| Administrador de una sucursal | **Consultar**, **Recibir**, **Contar**, **Apoyos** y **Movimientos** de su sucursal |
| Cajeros | **Consultar**, **Recibir**, **Contar** y **Apoyos** (todo lo del inventario de su sucursal) |

**Funciona aunque las computadoras estén apagadas**: la app habla directo con la central en la nube
(Supabase), la misma que usan las computadoras. Lo que se hace en el celular se ve al momento en las
computadoras y al revés.

Cada celular **se vincula una sola vez** con un código que da la computadora. Después ya no pide
usuario ni contraseña: la sesión queda guardada en el celular hasta que se desvincule (o si pasa
más de 6 meses sin usarse).

---

## Preparación (una sola vez, el administrador)

Se necesitan tres cosas: las tablas en Supabase, la función `movil` en Supabase y la app publicada
en Cloudflare Pages (gratis). Todo se hace desde la computadora donde está el sistema.

### 1. Tablas en Supabase

En Supabase → **SQL Editor**, pega y ejecuta otra vez el contenido de `supabase/schema.sql`
(se puede ejecutar varias veces sin riesgo). Crea las tablas `vinculos_movil`, `sesiones_movil`,
`cotizaciones`, `cotizacion_detalle`, las del jefe y el inventario del día (`bitacora`, `conteos`,
`conteo_detalle`, `conteo_ultimos`, `conteo_config`, `conteo_importantes`) y la columna `jefe` de los
usuarios, y deja todas las tablas protegidas.

### 2. Armar la app y la función

Si ya existen las carpetas `dist-movil` y `dist-funcion`, este paso ya está hecho. Si no, o si el
sistema trae cambios para el celular, en la carpeta del sistema abre PowerShell y ejecuta:

```
npm run movil
```

Toma la dirección de Supabase del `.env` (solo la dirección; la llave secreta no se usa ni se copia) y crea:

- `dist-movil\` → la app del celular (se sube a Cloudflare en el paso 4).
- `dist-funcion\index.ts` → la función `movil` en un solo archivo (se pega en Supabase en el paso 3).

### 3. Publicar la función `movil` en Supabase

1. **Llave para la función**: Supabase → Project Settings → **API Keys** → *Secret keys* →
   **New secret key**, nombre `movil`. Copia la llave (empieza con `sb_secret_`).
2. Supabase → **Edge Functions** → **Secrets** → agrega `FARMACIA_SECRET_KEY` con esa llave.
3. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
   Nombre: `movil`. Borra el código de ejemplo, pega **todo** el contenido de `dist-funcion\index.ts`
   y toca **Deploy**.
4. En la función `movil` → **Details** (o *Settings*): **apaga "Verify JWT"**
   (*Enforce JWT verification*) y guarda. La app no usa llaves de Supabase: cada celular entra con
   la sesión que obtiene al vincularse.
5. Prueba: abre en el navegador
   `https://TU-PROYECTO.supabase.co/functions/v1/movil/api/auth/yo`. Debe responder
   `{"error":"Este celular no está vinculado o la sesión se cerró","codigo":"SIN_SESION"}`.
   Eso significa que la función ya funciona.

> Con terminal, en lugar de los pasos 3 y 4:
> `npx supabase login` y luego
> `npx supabase functions deploy movil --project-ref TU-PROYECTO --no-verify-jwt --use-api`
> (usa la carpeta `supabase/functions/movil`).

### 4. Publicar la app en Cloudflare Pages

1. Crea una cuenta gratis en https://dash.cloudflare.com.
2. **Workers y Pages** → **Crear** → pestaña **Pages** → **Subir recursos** (*Upload assets / Direct Upload*).
3. Nombre del proyecto, por ejemplo `farmacia-inventario` → arrastra la carpeta **`dist-movil`** → **Implementar**.
4. La dirección de la app queda como `https://farmacia-inventario.pages.dev`. Si Cloudflare lo crea
   como *Worker*, la dirección termina en `.workers.dev` (por ejemplo
   `https://farmacia-sanfrancisco-inventario.tu-usuario.workers.dev`); funciona igual.

> Con terminal: `npx wrangler pages deploy dist-movil --project-name farmacia-inventario`.

### 5. Decirle a cada computadora la dirección de la app

En cada computadora, en la configuración del programa (**Opciones → Dirección de la app del celular**),
pega la dirección (`https://farmacia-inventario.pages.dev`) y **Guardar**. También se puede escribir en
**Administración → Datos del ticket → Dirección de la app del celular**.

Opcional, para que solo esa dirección pueda usar la función: en Supabase → Edge Functions → Secrets
agrega `MOVIL_ORIGENES=https://farmacia-inventario.pages.dev`.

### Actualizaciones

Cuando el sistema traiga cambios en la app del celular, repite `npm run movil`,
vuelve a subir `dist-movil` en Cloudflare (en el proyecto: **New deployment** y arrastra la carpeta) y, si cambió la
función, vuelve a pegar `dist-funcion\index.ts` en Supabase. Los celulares toman la versión nueva
solos la siguiente vez que abren la app con internet.

---

## Vincular un celular (una vez por celular)

En la computadora toca **Celular** (arriba a la derecha) → **Generar código para vincular**.
Aparece un código QR y un código de 8 letras/números que dura **15 minutos** y sirve **una sola vez**.
El administrador de la central puede elegir **de quién es el celular** (por ejemplo, la cuenta de
administrador para el celular del jefe). Cada quien entra con los permisos de su cuenta.

**Android**

1. Escanea el código QR con la cámara (o con Google Lens) y abre el enlace.
   La app se abre ya vinculada.
2. Toca **Instalar** (aviso de arriba o menú ☰ → *Instalar la app*). Queda el ícono **Inventario**
   en la pantalla de inicio y se abre sin barra del navegador.

**iPhone**

1. Escanea el código QR con la cámara y abre el enlace en Safari.
2. Sigue lo que dice la pantalla: **Compartir** → **Agregar a pantalla de inicio** → **Agregar**.
3. Abre **Inventario** desde la pantalla de inicio y escribe el código (o toca
   **Escanear el código QR** y apunta a la pantalla de la computadora).

En iPhone la app instalada guarda su sesión aparte de Safari; por eso el código se escribe ya dentro
de la app instalada.

La ventana **Celular** de la computadora avisa cuando el celular quedó vinculado y muestra la lista
de **celulares vinculados**.

### Si se pierde o cambia un celular

En la computadora: **Celular → Celulares vinculados → Desvincular**. Ese celular deja de entrar al
momento. Cada quien ve sus propios celulares; el administrador de la central ve todos.
También se puede desvincular desde el propio celular: menú ☰ → **Desvincular este celular**.
Si un usuario se da de baja, sus celulares dejan de entrar.

---

## Uso

- **Consultar**: toca **Escanear** y apunta al código, o escribe el código o el nombre.
- **Recibir**: cada escaneo suma una pieza (para cajas activa *Preguntar la cantidad al escanear*).
  Al terminar revisa la lista y toca **Aplicar entrada al inventario**.
- **Contar**: arriba está el **inventario del día** (ver abajo). Más abajo, el conteo libre: escanea
  cada pieza del estante; al terminar **Aplicar ajustes**.
- Las listas de recibir y contar **se guardan en el celular**: si se va la señal o se cierra la app,
  no se pierde lo escaneado. Para aplicarlas se necesita internet.
- Mientras el mismo código siga frente a la cámara no se cuenta dos veces. Para otra pieza igual,
  aparta el celular y vuelve a apuntar, o toca **+1**.
- Cada usuario trabaja con el inventario de **su** sucursal. El administrador de la central elige la
  sucursal arriba.
- **Últimos movimientos**: al consultar un producto, debajo de las existencias salen sus 5 movimientos
  más recientes (ventas, entradas, mermas, ajustes) con quién y cuándo. **Historial completo** muestra más.
  El jefe ve los de todas las sucursales.

### Inventario del día (pestaña Contar)

1. Toca **Empezar** (o **Seguir contando**): sale la lista del día ordenada por departamento.
2. Escanea cada producto (o toca **Contar**) y escribe **cuántas piezas hay**, contando estante y bodega.
   No se ve lo que dice el sistema.
3. Si no cuadra, la app pide contarlo **otra vez**; si sigue sin cuadrar, pide el **motivo**.
4. Al final toca **Terminar el inventario del día**. Lo que no se alcanzó a contar queda para otro día.

Las diferencias no se ajustan solas: las autoriza un jefe (nunca quien contó). Todo lo del jefe está
en [jefe.md](jefe.md).

### Revisar un apoyo que llegó (pestaña Apoyos)

1. En **Apoyos** aparecen los apoyos que la central mandó a tu farmacia (el número rojo avisa cuántos hay).
2. Abre el que llegó y toca **Escanear lo que llegó**: cada pieza escaneada se palomea en su renglón.
   También puedes usar **+** y **−**.
3. Toca **Terminar revisión**:
   - Si todo cuadra dice **Apoyo completo**: toca **Recibir apoyo** y se suma al inventario.
   - Si no, muestra las **diferencias** (faltan, sobran, o llegó algo que no venía). Con **Recibir con
     diferencias** entra solo lo que sí llegó y venía en el apoyo, y las diferencias quedan anotadas en
     el apoyo para que la central las revise.
4. Lo escaneado se guarda en el celular: si se sale de la app, la revisión sigue donde se quedó.
5. En la computadora de la sucursal el apoyo aparece **En espera de verificación con el celular** y
   se actualiza solo cuando se termina la revisión. La recepción ya no se confirma desde la computadora.

### Cotizar (administrador de la central)

1. En **Cotizar** escanea o busca los productos (cada escaneo suma una pieza). Desde **Consultar**
   también está el botón **Agregar a cotización**.
2. Ajusta la cantidad y, si quieres, el **precio** de cada producto (en rojo cuando es distinto al de lista).
3. Escribe el cliente (opcional), elige la **sucursal** y, si quieres, **el usuario** que la va a cobrar.
4. **Enviar cotización**. Abajo quedan las enviadas con su estado: *Por cobrar*, *Cobrada* (con el folio
   de la venta), *Vencida* o *Cancelada*. Tocando una se puede **cancelar** o **copiar a una nueva**.

En la computadora de la sucursal aparece el botón **Cotizaciones** en la pantalla de venta (con el
número de las que esperan). **Cargar en la venta** pone los productos en la venta y se cobra como
siempre (F12):

- El precio cotizado se respeta **7 días**. Si el precio de hoy es más bajo, se cobra el más bajo.
- Si se llevan **más piezas** de las cotizadas, ese producto se cobra al precio de hoy.
- Ya vencida, la cotización se puede cargar, pero se cobra con los precios de hoy.
- Una cotización se cobra **una sola vez**. En el ticket sale *Cotización folio N*.
- Para cargar una cotización se necesita internet (la venta normal funciona sin internet).
- Sin internet la app abre y muestra el último usuario, pero no puede consultar ni guardar: avisa
  **Sin internet** y se actualiza sola al volver la señal.

## Consejos

- Si la cámara no enfoca, aleja un poco el celular. Si tiene varias cámaras traseras, usa el botón
  **Cámara** para cambiar de lente. En lugares oscuros usa **Linterna** (en Android).
- iPhone: si no aparece la cámara, revisa **Ajustes → Safari → Cámara → Permitir**.
- Lector de código de barras Bluetooth: emparéjalo con el celular, toca el campo
  **Código o nombre del producto** y escanea. Para pedidos grandes suele ser lo más rápido.
- Si un código no está en el catálogo, la app lo anota para que la central lo dé de alta
  (el administrador de la central puede darlo de alta desde el mismo celular).

## Seguridad

- La app publicada en Cloudflare **no contiene ninguna llave**. La llave secreta solo vive en las
  computadoras (`.env`) y en los *Secrets* de la función en Supabase.
- El código de vinculación dura 15 minutos y sirve una vez; en la nube solo se guarda su huella
  (SHA-256), igual que la de cada sesión.
- El código viaja después de `#` en la dirección del QR, así que no llega a los servidores de
  Cloudflare, y la app lo borra de la dirección en cuanto lo lee.

---

## Sin Supabase (una sola computadora)

Si el sistema trabaja sin la central en la nube, el botón **Celular** muestra un QR para abrir
`/movil.html` desde la misma computadora (con usuario y contraseña). Ahí el celular necesita estar en
la misma red y, para usar la cámara, una dirección `https://` (por ejemplo con
[Tailscale](https://tailscale.com): `tailscale serve --bg 3000`, y esa dirección se escribe en
**Administración → Datos del ticket → Dirección de la app del celular**). En este modo, si la
computadora está apagada, el celular no puede consultar.
