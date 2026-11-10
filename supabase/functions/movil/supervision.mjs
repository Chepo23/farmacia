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
export const PRODUCTOS_POR_DIA = 40;
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
  { clase: 'conteo', prefijos: ['Conteo físico', 'Inventario del día'] },
  { clase: 'recepcion', prefijos: ['Recepción de mercancía'] },
  { clase: 'alta', prefijos: ['Existencia inicial'] },
];
export const TIPOS_MOVIMIENTO = ['venta', 'entrada', 'salida', 'ajuste', 'apoyo', 'conteo', 'cancelacion', 'recepcion', 'alta'];

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
  conteo_terminado: 'Inventario del día terminado',
  conteo_autorizado: 'Ajustes del inventario del día',
  conteo_config: 'Productos por día del inventario',
  conteo_importante: 'Producto importante para contar',
};
export const GRUPOS_CAMBIO = {
  productos: ['producto_alta', 'producto_cambio', 'producto_baja'],
  usuarios: ['usuario_alta', 'usuario_cambio', 'usuario_baja', 'sucursal_alta', 'sucursal_cambio', 'sucursal_baja'],
  caja: ['venta_cancelada', 'corte', 'efectivo_salida', 'efectivo_entrada'],
  apoyos: ['apoyo_enviado', 'apoyo_recibido', 'apoyo_cancelado'],
  cotizaciones: ['cotizacion_creada', 'cotizacion_cancelada'],
  conteos: ['conteo_terminado', 'conteo_autorizado', 'conteo_config', 'conteo_importante'],
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
    ['descripcion', 'descripción', (s) => `"${s}"`, false],
    ['codigo_barras', 'código', (s) => s || 'sin código', false],
    ['departamento', 'departamento', (s) => s || 'sin departamento', false],
  ];
  for (const [campo, nombre, formato, numerico] of campos) {
    const a = antes[campo] ?? null;
    const d = despues[campo] ?? null;
    const iguales = numerico
      ? (a == null) === (d == null) && Math.abs((Number(a) || 0) - (Number(d) || 0)) < 0.005
      : String(a ?? '') === String(d ?? '');
    if (!iguales) lista.push({ campo, antes: a, despues: d, texto: `${nombre} ${formato(a)} → ${formato(d)}` });
  }
  return { lista, texto: lista.map((c) => c.texto).join(', '), precio: lista.some((c) => c.campo === 'precio_venta') };
}

// ---------- Inventario del día ----------
export const RAZONES_CONTEO = {
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

  // ---------- Inventario del día ----------
  async function cuotaDe(sucursalId) {
    const { data } = await consultar(sb().from('conteo_config').select('productos_por_dia').eq('sucursal_id', sucursalId).limit(1));
    return data && data[0] ? Number(data[0].productos_por_dia) || PRODUCTOS_POR_DIA : PRODUCTOS_POR_DIA;
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

  // La lista del día. Prioridad: existencia negativa, lo que no cuadró la última vez y lo marcado
  // como importante (entre los tres, a lo mucho 3/4 de la lista); el resto, mitad lo que se movió
  // desde su último conteo y mitad lo que lleva más tiempo sin contarse, para que todo pase por turno.
  async function armarLista(sucursalId, cuota, hoy) {
    const [productos, filas, ultimos, importantes] = await Promise.all([
      todas(() => sb().from('productos').select('id,codigo_barras,descripcion,departamento,precio_costo').eq('activo', true).eq('usa_inventario', true).order('id')),
      todas(() => sb().from('inventario').select('producto_id,existencia,updated_at').eq('sucursal_id', sucursalId).order('id')),
      todas(() => sb().from('conteo_ultimos').select('producto_id,contado,diferencia').eq('sucursal_id', sucursalId).order('producto_id')),
      todas(() => sb().from('conteo_importantes').select('producto_id').order('producto_id')),
    ]);
    const porId = new Map(productos.filter((p) => Number(p.id) > 0).map((p) => [Number(p.id), p]));
    const ultimo = new Map(ultimos.map((u) => [Number(u.producto_id), u]));
    const marcados = new Set(importantes.map((i) => Number(i.producto_id)));
    const inicioHoy = new Date(inicioDelDia(hoy)).getTime();
    const ahora = Date.now();

    const candidatos = [];
    for (const f of filas) {
      const p = porId.get(Number(f.producto_id));
      if (!p) continue;
      const u = ultimo.get(Number(p.id));
      const contadoMs = u ? new Date(u.contado).getTime() : null;
      if (contadoMs !== null && contadoMs >= inicioHoy) continue; // ya se contó hoy
      const movidoMs = f.updated_at ? new Date(f.updated_at).getTime() : 0;
      const existencia = r2(f.existencia);
      candidatos.push({
        producto: p,
        existencia,
        contadoMs,
        diferencia: u ? r2(u.diferencia) : 0,
        movido: contadoMs === null ? ahora - movidoMs < 30 * DIA_MS : movidoMs > contadoMs,
        valor: Math.max(0, existencia) * (Number(p.precio_costo) || 0),
        importante: marcados.has(Number(p.id)),
      });
    }

    const elegidos = new Map();
    const tomar = (lista, razon, maximo = Infinity) => {
      let tomados = 0;
      for (const c of lista) {
        if (elegidos.size >= cuota || tomados >= maximo) break;
        const id = Number(c.producto.id);
        if (elegidos.has(id)) continue;
        elegidos.set(id, { ...c, razon: typeof razon === 'function' ? razon(c) : razon });
        tomados += 1;
      }
      return tomados;
    };
    // Primero lo que lleva más tiempo sin contarse (lo nunca contado antes que todo); a igual tiempo, lo de más valor
    const porAntiguedad = (a, b) => (a.contadoMs ?? -Infinity) - (b.contadoMs ?? -Infinity) || b.valor - a.valor;
    const hace7Dias = ahora - 7 * DIA_MS;

    let cupo = Math.ceil(cuota * 0.75);
    cupo -= tomar(candidatos.filter((c) => c.existencia < -EPS).sort(porAntiguedad), 'negativo', cupo);
    cupo -= tomar(candidatos.filter((c) => Math.abs(c.diferencia) > EPS).sort(porAntiguedad), 'diferencia', cupo);
    tomar(
      candidatos.filter((c) => c.importante && (c.contadoMs === null || c.contadoMs < hace7Dias)).sort(porAntiguedad),
      'importante',
      Math.min(cupo, Math.ceil(cuota / 2))
    );
    const movidos = candidatos.filter((c) => c.movido).sort(porAntiguedad);
    tomar(movidos, (c) => (c.contadoMs === null ? 'nunca' : 'movimiento'), Math.ceil((cuota - elegidos.size) / 2));
    tomar([...candidatos].sort(porAntiguedad), (c) => (c.contadoMs === null ? 'nunca' : 'turno'));

    // Por departamento y nombre, para recorrer los estantes en orden
    return [...elegidos.values()]
      .sort((a, b) => (a.producto.departamento || '￿').localeCompare(b.producto.departamento || '￿', 'es')
        || a.producto.descripcion.localeCompare(b.producto.descripcion, 'es'))
      .map((c, i) => ({
        sucursal_id: sucursalId,
        producto_id: Number(c.producto.id),
        codigo_barras: c.producto.codigo_barras || null,
        descripcion: c.producto.descripcion,
        departamento: c.producto.departamento || '',
        orden: i + 1,
        razon: c.razon,
        costo: r2(c.producto.precio_costo),
        decision: 'pendiente',
      }));
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
    return {
      productos: renglones.length,
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

  // Termina un conteo: lo que no se contó queda como "no contado" y, si hay diferencias, pasa a autorizar
  async function finalizar(c, usuario, { automatico = false } = {}) {
    const ahora = new Date().toISOString();
    await consultar(
      sb().from('conteo_detalle').update({ decision: 'no_contado' }).eq('conteo_id', Number(c.id)).is('contado', null).eq('decision', 'pendiente')
    );
    const renglones = await renglonesDe(c.id);
    const t = totales(renglones);
    const estado = t.por_autorizar > 0 ? 'por_autorizar' : 'cerrado';
    const cambios = {
      estado,
      productos: t.productos,
      contados: t.contados,
      sin_diferencia: t.sin_diferencia,
      terminado: ahora,
      terminado_por: usuario ? Number(usuario.id) : null,
      updated_at: ahora,
    };
    if (automatico) cambios.nota = t.contados ? 'Se cerró solo al día siguiente' : 'Nadie lo contó';
    if (estado === 'cerrado') cambios.cerrado = ahora;
    const { data } = await consultar(sb().from('conteos').update(cambios).eq('id', Number(c.id)).eq('estado', 'abierto').select('*'));
    if (!data || !data.length) return null; // alguien más lo terminó al mismo tiempo
    if (t.contados) {
      const n = await nombres({ sucursales: [c.sucursal_id] });
      await anotarCambio({
        usuario,
        sucursal_id: c.sucursal_id,
        tipo: 'conteo_terminado',
        descripcion: `${n.sucursal(c.sucursal_id)}: ${t.sin_diferencia} de ${t.contados} productos cuadraron`
          + `${t.con_diferencia ? `; ${t.con_diferencia} con diferencia (faltan $${t.faltante.toFixed(2)}, sobran $${t.sobrante.toFixed(2)})` : ''}`
          + `${t.productos > t.contados ? `; ${t.productos - t.contados} sin contar` : ''}${automatico ? ' (se cerró solo)' : ''}`,
        detalle: { conteo_id: Number(c.id), fecha: c.fecha, ...t },
        alerta: t.faltante >= 200,
      });
    }
    return data[0];
  }

  // Los conteos de días anteriores que se quedaron abiertos se cierran solos
  async function cerrarAnteriores(sucursalId, hoy) {
    const { data } = await consultar(
      sb().from('conteos').select('*').eq('sucursal_id', sucursalId).eq('estado', 'abierto').lt('fecha', hoy).limit(20)
    );
    for (const c of data || []) await finalizar(c, null, { automatico: true });
  }

  // La lista de hoy de la sucursal; si todavía no existe, se arma. Solo una computadora o celular la
  // arma a la vez: se "aparta" poniendo productos = -1 mientras se elige.
  async function conteoDeHoy(usuario, { sucursal_id } = {}) {
    const sucursalId = await sucursalDelConteo(usuario, sucursal_id);
    const hoy = diaDe();
    await cerrarAnteriores(sucursalId, hoy);
    const buscar = async () => {
      const { data } = await consultar(sb().from('conteos').select('*').eq('sucursal_id', sucursalId).eq('fecha', hoy).limit(1));
      return data && data[0] ? data[0] : null;
    };
    let c = await buscar();
    if (!c) {
      try {
        await consultar(sb().from('conteos').insert({ sucursal_id: sucursalId, fecha: hoy, estado: 'abierto', productos: 0 }).select('id'));
      } catch (error) {
        if (error.codigo !== '23505') throw error; // otro la creó al mismo tiempo
      }
      c = await buscar();
    }
    for (let intento = 0; intento < 4 && c.estado === 'abierto' && Number(c.productos) <= 0; intento += 1) {
      const libre = Number(c.productos) === 0;
      // Si quien la apartó se quedó a medias (se fue el internet), después de un minuto otro la arma
      const atorada = !libre && new Date(c.updated_at).getTime() < Date.now() - 60000;
      if (libre || atorada) {
        let apartar = sb().from('conteos').update({ productos: -1, updated_at: new Date().toISOString() }).eq('id', Number(c.id));
        apartar = libre ? apartar.eq('productos', 0) : apartar.eq('productos', -1).lt('updated_at', new Date(Date.now() - 60000).toISOString());
        const { data: apartado } = await consultar(apartar.select('id'));
        if (apartado && apartado.length) {
          let lista = [];
          try {
            lista = await armarLista(sucursalId, await cuotaDe(sucursalId), hoy);
            if (lista.length) {
              await consultar(sb().from('conteo_detalle').upsert(lista.map((r) => ({ ...r, conteo_id: Number(c.id) })), { onConflict: 'conteo_id,producto_id', ignoreDuplicates: true }));
            }
          } finally {
            await consultar(sb().from('conteos').update({ productos: lista.length, updated_at: new Date().toISOString() }).eq('id', Number(c.id)));
          }
          c = await buscar();
          break;
        }
      }
      await esperar(1200); // otro la está armando
      c = await buscar();
    }
    return mostrarConteo(c, usuario);
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
    if (!data || !data.length) throw new ErrorApp('Ese producto no está en la lista de hoy', { status: 404 });
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
    if (!renglones.length) throw new ErrorApp('La lista de hoy no tiene productos');
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
    if (['abierto', 'por_autorizar', 'cerrado'].includes(filtros.estado)) consulta = consulta.eq('estado', filtros.estado);
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
        nota: `Inventario del día ${dia}: el sistema tenía ${r2(r.existencia_sistema)} y se contaron ${r2(r.contado)}${r.motivo ? ` (${r.motivo})` : ''}`,
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
      descripcion: `${n.sucursal(c.sucursal_id)}, inventario del ${c.fecha}: ${aprobados.length} ajuste(s) aprobado(s) ($${valor(aprobados).toFixed(2)})`
        + `${rechazados.length ? ` y ${rechazados.length} rechazado(s)` : ''}`,
      detalle: {
        conteo_id: Number(c.id),
        aprobados: aprobados.map((r) => ({ producto: r.descripcion, sistema: r2(r.existencia_sistema), contado: r2(r.contado), diferencia: r2(r.diferencia) })),
        rechazados: rechazados.map((r) => ({ producto: r.descripcion, sistema: r2(r.existencia_sistema), contado: r2(r.contado), diferencia: r2(r.diferencia) })),
      },
    });
    return mostrarConteo(await conteoPorId(c.id), usuario, { renglones: restantes });
  }

  async function configuracion(usuario) {
    soloJefe(usuario);
    const [sucursales, { data }] = await Promise.all([
      sucursalesActivas(),
      consultar(sb().from('conteo_config').select('sucursal_id,productos_por_dia')),
    ]);
    const cuotas = new Map((data || []).map((f) => [Number(f.sucursal_id), Number(f.productos_por_dia)]));
    return sucursales.map((s) => ({ sucursal_id: s.id, sucursal: s.nombre, productos_por_dia: cuotas.get(s.id) || PRODUCTOS_POR_DIA }));
  }

  async function guardarConfiguracion(usuario, { sucursal_id, productos_por_dia } = {}) {
    soloJefe(usuario);
    const sucursal = Number(sucursal_id);
    const cuota = Math.round(Number(productos_por_dia));
    if (!(cuota >= 5 && cuota <= 500)) throw new ErrorApp('Escribe de 5 a 500 productos por día');
    const s = (await sucursalesActivas()).find((x) => x.id === sucursal);
    if (!s) throw new ErrorApp('Sucursal no válida');
    const anterior = await cuotaDe(sucursal);
    await consultar(sb().from('conteo_config').upsert({ sucursal_id: sucursal, productos_por_dia: cuota, updated_at: new Date().toISOString() }, { onConflict: 'sucursal_id' }));
    if (anterior !== cuota) {
      await anotarCambio({
        usuario, sucursal_id: sucursal, tipo: 'conteo_config',
        descripcion: `${s.nombre}: el inventario del día pasa de ${anterior} a ${cuota} productos (desde mañana)`,
        detalle: { antes: anterior, despues: cuota },
      });
    }
    return configuracion(usuario);
  }

  async function esImportante(productoId) {
    const { data } = await consultar(sb().from('conteo_importantes').select('producto_id').eq('producto_id', Number(productoId)).limit(1));
    return Boolean(data && data.length);
  }

  async function marcarImportante(usuario, { producto_id, importante } = {}) {
    soloJefe(usuario);
    const id = Number(producto_id);
    const { data: productos } = await consultar(sb().from('productos').select('id,descripcion').eq('id', id).limit(1));
    if (!productos || !productos.length) throw new ErrorApp('Producto no encontrado', { status: 404 });
    const antes = await esImportante(id);
    const marcar = Boolean(importante);
    if (marcar && !antes) {
      await consultar(sb().from('conteo_importantes').upsert({ producto_id: id, creado_por: Number(usuario.id) }, { onConflict: 'producto_id', ignoreDuplicates: true }));
    } else if (!marcar && antes) {
      await consultar(sb().from('conteo_importantes').delete().eq('producto_id', id));
    }
    if (marcar !== antes) {
      await anotarCambio({
        usuario, tipo: 'conteo_importante',
        descripcion: `${productos[0].descripcion}: ${marcar ? 'se contará seguido en el inventario del día' : 'vuelve a contarse por turno'}`,
        detalle: { producto_id: id, importante: marcar },
      });
    }
    return { producto_id: id, importante: marcar };
  }

  // ---------- Inicio del jefe ----------
  async function inicio(usuario, { fresco = false } = {}) {
    soloJefe(usuario);
    const hoy = diaDe();
    const [datos, conteosHoy, porAutorizar, alertas, ventas] = await Promise.all([
      datosInventario({ fresco }),
      consultar(sb().from('conteos').select('*').eq('fecha', hoy)),
      listarConteos(usuario, { estado: 'por_autorizar', limite: 20 }),
      listarCambios(usuario, { grupo: 'alertas', limite: 15 }),
      // Si la central todavía no tiene las ventas, el inicio sale igual sin ellas
      ventasHoy ? ventasHoy().catch(() => null) : null,
    ]);
    const deHoy = conteosHoy.data || [];
    const detalle = [];
    for (const lote of lotes(idsValidos(deHoy.map((c) => c.id)), 40)) {
      detalle.push(...await todas(() => sb().from('conteo_detalle').select('conteo_id,decision,contado,diferencia,costo').in('conteo_id', lote).order('id')));
    }
    const n = await nombres({ sucursales: deHoy.map((c) => c.sucursal_id) });
    return {
      hoy,
      inventario_leido: datos.leido,
      ventas_disponibles: Boolean(ventas),
      sucursales: resumirInventario(datos).map((s) => {
        const c = deHoy.find((x) => Number(x.sucursal_id) === s.sucursal_id);
        const ventas_hoy = ventas ? ventas.get(s.sucursal_id) || null : null;
        if (!c || Number(c.productos) <= 0) return { ...s, ventas_hoy, conteo_hoy: null };
        return { ...s, ventas_hoy, conteo_hoy: conteoParaMostrar(c, detalle.filter((d) => Number(d.conteo_id) === Number(c.id)), n, { conRenglones: false }) };
      }),
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
    esImportante: protegido(esImportante),
    marcarImportante: protegido(marcarImportante),
  };
}
