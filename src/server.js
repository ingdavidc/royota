/**
 * src/server.js — Punto de entrada principal
 * ─────────────────────────────────────────────────────────────
 * Configura y arranca Express con todos los middlewares,
 * rutas y el scheduler de limpieza.
 */
'use strict';

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path    = require('path');
const rateLimit = require('express-rate-limit');

const config    = require('./config');
const { getDb, getSettings } = require('./database');
const { startCleanupScheduler } = require('./services/cleanup-scheduler');
const { startWhatsAppBot } = require('./services/whatsapp-bot');

const app = express();

// ── Middlewares de seguridad ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https://*"],
      connectSrc: ["'self'", "https://firestore.googleapis.com", "https://*.firebaseio.com", "https://identitytoolkit.googleapis.com", "https://royota-bot.onrender.com", "https://royota.dctelematica.com"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// CORS: habilitado para permitir comunicación desde el dominio web y local
app.use(cors());

// ── Rate Limiting (Protección contra fuerza bruta y DoS) ──────
const voucherLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,             // máx 10 intentos por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Por favor espera un momento antes de intentar de nuevo.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,                   // máx 5 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso fallidos. Por seguridad, espera 15 minutos.' },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Archivos estáticos ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.nodeEnv === 'production' ? '1h' : '0',
}));

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const db = getDb();
  const dbOk = db.prepare('SELECT 1').get() !== undefined;
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version:   process.env.npm_package_version || '1.0.0',
    env:       config.nodeEnv,
  });
});

// ── Configuración pública (nombre del negocio, moneda) ───────
app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({
    businessName:   s.business_name || config.business.name,
    businessSlogan: s.business_slogan || '',
    currency:       config.business.currency,
    currencySymbol: config.business.currencySymbol,
  });
});

// ── Rate Limiters en endpoints sensibles ──────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/vouchers/activate', voucherLimiter);
app.use('/api/vouchers/check', voucherLimiter);

// ── Rutas API ─────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/plans',    require('./routes/plans'));
app.use('/api/vouchers', require('./routes/vouchers'));
app.use('/api/mikrotik', require('./routes/mikrotik'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/whatsapp',   require('./routes/whatsapp'));
app.use('/api/kiosks',     require('./routes/kiosks'));
app.use('/api/complaints', require('./routes/complaints'));

// ── SPA fallback para el admin ────────────────────────────────
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/login',  (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/print',  (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'print.html')));

// ── 404 para rutas /api no encontradas ───────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Error handler global ─────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Error Global]', err);
  res.status(err.status || 500).json({
    error: config.nodeEnv === 'production'
      ? 'Error interno del servidor'
      : err.message,
  });
});

// ── Arrancar servidor ─────────────────────────────────────────
function start() {
  // Inicializar BD y schema
  try {
    getDb();
    console.log('[DB] ✅ Base de datos lista');
  } catch (err) {
    console.error('[DB] ❌ Error al inicializar:', err.message);
    process.exit(1);
  }

  // Iniciar scheduler de limpieza
  startCleanupScheduler();

  // Iniciar Bot de WhatsApp con IA
  startWhatsAppBot();

  // Escuchar en todas las interfaces (necesario para Docker)
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  📶  Hotspot Fichas ROYOTA  — Fase 1                     ║
╠══════════════════════════════════════════════════════════╣
║  Portal cautivo → http://localhost:${config.port}/              ║
║  Login admin    → http://localhost:${config.port}/login         ║
║  Panel admin    → http://localhost:${config.port}/admin         ║
║  Imprimir       → http://localhost:${config.port}/print         ║
║  API health     → http://localhost:${config.port}/api/health    ║
╠══════════════════════════════════════════════════════════╣
║  Entorno: ${config.nodeEnv.padEnd(44)}║
║  MikroTik: ${config.mikrotik.host}:${config.mikrotik.port} ${config.mikrotik.useSsl ? '(HTTPS)' : '(HTTP) '}${''.padEnd(23)}║
╚══════════════════════════════════════════════════════════╝
    `);

    // Keep-Alive para Render (Evita que el servicio gratuito se duerma por inactividad)
    const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || (process.env.NODE_ENV === 'production' ? 'https://royota-bot.onrender.com' : null);
    if (keepAliveUrl) {
      setInterval(async () => {
        try {
          const res = await fetch(`${keepAliveUrl}/api/health`);
          if (res.ok) console.log(`[Keep-Alive] Ping exitoso a ${keepAliveUrl}/api/health`);
        } catch (_) {}
      }, 10 * 60 * 1000); // Cada 10 minutos
      console.log(`[Keep-Alive] ✅ Ping automático activo cada 10 min hacia: ${keepAliveUrl}`);
    }
  });
}

// Manejar errores no capturados
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// Manejar cierre limpio
process.on('SIGTERM', () => { console.log('[Server] SIGTERM recibido, cerrando...'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[Server] SIGINT recibido, cerrando...');  process.exit(0); });

start();
