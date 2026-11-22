# Farmacia POS

Sistema de punto de venta para farmacias, inspirado en Eleventa / Mi Abarrotes, con soporte
multi-sucursal (una farmacia central que administra y surte a las sucursales).

## Cómo se usa

**En las farmacias:** se instala el programa **Farmacia** en cada computadora (instalador en
`dist-escritorio\`). Abre en su propia ventana, arranca con Windows, imprime directo en la impresora de
tickets y hace respaldos diarios. Instalación y configuración: [docs/instalacion.md](docs/instalacion.md).

**Para desarrollo o pruebas:**

```
npm install   (solo la primera vez)
npm start     (y abre http://localhost:3000)
npm test      (pruebas automáticas; nunca tocan el Supabase real)
npm run escritorio   (arma el instalador del programa de escritorio)
npm run movil        (arma la app del celular para Cloudflare y la función de Supabase)
```

Usuario inicial: **admin** / contraseña: **admin**
(cámbiala en Administración → Usuarios en cuanto entres).

## Módulos

- **Venta (F2)** — pantalla principal. Escanea el código de barras o escribe y presiona Enter.
  - `3*código` agrega 3 piezas de golpe.
  - **F3** busca producto por nombre, **F12** cobra, **F4** cancela la venta (pregunta antes), **Supr** quita el renglón,
    **F11** precio de mayoreo, **Ins** artículo común (algo que no está en el catálogo).
  - **Doble clic en el precio**: cambiarlo solo en esa venta (o un % de descuento), nunca abajo del costo;
    queda en el registro de cambios para el jefe.
  - **Cóctel (F10)**: las ampolletas, la jeringa y la aguja que se usaron se cobran juntas al precio del
    cóctel; el inventario descuenta exactamente eso. Lo que llega en caja y se vende suelto se cobra
    suelto o con **Vender caja** (precio de la caja completa). Guía: [docs/inyecciones.md](docs/inyecciones.md).
  - El precio de mayoreo se aplica solo al llegar a la cantidad de mayoreo del producto.
  - Cobro en efectivo (calcula cambio), dólares (con el tipo de cambio de la apertura), tarjeta,
    mixto (efectivo + tarjeta) o crédito a clientes autorizados.
  - Ticket para impresora térmica (80, 58 mm u otro ancho, por computadora): logo, folio, artículos, ahorro por mayoreo,
    total con letra, forma de pago y firma en ventas a crédito.
  - **Ventas del día**: consultar, reimprimir y **cancelar** ventas del turno (con motivo); la mercancía
    regresa al inventario y, si fue a crédito, se quita de la cuenta del cliente.
- **Productos (F5)** — catálogo con precios de costo/venta/mayoreo (y de caja completa para lo que se vende
  suelto), cócteles de inyección y la existencia en todas las sucursales.
  Entradas, salidas (merma), ajustes por conteo físico, mínimos, alerta de bajo mínimo e **Historial**
  (kardex) de cada producto con la existencia que quedó después de cada movimiento.
- **Clientes (F6)** — crédito/fiado con límite. Estado de cuenta con saldo acumulado (en hoja carta o en
  ticket) y abonos en efectivo o tarjeta con comprobante impreso. Un abono no puede ser mayor a lo que se debe.
  **Préstamos** de medicamento (por ejemplo, a farmacias que no son del jefe): sale del inventario, vuelve
  al regresarlo, o se cobra en la caja (a costo, al contado o a crédito) sin volver a sacarlo.
- **Corte (F7)** — corte de caja del turno. Efectivo esperado = fondo + ventas en efectivo + abonos en
  efectivo + entradas − salidas − cambio en pesos de las ventas en dólares. Se captura el efectivo
  contado y los dólares contados, se ve el sobrante/faltante y se imprime el ticket del corte.
  Entradas y salidas de efectivo (pago a proveedor, retiro, morralla) quedan registradas.
- **Reportes (F8)** — total vendido, ganancia, ticket promedio, por día, sucursal, cajero, forma de pago
  y departamento, más vendidos, abonos cobrados y canceladas. Inventario: unidades, agotados, bajo
  mínimo y valor a costo y a precio de venta.
- **Apoyos (F9)** — traspaso de mercancía entre farmacias, sustituye el Excel y las fotos.
  - **Cualquier farmacia le manda a cualquiera**: la central a las sucursales (normalmente muchos
    productos), una sucursal a la central o a otra sucursal (normalmente uno o dos).
  - La sucursal también puede mandar su **pedido** a la central: escanea lo que se le acabó (o usa
    *Sugerencias*) y la central arma el apoyo desde ese pedido.
  - Quien manda arma el apoyo escaneando y lo **envía**: sale de su inventario. En *Pendientes* se ven
    los **apoyos en camino** (los que mandó y los que le mandaron).
  - La farmacia que recibe lo **revisa pieza por pieza con el celular**: solo lo confirmado entra a su
    inventario y los faltantes quedan registrados (con alerta para el jefe).
  - La que recibe puede cancelar un envío (regresa a la que lo mandó); quien lo armó puede descartar su borrador.
- **Administración** (administrador de la central) — usuarios, sucursales, departamentos,
  **datos del ticket** (nombre, lema, RFC, mensajes, ancho del papel), **sincronización** con la central,
  **respaldos de esta computadora** (diarios, manuales y descarga), la **copia diaria de la central**
  (inventario de todas las farmacias, conteos, apoyos, ventas; solo baja lo que cambió) y, en el programa de escritorio,
  sus impresoras y actualizaciones.
- **App del celular** (botón **Celular**) — app instalable para Android e iPhone: escanear con la cámara
  para consultar precio y existencias de todas las farmacias, **recibir mercancía** de corrido y **contar**
  estantes aplicando solo las diferencias. Funciona **aunque las computadoras estén apagadas** (habla
  directo con la central en Supabase). Cada celular se vincula una vez con un código QR de la computadora
  y se puede desvincular en cualquier momento. Publicación y uso: [docs/celular.md](docs/celular.md).
- **Jefe** (cuenta de jefe en la central) — ve todas las farmacias desde su celular o desde la
  computadora: lo vendido hoy y la utilidad de cada una, reportes, cortes (para verlos y reimprimirlos),
  créditos de clientes, **Movimientos** de inventario, **registro de cambios** (quién cambió qué) e
  **inventario**: la lista que él arma para cada farmacia se cuenta a ciegas en la mañana y en la
  tarde (la existencia se ajusta al terminar), más inventarios completos cuando él los pide, y él lo
  revisa cada semana en la **Revisión semanal** (como la hoja de Excel). También manda **cotizaciones** a las
  sucursales. Guía: [docs/jefe.md](docs/jefe.md).

Los **precios** solo los fija el administrador de la central y se aplican en todas las sucursales;
las sucursales manejan el inventario de su farmacia (entradas, salidas, ajustes y mínimos).
Las estadísticas de ventas son de cada farmacia.

## Inventario: una sola fuente de verdad

Todas las pantallas (Productos, Venta, búsqueda F3, Bajo mínimo, Apoyos, Pedidos, Reportes y Kardex)
leen y mueven existencias con el mismo módulo, `src/inventario.js`.

- **Sin Supabase (modo local):** un solo servidor y una base SQLite; todas las sucursales entran por el navegador.
- **Con Supabase (modo central):** cada farmacia tiene su servidor y su SQLite, y la central (Supabase)
  es la autoridad de catálogo, existencias, apoyos y pedidos. Cada movimiento se aplica en la central
  de forma atómica (dos cajas no pueden vender la misma última pieza).
- **Sin internet se sigue vendiendo:** el descuento queda en una cola y se sube solo al volver la
  conexión. La barra superior indica *En línea*, *Sin conexión* o cuántos movimientos faltan por subir.
  Entradas, ajustes y apoyos necesitan conexión, para que nadie trabaje con existencias viejas.
- Las ventas, clientes, abonos y cortes de cada farmacia se guardan en su propia computadora (para
  vender sin internet) y se suben solos a la central unos segundos después, para que el jefe vea todas
  las farmacias.

La estructura de la central está en `supabase/schema.sql` (ver `supabase/setup-steps.md`).

## Estructura

- `server.js` — servidor Express.
- `src/db.js` — esquema SQLite y migraciones (archivo `farmacia.db`, se crea solo).
  Con la variable `FARMACIA_DB` se puede abrir otra base, por ejemplo una copia para pruebas.
- `src/inventario.js`, `src/catalogo.js` — existencias y catálogo (central o local).
- `src/traspasos.js` — apoyos y pedidos (central o local).
- `src/subir-ventas.js` — sube ventas, cortes, clientes y abonos de esta computadora a la central.
- `src/respaldos.js`, `src/copia-central.js` — respaldo diario de esta computadora y copia diaria de la
  central (`scripts/restaurar-central.js` la compara con la central y la repone).
- `src/supervision.js`, `src/bitacora.js` — lo del jefe (movimientos, inventarios) y el registro de cambios.
- `src/routes/` — API: productos, ventas, clientes, cortes, reportes, admin, apoyos, pedidos, config,
  movimientos, conteos, supervisión, ventas de la central, celulares, respaldos y sistema.
- `public/` — interfaz web (HTML/CSS/JS sin frameworks). `public/js/impresion.js` arma los tickets
  y documentos impresos; `public/movil.html` es la app del celular.
- `supabase/functions/movil/` — función de Supabase que atiende al celular. `supervision.mjs` y
  `ventas.mjs` también los usa el servidor de cada computadora (mismas reglas en los dos lados).
- `escritorio/` — programa de escritorio (Electron) e instalador.
- `scripts/` — armar el instalador y la app del celular, importar el catálogo desde Eleventa y
  restaurar la central desde una copia.

## Pruebas

```
npm test
```

Las pruebas de punta a punta levantan servidores temporales (nunca usan `farmacia.db` ni el `.env`):
una con varias computadoras que comparten una central falsa (imitación de Supabase) y otra en modo local.

## Multi-sucursal

Cada usuario pertenece a una sucursal; sus ventas, inventario y cortes se registran ahí.
Para que las farmacias trabajen juntas se usa Supabase como central (ver `supabase/setup-steps.md`)
o un solo servidor con internet al que cada farmacia entra desde el navegador.
