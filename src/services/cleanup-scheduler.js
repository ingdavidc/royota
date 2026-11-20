/**
 * src/services/cleanup-scheduler.js
 * ─────────────────────────────────────────────────────────────
 * Scheduler de limpieza automática de fichas expiradas.
 *
 * Funciona con cron (node-cron). En cada ejecución:
 *  1. Busca fichas activas cuyo expires_at ya pasó
 *  2. Intenta eliminar cada usuario del router MikroTik
 *  3. Marca la ficha como 'expired' en la BD
 *  4. Registra el resultado en sync_log
 */
'use strict';

const cron     = require('node-cron');
const config   = require('../config');
const { getDb } = require('../database');
const mikrotik = require('./mikrotik-api');

let _task = null;

function startCleanupScheduler() {
  if (_task) return; // Evitar doble arranque

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
  const db = getDb();
  const startTime = Date.now();

  const expired = db.prepare(`
    SELECT id, code, mikrotik_synced
    FROM   vouchers
    WHERE  status = 'active'
      AND  expires_at IS NOT NULL
      AND  expires_at <= datetime('now')
  `).all();

  if (!expired.length) return;

  console.log(`[Scheduler] Limpiando ${expired.length} ficha(s) expirada(s)...`);

  for (const v of expired) {
    const t0 = Date.now();
    try {
      // Intentar eliminar del router (solo si fue creado allí)
      if (v.mikrotik_synced) {
        // 1. Expulsar cualquier sesión activa de inmediato
        await mikrotik.kickActiveUser(v.code);

        // 2. Eliminar usuario de /ip/hotspot/user
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
}

// Exponer función para limpieza manual (desde ruta admin)
async function runManualCleanup() {
  await _runCleanup();
}

module.exports = { startCleanupScheduler, runManualCleanup };
