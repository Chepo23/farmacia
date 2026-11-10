'use strict';
// Si la copia local de una computadora tiene pedidos o apoyos que la central ya no tiene (datos de
// prueba que se borraron en la central, o una base vieja traída con "Traer datos del sistema
// anterior"), al estar en línea se quitan solos de la copia local. Sin conexión no se toca nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { escenarioCentral, entrar } = require('../helpers/escenario');

function sembrarCentral(db) {
  db.prepare(
    `INSERT INTO productos (id, codigo_barras, descripcion, precio_costo, precio_venta, usa_inventario, activo)
     VALUES (1, '7501234567893', 'Paracetamol 500 mg c/10', 14.5, 28, 1, 1)`
  ).run();
  db.prepare("INSERT INTO pedidos (id, folio, sucursal_id, estado, creado_por, enviado_por, enviado) VALUES (50, 1, 2, 'enviado', 2, 2, ?)")
    .run(new Date().toISOString());
  db.prepare("INSERT INTO pedido_detalle (pedido_id, producto_id, codigo_barras, descripcion, cantidad) VALUES (50, 1, '7501234567893', 'Paracetamol 500 mg c/10', 5)").run();
  for (const [id, folio] of [[60, 1], [61, 2]]) {
    db.prepare("INSERT INTO apoyos (id, folio, origen_id, destino_id, pedido_id, estado, creado_por, enviado_por, enviado) VALUES (?, ?, 1, 2, ?, 'enviado', 1, 1, ?)")
      .run(id, folio, id === 60 ? 50 : null, new Date().toISOString());
    db.prepare("INSERT INTO apoyo_detalle (apoyo_id, producto_id, codigo_barras, descripcion, cantidad) VALUES (?, 1, '7501234567893', 'Paracetamol 500 mg c/10', 2)").run(id);
  }
}

// Mete directo en la base de la computadora un pedido y un apoyo que la central nunca tuvo
function meterViejos(ruta, { apoyo, pedido }) {
  const local = new Database(ruta, { timeout: 5000 });
  local.pragma('foreign_keys = ON');
  try {
    local.transaction(() => {
      if (pedido) {
        local.prepare("INSERT INTO pedidos (id, folio, sucursal_id, estado, creado_por, creado) VALUES (?, 99, 2, 'enviado', 2, '2026-09-12 12:01:18')").run(pedido);
        local.prepare("INSERT INTO pedido_detalle (pedido_id, producto_id, descripcion, cantidad) VALUES (?, 1, 'Paracetamol de prueba', 5)").run(pedido);
      }
      if (apoyo) {
        local.prepare("INSERT INTO apoyos (id, folio, origen_id, destino_id, pedido_id, estado, creado_por, creado) VALUES (?, 99, 1, 2, ?, 'enviado', 1, '2026-09-12 11:26:55')")
          .run(apoyo, pedido || null);
        local.prepare("INSERT INTO apoyo_detalle (apoyo_id, producto_id, descripcion, cantidad) VALUES (?, 1, 'Paracetamol de prueba', 1)").run(apoyo);
      }
    })();
  } finally {
    local.close();
  }
}

function enLaCopia(ruta, tabla, id) {
  const local = new Database(ruta, { readonly: true, timeout: 5000 });
  try {
    return Boolean(local.prepare(`SELECT 1 FROM ${tabla} WHERE id = ?`).get(id));
  } finally {
    local.close();
  }
}

test('la copia local quita los pedidos y apoyos que la central ya no tiene', async (t) => {
  const { central, servidores, cerrarTodo } = await escenarioCentral({ computadoras: ['central', 'norte'] });
  t.after(cerrarTodo);
  sembrarCentral(central.db);
  const norte = await entrar(servidores.norte.base, 'cajero2', '1234', { caja: false });
  const admin = await entrar(servidores.central.base, 'admin', 'admin', { caja: false });
  const rutaNorte = servidores.norte.dbPath;

  await t.test('al principio se ve lo que tiene la central', async () => {
    assert.deepEqual((await norte.get('/api/apoyos')).body.map((a) => a.id), [61, 60]);
    assert.deepEqual((await norte.get('/api/pedidos')).body.map((p) => p.id), [50]);
    assert.deepEqual((await admin.get('/api/pedidos')).body.map((p) => p.id), [50]);
  });

  await t.test('lo borrado en la central y lo que llegó con una base vieja desaparece de las pantallas', async () => {
    meterViejos(rutaNorte, { apoyo: 900, pedido: 901 });
    central.db.prepare('DELETE FROM apoyos WHERE id = 60').run();
    central.db.prepare('DELETE FROM pedidos WHERE id = 50').run();

    const apoyos = await norte.get('/api/apoyos');
    assert.equal(apoyos.status, 200, JSON.stringify(apoyos.body));
    assert.deepEqual(apoyos.body.map((a) => a.id), [61], 'el apoyo que sigue en la central no se toca');
    const pedidos = await norte.get('/api/pedidos');
    assert.deepEqual(pedidos.body.map((p) => p.id), []);
    for (const [tabla, id] of [['apoyos', 60], ['apoyos', 900], ['pedidos', 50], ['pedidos', 901]]) {
      assert.equal(enLaCopia(rutaNorte, tabla, id), false, `${tabla} ${id} sigue en la copia local`);
    }
    assert.equal(enLaCopia(rutaNorte, 'apoyos', 61), true);
    const pendientesCentral = await admin.get('/api/pedidos');
    assert.deepEqual(pendientesCentral.body.map((p) => p.id), [], 'la central tampoco lo muestra como pendiente');
  });

  await t.test('al abrir uno que la central ya no tiene responde "no encontrado" y se quita', async () => {
    meterViejos(rutaNorte, { apoyo: 902 });
    const r = await norte.get('/api/apoyos/902');
    assert.equal(r.status, 404);
    assert.equal(enLaCopia(rutaNorte, 'apoyos', 902), false);
  });

  await t.test('sin conexión con la central no se borra nada', async () => {
    meterViejos(rutaNorte, { apoyo: 903 });
    central.simularCaida(true);
    try {
      const r = await norte.get('/api/apoyos');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.some((a) => a.id === 903), 'sin poder revisar con la central se sigue mostrando');
      assert.equal(enLaCopia(rutaNorte, 'apoyos', 903), true);
    } finally {
      central.simularCaida(false);
    }
    await new Promise((listo) => setTimeout(listo, 1700)); // la computadora espera un momento antes de reintentar
    const r = await norte.get('/api/apoyos');
    assert.deepEqual(r.body.map((a) => a.id), [61]);
    assert.equal(enLaCopia(rutaNorte, 'apoyos', 903), false);
  });
});
