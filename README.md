# Farmacia POS

Sistema de punto de venta para farmacias, inspirado en Eleventa / Mi Abarrotes, con soporte
multi-sucursal (3 farmacias, una central como administradora).

## Cómo arrancarlo

```
npm install   (solo la primera vez)
npm start
```

Luego abre en el navegador: **http://localhost:3000**

Usuario inicial: **admin** / contraseña: **admin**
(cámbiala en Administración → Usuarios en cuanto entres).

## Módulos

- **Venta (F2)** — pantalla principal. Escanea el código de barras o escribe y presiona Enter.
  - `3*código` agrega 3 piezas de golpe.
  - **F3** busca producto por nombre, **F12** cobra, **F4** cancela la venta, **Supr** quita el renglón seleccionado.
  - Cobro en efectivo (calcula cambio), tarjeta o crédito (fiado) con cliente.
  - Imprime ticket en impresora térmica (72 mm) con `window.print`.
- **Productos (F5)** — catálogo con precios de costo/venta/mayoreo y existencia en las 3 sucursales
  (cada sucursal ve el inventario de las otras). Entradas, salidas, ajustes y alerta de bajo mínimo.
- **Clientes (F6)** — crédito/fiado con límite, estado de cuenta y abonos.
- **Corte (F7)** — corte de caja: efectivo esperado (fondo + ventas + abonos) contra efectivo contado.
- **Reportes (F8)** — total vendido, ganancia, por día, por sucursal y productos más vendidos.
- **Administración** (solo rol admin) — usuarios (cajero/administrador por sucursal) y sucursales.

## Estructura

- `server.js` — servidor Express.
- `src/db.js` — esquema SQLite (archivo `farmacia.db`, se crea solo).
- `src/routes/` — API: productos, ventas, clientes, cortes, reportes, admin.
- `public/` — interfaz web (HTML/CSS/JS sin frameworks).

## Multi-sucursal

Cada usuario pertenece a una sucursal; sus ventas, inventario y cortes se registran ahí.
Para que las 3 farmacias trabajen juntas, el sistema debe instalarse en un servidor con
internet (VPS o servicio en la nube) y cada farmacia entra desde el navegador.
