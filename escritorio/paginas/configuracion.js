// Pantalla de configuración de esta computadora
const programa = window.farmaciaEscritorio;
const F = programa.configuracion;
const $ = (id) => document.getElementById(id);

const estado = { primeraVez: true, conf: {}, anterior: null };

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

function tamanio(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round((Number(bytes) || 0) / 1024))} KB`;
}

const fecha = (iso) => new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const modo = () => document.querySelector('input[name="modo"]:checked').value;

function pintarModo() {
  $('campos-central').hidden = modo() !== 'central';
}

function mostrarError(texto) {
  $('error').textContent = texto || '';
  $('error').hidden = !texto;
}

function resultado(id, r) {
  const el = $(id);
  el.textContent = r.mensaje || '';
  el.className = `resultado ${r.ok ? 'ok' : 'mal'}`;
}

function anchoElegido() {
  return $('ancho').value === 'otro' ? Number($('ancho-otro').value) : Number($('ancho').value);
}

async function cargarImpresoras(conf) {
  const lista = await F.impresoras();
  const llenar = (select, elegida) => {
    const opciones = ['<option value="">Preguntar cada vez</option>'];
    for (const i of lista) {
      opciones.push(`<option value="${escapar(i.nombre)}">${escapar(i.visible)}${i.predeterminada ? ' (predeterminada)' : ''}</option>`);
    }
    if (elegida && !lista.some((i) => i.nombre === elegida)) {
      opciones.push(`<option value="${escapar(elegida)}">${escapar(elegida)} (no conectada)</option>`);
    }
    select.innerHTML = opciones.join('');
    select.value = elegida || '';
  };
  llenar($('impresora-ticket'), conf.impresoraTicket);
  llenar($('impresora-documentos'), conf.impresoraDocumentos);
}

async function cargar() {
  const r = await F.leer();
  estado.primeraVez = r.primeraVez;
  estado.conf = r.conf;
  const c = r.conf;
  $('titulo').textContent = r.primeraVez ? 'Bienvenido: configura esta computadora' : 'Configuración de esta computadora';
  $('subtitulo').textContent = `Programa Farmacia ${r.version}${r.primeraVez ? ' · Solo se hace una vez' : ''}`;
  document.querySelector(`input[name="modo"][value="${c.modo === 'local' ? 'local' : 'central'}"]`).checked = true;
  $('supabase-url').value = c.supabaseUrl || '';
  $('nota-llave').textContent = c.tieneLlave
    ? 'Ya hay una llave guardada (cifrada). Deja el campo vacío para conservarla o escribe otra para cambiarla.'
    : 'La llave se guarda cifrada con tu cuenta de Windows.';
  const comun = [58, 80].includes(Number(c.anchoTicket));
  $('ancho').value = comun ? String(c.anchoTicket) : 'otro';
  $('ancho-otro').hidden = comun;
  $('ancho-otro').value = comun ? '' : c.anchoTicket;
  $('iniciar-windows').checked = c.iniciarConWindows !== false;
  $('carpeta-extra').value = c.carpetaRespaldoExtra || '';
  $('url-movil').value = c.urlMovil || '';
  $('puerto').value = c.puerto || 3000;
  $('red').checked = Boolean(c.red);
  $('url-actualizaciones').value = c.urlActualizaciones || '';
  $('ruta-datos').textContent = r.rutas.datos;
  $('cancelar').textContent = r.primeraVez ? 'Salir' : 'Cancelar';
  $('guardar').textContent = r.primeraVez ? 'Guardar y abrir el sistema' : 'Guardar';
  if (!r.primeraVez && r.baseExiste) {
    $('texto-datos').innerHTML = 'Esta computadora ya tiene sus datos. Si traes los de otro sistema, los actuales se guardan aparte con otro nombre (no se borran).';
  }
  const ultimo = r.respaldos[0];
  $('info-respaldos').innerHTML = r.primeraVez ? 'Cada día se guarda un respaldo automático de esta computadora.'
    : `Respaldos en <b>${escapar(r.rutas.respaldos)}</b>. ${ultimo ? `Último: ${escapar(fecha(ultimo.creado))}.` : 'Todavía no hay respaldos.'}`;
  pintarModo();
  await cargarImpresoras(c);
}

// ---------- Sistema anterior ----------
async function examinar(tipo) {
  mostrarError('');
  const r = await F.examinarAnterior(tipo);
  if (r.cancelado) return;
  estado.anterior = r;
  const caja = $('anterior-resultado');
  if (!r.encontrado) {
    caja.innerHTML = '<div class="error">No se encontró la base de datos del sistema en esa ubicación. Elige la carpeta donde está el archivo farmacia.db.</div>';
    return;
  }
  // Lo que traiga el sistema anterior llena los campos vacíos
  if (r.supabaseUrl) {
    document.querySelector('input[name="modo"][value="central"]').checked = true;
    if (!$('supabase-url').value) $('supabase-url').value = r.supabaseUrl;
  }
  if (r.urlMovil && !$('url-movil').value) $('url-movil').value = r.urlMovil;
  if (r.puerto) $('puerto').value = r.puerto;
  pintarModo();
  caja.innerHTML = `<div class="tarjeta-anterior">
    ${r.base ? `<label class="check"><input type="checkbox" id="importar-base" checked>
      Traer la base de datos (${escapar(tamanio(r.base.bytes))}, modificada el ${escapar(fecha(r.base.modificado))})</label>` : '<span>No hay base de datos en esa ubicación (solo la configuración).</span>'}
    ${r.supabaseUrl ? `<span>Conexión encontrada: <b>${escapar(r.supabaseUrl)}</b></span>` : ''}
    ${r.tieneLlave ? '<label class="check"><input type="checkbox" id="usar-llave-anterior" checked> Usar la llave secreta del sistema anterior</label>' : ''}
    ${r.abierto ? '<div class="aviso">El sistema anterior está abierto: ciérralo (la ventana negra de "npm start") antes de guardar.</div>' : ''}
  </div>`;
}

function datosFormulario() {
  return {
    modo: modo(),
    supabaseUrl: $('supabase-url').value.trim(),
    llave: $('llave').value.trim(),
    usarLlaveAnterior: Boolean($('usar-llave-anterior') && $('usar-llave-anterior').checked),
    importarBase: Boolean($('importar-base') && $('importar-base').checked),
    puerto: Number($('puerto').value),
    red: $('red').checked,
    impresoraTicket: $('impresora-ticket').value,
    anchoTicket: anchoElegido(),
    impresoraDocumentos: $('impresora-documentos').value,
    iniciarConWindows: $('iniciar-windows').checked,
    urlMovil: $('url-movil').value.trim(),
    carpetaRespaldoExtra: $('carpeta-extra').value.trim(),
    urlActualizaciones: $('url-actualizaciones').value.trim(),
  };
}

// ---------- Eventos ----------
document.querySelectorAll('input[name="modo"]').forEach((r) => r.addEventListener('change', pintarModo));

$('ancho').addEventListener('change', () => {
  $('ancho-otro').hidden = $('ancho').value !== 'otro';
  if (!$('ancho-otro').hidden) $('ancho-otro').focus();
});

$('probar').addEventListener('click', async () => {
  const boton = $('probar');
  boton.disabled = true;
  $('resultado-conexion').textContent = 'Probando…';
  $('resultado-conexion').className = 'resultado';
  try {
    const d = datosFormulario();
    resultado('resultado-conexion', await F.probarConexion({ supabaseUrl: d.supabaseUrl, llave: d.llave, usarLlaveAnterior: d.usarLlaveAnterior }));
  } finally {
    boton.disabled = false;
  }
});

$('anterior-carpeta').addEventListener('click', () => examinar('carpeta'));
$('anterior-archivo').addEventListener('click', () => examinar('archivo'));

$('prueba-ticket').addEventListener('click', async () => {
  const boton = $('prueba-ticket');
  boton.disabled = true;
  $('resultado-prueba').textContent = 'Imprimiendo…';
  $('resultado-prueba').className = 'resultado';
  try {
    const r = await F.imprimirPrueba({ impresora: $('impresora-ticket').value, anchoMm: anchoElegido() });
    resultado('resultado-prueba', { ok: r.ok, mensaje: r.ok ? (r.aviso || 'Listo: revisa el ticket de prueba.') : `No se imprimió: ${r.motivo || ''}` });
  } catch (error) {
    resultado('resultado-prueba', { ok: false, mensaje: error.message });
  } finally {
    boton.disabled = false;
  }
});

$('elegir-carpeta').addEventListener('click', async () => {
  const carpeta = await F.elegirCarpeta();
  if (carpeta) $('carpeta-extra').value = carpeta;
});
$('quitar-carpeta').addEventListener('click', () => { $('carpeta-extra').value = ''; });

$('cancelar').addEventListener('click', () => F.cancelar());

$('guardar').addEventListener('click', async () => {
  mostrarError('');
  const boton = $('guardar');
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try {
    const r = await F.guardar(datosFormulario());
    if (!r.ok) throw new Error(r.mensaje);
    boton.textContent = r.reinicia ? 'Abriendo el sistema…' : 'Guardado';
  } catch (error) {
    mostrarError(error.message);
    boton.disabled = false;
    boton.textContent = estado.primeraVez ? 'Guardar y abrir el sistema' : 'Guardar';
  }
});

cargar().catch((error) => mostrarError(error.message));
