'use strict';
/**
 * Escenarios listos para pruebas de punta a punta.
 *
 * escenarioCentral(): central falsa con 3 sucursales y sus usuarios, más una computadora
 *   (server.js con su propio SQLite) por farmacia: central, norte y sur.
 *     admin/admin      -> administrador de la Farmacia Central (sucursal 1)
 *     cajero2/1234     -> cajero de la Sucursal Norte (sucursal 2)
 *     cajero3/1234     -> cajero de la Sucursal Sur (sucursal 3)
 *
 * escenarioLocal(): una sola computadora sin Supabase (todas las sucursales en el mismo SQLite).
 */
const { hashPassword } = require('../../src/passwords');
const { iniciarCentralFalsa, sembrarBase } = require('./central-falsa');
const { iniciarServidor, cliente } = require('./servidor');

const SUCURSALES = [
  { id: 1, nombre: 'Farmacia Central', direccion: 'Av. Principal 100', telefono: '6530000001', es_central: true, activa: true },
  { id: 2, nombre: 'Sucursal Norte', direccion: 'Calle Norte 20', telefono: '6530000002', es_central: false, activa: true },
  { id: 3, nombre: 'Sucursal Sur', direccion: 'Calle Sur 30', telefono: '6530000003', es_central: false, activa: true },
];

async function escenarioCentral({ computadoras = ['central', 'norte', 'sur'] } = {}) {
  const central = await iniciarCentralFalsa();
  sembrarBase(central.db, {
    sucursales: SUCURSALES,
    usuarios: [
      { id: 1, nombre: 'Administrador', usuario: 'admin', password_hash: hashPassword('admin'), rol: 'admin', sucursal_id: 1, activo: true },
      { id: 2, nombre: 'Cajero Norte', usuario: 'cajero2', password_hash: hashPassword('1234'), rol: 'cajero', sucursal_id: 2, activo: true },
      { id: 3, nombre: 'Cajero Sur', usuario: 'cajero3', password_hash: hashPassword('1234'), rol: 'cajero', sucursal_id: 3, activo: true },
    ],
    departamentos: [{ nombre: 'Analgésicos' }, { nombre: 'Vitaminas' }],
  });
  const servidores = {};
  try {
    for (const nombre of computadoras) servidores[nombre] = await iniciarServidor({ nombre, centralUrl: central.url });
  } catch (error) {
    for (const s of Object.values(servidores)) await s.cerrar();
    await central.cerrar();
    throw error;
  }
  return {
    central,
    servidores,
    async cerrarTodo() {
      for (const s of Object.values(servidores)) await s.cerrar();
      await central.cerrar();
    },
  };
}

async function escenarioLocal() {
  const servidor = await iniciarServidor({ nombre: 'local' });
  return { servidor, cerrarTodo: () => servidor.cerrar() };
}

async function abrirCaja(caja, { fondo = 500, tipoCambio = 18 } = {}) {
  const r = await caja.post('/api/cortes/apertura', { fondo_caja: fondo, tipo_cambio: tipoCambio });
  if (r.status !== 200) throw new Error(`No se pudo abrir la caja: ${JSON.stringify(r.body)}`);
  return r.body;
}

// Inicia sesión, sincroniza sucursales (como lo hace la pantalla al entrar) y abre la caja
async function entrar(base, usuario, password, { caja = true } = {}) {
  const c = cliente(base);
  await c.login(usuario, password);
  await c.get('/api/admin/sucursales');
  if (caja) await abrirCaja(c);
  return c;
}

module.exports = { SUCURSALES, escenarioCentral, escenarioLocal, abrirCaja, entrar };
