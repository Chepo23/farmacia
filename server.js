const path = require('path');
const express = require('express');
const { router: authRouter, requiereSesion } = require('./src/auth');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/productos', requiereSesion, require('./src/routes/productos'));
app.use('/api/ventas', requiereSesion, require('./src/routes/ventas'));
app.use('/api/clientes', requiereSesion, require('./src/routes/clientes'));
app.use('/api/cortes', requiereSesion, require('./src/routes/cortes'));
app.use('/api/reportes', requiereSesion, require('./src/routes/reportes'));
app.use('/api/admin', requiereSesion, require('./src/routes/admin'));
app.use('/api/departamentos', requiereSesion, require('./src/routes/departamentos'));

// Errores no controlados: responder JSON en lugar de HTML
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Farmacia POS corriendo en http://localhost:${PORT}`);
});
