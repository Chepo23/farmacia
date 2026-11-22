# Cuenta de jefe: ventas, movimientos e inventario

La cuenta **Jefe** es para el dueño o los encargados generales (jefe o jefa). Hace todo lo que hace el
administrador de la central y además ve, desde el celular o la computadora:

- **Movimientos de inventario** de todas las sucursales, como en Eleventa: entradas, salidas, ventas,
  ajustes, apoyos y conteos, con cuánto había, cuánto quedó, quién lo hizo y la nota.
- **Registro de cambios**: quién cambió un precio (antes y después), quién dio de alta o de baja un
  producto o un usuario, ventas canceladas, cortes de caja, salidas de efectivo, apoyos y cotizaciones.
- **Inventario de cada sucursal**: lo que vale (a costo y a precio de venta), lo que está bajo mínimo,
  agotado, en negativo y lo que no se ha movido en 60 días (dinero detenido).
- **Inventario**: la lista de productos que cuenta cada farmacia (la arma él), el avance de los
  conteos de la mañana y de la tarde y la **revisión semanal** (como la hoja de Excel de antes: cada
  turno de la semana, qué faltó, quién contó y quién cobró).
- **Ventas de todas las farmacias** (desde la versión 1.0.8): lo vendido hoy y la utilidad de cada
  sucursal, reportes por día, cajero, departamento y forma de pago, lo más vendido, las ventas
  canceladas, los cortes de caja de cada farmacia (para verlos y reimprimirlos) y los clientes que
  deben (créditos).

Cada caja sigue cobrando con su propia computadora, aunque no haya internet; sus ventas, cortes,
clientes con crédito y abonos se suben solos a la central unos segundos después (sin internet, en
cuanto vuelve). Cada farmacia sigue viendo solo sus ventas: todas juntas solo las ve el jefe.

---

## Crear la cuenta del jefe

1. En la computadora de la central entra con un administrador y ve a **Administración → Usuarios → Nuevo**.
2. Escribe el nombre y el usuario de la persona, una contraseña, y en **Rol** elige **Jefe**.
   La sucursal queda fija en la central.
3. Crea **una cuenta por persona**: así el registro de cambios dice quién hizo cada cosa.

Para proteger al jefe, **solo otro jefe** puede crear, cambiar o dar de baja una cuenta de jefe
(nadie más le puede cambiar la contraseña). El primer jefe lo crea el administrador de la central.
Recomendación: cambia la contraseña de la cuenta `admin` y no la uses para el día a día.

Para usar el celular, vincula el celular del jefe con su propia cuenta (botón **Celular** de la
computadora → elige su nombre → **Generar código para vincular**).

---

## En el celular

El jefe tiene cinco pestañas: **Inicio**, **Consultar**, **Movimientos**, **Cotizar** y **Más**.

- **Inicio**: una tarjeta por sucursal con lo vendido hoy (ventas, utilidad, ticket promedio y la
  comparación con el mismo día de la semana pasada a la misma hora), su último corte (toca para verlo),
  lo que deben sus clientes, lo que vale su inventario, cuántos productos están bajo mínimo, agotados,
  en negativo y sin movimiento (toca cualquiera para ver la lista) y cómo van sus inventarios de la
  mañana y de la tarde.
  Abajo, las alertas de la semana (por ejemplo, un inventario en el que faltó algo).
- **Movimientos**: elige el día (hoy, ayer, 7 o 30 días), la sucursal y el tipo. Para ver solo un
  producto, escanéalo o escribe su nombre arriba.
- **Más**: ventas y utilidad, cortes de caja, créditos de clientes (y lo **prestado a otras
  farmacias**), inventario de las sucursales, **revisión semanal**, inventarios, registro de cambios,
  **lista del inventario**, y también **Recibir** y **Contar**.
- Al consultar un producto aparecen las farmacias: toca una para agregar el producto a su lista del
  inventario (o quitarlo).

Los administradores de las sucursales también tienen la pestaña **Movimientos**, solo de su sucursal.

## En la computadora

La pestaña **Movimientos** aparece para los administradores (con los movimientos de su sucursal) y
para el jefe, que además tiene **Resumen** y **Registro de cambios**:

- **Resumen**: lo mismo que el Inicio del celular.
- **Cortes**: los cortes de caja de todas las farmacias por fechas, con lo que faltó o sobró; **Ver**
  muestra el corte completo y **Reimprimir** saca su ticket en la impresora de esa computadora.
- **Créditos**: los clientes que deben en cada farmacia, cuánto, su límite y su última compra y abono;
  abajo, el medicamento **prestado a otras farmacias** que falta que regresen o paguen.
- La pestaña **Reportes** le muestra al jefe las ventas de **todas las farmacias** (con las canceladas
  y quién las canceló). Si no hay internet, muestra solo lo de esa computadora y lo avisa.
- **Movimientos**: fechas, sucursal, tipo, persona y producto. Debajo de los filtros sale cuántos
  movimientos y piezas hubo de cada tipo.
- **Inventarios**: los de la mañana, la tarde y los completos; al elegir uno se ve producto por
  producto lo que decía el sistema, lo que se contó, la diferencia, su valor y el motivo. Abajo se
  arma la **lista del inventario** de cada farmacia.
- **Revisión semanal**: la hoja de la semana (ver abajo).
- **Registro de cambios**: por fechas, sucursal, persona y tipo (por ejemplo, *solo alertas*).

**Alertas**: venta cancelada, corte con faltante, cambio de precio, precio rebajado en una venta,
apoyo que llegó con diferencias o cancelado ya enviado, cambio de rol de un usuario e inventario en el
que faltó algo.

---

## Inventario: la lista de cada farmacia, dos veces al día

Cada farmacia tiene su **lista del inventario**: los productos que se cuentan. **La arma el jefe**, y
**cada día se cuenta dos veces**: en el **turno de la mañana** (de preferencia temprano, al abrir) y en
el **turno de la tarde** (en la tarde-noche, no al último). Se cuenta con el celular, sin ver lo que
dice el sistema; lo que no cuadra se recuenta y se anota el motivo. Al terminar, la existencia queda en
lo que se contó, y **el jefe lo revisa cada semana** en la **Revisión semanal**.

Sustituye a la hoja de Excel: ya no hay que ir restando a mano lo que se vende, porque el sistema lo
descuenta solo con cada escaneo. Si algo se vende sin escanear (o se cobra como artículo común), el
sistema sigue creyendo que está y en el siguiente conteo sale como **faltante**, con el turno, quién
contó y quién estaba cobrando.

### Armar la lista (jefe)

En el celular: **Más → Lista del inventario**. En la computadora: **Movimientos → Inventarios → Lista
del inventario**. Arriba se elige la farmacia; cada una tiene su propia lista.

- **Agregar productos**: búscalos por nombre o código, agrega **un departamento completo**, o **copia
  la lista de otra farmacia** (y luego quita lo que esa no maneje).
- **Desde Consultar** (celular): al escanear un producto aparecen las farmacias; toca una para
  agregarlo a su lista o quitarlo.
- **Quitar**: el botón *Quitar* de cada producto, o *Quitar todos*.
- **La tarde empieza a las…**: la hora en que cambia el turno (14:00 si no se cambia). Cada farmacia
  puede tener la suya.
- La pantalla dice cuántos productos tiene la lista y cuánto tarda contarla (unos 30 segundos por
  producto). Los cambios se ven desde el siguiente turno.

### Inventario completo (todo o un departamento)

Para contar **todos los productos** una sola vez (por ejemplo, al empezar a usar el sistema) o **un
departamento** (un pasillo), en la misma pantalla de la lista elige *Todos los productos* o el
departamento y toca **Empezar**. La farmacia lo ve en **Contar** junto al del turno y lo cuenta igual
(a ciegas, con recuento y motivo). **Queda abierto hasta que lo terminen**, aunque tarde varios días; si
se empezó por error, el jefe lo **cancela**. Solo puede haber uno abierto por farmacia.

### En la sucursal (celular, pestaña Contar)

1. Arriba aparece el inventario del turno (**Inventario de la mañana** o **de la tarde**) y, si el jefe
   empezó uno, el **Inventario completo**. Toca **Empezar** (o **Seguir contando**).
2. Escanea cada producto de la lista (o toca **Contar**) y escribe cuántas piezas hay, contando estante
   y bodega. **No se muestra lo que dice el sistema**: así se cuenta de verdad y no se "confirma".
3. Si cuadra, se palomea. Si no, la app pide **contarlo otra vez**. Si el recuento tampoco cuadra,
   pide el **motivo** (caducado, dañado, no se encontró, se vendió sin registrar, error al recibir…).
4. Al terminar toca **Terminar**. Si faltaron productos, quedan como *no contados*.

En el inventario completo, como la lista es larga, se ve un departamento a la vez (arriba se elige
cuál, con cuántos faltan de cada uno); al escanear un producto, la lista salta a su departamento.
Se puede contar con la farmacia abierta: si se vende algo después de contarlo, el ajuste lo respeta.
El conteo libre de un estante sigue abajo, como antes.

Al **Terminar**, lo que no cuadró se ajusta: la existencia queda en lo que se contó (por la diferencia,
así se respetan las ventas hechas después de contar) y queda en Movimientos como *Conteo*, a nombre de
quien contó. Así el siguiente turno empieza con lo que de verdad hay y no carga con lo que faltó antes.
Si faltó algo, al jefe le llega una **alerta** ese mismo día.

**Si no lo terminan**: el de la mañana se cierra solo al empezar la tarde y el de la tarde al día
siguiente, con lo que se alcanzó a contar (y se ajusta igual).

### Revisión semanal (jefe)

En el celular: **Más → Revisión semanal**. En la computadora: **Movimientos → Revisión semanal**. Se
elige la farmacia y la semana (lunes a domingo; con las flechas se va a la anterior).

- **La hoja**: los productos de la lista en renglones y cada turno en columnas (lunes mañana, lunes
  tarde…), con lo que se contó: **verde** si cuadró, **rojo** si faltó (con cuántas piezas) y **azul**
  si sobró. Pasando el mouse sobre una casilla se ve lo que decía el sistema, el motivo y quién contó.
- **Turnos sin conteo**: arriba, en rojo, los turnos que no se contaron.
- **Debajo de cada turno**: cuánto faltó y sobró (piezas y pesos a costo), quién contó y **quién cobró
  desde el conteo anterior** (cada conteo revisa lo que pasó desde el anterior).
- **Diferencias de la semana**: la lista de todo lo que no cuadró, con su motivo.
- **Descargar (Excel)** (computadora): la misma hoja en un archivo que abre Excel.
- **Marcar la semana como revisada**: queda anotado quién la revisó y cuándo (y en el registro de
  cambios).

Los inventarios que se quedaron *por autorizar* con la versión anterior se siguen revisando como antes
desde **Inventarios** (nadie autoriza lo que él mismo contó).

### El conteo libre y "Ajustar existencia"

Siguen igual: el conteo libre de un estante (Contar, abajo) y *Ajustar existencia* dejan lo contado al
momento y quedan en Movimientos.

---

## Precio cambiado en una venta y préstamos a otras farmacias

- **Doble clic en el precio** de un producto en la venta: se puede poner otro precio (o un % de
  descuento) **solo para esa venta**, como en Eleventa. Lo puede hacer cualquiera, **nunca abajo del
  costo** (con **A costo** se pone el costo de un toque). El precio del producto no cambia. Cada venta
  con precio cambiado queda en el **registro de cambios** (quién, qué producto, de cuánto a cuánto) y,
  si fue rebaja, como **alerta**; el corte dice cuánto se descontó en el turno.
- **Préstamos**: a las farmacias que no son del jefe se les da de alta como **clientes** (con crédito
  si se les fía). En **Clientes → Préstamos** se registra lo que se llevan prestado (sale del
  inventario); **Regresaron** lo vuelve a meter; **Lo van a pagar** lo pasa a la caja a costo (doble
  clic en el precio para cambiarlo) y se cobra al contado o a crédito, sin volver a sacarlo del
  inventario. El jefe ve lo prestado en **Créditos** y cada préstamo en **Movimientos** (tipo
  *Préstamos a otras farmacias*).

---

## Si una farmacia tiene más de una computadora

Cada computadora es una **caja** (Caja 1, Caja 2…) y lleva sus propios folios. En los reportes y en el
ticket de la segunda caja aparece "Caja 2 · folio 25" para que no se confunda con el folio 25 de la
primera. En **Administración → Sincronización** cada computadora dice qué caja es y cuántas ventas le
faltan por subir.

## Para el técnico

- La base central necesita las tablas nuevas: ejecuta `supabase/schema.sql` (agrega la columna
  `jefe` y las tablas `bitacora`, `conteos`, `conteo_detalle`, `conteo_ultimos`, `conteo_config`,
  `conteo_lista` y `conteo_importantes`, todas protegidas; desde la versión 1.0.10, `conteos` lleva
  `turno` y `departamento`, y `conteo_config` la hora de la tarde; desde la 1.0.11, `productos` lleva
  `piezas_caja`, `precio_caja` y `es_coctel`, y `conteo_detalle` `piezas_caja`, ver
  [inyecciones.md](inyecciones.md); desde la 1.0.12, la tabla `prestamos`). Mientras falten, esas pantallas avisan *Falta actualizar
  la base central* y lo demás sigue funcionando.
- Para las ventas, la central necesita además las tablas `cajas`, `ventas`, `venta_detalle`, `cortes`,
  `clientes` y `abonos` (también en `supabase/schema.sql`).
- Después publica otra vez la función `movil` (ver [celular.md](celular.md)), sube la app del celular
  y actualiza el programa de cada computadora (versión 1.0.9 o más nueva).
- Las ventas, cortes y abonos que ya estaban en una computadora antes de instalar la 1.0.8 no se suben
  (eran de prueba); se sube todo lo que se haga desde entonces.
- **Copias de la central**: cada computadora guarda una al día en `respaldos\central` (ver
  [instalacion.md](instalacion.md), sección 4). Para revisar una contra la central:
  `node scripts/restaurar-central.js "ruta\central-AAAA-MM-DD.db.gz"` (solo compara, no escribe). Para
  reponer tablas: `--tablas productos,inventario --aplicar` (o `--tablas todas`); con
  `--borrar-sobrantes` también borra de la central lo que no está en la copia. **Escribir en la central
  solo con autorización del dueño.** Después de `--aplicar` deja un `.sql` para ajustar los contadores de
  ids (correrlo con `supabase db query`). Las copias no llevan contraseñas.
- Para cargar el catálogo desde Eleventa: `node scripts/importar-eleventa.js --fdb "ruta\base.fdb"`
  (muestra qué haría) y luego lo mismo con `--aplicar`. Carga solo los productos con movimientos de
  inventario en el último año, con existencia en 0 en todas las sucursales, y guarda antes un respaldo
  de la central en `respaldos\`.
- El registro de cambios se guarda primero en cada computadora (aunque no haya internet) y se sube
  solo a la central. Empieza a contar desde que se instala esta versión.
- El "día" (inventario del día, ventas de hoy, filtros por fecha) es el de la hora de las farmacias. Cada
  computadora usa su propia hora; la función del celular usa la zona que diga `FARMACIA_ZONA_HORARIA` en
  sus *Secrets* (si no está, la del centro de México). En Sonora va `America/Hermosillo`.
