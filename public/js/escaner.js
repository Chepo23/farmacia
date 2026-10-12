// Lector de códigos de barras con la cámara del celular.
// - Android (Chrome): usa el lector que trae el navegador (BarcodeDetector).
// - iPhone y otros: carga ZXing (vendor/zxing) y lee la franja central de la imagen.
// También lee códigos QR (para vincular el celular con la computadora): abrir({ formatos: 'qr' }).
// La cámara solo funciona en páginas seguras (https://) o en localhost.
const Escaner = (() => {
  const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
  // Mientras el mismo código siga a la vista no se vuelve a contar; al quitarlo y volver a apuntar, sí
  const ESPERA_MISMO_CODIGO_MS = 1200;

  const el = {};
  let flujo = null;
  let pista = null;
  let detector = null;
  let lector = null;
  let tipoLector = ''; // 'barras' o 'qr'
  let lienzo = null;
  let contexto = null;
  let corriendo = false;
  let pausado = false;
  let opciones = null;
  let ultimo = { texto: '', hora: 0 };
  let camaras = [];
  let indiceCamara = -1;
  let linterna = false;
  let audio = null;
  let temporizador = null;

  function iniciarElementos() {
    el.capa = document.getElementById('escaner');
    el.video = document.getElementById('escaner-video');
    el.titulo = document.getElementById('escaner-titulo');
    el.ultimo = document.getElementById('escaner-ultimo');
    el.linterna = document.getElementById('escaner-linterna');
    el.camara = document.getElementById('escaner-camara');
    el.teclear = document.getElementById('escaner-teclear');
    document.getElementById('escaner-cerrar').addEventListener('click', () => cerrar());
    el.linterna.addEventListener('click', alternarLinterna);
    el.camara.addEventListener('click', cambiarCamara);
    el.teclear.addEventListener('click', () => {
      cerrar();
      if (opciones && opciones.alTeclear) opciones.alTeclear();
    });
  }

  function disponible() {
    return Boolean(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // El sonido solo se puede preparar en respuesta a un toque del usuario (iPhone)
  function prepararSonido() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* sin sonido */ }
  }

  function sonar(tipo = 'ok') {
    try {
      if (audio) {
        const oscilador = audio.createOscillator();
        const volumen = audio.createGain();
        oscilador.type = 'square';
        oscilador.frequency.value = tipo === 'ok' ? 1250 : 320;
        volumen.gain.value = 0.07;
        oscilador.connect(volumen);
        volumen.connect(audio.destination);
        oscilador.start();
        oscilador.stop(audio.currentTime + (tipo === 'ok' ? 0.08 : 0.25));
      }
    } catch { /* sin sonido */ }
    // El navegador solo deja vibrar después de que el usuario tocó la pantalla
    const tocado = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (navigator.vibrate && tocado) navigator.vibrate(tipo === 'ok' ? 50 : [80, 60, 80]);
  }

  function cargarZxing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise((listo, fallo) => {
      const script = document.createElement('script');
      script.src = 'vendor/zxing/index.min.js';
      script.onload = listo;
      script.onerror = () => fallo(new Error('No se pudo cargar el lector de códigos. Revisa la conexión.'));
      document.head.appendChild(script);
    });
  }

  async function prepararLector(tipo) {
    if (tipoLector === tipo && (detector || lector)) return;
    detector = null;
    lector = null;
    tipoLector = '';
    const buscados = tipo === 'qr' ? ['qr_code'] : FORMATOS;
    if ('BarcodeDetector' in window) {
      try {
        const soportados = await window.BarcodeDetector.getSupportedFormats();
        const formatos = buscados.filter((f) => soportados.includes(f));
        if (formatos.length) {
          detector = new window.BarcodeDetector({ formats: formatos });
          tipoLector = tipo;
          return;
        }
      } catch { /* se usa ZXing */ }
    }
    await cargarZxing();
    const Z = window.ZXing;
    const pistas = new Map();
    pistas.set(Z.DecodeHintType.POSSIBLE_FORMATS, tipo === 'qr' ? [Z.BarcodeFormat.QR_CODE] : [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODABAR,
    ]);
    pistas.set(Z.DecodeHintType.TRY_HARDER, true);
    lector = new Z.MultiFormatReader();
    lector.setHints(pistas);
    if (!lienzo) {
      lienzo = document.createElement('canvas');
      contexto = lienzo.getContext('2d', { willReadFrequently: true });
    }
    tipoLector = tipo;
  }

  // Lee un cuadro del video; devuelve el texto del código o null
  async function leerCuadro() {
    const video = el.video;
    if (!video.videoWidth || video.readyState < 2) return null;
    if (detector) {
      const codigos = await detector.detect(video);
      return codigos.length ? codigos[0].rawValue : null;
    }
    // ZXing: la zona de la guía (franja central, o un cuadro para el QR), reducida y en escala de grises
    const anchoVideo = video.videoWidth;
    const altoVideo = video.videoHeight;
    const esQr = tipoLector === 'qr';
    const recorteAncho = esQr ? Math.min(anchoVideo, altoVideo) * 0.85 : anchoVideo * 0.9;
    const recorteAlto = esQr ? recorteAncho : altoVideo * 0.45;
    const escala = Math.min(1, (esQr ? 640 : 900) / recorteAncho);
    const ancho = Math.round(recorteAncho * escala);
    const alto = Math.round(recorteAlto * escala);
    lienzo.width = ancho;
    lienzo.height = alto;
    contexto.drawImage(video, (anchoVideo - recorteAncho) / 2, (altoVideo - recorteAlto) / 2, recorteAncho, recorteAlto, 0, 0, ancho, alto);
    const { data } = contexto.getImageData(0, 0, ancho, alto);
    const grises = new Uint8ClampedArray(ancho * alto);
    for (let i = 0, j = 0; j < grises.length; i += 4, j += 1) {
      grises[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    const Z = window.ZXing;
    try {
      const fuente = new Z.RGBLuminanceSource(grises, ancho, alto);
      return lector.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(fuente))).getText();
    } catch {
      return null; // no hay código en este cuadro
    } finally {
      lector.reset();
    }
  }

  async function ciclo() {
    if (!corriendo) return;
    if (!pausado) {
      try {
        const texto = await leerCuadro();
        if (texto && corriendo && !pausado) {
          const ahora = Date.now();
          if (texto === ultimo.texto && ahora - ultimo.hora < ESPERA_MISMO_CODIGO_MS) {
            ultimo.hora = ahora; // sigue a la vista
          } else {
            ultimo = { texto, hora: ahora };
            sonar('ok');
            const seguir = await opciones.alLeer(texto.trim());
            if (!opciones.continuo || seguir === false) {
              cerrar();
              return;
            }
          }
        }
      } catch (error) {
        console.warn('Error al leer el cuadro', error);
      }
    }
    temporizador = setTimeout(ciclo, detector ? 110 : 160);
  }

  async function encenderCamara() {
    const video = indiceCamara >= 0 && camaras[indiceCamara]
      ? { deviceId: { exact: camaras[indiceCamara].deviceId } }
      : { facingMode: { ideal: 'environment' } };
    flujo = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...video, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    el.video.srcObject = flujo;
    await el.video.play().catch(() => {});
    pista = flujo.getVideoTracks()[0];
    try {
      await pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* la cámara no permite elegir el enfoque */ }
    const capacidades = pista.getCapabilities ? pista.getCapabilities() : {};
    el.linterna.hidden = !capacidades.torch;
    el.linterna.classList.toggle('activo', false);
    linterna = false;
    try {
      camaras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      camaras = [];
    }
    el.camara.hidden = camaras.length < 2;
  }

  function apagarCamara() {
    if (flujo) flujo.getTracks().forEach((t) => t.stop());
    flujo = null;
    pista = null;
    el.video.srcObject = null;
  }

  function mensajeDeError(error) {
    if (!disponible()) {
      return 'La cámara solo funciona si abres el sistema con https:// (pide la dirección segura al administrador). Mientras tanto escribe el código o usa un lector Bluetooth.';
    }
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      return 'No se dio permiso para usar la cámara. Actívalo en la configuración del navegador para este sitio.';
    }
    if (error && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
      return 'No se encontró una cámara disponible en este dispositivo.';
    }
    if (error && error.name === 'NotReadableError') return 'Otra aplicación está usando la cámara. Ciérrala e intenta de nuevo.';
    return (error && error.message) || 'No se pudo abrir la cámara';
  }

  // opciones: { titulo, continuo, formatos ('barras' | 'qr'), alLeer(texto) -> false para cerrar, alCerrar(), alTeclear() }
  async function abrir(nuevas) {
    if (!el.capa) iniciarElementos();
    prepararSonido();
    if (!disponible()) throw new Error(mensajeDeError());
    opciones = nuevas;
    ultimo = { texto: '', hora: 0 };
    pausado = false;
    el.titulo.textContent = nuevas.titulo || 'Apunta al código de barras';
    el.ultimo.hidden = true;
    el.capa.classList.toggle('qr', nuevas.formatos === 'qr');
    el.capa.hidden = false;
    try {
      await prepararLector(nuevas.formatos === 'qr' ? 'qr' : 'barras');
      await encenderCamara();
    } catch (error) {
      cerrar();
      throw new Error(mensajeDeError(error));
    }
    corriendo = true;
    ciclo();
  }

  function cerrar() {
    corriendo = false;
    clearTimeout(temporizador);
    apagarCamara();
    if (el.capa) el.capa.hidden = true;
    const alCerrar = opciones && opciones.alCerrar;
    opciones = null;
    if (alCerrar) alCerrar();
  }

  async function alternarLinterna() {
    if (!pista) return;
    try {
      linterna = !linterna;
      await pista.applyConstraints({ advanced: [{ torch: linterna }] });
      el.linterna.classList.toggle('activo', linterna);
    } catch {
      el.linterna.hidden = true;
    }
  }

  async function cambiarCamara() {
    if (camaras.length < 2) return;
    indiceCamara = (indiceCamara + 1) % camaras.length;
    apagarCamara();
    try {
      await encenderCamara();
    } catch (error) {
      informar(mensajeDeError(error), { error: true });
    }
  }

  // Mensaje en la parte de abajo de la cámara (último producto leído, errores…)
  function informar(html, { error = false, boton = null } = {}) {
    if (!el.ultimo) return;
    el.ultimo.className = `escaner-ultimo${error ? ' error' : ''}`;
    el.ultimo.innerHTML = `<span>${html}</span>`;
    if (boton) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = boton.texto;
      b.addEventListener('click', boton.alPulsar);
      el.ultimo.appendChild(b);
    }
    el.ultimo.hidden = false;
    if (error) sonar('error');
  }

  return {
    disponible,
    abrir,
    cerrar,
    informar,
    sonar,
    prepararSonido,
    pausar: (valor) => { pausado = Boolean(valor); },
    abierto: () => corriendo,
  };
})();
