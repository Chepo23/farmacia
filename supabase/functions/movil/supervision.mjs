// Lo que ve y autoriza el jefe, con las mismas reglas en el celular (función "movil") y en cada
// computadora (src/supervision.js):
// - Movimientos de inventario como en Eleventa: cuánto había, cuánto hay, quién lo hizo y por qué.
// - Registro de cambios: precios, altas, usuarios, cancelaciones, cortes, salidas de efectivo...
// - Inventario de todas las sucursales: valor, bajo mínimo, agotados, negativos y sin movimiento.
// - Inventario del día: cada día se arma una lista corta por sucursal, se cuenta con el celular sin
//   ver lo que dice el sistema, lo que no cuadra se recuenta una vez y lleva motivo, y un jefe
//   (nunca quien contó) autoriza el ajuste. Se respetan las ventas hechas mientras se cuenta.
//
// Como el resto de la función, no depende de Deno ni de Node: recibe el cliente de Supabase ya creado.

export const ZONA_HORARIA = 'America/Mexico_City';
// El turno de la tarde del inventario empieza a esta hora si el jefe no pone otra
export const HORA_TARDE = '14:00';
export const DIAS_SIN_MOVIMIENTO = 60;

const EPS = 0.005;
const DIA_MS = 86400000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

function lotes(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function idsValidos(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

export const esJefe = (u) => Boolean(u) && (u.jefe === true || Number(u.jefe) === 1) && u.rol === 'admin' && Number(u.es_central) === 1;
const esAdminCentral = (u) => Boolean(u) && u.rol === 'admin' && Number(u.es_central) === 1;

// ---------- Clases de movimiento (para mostrarlos y filtrarlos como en Eleventa) ----------
// Las ventas tienen su tipo; lo demás se reconoce por la nota que escribe cada operación.
const CLASES = [
  { clase: 'cancelacion', prefijos: ['Cancelación de la venta'] },
  { clase: 'apoyo', prefijos: ['Apoyo folio', 'Cancelación del apoyo'] },
  { clase: 'conteo', prefijos: ['Conteo físico', 'Inventario del día', 'Inventario de la mañana', 'Inventario de la tarde', 'Inventario completo'] },
  { clase: 'recepcion', prefijos: ['Recepción de mercancía'] },
  { clase: 'alta', prefijos: ['Existencia inicial'] },
  { clase: 'prestamo', prefijos: ['Préstamo P-', 'Devolución del préstamo P-'] },
];
export const TIPOS_MOVIMIENTO = ['venta', 'entrada', 'salida', 'ajuste', 'apoyo', 'conteo', 'cancelacion', 'recepcion', 'alta', 'prestamo'];

export function claseDeMovimiento(tipo, nota) {
  if (tipo === 'venta') return 'venta';
  const texto = String(nota || '');
  for (const c of CLASES) if (c.prefijos.some((p) => texto.startsWith(p))) return c.clase;
  return tipo; // entrada, salida o ajuste hechos a mano
}

export function deltaDe(tipo, cantidad) {
  if (tipo === 'entrada') return r2(cantidad);
  if (tipo === 'salida' || tipo === 'venta') return -r2(cantidad);
  return null; // ajuste: fija la existencia
}

// ---------- Registro de cambios ----------
export const TIPOS_CAMBIO = {
  producto_alta: 'Alta de producto',
  producto_cambio: 'Cambio de producto',
  producto_baja: 'Baja de producto',
  usuario_alta: 'Alta de usuario',
  usuario_cambio: 'Cambio de usuario',
  usuario_baja: 'Baja de usuario',
  sucursal_alta: 'Alta de sucursal',
  sucursal_cambio: 'Cambio de sucursal',
  sucursal_baja: 'Baja de sucursal',
  venta_cancelada: 'Venta cancelada',
  corte: 'Corte de caja',
  efectivo_salida: 'Salida de efectivo',
  efectivo_entrada: 'Entrada de efectivo',
  apoyo_enviado: 'Apoyo enviado',
  apoyo_recibido: 'Apoyo recibido',
  apoyo_cancelado: 'Apoyo cancelado',
  cotizacion_creada: 'Cotización enviada',
  cotizacion_cancelada: 'Cotización cancelada',
  conteo_terminado: 'Inventario terminado',
  conteo_autorizado: 'Ajustes del inventario',
  conteo_config: 'Turnos del inventario',
  conteo_lista: 'Lista del inventario',
  conteo_completo: 'Inventario completo',
  conteo_importante: 'Producto importante para contar',
  existencia_carga: 'Carga de existencias',
  inventario_revisado: 'Revisión semanal del inventario',
  precio_en_venta: 'Precio cambiado en una venta',
  prestamo: 'Préstamo a otra farmacia',
  prestamo_devuelto: 'Devolución de un préstamo',
};
export const GRUPOS_CAMBIO = {
  productos: ['producto_alta', 'producto_cambio', 'producto_baja'],
  usuarios: ['usuario_alta', 'usuario_cambio', 'usuario_baja', 'sucursal_alta', 'sucursal_cambio', 'sucursal_baja'],
  caja: ['venta_cancelada', 'corte', 'efectivo_salida', 'efectivo_entrada', 'precio_en_venta'],
  apoyos: ['apoyo_enviado', 'apoyo_recibido', 'apoyo_cancelado', 'prestamo', 'prestamo_devuelto'],
  cotizaciones: ['cotizacion_creada', 'cotizacion_cancelada'],
  conteos: ['conteo_terminado', 'conteo_autorizado', 'conteo_config', 'conteo_lista', 'conteo_completo', 'conteo_importante', 'existencia_carga', 'inventario_revisado'],
};

// "precio $28.00 → $30.00, costo $14.50 → $15.00": para el registro de cambios
export function describirCambiosProducto(antes, despues) {
  const lista = [];
  const dinero = (n) => (n == null ? 'sin mayoreo' : `$${Number(n).toFixed(2)}`);
  const campos = [
    ['precio_venta', 'precio', dinero, true],
    ['precio_costo', 'costo', dinero, true],
    ['precio_mayoreo', 'mayoreo', dinero, true],
    ['cantidad_mayoreo', 'mayoreo desde', (n) => (n == null ? 'sin cantidad' : `${n} pzas`), true],
    ['precio_caja', 'precio de caja', (n) => (n == null ? 'no se vende por caja' : `$${Number(n).toFixed(2)}`), true],
    ['piezas_caja', 'piezas por caja', (n) => (n == null ? 'sin caja' : `${n}`), true],
    ['es_coctel', 'cóctel', (n) => (Number(n) ? 'sí' : 'no'), 'si-no'],
    ['descripcion', 'descripción', (s) => `"${s}"`, false],
    ['codigo_barras', 'código', (s) => s || 'sin código', false],
    ['departamento', 'departamento', (s) => s || 'sin departamento', false],
  ];
  for (const [campo, nombre, formato, numerico] of campos) {
    // Solo lo que se está guardando (el celular no manda la caja ni el cóctel)
    if (!(campo in despues)) continue;
    const a = antes[campo] ?? null;
    const d = despues[campo] ?? null;
    const iguales = numerico === 'si-no'
      ? Boolean(Number(a)) === Boolean(Number(d))
      : numerico
        ? (a == null) === (d == null) && Math.abs((Number(a) || 0) - (Number(d) || 0)) < 0.005
        : String(a ?? '') === String(d ?? '');
    if (!iguales) lista.push({ campo, antes: a, despues: d, texto: `${nombre} ${formato(a)} → ${formato(d)}` });
  }
  return {
    lista,
    texto: lista.map((c) => c.texto).join(', '),
    precio: lista.some((c) => c.campo === 'precio_venta' || c.campo === 'precio_caja'),
  };
}

// ---------- Inventario del día ----------
export const TURNOS = {
  dia: 'Inventario del día',
  manana: 'Inventario de la mañana',
  tarde: 'Inventario de la tarde',
  completo: 'Inventario completo',
};
export const RAZONES_CONTEO = {
  lista: 'De la lista del inventario',
  completo: 'Inventario completo',
  // De la lista automática anterior (inventarios viejos)
  negativo: 'Tenía existencia negativa',
  diferencia: 'No cuadró en su último conteo',
  importante: 'Marcado como importante',
  movimiento: 'Se movió desde su último conteo',
  nunca: 'Nunca se había contado',
  turno: 'Le tocaba por turno',
};

export function crearSupervision({
  sb,
  consultar,
  ErrorApp,
  aplicarMovimientos,
  existenciaActual = null,
  registrarCambio = null,
  // Lo vendido hoy en cada sucursal (ventas.mjs); sin él, el inicio no muestra ventas
  ventasHoy = null,
  zona = ZONA_HORARIA,
  registrar = console.error,
}) {
  // ---------- Fechas en la hora de las farmacias ----------
  const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' });
  const formatoPartes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // 'AAAA-MM-DD' de ese instante en la zona horaria de las farmacias
  function diaDe(instante = new Date()) {
    return formatoDia.format(instante);
  }

  function desfaseMinutos(instante) {
    const p = Object.fromEntries(formatoPartes.formatToParts(instante).map((x) => [x.type, x.value]));
    const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return Math.round((comoUtc - instante.getTime()) / 60000);
  }

  // Instante (ISO, en UTC) en que empieza el día 'AAAA-MM-DD' en las farmacias
  function inicioDelDia(dia) {
    const [a, m, d] = dia.split('-').map(Number);
    const desfase = desfaseMinutos(new Date(Date.UTC(a, m - 1, d, 12)));
    return new Date(Date.UTC(a, m - 1, d) - desfase * 60000).toISOString();
  }

  function sumarDias(dia, n) {
    const [a, m, d] = dia.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function diaValido(texto) {
    const valor = String(texto || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
    return sumarDias(valor, 0) === valor ? valor : null;
  }

  // Rango de días pedido (por defecto los últimos `dias`), a lo mucho 3 meses
  function rangoDias(desdeTexto, hastaTexto, { dias = 1 } = {}) {
    const hoy = diaDe();
    let hasta = diaValido(hastaTexto) || hoy;
    let desde = diaValido(desdeTexto) || sumarDias(hasta, 1 - dias);
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    if (sumarDias(desde, 92) < hasta) desde = sumarDias(hasta, -92);
    return { desde, hasta, inicio: inicioDelDia(desde), fin: inicioDelDia(sumarDias(hasta, 1)) };
  }

  // ---------- Utilidades de consulta ----------
  // Sin las tablas nuevas (la base central no se ha actualizado) se avisa claro en lugar de fallar raro
  function traducir(error) {
    const texto = `${error?.codigo || ''} ${error?.message || ''}`;
    if (/PGRST205|42P01|Could not find the table|does not exist/i.test(texto) && /bitacora|conteo|jefe/i.test(texto)) {
      return new ErrorApp('Falta actualizar la base central para usar esta parte del sistema. Avisa a quien lo instaló.', {
        status: 503, codigo: 'FALTA_ACTUALIZAR_CENTRAL',
      });
    }
    return error;
  }

  const protegido = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw traducir(error);
    }
  };

  // Todas las filas de una consulta, de mil en mil (la central responde a lo mucho mil por vez)
  async function todas(construir, { pagina = 1000, maximo = 60000 } = {}) {
    const filas = [];
    for (let desde = 0; desde < maximo; desde += pagina) {
      const { data } = await consultar(construir().range(desde, desde + pagina - 1));
      filas.push(...(data || []));
      if (!data || data.length < pagina) break;
    }
    return filas;
  }

  async function sucursalesActivas() {
    const { data } = await consultar(sb().from('sucursales').select('id,nombre,es_central,activa').eq('activa', true).order('id'));
    return (data || [])
      .map((s) => ({ id: Number(s.id), nombre: s.nombre, es_central: s.es_central ? 1 : 0 }))
      .sort((a, b) => b.es_central - a.es_central || a.id - b.id);
  }

  async function nombres({ sucursales = [], usuarios = [], productos = [] }) {
    const mapaS = new Map();
    const mapaU = new Map();
    const mapaP = new Map();
    const s = idsValidos(sucursales);
    if (s.length) {
      const { data } = await consultar(sb().from('sucursales').select('id,nombre').in('id', s));
      for (const f of data || []) mapaS.set(Number(f.id), f.nombre);
    }
    for (const lote of lotes(idsValidos(usuarios), 150)) {
      const { data } = await consultar(sb().from('usuarios_central').select('id,nombre').in('id', lote));
      for (const f of data || []) mapaU.set(Number(f.id), f.nombre);
    }
    for (const lote of lotes(idsValidos(productos), 150)) {
      const { data } = await consultar(sb().from('productos').select('id,descripcion,codigo_barras,departamento').in('id', lote));
      for (const f of data || []) mapaP.set(Number(f.id), f);
    }
    return {
      sucursal: (id) => mapaS.get(Number(id)) || (id ? `Sucursal ${id}` : ''),
      usuario: (id) => mapaU.get(Number(id)) || (id ? `Usuario ${id}` : ''),
      producto: (id) => mapaP.get(Number(id)) || null,
    };
  }

  function soloJefe(usuario, mensaje = 'Esto solo lo ve el jefe') {
    if (!esJefe(usuario)) throw new ErrorApp(mensaje, { status: 403, codigo: 'SOLO_JEFE' });
  }

  // ---------- Registro de cambios ----------
  function filaCambio({ usuario = null, sucursal_id = null, tipo, descripcion = '', detalle = null, alerta = false, origen = 'celular', fecha = null, clave = null }) {
    return {
      clave: clave || crypto.randomUUID(),
      fecha: fecha || new Date().toISOString(),
      sucursal_id: Number(sucursal_id) || Number(usuario?.sucursal_id) || null,
      usuario_id: usuario ? Number(usuario.id) || null : null,
      tipo: String(tipo),
      descripcion: String(descripcion || '').slice(0, 500),
      detalle: detalle || null,
      alerta: Boolean(alerta),
      origen,
    };
  }

  // Sube cambios a la central (un reintento con la misma clave no los duplica)
  async function insertarCambios(filas) {
    if (!filas.length) return;
    await consultar(sb().from('bitacora').upsert(filas, { onConflict: 'clave', ignoreDuplicates: true }));
  }

  // Desde la función se escribe directo en la central; la computadora pasa su propio registrarCambio
  async function anotarCambio(cambio) {
    try {
      if (registrarCambio) await registrarCambio(cambio);
      else await insertarCambios([filaCambio(cambio)]);
    } catch (error) {
      registrar('No se pudo guardar el cambio en el registro:', error.message);
    }
  }

  function cambioParaMostrar(f, n) {
    return {
      id: Number(f.id),
      clave: f.clave,
      fecha: f.fecha,
      sucursal_id: f.sucursal_id == null ? null : Number(f.sucursal_id),
      sucursal: f.sucursal_id == null ? '' : n.sucursal(f.sucursal_id),
      usuario_id: f.usuario_id == null ? null : Number(f.usuario_id),
      usuario: f.usuario_id == null ? '' : n.usuario(f.usuario_id),
      tipo: f.tipo,
      titulo: TIPOS_CAMBIO[f.tipo] || f.tipo,
      descripcion: f.descripcion || '',
      detalle: f.detalle || null,
      alerta: Boolean(f.alerta),
      origen: f.origen || '',
    };
  }

  async function listarCambios(usuario, filtros = {}) {
    soloJefe(usuario);
    const { desde, hasta, inicio, fin } = rangoDias(filtros.desde, filtros.hasta, { dias: 7 });
    const limite = Math.min(Math.max(Number(filtros.limite) || 100, 1), 200);
    const salto = Math.max(0, Number(filtros.desde_fila) || 0);
    let consulta = sb().from('bitacora').select('*').gte('fecha', inicio).lt('fecha', fin);
    if (Number(filtros.sucursal_id)) consulta = consulta.eq('sucursal_id', Number(filtros.sucursal_id));
    if (Number(filtros.usuario_id)) consulta = consulta.eq('usuario_id', Number(filtros.usuario_id));
    if (filtros.grupo === 'alertas') consulta = consulta.eq('alerta', true);
    else if (GRUPOS_CAMBIO[filtros.grupo]) consulta = consulta.in('tipo', GRUPOS_CAMBIO[filtros.grupo]);
    const { data } = await consultar(consulta.order('fecha', { ascending: false }).order('id', { ascending: false }).range(salto, salto + limite));
    const filas = (data || []).slice(0, limite);
    const n = await nombres({ sucursales: filas.map((f) => f.sucursal_id), usuarios: filas.map((f) => f.usuario_id) });
    return {
      fuente: 'central',
      desde,
      hasta,
      cambios: filas.map((f) => cambioParaMostrar(f, n)),
      hay_mas: (data || []).length > limite,
      siguiente: salto + filas.length,
    };
  }

  // ---------- Movimientos de inventario ----------
  // El jefe ve todas las sucursales; un administrador, la suya; los cajeros no.
  function sucursalDeMovimientos(usuario, pedida) {
    if (esJefe(usuario)) return Number(pedida) || null;
    if (usuario.rol === 'admin') return Number(usuario.sucursal_id);
    throw new ErrorApp('Los movimientos los ven el jefe y los administradores', { status: 403, codigo: 'SOLO_ADMIN' });
  }

  async function productosQueCoinciden(texto) {
    const limpio = texto.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const { data } = await consultar(
      sb().from('productos').select('id').or(`codigo_barras.eq."${limpio}",descripcion.ilike."*${limpio}*"`).order('descripcion').limit(200)
    );
    return idsValidos((data || []).map((p) => p.id));
  }

  function filtrarTipo(consulta, tipo) {
    if (['venta', 'entrada', 'salida', 'ajuste'].includes(tipo)) return consulta.eq('tipo', tipo);
    const clase = CLASES.find((c) => c.clase === tipo);
    if (!clase) return consulta;
    if (clase.prefijos.length === 1) return consulta.ilike('nota', `${clase.prefijos[0]}*`);
    return consulta.or(clase.prefijos.map((p) => `nota.ilike."${p}*"`).join(','));
  }

  async function movimientos(usuario, filtros = {}) {
    const sucursal = sucursalDeMovimientos(usuario, filtros.sucursal_id);
    const { desde, hasta, inicio, fin } = rangoDias(filtros.desde, filtros.hasta);
    const limite = Math.min(Math.max(Number(filtros.limite) || 100, 1), 200);
    const salto = Math.max(0, Number(filtros.desde_fila) || 0);
    const tipo = TIPOS_MOVIMIENTO.includes(filtros.tipo) ? filtros.tipo : '';
    const usuarioId = Number(filtros.usuario_id) || null;
    const texto = String(filtros.q || '').trim().slice(0, 80);
    const productoIds = texto ? await productosQueCoinciden(texto) : null;
    const vacio = { fuente: 'central', desde, hasta, sucursal_id: sucursal, movimientos: [], hay_mas: false, siguiente: salto, resumen: salto ? null : { total: 0, por_clase: {}, parcial: false } };
    if (productoIds && productoIds.length === 0) return vacio;

    const filtrar = (consulta) => {
      let c = consulta.gte('fecha', inicio).lt('fecha', fin);
      if (sucursal) c = c.eq('sucursal_id', sucursal);
      if (usuarioId) c = c.eq('usuario_id', usuarioId);
      if (productoIds) c = c.in('producto_id', productoIds);
      return filtrarTipo(c, tipo);
    };
    const columnas = 'id,producto_id,sucursal_id,tipo,cantidad,usuario_id,nota,fecha,existencia_resultante';
    const { data } = await consultar(
      filtrar(sb().from('movimientos_inventario').select(columnas)).order('id', { ascending: false }).range(salto, salto + limite)
    );
    const filas = (data || []).slice(0, limite);

    // Cuánto había antes de un ajuste: lo que quedó en el movimiento anterior del mismo producto
    const anteriores = new Map();
    for (const f of filas.filter((x) => x.tipo === 'ajuste').slice(0, 25)) {
      const { data: previo } = await consultar(
        sb().from('movimientos_inventario').select('existencia_resultante')
          .eq('producto_id', f.producto_id).eq('sucursal_id', f.sucursal_id).lt('id', f.id)
          .order('id', { ascending: false }).limit(1)
      );
      if (previo && previo[0] && previo[0].existencia_resultante != null) anteriores.set(Number(f.id), r2(previo[0].existencia_resultante));
    }

    const n = await nombres({
      sucursales: filas.map((f) => f.sucursal_id),
      usuarios: filas.map((f) => f.usuario_id),
      productos: filas.map((f) => f.producto_id),
    });

    // Resumen de lo filtrado (solo con la primera página): cuántos movimientos y piezas de cada clase
    let resumen = null;
    if (!salto) {
      const LIMITE_RESUMEN = 3000;
      const todasLasFilas = await todas(
        () => filtrar(sb().from('movimientos_inventario').select('id,tipo,cantidad,nota')).order('id', { ascending: false }),
        { maximo: LIMITE_RESUMEN }
      );
      const porClase = {};
      for (const f of todasLasFilas) {
        const clase = claseDeMovimiento(f.tipo, f.nota);
        const actual = porClase[clase] || { movimientos: 0, piezas: 0 };
        actual.movimientos += 1;
        actual.piezas = r2(actual.piezas + Number(f.cantidad || 0));
        porClase[clase] = actual;
      }
      resumen = { total: todasLasFilas.length, por_clase: porClase, parcial: todasLasFilas.length >= LIMITE_RESUMEN };
    }

    return {
      fuente: 'central',
      desde,
      hasta,
      sucursal_id: sucursal,
      movimientos: filas.map((f) => {
        const delta = deltaDe(f.tipo, f.cantidad);
        const hay = f.existencia_resultante == null ? null : r2(f.existencia_resultante);
        const habia = hay == null ? null : delta == null ? (anteriores.get(Number(f.id)) ?? null) : r2(hay - delta);
        const producto = n.producto(f.producto_id);
        return {
          id: Number(f.id),
          fecha: f.fecha,
          sucursal_id: Number(f.sucursal_id),
          sucursal: n.sucursal(f.sucursal_id),
          producto_id: Number(f.producto_id),
          producto: producto ? producto.descripcion : `Producto ${f.producto_id}`,
          codigo_barras: producto ? producto.codigo_barras || null : null,
          tipo: f.tipo,
          clase: claseDeMovimiento(f.tipo, f.nota),
          cantidad: r2(f.cantidad),
          delta,
          habia,
          hay,
          usuario_id: f.usuario_id == null ? null : Number(f.usuario_id),
          usuario: n.usuario(f.usuario_id),
          nota: f.nota || '',
        };
      }),
      hay_mas: (data || []).length > limite,
      siguiente: salto + filas.length,
      resumen,
    };
  }

  // Sucursales y personas para los filtros de Movimientos y Cambios
  async function filtros(usuario) {
    const jefe = esJefe(usuario);
    if (!jefe && usuario.rol !== 'admin') throw new ErrorApp('Los movimientos los ven el jefe y los administradores', { status: 403, codigo: 'SOLO_ADMIN' });
    const sucursales = (await sucursalesActivas()).filter((s) => jefe || s.id === Number(usuario.sucursal_id));
    let consulta = sb().from('usuarios_central').select('id,nombre,sucursal_id,activo').order('nombre');
    if (!jefe) consulta = consulta.eq('sucursal_id', Number(usuario.sucursal_id));
    const { data } = await consultar(consulta.limit(500));
    return {
      jefe,
      sucursales,
      usuarios: (data || []).map((u) => ({ id: Number(u.id), nombre: u.nombre, sucursal_id: Number(u.sucursal_id), activo: u.activo !== false })),
      tipos: TIPOS_MOVIMIENTO,
      grupos_cambio: Object.keys(GRUPOS_CAMBIO),
    };
  }

  // ---------- Inventario de todas las sucursales ----------
  let cacheInventario = null; // { hasta, datos }

  async function datosInventario({ fresco = false } = {}) {
    if (!fresco && cacheInventario && cacheInventario.hasta > Date.now()) return cacheInventario.datos;
    const [sucursales, productos, filas] = await Promise.all([
      sucursalesActivas(),
      todas(() => sb().from('productos').select('id,codigo_barras,descripcion,departamento,precio_costo,precio_venta').eq('activo', true).eq('usa_inventario', true).order('id')),
      todas(() => sb().from('inventario').select('producto_id,sucursal_id,existencia,minimo,updated_at').order('id')),
    ]);
    const porId = new Map(productos.filter((p) => Number(p.id) > 0).map((p) => [Number(p.id), p]));
    const activas = new Set(sucursales.map((s) => s.id));
    const renglones = [];
    for (const f of filas) {
      const p = porId.get(Number(f.producto_id));
      if (!p || !activas.has(Number(f.sucursal_id))) continue;
      const existencia = r2(f.existencia);
      renglones.push({
        producto_id: Number(p.id),
        sucursal_id: Number(f.sucursal_id),
        descripcion: p.descripcion,
        codigo_barras: p.codigo_barras || null,
        departamento: p.departamento || '',
        existencia,
        minimo: r2(f.minimo),
        costo: r2(p.precio_costo),
        precio: r2(p.precio_venta),
        valor_costo: existencia > 0 ? r2(existencia * (Number(p.precio_costo) || 0)) : 0,
        actualizado: f.updated_at || null,
      });
    }
    const datos = { sucursales, renglones, leido: new Date().toISOString() };
    cacheInventario = { hasta: Date.now() + 20000, datos };
    return datos;
  }

  const limiteSinMovimiento = () => Date.now() - DIAS_SIN_MOVIMIENTO * DIA_MS;
  const LISTAS_INVENTARIO = {
    bajo_minimo: (r) => r.minimo > 0 && r.existencia > EPS && r.existencia <= r.minimo + EPS,
    agotados: (r) => Math.abs(r.existencia) < EPS,
    negativos: (r) => r.existencia < -EPS,
    sin_movimiento: (r) => r.existencia > EPS && r.actualizado && new Date(r.actualizado).getTime() < limiteSinMovimiento(),
    valor: (r) => r.valor_costo > 0,
  };

  function resumirInventario(datos) {
    return datos.sucursales.map((s) => {
      const propios = datos.renglones.filter((r) => r.sucursal_id === s.id);
      const cuenta = (lista) => propios.filter(LISTAS_INVENTARIO[lista]).length;
      return {
        sucursal_id: s.id,
        sucursal: s.nombre,
        es_central: s.es_central,
        productos: propios.filter((r) => r.existencia > EPS).length,
        piezas: r2(propios.reduce((t, r) => t + Math.max(0, r.existencia), 0)),
        valor_costo: r2(propios.reduce((t, r) => t + r.valor_costo, 0)),
        valor_venta: r2(propios.reduce((t, r) => t + (r.existencia > 0 ? r.existencia * r.precio : 0), 0)),
        bajo_minimo: cuenta('bajo_minimo'),
        agotados: cuenta('agotados'),
        negativos: cuenta('negativos'),
        sin_movimiento: cuenta('sin_movimiento'),
        valor_sin_movimiento: r2(propios.filter(LISTAS_INVENTARIO.sin_movimiento).reduce((t, r) => t + r.valor_costo, 0)),
      };
    });
  }

  async function inventario(usuario, { fresco = false } = {}) {
    soloJefe(usuario);
    const datos = await datosInventario({ fresco });
    return { leido: datos.leido, dias_sin_movimiento: DIAS_SIN_MOVIMIENTO, sucursales: resumirInventario(datos) };
  }

  async function listaInventario(usuario, { sucursal_id, lista, fresco = false } = {}) {
    soloJefe(usuario);
    const filtro = LISTAS_INVENTARIO[lista];
    if (!filtro) throw new ErrorApp('Lista no válida');
    const sucursal = Number(sucursal_id);
    const datos = await datosInventario({ fresco });
    const orden = {
      bajo_minimo: (a, b) => a.existencia / (a.minimo || 1) - b.existencia / (b.minimo || 1),
      agotados: (a, b) => b.minimo - a.minimo || a.descripcion.localeCompare(b.descripcion),
      negativos: (a, b) => a.existencia - b.existencia,
      sin_movimiento: (a, b) => b.valor_costo - a.valor_costo,
      valor: (a, b) => b.valor_costo - a.valor_costo,
    }[lista];
    const filas = datos.renglones.filter((r) => (!sucursal || r.sucursal_id === sucursal) && filtro(r)).sort(orden);
    const nombresS = new Map(datos.sucursales.map((s) => [s.id, s.nombre]));
    return {
      lista,
      sucursal_id: sucursal || null,
      total: filas.length,
      productos: filas.slice(0, 300).map((r) => ({ ...r, sucursal: nombresS.get(r.sucursal_id) || '' })),
    };
  }

  // ---------- Inventario: la lista del jefe, dos turnos al día y el inventario completo ----------
  // Cada farmacia tiene su lista de productos (la arma el jefe). Cada día se cuenta dos veces: en el
  // turno de la mañana y en el de la tarde (empieza a la hora que diga el jefe, 14:00 si no se cambia).
  // Aparte, el jefe puede empezar un inventario completo (todo o un departamento) que queda abierto
  // hasta que se termina.
  const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const horaDe = (instante = new Date()) => formatoHora.format(instante).replace(/^24/, '00');
  const horaValida = (texto) => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(texto || '').trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  };
  const turnoDe = (c) => c.turno || 'dia';
  const tituloConteo = (c) => `${TURNOS[turnoDe(c)] || TURNOS.dia}${c.departamento ? ` · ${c.departamento}` : ''}`;
  const porDepartamento = (a, b) => (a.departamento || '￿').localeCompare(b.departamento || '￿', 'es')
    || String(a.descripcion || '').localeCompare(String(b.descripcion || ''), 'es');

  async function configDe(sucursalId) {
    const { data } = await consultar(sb().from('conteo_config').select('hora_tarde').eq('sucursal_id', Number(sucursalId)).limit(1));
    return { hora_tarde: (data && data[0] && horaValida(data[0].hora_tarde)) || HORA_TARDE };
  }

  async function sucursalValida(id) {
    const s = (await sucursalesActivas()).find((x) => x.id === Number(id));
    if (!s) throw new ErrorApp('Sucursal no válida');
    return s;
  }

  async function sucursalDelConteo(usuario, pedida) {
    const propia = Number(usuario.sucursal_id);
    const sucursal = Number(pedida) || propia;
    if (sucursal !== propia && !esAdminCentral(usuario)) {
      throw new ErrorApp('Solo puedes contar el inventario de tu sucursal', { status: 403 });
    }
    const { data } = await consultar(sb().from('sucursales').select('id,nombre').eq('id', sucursal).eq('activa', true).limit(1));
    if (!data || !data.length) throw new ErrorApp('Sucursal no válida');
    return sucursal;
  }

  async function conteoPorId(id) {
    const { data } = await consultar(sb().from('conteos').select('*').eq('id', Number(id)).limit(1));
    return data && data[0] ? data[0] : null;
  }

  async function renglonesDe(conteoId) {
    return todas(() => sb().from('conteo_detalle').select('*').eq('conteo_id', Number(conteoId)).order('orden').order('id'));
  }

  // Los productos de la lista de una farmacia (activos y que usan inventario)
  async function productosDeLista(sucursalId) {
    const filas = await todas(() => sb().from('conteo_lista').select('producto_id').eq('sucursal_id', Number(sucursalId)).order('producto_id'));
    const productos = [];
    for (const lote of lotes(idsValidos(filas.map((f) => f.producto_id)), 150)) {
      const { data } = await consultar(sb().from('productos').select('id,codigo_barras,descripcion,departamento,precio_costo,activo,usa_inventario,piezas_caja').in('id', lote));
      productos.push(...(data || []).filter((p) => p.activo !== false && p.usa_inventario !== false));
    }
    return productos.sort(porDepartamento);
  }

  async function cuantosEnLista(sucursalId) {
    const { count } = await consultar(sb().from('conteo_lista').select('producto_id', { count: 'exact', head: true }).eq('sucursal_id', Number(sucursalId)));
    return Number(count) || 0;
  }

  // Todos los productos que usan inventario (o los de un departamento), para el inventario completo
  async function productosParaCompleto(departamento = '') {
    const filas = await todas(() => {
      let consulta = sb().from('productos').select('id,codigo_barras,descripcion,departamento,precio_costo,piezas_caja').eq('activo', true).eq('usa_inventario', true);
      if (departamento) consulta = consulta.eq('departamento', departamento);
      return consulta.order('id');
    });
    return filas.filter((p) => Number(p.id) > 0).sort(porDepartamento);
  }

  // Por departamento y nombre, para recorrer los estantes en orden
  function renglonesPara(sucursalId, productos, razon) {
    return productos.map((p, i) => ({
      sucursal_id: Number(sucursalId),
      producto_id: Number(p.id),
      codigo_barras: p.codigo_barras || null,
      descripcion: p.descripcion,
      departamento: p.departamento || '',
      orden: i + 1,
      razon,
      costo: r2(p.precio_costo),
      decision: 'pendiente',
      piezas_caja: Number(p.piezas_caja) >= 2 ? Number(p.piezas_caja) : null,
    }));
  }

  async function guardarRenglones(conteoId, renglones) {
    for (const lote of lotes(renglones, 500)) {
      await consultar(sb().from('conteo_detalle').upsert(lote.map((r) => ({ ...r, conteo_id: Number(conteoId) })), { onConflict: 'conteo_id,producto_id', ignoreDuplicates: true }));
    }
  }

  // Estado de un renglón para quien cuenta (sin la cantidad del sistema)
  function estadoRenglon(r) {
    if (r.contado == null) return r.decision === 'no_contado' ? 'no_contado' : 'por_contar';
    if (r.decision === 'cuadra') return 'cuadra';
    if (Number(r.reconteos) === 0) return 'recontar';
    return r.motivo ? 'con_diferencia' : 'falta_motivo';
  }

  function renglonCiego(r) {
    const estado = estadoRenglon(r);
    const final = estado === 'con_diferencia' || estado === 'falta_motivo';
    return {
      id: Number(r.id),
      producto_id: Number(r.producto_id),
      codigo_barras: r.codigo_barras || null,
      descripcion: r.descripcion,
      departamento: r.departamento || '',
      orden: Number(r.orden),
      estado,
      contado: r.contado == null ? null : r2(r.contado),
      // Ya recontado se dice si faltan o sobran, nunca cuántas piezas dice el sistema
      sentido: final ? (Number(r.diferencia) < 0 ? 'faltan' : 'sobran') : null,
      motivo: r.motivo || '',
      decision: r.decision,
      piezas_caja: Number(r.piezas_caja) >= 2 ? Number(r.piezas_caja) : null,
    };
  }

  function renglonCompleto(r, n) {
    const diferencia = r.diferencia == null ? null : r2(r.diferencia);
    return {
      ...renglonCiego(r),
      razon: r.razon || '',
      razon_texto: RAZONES_CONTEO[r.razon] || '',
      existencia_sistema: r.existencia_sistema == null ? null : r2(r.existencia_sistema),
      primer_conteo: r.primer_conteo == null ? null : r2(r.primer_conteo),
      reconteos: Number(r.reconteos) || 0,
      diferencia,
      costo: r2(r.costo),
      valor: diferencia == null ? 0 : r2(diferencia * (Number(r.costo) || 0)),
      contado_por: r.contado_por == null ? null : Number(r.contado_por),
      contador: r.contado_por == null ? '' : n.usuario(r.contado_por),
      contado_fecha: r.contado_fecha || null,
      decidido_por: r.decidido_por == null ? null : Number(r.decidido_por),
      decisor: r.decidido_por == null ? '' : n.usuario(r.decidido_por),
    };
  }

  function totales(renglones) {
    const contados = renglones.filter((r) => r.contado != null);
    const conDiferencia = contados.filter((r) => r.decision !== 'cuadra' && Math.abs(Number(r.diferencia) || 0) > EPS);
    const valor = (r) => r2((Number(r.diferencia) || 0) * (Number(r.costo) || 0));
    const piezas = (signo) => r2(Math.abs(conDiferencia.filter((r) => Math.sign(Number(r.diferencia)) === signo)
      .reduce((t, r) => t + (Number(r.diferencia) || 0), 0)));
    return {
      productos: renglones.length,
      piezas_faltan: piezas(-1),
      piezas_sobran: piezas(1),
      contados: contados.length,
      sin_diferencia: contados.filter((r) => r.decision === 'cuadra').length,
      con_diferencia: conDiferencia.length,
      por_contar: renglones.filter((r) => r.contado == null && r.decision === 'pendiente').length,
      por_autorizar: conDiferencia.filter((r) => r.decision === 'pendiente').length,
      faltante: r2(-conDiferencia.filter((r) => valor(r) < 0).reduce((t, r) => t + valor(r), 0)),
      sobrante: r2(conDiferencia.filter((r) => valor(r) > 0).reduce((t, r) => t + valor(r), 0)),
      exactitud: contados.length ? Math.round((contados.filter((r) => r.decision === 'cuadra').length / contados.length) * 100) : null,
    };
  }

  function conteoParaMostrar(c, renglones, n, { completo = false, conRenglones = true } = {}) {
    return {
      id: Number(c.id),
      sucursal_id: Number(c.sucursal_id),
      sucursal: n.sucursal(c.sucursal_id),
      fecha: c.fecha,
      turno: turnoDe(c),
      departamento: c.departamento || '',
      titulo: tituloConteo(c),
      estado: c.estado,
      nota: c.nota || '',
      creado: c.creado,
      terminado: c.terminado || null,
      terminado_por: c.terminado_por == null ? null : Number(c.terminado_por),
      terminador: c.terminado_por == null ? '' : n.usuario(c.terminado_por),
      cerrado: c.cerrado || null,
      cerrador: c.cerrado_por == null ? '' : n.usuario(c.cerrado_por),
      ...totales(renglones),
      completo,
      ...(conRenglones ? { renglones: renglones.map((r) => (completo ? renglonCompleto(r, n) : renglonCiego(r))) } : {}),
    };
  }

  async function mostrarConteo(c, usuario, { renglones = null } = {}) {
    const filas = renglones || (await renglonesDe(c.id));
    const completo = esJefe(usuario);
    const n = await nombres({
      sucursales: [c.sucursal_id],
      usuarios: [c.terminado_por, c.cerrado_por, ...(completo ? filas.flatMap((r) => [r.contado_por, r.decidido_por]) : [])],
    });
    return conteoParaMostrar(c, filas, n, { completo });
  }

  // Resumen sin renglones (para las tarjetas): cuántos lleva contados
  async function resumenConteo(c) {
    const filas = await todas(() => sb().from('conteo_detalle').select('decision,contado,diferencia,costo').eq('conteo_id', Number(c.id)).order('id'));
    const n = await nombres({ sucursales: [c.sucursal_id] });
    return conteoParaMostrar(c, filas, n, { conRenglones: false });
  }

  // Termina un conteo: lo que no se contó queda como "no contado" y, si hay diferencias, pasa a autorizar
  // Lo que no cuadró se ajusta al terminar, por la diferencia (se respetan las ventas hechas después de
  // contar): así el siguiente turno empieza con lo que de verdad hay y no carga con lo que faltó antes.
  // No hace falta que el jefe lo autorice: lo revisa en la revisión semanal. El ajuste queda a nombre
  // de quien contó.
  async function ajustarDiferencias(c, filas) {
    if (!filas.length) return { aplicados: [], fallidos: [] };
    const { data } = await consultar(
      sb().from('conteo_detalle').update({ decision: 'aprobado', decidido_por: null, decidido: new Date().toISOString() })
        .in('id', filas.map((r) => Number(r.id))).eq('conteo_id', Number(c.id)).eq('decision', 'pendiente').select('*')
    );
    const dia = new Date(`${c.fecha}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const porQuien = new Map();
    for (const r of data || []) {
      const quien = Number(r.contado_por) || 0;
      if (!porQuien.has(quien)) porQuien.set(quien, []);
      porQuien.get(quien).push(r);
    }
    const aplicados = [];
    const fallidos = [];
    for (const [quien, grupo] of porQuien) {
      const movimientos = grupo.map((r) => ({
        producto_id: Number(r.producto_id),
        sucursal_id: Number(c.sucursal_id),
        tipo: Number(r.diferencia) > 0 ? 'entrada' : 'salida',
        cantidad: Math.abs(r2(r.diferencia)),
        validar: false,
        descripcion: r.descripcion,
        nota: `${TURNOS[turnoDe(c)] || TURNOS.dia} ${dia}: el sistema tenía ${r2(r.existencia_sistema)} y se contaron ${r2(r.contado)}`
          + `${r.motivo ? ` (${r.motivo})` : Number(r.reconteos) ? '' : ' (sin recontar)'}`,
      }));
      try {
        await aplicarMovimientos(movimientos, quien || null);
        aplicados.push(...grupo);
      } catch (error) {
        registrar('No se pudo ajustar el inventario del conteo:', error.message);
        fallidos.push(...grupo);
      }
    }
    if (fallidos.length) {
      await consultar(
        sb().from('conteo_detalle').update({ decision: 'pendiente', decidido_por: null, decidido: null }).in('id', fallidos.map((r) => Number(r.id)))
      ).catch(() => {});
    }
    return { aplicados, fallidos };
  }

  async function finalizar(c, usuario, { automatico = false, porTurno = false } = {}) {
    const ahora = new Date().toISOString();
    await consultar(
      sb().from('conteo_detalle').update({ decision: 'no_contado' }).eq('conteo_id', Number(c.id)).is('contado', null).eq('decision', 'pendiente')
    );
    const renglones = await renglonesDe(c.id);
    const t = totales(renglones);
    const cambios = {
      estado: 'cerrado',
      productos: t.productos,
      contados: t.contados,
      sin_diferencia: t.sin_diferencia,
      terminado: ahora,
      terminado_por: usuario ? Number(usuario.id) : null,
      cerrado: ahora,
      updated_at: ahora,
    };
    if (automatico) {
      cambios.nota = !t.contados ? 'Nadie lo contó' : porTurno ? 'Se cerró solo al empezar el turno de la tarde' : 'Se cerró solo al día siguiente';
    }
    const { data } = await consultar(sb().from('conteos').update(cambios).eq('id', Number(c.id)).eq('estado', 'abierto').select('*'));
    if (!data || !data.length) return null; // alguien más lo terminó al mismo tiempo
    let final = data[0];
    const conDiferencia = renglones.filter((r) => r.contado != null && r.decision === 'pendiente' && Math.abs(Number(r.diferencia) || 0) > EPS);
    const { fallidos } = await ajustarDiferencias(c, conDiferencia);
    if (fallidos.length) {
      // No se pudo ajustar (por ejemplo, se fue el internet a la mitad): el jefe lo aplica desde Inventarios
      const { data: pendiente } = await consultar(
        sb().from('conteos').update({ estado: 'por_autorizar', cerrado: null, updated_at: new Date().toISOString() }).eq('id', Number(c.id)).select('*')
      ).catch(() => ({ data: null }));
      if (pendiente && pendiente[0]) final = pendiente[0];
    }
    if (t.contados) {
      const n = await nombres({ sucursales: [c.sucursal_id] });
      const diferencias = conDiferencia.slice(0, 30).map((r) => ({
        producto: r.descripcion, sistema: r2(r.existencia_sistema), contado: r2(r.contado), diferencia: r2(r.diferencia), motivo: r.motivo || '',
      }));
      await anotarCambio({
        usuario,
        sucursal_id: c.sucursal_id,
        tipo: 'conteo_terminado',
        descripcion: `${n.sucursal(c.sucursal_id)} (${tituloConteo(c).toLowerCase()}): ${t.sin_diferencia} de ${t.contados} productos cuadraron`
          + `${t.piezas_faltan ? `; faltan ${t.piezas_faltan} pieza(s) ($${t.faltante.toFixed(2)})` : ''}`
          + `${t.piezas_sobran ? `; sobran ${t.piezas_sobran} pieza(s) ($${t.sobrante.toFixed(2)})` : ''}`
          + `${t.con_diferencia ? (fallidos.length ? '; falta ajustar la existencia' : '; se ajustó la existencia') : ''}`
          + `${t.productos > t.contados ? `; ${t.productos - t.contados} sin contar` : ''}${automatico ? ' (se cerró solo)' : ''}`,
        detalle: { conteo_id: Number(c.id), fecha: c.fecha, turno: turnoDe(c), ...t, diferencias },
        // El jefe se entera el mismo día si faltó algo
        alerta: t.piezas_faltan > EPS || fallidos.length > 0,
      });
    }
    return final;
  }

  // Lo que se quedó abierto se cierra solo: los turnos de días anteriores y, al empezar la tarde, el de
  // la mañana. El inventario completo no: sigue abierto hasta que se termina o se cancela.
  async function cerrarAnteriores(sucursalId, hoy, turno) {
    const { data } = await consultar(
      sb().from('conteos').select('*').eq('sucursal_id', sucursalId).eq('estado', 'abierto').lte('fecha', hoy).limit(40)
    );
    for (const c of data || []) {
      const t = turnoDe(c);
      if (t === 'completo') continue;
      const deLaManana = c.fecha === hoy && t === 'manana' && turno === 'tarde';
      if (c.fecha < hoy || deLaManana) await finalizar(c, null, { automatico: true, porTurno: deLaManana });
    }
  }

  async function completoAbierto(sucursalId) {
    const { data } = await consultar(
      sb().from('conteos').select('*').eq('sucursal_id', Number(sucursalId)).eq('turno', 'completo').eq('estado', 'abierto')
        .order('id', { ascending: false }).limit(1)
    );
    return data && data[0] ? data[0] : null;
  }

  // El conteo del turno que corre (mañana o tarde) de la sucursal; si todavía no existe, se arma con
  // los productos de su lista. Solo una computadora o celular lo arma a la vez: se "aparta" poniendo
  // productos = -1 mientras se arma. También dice si hay un inventario completo abierto.
  async function conteoDeHoy(usuario, { sucursal_id } = {}) {
    const sucursalId = await sucursalDelConteo(usuario, sucursal_id);
    const hoy = diaDe();
    const { hora_tarde } = await configDe(sucursalId);
    const turno = horaDe() < hora_tarde ? 'manana' : 'tarde';
    await cerrarAnteriores(sucursalId, hoy, turno);
    const abierto = await completoAbierto(sucursalId);
    const completo = abierto ? await resumenConteo(abierto) : null;
    const buscar = async () => {
      const { data } = await consultar(sb().from('conteos').select('*').eq('sucursal_id', sucursalId).eq('fecha', hoy).eq('turno', turno).limit(1));
      return data && data[0] ? data[0] : null;
    };
    let c = await buscar();
    if (!c) {
      if (!(await cuantosEnLista(sucursalId))) {
        const n = await nombres({ sucursales: [sucursalId] });
        return {
          sin_lista: true, sucursal_id: sucursalId, sucursal: n.sucursal(sucursalId), fecha: hoy, turno,
          titulo: TURNOS[turno], hora_tarde, productos: 0, contados: 0, renglones: [], completo,
        };
      }
      try {
        await consultar(sb().from('conteos').insert({ sucursal_id: sucursalId, fecha: hoy, turno, estado: 'abierto', productos: 0 }).select('id'));
      } catch (error) {
        if (error.codigo !== '23505') throw error; // otro lo creó al mismo tiempo
      }
      c = await buscar();
    }
    for (let intento = 0; intento < 4 && c.estado === 'abierto' && Number(c.productos) <= 0; intento += 1) {
      const libre = Number(c.productos) === 0;
      // Si quien lo apartó se quedó a medias (se fue el internet), después de un minuto otro lo arma
      const atorada = !libre && new Date(c.updated_at).getTime() < Date.now() - 60000;
      if (libre || atorada) {
        let apartar = sb().from('conteos').update({ productos: -1, updated_at: new Date().toISOString() }).eq('id', Number(c.id));
        apartar = libre ? apartar.eq('productos', 0) : apartar.eq('productos', -1).lt('updated_at', new Date(Date.now() - 60000).toISOString());
        const { data: apartado } = await consultar(apartar.select('id'));
        if (apartado && apartado.length) {
          let lista = [];
          try {
            lista = renglonesPara(sucursalId, await productosDeLista(sucursalId), 'lista');
            await guardarRenglones(c.id, lista);
          } finally {
            await consultar(sb().from('conteos').update({ productos: lista.length, updated_at: new Date().toISOString() }).eq('id', Number(c.id)));
          }
          c = await buscar();
          break;
        }
      }
      await esperar(1200); // otro lo está armando
      c = await buscar();
    }
    return { ...(await mostrarConteo(c, usuario)), hora_tarde, completo };
  }

  async function conteoEditable(usuario, conteoId) {
    const c = await conteoPorId(conteoId);
    if (!c) throw new ErrorApp('Conteo no encontrado', { status: 404 });
    await sucursalDelConteo(usuario, c.sucursal_id);
    if (c.estado !== 'abierto') throw new ErrorApp('Este inventario ya se terminó; actualiza la pantalla', { codigo: 'CONTEO_CERRADO' });
    return c;
  }

  async function renglonDe(c, renglonId) {
    const { data } = await consultar(sb().from('conteo_detalle').select('*').eq('id', Number(renglonId)).eq('conteo_id', Number(c.id)).limit(1));
    if (!data || !data.length) throw new ErrorApp('Ese producto no está en esta lista', { status: 404 });
    return data[0];
  }

  async function existenciaEnCentral(productoId, sucursalId) {
    if (existenciaActual) return r2(await existenciaActual(productoId, sucursalId));
    const { data } = await consultar(sb().from('inventario').select('existencia').eq('producto_id', productoId).eq('sucursal_id', sucursalId).limit(1));
    return data && data[0] ? r2(data[0].existencia) : 0;
  }

  // Registra lo que se contó. La primera vez, si no cuadra, pide recontar; el recuento es el definitivo.
  async function contar(usuario, conteoId, { renglon_id, contado } = {}) {
    const valor = Number(contado);
    if (contado === '' || contado === null || contado === undefined || !Number.isFinite(valor) || valor < 0) {
      throw new ErrorApp('Escribe cuántas piezas contaste');
    }
    const c = await conteoEditable(usuario, conteoId);
    const r = await renglonDe(c, renglon_id);
    const primera = r.contado == null;
    if (r.decision !== 'pendiente' || (!primera && Number(r.reconteos) >= 1)) {
      throw new ErrorApp('Este producto ya quedó contado', { codigo: 'YA_CONTADO' });
    }
    const sistema = await existenciaEnCentral(Number(r.producto_id), Number(c.sucursal_id));
    const piezas = r2(valor);
    const diferencia = r2(piezas - sistema);
    const cuadra = Math.abs(diferencia) < EPS;
    const ahora = new Date().toISOString();
    const cambios = {
      contado: piezas,
      existencia_sistema: sistema,
      diferencia,
      contado_por: Number(usuario.id),
      contado_fecha: ahora,
      decision: cuadra ? 'cuadra' : 'pendiente',
    };
    if (primera) cambios.primer_conteo = piezas;
    else cambios.reconteos = 1;
    let actualizar = sb().from('conteo_detalle').update(cambios).eq('id', Number(r.id)).eq('decision', 'pendiente');
    actualizar = primera ? actualizar.is('contado', null) : actualizar.eq('reconteos', 0).not('contado', 'is', null);
    const { data } = await consultar(actualizar.select('*'));
    if (!data || !data.length) throw new ErrorApp('Alguien más acaba de contar este producto; actualiza la lista', { status: 409, codigo: 'YA_CONTADO' });
    await consultar(sb().from('conteo_ultimos').upsert(
      { sucursal_id: Number(c.sucursal_id), producto_id: Number(r.producto_id), contado: ahora, diferencia },
      { onConflict: 'sucursal_id,producto_id' }
    ));
    return { resultado: cuadra ? 'cuadra' : primera ? 'recontar' : 'diferencia', renglon: renglonCiego(data[0]) };
  }

  async function anotarMotivo(usuario, conteoId, { renglon_id, motivo } = {}) {
    const texto = String(motivo || '').trim().slice(0, 200);
    if (!texto) throw new ErrorApp('Escribe el motivo de la diferencia');
    const c = await conteoEditable(usuario, conteoId);
    const r = await renglonDe(c, renglon_id);
    if (r.contado == null || r.decision !== 'pendiente' || Math.abs(Number(r.diferencia) || 0) < EPS) {
      throw new ErrorApp('Ese producto no tiene diferencia');
    }
    const { data } = await consultar(sb().from('conteo_detalle').update({ motivo: texto }).eq('id', Number(r.id)).eq('decision', 'pendiente').select('*'));
    if (!data || !data.length) throw new ErrorApp('Ese producto ya se revisó; actualiza la lista');
    return { renglon: renglonCiego(data[0]) };
  }

  async function terminar(usuario, conteoId, { dejar_pendientes = false } = {}) {
    const c = await conteoEditable(usuario, conteoId);
    const renglones = await renglonesDe(c.id);
    const estados = renglones.map(estadoRenglon);
    const recontar = estados.filter((e) => e === 'recontar').length;
    if (recontar) throw new ErrorApp(`Falta recontar ${recontar} producto(s) que no cuadraron`, { codigo: 'FALTA_RECONTAR' });
    const sinMotivo = estados.filter((e) => e === 'falta_motivo').length;
    if (sinMotivo) throw new ErrorApp(`Falta anotar el motivo de ${sinMotivo} producto(s) con diferencia`, { codigo: 'FALTA_MOTIVO' });
    const porContar = estados.filter((e) => e === 'por_contar').length;
    if (!renglones.length) throw new ErrorApp('Esta lista no tiene productos');
    if (porContar === renglones.length) throw new ErrorApp('Todavía no has contado ningún producto');
    if (porContar && !dejar_pendientes) {
      throw new ErrorApp(`Faltan ${porContar} producto(s) por contar`, { status: 409, codigo: 'FALTAN_POR_CONTAR', datos: { por_contar: porContar } });
    }
    await finalizar(c, usuario);
    return mostrarConteo(await conteoPorId(c.id), usuario);
  }

  async function listarConteos(usuario, filtros = {}) {
    const jefe = esJefe(usuario);
    let consulta = sb().from('conteos').select('*');
    if (!jefe) consulta = consulta.eq('sucursal_id', Number(usuario.sucursal_id));
    else if (Number(filtros.sucursal_id)) consulta = consulta.eq('sucursal_id', Number(filtros.sucursal_id));
    if (['abierto', 'por_autorizar', 'cerrado', 'cancelado'].includes(filtros.estado)) consulta = consulta.eq('estado', filtros.estado);
    if (Object.keys(TURNOS).includes(filtros.turno)) consulta = consulta.eq('turno', filtros.turno);
    const limite = Math.min(Math.max(Number(filtros.limite) || 30, 1), 60);
    const { data } = await consultar(consulta.gt('productos', 0).order('fecha', { ascending: false }).order('id', { ascending: false }).limit(limite));
    const conteos = data || [];
    const detalle = [];
    for (const lote of lotes(idsValidos(conteos.map((c) => c.id)), 40)) {
      detalle.push(...await todas(() => sb().from('conteo_detalle').select('conteo_id,decision,contado,diferencia,costo').in('conteo_id', lote).order('id')));
    }
    const n = await nombres({ sucursales: conteos.map((c) => c.sucursal_id), usuarios: conteos.flatMap((c) => [c.terminado_por, c.cerrado_por]) });
    return conteos.map((c) => conteoParaMostrar(c, detalle.filter((d) => Number(d.conteo_id) === Number(c.id)), n, { conRenglones: false }));
  }

  async function cargarConteo(usuario, id) {
    const c = await conteoPorId(id);
    if (!c) throw new ErrorApp('Conteo no encontrado', { status: 404 });
    if (!esJefe(usuario) && Number(c.sucursal_id) !== Number(usuario.sucursal_id)) {
      throw new ErrorApp('Ese conteo es de otra sucursal', { status: 403 });
    }
    return mostrarConteo(c, usuario);
  }

  // El jefe aprueba (se ajusta el inventario por la diferencia) o rechaza (no se toca) cada renglón.
  // Nunca puede autorizar lo que él mismo contó.
  async function autorizar(usuario, conteoId, { aprobar = [], rechazar = [] } = {}) {
    soloJefe(usuario, 'Solo un jefe autoriza los ajustes del inventario');
    const c = await conteoPorId(conteoId);
    if (!c) throw new ErrorApp('Conteo no encontrado', { status: 404 });
    if (c.estado !== 'por_autorizar') throw new ErrorApp('Este inventario no tiene diferencias por autorizar');
    const idsAprobar = idsValidos(aprobar);
    const idsRechazar = idsValidos(rechazar).filter((id) => !idsAprobar.includes(id));
    if (!idsAprobar.length && !idsRechazar.length) throw new ErrorApp('Elige qué diferencias apruebas o rechazas');
    const renglones = await renglonesDe(c.id);
    const porId = new Map(renglones.map((r) => [Number(r.id), r]));
    for (const id of [...idsAprobar, ...idsRechazar]) {
      const r = porId.get(id);
      if (!r || r.contado == null || r.decision !== 'pendiente') throw new ErrorApp('Una de las diferencias ya se revisó; actualiza la pantalla');
      if (Number(r.contado_por) === Number(usuario.id)) {
        throw new ErrorApp(`No puedes autorizar lo que tú contaste ("${r.descripcion}"): pide a otro jefe que lo revise`, { status: 403, codigo: 'PROPIO' });
      }
    }
    const ahora = new Date().toISOString();
    const apartar = async (ids, decision) => {
      if (!ids.length) return [];
      const { data } = await consultar(
        sb().from('conteo_detalle').update({ decision, decidido_por: Number(usuario.id), decidido: ahora })
          .in('id', ids).eq('conteo_id', Number(c.id)).eq('decision', 'pendiente').select('*')
      );
      return data || [];
    };
    const regresar = (filas) => (filas.length
      ? consultar(sb().from('conteo_detalle').update({ decision: 'pendiente', decidido_por: null, decidido: null }).in('id', filas.map((f) => Number(f.id)))).catch(() => {})
      : null);
    const aprobados = await apartar(idsAprobar, 'aprobado');
    let rechazados = [];
    try {
      rechazados = await apartar(idsRechazar, 'rechazado');
      const dia = new Date(`${c.fecha}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const movimientos = aprobados.filter((r) => Math.abs(Number(r.diferencia)) > EPS).map((r) => ({
        producto_id: Number(r.producto_id),
        sucursal_id: Number(c.sucursal_id),
        tipo: Number(r.diferencia) > 0 ? 'entrada' : 'salida',
        cantidad: Math.abs(r2(r.diferencia)),
        validar: false,
        descripcion: r.descripcion,
        nota: `${TURNOS[turnoDe(c)] || TURNOS.dia} ${dia}: el sistema tenía ${r2(r.existencia_sistema)} y se contaron ${r2(r.contado)}${r.motivo ? ` (${r.motivo})` : ''}`,
      }));
      if (movimientos.length) await aplicarMovimientos(movimientos, Number(usuario.id));
    } catch (error) {
      await regresar(aprobados);
      await regresar(rechazados);
      throw error;
    }
    const restantes = await renglonesDe(c.id);
    const t = totales(restantes);
    if (t.por_autorizar === 0) {
      await consultar(
        sb().from('conteos').update({ estado: 'cerrado', cerrado: ahora, cerrado_por: Number(usuario.id), updated_at: ahora })
          .eq('id', Number(c.id)).eq('estado', 'por_autorizar')
      );
    }
    const valor = (filas) => r2(filas.reduce((s, r) => s + r2((Number(r.diferencia) || 0) * (Number(r.costo) || 0)), 0));
    const n = await nombres({ sucursales: [c.sucursal_id] });
    await anotarCambio({
      usuario,
      sucursal_id: c.sucursal_id,
      tipo: 'conteo_autorizado',
      descripcion: `${n.sucursal(c.sucursal_id)}, ${tituloConteo(c).toLowerCase()} del ${c.fecha}: ${aprobados.length} ajuste(s) aprobado(s) ($${valor(aprobados).toFixed(2)})`
        + `${rechazados.length ? ` y ${rechazados.length} rechazado(s)` : ''}`,
      detalle: {
        conteo_id: Number(c.id),
        aprobados: aprobados.map((r) => ({ producto: r.descripcion, sistema: r2(r.existencia_sistema), contado: r2(r.contado), diferencia: r2(r.diferencia) })),
        rechazados: rechazados.map((r) => ({ producto: r.descripcion, sistema: r2(r.existencia_sistema), contado: r2(r.contado), diferencia: r2(r.diferencia) })),
      },
    });
    return mostrarConteo(await conteoPorId(c.id), usuario, { renglones: restantes });
  }

  // ---------- Revisión semanal del inventario (jefe) ----------
  // Como la hoja de Excel de antes: los productos que se contaron en la semana en renglones y cada
  // conteo (día y turno) en columnas, con lo que se contó y si cuadró. Cada conteo revisa lo que pasó
  // desde el conteo anterior de esa farmacia: dice quién contó y quién cobró en ese tiempo.
  const lunesDe = (dia) => sumarDias(dia, -((new Date(`${dia}T12:00:00Z`).getUTCDay() + 6) % 7));
  const detalleDe = (f) => {
    if (!f || f.detalle == null) return {};
    if (typeof f.detalle !== 'string') return f.detalle;
    try { return JSON.parse(f.detalle); } catch { return {}; }
  };

  function estadoCelda(r) {
    if (r.contado == null) return 'no_contado';
    if (r.decision === 'cuadra' || Math.abs(Number(r.diferencia) || 0) < EPS) return 'cuadra';
    return Number(r.diferencia) < 0 ? 'faltan' : 'sobran';
  }

  async function revisionDeSemana(sucursalId, lunes) {
    const { data } = await consultar(
      sb().from('bitacora').select('*').eq('tipo', 'inventario_revisado').eq('sucursal_id', Number(sucursalId))
        .gte('fecha', inicioDelDia(lunes)).order('fecha', { ascending: false }).limit(50)
    );
    return (data || []).find((f) => detalleDe(f).semana === lunes) || null;
  }

  async function semana(usuario, { sucursal_id, desde } = {}) {
    soloJefe(usuario);
    const sucursales = await sucursalesActivas();
    const sucursal = Number(sucursal_id) ? await sucursalValida(sucursal_id) : sucursales[0];
    if (!sucursal) throw new ErrorApp('No hay sucursales');
    const hoy = diaDe();
    const lunes = lunesDe(diaValido(desde) || hoy);
    const domingo = sumarDias(lunes, 6);
    const { hora_tarde } = await configDe(sucursal.id);
    const [{ data: deLaSemana }, { data: anteriores }, revision] = await Promise.all([
      consultar(sb().from('conteos').select('*').eq('sucursal_id', sucursal.id).gte('fecha', lunes).lte('fecha', domingo)
        .gt('productos', 0).neq('estado', 'cancelado').order('fecha').order('id')),
      consultar(sb().from('conteos').select('*').eq('sucursal_id', sucursal.id).lt('fecha', lunes)
        .gt('productos', 0).neq('estado', 'cancelado').order('fecha', { ascending: false }).order('id', { ascending: false }).limit(1)),
      revisionDeSemana(sucursal.id, lunes),
    ]);
    const previo = (anteriores || [])[0] || null;
    const todos = [...(previo ? [previo] : []), ...(deLaSemana || [])];
    const renglones = [];
    for (const lote of lotes(idsValidos(todos.map((c) => c.id)), 40)) {
      renglones.push(...await todas(() => sb().from('conteo_detalle').select('*').in('conteo_id', lote).order('id')));
    }
    const porConteo = new Map(todos.map((c) => [Number(c.id), []]));
    for (const r of renglones) porConteo.get(Number(r.conteo_id))?.push(r);
    // Cuándo se contó: del primer al último producto contado
    const tiempos = (c) => {
      const fechas = (porConteo.get(Number(c.id)) || []).map((r) => r.contado_fecha).filter(Boolean).sort();
      const respaldo = c.terminado || c.creado || inicioDelDia(c.fecha);
      return { inicio: fechas[0] || respaldo, fin: fechas[fechas.length - 1] || respaldo };
    };
    const ordenados = (deLaSemana || []).map((c) => ({ c, ...tiempos(c) })).sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
    let anterior = previo ? tiempos(previo).fin : null;
    for (const o of ordenados) {
      o.desde = anterior;
      anterior = o.fin;
    }
    // Quién cobró entre un conteo y el siguiente
    let ventas = null;
    if (ordenados.length) {
      try {
        const inicioVentas = ordenados[0].desde || inicioDelDia(lunes);
        const finVentas = ordenados[ordenados.length - 1].inicio;
        ventas = await todas(() => sb().from('ventas').select('usuario_id,fecha,cancelada').eq('sucursal_id', sucursal.id)
          .gt('fecha', inicioVentas).lte('fecha', finVentas).order('fecha'));
      } catch {
        ventas = null; // sin las ventas en la central, la revisión sale igual sin "quién cobró"
      }
    }
    const usuarios = [
      ...renglones.map((r) => r.contado_por),
      ...todos.map((c) => c.terminado_por),
      ...(ventas || []).map((v) => v.usuario_id),
      revision ? revision.usuario_id : null,
    ];
    const n = await nombres({ sucursales: [sucursal.id], usuarios });
    const instante = (texto) => new Date(texto).getTime();
    const conteos = ordenados.map(({ c, inicio, fin, desde: periodoDesde }) => {
      const filas = porConteo.get(Number(c.id)) || [];
      let cobraron = null;
      if (ventas) {
        const cuenta = new Map();
        for (const v of ventas) {
          if (v.cancelada === true || Number(v.cancelada) === 1) continue;
          const t = instante(v.fecha);
          if ((periodoDesde && t <= instante(periodoDesde)) || t > instante(inicio)) continue;
          const quien = Number(v.usuario_id) || 0;
          cuenta.set(quien, (cuenta.get(quien) || 0) + 1);
        }
        cobraron = [...cuenta].map(([id, num]) => ({ usuario: id ? n.usuario(id) : 'Sin usuario', ventas: num })).sort((a, b) => b.ventas - a.ventas);
      }
      return {
        id: Number(c.id),
        fecha: c.fecha,
        turno: turnoDe(c),
        titulo: tituloConteo(c),
        estado: c.estado,
        nota: c.nota || '',
        inicio,
        fin,
        hora: horaDe(new Date(inicio)),
        periodo_desde: periodoDesde,
        contaron: [...new Set(filas.filter((r) => r.contado_por != null).map((r) => n.usuario(r.contado_por)))],
        cobraron,
        ...totales(filas),
      };
    });
    // Los productos (renglones de la hoja), con lo que se contó en cada conteo
    const productos = new Map();
    for (const { c } of ordenados) {
      for (const r of porConteo.get(Number(c.id)) || []) {
        const id = Number(r.producto_id);
        if (!productos.has(id)) {
          productos.set(id, { producto_id: id, descripcion: r.descripcion, departamento: r.departamento || '', codigo_barras: r.codigo_barras || null, celdas: {} });
        }
        const p = productos.get(id);
        const estado = estadoCelda(r);
        p.celdas[Number(c.id)] = {
          estado,
          contado: r.contado == null ? null : r2(r.contado),
          sistema: r.existencia_sistema == null ? null : r2(r.existencia_sistema),
          diferencia: estado === 'faltan' || estado === 'sobran' ? r2(r.diferencia) : 0,
          valor: estado === 'faltan' || estado === 'sobran' ? r2((Number(r.diferencia) || 0) * (Number(r.costo) || 0)) : 0,
          primer_conteo: r.primer_conteo == null ? null : r2(r.primer_conteo),
          motivo: r.motivo || '',
          contador: r.contado_por == null ? '' : n.usuario(r.contado_por),
          hora: r.contado_fecha ? horaDe(new Date(r.contado_fecha)) : '',
        };
      }
    }
    const filasProductos = [...productos.values()].sort(porDepartamento).map((p) => {
      const celdas = Object.values(p.celdas);
      return {
        ...p,
        diferencia_semana: r2(celdas.reduce((t, x) => t + (Number(x.diferencia) || 0), 0)),
        valor_semana: r2(celdas.reduce((t, x) => t + (Number(x.valor) || 0), 0)),
      };
    });
    // Los dos turnos de cada día: cuáles se hicieron y cuáles no
    const ahora = horaDe();
    const turnos = [];
    for (let i = 0; i < 7; i += 1) {
      const dia = sumarDias(lunes, i);
      for (const turno of ['manana', 'tarde']) {
        const hecho = conteos.find((x) => x.fecha === dia && x.turno === turno && x.contados > 0);
        let estado = 'por_venir';
        if (hecho) estado = 'hecho';
        else if (dia < hoy || (dia === hoy && turno === 'manana' && ahora >= hora_tarde)) estado = 'no_se_hizo';
        else if (dia === hoy) estado = 'pendiente';
        turnos.push({ fecha: dia, turno, titulo: TURNOS[turno], estado, conteo_id: hecho ? hecho.id : null });
      }
    }
    const suma = (campo) => r2(conteos.reduce((t, x) => t + (Number(x[campo]) || 0), 0));
    return {
      sucursal_id: sucursal.id,
      sucursal: sucursal.nombre,
      sucursales: sucursales.map((s) => ({ id: s.id, nombre: s.nombre })),
      desde: lunes,
      hasta: domingo,
      hoy,
      hora_tarde,
      conteos,
      productos: filasProductos,
      turnos,
      ventas_disponibles: Boolean(ventas) || !ordenados.length,
      totales: {
        conteos: conteos.length,
        turnos_hechos: turnos.filter((t) => t.estado === 'hecho').length,
        turnos_sin_hacer: turnos.filter((t) => t.estado === 'no_se_hizo').length,
        piezas_faltan: suma('piezas_faltan'),
        piezas_sobran: suma('piezas_sobran'),
        faltante: suma('faltante'),
        sobrante: suma('sobrante'),
        con_diferencia: conteos.reduce((t, x) => t + x.con_diferencia, 0),
        contados: conteos.reduce((t, x) => t + x.contados, 0),
      },
      revisada: revision ? { por: revision.usuario_id == null ? '' : n.usuario(revision.usuario_id), fecha: revision.fecha } : null,
    };
  }

  // El jefe marca la semana como revisada (queda en el registro de cambios)
  async function revisarSemana(usuario, { sucursal_id, semana: dia } = {}) {
    soloJefe(usuario);
    const hoja = await semana(usuario, { sucursal_id, desde: dia });
    const t = hoja.totales;
    const formato = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const fecha = new Date().toISOString();
    await anotarCambio({
      usuario,
      sucursal_id: hoja.sucursal_id,
      tipo: 'inventario_revisado',
      descripcion: `${hoja.sucursal}: semana del ${formato(hoja.desde)} al ${formato(hoja.hasta)} revisada`
        + ` (${t.turnos_hechos} de 14 turnos contados${t.turnos_sin_hacer ? `, ${t.turnos_sin_hacer} sin hacer` : ''}`
        + `; faltaron ${t.piezas_faltan} pieza(s), $${t.faltante.toFixed(2)}; sobraron ${t.piezas_sobran}, $${t.sobrante.toFixed(2)})`,
      detalle: { semana: hoja.desde, ...t },
    });
    return { ...hoja, revisada: { por: usuario.nombre || '', fecha } };
  }

  // ---------- Inventario completo (todo o un departamento) ----------
  async function iniciarCompleto(usuario, { sucursal_id, departamento = '' } = {}) {
    soloJefe(usuario, 'Solo el jefe empieza un inventario completo');
    const sucursal = await sucursalValida(sucursal_id);
    if (await completoAbierto(sucursal.id)) {
      throw new ErrorApp('Ya hay un inventario completo abierto en esta sucursal: termínalo o cancélalo antes de empezar otro', { codigo: 'COMPLETO_ABIERTO' });
    }
    const depto = String(departamento || '').trim();
    const productos = await productosParaCompleto(depto);
    if (!productos.length) throw new ErrorApp(depto ? `El departamento "${depto}" no tiene productos que usen inventario` : 'No hay productos que usen inventario');
    const ahora = () => new Date().toISOString();
    const { data } = await consultar(sb().from('conteos').insert({
      sucursal_id: sucursal.id, fecha: diaDe(), turno: 'completo', departamento: depto, estado: 'abierto', productos: -1,
    }).select('*'));
    const c = data[0];
    try {
      await guardarRenglones(c.id, renglonesPara(sucursal.id, productos, 'completo'));
    } catch (error) {
      await consultar(sb().from('conteos').update({ estado: 'cancelado', nota: 'No se pudo armar la lista', updated_at: ahora() }).eq('id', Number(c.id))).catch(() => {});
      throw error;
    }
    await consultar(sb().from('conteos').update({ productos: productos.length, updated_at: ahora() }).eq('id', Number(c.id)));
    await anotarCambio({
      usuario, sucursal_id: sucursal.id, tipo: 'conteo_completo',
      descripcion: `${sucursal.nombre}: empezó un inventario completo ${depto ? `del departamento ${depto}` : 'de todos los productos'} (${productos.length} productos)`,
      detalle: { conteo_id: Number(c.id), departamento: depto, productos: productos.length },
    });
    return resumenConteo(await conteoPorId(c.id));
  }

  // El jefe cancela un inventario completo abierto (por ejemplo, si se empezó por error)
  async function cancelarConteo(usuario, conteoId) {
    soloJefe(usuario, 'Solo el jefe cancela un inventario completo');
    const c = await conteoPorId(conteoId);
    if (!c) throw new ErrorApp('Conteo no encontrado', { status: 404 });
    if (turnoDe(c) !== 'completo') throw new ErrorApp('Solo se cancela un inventario completo; los de cada turno se terminan solos');
    const { data } = await consultar(sb().from('conteos').update({ estado: 'cancelado', nota: `Lo canceló ${usuario.nombre || 'el jefe'}`, updated_at: new Date().toISOString() })
      .eq('id', Number(c.id)).eq('estado', 'abierto').select('*'));
    if (!data || !data.length) throw new ErrorApp('Este inventario ya no está abierto; actualiza la pantalla', { codigo: 'CONTEO_CERRADO' });
    const n = await nombres({ sucursales: [c.sucursal_id] });
    await anotarCambio({
      usuario, sucursal_id: c.sucursal_id, tipo: 'conteo_completo',
      descripcion: `${n.sucursal(c.sucursal_id)}: se canceló el ${tituloConteo(c).toLowerCase()} del ${c.fecha}`,
      detalle: { conteo_id: Number(c.id), cancelado: true },
    });
    return resumenConteo(data[0]);
  }

  // ---------- La lista del inventario de cada farmacia (la arma el jefe) ----------
  async function lista(usuario, { sucursal_id } = {}) {
    soloJefe(usuario);
    const sucursales = await sucursalesActivas();
    const sucursal = sucursales.find((s) => s.id === Number(sucursal_id)) || sucursales[0];
    if (!sucursal) throw new ErrorApp('No hay sucursales activas');
    const [productos, config, abierto] = await Promise.all([productosDeLista(sucursal.id), configDe(sucursal.id), completoAbierto(sucursal.id)]);
    return {
      sucursal_id: sucursal.id,
      sucursal: sucursal.nombre,
      sucursales: sucursales.map((s) => ({ id: s.id, nombre: s.nombre })),
      hora_tarde: config.hora_tarde,
      total: productos.length,
      // Unos 30 segundos por producto (escanear, contar estante y bodega)
      minutos_por_turno: Math.ceil(productos.length / 2),
      productos: productos.map((p) => ({ producto_id: Number(p.id), codigo_barras: p.codigo_barras || null, descripcion: p.descripcion, departamento: p.departamento || '' })),
      completo: abierto ? await resumenConteo(abierto) : null,
    };
  }

  async function agregarIds(usuario, sucursal, ids, origen = '') {
    const validos = [];
    for (const lote of lotes(idsValidos(ids), 150)) {
      const { data } = await consultar(sb().from('productos').select('id,descripcion,activo,usa_inventario').in('id', lote));
      validos.push(...(data || []).filter((p) => p.activo !== false && p.usa_inventario !== false));
    }
    if (!validos.length) throw new ErrorApp('Esos productos no usan inventario o están dados de baja');
    const ya = new Set((await todas(() => sb().from('conteo_lista').select('producto_id').eq('sucursal_id', sucursal.id).order('producto_id')))
      .map((f) => Number(f.producto_id)));
    const nuevos = validos.filter((p) => !ya.has(Number(p.id)));
    for (const lote of lotes(nuevos, 500)) {
      await consultar(sb().from('conteo_lista').upsert(
        lote.map((p) => ({ sucursal_id: sucursal.id, producto_id: Number(p.id), agregado_por: Number(usuario.id) })),
        { onConflict: 'sucursal_id,producto_id', ignoreDuplicates: true }
      ));
    }
    if (nuevos.length) {
      const nombresP = nuevos.slice(0, 3).map((p) => p.descripcion).join(', ');
      await anotarCambio({
        usuario, sucursal_id: sucursal.id, tipo: 'conteo_lista',
        descripcion: `${sucursal.nombre}: ${nuevos.length} producto(s) a la lista del inventario`
          + (origen ? ` (de ${origen})` : `: ${nombresP}${nuevos.length > 3 ? '…' : ''}`),
        detalle: { agregados: nuevos.map((p) => Number(p.id)).slice(0, 500), origen },
      });
    }
    return { agregados: nuevos.length, ya_estaban: validos.length - nuevos.length };
  }

  async function quitarIds(usuario, sucursal, ids, { todo = false } = {}) {
    let quitados = [];
    if (todo) {
      const { data } = await consultar(sb().from('conteo_lista').delete().eq('sucursal_id', sucursal.id).select('producto_id'));
      quitados = data || [];
    } else {
      for (const lote of lotes(idsValidos(ids), 150)) {
        const { data } = await consultar(sb().from('conteo_lista').delete().eq('sucursal_id', sucursal.id).in('producto_id', lote).select('producto_id'));
        quitados.push(...(data || []));
      }
    }
    if (quitados.length) {
      const n = await nombres({ productos: quitados.slice(0, 3).map((f) => f.producto_id) });
      const nombresP = quitados.slice(0, 3).map((f) => n.producto(f.producto_id)?.descripcion || `producto ${f.producto_id}`).join(', ');
      await anotarCambio({
        usuario, sucursal_id: sucursal.id, tipo: 'conteo_lista',
        descripcion: `${sucursal.nombre}: se quitaron ${quitados.length} producto(s) de la lista del inventario`
          + (todo ? ' (toda la lista)' : `: ${nombresP}${quitados.length > 3 ? '…' : ''}`),
        detalle: { quitados: quitados.map((f) => Number(f.producto_id)).slice(0, 500) },
      });
    }
    return { quitados: quitados.length };
  }

  // Agrega productos sueltos, un departamento completo o la lista de otra farmacia
  async function agregarALista(usuario, { sucursal_id, producto_ids = [], departamento = '', copiar_de = null } = {}) {
    soloJefe(usuario, 'Solo el jefe arma la lista del inventario');
    const sucursal = await sucursalValida(sucursal_id);
    let ids = idsValidos(producto_ids);
    let origen = '';
    const depto = String(departamento || '').trim();
    if (depto) {
      ids = ids.concat((await productosParaCompleto(depto)).map((p) => Number(p.id)));
      origen = `el departamento ${depto}`;
    }
    if (Number(copiar_de)) {
      const otra = await sucursalValida(copiar_de);
      if (otra.id === sucursal.id) throw new ErrorApp('Elige otra farmacia para copiar su lista');
      ids = ids.concat((await productosDeLista(otra.id)).map((p) => Number(p.id)));
      origen = `la lista de ${otra.nombre}`;
    }
    if (!ids.length) throw new ErrorApp(origen ? `No hay productos en ${origen}` : 'Elige qué productos agregar');
    const r = await agregarIds(usuario, sucursal, ids, origen);
    return { ...r, ...(await lista(usuario, { sucursal_id: sucursal.id })) };
  }

  async function quitarDeLista(usuario, { sucursal_id, producto_ids = [], todo = false } = {}) {
    soloJefe(usuario, 'Solo el jefe arma la lista del inventario');
    const sucursal = await sucursalValida(sucursal_id);
    if (!todo && !idsValidos(producto_ids).length) throw new ErrorApp('Elige qué productos quitar');
    const r = await quitarIds(usuario, sucursal, producto_ids, { todo: Boolean(todo) });
    return { ...r, ...(await lista(usuario, { sucursal_id: sucursal.id })) };
  }

  // En qué listas está un producto (para el interruptor al consultarlo)
  async function listasDeProducto(usuario, productoId) {
    soloJefe(usuario);
    const [sucursales, { data }] = await Promise.all([
      sucursalesActivas(),
      consultar(sb().from('conteo_lista').select('sucursal_id').eq('producto_id', Number(productoId))),
    ]);
    const en = new Set((data || []).map((f) => Number(f.sucursal_id)));
    return { producto_id: Number(productoId), sucursales: sucursales.map((s) => ({ sucursal_id: s.id, sucursal: s.nombre, en_lista: en.has(s.id) })) };
  }

  async function cambiarListaProducto(usuario, { producto_id, sucursal_id, en_lista } = {}) {
    soloJefe(usuario, 'Solo el jefe arma la lista del inventario');
    const sucursal = await sucursalValida(sucursal_id);
    if (en_lista) await agregarIds(usuario, sucursal, [producto_id]);
    else await quitarIds(usuario, sucursal, [producto_id]);
    return listasDeProducto(usuario, producto_id);
  }

  // A qué hora empieza el turno de la tarde en cada farmacia y cuántos productos tiene su lista
  async function configuracion(usuario) {
    soloJefe(usuario);
    const [sucursales, { data }] = await Promise.all([
      sucursalesActivas(),
      consultar(sb().from('conteo_config').select('sucursal_id,hora_tarde')),
    ]);
    const horas = new Map((data || []).map((f) => [Number(f.sucursal_id), horaValida(f.hora_tarde)]));
    const salida = [];
    for (const s of sucursales) {
      salida.push({ sucursal_id: s.id, sucursal: s.nombre, hora_tarde: horas.get(s.id) || HORA_TARDE, productos_en_lista: await cuantosEnLista(s.id) });
    }
    return salida;
  }

  async function guardarConfiguracion(usuario, { sucursal_id, hora_tarde } = {}) {
    soloJefe(usuario);
    const hora = horaValida(hora_tarde);
    if (!hora) throw new ErrorApp('Escribe la hora en que empieza el turno de la tarde, por ejemplo 14:00');
    const s = await sucursalValida(sucursal_id);
    const anterior = (await configDe(s.id)).hora_tarde;
    await consultar(sb().from('conteo_config').upsert({ sucursal_id: s.id, hora_tarde: hora, updated_at: new Date().toISOString() }, { onConflict: 'sucursal_id' }));
    if (anterior !== hora) {
      await anotarCambio({
        usuario, sucursal_id: s.id, tipo: 'conteo_config',
        descripcion: `${s.nombre}: el turno de la tarde del inventario empieza a las ${hora} (antes ${anterior})`,
        detalle: { antes: anterior, despues: hora },
      });
    }
    return configuracion(usuario);
  }

  // ---------- Inicio del jefe ----------
  async function inicio(usuario, { fresco = false } = {}) {
    soloJefe(usuario);
    const hoy = diaDe();
    const [datos, conteosHoy, completos, porAutorizar, alertas, ventas] = await Promise.all([
      datosInventario({ fresco }),
      consultar(sb().from('conteos').select('*').eq('fecha', hoy)),
      consultar(sb().from('conteos').select('*').eq('turno', 'completo').eq('estado', 'abierto')),
      listarConteos(usuario, { estado: 'por_autorizar', limite: 20 }),
      listarCambios(usuario, { grupo: 'alertas', limite: 15 }),
      // Si la central todavía no tiene las ventas, el inicio sale igual sin ellas
      ventasHoy ? ventasHoy().catch(() => null) : null,
    ]);
    const vistos = new Set();
    const conteos = [...(conteosHoy.data || []), ...(completos.data || [])]
      .filter((c) => Number(c.productos) > 0 && !vistos.has(Number(c.id)) && vistos.add(Number(c.id)));
    const detalle = [];
    for (const lote of lotes(idsValidos(conteos.map((c) => c.id)), 40)) {
      detalle.push(...await todas(() => sb().from('conteo_detalle').select('conteo_id,decision,contado,diferencia,costo').in('conteo_id', lote).order('id')));
    }
    const n = await nombres({ sucursales: conteos.map((c) => c.sucursal_id) });
    const resumen = (c) => (c ? conteoParaMostrar(c, detalle.filter((d) => Number(d.conteo_id) === Number(c.id)), n, { conRenglones: false }) : null);
    const sucursales = [];
    for (const s of resumirInventario(datos)) {
      const deLaSucursal = conteos.filter((c) => Number(c.sucursal_id) === s.sucursal_id);
      const deHoy = (turno) => deLaSucursal.find((c) => c.fecha === hoy && turnoDe(c) === turno) || null;
      const turnos = {
        manana: resumen(deHoy('manana')),
        tarde: resumen(deHoy('tarde')),
        completo: resumen(deLaSucursal.find((c) => turnoDe(c) === 'completo' && c.estado === 'abierto')),
        en_lista: await cuantosEnLista(s.sucursal_id),
      };
      sucursales.push({
        ...s,
        ventas_hoy: ventas ? ventas.get(s.sucursal_id) || null : null,
        inventario_hoy: turnos,
        // Lo último de hoy (para las pantallas que solo muestran uno)
        conteo_hoy: turnos.tarde || turnos.manana || resumen(deHoy('dia')),
      });
    }
    return {
      hoy,
      inventario_leido: datos.leido,
      ventas_disponibles: Boolean(ventas),
      sucursales,
      por_autorizar: porAutorizar,
      alertas: alertas.cambios,
    };
  }

  return {
    diaDe,
    inicioDelDia,
    rangoDias,
    filaCambio,
    insertarCambios,
    anotarCambio,
    movimientos: protegido(movimientos),
    filtros: protegido(filtros),
    listarCambios: protegido(listarCambios),
    inventario: protegido(inventario),
    listaInventario: protegido(listaInventario),
    inicio: protegido(inicio),
    conteoDeHoy: protegido(conteoDeHoy),
    contar: protegido(contar),
    anotarMotivo: protegido(anotarMotivo),
    terminar: protegido(terminar),
    listarConteos: protegido(listarConteos),
    cargarConteo: protegido(cargarConteo),
    autorizar: protegido(autorizar),
    configuracion: protegido(configuracion),
    guardarConfiguracion: protegido(guardarConfiguracion),
    lista: protegido(lista),
    agregarALista: protegido(agregarALista),
    quitarDeLista: protegido(quitarDeLista),
    listasDeProducto: protegido(listasDeProducto),
    cambiarListaProducto: protegido(cambiarListaProducto),
    iniciarCompleto: protegido(iniciarCompleto),
    cancelarConteo: protegido(cancelarConteo),
    semana: protegido(semana),
    revisarSemana: protegido(revisarSemana),
  };
}
