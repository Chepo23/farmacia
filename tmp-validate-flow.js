const base = 'http://localhost:3000';

async function request(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function login(usuario, password) {
  const res = await request(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, password })
  });
  const cookie = res.headers.get('set-cookie') || '';
  return {
    status: res.status,
    cookie: cookie.split(';')[0] || '',
    body: res.body
  };
}

(async () => {
  const admin = await login('admin', 'admin');
  if (admin.status !== 200) throw new Error('admin login failed');

  const sucursal = await request(base + '/api/admin/sucursales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ nombre: 'Sucursal Validate Final', direccion: 'Av. Validate Final', telefono: '5551114444' })
  });
  console.log('SUCURSAL', sucursal.status, JSON.stringify(sucursal.body));
  const sucursalId = sucursal.body.id;

  const user = await request(base + '/api/admin/usuarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ nombre: 'Usuario Validate Final', usuario: 'validfinal', password: '123456', rol: 'cajero', sucursal_id: sucursalId })
  });
  console.log('USER', user.status, JSON.stringify(user.body));

  const branch = await login('validfinal', '123456');
  if (branch.status !== 200) throw new Error('branch login failed');

  const pedidoOpen = await request(base + '/api/pedidos', {
    method: 'POST',
    headers: { Cookie: branch.cookie }
  });
  console.log('PEDIDO_OPEN', pedidoOpen.status, JSON.stringify(pedidoOpen.body));
  const pedidoId = pedidoOpen.body.id;

  const add = await request(base + '/api/pedidos/' + pedidoId + '/renglones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: branch.cookie },
    body: JSON.stringify({ producto_id: 1, cantidad: 3 })
  });
  console.log('PEDIDO_ADD', add.status, JSON.stringify(add.body));

  const sendPedido = await request(base + '/api/pedidos/' + pedidoId + '/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: branch.cookie },
    body: JSON.stringify({ nota: 'Pedido validate final' })
  });
  console.log('PEDIDO_SEND', sendPedido.status, JSON.stringify(sendPedido.body));

  const centralSession = await login('admin', 'admin');
  const stock = await request(base + '/api/productos/1/inventario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: centralSession.cookie },
    body: JSON.stringify({ tipo: 'entrada', cantidad: 50, nota: 'Stock central para validación final' })
  });
  console.log('INVENTARIO_ADD', stock.status, JSON.stringify(stock.body));

  const apoyo = await request(base + '/api/apoyos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: centralSession.cookie },
    body: JSON.stringify({ destino_id: sucursalId, pedido_id: pedidoId })
  });
  console.log('APOYO_CREATE', apoyo.status, JSON.stringify(apoyo.body));
  const apoyoId = apoyo.body.id;

  const sendApoyo = await request(base + '/api/apoyos/' + apoyoId + '/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: centralSession.cookie },
    body: JSON.stringify({ nota: 'Envío validate final' })
  });
  console.log('APOYO_SEND', sendApoyo.status, JSON.stringify(sendApoyo.body));

  const branch2 = await login('validfinal', '123456');
  const receive = await request(base + '/api/apoyos/' + apoyoId + '/recibir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: branch2.cookie },
    body: JSON.stringify({ renglones: [{ id: sendApoyo.body.renglones[0].id, cantidad_recibida: 3 }] })
  });
  console.log('APOYO_RECEIVE', receive.status, JSON.stringify(receive.body));
})();
