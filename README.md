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
  - **F3** busca producto por nombre, **F12** cobra, **F4** cancela la venta, **Supr** quita el renglón,
    **F11** precio de mayoreo, **Ins** artículo común (algo que no está en el catálogo).
  - El precio de mayoreo se aplica solo al llegar a la cantidad de mayoreo del producto.
  - Cobro en efectivo (calcula cambio), dólares (con el tipo de cambio de la apertura), tarjeta,
    mixto (efectivo + tarjeta) o crédito a clientes autorizados.
  - Ticket para impresora térmica (80, 58 mm u otro ancho, por computadora): logo, folio, artículos, ahorro por mayoreo,
    total con letra, forma de pago y firma en ventas a crédito.
  - **Ventas del día**: consultar, reimprimir y **cancelar** ventas del turno (con motivo); la mercancía
    regresa al inventario y, si fue a crédito, se quita de la cuenta del cliente.
- **Productos (F5)** — catálogo con precios de costo/venta/mayoreo y la existencia en todas las sucursales.
  Entradas, salidas (merma), ajustes por conteo físico, mínimos, alerta de bajo mínimo e **Historial**
  (kardex) de cada producto con la existencia que quedó después de cada movimiento.
- **Clientes (F6)** — crédito/fiado con límite. Estado de cuenta con saldo acumulado (en hoja carta o en
  ticket) y abonos en efectivo o tarjeta con comprobante impreso. Un abono no puede ser mayor a lo que se debe.
- **Corte (F7)** — corte de caja del turno. Efectivo esperado = fondo + ventas en efectivo + abonos en
  efectivo + entradas − salidas − cambio en pesos de las ventas en dólares. Se captura el efectivo
  contado y los dólares contados, se ve el sobrante/faltante y se imprime el ticket del corte.
  Entradas y salidas de efectivo (pago a proveedor, retiro, morralla) quedan registradas.
- **Reportes (F8)** — total vendido, ganancia, ticket promedio, por día, sucursal, cajero, forma de pago
  y departamento, más vendidos, abonos cobrados y canceladas. Inventario: unidades, agotados, bajo
  mínimo y valor a costo y a precio de venta.
- **Apoyos (F9)** — traspaso de mercancía entre farmacias, sustituye el Excel y las fotos.
  - La sucursal manda su **pedido**: escanea lo que se le acabó (o usa *Sugerencias*) y lo envía a la central.
  - La central arma el apoyo escaneando (o desde el pedido) y lo **envía**: sale de su inventario.
  - La sucursal **recibe revisando pieza por pieza**: solo lo confirmado entra a su inventario y los
    faltantes quedan registrados.
  - La sucursal puede cancelar un envío (regresa a la central); la central puede descartar su borrador.
- **Administración** (administrador de la central) — usuarios, sucursales, departamentos,
  **datos del ticket** (nombre, lema, RFC, mensajes, ancho del papel), **sincronización** con la central,
  **respaldos de esta computadora** (diarios, manuales y descarga) y, en el programa de escritorio,
  sus impresoras y actualizaciones.
- **App del celular** (botón **Celular**) — app instalable para Android e iPhone: escanear con la cámara
  para consultar precio y existencias de todas las farmacias, **recibir mercancía** de corrido y **contar**
  estantes aplicando solo las diferencias. Funciona **aunque las computadoras estén apagadas** (habla
  directo con la central en Supabase). Cada celular se vincula una vez con un código QR de la computadora
  y se puede desvincular en cualquier momento. Publicación y uso: [docs/celular.md](docs/celular.md).

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
- Las ventas, clientes, abonos y cortes de cada farmacia se guardan en su propia computadora.

Para activar el kardex completo en Supabase, ejecuta otra vez `supabase/schema.sql` en el editor SQL.

## Estructura

- `server.js` — servidor Express.
- `src/db.js` — esquema SQLite y migraciones (archivo `farmacia.db`, se crea solo).
  Con la variable `FARMACIA_DB` se puede abrir otra base, por ejemplo una copia para pruebas.
- `src/inventario.js`, `src/catalogo.js` — existencias y catálogo (central o local).
- `src/traspasos.js` — apoyos y pedidos (central o local).
- `src/routes/` — API: productos, ventas, clientes, cortes, reportes, admin, apoyos, pedidos, config.
- `public/` — interfaz web (HTML/CSS/JS sin frameworks). `public/js/impresion.js` arma los tickets
  y documentos impresos.

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
