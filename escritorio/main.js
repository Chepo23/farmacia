// Programa de escritorio de la farmacia: el sistema en su propia ventana (sin navegador), con su
// servidor local, impresión directa a la impresora de cada computadora, inicio con Windows,
// respaldos automáticos y actualizaciones.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');

// Pruebas automáticas: carpeta de datos aparte y ventanas ocultas
if (process.env.FARMACIA_DATOS) app.setPath('userData', path.resolve(process.env.FARMACIA_DATOS));
const PRUEBA = process.env.FARMACIA_PRUEBA === '1';
const OCULTO = process.env.FARMACIA_OCULTO === '1';

const configuracion = require('./src/configuracion');
const { Servidor } = require('./src/servidor');
const impresion = require('./src/impresion');
const migracion = require('./src/migracion');
const actualizaciones = require('./src/actualizaciones');

const PAGINAS = path.join(__dirname, 'paginas');
const ICONO = path.join(__dirname, 'recursos', 'icono.png');
const PRELOAD = path.join(__dirname, 'preload.js');

let ventana = null; // el sistema
let ventanaConfig = null; // configuración de esta computadora
let ultimoError = null; // { mensaje, registro } para la pantalla de error
let saliendo = false;
let cerrando = false; // ya se está preguntando o respaldando al cerrar (evita preguntas repetidas)
let finDeSesion = false; // Windows se está apagando: se cierra sin preguntar
let caidas = [];
let anterior = null; // datos del sistema anterior elegidos en la configuración

const servidor = new Servidor({ alTerminar: alCaerServidor });

Menu.setApplicationMenu(null);
app.setAppUserModelId('mx.farmacia.sanfrancisco.pos');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const v = ventana || ventanaConfig;
    if (!v) return;
    if (v.isMinimized()) v.restore();
    v.show();
    v.focus();
  });
  app.whenReady().then(arrancar);
}

async function arrancar() {
  protegerSesion();
  registrarIpc();
  const conf = configuracion.leer();
  if (!conf) {
    abrirConfiguracion({ primeraVez: true });
    return;
  }
  aplicarInicioConWindows(conf);
  crearVentana();
  await iniciarSistema();
  if (actualizaciones.configurar(conf.urlActualizaciones)) actualizaciones.buscar(conf.urlActualizaciones).catch(() => {});
}

// ---------- Ventanas ----------
function opcionesWeb() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    backgroundThrottling: !OCULTO,
  };
}

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Farmacia — Punto de venta',
    icon: ICONO,
    backgroundColor: '#F2F6F8',
    autoHideMenuBar: true,
    webPreferences: opcionesWeb(),
  });
  ventana.once('ready-to-show', () => {
    if (OCULTO) return;
    ventana.maximize(); // al salir de pantalla completa queda maximizada
    ventana.show();
    if ((configuracion.leer() || configuracion.DEFECTOS).pantallaCompleta !== false) ventana.setFullScreen(true);
  });
  protegerContenido(ventana.webContents);
  ventana.on('close', alCerrarVentana);
  ventana.on('session-end', () => { finDeSesion = true; });
  ventana.on('closed', () => { ventana = null; });
}

function abrirConfiguracion({ primeraVez = false } = {}) {
  if (ventanaConfig) {
    ventanaConfig.show();
    ventanaConfig.focus();
    return;
  }
  const conPadre = !primeraVez && ventana && !ventana.isDestroyed();
  ventanaConfig = new BrowserWindow({
    width: 860,
    height: 900,
    minWidth: 640,
    minHeight: 560,
    show: false,
    title: primeraVez ? 'Bienvenido: configura esta computadora' : 'Configuración de esta computadora',
    icon: ICONO,
    backgroundColor: '#F2F6F8',
    autoHideMenuBar: true,
    parent: conPadre ? ventana : undefined,
    modal: Boolean(conPadre),
    webPreferences: opcionesWeb(),
  });
  protegerContenido(ventanaConfig.webContents);
  ventanaConfig.loadFile(path.join(PAGINAS, 'configuracion.html'));
  ventanaConfig.once('ready-to-show', () => { if (!OCULTO) ventanaConfig.show(); });
  ventanaConfig.on('closed', () => {
    ventanaConfig = null;
    anterior = null;
  });
}

// ---------- Servidor ----------
async function iniciarSistema() {
  if (!ventana || ventana.isDestroyed()) return;
  ultimoError = null;
  await ventana.loadFile(path.join(PAGINAS, 'cargando.html'));
  const mostradaDesde = Date.now();
  try {
    const { url } = await servidor.iniciar(configuracion.leer());
    const falta = 1600 - (Date.now() - mostradaDesde);
    if (falta > 0 && !OCULTO) await new Promise((listo) => setTimeout(listo, falta));
    if (ventana && !ventana.isDestroyed()) await ventana.loadURL(`${url}/`);
  } catch (error) {
    mostrarError(error.message);
  }
}

function mostrarError(mensaje) {
  ultimoError = { mensaje, registro: servidor.ultimasLineas() };
  if (ventana && !ventana.isDestroyed()) ventana.loadFile(path.join(PAGINAS, 'error.html'));
}

// Si el servidor se cae con el programa abierto, se vuelve a levantar solo (hasta 3 veces en 5 minutos)
function alCaerServidor(codigo) {
  if (saliendo) return;
  const ahora = Date.now();
  caidas = caidas.filter((t) => ahora - t < 5 * 60000);
  if (caidas.length >= 3) {
    mostrarError(`El servidor se cerró varias veces seguidas (último código ${codigo}).`);
    return;
  }
  caidas.push(ahora);
  iniciarSistema();
}

// ---------- Cerrar ----------
// Al cerrar (X, Alt+F4 o "Salir → Cerrar el sistema"): se pregunta por las ventas sin cobrar y por
// los movimientos sin subir, se actualiza el respaldo del día y se apaga el servidor.
async function alCerrarVentana(evento) {
  if (saliendo) return;
  evento.preventDefault();
  if (cerrando) return;
  cerrando = true;
  try {
    if (!finDeSesion) {
      if (!await preguntarVentasAbiertas()) return;
      if (!await preguntarMovimientosPendientes()) return;
      await respaldarAlCerrar();
    }
    await salir();
  } finally {
    cerrando = false;
  }
}

const pesos = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);

// Las ventas abiertas (pestañas de venta) se guardan en la computadora: aquí se decide si se dejan
async function preguntarVentasAbiertas() {
  if (!ventana || ventana.isDestroyed()) return true;
  let abiertas = null;
  try {
    abiertas = await Promise.race([
      ventana.webContents.executeJavaScript('typeof window.ventasSinCobrar === "function" ? window.ventasSinCobrar() : null', true),
      new Promise((listo) => setTimeout(() => listo(null), 3000)),
    ]);
  } catch { /* la pantalla no es la del sistema */ }
  if (!abiertas || !(abiertas.tickets > 0)) return true;
  let respuesta = process.env.FARMACIA_PRUEBA_VENTAS === 'borrar' ? 1 : 0;
  if (!OCULTO) {
    const { response } = await dialog.showMessageBox(ventana, {
      type: 'question',
      buttons: ['Dejarlas y cerrar', 'Borrarlas y cerrar', 'No cerrar'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Ventas sin cobrar',
      message: abiertas.tickets === 1
        ? `Hay una venta sin cobrar (${abiertas.articulos} artículo(s), ${pesos(abiertas.total)}).`
        : `Hay ${abiertas.tickets} ventas sin cobrar (${abiertas.articulos} artículos, ${pesos(abiertas.total)} en total).`,
      detail: '¿Deseas dejarlas? Si las dejas, aparecerán igual la próxima vez que abras el programa para cobrarlas.',
    });
    respuesta = response;
  }
  if (respuesta === 2) return false;
  if (respuesta === 1) {
    await ventana.webContents.executeJavaScript('window.descartarVentasSinCobrar && window.descartarVentasSinCobrar()', true).catch(() => {});
  }
  return true;
}

async function preguntarMovimientosPendientes() {
  let pendientes = 0;
  try {
    pendientes = Number((await servidor.estado()).sincronizacion.pendientes) || 0;
  } catch { /* el servidor ya no responde */ }
  if (!(pendientes > 0) || OCULTO) return true;
  const { response } = await dialog.showMessageBox(ventana, {
    type: 'warning',
    buttons: ['Cerrar de todos modos', 'No cerrar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Movimientos sin subir',
    message: `Hay ${pendientes} movimiento(s) de inventario que todavía no se suben a la central.`,
    detail: 'Se subirán solos la próxima vez que abras el programa con internet. Si puedes, revisa la conexión y espera un momento antes de cerrar.',
  });
  return response === 0;
}

// Como en Eleventa: al salir se guarda un respaldo (el del día queda como terminó el día)
async function respaldarAlCerrar() {
  if (!servidor.url) return;
  const inicio = Date.now();
  try {
    if (ventana && !ventana.isDestroyed()) await ventana.loadFile(path.join(PAGINAS, 'cerrando.html'));
  } catch { /* se respalda igual */ }
  try {
    await servidor.respaldar({ tipo: 'cierre' });
  } catch (error) {
    servidor.registrar(`No se pudo guardar el respaldo al cerrar: ${error.message}\n`);
  }
  const falta = 1200 - (Date.now() - inicio); // que alcance a leerse el aviso
  if (falta > 0 && !OCULTO) await new Promise((listo) => setTimeout(listo, falta));
}

async function salir() {
  if (saliendo) return;
  saliendo = true;
  try {
    await servidor.detener();
  } finally {
    app.quit();
  }
}

app.on('window-all-closed', () => { salir(); });
app.on('before-quit', (evento) => {
  if (saliendo) return;
  evento.preventDefault();
  salir();
});

// ---------- Inicio con Windows ----------
function aplicarInicioConWindows(conf) {
  // Nunca se registra una copia de prueba o de desarrollo
  if (PRUEBA || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(conf.iniciarConWindows), path: process.execPath, args: [] });
}

// ---------- Seguridad de las ventanas ----------
function esDelSistema(url) {
  return Boolean(servidor.url) && (url === servidor.url || String(url).startsWith(`${servidor.url}/`));
}

function protegerSesion() {
  const permitidos = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contenido, permiso, responder) => responder(permitidos.has(permiso)));
  session.defaultSession.setPermissionCheckHandler((contenido, permiso) => permitidos.has(permiso));
}

function protegerContenido(contenido) {
  // Enlaces a internet: en el navegador normal; ninguna ventana nueva dentro del programa
  contenido.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !esDelSistema(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contenido.on('will-navigate', (evento, url) => {
    if (esDelSistema(url)) return;
    evento.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // Ctrl + / Ctrl - / Ctrl 0: tamaño de la letra; Ctrl+Shift+I: herramientas para soporte técnico;
  // Ctrl+Shift+F: pantalla completa o ventana (F11 no, porque en la venta es el precio de mayoreo)
  contenido.on('before-input-event', (evento, entrada) => {
    if (entrada.type !== 'keyDown' || !entrada.control) return;
    const tecla = entrada.key;
    if (entrada.shift && tecla.toLowerCase() === 'f') {
      if (ventana && contenido === ventana.webContents) alternarPantallaCompleta();
    } else if (tecla === '+' || tecla === '=') contenido.setZoomLevel(Math.min(contenido.getZoomLevel() + 0.5, 4));
    else if (tecla === '-') contenido.setZoomLevel(Math.max(contenido.getZoomLevel() - 0.5, -3));
    else if (tecla === '0') contenido.setZoomLevel(0);
    else if (entrada.shift && tecla.toLowerCase() === 'i') contenido.toggleDevTools();
    else return;
    evento.preventDefault();
  });
}

function alternarPantallaCompleta() {
  if (!ventana || ventana.isDestroyed()) return;
  ventana.setFullScreen(!ventana.isFullScreen());
}

// ---------- Comunicación con las pantallas ----------
function rutaRemitente(evento) {
  try {
    const url = evento.senderFrame.url;
    return url.startsWith('file:') ? fileURLToPath(url) : '';
  } catch {
    return '';
  }
}

// Pantallas propias del programa (configuración, carga, error)
function esPaginaPropia(evento) {
  const ruta = rutaRemitente(evento).toLowerCase();
  return Boolean(ruta) && ruta.startsWith(`${PAGINAS.toLowerCase()}${path.sep}`);
}

function desdeElSistema(evento) {
  try {
    return esDelSistema(evento.senderFrame.url);
  } catch {
    return false;
  }
}

function soloPropia(fn) {
  return (evento, ...args) => {
    if (!esPaginaPropia(evento)) throw new Error('No permitido');
    return fn(evento, ...args);
  };
}

function datosDeImpresion() {
  const c = configuracion.leer() || configuracion.DEFECTOS;
  return { impresoraTicket: c.impresoraTicket, anchoTicket: c.anchoTicket, impresoraDocumentos: c.impresoraDocumentos };
}

function listarRespaldos(conf) {
  const carpeta = configuracion.carpetaRespaldos(conf);
  try {
    return fs.readdirSync(carpeta)
      .filter((n) => /^farmacia-.*\.db$/.test(n))
      .map((n) => ({ nombre: n, creado: fs.statSync(path.join(carpeta, n)).mtime.toISOString() }))
      .sort((a, b) => (a.creado < b.creado ? 1 : -1));
  } catch {
    return [];
  }
}

async function probarConexion(url, llave) {
  const direccion = String(url || '').trim().replace(/\/+$/, '');
  if (!direccion || !llave) return { ok: false, mensaje: 'Escribe la dirección de Supabase y la llave secreta.' };
  if (/^sb_publishable_/.test(llave)) return { ok: false, mensaje: 'Esa es la llave pública (publishable). Se necesita la llave secreta (empieza con sb_secret_).' };
  const llaveNueva = /^sb_secret_/.test(llave);
  try {
    const r = await fetch(`${direccion}/rest/v1/sucursales?select=id,nombre&order=id`, {
      headers: { apikey: llave, ...(llaveNueva ? {} : { Authorization: `Bearer ${llave}` }) },
      signal: AbortSignal.timeout(10000),
    });
    const datos = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) {
      return { ok: false, mensaje: 'Supabase rechazó la llave: revisa que sea la secreta, que esté completa y que no se haya desactivado.' };
    }
    if (!r.ok) return { ok: false, mensaje: `Supabase respondió con un error (${r.status}) ${(datos && (datos.message || datos.error)) || ''}`.trim() };
    const nombres = Array.isArray(datos) ? datos.map((s) => s.nombre) : [];
    if (!nombres.length) return { ok: false, mensaje: 'Se conectó, pero no se ve ninguna sucursal: revisa que sea la llave secreta del proyecto correcto.' };
    return { ok: true, mensaje: `Conexión correcta. Sucursales: ${nombres.join(', ')}.` };
  } catch (error) {
    const motivo = error.name === 'TimeoutError' ? 'no hubo respuesta' : error.message;
    return { ok: false, mensaje: `No se pudo conectar (${motivo}). Revisa el internet y la dirección.` };
  }
}

const CAMBIAN_SERVIDOR = ['modo', 'supabaseUrl', 'llaveCifrada', 'llaveTexto', 'puerto', 'red', 'carpetaDatos', 'urlMovil', 'carpetaRespaldoExtra'];

async function guardarConfiguracion(datosRecibidos) {
  const previa = configuracion.leer();
  const primeraVez = !previa;
  let datos = { ...(datosRecibidos || {}) };
  // La llave del sistema anterior nunca pasa por la pantalla: se toma aquí
  if (datos.usarLlaveAnterior && anterior && anterior.llave && !datos.llave) datos = { ...datos, llave: anterior.llave };
  const { error, conf } = configuracion.validar(datos, previa);
  if (error) return { ok: false, mensaje: error };

  let importada = false;
  if (datos.importarBase && anterior && anterior.base) {
    if (await migracion.sistemaAbierto(anterior.puerto, servidor.instancia)) {
      return { ok: false, mensaje: 'El sistema anterior sigue abierto. Ciérralo (la ventana negra de "npm start") y vuelve a guardar.' };
    }
    await servidor.detener(); // libera la base actual antes de reemplazarla
    try {
      migracion.importarBase(anterior.base.ruta, configuracion.rutaBase(conf));
      importada = true;
    } catch (e) {
      return { ok: false, mensaje: `No se pudo copiar la base anterior: ${e.message}` };
    }
  }

  configuracion.guardar(conf);
  aplicarInicioConWindows(conf);
  if (previa && previa.pantallaCompleta !== conf.pantallaCompleta && ventana && !ventana.isDestroyed() && !OCULTO) {
    ventana.setFullScreen(conf.pantallaCompleta);
  }
  actualizaciones.configurar(conf.urlActualizaciones);
  const reiniciar = primeraVez || importada || CAMBIAN_SERVIDOR.some((clave) => previa[clave] !== conf[clave]) || !servidor.url;

  // Se responde a la pantalla y después se aplican los cambios (la ventana de configuración se cierra)
  setTimeout(async () => {
    if (!ventana || ventana.isDestroyed()) crearVentana();
    if (ventanaConfig) ventanaConfig.close();
    if (reiniciar) await iniciarSistema();
  }, 60);
  return { ok: true, reinicia: reiniciar };
}

// Ventana de Windows para elegir carpeta o archivo (en las pruebas automáticas se indica por variable)
function elegirRuta(opciones) {
  if (PRUEBA && process.env.FARMACIA_PRUEBA_SELECCION) {
    return Promise.resolve({ canceled: false, filePaths: [process.env.FARMACIA_PRUEBA_SELECCION] });
  }
  return dialog.showOpenDialog(ventanaConfig || undefined, opciones);
}

function registrarIpc() {
  ipcMain.on('app:version', (evento) => { evento.returnValue = app.getVersion(); });
  ipcMain.on('impresion:config', (evento) => { evento.returnValue = datosDeImpresion(); });

  ipcMain.handle('imprimir', (evento, opciones) => {
    if (!desdeElSistema(evento)) throw new Error('No permitido');
    return impresion.imprimir(evento.sender, configuracion.leer() || configuracion.DEFECTOS, opciones || {});
  });
  // "Salir → Cerrar el sistema" y "Cerrar el programa" del inicio de sesión: mismo camino que la X
  ipcMain.handle('ventana:cerrar', (evento) => {
    if (!desdeElSistema(evento) && !esPaginaPropia(evento)) throw new Error('No permitido');
    if (ventana && !ventana.isDestroyed()) ventana.close();
  });
  ipcMain.handle('config:abrir', (evento) => {
    if (desdeElSistema(evento) || esPaginaPropia(evento)) abrirConfiguracion();
  });
  ipcMain.handle('respaldos:abrir', async (evento) => {
    if (!desdeElSistema(evento) && !esPaginaPropia(evento)) throw new Error('No permitido');
    const carpeta = configuracion.carpetaRespaldos(configuracion.leer());
    fs.mkdirSync(carpeta, { recursive: true });
    return shell.openPath(carpeta);
  });
  ipcMain.handle('actualizar:buscar', (evento) => {
    if (!desdeElSistema(evento) && !esPaginaPropia(evento)) throw new Error('No permitido');
    return actualizaciones.buscar((configuracion.leer() || {}).urlActualizaciones);
  });

  ipcMain.handle('config:leer', soloPropia(() => {
    const conf = configuracion.leer();
    return {
      primeraVez: !conf,
      version: app.getVersion(),
      conf: configuracion.paraPantalla(conf),
      rutas: {
        datos: configuracion.carpetaDatos(conf),
        respaldos: configuracion.carpetaRespaldos(conf),
        registros: configuracion.carpetaRegistros(),
      },
      baseExiste: fs.existsSync(configuracion.rutaBase(conf)),
      respaldos: listarRespaldos(conf).slice(0, 5),
    };
  }));
  ipcMain.handle('config:impresoras', soloPropia((evento) => impresion.listarImpresoras(evento.sender)));
  ipcMain.handle('config:probar', soloPropia((evento, datos = {}) => {
    const conf = configuracion.leer();
    let llave = String(datos.llave || '').trim();
    if (!llave && datos.usarLlaveAnterior && anterior) llave = anterior.llave;
    if (!llave) llave = configuracion.llave(conf);
    return probarConexion(datos.supabaseUrl, llave);
  }));
  ipcMain.handle('config:examinar', soloPropia(async (evento, tipo) => {
    const propiedades = tipo === 'archivo' ? ['openFile'] : ['openDirectory'];
    const eleccion = await elegirRuta({
      title: tipo === 'archivo' ? 'Elige el archivo farmacia.db del sistema anterior' : 'Elige la carpeta donde estaba el sistema anterior',
      properties: propiedades,
      filters: tipo === 'archivo' ? [{ name: 'Base de datos', extensions: ['db'] }] : undefined,
    });
    if (eleccion.canceled || !eleccion.filePaths.length) return { cancelado: true };
    const ruta = eleccion.filePaths[0];
    anterior = migracion.examinar(tipo === 'archivo' ? { archivo: ruta } : { carpeta: ruta });
    const { llave: _oculta, ...paraPantalla } = anterior;
    return { ...paraPantalla, abierto: await migracion.sistemaAbierto(anterior.puerto, servidor.instancia) };
  }));
  ipcMain.handle('config:elegir-carpeta', soloPropia(async () => {
    const eleccion = await elegirRuta({
      title: 'Carpeta extra para los respaldos (por ejemplo una de OneDrive o una USB)',
      properties: ['openDirectory', 'createDirectory'],
    });
    return eleccion.canceled ? null : eleccion.filePaths[0];
  }));
  ipcMain.handle('config:imprimir-prueba', soloPropia((evento, datos = {}) => impresion.imprimirPrueba({
    impresora: String(datos.impresora || ''),
    anchoMm: Number(datos.anchoMm) || 80,
  })));
  ipcMain.handle('config:guardar', soloPropia((evento, datos) => guardarConfiguracion(datos)));
  ipcMain.handle('config:cancelar', soloPropia(() => { if (ventanaConfig) ventanaConfig.close(); }));

  ipcMain.handle('app:error', soloPropia(() => ultimoError));
  ipcMain.handle('app:reintentar', soloPropia(() => { iniciarSistema(); }));
  ipcMain.handle('app:registros', soloPropia(() => {
    fs.mkdirSync(configuracion.carpetaRegistros(), { recursive: true });
    return shell.openPath(configuracion.carpetaRegistros());
  }));
  ipcMain.handle('app:salir', soloPropia(() => salir()));
}
