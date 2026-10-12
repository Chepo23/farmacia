// Administración: usuarios, sucursales, departamentos, datos del ticket y sincronización
const Admin = { usuarios: [], sucursales: [], departamentos: [] };

async function cargarAdmin() {
  if (App.usuario.rol !== 'admin') return;
  try {
    [Admin.usuarios, Admin.sucursales, Admin.departamentos] = await Promise.all([
      api('/api/admin/usuarios'),
      api('/api/admin/sucursales'),
      api('/api/departamentos'),
    ]);
  } catch (err) {
    aviso(err.message, 'error');
    return;
  }
  App.sucursales = Admin.sucursales;

  document.getElementById('cuerpo-departamentos').innerHTML = Admin.departamentos
    .map(
      (d) => `<tr>
        <td>${escaparHtml(d.nombre)}</td>
        <td><button class="boton chico peligro-suave" data-accion="eliminar" data-id="${d.id}" title="Eliminar"><svg class="icono"><use href="#i-basura"/></svg></button></td>
      </tr>`
    )
    .join('') || '<tr><td colspan="2">Todavía no hay departamentos</td></tr>';

  document.getElementById('cuerpo-usuarios').innerHTML = Admin.usuarios
    .map(
      (u) => `<tr>
        <td>${escaparHtml(u.nombre)}</td>
        <td>${escaparHtml(u.usuario)}</td>
        <td>${u.rol === 'admin' ? 'Administrador' : 'Cajero'}</td>
        <td>${escaparHtml(u.sucursal)}</td>
        <td style="white-space:nowrap">
          <button class="boton chico" data-accion="editar" data-id="${u.id}">Editar</button>
          ${u.id === App.usuario.id ? '' : `<button class="boton chico peligro-suave" data-accion="eliminar" data-id="${u.id}" title="Dar de baja"><svg class="icono"><use href="#i-basura"/></svg></button>`}
        </td>
      </tr>`
    )
    .join('');

  document.getElementById('cuerpo-sucursales').innerHTML = Admin.sucursales
    .map(
      (s) => `<tr>
        <td>${escaparHtml(s.nombre)}${s.es_central ? ' ⭐' : ''}</td>
        <td>${escaparHtml(s.direccion)}</td>
        <td>${escaparHtml(s.telefono)}</td>
        <td style="white-space:nowrap">
          <button class="boton chico" data-accion="editar" data-id="${s.id}">Editar</button>
          <button class="boton chico peligro-suave" data-accion="eliminar-sucursal" data-id="${s.id}" title="Dar de baja la sucursal" ${s.es_central ? 'disabled' : ''}>
            <svg class="icono"><use href="#i-basura"/></svg>
          </button>
        </td>
      </tr>`
    )
    .join('');

  pintarConfig();
  cargarSincronizacion();
  cargarRespaldos();
  pintarPrograma();
}

function formularioUsuario(u = {}) {
  const esNuevo = !u.id;
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo usuario' : 'Editar usuario'}</h3>
    <div class="fila">
      <label>Nombre completo <input type="text" id="usu-nombre" value="${escaparHtml(u.nombre || '')}" maxlength="120"></label>
      <label>Usuario (para entrar) <input type="text" id="usu-usuario" value="${escaparHtml(u.usuario || '')}" maxlength="30" autocomplete="off"></label>
    </div>
    <div class="fila">
      <label>Contraseña ${esNuevo ? '(mínimo 4 caracteres)' : '(dejar vacío para no cambiarla)'}
        <input type="password" id="usu-password" autocomplete="new-password">
      </label>
      <label>Rol
        <select id="usu-rol">
          <option value="cajero" ${u.rol === 'cajero' ? 'selected' : ''}>Cajero</option>
          <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Administrador</option>
        </select>
      </label>
      <label>Sucursal
        <select id="usu-sucursal">
          ${Admin.sucursales.map((s) => `<option value="${s.id}" ${u.sucursal_id === s.id ? 'selected' : ''}>${escaparHtml(s.nombre)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="usu-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="usu-cancelar">Cancelar</button>
      <button class="boton exito" id="usu-guardar">Guardar</button>
    </div>
  `);
  modal.querySelector('#usu-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#usu-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#usu-error');
    errorEl.hidden = true;
    try {
      await api(esNuevo ? '/api/admin/usuarios' : '/api/admin/usuarios/' + u.id, {
        method: esNuevo ? 'POST' : 'PUT',
        body: {
          nombre: modal.querySelector('#usu-nombre').value,
          usuario: modal.querySelector('#usu-usuario').value,
          password: modal.querySelector('#usu-password').value,
          rol: modal.querySelector('#usu-rol').value,
          sucursal_id: modal.querySelector('#usu-sucursal').value,
        },
      });
      cerrarModal();
      aviso('Usuario guardado', 'exito');
      cargarAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// alGuardar permite reutilizar este formulario desde la sección de Apoyos
function formularioSucursal(s = {}, alGuardar = null) {
  const esNueva = !s.id;
  const modal = abrirModal(`
    <h3>${esNueva ? 'Nueva sucursal' : 'Editar sucursal'}</h3>
    <label>Nombre <input type="text" id="suc-nombre" value="${escaparHtml(s.nombre || '')}" maxlength="120"></label>
    <label>Dirección (aparece en el ticket) <input type="text" id="suc-direccion" value="${escaparHtml(s.direccion || '')}" maxlength="200"></label>
    <label>Teléfono (aparece en el ticket) <input type="text" id="suc-telefono" value="${escaparHtml(s.telefono || '')}" maxlength="40"></label>
    <div id="suc-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="suc-cancelar">Cancelar</button>
      <button class="boton exito" id="suc-guardar">Guardar</button>
    </div>
  `);
  modal.querySelector('#suc-cancelar').addEventListener('click', cerrarModal);
  modal.querySelector('#suc-guardar').addEventListener('click', async () => {
    const errorEl = modal.querySelector('#suc-error');
    errorEl.hidden = true;
    try {
      await api(esNueva ? '/api/admin/sucursales' : '/api/admin/sucursales/' + s.id, {
        method: esNueva ? 'POST' : 'PUT',
        body: {
          nombre: modal.querySelector('#suc-nombre').value,
          direccion: modal.querySelector('#suc-direccion').value,
          telefono: modal.querySelector('#suc-telefono').value,
        },
      });
      cerrarModal();
      aviso('Sucursal guardada', 'exito');
      App.sucursales = await api('/api/admin/sucursales');
      if (alGuardar) alGuardar();
      else cargarAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function formularioDepartamento() {
  const modal = abrirModal(`
    <h3>Nuevo departamento</h3>
    <label>Nombre <input type="text" id="dep-nombre" placeholder="Ej. Analgésicos" maxlength="80"></label>
    <div id="dep-error" class="mensaje-error" hidden></div>
    <div class="pie">
      <button class="boton" id="dep-cancelar">Cancelar</button>
      <button class="boton exito" id="dep-guardar">Guardar</button>
    </div>
  `);
  modal.querySelector('#dep-cancelar').addEventListener('click', cerrarModal);
  async function guardar() {
    const errorEl = modal.querySelector('#dep-error');
    errorEl.hidden = true;
    try {
      await api('/api/departamentos', {
        method: 'POST',
        body: { nombre: modal.querySelector('#dep-nombre').value },
      });
      cerrarModal();
      aviso('Departamento guardado', 'exito');
      cargarAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }
  modal.querySelector('#dep-guardar').addEventListener('click', guardar);
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); guardar(); }
  });
}

// ---------- Datos del ticket ----------
function pintarConfig() {
  const c = App.config || {};
  document.getElementById('cfg-nombre').value = c.negocio_nombre || '';
  document.getElementById('cfg-encabezado').value = c.ticket_encabezado || '';
  document.getElementById('cfg-rfc').value = c.negocio_rfc || '';
  document.getElementById('cfg-mensaje').value = c.ticket_mensaje || '';
  document.getElementById('cfg-pie').value = c.ticket_pie || '';
  const ancho = String(c.ticket_ancho || '80');
  const comun = ['58', '80'].includes(ancho);
  document.getElementById('cfg-ancho').value = comun ? ancho : 'otro';
  document.getElementById('cfg-ancho-otro').value = comun ? '' : ancho;
  document.getElementById('cfg-ancho-otro').hidden = comun;
  document.getElementById('cfg-url-movil').value = c.url_movil || '';
  // En el programa de escritorio el ancho va con la impresora de esta computadora
  const enPrograma = Boolean(window.farmaciaEscritorio);
  document.getElementById('cfg-ancho').hidden = enPrograma;
  document.getElementById('cfg-ancho-otro').hidden = enPrograma || comun;
  document.getElementById('cfg-ancho-nota').hidden = !enPrograma;
}

document.getElementById('cfg-ancho').addEventListener('change', (e) => {
  const otro = document.getElementById('cfg-ancho-otro');
  otro.hidden = e.target.value !== 'otro';
  if (!otro.hidden) otro.focus();
});

function anchoElegido() {
  const valor = document.getElementById('cfg-ancho').value;
  return valor === 'otro' ? document.getElementById('cfg-ancho-otro').value : valor;
}

document.getElementById('form-config').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    App.config = await api('/api/config', {
      method: 'PUT',
      body: {
        negocio_nombre: document.getElementById('cfg-nombre').value,
        ticket_encabezado: document.getElementById('cfg-encabezado').value,
        negocio_rfc: document.getElementById('cfg-rfc').value,
        ticket_mensaje: document.getElementById('cfg-mensaje').value,
        ticket_pie: document.getElementById('cfg-pie').value,
        ...(window.farmaciaEscritorio ? {} : { ticket_ancho: anchoElegido() }),
        url_movil: document.getElementById('cfg-url-movil').value,
      },
    });
    aviso('Datos guardados', 'exito');
  } catch (err) {
    aviso(err.message, 'error');
  }
});

document.getElementById('cfg-prueba').addEventListener('click', () => {
  const ahora = new Date();
  const fecha = `${ahora.toLocaleDateString('sv-SE')} ${ahora.toLocaleTimeString('es-MX', { hour12: false })}`;
  Impresion.imprimirVenta({
    folio: 0,
    fecha,
    cajero: App.usuario.nombre,
    forma_pago: 'efectivo',
    total: 98,
    pago: 100,
    cambio: 2,
    articulos: 3,
    ahorro: 0,
    nota: 'Ticket de prueba: no es una venta',
    partidas: [
      { cantidad: 2, descripcion: 'Paracetamol 500 mg c/10', precio_unitario: 28, precio_lista: 28, importe: 56 },
      { cantidad: 1, descripcion: 'Vitamina C 1000 mg', precio_unitario: 42, precio_lista: 42, importe: 42 },
    ],
  });
});

// ---------- Respaldos de esta computadora ----------
function tamanio(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round((Number(bytes) || 0) / 1024))} KB`;
}

async function cargarRespaldos() {
  const contenedor = document.getElementById('admin-respaldos');
  try {
    const r = await api('/api/respaldos');
    const ultimo = r.ultimo;
    contenedor.innerHTML = `
      <div class="dato-secundario"><span>Último respaldo</span>
        <b class="${ultimo ? '' : 'texto-rojo'}">${ultimo ? escaparHtml(new Date(ultimo.creado).toLocaleString('es-MX')) : 'Todavía no hay'}</b></div>
      <div class="dato-secundario"><span>Respaldos guardados</span><b>${r.total} (se conservan ${r.conservar_dias} días)</b></div>
      <div class="dato-secundario"><span>Carpeta</span><b class="texto-ruta">${escaparHtml(r.carpeta)}</b></div>
      ${r.carpeta_extra ? `<div class="dato-secundario"><span>Copia extra en</span><b class="texto-ruta">${escaparHtml(r.carpeta_extra)}</b></div>` : ''}
      ${r.activo ? '' : '<div class="mensaje-error">Los respaldos automáticos están apagados en esta computadora.</div>'}
      ${r.error ? `<div class="mensaje-error">${escaparHtml(r.error)}</div>` : ''}
      ${r.error_extra ? `<div class="mensaje-error">${escaparHtml(r.error_extra)}</div>` : ''}
      ${r.respaldos.length ? `<ul class="lista-respaldos">${r.respaldos.slice(0, 5).map((x) => `
        <li><span>${escaparHtml(x.nombre)} <small>${tamanio(x.bytes)}</small></span>
          <a class="boton chico" href="/api/respaldos/${encodeURIComponent(x.nombre)}" download>Descargar</a></li>`).join('')}</ul>` : ''}`;
  } catch (err) {
    contenedor.innerHTML = `<div class="mensaje-error">${escaparHtml(err.message)}</div>`;
  }
}

document.getElementById('boton-respaldar').addEventListener('click', async (e) => {
  const boton = e.currentTarget;
  boton.disabled = true;
  try {
    const r = await api('/api/respaldos', { method: 'POST' });
    aviso(`Respaldo guardado: ${r.nombre}`, 'exito');
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    boton.disabled = false;
  }
  cargarRespaldos();
});

// ---------- Programa de esta computadora (solo en el programa de escritorio) ----------
function pintarPrograma() {
  const programa = window.farmaciaEscritorio;
  const tarjeta = document.getElementById('tarjeta-programa');
  tarjeta.hidden = !programa;
  if (!programa) return;
  const i = (programa.leerImpresion ? programa.leerImpresion() : programa.impresion) || {};
  document.getElementById('admin-programa').innerHTML = `
    <div class="dato-secundario"><span>Versión</span><b>${escaparHtml(programa.version || '')}</b></div>
    <div class="dato-secundario"><span>Impresora de tickets</span><b>${escaparHtml(i.impresoraTicket || 'Preguntar al imprimir')} · ${escaparHtml(String(i.anchoTicket || 80))} mm</b></div>
    <div class="dato-secundario"><span>Impresora de documentos</span><b>${escaparHtml(i.impresoraDocumentos || 'Preguntar al imprimir')}</b></div>`;
}

document.getElementById('boton-programa-config').addEventListener('click', () => window.farmaciaEscritorio?.abrirConfiguracion());
document.getElementById('boton-programa-respaldos').addEventListener('click', () => window.farmaciaEscritorio?.abrirCarpetaRespaldos());
document.getElementById('boton-programa-actualizar').addEventListener('click', async (e) => {
  const boton = e.currentTarget;
  boton.disabled = true;
  try {
    const r = await window.farmaciaEscritorio.buscarActualizaciones();
    aviso(r.mensaje, r.ok ? 'exito' : 'error');
  } catch (err) {
    aviso(err.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

// ---------- Sincronización con la central ----------
async function cargarSincronizacion() {
  const contenedor = document.getElementById('admin-sync-estado');
  const errores = document.getElementById('admin-sync-errores');
  const boton = document.getElementById('boton-sincronizar');
  if (App.usuario.modo !== 'central') {
    contenedor.innerHTML = '<p><small>Esta computadora trabaja sin central (modo local): el inventario está en esta misma base de datos.</small></p>';
    boton.hidden = true;
    errores.innerHTML = '';
    return;
  }
  boton.hidden = false;
  try {
    const e = await api('/api/sync/estado');
    contenedor.innerHTML = `
      <div class="dato-secundario"><span>Conexión con la central</span><b class="${e.disponible ? 'texto-verde' : 'texto-rojo'}">${e.disponible ? 'En línea' : 'Sin conexión'}</b></div>
      <div class="dato-secundario"><span>Movimientos por subir</span><b>${e.pendientes}</b></div>
      <div class="dato-secundario"><span>Movimientos con error</span><b class="${e.errores ? 'texto-rojo' : ''}">${e.errores}</b></div>
      <div class="dato-secundario"><span>Última sincronización</span><b>${e.ultima_sincronizacion ? escaparHtml(new Date(e.ultima_sincronizacion).toLocaleString('es-MX')) : '—'}</b></div>
      ${e.ultimo_error ? `<div class="mensaje-error">${escaparHtml(e.ultimo_error)}</div>` : ''}`;
    errores.innerHTML = e.detalle_errores.length ? `
      <div class="lista-errores-sync">
        ${e.detalle_errores.map((x) => `<div class="error-sync">
          <span><b>${escaparHtml(x.descripcion || `Producto ${x.producto_id}`)}</b> — ${escaparHtml(x.tipo)} ${x.cantidad}<br><small>${escaparHtml(x.ultimo_error || '')}</small></span>
          <button class="boton chico peligro-suave" data-descartar="${x.id}">Descartar</button>
        </div>`).join('')}
        <button class="boton chico" id="boton-reintentar-sync">Reintentar todos</button>
      </div>` : '';
  } catch (err) {
    contenedor.innerHTML = `<div class="mensaje-error">${escaparHtml(err.message)}</div>`;
  }
}

document.getElementById('boton-sincronizar').addEventListener('click', async () => {
  try {
    const r = await api('/api/sync/sincronizar', { method: 'POST' });
    aviso(`Sincronizado: ${r.productos} productos, ${r.filas} existencias; ${r.enviados} movimiento(s) subidos`, 'exito');
  } catch (err) {
    aviso(err.message, 'error');
  }
  cargarSincronizacion();
  revisarSincronizacion();
});

document.getElementById('admin-sync-errores').addEventListener('click', async (e) => {
  const descartar = e.target.closest('button[data-descartar]');
  if (descartar) {
    const confirmado = await confirmar({
      titulo: 'Descartar movimiento',
      mensaje: 'El movimiento no se subirá a la central. Después revisa la existencia de ese producto en Productos (ajuste).',
      boton: 'Descartar',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api(`/api/productos/sincronizacion/${descartar.dataset.descartar}/descartar`, { method: 'POST' });
    } catch (err) {
      aviso(err.message, 'error');
    }
    cargarSincronizacion();
    return;
  }
  if (e.target.closest('#boton-reintentar-sync')) {
    try {
      await api('/api/productos/sincronizacion/reintentar', { method: 'POST' });
      aviso('Reintento enviado', 'exito');
    } catch (err) {
      aviso(err.message, 'error');
    }
    cargarSincronizacion();
    revisarSincronizacion();
  }
});

document.getElementById('cuerpo-departamentos').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion="eliminar"]');
  if (!boton) return;
  const departamento = Admin.departamentos.find((d) => d.id === Number(boton.dataset.id));
  if (!departamento) return;
  const confirmado = await confirmar({
    titulo: 'Eliminar departamento',
    mensaje: `¿Eliminar el departamento "${departamento.nombre}"? Los productos que lo usan lo conservan.`,
    boton: 'Eliminar',
    peligro: true,
  });
  if (!confirmado) return;
  try {
    await api('/api/departamentos/' + departamento.id, { method: 'DELETE' });
    aviso('Departamento eliminado');
    cargarAdmin();
  } catch (err) {
    aviso(err.message, 'error');
  }
});

document.getElementById('boton-nuevo-usuario').addEventListener('click', () => formularioUsuario());
document.getElementById('boton-nueva-sucursal').addEventListener('click', () => formularioSucursal());
document.getElementById('boton-nuevo-departamento').addEventListener('click', formularioDepartamento);

document.getElementById('cuerpo-usuarios').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const usuario = Admin.usuarios.find((u) => u.id === Number(boton.dataset.id));
  if (!usuario) return;
  if (boton.dataset.accion === 'editar') formularioUsuario(usuario);
  if (boton.dataset.accion === 'eliminar') {
    const confirmado = await confirmar({
      titulo: 'Dar de baja al usuario',
      mensaje: `"${usuario.nombre}" ya no podrá entrar al sistema. Sus ventas y movimientos se conservan con su nombre.`,
      boton: 'Dar de baja',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api('/api/admin/usuarios/' + usuario.id, { method: 'DELETE' });
      aviso('Usuario dado de baja', 'exito');
      cargarAdmin();
    } catch (err) {
      aviso(err.message, 'error');
    }
  }
});

document.getElementById('cuerpo-sucursales').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const sucursal = Admin.sucursales.find((s) => s.id === Number(boton.dataset.id));
  if (!sucursal) return;

  if (boton.dataset.accion === 'editar') {
    formularioSucursal(sucursal);
    return;
  }

  if (boton.dataset.accion === 'eliminar-sucursal') {
    const confirmado = await confirmar({
      titulo: `Dar de baja "${sucursal.nombre}"`,
      mensaje: 'La sucursal dejará de aparecer y sus usuarios ya no podrán entrar. Sus ventas, apoyos e inventario se conservan en el historial.',
      boton: 'Dar de baja la sucursal',
      peligro: true,
    });
    if (!confirmado) return;
    try {
      await api('/api/admin/sucursales/' + sucursal.id, { method: 'DELETE' });
      aviso('Sucursal dada de baja', 'exito');
      App.sucursales = await api('/api/admin/sucursales');
      cargarAdmin();
    } catch (err) {
      aviso(err.message, 'error');
    }
  }
});

App.alMostrarSeccion.admin = cargarAdmin;
