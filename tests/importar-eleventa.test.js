'use strict';
// Carga del catálogo de Eleventa: qué productos entran (los que tuvieron movimientos de inventario
// recientes), cómo se guardan y que se pueda correr dos veces sin duplicar nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { iniciarCentralFalsa, sembrarBase } = require('./helpers/central-falsa');
const { SUCURSALES } = require('./helpers/escenario');
const { leerExportacion, seleccionar, desdePorDefecto, cargarEnCentral, existenciaDespues } = require('../scripts/importar-eleventa');

// Como lo escribe isql de Eleventa: "#campos#" rellenos de espacios
const renglon = (campos) => `#${campos.join('|')}#${' '.repeat(40)}`;
const PRODUCTOS = [
  renglon(['7501000000101', 'PARACETAMOL 500MG  C/10', 'U', '14.5000', '28.0000', '25.0000', 'GENERICO', '3.0000', '2026-10-11']),
  renglon(['7501000000202', 'IBUPROFENO | 400MG', 'U', '12.0000', '30.0000', '30.0000', 'PATENTE', '1.0000', '']),
  renglon(['7501000000303', 'CREMA QUE YA NO SE VENDE', 'U', '20.0000', '45.0000', '0.0000', 'HIGIENE', '1.0000', '']),
  renglon(['7501000000404', 'NO USA INVENTARIO', 'U', '5.0000', '9.0000', '0.0000', 'ABARROTES', '0.0000', '']),
  renglon([' 7501000000505', 'SUERO (VIEJO)', 'U', '10.0000', '20.0000', '0.0000', 'PATENTE', '0.0000', '']),
  renglon(['7501000000505', 'SUERO ORAL 625ML', 'U', '11.0000', '22.0000', '0.0000', 'PATENTE', '2.0000', '']),
].join('\r\n');
const HISTORIAL = [
  renglon(['1', '7501000000303', '2024-02-01 10:00:00.0000', 's', '5.0000', '1.0000']),
  renglon(['2', '7501000000101', '2026-09-01 10:00:00.0000', 'a', '2.0000', '10.0000']),
  renglon(['3', '7501000000101', '2026-10-10 10:00:00.0000', 's', '10.0000', '3.0000']),
  renglon(['4', '7501000000202', '2026-10-15 21:00:00.0000', 'e', '1.0000', '4.0000']),
  renglon(['5', '7501000000505', '2026-06-01 09:00:00.0000', 's', '8.0000', '1.0000']),
].join('\r\n');

test('del archivo de Eleventa entran solo los productos con movimientos recientes', () => {
  assert.equal(existenciaDespues('a', 2, 10), 10);
  assert.equal(existenciaDespues('s', 10, 3), 7);
  assert.equal(existenciaDespues('e', 1, 4), 5);
  const productos = leerExportacion({ productosTexto: PRODUCTOS, historialTexto: HISTORIAL });
  assert.equal(productos.length, 6);
  const ibu = productos.find((p) => p.codigo === '7501000000202');
  assert.equal(ibu.descripcion, 'IBUPROFENO | 400MG', 'la descripción puede traer "|"');
  assert.equal(productos.find((p) => p.codigo === '7501000000101').existencia_eleventa, 7);
  assert.equal(desdePorDefecto(productos), '2025-10-15', 'un año antes del último movimiento');

  const { productos: elegidos, descartados } = seleccionar(productos, { desde: '2025-10-15' });
  assert.deepEqual(elegidos.map((p) => p.codigo).sort(), ['7501000000101', '7501000000202', '7501000000505']);
  assert.equal(elegidos.find((p) => p.codigo === '7501000000505').descripcion, 'SUERO ORAL 625ML', 'del código repetido queda uno');
  assert.equal(descartados.sin_movimientos, 3, 'la crema vieja, el que no usa inventario y el código con espacio');
});

test('el catálogo se carga en la central con existencia en 0 y se puede repetir', async (t) => {
  const central = await iniciarCentralFalsa();
  t.after(() => central.cerrar());
  sembrarBase(central.db, { sucursales: SUCURSALES, departamentos: [{ nombre: 'PATENTE' }] });
  central.db.prepare("INSERT INTO productos (codigo_barras, descripcion, precio_venta) VALUES ('7501000000202', 'Ibuprofeno ya cargado', 31)").run();
  const supabase = createClient(central.url, central.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { productos } = seleccionar(leerExportacion({ productosTexto: PRODUCTOS, historialTexto: HISTORIAL }), { desde: '2025-10-15' });

  const vistaPrevia = await cargarEnCentral(supabase, productos, { aplicar: false });
  assert.deepEqual([vistaPrevia.productos_nuevos, vistaPrevia.ya_estaban, vistaPrevia.departamentos_nuevos], [2, 1, 1]);
  assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM productos').get().n, 1, 'la vista previa no toca nada');

  const r = await cargarEnCentral(supabase, productos, { aplicar: true, desde: '2025-10-15' });
  assert.equal(r.productos_cargados, 2);
  const para = central.db.prepare("SELECT * FROM productos WHERE codigo_barras = '7501000000101'").get();
  assert.deepEqual([para.descripcion, para.precio_costo, para.precio_venta, para.precio_mayoreo, para.cantidad_mayoreo, para.usa_inventario, para.departamento],
    ['PARACETAMOL 500MG C/10', 14.5, 28, 25, null, 1, 'GENERICO']);
  assert.equal(central.db.prepare("SELECT precio_mayoreo FROM productos WHERE codigo_barras = '7501000000505'").get().precio_mayoreo, null);
  assert.equal(central.db.prepare("SELECT descripcion FROM productos WHERE codigo_barras = '7501000000202'").get().descripcion, 'Ibuprofeno ya cargado', 'lo que ya estaba no se toca');
  const inventario = central.db.prepare('SELECT sucursal_id, existencia, minimo FROM inventario WHERE producto_id = ? ORDER BY sucursal_id').all(para.id);
  assert.deepEqual(inventario.map((f) => [f.sucursal_id, f.existencia, f.minimo]), [[1, 0, 3], [2, 0, 0], [3, 0, 0]], 'mínimos solo en la central');
  assert.deepEqual(central.db.prepare('SELECT nombre FROM departamentos ORDER BY nombre').all().map((d) => d.nombre), ['GENERICO', 'PATENTE']);
  assert.match(central.db.prepare("SELECT descripcion FROM bitacora WHERE tipo = 'producto_alta'").get().descripcion, /Catálogo cargado desde Eleventa: 2 productos/);

  const otraVez = await cargarEnCentral(supabase, productos, { aplicar: true });
  assert.equal(otraVez.productos_nuevos, 0);
  assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM productos').get().n, 3);
  assert.equal(central.db.prepare('SELECT COUNT(*) AS n FROM inventario').get().n, 6);
});
