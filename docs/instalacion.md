# Programa de escritorio: instalación en cada computadora

El sistema ya no se abre con `npm start` ni en el navegador: se instala como un programa normal de
Windows.

- Icono **Farmacia** en el escritorio; abre en **pantalla completa**, sin barra del navegador ni de Windows.
- Arranca solo al encender la computadora.
- Imprime directo en la impresora de tickets de esa computadora, sin la ventana de "Imprimir".
- Guarda un respaldo diario de los datos de esa computadora (ventas, clientes, crédito y cortes) y una
  **copia diaria de la base central** (inventario de todas las farmacias, conteos, apoyos, ventas…).

**Requisitos:** Windows 10 u 11 de 64 bits.

---

## 1. Instalar

1. Busca el instalador **`Farmacia-Instalador-1.0.13.exe`** en la carpeta `dist-escritorio` del sistema.
   Como está en OneDrive, en otra computadora puedes descargarlo desde OneDrive, o pasarlo con una USB.
2. Ábrelo. La primera vez Windows puede mostrar **"Windows protegió su PC"** (el programa no tiene
   una firma digital de pago): toca **Más información → Ejecutar de todas formas**.
3. Sigue el instalador (**Siguiente → Instalar**). No necesita permisos de administrador.

## 2. Configurar (solo la primera vez)

Al terminar se abre **Configura esta computadora**:

1. **Conexión:** deja *Conectada a la central (Supabase)* y escribe:
   - la dirección de Supabase (`https://….supabase.co`);
   - la **llave secreta** (`sb_secret_…`; usa la nueva de los pasos de seguridad).

   Toca **Probar conexión**: debe decir *Conexión correcta* y los nombres de las sucursales.
   La llave se guarda cifrada con la cuenta de Windows de esa computadora.
2. **Datos:** **solo** si esa computadora ya vendía **de verdad** con este sistema (con `npm start`).
   Si ahí se usaba Eleventa u otro programa, o solo se hicieron pruebas, **sáltate este paso**: traería
   ventas, clientes y apoyos de prueba. Si ya se trajeron por error, ve a *Recuperar un respaldo* (sección 4)
   y elige el archivo `farmacia-antes-de-importar-….db` de la carpeta de datos del programa.
   Si sí vendía con este sistema:
   - Primero **cierra la ventana negra de `npm start`**.
   - Toca **Traer datos del sistema anterior…** y elige la carpeta del sistema (donde están
     `farmacia.db` y `.env`).
   - Se copian las ventas, clientes, crédito y cortes. La base original no se mueve ni se borra.
   - También se toman la dirección de Supabase y la llave del `.env` (casilla *Usar la llave secreta
     del sistema anterior*). Si ya cambiaste la llave en Supabase, escribe la nueva en el paso 1.
3. **Impresoras:**
   - Elige la **impresora de tickets** y el **ancho del papel**: 80 mm, 58 mm u *Otro ancho…* (en mm).
     Cada computadora tiene el suyo, así que la central puede usar uno más ancho que las sucursales.
   - Toca **Imprimir ticket de prueba**: las marcas `|izquierda` y `derecha|` deben salir completas.
     Si se cortan, prueba con el otro ancho.
   - Elige la **impresora de documentos** (hoja carta: estados de cuenta, apoyos, pedidos), o deja
     *Preguntar cada vez* para que salga la ventana de impresión de Windows.
4. **Opciones:**
   - Deja marcado *Abrir el programa al encender la computadora*.
   - *Abrir en pantalla completa*: viene marcado. Si en esa computadora prefieres la ventana normal
     (con la barra de Windows abajo), desmárcalo.
   - En **Carpeta extra para los respaldos** se recomienda una carpeta de OneDrive (por ejemplo
     `OneDrive\Respaldos Farmacia\Sucursal Norte`): así cada día queda una copia en la nube.
   - *Dirección de la app del celular*: la de Cloudflare (ver `docs/celular.md`).
5. **Guardar y abrir el sistema** y entra con tu usuario como siempre.

Desde ese momento ya no uses `npm start` en esa computadora. Si los dos quedan abiertos a la vez, el
programa avisa que *el puerto ya lo está usando otro programa*.

## 3. Cambiar la configuración después

- En la pantalla de inicio de sesión: **Configurar este programa (conexión e impresoras)**.
- O dentro del sistema: **Administración → Programa de esta computadora → Impresoras y opciones**.

Cambiar la impresora o el papel se aplica al momento, sin interrumpir la venta en curso. Cambiar la
conexión reinicia el sistema, así que termina primero la venta.

## 4. Respaldos

- Se guarda una copia de los datos de esa computadora al abrir el sistema cada día y **al cerrarlo**
  (como en Eleventa, aparece *Guardando un respaldo de los datos…* y el programa se cierra solo):
  - en `%APPDATA%\Farmacia\datos\respaldos` (uno por día, se conservan 30 días; el del día queda
    como estaba al cerrar);
  - y en la carpeta extra, si se eligió una.
- En **Administración → Respaldos de esta computadora** se ve el último respaldo y hay botones para
  **Respaldar ahora** y **Descargar**.
- **Copia de la central:** una vez al día (al abrir el sistema, o en cuanto haya internet) cada
  computadora guarda también una copia de la base central en `%APPDATA%\Farmacia\datos\respaldos\central`
  (`central-AAAA-MM-DD.db.gz`, se conservan 30; también va a la carpeta extra si se eligió una). Solo baja
  lo que cambió desde la copia anterior, para no gastar el límite de la central. No lleva contraseñas.
  En la misma pantalla se ve la última copia, hay botón **Copiar la central ahora** y se puede descargar.
  Volver a una copia lo hace el técnico con `scripts/restaurar-central.js` (ver [jefe.md](jefe.md)).
- **Para recuperar un respaldo:** Configuración → Datos → **Elegir solo el archivo farmacia.db…** →
  elige el respaldo → **Guardar**. Los datos que había se guardan aparte con otro nombre; no se pierden.
- Desinstalar el programa **no** borra los datos.

## 5. Si algo falla

- Si aparece **No se pudo iniciar el sistema**, el mensaje dice la causa (por ejemplo, que quedó
  abierto el sistema anterior). Usa **Reintentar**, **Configuración** o **Abrir registros**.
- Si el sistema se cierra solo, el programa lo vuelve a abrir.
- Los registros están en `%APPDATA%\Farmacia\registros` (sirven para soporte técnico).
- **Ctrl +** / **Ctrl −** cambian el tamaño de la letra; **Ctrl 0** lo regresa a normal.
- **Ctrl+Shift+F** cambia entre pantalla completa y ventana
  (F11 no, porque en la venta es el precio de mayoreo).
- Si al cerrar hay movimientos de inventario sin subir a la central (por falta de internet), el
  programa avisa. Se suben solos la próxima vez que se abra con internet.

## Uso diario

> Novedades de la versión 1.0.7: rol **Jefe** (en *Administración → Usuarios*), pestaña **Movimientos**
> (para administradores y jefes), **registro de cambios** e **inventario del día** con autorización del
> jefe. Versión 1.0.8: cada computadora sube sola sus ventas, cortes, créditos y abonos a la central y el
> jefe ve todas las farmacias (Inicio, Reportes, Cortes y Créditos). Antes de instalarlas hay que
> actualizar la base central y la función del celular. Todo se explica en [jefe.md](jefe.md).
> Versión 1.0.9: corrige el teclado después de cobrar (se "comían" letras en los buscadores y un cobro
> con Enter, F1 o F2 podía guardar el pago anterior o repetirse), el doble clic que guardaba dos veces,
> el guion, + y Supr en la caja del código, y el "día" cerca de la medianoche (usa la hora de la computadora).
> **F4** (cancelar la venta) ahora pregunta antes de borrar; un Enter perdido no la borra.
> Versión 1.0.10: el inventario se hace con la **lista que arma el jefe** para cada farmacia, dos veces al
> día (turno de la mañana y de la tarde), más **inventarios completos** (todo o un departamento) cuando el
> jefe los pide; en Productos se puede filtrar por departamento y **dar de baja varios a la vez** (solo la
> central). Necesita actualizar la base central y la función del celular (ver [jefe.md](jefe.md)).
> Versión 1.0.11: **inyecciones**. Lo que llega en caja y se vende suelto (como ampolletas sin código)
> se cobra suelto o por **caja completa** con su precio, y los **cócteles** se cobran con **Cóctel (F10)**:
> se escanea lo que se usó (de la marca que sea) y el inventario descuenta exactamente eso. Necesita
> actualizar la base central y la función del celular. Guía: [inyecciones.md](inyecciones.md).
> Versión 1.0.12: el inventario de cada turno **se ajusta solo al terminar** y el jefe lo revisa en la
> **Revisión semanal** (la hoja de la semana, como el Excel de antes); **doble clic en el precio** de la
> venta para cambiarlo solo en esa venta (nunca abajo del costo); **préstamos** de medicamento a otras
> farmacias en **Clientes → Préstamos**. Necesita actualizar la base central y la función del celular
> (ver [jefe.md](jefe.md)).
> Versión 1.0.13: **apoyos desde cualquier farmacia** (una sucursal le manda a la central o a otra
> sucursal; en *Pendientes* se ven los apoyos en camino; en la central también reciben con el celular los
> administradores) y **copia diaria de la central** en cada computadora (sección 4). No necesita cambios en
> la base central ni en la función del celular; sí hay que subir otra vez la app del celular.

- **Salir** (arriba a la derecha) pregunta qué hacer: **Cerrar el sistema** (guarda el respaldo y
  cierra el programa) o **Cambiar de usuario**. En el inicio de sesión está **Cerrar el programa**.
  También se cierra con **Alt+F4**.
- **Varias ventas a la vez:** en la venta hay pestañas (*Ticket 1*, *Ticket 2*…). Con **Nuevo ticket**
  (o **Ctrl+N**) se atiende a otro cliente sin cobrar la venta que se estaba haciendo; **Ctrl+Tab**
  pasa de una a otra. Doble clic en una pestaña para ponerle nombre (por ejemplo, el del cliente).
  Al cobrar, su pestaña se cierra.
- **Ventas sin cobrar:** si se cierra el programa con ventas en las pestañas, pregunta si se dejan.
  Si se dejan, aparecen igual la próxima vez que se abra (también si se fue la luz).
- **Después del corte** la caja queda cerrada: si llega un cliente se puede armar su venta y dejarla
  en su pestaña. Para cobrar, el programa pide abrir la caja otra vez (fondo y tipo de cambio); se
  puede cancelar si solo se quería dejar la venta. También está el botón **Abrir caja**.

## 6. Versiones nuevas

**Opción sencilla:** instala el archivo nuevo encima del anterior, sin desinstalar. Los datos y la
configuración se conservan.

**Opción automática (opcional):** las computadoras descargan solas la versión nueva y la instalan al
cerrar el programa.

1. En Cloudflare → **R2** crea un bucket, por ejemplo `farmacia-actualizaciones`.
2. En el bucket ve a **Settings → Public access** y activa **R2.dev subdomain**. Copia su dirección
   (`https://pub-….r2.dev`).
3. En cada computadora: Configuración → **Opciones avanzadas → Dirección de actualizaciones**, pega
   esa dirección.
4. Con cada versión nueva, sube al bucket los archivos de `dist-escritorio`:
   - `latest.yml`
   - `Farmacia-Instalador-X.Y.Z.exe`
   - `Farmacia-Instalador-X.Y.Z.exe.blockmap`

## 7. Armar una versión nueva (técnico)

1. Sube el número de `"version"` en `escritorio/package.json` (por ejemplo `1.0.1`).
2. En la carpeta del sistema ejecuta `npm run escritorio`.
3. El instalador queda en `dist-escritorio\`.

El armado ocurre en `%LOCALAPPDATA%\farmacia-construccion`, fuera de OneDrive, para no subir a la nube
las herramientas de Electron. El servidor va dentro del programa con el mismo Node.js con el que se
corren las pruebas.

`npm run escritorio -- --carpeta` arma solo la carpeta del programa, sin instalador, para probar más
rápido.
