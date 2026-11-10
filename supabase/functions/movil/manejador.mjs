// Función "movil" de Supabase: atiende a la app del celular las 24 horas, aunque las
// computadoras de las farmacias estén apagadas. Habla con la base central con la llave secreta
// (que nunca sale de Supabase) y aplica las mismas reglas que el servidor de las computadoras:
// mismos permisos, mismos precios y mismo inventario.
//
// El celular se vincula con un código de un solo uso que genera el programa de la computadora
// (Administración o botón "Celular") y recibe una sesión de larga duración que se puede revocar.
//
// Este archivo no depende de Deno ni de Node: recibe el cliente de Supabase ya creado y usa
// Web Crypto, así se prueba en Node con la central falsa y se publica tal cual en Supabase.
// Lo del jefe (movimientos, cambios, inventario de las sucursales e inventario del día) vive en
// supervision.mjs, que también usa el servidor de cada computadora.
import { crearSupervision, esJefe, describirCambiosProducto } from './supervision.mjs';
import { crearVentasCentral } from './ventas.mjs';

const COLUMNAS_PRODUCTO =
  'id,codigo_barras,descripcion,departamento,precio_costo,precio_venta,precio_mayoreo,cantidad_mayoreo,usa_inventario,activo';
const TIPOS = ['entrada', 'salida', 'venta', 'ajuste'];
const SESION_MAX_DIAS_SIN_USO = 180;
const EPS = 1e-6;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

class ErrorApp extends Error {
  constructor(mensaje, { status = 400, codigo = '', datos = null } = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
    this.datos = datos;
  }
}

// ---------- Utilidades ----------
async function sha256(texto) {
  const datos = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', datos);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function tokenAleatorio() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Los códigos se escriben "ABCD-1234": se comparan sin guion y en mayúsculas
function normalizarCodigoVinculo(texto) {
  let valor = String(texto || '').trim();
  const enUrl = valor.match(/vincular=([A-Za-z0-9-]+)/);
  if (enUrl) valor = enUrl[1];
  return valor.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function lotes(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function idsValidos(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function numeroONulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function normalizarProducto(p) {
  if (!p) return null;
  return {
    id: Number(p.id),
    codigo_barras: p.codigo_barras ? String(p.codigo_barras) : null,
    descripcion: p.descripcion || '',
    departamento: p.departamento || '',
    precio_costo: Number(p.precio_costo) || 0,
    precio_venta: Number(p.precio_venta) || 0,
    precio_mayoreo: numeroONulo(p.precio_mayoreo),
    cantidad_mayoreo: numeroONulo(p.cantidad_mayoreo),
    usa_inventario: p.usa_inventario === false || p.usa_inventario === 0 ? 0 : 1,
    activo: p.activo === false || p.activo === 0 ? 0 : 1,
  };
}

// Mismas reglas que el formulario de producto de la computadora
function validarProducto(body) {
  const descripcion = String(body.descripcion || '').trim();
  if (!descripcion) return { error: 'La descripción es obligatoria' };
  if (descripcion.length > 200) return { error: 'La descripción es demasiado larga (máximo 200 caracteres)' };
  const precioVenta = Number(body.precio_venta);
  if (body.precio_venta === '' || body.precio_venta === null || body.precio_venta === undefined
    || !Number.isFinite(precioVenta) || precioVenta < 0) {
    return { error: 'Precio de venta no válido' };
  }
  const precioCosto = body.precio_costo === '' || body.precio_costo == null ? 0 : Number(body.precio_costo);
  if (!Number.isFinite(precioCosto) || precioCosto < 0) return { error: 'Precio de costo no válido' };
  const precioMayoreo = numeroONulo(body.precio_mayoreo);
  if (precioMayoreo !== null && precioMayoreo < 0) return { error: 'Precio de mayoreo no válido' };
  const cantidadMayoreo = numeroONulo(body.cantidad_mayoreo);
  if (cantidadMayoreo !== null && cantidadMayoreo <= 0) return { error: 'La cantidad para mayoreo debe ser mayor a cero' };
  return {
    codigo_barras: String(body.codigo_barras || '').trim() || null,
    descripcion,
    departamento: String(body.departamento || '').trim(),
    precio_costo: r2(precioCosto),
    precio_venta: r2(precioVenta),
    precio_mayoreo: precioMayoreo === null ? null : r2(precioMayoreo),
    cantidad_mayoreo: cantidadMayoreo,
    usa_inventario: !(body.usa_inventario === false || body.usa_inventario === 0 || body.usa_inventario === '0'),
  };
}

export function crearManejador({ supabase, origenesPermitidos = ['*'], registrar = console.error, zona = undefined } = {}) {
  const sb = () => supabase;

  async function consultar(builder) {
    let resultado;
    try {
      resultado = await builder;
    } catch (error) {
      resultado = { error: { message: error.message } };
    }
    if (resultado.error) {
      const e = new ErrorApp(resultado.error.message || 'Error de la base central', { status: 502, codigo: resultado.error.code || 'CENTRAL' });
      e.central = resultado.error;
      throw e;
    }
    return resultado;
  }

  // ---------- Sucursales y existencias ----------
  async function sucursalesActivas() {
    const { data } = await consultar(sb().from('sucursales').select('id,nombre,direccion,telefono,es_central,activa').eq('activa', true).order('id'));
    return (data || []).map((s) => ({ ...s, id: Number(s.id), es_central: s.es_central ? 1 : 0 }));
  }

  async function conExistencias(productos, usuario) {
    const lista = (productos || []).filter(Boolean);
    const sucursales = (await sucursalesActivas()).sort((a, b) => b.es_central - a.es_central || a.id - b.id);
    const ids = idsValidos(lista.filter((p) => p.usa_inventario).map((p) => p.id));
    const mapa = new Map();
    const porConsulta = Math.max(10, Math.floor(900 / Math.max(1, sucursales.length + 2)));
    for (const lote of lotes(ids, Math.min(150, porConsulta))) {
      const { data } = await consultar(sb().from('inventario').select('producto_id,sucursal_id,existencia,minimo').in('producto_id', lote));
      for (const f of data || []) {
        const p = Number(f.producto_id);
        if (!mapa.has(p)) mapa.set(p, new Map());
        mapa.get(p).set(Number(f.sucursal_id), { existencia: r2(f.existencia), minimo: r2(f.minimo) });
      }
    }
    return lista.map((p) => {
      const porSucursal = mapa.get(Number(p.id)) || new Map();
      const existencias = sucursales.map((s) => {
        const valor = porSucursal.get(s.id);
        return { sucursal_id: s.id, sucursal: s.nombre, es_central: s.es_central, existencia: valor ? valor.existencia : 0, minimo: valor ? valor.minimo : 0 };
      });
      const propia = existencias.find((e) => e.sucursal_id === Number(usuario.sucursal_id));
      return {
        ...p,
        existencias,
        existencia_local: propia ? propia.existencia : 0,
        minimo_local: propia ? propia.minimo : 0,
        total_disponible: r2(existencias.reduce((t, e) => t + e.existencia, 0)),
      };
    });
  }

  async function productoPorId(id, { incluirInactivos = false } = {}) {
    let consulta = sb().from('productos').select(COLUMNAS_PRODUCTO).eq('id', Number(id));
    if (!incluirInactivos) consulta = consulta.eq('activo', true);
    const { data } = await consultar(consulta.limit(1));
    return data && data[0] ? normalizarProducto(data[0]) : null;
  }

  // ---------- Movimientos de inventario (las mismas reglas que la computadora) ----------
  function normalizarMovimiento(m) {
    const tipo = String(m.tipo || '');
    if (!TIPOS.includes(tipo)) throw new ErrorApp('Tipo de movimiento no válido');
    const cantidad = Number(m.cantidad);
    if (m.cantidad === '' || m.cantidad === null || m.cantidad === undefined || !Number.isFinite(cantidad)
      || (tipo === 'ajuste' ? cantidad < 0 : cantidad <= 0)) {
      throw new ErrorApp(tipo === 'ajuste' ? 'La existencia del ajuste no puede ser negativa' : 'Cantidad no válida');
    }
    let minimo = null;
    if (m.minimo !== undefined && m.minimo !== null && m.minimo !== '') {
      minimo = Number(m.minimo);
      if (!Number.isFinite(minimo) || minimo < 0) throw new ErrorApp('Mínimo no válido');
      minimo = r2(minimo);
    }
    const cant = r2(cantidad);
    return {
      producto_id: Number(m.producto_id),
      sucursal_id: Number(m.sucursal_id),
      tipo,
      cantidad: cant,
      delta: tipo === 'entrada' ? cant : tipo === 'ajuste' ? null : -cant,
      fijar: tipo === 'ajuste' ? cant : null,
      minimo,
      nota: String(m.nota || '').trim().slice(0, 300),
      validar: m.validar ?? (tipo === 'salida' || tipo === 'venta'),
      descripcion: m.descripcion || '',
    };
  }

  function agrupar(movimientos) {
    const grupos = new Map();
    for (const m of movimientos) {
      const clave = `${m.producto_id}:${m.sucursal_id}`;
      if (!grupos.has(clave)) grupos.set(clave, { producto_id: m.producto_id, sucursal_id: m.sucursal_id, movs: [], minimo: null });
      const grupo = grupos.get(clave);
      grupo.movs.push(m);
      if (m.minimo !== null) grupo.minimo = m.minimo;
    }
    return [...grupos.values()];
  }

  function calcular(grupo, anterior, { validar = true } = {}) {
    let valor = r2(anterior);
    const pasos = [];
    for (const m of grupo.movs) {
      valor = r2(m.fijar !== null ? m.fijar : valor + m.delta);
      if (validar && m.validar && valor < -EPS) {
        const pedido = r2(-grupo.movs.reduce((t, x) => t + (x.delta || 0), 0));
        throw new ErrorApp(`No hay suficiente existencia de "${grupo.movs[0].descripcion || `producto ${grupo.producto_id}`}" (hay ${r2(anterior)} y se piden ${pedido})`, {
          codigo: 'SIN_EXISTENCIA',
          datos: { producto_id: grupo.producto_id, sucursal_id: grupo.sucursal_id, disponible: r2(anterior) },
        });
      }
      pasos.push(valor);
    }
    return { final: valor, pasos };
  }

  // Compara y escribe: si otra caja cambió la existencia entre la lectura y la escritura, reintenta
  async function casCentral(grupo, { validar = true } = {}) {
    for (let intento = 0; intento < 12; intento += 1) {
      const { data: filas } = await consultar(
        sb().from('inventario').select('existencia,minimo').eq('producto_id', grupo.producto_id).eq('sucursal_id', grupo.sucursal_id).limit(1)
      );
      const fila = filas && filas[0];
      const anterior = fila ? r2(fila.existencia) : 0;
      const { final, pasos } = calcular(grupo, anterior, { validar });
      const minimo = grupo.minimo !== null ? grupo.minimo : fila ? r2(fila.minimo) : 0;
      const ahora = new Date().toISOString();
      if (!fila) {
        try {
          await consultar(sb().from('inventario').insert({ producto_id: grupo.producto_id, sucursal_id: grupo.sucursal_id, existencia: final, minimo, updated_at: ahora }).select('id'));
        } catch (error) {
          if (error.codigo === '23505') continue;
          throw error;
        }
      } else {
        const cambios = { existencia: final, updated_at: ahora };
        if (grupo.minimo !== null) cambios.minimo = grupo.minimo;
        const { data } = await consultar(
          sb().from('inventario').update(cambios).eq('producto_id', grupo.producto_id).eq('sucursal_id', grupo.sucursal_id)
            .eq('existencia', fila.existencia).select('existencia')
        );
        if (!data || data.length === 0) {
          await esperar(15 + intento * 25 + Math.floor(Math.random() * 25));
          continue;
        }
      }
      return { ...grupo, anterior, existencia: final, minimo, pasos };
    }
    throw new ErrorApp('Otra caja está moviendo este mismo producto en este momento; intenta de nuevo', { status: 409, codigo: 'CONFLICTO' });
  }

  let centralTieneResultante = true;
  async function insertarMovimientos(filas) {
    if (!filas.length) return;
    if (centralTieneResultante) {
      try {
        await consultar(sb().from('movimientos_inventario').insert(filas));
        return;
      } catch (error) {
        if (!/existencia_resultante|PGRST204|42703/i.test(`${error.codigo} ${error.message}`)) throw error;
        centralTieneResultante = false;
      }
    }
    await consultar(sb().from('movimientos_inventario').insert(filas.map(({ existencia_resultante: _omitir, ...resto }) => resto)));
  }

  async function compensar(resultados) {
    for (const r of resultados) {
      const delta = r2(r.anterior - r.existencia);
      if (Math.abs(delta) < EPS) continue;
      try {
        await casCentral({ producto_id: r.producto_id, sucursal_id: r.sucursal_id, minimo: null, movs: [{ delta, fijar: null, validar: false }] }, { validar: false });
      } catch (error) {
        registrar('No se pudo revertir un movimiento de inventario:', error.message);
      }
    }
  }

  async function enParalelo(lista, limite, fn) {
    const resultados = new Array(lista.length);
    let siguiente = 0;
    async function trabajador() {
      while (siguiente < lista.length) {
        const i = siguiente;
        siguiente += 1;
        try {
          resultados[i] = { status: 'fulfilled', value: await fn(lista[i]) };
        } catch (reason) {
          resultados[i] = { status: 'rejected', reason };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabajador));
    return resultados;
  }

  // Aplica movimientos en la central: todo o nada
  async function aplicarMovimientos(movimientos, usuarioId) {
    const movs = movimientos.map(normalizarMovimiento);
    const grupos = agrupar(movs);
    if (!grupos.length) return [];
    const intentos = await enParalelo(grupos, 8, (g) => casCentral(g));
    const aplicados = intentos.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const errores = intentos.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errores.length) {
      await compensar(aplicados);
      throw errores[0];
    }
    const filas = [];
    for (const r of aplicados) {
      r.movs.forEach((m, i) => filas.push({
        producto_id: m.producto_id, sucursal_id: m.sucursal_id, tipo: m.tipo, cantidad: m.cantidad,
        usuario_id: usuarioId, nota: m.nota, existencia_resultante: r.pasos[i],
      }));
    }
    try {
      await insertarMovimientos(filas);
    } catch (error) {
      registrar('No se pudo registrar el historial de movimientos:', error.message);
    }
    return aplicados.map((r) => ({ producto_id: r.producto_id, sucursal_id: r.sucursal_id, existencia: r.existencia, minimo: r.minimo }));
  }

  async function fijarMinimo(productoId, sucursalId, minimo) {
    const valor = Number(minimo);
    if (!Number.isFinite(valor) || valor < 0) throw new ErrorApp('Mínimo no válido');
    const { data } = await consultar(
      sb().from('inventario').update({ minimo: r2(valor), updated_at: new Date().toISOString() })
        .eq('producto_id', productoId).eq('sucursal_id', sucursalId).select('existencia,minimo')
    );
    if (!data || data.length === 0) {
      await consultar(sb().from('inventario').insert({ producto_id: productoId, sucursal_id: sucursalId, existencia: 0, minimo: r2(valor) }).select('id'));
      return { existencia: 0, minimo: r2(valor) };
    }
    return { existencia: r2(data[0].existencia), minimo: r2(valor) };
  }

  const supervision = crearSupervision({ sb, consultar, ErrorApp, aplicarMovimientos, registrar, zona, ventasHoy: () => ventasCentral.hoyPorSucursal() });
  const ventasCentral = crearVentasCentral({ sb, consultar, ErrorApp, fechas: supervision });
  const anotarCambio = (cambio) => supervision.anotarCambio({ origen: 'celular', ...cambio });

  // ---------- Sesiones del celular ----------
  // select('*'): así la función sigue funcionando aunque la base central todavía no tenga la columna "jefe"
  async function perfilDe(usuarioId) {
    const { data: usuarios } = await consultar(sb().from('usuarios_central').select('*').eq('id', Number(usuarioId)).limit(1));
    const u = usuarios && usuarios[0];
    if (!u || u.activo === false) return null;
    const { data: sucursales } = await consultar(sb().from('sucursales').select('id,nombre,es_central,activa').eq('id', Number(u.sucursal_id)).limit(1));
    const s = sucursales && sucursales[0];
    if (!s || s.activa === false) return null;
    const rol = u.rol === 'admin' ? 'admin' : 'cajero';
    return {
      id: Number(u.id), nombre: u.nombre, usuario: u.usuario, rol,
      sucursal_id: Number(u.sucursal_id), sucursal: s.nombre, es_central: s.es_central ? 1 : 0,
      jefe: u.jefe === true && rol === 'admin' && Boolean(s.es_central) ? 1 : 0, modo: 'nube',
    };
  }

  async function sesionDe(req) {
    const encabezado = req.headers.get('authorization') || '';
    const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7).trim() : '';
    if (!token || token.length < 20) return null;
    const { data } = await consultar(
      sb().from('sesiones_movil').select('id,usuario_id,ultimo_uso,revocada').eq('token_hash', await sha256(token)).limit(1)
    );
    const sesion = data && data[0];
    if (!sesion || sesion.revocada) return null;
    const ultimoUso = new Date(sesion.ultimo_uso).getTime();
    if (Date.now() - ultimoUso > SESION_MAX_DIAS_SIN_USO * 86400000) return null;
    const usuario = await perfilDe(sesion.usuario_id);
    if (!usuario) return null;
    // Se renueva como mucho cada 10 minutos
    if (Date.now() - ultimoUso > 10 * 60000) {
      await consultar(sb().from('sesiones_movil').update({ ultimo_uso: new Date().toISOString() }).eq('id', sesion.id)).catch(() => {});
    }
    return { sesion, usuario };
  }

  const esAdminCentral = (u) => u.rol === 'admin' && Number(u.es_central) === 1;

  async function sucursalPermitida(usuario, sucursalId) {
    const sucursal = Number(sucursalId || usuario.sucursal_id);
    if (!sucursal) throw new ErrorApp('Sucursal no válida');
    if (sucursal !== Number(usuario.sucursal_id) && !esAdminCentral(usuario)) {
      throw new ErrorApp('Solo puedes modificar el inventario de tu sucursal', { status: 403 });
    }
    const { data } = await consultar(sb().from('sucursales').select('id').eq('id', sucursal).eq('activa', true).limit(1));
    if (!data || !data.length) throw new ErrorApp('Sucursal no válida');
    return sucursal;
  }

  // ---------- Rutas ----------
  const rutas = [];
  const ruta = (metodo, patron, fn, { publica = false } = {}) => rutas.push({ metodo, patron, fn, publica });

  // Vincular el celular con el código que dio la computadora
  ruta('POST', /^\/api\/movil\/vincular$/, async ({ cuerpo, req }) => {
    const codigo = normalizarCodigoVinculo(cuerpo.codigo);
    if (codigo.length < 6) throw new ErrorApp('Escribe el código que aparece en la computadora');
    const { data } = await consultar(sb().from('vinculos_movil').select('id,usuario_id,expira,usado').eq('codigo_hash', await sha256(codigo)).limit(1));
    const vinculo = data && data[0];
    if (!vinculo) {
      await esperar(700); // frena a quien intente adivinar códigos
      throw new ErrorApp('El código no es válido. Pide uno nuevo en la computadora.', { status: 400, codigo: 'CODIGO_INVALIDO' });
    }
    if (vinculo.usado) throw new ErrorApp('Ese código ya se usó. Pide uno nuevo en la computadora.', { codigo: 'CODIGO_USADO' });
    if (new Date(vinculo.expira).getTime() < Date.now()) {
      throw new ErrorApp('El código ya venció (duran 15 minutos). Pide uno nuevo en la computadora.', { codigo: 'CODIGO_VENCIDO' });
    }
    const { data: tomado } = await consultar(
      sb().from('vinculos_movil').update({ usado: new Date().toISOString() }).eq('id', vinculo.id).is('usado', null).select('id')
    );
    if (!tomado || !tomado.length) throw new ErrorApp('Ese código ya se usó. Pide uno nuevo en la computadora.', { codigo: 'CODIGO_USADO' });
    const usuario = await perfilDe(vinculo.usuario_id);
    if (!usuario) throw new ErrorApp('El usuario ya no está activo', { status: 403 });
    const token = tokenAleatorio();
    const dispositivo = String(cuerpo.dispositivo || req.headers.get('user-agent') || '').slice(0, 160);
    await consultar(sb().from('sesiones_movil').insert({ token_hash: await sha256(token), usuario_id: usuario.id, dispositivo }));
    return { token, usuario };
  }, { publica: true });

  ruta('POST', /^\/api\/auth\/logout$/, async ({ sesion }) => {
    await consultar(sb().from('sesiones_movil').update({ revocada: new Date().toISOString() }).eq('id', sesion.id));
    return { ok: true };
  });

  ruta('GET', /^\/api\/auth\/yo$/, async ({ usuario }) => usuario);

  ruta('GET', /^\/api\/admin\/sucursales$/, async () => sucursalesActivas());

  ruta('GET', /^\/api\/productos\/sincronizacion$/, async () => ({ modo: 'nube', disponible: true, pendientes: 0, errores: 0 }));

  ruta('GET', /^\/api\/productos\/codigo\/([^/]+)$/, async ({ usuario, params }) => {
    let codigo;
    try {
      codigo = decodeURIComponent(params[0]).trim();
    } catch {
      throw new ErrorApp('Código no válido');
    }
    const { data } = await consultar(sb().from('productos').select(COLUMNAS_PRODUCTO).eq('codigo_barras', codigo).eq('activo', true).limit(1));
    if (!data || !data.length) throw new ErrorApp('Producto no encontrado', { status: 404 });
    const [producto] = await conExistencias([normalizarProducto(data[0])], usuario);
    return producto;
  });

  ruta('GET', /^\/api\/productos\/buscar$/, async ({ usuario, url }) => {
    const texto = String(url.searchParams.get('q') || '').trim();
    let consulta = sb().from('productos').select(COLUMNAS_PRODUCTO).eq('activo', true);
    if (texto) {
      const patron = `"*${texto.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}*"`;
      consulta = consulta.or(`descripcion.ilike.${patron},codigo_barras.ilike.${patron}`);
    }
    const { data } = await consultar(consulta.order('descripcion').limit(50));
    const productos = (data || []).map(normalizarProducto);
    productos.sort((a, b) => (b.codigo_barras === texto) - (a.codigo_barras === texto));
    return conExistencias(productos, usuario);
  });

  ruta('GET', /^\/api\/productos\/(\d+)\/kardex$/, async ({ usuario, params, url }) => {
    const producto = await productoPorId(params[0], { incluirInactivos: true });
    if (!producto) throw new ErrorApp('Producto no encontrado', { status: 404 });
    const sucursal = Number(url.searchParams.get('sucursal_id')) || null;
    const tope = Math.min(Math.max(Number(url.searchParams.get('limite')) || 100, 1), 500);
    const columnas = `id,producto_id,sucursal_id,tipo,cantidad,usuario_id,nota,fecha${centralTieneResultante ? ',existencia_resultante' : ''}`;
    let consulta = sb().from('movimientos_inventario').select(columnas).eq('producto_id', producto.id);
    if (sucursal) consulta = consulta.eq('sucursal_id', sucursal);
    let resultado;
    try {
      resultado = await consultar(consulta.order('id', { ascending: false }).limit(tope));
    } catch (error) {
      if (!centralTieneResultante || !/existencia_resultante|42703|PGRST204/i.test(`${error.codigo} ${error.message}`)) throw error;
      centralTieneResultante = false;
      let otra = sb().from('movimientos_inventario').select('id,producto_id,sucursal_id,tipo,cantidad,usuario_id,nota,fecha').eq('producto_id', producto.id);
      if (sucursal) otra = otra.eq('sucursal_id', sucursal);
      resultado = await consultar(otra.order('id', { ascending: false }).limit(tope));
    }
    const filas = resultado.data || [];
    const idsUsuarios = idsValidos(filas.map((f) => f.usuario_id));
    const nombres = new Map();
    if (idsUsuarios.length) {
      const { data: usuarios } = await consultar(sb().from('usuarios_central').select('id,nombre').in('id', idsUsuarios));
      for (const u of usuarios || []) nombres.set(Number(u.id), u.nombre);
    }
    const sucursales = new Map((await sucursalesActivas()).map((s) => [s.id, s.nombre]));
    const [conStock] = await conExistencias([producto], usuario);
    return {
      fuente: 'central',
      producto: conStock,
      movimientos: filas.map((f) => ({
        id: f.id,
        fecha: f.fecha,
        sucursal_id: Number(f.sucursal_id),
        sucursal: sucursales.get(Number(f.sucursal_id)) || `Sucursal ${f.sucursal_id}`,
        tipo: f.tipo,
        cantidad: r2(f.cantidad),
        delta: f.tipo === 'entrada' ? r2(f.cantidad) : f.tipo === 'ajuste' ? null : -r2(f.cantidad),
        existencia_resultante: f.existencia_resultante == null ? null : r2(f.existencia_resultante),
        usuario: nombres.get(Number(f.usuario_id)) || (f.usuario_id ? `Usuario ${f.usuario_id}` : ''),
        nota: f.nota || '',
        pendiente: false,
      })),
    };
  });

  // Entrada, salida, ajuste o solo mínimo de un producto
  ruta('POST', /^\/api\/productos\/(\d+)\/inventario$/, async ({ usuario, params, cuerpo }) => {
    const sucursalId = await sucursalPermitida(usuario, cuerpo.sucursal_id);
    const producto = await productoPorId(params[0]);
    if (!producto) throw new ErrorApp('Producto no encontrado', { status: 404 });
    if (!producto.usa_inventario) throw new ErrorApp('Este producto no controla inventario');
    const { tipo, cantidad, minimo, nota } = cuerpo;
    const soloMinimo = (tipo === undefined || tipo === '' || tipo === 'minimo') && (cantidad === undefined || cantidad === '' || cantidad === null);
    if (soloMinimo) {
      if (minimo === undefined || minimo === '' || minimo === null) throw new ErrorApp('Indica la cantidad del movimiento o el nuevo mínimo');
      const r = await fijarMinimo(producto.id, sucursalId, minimo);
      return { ok: true, ...r };
    }
    const [r] = await aplicarMovimientos([{
      producto_id: producto.id, sucursal_id: sucursalId, tipo, cantidad, minimo,
      nota: String(nota || '').trim() || 'Desde el celular', descripcion: producto.descripcion,
    }], usuario.id);
    return { ok: true, existencia: r.existencia, minimo: r.minimo };
  });

  // Recepción de mercancía y conteo físico por lote (mismas reglas que la computadora)
  ruta('POST', /^\/api\/productos\/inventario\/lote$/, async ({ usuario, cuerpo }) => {
    const tipo = String(cuerpo.tipo || '');
    if (!['entrada', 'conteo'].includes(tipo)) throw new ErrorApp('Tipo de operación no válido');
    const sucursalId = await sucursalPermitida(usuario, cuerpo.sucursal_id);
    const renglones = Array.isArray(cuerpo.renglones) ? cuerpo.renglones : [];
    if (!renglones.length) throw new ErrorApp('No hay productos en la lista');
    if (renglones.length > 500) throw new ErrorApp('La lista es demasiado grande (máximo 500 productos)');
    const nota = String(cuerpo.nota || '').trim().slice(0, 200);
    const porProducto = new Map();
    for (const r of renglones) {
      const id = Number(r.producto_id);
      if (!(id > 0)) throw new ErrorApp('Producto no válido en la lista');
      if (tipo === 'entrada') {
        const cantidad = Number(r.cantidad);
        if (!Number.isFinite(cantidad) || !(cantidad > 0)) throw new ErrorApp('Hay una cantidad no válida en la lista');
        porProducto.set(id, { cantidad: (porProducto.get(id)?.cantidad || 0) + cantidad });
      } else {
        const contado = Number(r.contado);
        const alContar = Number(r.existencia_al_contar);
        if (!Number.isFinite(contado) || contado < 0 || !Number.isFinite(alContar)) throw new ErrorApp('Hay un conteo no válido en la lista');
        porProducto.set(id, { contado, alContar });
      }
    }
    const productos = new Map();
    for (const lote of lotes([...porProducto.keys()], 150)) {
      const { data } = await consultar(sb().from('productos').select(COLUMNAS_PRODUCTO).in('id', lote));
      for (const p of data || []) productos.set(Number(p.id), normalizarProducto(p));
    }
    const faltan = [...porProducto.keys()].filter((id) => !productos.has(id));
    if (faltan.length) throw new ErrorApp(`Hay productos que ya no existen en el catálogo (${faltan.join(', ')})`, { status: 404 });

    const movimientos = [];
    const omitidos = [];
    let sinDiferencia = 0;
    for (const [id, r] of porProducto) {
      const producto = productos.get(id);
      if (!producto.usa_inventario) {
        omitidos.push(producto.descripcion);
        continue;
      }
      if (tipo === 'entrada') {
        movimientos.push({ producto_id: id, sucursal_id: sucursalId, tipo: 'entrada', cantidad: r.cantidad, descripcion: producto.descripcion, nota: nota ? `Recepción de mercancía: ${nota}` : 'Recepción de mercancía' });
        continue;
      }
      const diferencia = r3(r.contado - r.alContar);
      if (Math.abs(diferencia) < 0.001) {
        sinDiferencia += 1;
        continue;
      }
      movimientos.push({
        producto_id: id, sucursal_id: sucursalId, tipo: diferencia > 0 ? 'entrada' : 'salida', cantidad: Math.abs(diferencia),
        validar: false, descripcion: producto.descripcion,
        nota: `Conteo físico: el sistema tenía ${r.alContar} y se contaron ${r.contado}${nota ? ` — ${nota}` : ''}`,
      });
    }
    const existencias = movimientos.length ? await aplicarMovimientos(movimientos, usuario.id) : [];
    return { ok: true, aplicados: movimientos.length, sin_diferencia: sinDiferencia, omitidos, existencias };
  });

  // Precios y datos del producto: solo el administrador de la central (se aplican en todas las sucursales)
  ruta('PUT', /^\/api\/productos\/(\d+)$/, async ({ usuario, params, cuerpo }) => {
    if (!esAdminCentral(usuario)) throw new ErrorApp('Solo el administrador de la central puede cambiar productos y precios', { status: 403, codigo: 'SOLO_CENTRAL' });
    const datos = validarProducto(cuerpo);
    if (datos.error) throw new ErrorApp(datos.error);
    const antes = await productoPorId(params[0]);
    try {
      const { data } = await consultar(
        sb().from('productos').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', Number(params[0])).eq('activo', true).select('id')
      );
      if (!data || !data.length) throw new ErrorApp('Producto no encontrado', { status: 404 });
    } catch (error) {
      if (/23505|duplicate/i.test(`${error.codigo} ${error.message}`)) throw new ErrorApp('Ya existe un producto con ese código de barras');
      throw error;
    }
    if (antes) {
      const cambios = describirCambiosProducto(antes, datos);
      if (cambios.lista.length) {
        await anotarCambio({
          usuario, tipo: 'producto_cambio', descripcion: `${datos.descripcion}: ${cambios.texto}`,
          detalle: { producto_id: antes.id, cambios: cambios.lista }, alerta: cambios.precio,
        });
      }
    }
    return { ok: true };
  });

  // Cualquier usuario da de alta un producto nuevo con su existencia en su sucursal (por ejemplo, al
  // recibir mercancía). Cambiar los precios de uno que ya existe sigue siendo de la central.
  ruta('POST', /^\/api\/productos$/, async ({ usuario, cuerpo }) => {
    const datos = validarProducto(cuerpo);
    if (datos.error) throw new ErrorApp(datos.error);
    const sucursalId = await sucursalPermitida(usuario, cuerpo.sucursal_id);
    const existenciaInicial = numeroONulo(cuerpo.existencia_inicial) ?? 0;
    const minimoInicial = numeroONulo(cuerpo.minimo_inicial) ?? 0;
    if (existenciaInicial < 0) throw new ErrorApp('Existencia inicial no válida');
    if (minimoInicial < 0) throw new ErrorApp('Mínimo inicial no válido');
    if (datos.codigo_barras) {
      const { data: existente } = await consultar(sb().from('productos').select('id').eq('codigo_barras', datos.codigo_barras).limit(1));
      if (existente && existente.length) throw new ErrorApp('Ya existe un producto con ese código de barras');
    }
    const { data } = await consultar(sb().from('productos').insert({ ...datos, activo: true }).select(COLUMNAS_PRODUCTO));
    const producto = normalizarProducto(data[0]);
    await anotarCambio({
      usuario, sucursal_id: sucursalId, tipo: 'producto_alta',
      descripcion: `${producto.descripcion} (${producto.codigo_barras || 'sin código'}) a $${producto.precio_venta.toFixed(2)}${existenciaInicial > 0 ? `, con ${existenciaInicial} pieza(s)` : ''}`,
      detalle: { producto_id: producto.id, precio_venta: producto.precio_venta, precio_costo: producto.precio_costo, existencia_inicial: existenciaInicial },
    });
    let aviso = null;
    if (producto.usa_inventario && (existenciaInicial > 0 || minimoInicial > 0)) {
      try {
        if (existenciaInicial > 0) {
          await aplicarMovimientos([{ producto_id: producto.id, sucursal_id: sucursalId, tipo: 'entrada', cantidad: existenciaInicial, minimo: minimoInicial, nota: 'Existencia inicial al dar de alta el producto' }], usuario.id);
        } else {
          await fijarMinimo(producto.id, sucursalId, minimoInicial);
        }
      } catch (error) {
        aviso = `El producto se guardó, pero no se pudo registrar la existencia inicial: ${error.message}`;
      }
    }
    return { ok: true, id: producto.id, aviso };
  });

  // ---------- Nombres de sucursales y usuarios ----------
  async function nombresDe({ sucursales = [], usuarios = [] }) {
    const mapaS = new Map();
    const mapaU = new Map();
    const s = idsValidos(sucursales);
    const u = idsValidos(usuarios);
    if (s.length) {
      const { data } = await consultar(sb().from('sucursales').select('id,nombre').in('id', s));
      for (const f of data || []) mapaS.set(Number(f.id), f.nombre);
    }
    if (u.length) {
      const { data } = await consultar(sb().from('usuarios_central').select('id,nombre').in('id', u));
      for (const f of data || []) mapaU.set(Number(f.id), f.nombre);
    }
    return {
      sucursal: (id) => mapaS.get(Number(id)) || (id ? `Sucursal ${id}` : ''),
      usuario: (id) => mapaU.get(Number(id)) || (id ? `Usuario ${id}` : ''),
    };
  }

  // ---------- Cotizaciones (mismas reglas que src/cotizaciones.js de la computadora) ----------
  // Las arma el administrador de la central y las manda a una sucursal (o a un usuario de ella);
  // la caja de esa sucursal la cobra. El precio cotizado se respeta 7 días.
  const DIAS_VIGENCIA_COTIZACION = 7;
  const ESTADOS_COTIZACION = ['enviada', 'vendida', 'cancelada'];
  const cotizacionVigente = (c) => c.estado === 'enviada' && new Date(c.vigente_hasta).getTime() >= Date.now();
  const soloAdminCentral = (usuario) => {
    if (!esAdminCentral(usuario)) throw new ErrorApp('Solo el administrador de la central arma cotizaciones', { status: 403, codigo: 'SOLO_CENTRAL' });
  };

  async function cotizacionPorId(id) {
    const { data } = await consultar(sb().from('cotizaciones').select('*').eq('id', Number(id)).limit(1));
    return data && data[0] ? data[0] : null;
  }

  async function completarCotizaciones(filas) {
    const ids = idsValidos(filas.map((c) => c.id));
    const detalles = [];
    for (const lote of lotes(ids, 100)) {
      const { data } = await consultar(sb().from('cotizacion_detalle').select('*').in('cotizacion_id', lote).order('id').limit(5000));
      detalles.push(...(data || []));
    }
    const n = await nombresDe({
      sucursales: filas.map((c) => c.destino_sucursal_id),
      usuarios: filas.flatMap((c) => [c.creado_por, c.destino_usuario_id, c.vendida_por]),
    });
    return filas.map((c) => {
      const renglones = detalles.filter((d) => Number(d.cotizacion_id) === Number(c.id)).map((d) => ({
        id: Number(d.id), producto_id: Number(d.producto_id), codigo_barras: d.codigo_barras || null, descripcion: d.descripcion || '',
        cantidad: r2(d.cantidad), precio_unitario: r2(d.precio_unitario), precio_lista: r2(d.precio_lista), importe: r2(d.importe),
      }));
      return {
        id: Number(c.id), folio: Number(c.folio), estado: c.estado, cliente: c.cliente || '', nota: c.nota || '', total: r2(c.total),
        creado: c.creado, vigente_hasta: c.vigente_hasta, vigente: cotizacionVigente(c),
        creado_por: Number(c.creado_por), creador: n.usuario(c.creado_por),
        origen_sucursal_id: Number(c.origen_sucursal_id), destino_sucursal_id: Number(c.destino_sucursal_id), destino: n.sucursal(c.destino_sucursal_id),
        destino_usuario_id: numeroONulo(c.destino_usuario_id), destino_usuario: c.destino_usuario_id ? n.usuario(c.destino_usuario_id) : '',
        vendida_folio: numeroONulo(c.vendida_folio), vendida_fecha: c.vendida_fecha || null, vendida_por: numeroONulo(c.vendida_por),
        vendedor: c.vendida_por ? n.usuario(c.vendida_por) : '', cancelada_fecha: c.cancelada_fecha || null,
        productos: renglones.length, articulos: r2(renglones.reduce((t, d) => t + d.cantidad, 0)), renglones,
      };
    });
  }

  async function cargarCotizacion(id, usuario) {
    const c = await cotizacionPorId(id);
    if (!c) throw new ErrorApp('Cotización no encontrada', { status: 404 });
    if (!esAdminCentral(usuario) && Number(c.destino_sucursal_id) !== Number(usuario.sucursal_id)) {
      throw new ErrorApp('Esa cotización es de otra sucursal', { status: 403 });
    }
    return (await completarCotizaciones([c]))[0];
  }

  ruta('GET', /^\/api\/cotizaciones\/destinos$/, async ({ usuario }) => {
    soloAdminCentral(usuario);
    const { data: usuarios } = await consultar(
      sb().from('usuarios_central').select('id,nombre,usuario,rol,sucursal_id').eq('activo', true).order('nombre')
    );
    return {
      sucursales: (await sucursalesActivas()).map((s) => ({ id: s.id, nombre: s.nombre, es_central: s.es_central })),
      usuarios: (usuarios || []).map((u) => ({ id: Number(u.id), nombre: u.nombre, usuario: u.usuario, rol: u.rol, sucursal_id: Number(u.sucursal_id) })),
    };
  });

  ruta('GET', /^\/api\/cotizaciones\/pendientes$/, async ({ usuario }) => {
    const { data } = await consultar(
      sb().from('cotizaciones').select('id,destino_usuario_id').eq('destino_sucursal_id', Number(usuario.sucursal_id)).eq('estado', 'enviada').limit(500)
    );
    const lista = data || [];
    return { pendientes: lista.length, para_mi: lista.filter((f) => Number(f.destino_usuario_id) === Number(usuario.id)).length };
  });

  ruta('GET', /^\/api\/cotizaciones$/, async ({ usuario, url }) => {
    const todas = url.searchParams.get('bandeja') === 'enviadas';
    if (todas) soloAdminCentral(usuario);
    const estado = url.searchParams.get('estado') || '';
    let consulta = sb().from('cotizaciones').select('*');
    if (!todas) consulta = consulta.eq('destino_sucursal_id', Number(usuario.sucursal_id));
    if (ESTADOS_COTIZACION.includes(estado)) consulta = consulta.eq('estado', estado);
    const { data } = await consultar(consulta.order('id', { ascending: false }).limit(100));
    return completarCotizaciones(data || []);
  });

  ruta('GET', /^\/api\/cotizaciones\/(\d+)$/, async ({ usuario, params }) => cargarCotizacion(params[0], usuario));

  ruta('POST', /^\/api\/cotizaciones$/, async ({ usuario, cuerpo }) => {
    soloAdminCentral(usuario);
    const sucursalDestino = Number(cuerpo.destino_sucursal_id);
    const usuarioDestino = numeroONulo(cuerpo.destino_usuario_id);
    if (!(sucursalDestino > 0)) throw new ErrorApp('Elige la sucursal a la que va la cotización');
    const { data: sucursal } = await consultar(sb().from('sucursales').select('id').eq('id', sucursalDestino).eq('activa', true).limit(1));
    if (!sucursal || !sucursal.length) throw new ErrorApp('Sucursal de destino no válida');
    if (usuarioDestino) {
      const { data: u } = await consultar(sb().from('usuarios_central').select('id,sucursal_id').eq('id', usuarioDestino).eq('activo', true).limit(1));
      if (!u || !u.length) throw new ErrorApp('El usuario de destino no existe o está dado de baja');
      if (Number(u[0].sucursal_id) !== sucursalDestino) throw new ErrorApp('Ese usuario es de otra sucursal');
    }
    const renglones = Array.isArray(cuerpo.renglones) ? cuerpo.renglones : [];
    if (!renglones.length) throw new ErrorApp('La cotización no tiene productos');
    if (renglones.length > 200) throw new ErrorApp('La cotización tiene demasiados productos (máximo 200)');
    const porProducto = new Map();
    for (const r of renglones) {
      const id = Number(r.producto_id);
      if (!(id > 0)) throw new ErrorApp('Producto no válido en la cotización');
      const cantidad = Number(r.cantidad);
      if (!Number.isFinite(cantidad) || !(cantidad > 0)) throw new ErrorApp('Hay una cantidad no válida en la cotización');
      let precio = null;
      if (r.precio_unitario !== undefined && r.precio_unitario !== null && r.precio_unitario !== '') {
        precio = Number(r.precio_unitario);
        if (!Number.isFinite(precio) || precio < 0) throw new ErrorApp('Hay un precio no válido en la cotización');
      }
      const previo = porProducto.get(id);
      porProducto.set(id, { cantidad: r2((previo?.cantidad || 0) + cantidad), precio: precio ?? previo?.precio ?? null });
    }
    const productos = new Map();
    for (const lote of lotes([...porProducto.keys()], 150)) {
      const { data } = await consultar(sb().from('productos').select(COLUMNAS_PRODUCTO).in('id', lote).eq('activo', true));
      for (const p of data || []) productos.set(Number(p.id), normalizarProducto(p));
    }
    const faltan = [...porProducto.keys()].filter((id) => !productos.has(id));
    if (faltan.length) throw new ErrorApp(`Hay productos que ya no están en el catálogo (${faltan.join(', ')})`, { status: 404 });
    const detalle = [...porProducto].map(([id, r]) => {
      const p = productos.get(id);
      const precio = r2(r.precio ?? p.precio_venta);
      return {
        producto_id: id, codigo_barras: p.codigo_barras, descripcion: p.descripcion, cantidad: r.cantidad,
        precio_unitario: precio, precio_lista: p.precio_venta, importe: r2(precio * r.cantidad),
      };
    });
    const ahora = new Date();
    const base = {
      creado_por: usuario.id, origen_sucursal_id: usuario.sucursal_id, destino_sucursal_id: sucursalDestino, destino_usuario_id: usuarioDestino,
      cliente: String(cuerpo.cliente || '').trim().slice(0, 120), nota: String(cuerpo.nota || '').trim().slice(0, 300),
      estado: 'enviada', total: r2(detalle.reduce((t, d) => t + d.importe, 0)),
      vigente_hasta: new Date(ahora.getTime() + DIAS_VIGENCIA_COTIZACION * 86400000).toISOString(), creado: ahora.toISOString(),
    };
    let fila = null;
    for (let intento = 0; intento < 6 && !fila; intento += 1) {
      const { data: ultimo } = await consultar(sb().from('cotizaciones').select('folio').order('folio', { ascending: false }).limit(1));
      const folio = (ultimo && ultimo[0] ? Number(ultimo[0].folio) : 0) + 1 + intento;
      try {
        const { data } = await consultar(sb().from('cotizaciones').insert({ ...base, folio }).select('*'));
        fila = data[0];
      } catch (error) {
        if (error.codigo !== '23505' || intento === 5) throw error;
      }
    }
    try {
      await consultar(sb().from('cotizacion_detalle').insert(detalle.map((d) => ({ ...d, cotizacion_id: Number(fila.id) }))));
    } catch (error) {
      await consultar(sb().from('cotizaciones').delete().eq('id', Number(fila.id))).catch(() => {});
      throw error;
    }
    const cotizacion = await cargarCotizacion(fila.id, usuario);
    await anotarCambio({
      usuario, sucursal_id: sucursalDestino, tipo: 'cotizacion_creada',
      descripcion: `Folio ${cotizacion.folio} para ${cotizacion.destino}${cotizacion.cliente ? ` (${cotizacion.cliente})` : ''}: ${cotizacion.productos} producto(s), $${cotizacion.total.toFixed(2)}`,
      detalle: { cotizacion_id: cotizacion.id, folio: cotizacion.folio, total: cotizacion.total },
    });
    return cotizacion;
  });

  ruta('POST', /^\/api\/cotizaciones\/(\d+)\/cancelar$/, async ({ usuario, params }) => {
    soloAdminCentral(usuario);
    const c = await cotizacionPorId(params[0]);
    if (!c) throw new ErrorApp('Cotización no encontrada', { status: 404 });
    if (c.estado === 'cancelada') return cargarCotizacion(c.id, usuario);
    if (c.estado !== 'enviada') throw new ErrorApp('Esa cotización ya se cobró; no se puede cancelar');
    const { data } = await consultar(
      sb().from('cotizaciones').update({ estado: 'cancelada', cancelada_por: usuario.id, cancelada_fecha: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', Number(c.id)).eq('estado', 'enviada').select('id')
    );
    if (!data || !data.length) throw new ErrorApp('La cotización cambió mientras tanto; actualiza la pantalla');
    const cancelada = await cargarCotizacion(c.id, usuario);
    await anotarCambio({
      usuario, sucursal_id: cancelada.destino_sucursal_id, tipo: 'cotizacion_cancelada',
      descripcion: `Folio ${cancelada.folio} para ${cancelada.destino}, $${cancelada.total.toFixed(2)}`,
      detalle: { cotizacion_id: cancelada.id, folio: cancelada.folio },
    });
    return cancelada;
  });

  // ---------- Apoyos: revisar en la sucursal lo que mandó la central (mismas reglas que la computadora) ----------
  async function apoyoCompleto(id) {
    const { data } = await consultar(sb().from('apoyos').select('*').eq('id', Number(id)).limit(1));
    const a = data && data[0];
    if (!a) return null;
    const { data: detalle } = await consultar(sb().from('apoyo_detalle').select('*').eq('apoyo_id', Number(a.id)).order('id').limit(2000));
    const usaInventario = new Map();
    for (const lote of lotes(idsValidos((detalle || []).map((d) => d.producto_id)), 150)) {
      const { data: productos } = await consultar(sb().from('productos').select('id,usa_inventario').in('id', lote));
      for (const p of productos || []) usaInventario.set(Number(p.id), p.usa_inventario === false || p.usa_inventario === 0 ? 0 : 1);
    }
    const n = await nombresDe({ sucursales: [a.origen_id, a.destino_id], usuarios: [a.enviado_por, a.recibido_por] });
    const renglones = (detalle || []).map((d) => ({
      id: Number(d.id), producto_id: Number(d.producto_id), codigo_barras: d.codigo_barras || null, descripcion: d.descripcion || '',
      cantidad: r2(d.cantidad), cantidad_recibida: numeroONulo(d.cantidad_recibida),
      precio_venta: r2(d.precio_venta), usa_inventario: usaInventario.has(Number(d.producto_id)) ? usaInventario.get(Number(d.producto_id)) : 1,
    }));
    return {
      id: Number(a.id), folio: Number(a.folio), estado: a.estado, nota: a.nota || '',
      origen_id: Number(a.origen_id), destino_id: Number(a.destino_id), origen: n.sucursal(a.origen_id), destino: n.sucursal(a.destino_id),
      enviado: a.enviado, remitente: a.enviado_por ? n.usuario(a.enviado_por) : '', recibido: a.recibido,
      receptor: a.recibido_por ? n.usuario(a.recibido_por) : '',
      renglones, piezas: r2(renglones.reduce((t, r) => t + r.cantidad, 0)),
      piezas_recibidas: r2(renglones.reduce((t, r) => t + (r.cantidad_recibida ?? 0), 0)),
    };
  }

  // Los que llegan a la sucursal del usuario (los borradores todavía no se ven)
  ruta('GET', /^\/api\/apoyos$/, async ({ usuario, url }) => {
    const estado = url.searchParams.get('estado') || '';
    let consulta = sb().from('apoyos').select('*').eq('destino_id', Number(usuario.sucursal_id)).neq('estado', 'borrador');
    if (['enviado', 'recibido', 'cancelado'].includes(estado)) consulta = consulta.eq('estado', estado);
    const { data } = await consultar(consulta.order('id', { ascending: false }).limit(50));
    const apoyos = data || [];
    const conteo = new Map();
    for (const lote of lotes(idsValidos(apoyos.map((a) => a.id)), 100)) {
      const { data: detalle } = await consultar(sb().from('apoyo_detalle').select('apoyo_id,cantidad').in('apoyo_id', lote).limit(10000));
      for (const d of detalle || []) {
        const actual = conteo.get(Number(d.apoyo_id)) || { renglones: 0, piezas: 0 };
        conteo.set(Number(d.apoyo_id), { renglones: actual.renglones + 1, piezas: r2(actual.piezas + Number(d.cantidad)) });
      }
    }
    const n = await nombresDe({ sucursales: apoyos.flatMap((a) => [a.origen_id, a.destino_id]) });
    return apoyos.map((a) => ({
      id: Number(a.id), folio: Number(a.folio), estado: a.estado, nota: a.nota || '', enviado: a.enviado, recibido: a.recibido,
      origen_id: Number(a.origen_id), destino_id: Number(a.destino_id), origen: n.sucursal(a.origen_id), destino: n.sucursal(a.destino_id),
      renglones: conteo.get(Number(a.id))?.renglones || 0, piezas: conteo.get(Number(a.id))?.piezas || 0,
    }));
  });

  ruta('GET', /^\/api\/apoyos\/(\d+)$/, async ({ usuario, params }) => {
    const apoyo = await apoyoCompleto(params[0]);
    if (!apoyo) throw new ErrorApp('Apoyo no encontrado', { status: 404 });
    const propia = Number(usuario.sucursal_id);
    if (apoyo.origen_id !== propia && !(apoyo.destino_id === propia && apoyo.estado !== 'borrador')) {
      throw new ErrorApp('Ese apoyo no es de tu farmacia', { status: 403 });
    }
    return apoyo;
  });

  ruta('POST', /^\/api\/apoyos\/(\d+)\/recibir$/, async ({ usuario, params, cuerpo }) => {
    const apoyo = await apoyoCompleto(params[0]);
    if (!apoyo) throw new ErrorApp('Apoyo no encontrado', { status: 404 });
    if (apoyo.destino_id !== Number(usuario.sucursal_id)) throw new ErrorApp('Solo la farmacia que recibe puede confirmar el apoyo', { status: 403 });
    if (apoyo.estado !== 'enviado') throw new ErrorApp('Este apoyo no está pendiente de recibir');
    // Lo que no venga en el cuerpo se da por recibido completo
    const capturado = new Map((Array.isArray(cuerpo.renglones) ? cuerpo.renglones : []).map((r) => [Number(r.id), Number(r.cantidad_recibida)]));
    const recibidas = [];
    for (const r of apoyo.renglones) {
      const cantidad = capturado.has(r.id) ? capturado.get(r.id) : r.cantidad;
      if (!Number.isFinite(cantidad) || cantidad < 0) throw new ErrorApp(`Cantidad recibida no válida en "${r.descripcion}"`);
      if (cantidad > r.cantidad + 1e-9) throw new ErrorApp(`No puedes recibir más de lo que se mandó de "${r.descripcion}" (se mandaron ${r.cantidad})`);
      recibidas.push({ renglon: r, cantidad: r2(cantidad) });
    }
    const notaRecepcion = String(cuerpo.nota_recepcion || '').trim().slice(0, 700);
    const nota = notaRecepcion ? [apoyo.nota, `Recepción: ${notaRecepcion}`].filter(Boolean).join(' · ') : apoyo.nota;
    const ahora = new Date().toISOString();
    const { data: tomado } = await consultar(
      sb().from('apoyos').update({ estado: 'recibido', recibido_por: usuario.id, recibido: ahora, nota, updated_at: ahora })
        .eq('id', apoyo.id).eq('estado', 'enviado').select('id')
    );
    if (!tomado || !tomado.length) throw new ErrorApp('Este apoyo ya fue recibido o cancelado; actualiza la pantalla');
    try {
      await aplicarMovimientos(
        recibidas.filter(({ renglon, cantidad }) => renglon.usa_inventario && cantidad > 0).map(({ renglon, cantidad }) => ({
          producto_id: renglon.producto_id, sucursal_id: apoyo.destino_id, tipo: 'entrada', cantidad,
          descripcion: renglon.descripcion, nota: `Apoyo folio ${apoyo.folio} recibido de ${apoyo.origen}`,
        })),
        usuario.id
      );
    } catch (error) {
      await consultar(
        sb().from('apoyos').update({ estado: 'enviado', recibido_por: null, recibido: null, nota: apoyo.nota, updated_at: new Date().toISOString() })
          .eq('id', apoyo.id).eq('estado', 'recibido')
      ).catch(() => {});
      throw error;
    }
    for (const { renglon, cantidad } of recibidas) {
      await consultar(sb().from('apoyo_detalle').update({ cantidad_recibida: cantidad }).eq('id', renglon.id));
    }
    const faltantes = recibidas.filter(({ renglon, cantidad }) => cantidad < renglon.cantidad - 1e-9);
    await anotarCambio({
      usuario, sucursal_id: apoyo.destino_id, tipo: 'apoyo_recibido',
      descripcion: `Folio ${apoyo.folio} de ${apoyo.origen}: ${faltantes.length ? `llegó con diferencias en ${faltantes.length} producto(s)` : 'llegó completo'}`
        + `${notaRecepcion ? ` — ${notaRecepcion}` : ''}`,
      detalle: {
        apoyo_id: apoyo.id, folio: apoyo.folio,
        faltantes: faltantes.map(({ renglon, cantidad }) => ({ producto: renglon.descripcion, enviado: renglon.cantidad, recibido: cantidad })),
      },
      alerta: faltantes.length > 0,
    });
    return apoyoCompleto(apoyo.id);
  });

  // ---------- Jefe: movimientos, cambios e inventario de las sucursales ----------
  const parametros = (url) => Object.fromEntries(url.searchParams.entries());
  ruta('GET', /^\/api\/movimientos$/, async ({ usuario, url }) => supervision.movimientos(usuario, parametros(url)));
  ruta('GET', /^\/api\/movimientos\/filtros$/, async ({ usuario }) => supervision.filtros(usuario));
  ruta('GET', /^\/api\/bitacora$/, async ({ usuario, url }) => supervision.listarCambios(usuario, parametros(url)));
  ruta('GET', /^\/api\/supervision\/inicio$/, async ({ usuario, url }) => supervision.inicio(usuario, { fresco: url.searchParams.has('fresco') }));
  ruta('GET', /^\/api\/supervision\/inventario$/, async ({ usuario, url }) => supervision.inventario(usuario, { fresco: url.searchParams.has('fresco') }));
  ruta('GET', /^\/api\/supervision\/inventario\/lista$/, async ({ usuario, url }) => supervision.listaInventario(usuario, {
    ...parametros(url), fresco: url.searchParams.has('fresco'),
  }));

  // ---------- Ventas de todas las farmacias (lo que suben las cajas) ----------
  ruta('GET', /^\/api\/ventas-central\/reporte$/, async ({ usuario, url }) => ventasCentral.reporte(usuario, parametros(url)));
  ruta('GET', /^\/api\/ventas-central\/cortes$/, async ({ usuario, url }) => ventasCentral.listarCortes(usuario, parametros(url)));
  ruta('GET', /^\/api\/ventas-central\/cortes\/(\d+)$/, async ({ usuario, params }) => ventasCentral.cargarCorte(usuario, params[0]));
  ruta('GET', /^\/api\/ventas-central\/creditos$/, async ({ usuario, url }) => ventasCentral.creditos(usuario, parametros(url)));

  // ---------- Inventario del día ----------
  ruta('GET', /^\/api\/conteos\/hoy$/, async ({ usuario, url }) => supervision.conteoDeHoy(usuario, parametros(url)));
  ruta('GET', /^\/api\/conteos\/config$/, async ({ usuario }) => supervision.configuracion(usuario));
  ruta('PUT', /^\/api\/conteos\/config$/, async ({ usuario, cuerpo }) => supervision.guardarConfiguracion(usuario, cuerpo));
  ruta('GET', /^\/api\/conteos\/importante\/(\d+)$/, async ({ usuario, params }) => {
    if (!esJefe(usuario)) throw new ErrorApp('Esto solo lo ve el jefe', { status: 403, codigo: 'SOLO_JEFE' });
    return { producto_id: Number(params[0]), importante: await supervision.esImportante(params[0]) };
  });
  ruta('POST', /^\/api\/conteos\/importante$/, async ({ usuario, cuerpo }) => supervision.marcarImportante(usuario, cuerpo));
  ruta('GET', /^\/api\/conteos$/, async ({ usuario, url }) => supervision.listarConteos(usuario, parametros(url)));
  ruta('GET', /^\/api\/conteos\/(\d+)$/, async ({ usuario, params }) => supervision.cargarConteo(usuario, params[0]));
  ruta('POST', /^\/api\/conteos\/(\d+)\/contar$/, async ({ usuario, params, cuerpo }) => supervision.contar(usuario, params[0], cuerpo));
  ruta('POST', /^\/api\/conteos\/(\d+)\/motivo$/, async ({ usuario, params, cuerpo }) => supervision.anotarMotivo(usuario, params[0], cuerpo));
  ruta('POST', /^\/api\/conteos\/(\d+)\/terminar$/, async ({ usuario, params, cuerpo }) => supervision.terminar(usuario, params[0], cuerpo));
  ruta('POST', /^\/api\/conteos\/(\d+)\/autorizar$/, async ({ usuario, params, cuerpo }) => supervision.autorizar(usuario, params[0], cuerpo));

  // ---------- Atender la solicitud ----------
  function cabecerasCors(req) {
    const origen = req.headers.get('origin') || '';
    const permitido = origenesPermitidos.includes('*') ? '*' : (origenesPermitidos.includes(origen) ? origen : origenesPermitidos[0] || '');
    return {
      'Access-Control-Allow-Origin': permitido,
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  function responder(req, status, cuerpo) {
    return new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cabecerasCors(req) },
    });
  }

  return async function manejar(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecerasCors(req) });
    const url = new URL(req.url);
    // La dirección pública es .../functions/v1/movil/api/...: se quita todo hasta "/movil"
    const camino = url.pathname.replace(/^.*?\/movil(?=\/|$)/, '') || '/';
    try {
      const destino = rutas.find((r) => r.metodo === req.method && r.patron.test(camino));
      if (!destino) return responder(req, 404, { error: 'Ruta no encontrada' });
      let cuerpo = {};
      if (req.method !== 'GET') {
        const texto = await req.text();
        if (texto) {
          try {
            cuerpo = JSON.parse(texto);
          } catch {
            return responder(req, 400, { error: 'La solicitud no es válida' });
          }
        }
      }
      let contexto = { req, url, cuerpo, params: camino.match(destino.patron).slice(1) };
      if (!destino.publica) {
        const sesion = await sesionDe(req);
        if (!sesion) return responder(req, 401, { error: 'Este celular no está vinculado o la sesión se cerró', codigo: 'SIN_SESION' });
        contexto = { ...contexto, ...sesion };
      }
      const resultado = await destino.fn(contexto);
      return responder(req, 200, resultado);
    } catch (error) {
      if (error instanceof ErrorApp) {
        return responder(req, error.status, { error: error.message, codigo: error.codigo || undefined, ...(error.datos || {}) });
      }
      registrar('Error en la función movil:', error);
      return responder(req, 500, { error: 'Error interno del servidor' });
    }
  };
}
