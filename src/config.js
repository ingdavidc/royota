/**
 * src/config.js
 * ─────────────────────────────────────────────────────────────
 * Centraliza todas las variables de entorno con validación y
 * valores por defecto.
 */
'use strict';
require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    throw new Error(`[Config] Variable de entorno obligatoria no definida: ${key}`);
  }
  return val.trim();
}

function optional(key, defaultValue) {
  const val = process.env[key];
  return (val && val.trim() !== '') ? val.trim() : defaultValue;
}

const jwtSecret = optional('JWT_SECRET', 'dev-secret-inseguro-cambiar-en-produccion-123456');

const config = {
  // ── Servidor ───────────────────────────────────────────────
  port:    parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
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

  // ── MikroTik REST API ──────────────────────────────────────
  mikrotik: {
    // Si MIKROTIK_MOCK=true, simula el router sin necesitar el hardware físico
    mock:      optional('MIKROTIK_MOCK', 'true') === 'true',
    host:      optional('MIKROTIK_HOST', '192.168.88.1'),
    port:      parseInt(optional('MIKROTIK_PORT', '443'), 10),
    user:      optional('MIKROTIK_USER', 'admin'),
    pass:      optional('MIKROTIK_PASS', ''),
    server:    optional('MIKROTIK_HOTSPOT_SERVER', 'hotspot1'),
    useSsl:    optional('MIKROTIK_USE_SSL', 'true') !== 'false',
    verifySsl: optional('MIKROTIK_VERIFY_SSL', 'false') === 'true',
    timeoutMs: parseInt(optional('MIKROTIK_TIMEOUT_MS', '8000'), 10),
  },

  // ── Scheduler de expiración continua ──────────────────────
  cleanup: {
    cron: optional('CLEANUP_CRON', '*/5 * * * *'),
  },

  // ── Admin por defecto ──────────────────────────────────────
  admin: {
    user: optional('ADMIN_USER', 'admin'),
    pass: optional('ADMIN_PASS', 'admin123'),
  },

  // ── WhatsApp & IA Bot (Automatización de Ventas) ───────────
  whatsapp: {
    enabled:        optional('WHATSAPP_ENABLED', 'true') === 'true',
    geminiApiKey:   optional('GEMINI_API_KEY', ''),
    geminiModel:    optional('GEMINI_MODEL', 'gemini-1.5-flash'),
    paymentPhone:   optional('PAYMENT_PHONE', '3174251419'),
    daviplataPhone: optional('DAVIPLATA_PHONE', '3174251419'),
    brebKey:        optional('BREB_KEY', '3174251419'),
  },
};

module.exports = config;
