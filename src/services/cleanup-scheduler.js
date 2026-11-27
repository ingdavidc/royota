/**
 * src/services/cleanup-scheduler.js
 * ─────────────────────────────────────────────────────────────
 * Scheduler de limpieza automática de fichas expiradas con bloqueo
 * anti-solapamiento.
 */
'use strict';

const cron     = require('node-cron');
const config   = require('../config');
const { getDb } = require('../database');
const mikrotik = require('./mikrotik-api');
const { isFirestoreQuotaBackoffActive } = require('./firestore-client');

let _task = null;
let _isCleaning = false;
let _lastFirestoreExpireMs = 0;

function startCleanupScheduler() {
  if (_task) return;

  if (!cron.validate(config.cleanup.cron)) {
    console.error(`[Scheduler] Expresión cron inválida: "${config.cleanup.cron}". Usando default.`);
    config.cleanup.cron = '*/15 * * * *';
  }

  console.log(`[Scheduler] ✅ Limpieza programada: "${config.cleanup.cron}"`);

  _task = cron.schedule(config.cleanup.cron, _runCleanup, {
    scheduled: true,
    timezone:  config.tz,
  });
}

async function _runCleanup() {
  if (_isCleaning) {
    console.warn('[Scheduler] Limpieza anterior aún en curso; omitiendo ciclo solapado.');
    return;
  }
  _isCleaning = true;

  try {
    const db = getDb();
    const startTime = Date.now();

    const { isVoucherExpiredSSOT, expireStaleVouchersSSOT } = require('./firestore-store');
    const nowMs = Date.now();
    const shouldCheckFirestore = !isFirestoreQuotaBackoffActive() && (nowMs - _lastFirestoreExpireMs >= 30 * 60 * 1000);
    if (shouldCheckFirestore) {
      _lastFirestoreExpireMs = nowMs;
      await expireStaleVouchersSSOT(db, { skipFirestore: false });
    } else {
      await expireStaleVouchersSSOT(db, { skipFirestore: true });
    }

    const expired = db.prepare(`
      SELECT id, code, activated_at, expires_at, status, mikrotik_synced
      FROM   vouchers
      WHERE  status = 'active'
    `).all().filter((v) => isVoucherExpiredSSOT(v));

    if (!expired.length) return;

    console.log(`[Scheduler] Limpiando ${expired.length} ficha(s) expirada(s)...`);

    for (const v of expired) {
      const t0 = Date.now();
      try {
        if (v.mikrotik_synced && !config.mikrotik.cloudSyncOnly) {
          await mikrotik.kickActiveUser(v.code);
          const mkUser = await mikrotik.findHotspotUser(v.code);
          if (mkUser?.['.id']) {
            await mikrotik.removeHotspotUser(mkUser['.id']);
          }
        }

        db.prepare(`
          UPDATE vouchers SET status = 'expired' WHERE id = ?
        `).run(v.id);

        db.prepare(`
          INSERT INTO sync_log (action, voucher_code, status, response, duration_ms)
          VALUES ('cleanup', ?, 'success', 'Expirada y eliminada del router', ?)
        `).run(v.code, Date.now() - t0);
      } catch (err) {
        console.error(`[Scheduler] Error con ficha ${v.code}:`, err.message);
        db.prepare(`
          INSERT INTO sync_log (action, voucher_code, status, http_status, response, duration_ms)
          VALUES ('cleanup', ?, 'error', ?, ?, ?)
        `).run(v.code, err.httpStatus || 0, err.message, Date.now() - t0);
      }
    }

    console.log(`[Scheduler] Limpieza completada en ${Date.now() - startTime}ms`);
  } finally {
    _isCleaning = false;
  }
}

async function runManualCleanup() {
  await _runCleanup();
}

module.exports = { startCleanupScheduler, runManualCleanup };
