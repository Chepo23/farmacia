// Puente entre las pantallas y el programa: solo las funciones necesarias (las páginas no tienen
// acceso a Node.js ni a los archivos). El programa revisa quién llama a cada función.
const { contextBridge, ipcRenderer } = require('electron');

function leerImpresion() {
  try {
    return ipcRenderer.sendSync('impresion:config') || {};
  } catch {
    return {};
  }
}

let version = '';
try {
  version = ipcRenderer.sendSync('app:version') || '';
} catch { /* sin versión */ }

contextBridge.exposeInMainWorld('farmaciaEscritorio', {
  version,
  impresion: leerImpresion(),
  leerImpresion,
  imprimir: (opciones) => ipcRenderer.invoke('imprimir', opciones),
  abrirConfiguracion: () => ipcRenderer.invoke('config:abrir'),
  abrirCarpetaRespaldos: () => ipcRenderer.invoke('respaldos:abrir'),
  buscarActualizaciones: () => ipcRenderer.invoke('actualizar:buscar'),
  // Solo para las pantallas propias del programa (configuración y error)
  configuracion: {
    leer: () => ipcRenderer.invoke('config:leer'),
    impresoras: () => ipcRenderer.invoke('config:impresoras'),
    probarConexion: (datos) => ipcRenderer.invoke('config:probar', datos),
    examinarAnterior: (tipo) => ipcRenderer.invoke('config:examinar', tipo),
    elegirCarpeta: () => ipcRenderer.invoke('config:elegir-carpeta'),
    imprimirPrueba: (datos) => ipcRenderer.invoke('config:imprimir-prueba', datos),
    guardar: (datos) => ipcRenderer.invoke('config:guardar', datos),
    cancelar: () => ipcRenderer.invoke('config:cancelar'),
  },
  error: () => ipcRenderer.invoke('app:error'),
  reintentar: () => ipcRenderer.invoke('app:reintentar'),
  abrirRegistros: () => ipcRenderer.invoke('app:registros'),
  salir: () => ipcRenderer.invoke('app:salir'),
});
