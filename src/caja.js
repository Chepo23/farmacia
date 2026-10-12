// Apertura de caja (turno): fondo inicial y tipo de cambio del día.
const db = require('./db');

const hoy = () => new Date().toLocaleDateString('sv-SE');

// Última apertura de la sucursal que aún no tiene corte (el turno abierto)
function aperturaActual(sucursalId) {
  return db
    .prepare('SELECT * FROM aperturas_caja WHERE sucursal_id = ? AND corte_id IS NULL ORDER BY id DESC LIMIT 1')
    .get(sucursalId);
}

function aperturaDeSesion(token) {
  return db
    .prepare('SELECT a.* FROM sesiones se JOIN aperturas_caja a ON a.id = se.apertura_id WHERE se.token = ?')
    .get(token);
}

// Apertura con la que trabaja esta sesión. Si la de la sesión ya se cerró con un corte, o la
// sesión es nueva, se une al turno abierto de la sucursal cuando ese turno se abrió hoy.
function aperturaVigente(token, sucursalId) {
  const propia = aperturaDeSesion(token);
  if (propia && !propia.corte_id) return propia;
  const abierta = aperturaActual(sucursalId);
  if (abierta && String(abierta.fecha).slice(0, 10) === hoy()) {
    db.prepare('UPDATE sesiones SET apertura_id = ? WHERE token = ?').run(abierta.id, token);
    return abierta;
  }
  return null;
}

module.exports = { aperturaActual, aperturaDeSesion, aperturaVigente };
