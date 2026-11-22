'use strict';
// Revisión semanal del inventario (la hoja que antes se llevaba en Excel): los productos de la lista
// en renglones y cada conteo (día y turno) en columnas; qué turnos no se contaron, quién contó, quién
// cobró entre un conteo y otro, y el jefe marca la semana como revisada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { escenarioCentral, entrar } = require('../helpers/escenario');
const { crearNube } = require('../helpers/nube');

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

test('revisión semanal del inventario', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  const db = central.db;
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const laura = Number((await admin.post('/api/admin/usuarios', { nombre: 'Laura Jefa', usuario: 'laura', password: 'jefa1234', rol: 'jefe', sucursal_id: 1 })).body.id);
  const tarde = Number((await admin.post('/api/admin/usuarios', { nombre: 'Cajera Tarde', usuario: 'tarde2', password: '1234', rol: 'cajero', sucursal_id: 2 })).body.id);
  const jefa = await entrar(servidores.central.base, 'laura', 'jefa1234', { caja: false });
  const para = (await admin.post('/api/productos', { codigo_barras: '7501000000101', descripcion: 'Paracetamol 500 mg', departamento: 'Analgésicos', precio_costo: 10, precio_venta: 25 })).body.id;
  const ibu = (await admin.post('/api/productos', { codigo_barras: '7501000000202', descripcion: 'Ibuprofeno 400 mg', departamento: 'Analgésicos', precio_costo: 12, precio_venta: 30 })).body.id;

  // Una semana pasada de la Sucursal Norte (del lunes 2 al domingo 8 de noviembre): el conteo de la
  // tarde anterior, lunes mañana y tarde, el martes no se contó, miércoles mañana
  const conteo = (fecha, turno) => Number(db.prepare(
    "INSERT INTO conteos (sucursal_id, fecha, turno, estado, productos, contados) VALUES (2, ?, ?, 'cerrado', 2, 2)"
  ).run(fecha, turno).lastInsertRowid);
  const renglon = (conteoId, productoId, { contado, sistema, quien, hora, motivo = '' }) => {
    const descripcion = productoId === para ? 'Paracetamol 500 mg' : 'Ibuprofeno 400 mg';
    const cuadra = contado != null && contado === sistema;
    db.prepare(
      `INSERT INTO conteo_detalle (conteo_id, sucursal_id, producto_id, descripcion, departamento, costo, contado, existencia_sistema,
         diferencia, reconteos, motivo, contado_por, contado_fecha, decision)
       VALUES (?, 2, ?, ?, 'Analgésicos', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(conteoId, productoId, descripcion, productoId === para ? 10 : 12, contado ?? null, contado == null ? null : sistema,
      contado == null ? null : contado - sistema, cuadra || contado == null ? 0 : 1, motivo, contado == null ? null : quien, hora,
      contado == null ? 'no_contado' : cuadra ? 'cuadra' : 'aprobado');
  };
  const previo = conteo('2026-10-31', 'tarde');
  renglon(previo, para, { contado: 10, sistema: 10, quien: tarde, hora: '2026-11-01T01:00:00.000Z' });
  const lunesManana = conteo('2026-11-02', 'manana');
  renglon(lunesManana, para, { contado: 10, sistema: 10, quien: 2, hora: '2026-11-02T15:00:00.000Z' });
  renglon(lunesManana, ibu, { contado: 5, sistema: 6, quien: 2, hora: '2026-11-02T15:05:00.000Z', motivo: 'Se rompió' });
  const lunesTarde = conteo('2026-11-02', 'tarde');
  renglon(lunesTarde, para, { contado: 8, sistema: 9, quien: tarde, hora: '2026-11-03T01:00:00.000Z', motivo: 'No se encontró' });
  renglon(lunesTarde, ibu, { contado: 5, sistema: 5, quien: tarde, hora: '2026-11-03T01:02:00.000Z' });
  const miercoles = conteo('2026-11-04', 'manana');
  renglon(miercoles, para, { contado: 8, sistema: 8, quien: 2, hora: '2026-11-04T15:00:00.000Z' });
  renglon(miercoles, ibu, { contado: null, sistema: null, quien: null, hora: null });

  // Ventas de la central en esos días (quién cobró entre un conteo y el siguiente)
  const caja = Number(db.prepare("INSERT INTO cajas (clave, sucursal_id, numero) VALUES ('caja-norte', 2, 1)").run().lastInsertRowid);
  let folio = 0;
  const venta = (usuario, fecha, cancelada = 0) => {
    folio += 1;
    db.prepare(
      `INSERT INTO ventas (clave, caja_id, sucursal_id, venta_local_id, folio, usuario_id, forma_pago, total, fecha, cancelada)
       VALUES (?, ?, 2, ?, ?, ?, 'efectivo', 50, ?, ?)`
    ).run(`v-${folio}`, caja, folio, folio, usuario, fecha, cancelada);
  };
  venta(2, '2026-10-31T20:00:00.000Z'); // antes del conteo anterior: no cuenta
  venta(2, '2026-11-02T17:00:00.000Z');
  venta(2, '2026-11-02T18:00:00.000Z');
  venta(2, '2026-11-02T19:00:00.000Z', 1); // cancelada: no cuenta
  venta(tarde, '2026-11-02T23:00:00.000Z');
  venta(tarde, '2026-11-03T02:00:00.000Z');

  let hoja;
  await t.test('la hoja de la semana: conteos en columnas, productos en renglones', async () => {
    assert.equal((await admin.get('/api/conteos/semana?sucursal_id=2')).status, 403, 'solo el jefe');
    const r = await jefa.get('/api/conteos/semana?sucursal_id=2&desde=2026-11-04');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    hoja = r.body;
    assert.deepEqual([hoja.sucursal, hoja.desde, hoja.hasta, hoja.revisada], ['Sucursal Norte', '2026-11-02', '2026-11-08', null]);
    assert.deepEqual(hoja.conteos.map((c) => [c.fecha, c.turno]), [['2026-11-02', 'manana'], ['2026-11-02', 'tarde'], ['2026-11-04', 'manana']]);
    assert.deepEqual(hoja.conteos.map((c) => c.contaron), [['Cajero Norte'], ['Cajera Tarde'], ['Cajero Norte']]);
    assert.deepEqual(hoja.conteos.map((c) => (c.cobraron || []).map((x) => [x.usuario, x.ventas])),
      [[], [['Cajero Norte', 2], ['Cajera Tarde', 1]], [['Cajera Tarde', 1]]],
      'cada conteo revisa lo que pasó desde el anterior: quién cobró en ese tiempo (sin las canceladas)');
    assert.deepEqual(hoja.conteos.map((c) => [c.piezas_faltan, c.faltante, c.con_diferencia]), [[1, 12, 1], [1, 10, 1], [0, 0, 0]]);
    assert.equal(hoja.conteos[0].periodo_desde, '2026-11-01T01:00:00.000Z', 'el primero empieza en el conteo de la semana anterior');

    assert.deepEqual(hoja.productos.map((p) => p.descripcion), ['Ibuprofeno 400 mg', 'Paracetamol 500 mg']);
    const [hojaIbu, hojaPara] = hoja.productos;
    assert.deepEqual(hojaIbu.celdas[lunesManana], {
      estado: 'faltan', contado: 5, sistema: 6, diferencia: -1, valor: -12, primer_conteo: null, motivo: 'Se rompió', contador: 'Cajero Norte',
      hora: hojaIbu.celdas[lunesManana].hora,
    });
    assert.deepEqual([hojaIbu.celdas[lunesTarde].estado, hojaIbu.celdas[miercoles].estado], ['cuadra', 'no_contado']);
    assert.deepEqual([hojaIbu.diferencia_semana, hojaIbu.valor_semana, hojaPara.diferencia_semana, hojaPara.valor_semana], [-1, -12, -1, -10]);

    const estados = Object.fromEntries(hoja.turnos.map((x) => [`${x.fecha} ${x.turno}`, x.estado]));
    assert.deepEqual([estados['2026-11-02 manana'], estados['2026-11-02 tarde'], estados['2026-11-03 manana'], estados['2026-11-03 tarde'], estados['2026-11-08 tarde']],
      ['hecho', 'hecho', 'no_se_hizo', 'no_se_hizo', 'no_se_hizo']);
    assert.deepEqual(hoja.totales, {
      conteos: 3, turnos_hechos: 3, turnos_sin_hacer: 11, piezas_faltan: 2, piezas_sobran: 0, faltante: 22, sobrante: 0, con_diferencia: 2, contados: 5,
    });
  });

  await t.test('el jefe marca la semana como revisada y queda en el registro', async () => {
    const r = await jefa.post('/api/conteos/semana/revisar', { sucursal_id: 2, semana: '2026-11-05' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revisada.por, 'Laura Jefa');
    assert.equal(r.body.desde, '2026-11-02');
    let revisada = null;
    for (let i = 0; i < 60 && !revisada; i += 1) {
      revisada = (await jefa.get('/api/conteos/semana?sucursal_id=2&desde=2026-11-02')).body.revisada;
      if (!revisada) await esperar(250);
    }
    assert.equal(revisada && revisada.por, 'Laura Jefa', 'se ve revisada al volver a abrirla');
    const cambio = db.prepare("SELECT descripcion, detalle FROM bitacora WHERE tipo = 'inventario_revisado'").get();
    assert.match(cambio.descripcion, /^Sucursal Norte: semana del 2 nov\.? al 8 nov\.? revisada \(3 de 14 turnos contados, 11 sin hacer; faltaron 2 pieza\(s\), \$22\.00/);
    assert.equal(JSON.parse(cambio.detalle).semana, '2026-11-02');
    // Otra semana sigue sin revisar
    assert.equal((await jefa.get('/api/conteos/semana?sucursal_id=2&desde=2026-11-09')).body.revisada, null);
  });

  await t.test('en el celular del jefe es la misma hoja', async () => {
    const nube = await crearNube(central);
    const token = await nube.vincular(laura);
    const r = await nube.pedir('GET', '/api/conteos/semana?sucursal_id=2&desde=2026-11-02', { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.conteos.length, r.body.totales.faltante, r.body.revisada.por], [3, 22, 'Laura Jefa']);
    const cajero = await nube.pedir('GET', '/api/conteos/semana?sucursal_id=2', { token: await nube.vincular(2) });
    assert.equal(cajero.status, 403);
    assert.deepEqual(nube.errores, []);
  });
});
