/**
 * src/server.js — Punto de entrada principal
 * ─────────────────────────────────────────────────────────────
 * Configura y arranca Express con todos los middlewares,
 * rutas y el scheduler de limpieza.
 */
'use strict';

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const config    = require('./config');
const { getDb, getSettings } = require('./database');
const { startCleanupScheduler } = require('./services/cleanup-scheduler');
const { startWhatsAppBot } = require('./services/whatsapp-bot');

const app = express();

// Confiar en 1 proxy inverso (Render / Cloudflare) para que express-rate-limit lea la IP real del cliente
app.set('trust proxy', 1);

// ── Middlewares de seguridad ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: [
        "'self'",
        "https://firestore.googleapis.com",
        "https://*.firebaseio.com",
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://royota-bot.onrender.com",
        "https://royota.dctelematica.com",
      ],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'self'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'", "http://192.168.20.1", "https://royota.dctelematica.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS estricto: solo orígenes autorizados (y peticiones server-to-server sin Origin, ej. MikroTik)
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (config.cors.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origen no permitido por política CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Sync-Token'],
}));

// ── Unificación Arquitectónica: Redirigir accesos web al dominio oficial ──
const OFFICIAL_ADMIN_URL  = 'https://royota.dctelematica.com/admin';
const OFFICIAL_PORTAL_URL = 'https://royota.dctelematica.com';

app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host.includes('onrender.com')) {
    if (req.path === '/admin' || req.path === '/admin.html') {
      return res.redirect(301, OFFICIAL_ADMIN_URL);
    }
    if (req.path === '/login' || req.path === '/login.html') {
      return res.redirect(301, 'https://royota.dctelematica.com/login.html');
    }
    if (req.path === '/' || req.path === '/index.html') {
      return res.redirect(301, OFFICIAL_PORTAL_URL);
    }
  }
  next();
});

// ── Rate Limiting (Protección contra fuerza bruta y DoS) ──────
const voucherLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Por favor espera un momento antes de intentar de nuevo.' },
});

const trialLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de cortesía. Espera unos minutos.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso fallidos. Por seguridad, espera 15 minutos.' },
});

const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de peticiones alcanzado. Espera un momento.' },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));

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
app.use('/api/auth/login',            authLimiter);
app.use('/api/auth/change-password',  authLimiter);
app.use('/api/vouchers/activate',     voucherLimiter);
app.use('/api/vouchers/check',        voucherLimiter);
app.use('/api/vouchers/trial',        trialLimiter);
app.use('/api/mikrotik/bindings',     apiWriteLimiter);
app.use('/api/mikrotik/sync/push-batch',   apiWriteLimiter);
app.use('/api/mikrotik/sync/push-binding', apiWriteLimiter);

// ── Rutas API ─────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/plans',      require('./routes/plans'));
app.use('/api/vouchers',   require('./routes/vouchers'));
app.use('/api/mikrotik',   require('./routes/mikrotik'));
app.use('/api/settings',   require('./routes/settings'));
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
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: 'Origen no autorizado' });
  }
  console.error('[Error Global]', err);
  res.status(err.status || 500).json({
    error: config.nodeEnv === 'production'
      ? 'Error interno del servidor'
      : err.message,
  });
});

// ── Arrancar servidor ─────────────────────────────────────────
function start() {
  try {
    getDb();
    console.log('[DB] ✅ Base de datos lista');
  } catch (err) {
    console.error('[DB] ❌ Error al inicializar:', err.message);
    process.exit(1);
  }

  startCleanupScheduler();
  startWhatsAppBot();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  📶  Hotspot Fichas ROYOTA  — Hardened                  ║
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

    const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || (process.env.NODE_ENV === 'production' ? 'https://royota-bot.onrender.com' : null);
    if (keepAliveUrl) {
      setInterval(async () => {
        try {
          const res = await fetch(`${keepAliveUrl}/api/health`);
          if (res.ok) console.log(`[Keep-Alive] Ping exitoso a ${keepAliveUrl}/api/health`);
        } catch (_) {}
      }, 10 * 60 * 1000);
      console.log(`[Keep-Alive] ✅ Ping automático activo cada 10 min hacia: ${keepAliveUrl}`);
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('SIGTERM', () => { console.log('[Server] SIGTERM recibido, cerrando...'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[Server] SIGINT recibido, cerrando...');  process.exit(0); });

start();
