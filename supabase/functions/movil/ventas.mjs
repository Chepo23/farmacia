// Ventas de todas las farmacias para el jefe: lo que cada caja sube a la central (src/subir-ventas.js).
// Reporte de ventas (con la misma forma que el reporte de cada computadora), lo de hoy por sucursal,
// cortes de caja (para consultarlos y reimprimirlos) y clientes con crédito. Lo usan la función del
// celular y el servidor de cada computadora (src/supervision.js). No depende de Deno ni de Node.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const DIA_MS = 86400000;

function idsValidos(ids) {
  return [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function lotes(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

const esJefeVentas = (u) => Boolean(u) && (u.jefe === true || Number(u.jefe) === 1) && u.rol === 'admin' && Number(u.es_central) === 1;

// fechas: diaDe, inicioDelDia y rangoDias de supervision.mjs (la hora de las farmacias)
export function crearVentasCentral({ sb, consultar, ErrorApp, fechas }) {
  function soloJefe(usuario) {
    if (!esJefeVentas(usuario)) throw new ErrorApp('Las ventas de todas las farmacias solo las ve el jefe', { status: 403, codigo: 'SOLO_JEFE' });
  }

  // Sin las tablas nuevas en la central se avisa claro
  const protegido = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      const texto = `${error?.codigo || ''} ${error?.message || ''}`;
      if (/PGRST205|42P01|Could not find the table|does not exist/i.test(texto) && /ventas|cortes|clientes|abonos|cajas|venta_detalle/i.test(texto)) {
        throw new ErrorApp('Falta actualizar la base central para ver las ventas. Avisa a quien instaló el sistema.', { status: 503, codigo: 'FALTA_ACTUALIZAR_CENTRAL' });
      }
      throw error;
    }
  };

  async function todas(construir, { maximo = 200000 } = {}) {
    const filas = [];
    for (let desde = 0; desde < maximo; desde += 1000) {
      const { data } = await consultar(construir().range(desde, desde + 999));
      filas.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return filas;
  }

  async function nombres({ sucursales = [], usuarios = [], cajas = [] }) {
    const mapas = { s: new Map(), u: new Map(), c: new Map() };
    const s = idsValidos(sucursales);
    if (s.length) for (const f of (await consultar(sb().from('sucursales').select('id,nombre').in('id', s))).data || []) mapas.s.set(Number(f.id), f.nombre);
    for (const lote of lotes(idsValidos(usuarios), 150)) {
      for (const f of (await consultar(sb().from('usuarios_central').select('id,nombre').in('id', lote))).data || []) mapas.u.set(Number(f.id), f.nombre);
    }
    const c = idsValidos(cajas);
    if (c.length) for (const f of (await consultar(sb().from('cajas').select('id,numero,sucursal_id').in('id', c))).data || []) mapas.c.set(Number(f.id), f);
    return {
      sucursal: (id) => mapas.s.get(Number(id)) || (id ? `Sucursal ${id}` : ''),
      usuario: (id) => mapas.u.get(Number(id)) || (id ? `Usuario ${id}` : ''),
      caja: (id) => mapas.c.get(Number(id)) || null,
    };
  }

  const sucursalPedida = (filtros) => (filtros.sucursal_id && filtros.sucursal_id !== 'todas' ? Number(filtros.sucursal_id) || null : null);

  // ---------- Reporte de ventas: la misma forma que GET /api/reportes/ventas de cada computadora ----------
  async function reporte(usuario, filtros = {}) {
    soloJefe(usuario);
    const { desde, hasta, inicio, fin } = fechas.rangoDias(filtros.desde, filtros.hasta);
    const sucursal = sucursalPedida(filtros);
    const filtrar = (consulta) => {
      const c = consulta.gte('fecha', inicio).lt('fecha', fin);
      return sucursal ? c.eq('sucursal_id', sucursal) : c;
    };
    const [ventas, detalle, abonos] = await Promise.all([
      todas(() => filtrar(sb().from('ventas').select('id,folio,sucursal_id,caja_id,usuario_id,forma_pago,total,costo,piezas,pago_efectivo,pago_tarjeta,pago_usd,fecha,cancelada,cancelada_por,cancelada_fecha,motivo_cancelacion,cliente_nombre')).order('id')),
      todas(() => filtrar(sb().from('venta_detalle').select('venta_id,producto_id,descripcion,departamento,cantidad,importe,costo_unitario')).order('id')),
      todas(() => filtrar(sb().from('abonos').select('monto')).order('id')),
    ]);
    const canceladas = ventas.filter((v) => v.cancelada);
    const activas = ventas.filter((v) => !v.cancelada);
    const idsCanceladas = new Set(canceladas.map((v) => Number(v.id)));
    const lineas = detalle.filter((d) => !idsCanceladas.has(Number(d.venta_id)));
    const n = await nombres({
      sucursales: ventas.map((v) => v.sucursal_id),
      usuarios: ventas.flatMap((v) => [v.usuario_id, v.cancelada_por]),
      cajas: ventas.map((v) => v.caja_id),
    });
    const suma = (lista, campo) => r2(lista.reduce((t, x) => t + (Number(x[campo]) || 0), 0));
    const agrupar = (lista, clave, nombre) => {
      const grupos = new Map();
      for (const v of lista) {
        const k = clave(v);
        const g = grupos.get(k) || { [nombre]: k, num_ventas: 0, total: 0 };
        g.num_ventas += 1;
        g.total = r2(g.total + Number(v.total));
        grupos.set(k, g);
      }
      return [...grupos.values()];
    };
    const totalVendido = suma(activas, 'total');
    const costo = r2(lineas.reduce((t, d) => t + Number(d.costo_unitario) * Number(d.cantidad), 0));
    const porDepartamento = new Map();
    const porProducto = new Map();
    for (const d of lineas) {
      const departamento = Number(d.producto_id) === 0 ? 'Artículos comunes' : (d.departamento || 'Sin departamento');
      const ganancia = Number(d.importe) - Number(d.costo_unitario) * Number(d.cantidad);
      const g = porDepartamento.get(departamento) || { departamento, cantidad: 0, importe: 0, ganancia: 0 };
      g.cantidad = r3(g.cantidad + Number(d.cantidad));
      g.importe = r2(g.importe + Number(d.importe));
      g.ganancia = r2(g.ganancia + ganancia);
      porDepartamento.set(departamento, g);
      // Los artículos comunes se agrupan por su nombre, no como un solo producto
      const clave = Number(d.producto_id) === 0 ? `c:${d.descripcion}` : `p:${d.producto_id}`;
      const p = porProducto.get(clave) || { descripcion: d.descripcion, cantidad: 0, importe: 0, ganancia: 0 };
      p.cantidad = r3(p.cantidad + Number(d.cantidad));
      p.importe = r2(p.importe + Number(d.importe));
      p.ganancia = r2(p.ganancia + ganancia);
      porProducto.set(clave, p);
    }
    const cajasPorSucursal = new Map();
    for (const v of ventas) {
      const s = Number(v.sucursal_id);
      if (!cajasPorSucursal.has(s)) cajasPorSucursal.set(s, new Set());
      cajasPorSucursal.get(s).add(Number(v.caja_id));
    }
    // El número de caja solo se menciona donde hay más de una
    const caja = (v) => {
      if ((cajasPorSucursal.get(Number(v.sucursal_id)) || new Set()).size < 2) return '';
      const c = n.caja(v.caja_id);
      return c ? `Caja ${c.numero}` : '';
    };
    return {
      fuente: 'central',
      desde,
      hasta,
      num_ventas: activas.length,
      total_vendido: totalVendido,
      efectivo: r2(activas.reduce((t, v) => t + (v.forma_pago === 'efectivo' ? Number(v.total) : v.forma_pago === 'mixto' ? Number(v.pago_efectivo) || 0 : 0), 0)),
      dolares: suma(activas.filter((v) => v.forma_pago === 'dolar'), 'total'),
      usd_recibidos: suma(activas.filter((v) => v.forma_pago === 'dolar'), 'pago_usd'),
      tarjeta: r2(activas.reduce((t, v) => t + (v.forma_pago === 'tarjeta' ? Number(v.total) : v.forma_pago === 'mixto' ? Number(v.pago_tarjeta) || 0 : 0), 0)),
      credito: suma(activas.filter((v) => v.forma_pago === 'credito'), 'total'),
      ganancia: r2(totalVendido - costo),
      costo,
      piezas: r3(lineas.reduce((t, d) => t + Number(d.cantidad), 0)),
      ticket_promedio: activas.length ? r2(totalVendido / activas.length) : 0,
      abonos: { num: abonos.length, total: suma(abonos, 'monto') },
      canceladas: { num: canceladas.length, total: suma(canceladas, 'total') },
      por_dia: agrupar(activas, (v) => fechas.diaDe(new Date(v.fecha)), 'dia').sort((a, b) => a.dia.localeCompare(b.dia)),
      por_sucursal: agrupar(activas, (v) => n.sucursal(v.sucursal_id), 'sucursal').sort((a, b) => b.total - a.total),
      por_cajero: agrupar(activas, (v) => n.usuario(v.usuario_id), 'cajero').sort((a, b) => b.total - a.total),
      por_forma_pago: agrupar(activas, (v) => v.forma_pago, 'forma_pago').sort((a, b) => b.total - a.total),
      por_departamento: [...porDepartamento.values()].sort((a, b) => b.importe - a.importe),
      mas_vendidos: [...porProducto.values()].sort((a, b) => b.cantidad - a.cantidad).slice(0, 20),
      canceladas_detalle: canceladas.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 200).map((v) => ({
        folio: Number(v.folio), caja: caja(v), sucursal: n.sucursal(v.sucursal_id), total: r2(v.total), fecha: v.fecha,
        vendio: n.usuario(v.usuario_id), cancelo: n.usuario(v.cancelada_por), cancelada_fecha: v.cancelada_fecha,
        motivo: v.motivo_cancelacion || '', cliente: v.cliente_nombre || '',
      })),
      ventas_solo_de_esta_computadora: false,
    };
  }

  // ---------- Lo de hoy por sucursal (para el inicio del jefe) ----------
  async function hoyPorSucursal() {
    const hoy = fechas.diaDe();
    const ahora = Date.now();
    const inicioHoy = fechas.inicioDelDia(hoy);
    // El mismo día de la semana pasada, hasta la misma hora: así la comparación es pareja
    const hace7 = fechas.inicioDelDia(fechas.diaDe(new Date(ahora - 7 * DIA_MS)));
    const hastaHace7 = new Date(ahora - 7 * DIA_MS).toISOString();
    const [deHoy, semanaPasada, cortes, clientes] = await Promise.all([
      todas(() => sb().from('ventas').select('sucursal_id,total,costo,cancelada').gte('fecha', inicioHoy).order('id')),
      todas(() => sb().from('ventas').select('sucursal_id,total,cancelada').gte('fecha', hace7).lt('fecha', hastaHace7).order('id')),
      consultar(sb().from('cortes').select('id,sucursal_id,fecha,usuario_id,diferencia,total_vendido').gte('fecha', new Date(ahora - 7 * DIA_MS).toISOString()).order('fecha', { ascending: false }).limit(200)),
      todas(() => sb().from('clientes').select('sucursal_id,saldo').eq('activo', true).gt('saldo', 0).order('id')),
    ]);
    const n = await nombres({ usuarios: (cortes.data || []).map((c) => c.usuario_id) });
    const resumen = new Map();
    const de = (s) => {
      const k = Number(s);
      if (!resumen.has(k)) resumen.set(k, { num_ventas: 0, total: 0, ganancia: 0, canceladas: 0, semana_pasada: 0, ultimo_corte: null, creditos: 0, clientes_con_saldo: 0 });
      return resumen.get(k);
    };
    for (const v of deHoy) {
      const r = de(v.sucursal_id);
      if (v.cancelada) { r.canceladas += 1; continue; }
      r.num_ventas += 1;
      r.total = r2(r.total + Number(v.total));
      r.ganancia = r2(r.ganancia + Number(v.total) - Number(v.costo));
    }
    for (const v of semanaPasada) if (!v.cancelada) de(v.sucursal_id).semana_pasada = r2(de(v.sucursal_id).semana_pasada + Number(v.total));
    for (const c of cortes.data || []) {
      const r = de(c.sucursal_id);
      if (!r.ultimo_corte) r.ultimo_corte = { id: Number(c.id), fecha: c.fecha, diferencia: r2(c.diferencia), total_vendido: r2(c.total_vendido), usuario: n.usuario(c.usuario_id) };
    }
    for (const c of clientes) {
      const r = de(c.sucursal_id);
      r.creditos = r2(r.creditos + Number(c.saldo));
      r.clientes_con_saldo += 1;
    }
    for (const r of resumen.values()) {
      r.ticket_promedio = r.num_ventas ? r2(r.total / r.num_ventas) : 0;
      r.cambio_semana = r.semana_pasada > 0 ? Math.round(((r.total - r.semana_pasada) / r.semana_pasada) * 100) : null;
    }
    return resumen;
  }

  // ---------- Cortes de todas las sucursales ----------
  async function listarCortes(usuario, filtros = {}) {
    soloJefe(usuario);
    const { desde, hasta, inicio, fin } = fechas.rangoDias(filtros.desde, filtros.hasta, { dias: 7 });
    let consulta = sb().from('cortes').select('id,sucursal_id,caja_id,usuario_id,fecha,num_ventas,total_vendido,efectivo_esperado,efectivo_contado,diferencia,num_canceladas,total_canceladas,salidas_efectivo')
      .gte('fecha', inicio).lt('fecha', fin);
    const sucursal = sucursalPedida(filtros);
    if (sucursal) consulta = consulta.eq('sucursal_id', sucursal);
    const filas = (await consultar(consulta.order('fecha', { ascending: false }).limit(300))).data || [];
    const n = await nombres({ sucursales: filas.map((c) => c.sucursal_id), usuarios: filas.map((c) => c.usuario_id), cajas: filas.map((c) => c.caja_id) });
    return {
      desde,
      hasta,
      cortes: filas.map((c) => ({
        id: Number(c.id), fecha: c.fecha, sucursal_id: Number(c.sucursal_id), sucursal: n.sucursal(c.sucursal_id),
        caja: n.caja(c.caja_id) && n.caja(c.caja_id).numero > 1 ? `Caja ${n.caja(c.caja_id).numero}` : '',
        usuario: n.usuario(c.usuario_id), num_ventas: Number(c.num_ventas), total_vendido: r2(c.total_vendido),
        efectivo_esperado: r2(c.efectivo_esperado), efectivo_contado: r2(c.efectivo_contado), diferencia: r2(c.diferencia),
        num_canceladas: Number(c.num_canceladas), total_canceladas: r2(c.total_canceladas), salidas_efectivo: r2(c.salidas_efectivo),
      })),
    };
  }

  async function cargarCorte(usuario, id) {
    soloJefe(usuario);
    const { data } = await consultar(sb().from('cortes').select('*').eq('id', Number(id)).limit(1));
    if (!data || !data.length) throw new ErrorApp('Corte no encontrado', { status: 404 });
    const c = data[0];
    const n = await nombres({ sucursales: [c.sucursal_id], usuarios: [c.usuario_id] });
    // El corte tal como lo imprimió su caja (para verlo y reimprimirlo)
    return { ...(c.detalle || {}), id: Number(c.id), sucursal: n.sucursal(c.sucursal_id), usuario: (c.detalle && c.detalle.usuario) || n.usuario(c.usuario_id) };
  }

  // ---------- Créditos: clientes que deben, en cada farmacia ----------
  async function creditos(usuario, filtros = {}) {
    soloJefe(usuario);
    const sucursal = sucursalPedida(filtros);
    const filas = await todas(() => {
      let c = sb().from('clientes').select('id,sucursal_id,caja_id,nombre,telefono,limite_credito,credito_autorizado,saldo,ultima_compra,ultimo_abono').eq('activo', true).gt('saldo', 0);
      if (sucursal) c = c.eq('sucursal_id', sucursal);
      return c.order('saldo', { ascending: false }).order('id');
    });
    const n = await nombres({ sucursales: filas.map((c) => c.sucursal_id) });
    const porSucursal = new Map();
    for (const c of filas) {
      const k = Number(c.sucursal_id);
      const s = porSucursal.get(k) || { sucursal_id: k, sucursal: n.sucursal(k), clientes: 0, saldo: 0 };
      s.clientes += 1;
      s.saldo = r2(s.saldo + Number(c.saldo));
      porSucursal.set(k, s);
    }
    return {
      total: r2(filas.reduce((t, c) => t + Number(c.saldo), 0)),
      por_sucursal: [...porSucursal.values()].sort((a, b) => b.saldo - a.saldo),
      clientes: filas.slice(0, 500).map((c) => ({
        id: Number(c.id), sucursal_id: Number(c.sucursal_id), sucursal: n.sucursal(c.sucursal_id), nombre: c.nombre, telefono: c.telefono || '',
        saldo: r2(c.saldo), limite_credito: r2(c.limite_credito), excedido: Number(c.limite_credito) > 0 && Number(c.saldo) > Number(c.limite_credito) + 0.005,
        ultima_compra: c.ultima_compra, ultimo_abono: c.ultimo_abono,
      })),
    };
  }

  return {
    reporte: protegido(reporte),
    hoyPorSucursal: protegido(hoyPorSucursal),
    listarCortes: protegido(listarCortes),
    cargarCorte: protegido(cargarCorte),
    creditos: protegido(creditos),
  };
}
