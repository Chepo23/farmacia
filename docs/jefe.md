# Cuenta de jefe: ventas, movimientos e inventario del día

La cuenta **Jefe** es para el dueño o los encargados generales (jefe o jefa). Hace todo lo que hace el
administrador de la central y además ve, desde el celular o la computadora:

- **Movimientos de inventario** de todas las sucursales, como en Eleventa: entradas, salidas, ventas,
  ajustes, apoyos y conteos, con cuánto había, cuánto quedó, quién lo hizo y la nota.
- **Registro de cambios**: quién cambió un precio (antes y después), quién dio de alta o de baja un
  producto o un usuario, ventas canceladas, cortes de caja, salidas de efectivo, apoyos y cotizaciones.
- **Inventario de cada sucursal**: lo que vale (a costo y a precio de venta), lo que está bajo mínimo,
  agotado, en negativo y lo que no se ha movido en 60 días (dinero detenido).
- **Inventario del día**: el avance de cada sucursal, cuánto cuadró y las diferencias que tiene que
  autorizar.
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
  en negativo y sin movimiento (toca cualquiera para ver la lista) y cómo va su inventario del día.
  Arriba, en rojo, los inventarios por autorizar; abajo, las alertas de la semana.
- **Movimientos**: elige el día (hoy, ayer, 7 o 30 días), la sucursal y el tipo. Para ver solo un
  producto, escanéalo o escribe su nombre arriba.
- **Más**: ventas y utilidad, cortes de caja, créditos de clientes, inventario de las sucursales,
  inventarios del día (y autorizar), registro de cambios, productos por día, y también **Recibir** y
  **Contar**.
- Al consultar un producto aparece **Marcar como importante**: los importantes (controlados,
  antibióticos, los más caros) se cuentan más seguido en el inventario del día.

Los administradores de las sucursales también tienen la pestaña **Movimientos**, solo de su sucursal.

## En la computadora

La pestaña **Movimientos** aparece para los administradores (con los movimientos de su sucursal) y
para el jefe, que además tiene **Resumen** y **Registro de cambios**:

- **Resumen**: lo mismo que el Inicio del celular.
- **Cortes**: los cortes de caja de todas las farmacias por fechas, con lo que faltó o sobró; **Ver**
  muestra el corte completo y **Reimprimir** saca su ticket en la impresora de esa computadora.
- **Créditos**: los clientes que deben en cada farmacia, cuánto, su límite y su última compra y abono.
- La pestaña **Reportes** le muestra al jefe las ventas de **todas las farmacias** (con las canceladas
  y quién las canceló). Si no hay internet, muestra solo lo de esa computadora y lo avisa.
- **Movimientos**: fechas, sucursal, tipo, persona y producto. Debajo de los filtros sale cuántos
  movimientos y piezas hubo de cada tipo.
- **Inventario del día**: la lista de inventarios; al elegir uno se ve producto por producto lo que
  decía el sistema, lo que se contó, la diferencia, su valor y el motivo. Aquí también se autoriza
  y se cambian los **productos por día**.
- **Registro de cambios**: por fechas, sucursal, persona y tipo (por ejemplo, *solo alertas*).

**Alertas**: venta cancelada, corte con faltante, cambio de precio, apoyo que llegó con diferencias
o cancelado ya enviado, cambio de rol de un usuario e inventario del día con faltante de $200 o más.

---

## Inventario del día

En lugar de revisar tablas, **cada día el sistema arma una lista corta por sucursal** (40 productos
si no se cambia), ordenada por departamento. Lo que no cuadra se recuenta, se anota el motivo y un jefe
lo autoriza. Así todo el inventario pasa por un conteo cada cierto tiempo sin parar la farmacia.

**Quién entra a la lista** (en este orden): lo que tiene existencia negativa, lo que no cuadró en su
último conteo y lo marcado como importante (entre los tres, a lo mucho tres cuartos de la lista). El
resto, la mitad lo que se movió desde su último conteo y la mitad lo que lleva más tiempo sin
contarse, para que todo pase por turno.

### En la sucursal (celular, pestaña Contar)

1. Arriba aparece **Inventario del día**: toca **Empezar** (o **Seguir contando**).
2. Escanea cada producto de la lista (o toca **Contar**) y escribe cuántas piezas hay, contando estante
   y bodega. **No se muestra lo que dice el sistema**: así se cuenta de verdad y no se "confirma".
3. Si cuadra, se palomea. Si no, la app pide **contarlo otra vez**. Si el recuento tampoco cuadra,
   pide el **motivo** (caducado, dañado, no se encontró, se vendió sin registrar, error al recibir…).
4. Al terminar toca **Terminar el inventario del día**. Si faltaron productos, quedan para otro día.

Se puede contar con la farmacia abierta: si se vende algo después de contarlo, el ajuste lo respeta.
El conteo libre de un estante sigue abajo, como antes.

### El jefe autoriza

En **Inicio** (celular) o **Movimientos → Inventario del día** (computadora) abre el inventario por
autorizar, marca las diferencias y toca:

- **Aprobar ajuste**: el inventario se corrige por la diferencia y queda en Movimientos como *Conteo*.
- **Rechazar**: el inventario no se toca y el producto vuelve a entrar a la lista otro día.

**Nadie autoriza lo que él mismo contó**: si el jefe contó algo, lo autoriza otro jefe.
Si nadie termina el inventario, se cierra solo al día siguiente con lo que se alcanzó a contar.

### Productos por día

En **Más → Productos por día** (celular) o en **Inventario del día** (computadora). Con más productos
se revisa todo más seguido, pero tarda más: calcula unos 20 minutos por cada 40 productos. El cambio
se nota en la lista del día siguiente.

---

## Si una farmacia tiene más de una computadora

Cada computadora es una **caja** (Caja 1, Caja 2…) y lleva sus propios folios. En los reportes y en el
ticket de la segunda caja aparece "Caja 2 · folio 25" para que no se confunda con el folio 25 de la
primera. En **Administración → Sincronización** cada computadora dice qué caja es y cuántas ventas le
faltan por subir.

## Para el técnico

- La base central necesita las tablas nuevas: ejecuta `supabase/schema.sql` (agrega la columna
  `jefe` y las tablas `bitacora`, `conteos`, `conteo_detalle`, `conteo_ultimos`, `conteo_config` y
  `conteo_importantes`, todas protegidas). Mientras falten, esas pantallas avisan *Falta actualizar
  la base central* y lo demás sigue funcionando.
- Para las ventas, la central necesita además las tablas `cajas`, `ventas`, `venta_detalle`, `cortes`,
  `clientes` y `abonos` (también en `supabase/schema.sql`).
- Después publica otra vez la función `movil` (ver [celular.md](celular.md)), sube la app del celular
  y actualiza el programa de cada computadora (versión 1.0.8 o más nueva).
- Las ventas, cortes y abonos que ya estaban en una computadora antes de instalar la 1.0.8 no se suben
  (eran de prueba); se sube todo lo que se haga desde entonces.
- Para cargar el catálogo desde Eleventa: `node scripts/importar-eleventa.js --fdb "ruta\base.fdb"`
  (muestra qué haría) y luego lo mismo con `--aplicar`. Carga solo los productos con movimientos de
  inventario en el último año, con existencia en 0 en todas las sucursales, y guarda antes un respaldo
  de la central en `respaldos\`.
- El registro de cambios se guarda primero en cada computadora (aunque no haya internet) y se sube
  solo a la central. Empieza a contar desde que se instala esta versión.
- Las fechas del inventario del día y de los filtros usan la hora del centro de México. Si alguna vez
  hiciera falta otra zona, se pone la misma `FARMACIA_ZONA_HORARIA` en los *Secrets* de la función y
  en el `.env` de las computadoras.
