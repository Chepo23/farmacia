# Programa de escritorio: instalación en cada computadora

El sistema ya no se abre con `npm start` ni en el navegador: se instala como un programa normal de
Windows.

- Icono **Farmacia** en el escritorio; abre en su propia ventana, sin barra del navegador.
- Arranca solo al encender la computadora.
- Imprime directo en la impresora de tickets de esa computadora, sin la ventana de "Imprimir".
- Guarda un respaldo diario de los datos de esa computadora (ventas, clientes, crédito y cortes).

**Requisitos:** Windows 10 u 11 de 64 bits.

---

## 1. Instalar

1. Busca el instalador **`Farmacia-Instalador-1.0.0.exe`** en la carpeta `dist-escritorio` del sistema.
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
2. **Datos:** si esa computadora ya usaba el sistema:
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

- Cada día, al abrir el sistema, se guarda una copia de los datos de esa computadora:
  - en `%APPDATA%\Farmacia\datos\respaldos` (se conservan 30 días);
  - y en la carpeta extra, si se eligió una.
- En **Administración → Respaldos de esta computadora** se ve el último respaldo y hay botones para
  **Respaldar ahora** y **Descargar**.
- **Para recuperar un respaldo:** Configuración → Datos → **Elegir solo el archivo farmacia.db…** →
  elige el respaldo → **Guardar**. Los datos que había se guardan aparte con otro nombre; no se pierden.
- Desinstalar el programa **no** borra los datos.

## 5. Si algo falla

- Si aparece **No se pudo iniciar el sistema**, el mensaje dice la causa (por ejemplo, que quedó
  abierto el sistema anterior). Usa **Reintentar**, **Configuración** o **Abrir registros**.
- Si el sistema se cierra solo, el programa lo vuelve a abrir.
- Los registros están en `%APPDATA%\Farmacia\registros` (sirven para soporte técnico).
- **Ctrl +** / **Ctrl −** cambian el tamaño de la letra; **Ctrl 0** lo regresa a normal.
- Al cerrar la ventana, si hay movimientos de inventario sin subir a la central (por falta de
  internet), el programa avisa. Se suben solos la próxima vez que se abra con internet.

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
