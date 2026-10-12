// Pantalla cuando el sistema no pudo arrancar (puerto ocupado, base bloqueada, etc.)
const programa = window.farmaciaEscritorio;
const $ = (id) => document.getElementById(id);

programa.error().then((e) => {
  $('mensaje').textContent = (e && e.mensaje) || 'Ocurrió un error al iniciar.';
  $('registro').textContent = (e && e.registro) || '';
});

$('reintentar').addEventListener('click', () => {
  $('reintentar').disabled = true;
  programa.reintentar();
});
$('configurar').addEventListener('click', () => programa.abrirConfiguracion());
$('registros').addEventListener('click', () => programa.abrirRegistros());
$('salir').addEventListener('click', () => programa.salir());
