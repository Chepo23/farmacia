# Migración sugerida a PostgreSQL para inventario compartido

## Objetivo

Dejar la parte del proyecto que sí puede implementarse hoy para soportar farmacias alejadas sin depender de una base común local.

## Arquitectura recomendada

### Central

- PostgreSQL como base maestra de la red.
- La central es la autoridad del inventario compartido.
- Todas las consultas entre sucursales pasan por la central.

### Sucursal

- SQLite local para funcionamiento sin internet.
- Cada sucursal guarda ventas, inventario local y pendientes de sincronización.
- Cuando hay internet, sincroniza con la central.

---

## Lo que debes implementar tú en el servidor central

1. Instala PostgreSQL.
2. Crea la base de datos `farmacia_central`.
3. Ejecuta el archivo SQL en `sql/postgres-central.sql`.
4. Configura la variable `DATABASE_URL` en tu entorno.
5. Crea una API de sincronización para aceptar cambios desde cada sucursal.
6. Crea endpoints para:
   - `/api/sync/push`
   - `/api/sync/pull`
   - `/api/inventario/global`
   - `/api/mini-apoyos/:id/aceptar`
   - `/api/mini-apoyos/:id/rechazar`

---

## Flujos que debe soportar la central

### 1) Consulta global de inventario

La central debe responder algo como:

- producto X disponible en central
- producto X disponible en sucursal A
- producto X disponible en sucursal B
- total disponible global

### 2) Mini apoyo / reconciliación

Si una sucursal dice que tiene stock y la central no, la central hace lo siguiente:

- valida que la sucursal origen tenga el stock real,
- marca el registro como pendiente,
- acepta o rechaza el mini apoyo,
- actualiza inventario de origen y destino,
- registra el movimiento en `movimientos_inventario`.

### 3) Sincronización local → central

Cada sucursal debe mandar a la central lo que cambió:

- productos nuevos o actualizados,
- movimientos inventario,
- mini apoyos pendientes,
- pedidos enviados,
- cambios de stock.

### 4) Sincronización central → sucursal

La central debe devolver:

- catálogo actualizado,
- stock de la sucursal,
- mini apoyos pendientes,
- cambios aceptados por la central,
- conflicto de sincronización si aplica.

---

## Reglas de negocio para no perder consistencia

- La central es la autoridad del inventario compartido.
- Cada sucursal puede operar localmente sin internet.
- Los cambios locales deben quedar en `sync_estado` con `pendiente`.
- Si hay conflicto, debe registrarse en `sync_conflictos`.
- La central debe validar stock antes de aceptar mini apoyos.

---

## Qué ya quedó hecho en este proyecto

Se dejó la base del flujo en:

- [src/db.js](../src/db.js)
- [src/routes/productos.js](../src/routes/productos.js)
- [docs/inventario-compartido.md](../docs/inventario-compartido.md)

Esto ya incluye:

- soporte de sincronización local (`sync_estado`)
- mini apoyos (`mini_apoyos`)
- consulta global de inventario
- aceptación y rechazo de mini apoyos

---

## Lo que tú debes hacer ahora

1. Instalar PostgreSQL.
2. Crear la base `farmacia_central`.
3. Ejecutar `sql/postgres-central.sql`.
4. Configurar `.env` con `DATABASE_URL`.
5. Crear la API de sincronización central con `pg`.
6. En cada sucursal, dejar que `sync_estado` envie cambios a la central.
7. Implementar la sincronización por lotes cuando haya internet.

---

## Recomendación final

Para tu negocio, esta sí es la arquitectura que te conviene:

- PostgreSQL central
- SQLite local en cada sucursal
- trabajo offline en cada farmacia
- central como autoridad del inventario compartido

Eso te da el flujo que tú estás describiendo: stock compartido, mini apoyos, consultas cross-sucursal, y eliminación del Excel.
