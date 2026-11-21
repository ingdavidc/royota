/**
 * src/database.js
 * ─────────────────────────────────────────────────────────────
 * Inicialización y esquema completo de la base de datos SQLite.
 *
 * Utiliza el motor nativo `node:sqlite` de Node.js (v22+) sin
 * requerir compiladores C++ ni paquetes externos en Windows/Linux.
 * Cuenta con fallback a `better-sqlite3` si está instalado.
 */
'use strict';

const path   = require('path');
const fs     = require('fs');
const bcrypt = require('bcryptjs');
const config = require('./config');

const DB_PATH = path.join(__dirname, '..', 'data', 'fichas.db');

let _db = null;

/**
 * Retorna la instancia única de la base de datos.
 * Crea e inicializa el esquema en el primer llamado.
 */
function getDb() {
  if (_db) return _db;

  // Asegurar que el directorio data exista
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 1. Intentar usar node:sqlite nativo (Node 22+)
  let nodeSqlite;
  try {
    nodeSqlite = require('node:sqlite');
  } catch (_) {}

  if (nodeSqlite && nodeSqlite.DatabaseSync) {
    const rawDb = new nodeSqlite.DatabaseSync(DB_PATH);

    // Pragmáticas de rendimiento
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec('PRAGMA foreign_keys = ON;');
    rawDb.exec('PRAGMA synchronous = NORMAL;');
    rawDb.exec('PRAGMA temp_store = MEMORY;');
    rawDb.exec('PRAGMA cache_size = -8000;');

    // Adaptador para compatibilidad total de API
    rawDb.pragma = function (sql) {
      return rawDb.exec('PRAGMA ' + sql + ';');
    };

    rawDb.transaction = function (fn) {
      return function (...args) {
        rawDb.exec('BEGIN');
        try {
          const res = fn(...args);
          rawDb.exec('COMMIT');
          return res;
        } catch (err) {
          rawDb.exec('ROLLBACK');
          throw err;
        }
      };
    };

    _db = rawDb;
  } else {
    // 2. Fallback a better-sqlite3 si está disponible
    const Database = require('better-sqlite3');
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('temp_store = MEMORY');
    _db.pragma('cache_size = -8000');
  }

  _initSchema(_db);
  _seedAdmin(_db);
  _seedSettings(_db);
  _seedKiosks(_db);

  return _db;
}

// ═══════════════════════════════════════════════════════════════
//  ESQUEMA COMPLETO
// ═══════════════════════════════════════════════════════════════
function _initSchema(db) {
  db.exec(`
    -- ── Administradores del sistema ──────────────────────────
    CREATE TABLE IF NOT EXISTS admins (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password    TEXT    NOT NULL,          -- bcrypt hash
      role        TEXT    NOT NULL DEFAULT 'admin'
                          CHECK (role IN ('superadmin','admin','vendedor')),
      full_name   TEXT    DEFAULT '',
      is_active   INTEGER NOT NULL DEFAULT 1,
      last_login  TEXT    DEFAULT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Planes de conexión ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      duration     TEXT    NOT NULL,         -- Formato RouterOS: 30m, 1h, 1d
      speed_limit  TEXT    NOT NULL,         -- Formato RouterOS: 5M/5M (up/down)
      price        REAL    NOT NULL CHECK (price >= 0),
      data_limit   TEXT    DEFAULT NULL,     -- Límite datos: 500M, 1G (NULL = ilimitado)
      shared_users INTEGER NOT NULL DEFAULT 1 CHECK (shared_users >= 1),
      profile_name TEXT    DEFAULT 'default', -- Perfil Hotspot en el router
      description  TEXT    DEFAULT '',
      is_active    INTEGER NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Lotes de generación de fichas ────────────────────────
    CREATE TABLE IF NOT EXISTS voucher_batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id     INTEGER NOT NULL REFERENCES plans(id),
      quantity    INTEGER NOT NULL,
      charset     TEXT    NOT NULL DEFAULT 'full',
      code_length INTEGER NOT NULL DEFAULT 8,
      group_size  INTEGER NOT NULL DEFAULT 0,
      separator   TEXT    NOT NULL DEFAULT '-',
      prefix      TEXT    NOT NULL DEFAULT '',
      note        TEXT    DEFAULT '',
      created_by  INTEGER REFERENCES admins(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Fichas / Vouchers ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS vouchers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      code            TEXT    NOT NULL UNIQUE,
      plan_id         INTEGER NOT NULL REFERENCES plans(id),
      batch_id        INTEGER REFERENCES voucher_batches(id),
      status          TEXT    NOT NULL DEFAULT 'available'
                              CHECK (status IN ('available','sold','active','expired','revoked')),
      sold_at         TEXT    DEFAULT NULL,
      sold_by         INTEGER REFERENCES admins(id),
      activated_at    TEXT    DEFAULT NULL,
      expires_at      TEXT    DEFAULT NULL,      -- Calculado al activar
      buyer_note      TEXT    DEFAULT '',
      payment_method  TEXT    DEFAULT 'efectivo',
      mikrotik_synced INTEGER NOT NULL DEFAULT 0, -- 1 = creado en el router
      mikrotik_id     TEXT    DEFAULT NULL,       -- .id interno del router
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Registro de ventas ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sales (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_id      INTEGER NOT NULL REFERENCES vouchers(id),
      plan_id         INTEGER NOT NULL REFERENCES plans(id),
      amount          REAL    NOT NULL,
      payment_method  TEXT    NOT NULL DEFAULT 'efectivo',
      seller_id       INTEGER REFERENCES admins(id),
      notes           TEXT    DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Log de sincronización con MikroTik ───────────────────
    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      action       TEXT    NOT NULL,          -- create | delete | cleanup
      voucher_code TEXT    DEFAULT NULL,
      batch_id     INTEGER DEFAULT NULL,
      status       TEXT    NOT NULL,          -- success | error | skipped
      http_status  INTEGER DEFAULT NULL,
      response     TEXT    DEFAULT NULL,      -- JSON de respuesta o error
      duration_ms  INTEGER DEFAULT NULL,      -- Tiempo de respuesta del router
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Pagos recibidos por WhatsApp ─────────────────────────
    CREATE TABLE IF NOT EXISTS whatsapp_payments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_number TEXT NOT NULL UNIQUE,
      platform         TEXT NOT NULL,
      sender_phone     TEXT NOT NULL,
      amount           REAL NOT NULL,
      destination      TEXT NOT NULL,
      voucher_id       INTEGER REFERENCES vouchers(id),
      plan_id          INTEGER REFERENCES plans(id),
      raw_analysis     TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Kioskos y Puntos de Venta Físicos (Casetas) ─────────
    CREATE TABLE IF NOT EXISTS kiosks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      location    TEXT    NOT NULL,
      contact     TEXT    DEFAULT '',
      notes       TEXT    DEFAULT '',
      is_active   INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Control de Seguridad y Strikes de WhatsApp ───────────
    CREATE TABLE IF NOT EXISTS whatsapp_strikes (
      phone          TEXT PRIMARY KEY,
      strikes        INTEGER NOT NULL DEFAULT 0,
      blocked_until  TEXT DEFAULT NULL,
      last_reason    TEXT DEFAULT '',
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Quejas, Reclamos y Soporte al Cliente (PQRS) ─────────
    CREATE TABLE IF NOT EXISTS complaints (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT    NOT NULL,
      message     TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'in_progress', 'resolved')),
      admin_notes TEXT    DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT    DEFAULT NULL
    );

    -- ── Configuración y Portal Cautivo ──────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── Índices de rendimiento ────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_vouchers_code      ON vouchers(code);
    CREATE INDEX IF NOT EXISTS idx_vouchers_status    ON vouchers(status);
    CREATE INDEX IF NOT EXISTS idx_vouchers_plan      ON vouchers(plan_id);
    CREATE INDEX IF NOT EXISTS idx_vouchers_batch     ON vouchers(batch_id);
    CREATE INDEX IF NOT EXISTS idx_vouchers_expires   ON vouchers(expires_at) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_sales_date         ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_log_date      ON sync_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_ref       ON whatsapp_payments(reference_number);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_date      ON whatsapp_payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_kiosks_active      ON kiosks(is_active);
    CREATE INDEX IF NOT EXISTS idx_strikes_blocked    ON whatsapp_strikes(blocked_until);
    CREATE INDEX IF NOT EXISTS idx_complaints_status  ON complaints(status);
  `);
}

// ── Seed del admin por defecto ────────────────────────────────
function _seedAdmin(db) {
  const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(config.admin.user);
  if (!exists) {
    const hash = bcrypt.hashSync(config.admin.pass, 10);
    db.prepare(
      'INSERT INTO admins (username, password, role, full_name) VALUES (?, ?, ?, ?)'
    ).run(config.admin.user, hash, 'superadmin', 'Administrador');
    console.log(`[DB] ✅ Admin "${config.admin.user}" creado. Cambia la contraseña al primer login.`);
  }
}

// ── Seed de configuración por defecto (Balneario) ─────────────
function _seedSettings(db) {
  const defaults = {
    business_name:    'Balneario Río Royota',
    business_slogan:  'El paraíso natural junto al río · Conexión WiFi de alta velocidad',
    whatsapp_number:  '573123456789',
    whatsapp_message: '¡Hola! Estoy en el Balneario Río Royota y me interesa comprar una ficha de internet WiFi.',
    info_active:      '1',
    info_badge:       'Avisos & Servicios del Balneario',
    info_title:       '¡Bienvenidos al Balneario Río Royota!',
    info_content:     '🌊 Disfruta de nuestras refrescantes aguas y zonas de descanso.\n🍹 Restaurante, kioscos y bebidas frías disponibles todo el día.\n🎫 Venta de fichas WiFi en Taquilla Principal y Restaurante.\n🌿 Cuidemos el río: utiliza las canecas de basura y evita plásticos en el agua.',
  };

  const insertStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(function () {
    for (const [k, v] of Object.entries(defaults)) {
      insertStmt.run(k, v);
    }
  });
  tx();
}

// ── Seed de Kioskos de venta física por defecto ───────────────
function _seedKiosks(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM kiosks').get().c;
  if (count === 0) {
    const insert = db.prepare(`
      INSERT INTO kiosks (name, location, contact, notes, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(function () {
      insert.run('Taquilla Principal', 'Entrada peatonal del Balneario', 'Recepción', 'Abierto 7:00 AM - 6:00 PM', 1);
      insert.run('Restaurante El Río', 'Frente a las piscinas naturales', 'Caja Restaurante', 'Venta de fichas y bebidas frías', 2);
      insert.run('Kiosko Los Samanes', 'Zona de kioskos y hamacas', 'Encargado Kiosko', 'Venta de fichas en efectivo', 3);
    });
    tx();
  }
}

/** Obtener todas las configuraciones como objeto */
function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

/** Guardar múltiples configuraciones */
function setSettings(newSettings) {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(function () {
    for (const [k, v] of Object.entries(newSettings)) {
      if (v !== undefined && v !== null) {
        stmt.run(k, String(v));
      }
    }
  });
  tx();
  return getSettings();
}

/** Cierra la conexión limpiamente (para tests o shutdown) */
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb, getSettings, setSettings };
