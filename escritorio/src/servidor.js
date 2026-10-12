// El servidor de la farmacia (server.js) corre como un proceso aparte con su propio Node.js,
// el mismo con el que se probó el sistema. Así la base de datos nativa (better-sqlite3) no se tiene
// que recompilar para Electron y, si el servidor falla, la ventana sigue viva y lo puede reiniciar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');
const configuracion = require('./configuracion');

const LINEAS_RECORDADAS = 120;
const DIAS_DE_REGISTROS = 14;

function rutas() {
  if (app.isPackaged) {
    const base = path.join(process.resourcesPath, 'servidor');
    return { node: path.join(base, 'node.exe'), script: path.join(base, 'server.js') };
  }
  // Desarrollo: el Node.js instalado y el server.js del repositorio
  return { node: process.env.FARMACIA_NODE || 'node', script: path.join(__dirname, '..', '..', 'server.js') };
}

function fechaHoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function limpiarRegistrosViejos(carpeta) {
  try {
    const limite = Date.now() - DIAS_DE_REGISTROS * 86400000;
    for (const nombre of fs.readdirSync(carpeta)) {
      const archivo = path.join(carpeta, nombre);
      if (fs.statSync(archivo).mtimeMs < limite) fs.unlinkSync(archivo);
    }
  } catch { /* sin registros todavía */ }
}

// Variables del entorno que no deben pasar al servidor: él recibe exactamente las de esta configuración
const QUITAR = /^(SUPABASE_|FARMACIA_|MOVIL_|DATABASE_URL$|PORT$|HOST$|NODE_OPTIONS$|ELECTRON_|DOTENV_)/i;

class Servidor {
  constructor({ alTerminar } = {}) {
    this.hijo = null;
    this.lineas = [];
    this.alTerminar = alTerminar;
    this.apagando = false;
    this.url = '';
    this.token = '';
  }

  ultimasLineas() {
    return this.lineas.join('');
  }

  registrar(texto) {
    this.lineas.push(texto);
    if (this.lineas.length > LINEAS_RECORDADAS) this.lineas.splice(0, this.lineas.length - LINEAS_RECORDADAS);
    try { this.salidaRegistro?.write(texto); } catch { /* sin espacio en disco */ }
  }

  async iniciar(conf) {
    await this.detener();
    this.apagando = false;
    this.lineas = [];
    const { node, script } = rutas();
    if (app.isPackaged && !fs.existsSync(node)) throw new Error(`Falta el archivo ${node}. Vuelve a instalar el programa.`);
    const datos = configuracion.carpetaDatos(conf);
    fs.mkdirSync(datos, { recursive: true });
    const registros = configuracion.carpetaRegistros();
    fs.mkdirSync(registros, { recursive: true });
    limpiarRegistrosViejos(registros);
    this.salidaRegistro = fs.createWriteStream(path.join(registros, `servidor-${fechaHoy()}.log`), { flags: 'a' });

    this.token = crypto.randomBytes(32).toString('hex');
    this.instancia = crypto.randomUUID();
    const env = {};
    for (const [clave, valor] of Object.entries(process.env)) if (!QUITAR.test(clave)) env[clave] = valor;
    Object.assign(env, {
      PORT: String(conf.puerto),
      HOST: conf.red ? '0.0.0.0' : '127.0.0.1',
      FARMACIA_DB: configuracion.rutaBase(conf),
      FARMACIA_TOKEN_INTERNO: this.token,
      FARMACIA_INSTANCIA: this.instancia,
      FARMACIA_RESPALDOS_EXTRA: conf.carpetaRespaldoExtra || '',
      MOVIL_URL: conf.urlMovil || '',
      NODE_ENV: 'production',
      // Vacías a propósito en modo local: así un .env olvidado en la carpeta no cambia el modo
      SUPABASE_URL: conf.modo === 'central' ? conf.supabaseUrl : '',
      SUPABASE_SERVICE_ROLE_KEY: conf.modo === 'central' ? configuracion.llave(conf) : '',
      SUPABASE_ANON_KEY: '',
    });
    // Solo para las pruebas automáticas del programa
    for (const clave of ['FARMACIA_RESPALDO_INICIAL_MS', 'CENTRAL_ESPERA_CAIDA_MS', 'SUPABASE_TIMEOUT_MS']) {
      if (process.env[clave]) env[clave] = process.env[clave];
    }

    this.registrar(`\n===== ${new Date().toLocaleString('es-MX')}: iniciando el servidor (puerto ${conf.puerto}, modo ${conf.modo}) =====\n`);
    const hijo = spawn(node, [script], { cwd: datos, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.hijo = hijo;
    hijo.stdout.setEncoding('utf8');
    hijo.stderr.setEncoding('utf8');
    hijo.stdout.on('data', (d) => this.registrar(d));
    hijo.stderr.on('data', (d) => this.registrar(d));
    let terminoAntes = null;
    hijo.on('error', (error) => { terminoAntes = error; this.registrar(`No se pudo ejecutar el servidor: ${error.message}\n`); });
    hijo.on('exit', (codigo) => {
      this.registrar(`===== El servidor terminó (código ${codigo}) =====\n`);
      const estabaListo = this.hijo === hijo && Boolean(this.url);
      if (this.hijo === hijo) {
        this.hijo = null;
        this.url = '';
      }
      if (!terminoAntes) terminoAntes = new Error(`El servidor se cerró (código ${codigo})`);
      // Se cayó mientras se usaba (no porque se cerrara el programa): avisar para reiniciarlo
      if (!this.apagando && estabaListo && this.alTerminar) this.alTerminar(codigo);
    });

    const url = `http://127.0.0.1:${conf.puerto}`;
    const limite = Date.now() + 40000;
    while (Date.now() < limite) {
      if (terminoAntes) throw this.errorDeArranque(terminoAntes, conf);
      try {
        const r = await fetch(`${url}/api/sync/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          const salud = await r.json();
          if (salud.instancia === this.instancia) {
            this.url = url;
            return { url };
          }
        }
      } catch { /* todavía no responde */ }
      await new Promise((listo) => setTimeout(listo, 200));
    }
    await this.detener();
    throw new Error('El servidor tardó demasiado en arrancar. Revisa el registro.');
  }

  errorDeArranque(error, conf) {
    const texto = this.ultimasLineas();
    if (/EADDRINUSE|ya está en uso/i.test(texto)) {
      return new Error(`El puerto ${conf.puerto} ya lo está usando otro programa. ¿Quedó abierto el sistema anterior (la ventana negra de "npm start")? Ciérralo o cambia el puerto en la configuración.`);
    }
    if (/SQLITE_BUSY|database is locked/i.test(texto)) {
      return new Error('La base de datos está ocupada por otro programa (¿el sistema anterior sigue abierto?). Ciérralo e intenta de nuevo.');
    }
    return new Error(`No se pudo iniciar el servidor: ${error.message}`);
  }

  async interno(metodo, ruta) {
    if (!this.url) throw new Error('El servidor no está en marcha');
    const r = await fetch(`${this.url}/api/sistema${ruta}`, {
      method: metodo,
      headers: { 'x-farmacia-interno': this.token },
      signal: AbortSignal.timeout(15000),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(datos.error || `Error ${r.status}`);
    return datos;
  }

  estado() {
    return this.interno('GET', '/estado');
  }

  respaldar() {
    return this.interno('POST', '/respaldar');
  }

  // Apaga el servidor en orden (la base queda bien cerrada); si no responde, se termina a la fuerza
  async detener() {
    const hijo = this.hijo;
    if (!hijo) return;
    this.apagando = true;
    const termino = new Promise((listo) => hijo.once('exit', listo));
    try {
      if (this.url) await this.interno('POST', '/apagar');
    } catch { /* ya no respondía */ }
    const aTiempo = await Promise.race([termino.then(() => true), new Promise((listo) => setTimeout(listo, 5000, false))]);
    if (!aTiempo) {
      try { hijo.kill(); } catch { /* ya terminó */ }
      await Promise.race([termino, new Promise((listo) => setTimeout(listo, 3000))]);
    }
    this.hijo = null;
    this.url = '';
    try { this.salidaRegistro?.end(); } catch { /* ya cerrado */ }
  }
}

module.exports = { Servidor, rutas };
