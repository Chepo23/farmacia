# Arquitectura recomendada para inventario compartido entre sucursales

## Objetivo

Compartir el inventario y los apoyos entre sucursales sin depender de un archivo SQLite compartido ni de llamadas manuales por Excel.

Esta solución está pensada para un entorno con sucursales alejadas, sin misma LAN y con necesidad de operar aunque haya cortes de internet.

## Problema actual

La app actual crea la base de datos local en cada equipo usando la ruta local de la aplicación:

- [src/db.js](../src/db.js)

Eso hace que cada computadora tenga su propia copia de `farmacia.db`. Por lo tanto:

- un equipo escribe usuarios, productos o inventario localmente,
- otro equipo no ve esos cambios,
- el sistema no funciona como inventario compartido real.

## Arquitectura recomendada

### 1) Base central

Usar PostgreSQL en un servidor central (VPS, nube o equipo dedicado).

Funciones:

- guardar catálogo maestro de productos,
- consolidar inventario general,
- manejar apoyos y pedidos,
- servir datos a sucursales cuando haya conexión,
- registrar sincronización y conflictos.

### 2) Base local en cada sucursal

Cada sucursal mantiene SQLite local para operar sin internet.

Funciones:

- vender en local,
- consultar inventario local,
- crear pedidos y apoyos,
- guardar cambios pendientes por sincronizar.

### 3) Sincronización offline-first

Cuando hay internet, la sucursal envía:

- productos actualizados,
- movimientos de inventario,
- apoyos creados,
- estado de recepciones,
- cambios de stock.

La central responde con:

- stock actualizado,
- catálogo maestro,
- apoyos recibidos,
- confirmaciones de sincronización.

---

## Modelo de datos recomendado

### Productos

La tabla actual de productos ya sirve como catálogo base:

- `productos`
  - `id`
  - `codigo_barras`
  - `descripcion`
  - `departamento`
  - `precio_costo`
  - `precio_venta`
  - `precio_mayoreo`
  - `usa_inventario`
  - `activo`

### Inventario por sucursal

La tabla actual `inventario` ya está muy cerca del modelo correcto:

- `inventario`
  - `producto_id`
  - `sucursal_id`
  - `existencia`
  - `minimo`

Esto permite que cada sucursal tenga su propio stock sin mezclar todo en una sola base.

### Apoyos

La estructura ya existente de `apoyos`, `apoyo_detalle`, `pedidos` y `pedido_detalle` ya está alineada con tu flujo de negocio:

- una sucursal pide faltante,
- la central prepara apoyo,
- la central envía mercancía,
- la sucursal recibe,
- queda trazado quién pidió y quién surtió.

---

## Reglas de sincronización

Cada registro debe tener:

- `id` local o global
- `sucursal_id`
- `created_at`
- `updated_at`
- `sync_state` (`pendiente`, `sincronizado`, `conflicto`)
- `sync_version`

Esto evita sobrescribir datos si dos sucursales cambian lo mismo al mismo tiempo.

### Regla principal

- cada sucursal escribe solo sobre su propio stock local,
- la central es la autoridad del catálogo y del stock consolidado,
- la sincronización nunca debe borrar cambios locales sin validación.

---

## Flujo de negocio recomendado

### Caso 1: Consulta de inventario entre sucursales

- la sucursal A consulta el stock disponible de productos,
- la app usa la base local si la central no está disponible,
- si hay conexión, consulta el stock consolidado de la central,
- la respuesta se muestra con la sucursal de origen y la cantidad disponible.

### Caso 2: Pedido o apoyo

1. Sucursal A crea un pedido o apoyo.
2. El dato queda guardado localmente.
3. La app intenta sincronizar con la central.
4. La central recibe el apoyo y lo procesa.
5. La central asigna surtido y confirma la recepción.
6. La sucursal marca el apoyo como sincronizado.

### Caso 3: Sin internet

- la sucursal sigue operando con el SQLite local,
- el flujo de apoyo se guarda como pendiente,
- al restaurarse la conexión se reintenta la sincronización,
- la central revalida la disponibilidad del inventario.

---

## Datos que conviene sincronizar primero

Prioridad 1:

- productos
- inventario por sucursal
- apoyos
- pedidos
- movimientos

Prioridad 2:

- usuarios de sucursal
- auditoría
- historial de ventas y cortes

No conviene empezar por clientes, usuarios y pagos complejos si el objetivo inicial es inventario compartido.

---

## Recomendación práctica para este proyecto

Para este proyecto te conviene hacer lo siguiente:

1. mantener la estructura actual de `productos`, `inventario`, `pedidos`, `apoyos`;
2. añadir una capa de sincronización con estados y timestamps;
3. dejar la central como autoridad del stock compartido;
4. usar SQLite local en cada sucursal para trabajo offline;
5. centralizar la sincronización con una API REST y PostgreSQL.

---

## Siguiente paso para implementarlo

Se puede empezar con:

- tablas de control de sincronización,
- endpoints para exportar cambios pendientes,
- endpoints para importar cambios desde la central,
- una cola simple de sincronización por `sync_state`.

Eso deja el sistema listo para expandir sin reescribir toda la app.
