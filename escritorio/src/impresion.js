// Impresión directa: el ticket va a la impresora térmica de esta computadora y los documentos tamaño
// carta a la impresora de documentos, sin ventana de "Imprimir". Si no se eligió impresora (o no está
// conectada), se abre la ventana de impresión de Windows como en el navegador.
// FARMACIA_IMPRESION_PDF=<carpeta>: en lugar de imprimir guarda un PDF (pruebas automáticas).
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const limitar = (n, minimo, maximo) => Math.min(maximo, Math.max(minimo, n));

// Medidas de la hoja para un ticket: el papel de la impresora y el alto real del contenido
function hojaTicket(anchoMm, altoMm) {
  const ancho = limitar(Math.round(Number(anchoMm) || 80), 40, 120);
  const alto = limitar(Math.ceil(Number(altoMm) || 150) + 4, 40, 3000);
  return { ancho, alto };
}

async function impresoraDisponible(webContents, nombre) {
  if (!nombre) return false;
  try {
    const impresoras = await webContents.getPrintersAsync();
    return impresoras.some((i) => i.name === nombre);
  } catch {
    return false;
  }
}

async function comoPdf(webContents, { tipo, hoja, impresora }) {
  const carpeta = process.env.FARMACIA_IMPRESION_PDF;
  fs.mkdirSync(carpeta, { recursive: true });
  const pulgadas = (mm) => mm / 25.4;
  const opciones = tipo === 'ticket'
    ? { pageSize: { width: pulgadas(hoja.ancho), height: pulgadas(hoja.alto) }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true }
    : { pageSize: 'Letter', printBackground: true };
  const datos = await webContents.printToPDF(opciones);
  const nombre = `${tipo}-${Date.now()}`;
  fs.writeFileSync(path.join(carpeta, `${nombre}.pdf`), datos);
  fs.writeFileSync(path.join(carpeta, `${nombre}.json`), JSON.stringify({ tipo, hoja, impresora }, null, 2));
  return { ok: true, archivo: `${nombre}.pdf` };
}

function enviar(webContents, opciones) {
  return new Promise((listo) => {
    webContents.print(opciones, (exito, motivo) => {
      if (exito) return listo({ ok: true });
      listo({ ok: false, motivo: motivo === 'cancelled' ? 'cancelado' : (motivo || 'la impresora no respondió') });
    });
  });
}

// tipo: 'ticket' | 'documento'
async function imprimir(webContents, conf, { tipo, anchoMm, altoMm }) {
  const esTicket = tipo === 'ticket';
  const nombre = esTicket ? conf.impresoraTicket : conf.impresoraDocumentos;
  const hoja = esTicket ? hojaTicket(anchoMm || conf.anchoTicket, altoMm) : null;
  if (process.env.FARMACIA_IMPRESION_PDF) return comoPdf(webContents, { tipo, hoja, impresora: nombre });
  const silenciosa = await impresoraDisponible(webContents, nombre);
  const opciones = {
    silent: silenciosa,
    printBackground: true,
    copies: 1,
    ...(silenciosa ? { deviceName: nombre } : {}),
    ...(esTicket
      ? { margins: { marginType: 'none' }, pageSize: { width: hoja.ancho * 1000, height: hoja.alto * 1000 } }
      : { pageSize: 'Letter' }),
  };
  const r = await enviar(webContents, opciones);
  if (nombre && !silenciosa && r.ok) r.aviso = `La impresora "${nombre}" no está conectada; se usó la ventana de impresión.`;
  return r;
}

// Ticket de prueba desde la configuración (antes de que el sistema esté en marcha)
function htmlPrueba(anchoMm, impresora) {
  const ancho = limitar(Math.round(Number(anchoMm) || 80), 40, 120);
  const util = ancho - (ancho <= 60 ? 10 : 8);
  const fecha = new Date().toLocaleString('es-MX');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: #fff; }
    .t { width: ${util}mm; padding: 2mm ${ancho <= 60 ? 1.5 : 3}mm 6mm; font: ${ancho <= 60 ? 10.5 : 11.5}px Arial, sans-serif; color: #000; }
    .c { text-align: center; } .b { font-weight: 800; font-size: 15px; text-transform: uppercase; }
    .r { border-top: 1px dashed #000; margin: 2mm 0; } .f { display: flex; justify-content: space-between; }
    .m { display: flex; justify-content: space-between; font-size: 9px; border: 1px solid #000; border-width: 1px 1px 0; padding: 0 1mm; }
  </style></head><body><div class="t" id="t">
    <div class="c b">Prueba de impresión</div>
    <div class="c">Farmacia — punto de venta</div>
    <div class="r"></div>
    <div class="f"><span>Impresora</span><span>${String(impresora || 'Preguntar').replace(/[<>&]/g, '')}</span></div>
    <div class="f"><span>Papel</span><span>${ancho} mm</span></div>
    <div class="f"><span>Fecha</span><span>${fecha}</span></div>
    <div class="r"></div>
    <div class="m"><span>|izquierda</span><span>derecha|</span></div>
    <div class="c" style="margin-top:2mm">Si las dos marcas de arriba salen completas, el ancho es correcto.</div>
    <div class="c b" style="margin-top:3mm;font-size:13px">$ 1,234.50</div>
  </div></body></html>`;
}

async function imprimirPrueba({ impresora, anchoMm }) {
  const ventana = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await ventana.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlPrueba(anchoMm, impresora))}`);
    const altoPx = await ventana.webContents.executeJavaScript('document.getElementById("t").getBoundingClientRect().height');
    const altoMm = (altoPx * 25.4) / 96;
    return await imprimir(ventana.webContents, { impresoraTicket: impresora, anchoTicket: anchoMm }, { tipo: 'ticket', anchoMm, altoMm });
  } finally {
    ventana.destroy();
  }
}

async function listarImpresoras(webContents) {
  try {
    const impresoras = await webContents.getPrintersAsync();
    return impresoras.map((i) => ({ nombre: i.name, visible: i.displayName || i.name, predeterminada: Boolean(i.isDefault) }));
  } catch {
    return [];
  }
}

module.exports = { imprimir, imprimirPrueba, listarImpresoras, hojaTicket };
