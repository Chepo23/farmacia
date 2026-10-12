require('dotenv').config();

const path = require('path');
const express = require('express');
const { router: authRouter, requiereSesion } = require('./src/auth');
const inventario = require('./src/inventario');
const respaldos = require('./src/respaldos');

const app = express();
app.disable('x-powered-by');
// Con un túnel HTTPS (Tailscale, Cloudflare) el proxy corre en esta misma computadora:
// así Express sabe que la conexión original es segura
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Lector de códigos de barras para la cámara del celular (iPhone no trae uno propio)
app.use('/vendor/zxing', express.static(path.join(__dirname, 'node_modules', '@zxing', 'library', 'umd'), { maxAge: '7d' }));

app.use('/api/auth', authRouter);
app.use('/api/sync', require('./src/routes/sync'));
app.use('/api/config', requiereSesion, require('./src/routes/config'));
app.use('/api/productos', requiereSesion, require('./src/routes/productos'));
app.use('/api/ventas', requiereSesion, require('./src/routes/ventas'));
app.use('/api/clientes', requiereSesion, require('./src/routes/clientes'));
app.use('/api/cortes', requiereSesion, require('./src/routes/cortes'));
app.use('/api/reportes', requiereSesion, require('./src/routes/reportes'));
app.use('/api/admin', requiereSesion, require('./src/routes/admin'));
app.use('/api/departamentos', requiereSesion, require('./src/routes/departamentos'));
app.use('/api/apoyos', requiereSesion, require('./src/routes/apoyos'));
app.use('/api/pedidos', requiereSesion, require('./src/routes/pedidos'));
app.use('/api/celulares', requiereSesion, require('./src/routes/celulares'));
app.use('/api/respaldos', requiereSesion, require('./src/routes/respaldos'));
// Solo para el programa de escritorio, desde esta misma computadora
app.use('/api/sistema', require('./src/routes/sistema'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Errores no controlados: responder JSON en lugar de HTML
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'La solicitud no es válida' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud es demasiado grande' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Un error en una consulta no debe tumbar la caja
process.on('unhandledRejection', (error) => {
  console.error('Error no controlado:', error);
});

const PORT = process.env.PORT || 3000;
// HOST=127.0.0.1: solo esta computadora (el programa de escritorio lo usa así salvo que se permita la red)
const HOST = process.env.HOST || undefined;
const servidor = app.listen(PORT, HOST, () => {
  console.log(`Farmacia POS corriendo en http://localhost:${PORT}`);
  inventario.iniciar();
  respaldos.iniciar();
});
servidor.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso: otro programa (o el sistema abierto dos veces) lo está ocupando.`);
  } else {
    console.error('No se pudo iniciar el servidor:', error.message);
  }
  process.exit(10);
});
