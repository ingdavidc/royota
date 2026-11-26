/**
 * src/config.js
 * ─────────────────────────────────────────────────────────────
 * Centraliza todas las variables de entorno con validación y
 * valores por defecto seguros.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');

function optional(key, defaultValue) {
  const val = process.env[key];
  return (val && val.trim() !== '') ? val.trim() : defaultValue;
}

const nodeEnv = optional('NODE_ENV', 'development');

// Nunca usar un secreto JWT estático predecible cuando no está configurado
let jwtSecret = optional('JWT_SECRET', '');
if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.includes('dev-secret-inseguro')) {
  jwtSecret = crypto.randomBytes(48).toString('hex');
  if (nodeEnv === 'production') {
    console.error('[Config] ⚠️ JWT_SECRET no configurado o inseguro en producción. Usando clave efímera aleatoria por arranque.');
  }
}

// Evitar contraseña admin por defecto predecible en producción
let adminPass = optional('ADMIN_PASS', '');
let adminPassGenerated = false;
if (!adminPass) {
  if (nodeEnv === 'production') {
    adminPass = crypto.randomBytes(18).toString('base64url');
    adminPassGenerated = true;
  } else {
    adminPass = 'admin123';
  }
}

const config = {
  // ── Servidor ───────────────────────────────────────────────
  port:    parseInt(optional('PORT', '3000'), 10),
  nodeEnv,
  tz:      optional('TZ', 'America/Bogota'),

  // ── Negocio ────────────────────────────────────────────────
  business: {
    name:           optional('BUSINESS_NAME', 'WiFi ROYOTA'),
    currency:       optional('BUSINESS_CURRENCY', 'COP'),
    currencySymbol: optional('BUSINESS_CURRENCY_SYMBOL', '$'),
  },

  // ── JWT ────────────────────────────────────────────────────
  jwt: {
    secret:    jwtSecret,
    expiresIn: optional('JWT_EXPIRES_IN', '10h'),
  },

  // ── CORS ───────────────────────────────────────────────────
  cors: {
    allowedOrigins: optional(
      'CORS_ORIGINS',
      'https://royota.dctelematica.com,http://localhost:3000,http://127.0.0.1:3000'
    ).split(',').map((s) => s.trim()).filter(Boolean),
  },

  // ── Firebase & Auth Admin ──────────────────────────────────
  firebase: {
    projectId:          optional('FIREBASE_PROJECT_ID', 'fichas-royota'),
    serviceAccount:     optional('FIREBASE_SERVICE_ACCOUNT', ''),
    allowedAdminUids:   optional('ALLOWED_ADMIN_UIDS', '2yDqpc64kwQt92PqGOBefC38zA92')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedAdminEmails: optional('ALLOWED_ADMIN_EMAILS', 'ing.david@dctelematica.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  // ── MikroTik REST API & Cloud Sync ─────────────────────────
  mikrotik: {
    mock:          optional('MIKROTIK_MOCK', 'true') === 'true',
    cloudSyncOnly: optional('MIKROTIK_CLOUD_SYNC_ONLY', 'false') === 'true',
    host:          optional('MIKROTIK_HOST', '192.168.88.1'),
    port:      parseInt(optional('MIKROTIK_PORT', '443'), 10),
    user:      optional('MIKROTIK_USER', 'api-fichas'),
    pass:      optional('MIKROTIK_PASS', ''),
    server:    optional('MIKROTIK_HOTSPOT_SERVER', 'hotspot1'),
    useSsl:    optional('MIKROTIK_USE_SSL', 'true') !== 'false',
    verifySsl: optional('MIKROTIK_VERIFY_SSL', 'true') === 'true',
    timeoutMs: parseInt(optional('MIKROTIK_TIMEOUT_MS', '8000'), 10),
    syncToken: optional('MIKROTIK_SYNC_TOKEN', ''),
  },

  // ── Scheduler de limpieza ──────────────────────────────────
  cleanup: {
    cron: optional('CLEANUP_CRON', '*/5 * * * *'),
  },

  // ── Watchdog de Caída del Sitio (Alertas WhatsApp) ─────────
  watchdog: {
    enabled:         optional('ALERT_ENABLED', 'true') === 'true',
    alertPhone:      optional('ALERT_PHONE', '3174251419'),
    offlineMinutes:  Math.max(1, parseInt(optional('ALERT_OFFLINE_MINUTES', '3'), 10) || 3),
    checkIntervalMs: 30_000,
  },

  // ── Admin por defecto ──────────────────────────────────────
  admin: {
    user: optional('ADMIN_USER', 'admin'),
    pass: adminPass,
    generatedBootstrapPass: adminPassGenerated,
  },

  // ── WhatsApp & IA Bot (Automatización de Ventas) ───────────
  whatsapp: {
    enabled:        optional('WHATSAPP_ENABLED', 'true') === 'true',
    geminiApiKey:   optional('GEMINI_API_KEY', ''),
    geminiModel:    optional('GEMINI_MODEL', 'gemini-2.5-flash'),
    paymentPhone:   optional('PAYMENT_PHONE', '3174251419'),
    daviplataPhone: optional('DAVIPLATA_PHONE', '3174251419'),
    brebKey:        optional('BREB_KEY', '3174251419'),
  },
};

module.exports = config;
