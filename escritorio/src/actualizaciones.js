// Actualizaciones automáticas (opcional): si en la configuración hay una dirección de
// actualizaciones (por ejemplo una carpeta pública de Cloudflare R2 con latest.yml y el instalador),
// el programa revisa al abrir, descarga la versión nueva en segundo plano y la instala al cerrar.
const { app, dialog } = require('electron');

let actualizador = null;
let configurada = '';
let aviso = null;

function cargar() {
  if (!actualizador) {
    ({ autoUpdater: actualizador } = require('electron-updater'));
    actualizador.autoDownload = true;
    actualizador.autoInstallOnAppQuit = true;
    actualizador.on('update-downloaded', (info) => {
      if (aviso) return;
      aviso = dialog.showMessageBox({
        type: 'info',
        buttons: ['Reiniciar ahora', 'Al cerrar el programa'],
        defaultId: 1,
        cancelId: 1,
        title: 'Actualización lista',
        message: `La versión ${info.version} del programa ya se descargó.`,
        detail: 'Se instalará sola al cerrar el programa. Si quieres, reinícialo ahora (termina primero la venta en curso).',
      }).then(({ response }) => {
        if (response === 0) actualizador.quitAndInstall(false, true);
      }).finally(() => { aviso = null; });
    });
  }
  return actualizador;
}

function configurar(url) {
  if (!url || !app.isPackaged) return false;
  const a = cargar();
  if (configurada !== url) {
    a.setFeedURL({ provider: 'generic', url });
    configurada = url;
  }
  return true;
}

async function buscar(url) {
  if (!app.isPackaged) return { ok: false, mensaje: 'Las actualizaciones solo funcionan en el programa instalado.' };
  if (!url) {
    return { ok: false, mensaje: 'No hay dirección de actualizaciones. Para actualizar, instala el archivo nuevo encima (los datos se conservan).' };
  }
  try {
    configurar(url);
    const r = await cargar().checkForUpdates();
    const nueva = r && r.updateInfo && r.updateInfo.version;
    if (!nueva || nueva === app.getVersion()) return { ok: true, mensaje: `Ya tienes la versión más reciente (${app.getVersion()}).` };
    return { ok: true, mensaje: `Se está descargando la versión ${nueva}; se instalará al cerrar el programa.` };
  } catch (error) {
    return { ok: false, mensaje: `No se pudo revisar si hay actualizaciones: ${error.message}` };
  }
}

module.exports = { buscar, configurar };
