// Administración: usuarios, sucursales y departamentos (solo admin)
const Admin = { usuarios: [], sucursales: [], departamentos: [] };

async function cargarAdmin() {
  if (App.usuario.rol !== 'admin') return;
  [Admin.usuarios, Admin.sucursales, Admin.departamentos] = await Promise.all([
    api('/api/admin/usuarios'),
    api('/api/admin/sucursales'),
    api('/api/departamentos'),
  ]);
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
          <button class="boton chico peligro-suave" data-accion="eliminar" data-id="${u.id}" title="Eliminar"><svg class="icono"><use href="#i-basura"/></svg></button>
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
        <td><button class="boton chico" data-accion="editar" data-id="${s.id}">Editar</button></td>
      </tr>`
    )
    .join('');
}

function formularioUsuario(u = {}) {
  const esNuevo = !u.id;
  const modal = abrirModal(`
    <h3>${esNuevo ? 'Nuevo usuario' : 'Editar usuario'}</h3>
    <div class="fila">
      <label>Nombre completo <input type="text" id="usu-nombre" value="${escaparHtml(u.nombre || '')}"></label>
      <label>Usuario (para entrar) <input type="text" id="usu-usuario" value="${escaparHtml(u.usuario || '')}"></label>
    </div>
    <div class="fila">
      <label>Contraseña ${esNuevo ? '' : '(dejar vacío para no cambiarla)'}
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

function formularioSucursal(s = {}) {
  const esNueva = !s.id;
  const modal = abrirModal(`
    <h3>${esNueva ? 'Nueva sucursal' : 'Editar sucursal'}</h3>
    <label>Nombre <input type="text" id="suc-nombre" value="${escaparHtml(s.nombre || '')}"></label>
    <label>Dirección (aparece en el ticket) <input type="text" id="suc-direccion" value="${escaparHtml(s.direccion || '')}"></label>
    <label>Teléfono (aparece en el ticket) <input type="text" id="suc-telefono" value="${escaparHtml(s.telefono || '')}"></label>
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
      cargarAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

function formularioDepartamento() {
  const modal = abrirModal(`
    <h3>Nuevo departamento</h3>
    <label>Nombre <input type="text" id="dep-nombre" placeholder="Ej. Analgésicos"></label>
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

document.getElementById('cuerpo-departamentos').addEventListener('click', async (e) => {
  const boton = e.target.closest('button[data-accion="eliminar"]');
  if (!boton) return;
  const departamento = Admin.departamentos.find((d) => d.id === Number(boton.dataset.id));
  if (!departamento) return;
  if (confirm(`¿Eliminar el departamento "${departamento.nombre}"? Los productos que lo usan lo conservan.`)) {
    await api('/api/departamentos/' + departamento.id, { method: 'DELETE' });
    aviso('Departamento eliminado');
    cargarAdmin();
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
    if (confirm(`¿Desactivar al usuario "${usuario.nombre}"?`)) {
      try {
        await api('/api/admin/usuarios/' + usuario.id, { method: 'DELETE' });
        aviso('Usuario desactivado');
        cargarAdmin();
      } catch (err) {
        aviso(err.message, 'error');
      }
    }
  }
});

document.getElementById('cuerpo-sucursales').addEventListener('click', (e) => {
  const boton = e.target.closest('button[data-accion]');
  if (!boton) return;
  const sucursal = Admin.sucursales.find((s) => s.id === Number(boton.dataset.id));
  if (sucursal) formularioSucursal(sucursal);
});

App.alMostrarSeccion.admin = cargarAdmin;
