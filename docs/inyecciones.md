# Inyecciones: cócteles y venta por caja

Desde la versión 1.0.11. Resuelve dos cosas que pasan con las inyecciones:

1. Hay ampolletas que llegan en caja con un solo código (el de la caja) y se venden sueltas.
2. El **cóctel** (varias ampolletas para una sola inyección) tiene su propio precio, distinto a la suma
   de las ampolletas por separado, y cada ampolleta puede ser de una marca distinta.

En los dos casos el inventario se lleva **en piezas** (ampolletas, jeringas, agujas) y descuenta
exactamente lo que se usó.

---

## Lo que llega en caja y se vende suelto

Ejemplo: ketorolaco, caja con 3 ampolletas, un solo código de barras.

**Darlo de alta o corregirlo (central):** en **Productos → Editar**:

- **Precio de venta**: el de **una ampolleta suelta** (ej. $30).
- **Piezas por caja**: cuántas trae la caja (ej. 3).
- **Precio de la caja completa**: lo que cuesta la caja cerrada (ej. $80).

**Ojo con la existencia que ya tenía:** desde que se le ponen piezas por caja, su existencia se cuenta
en **piezas**. Si estaba en cajas (por ejemplo, venía así de Eleventa), corrígela: 4 cajas = 12 piezas
(Productos → Inventario → Ajuste). Lo más fácil es pedir un **inventario completo** del departamento de
inyectables después de poner las cajas.

**En la caja (venta):**

- Se escanea el código de la caja y entra **una ampolleta suelta** a su precio.
- Para vender la **caja completa**, toca en ese renglón **Vender caja c/3 · $80**. El renglón queda en
  cajas (la cantidad son cajas) y descuenta las 3 piezas. Para regresarlo a suelta toca **Vender suelta**.
- Si se lleva una caja y una suelta, escanea otra vez: la suelta queda en otro renglón.
- La existencia se revisa en piezas: con 4 ampolletas no deja vender 2 cajas (serían 6).

**Al recibir con el celular:** cada escaneo de la caja suma **sus 3 piezas**; los botones **+** y **−**
suben o bajan de caja en caja. Con *Preguntar la cantidad al escanear*, pregunta **cuántas cajas** llegaron.

**Al contar (inventario):** se cuentan **piezas**, no cajas: 2 cajas cerradas y 1 ampolleta suelta = 7.
La app lo recuerda en esos productos (*caja c/3: cuenta piezas*).

**Abrir una caja nueva** cuando se acaban las sueltas no se registra en ningún lado: el sistema ya lleva
las piezas, así que no hay nada que ajustar.

Lo que trae **una sola ampolleta con su propio código** (como la dexametasona) es un producto normal:
no se le pone caja.

---

## Cócteles

### Darlos de alta (una sola vez, la central)

En **Productos → Nuevo producto**:

1. **Descripción**: el nombre del cóctel, por ejemplo *Cóctel ceftriaxona*.
2. **Precio de venta**: el precio del cóctel. Incluye la jeringa y la aguja; la aplicación no se cobra.
3. Marca **Es un cóctel de inyección**. No lleva código de barras ni inventario.

Los dos de siempre:

| Cóctel | Lleva | Precio |
| --- | --- | --- |
| Cóctel ceftriaxona | ceftriaxona + dexametasona + eucaliptine (+ jeringa y aguja) | $200 |
| Cóctel lincomicina | lincomicina + dexametasona + eucaliptine (+ jeringa y aguja) | $150 |

El cóctel **es un producto más** del catálogo (aparece en Productos y en la búsqueda F3 con la marca
*Cóctel*); lo único distinto es cómo se cobra. El sistema no trae cócteles: los da de alta la central.
El precio del cóctel se cambia como cualquier precio (Productos → Editar, o desde el celular del jefe).
Solo la central da de alta o cambia cócteles.

### Cobrarlo en la caja

1. Escanea lo que se usó: las ampolletas **de la marca que sean** (AMCEF o XENTRIAC, AMSA o ALIN…),
   la **jeringa** (3, 5 o 10 ml) y la **aguja** si se usó.
2. Toca el botón **Cóctel (F10)** del panel de la derecha de la venta (debajo de *Artículo común*), o la
   tecla **F10**. No está en la barra de arriba: es un botón más de la venta, como *Buscar producto (F3)*.
3. Elige el cóctel (o las teclas **1**, **2**). Si lo escaneado dice *ceftriaxona* o *lincomicina*,
   ya viene elegido.
4. Deja marcado lo que lleva la inyección. **Desmarca** lo que el cliente se lleva aparte (eso se cobra
   a su precio normal). La ventana muestra cuánto sería por separado y cuánto como cóctel.
5. **Enter**. En la venta aparece **Cóctel ceftriaxona $200.00** con lo que lleva debajo.
   **Quitar cóctel** lo deshace.
6. Cobra como siempre (**F12**). El ticket dice *Cóctel ceftriaxona $200.00* e *Incluye: …*.

Si un cóctel lleva **una ampolleta de más** (pasa poco), desmárcala en el paso 4 y se cobra aparte.

### Qué pasa con el inventario y los reportes

- El inventario descuenta **exactamente** lo que se escaneó. Si se cancela la venta, todo regresa.
- En los reportes cada ampolleta aparece con **su parte** del precio del cóctel (repartido según su
  precio normal), así la utilidad sale bien. En la central la descripción dice *(Cóctel ceftriaxona)*.
- El historial de ventas marca cada renglón con su cóctel.

---

## Para el técnico

- La base central necesita las columnas `productos.piezas_caja`, `productos.precio_caja`,
  `productos.es_coctel` y `conteo_detalle.piezas_caja` (ya están en `supabase/schema.sql`).
- El orden para actualizar: **1)** la base central, **2)** la función `movil`, **3)** la app del
  celular y **4)** el programa de cada computadora (1.0.11). Las computadoras con versiones anteriores
  siguen funcionando con la base ya actualizada.
- La venta manda cada renglón con `caja: true` (cantidad en cajas) o con `coctel: { id, grupo }`; el
  servidor pone los precios, reparte el del cóctel y revisa la existencia en piezas.
