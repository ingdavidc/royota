/**
 * src/routes/mikrotik.js — Estado y diagnóstico del router
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const mikrotik = require('../services/mikrotik-api');
const { getDb } = require('../database');

const router = Router();

// Estado de telemetría reportado por el router físico en la nube
let _routerTelemetry = {
  lastSeen: null,
  version: null,
  uptime: null,
  cpuLoad: null,
  freeMemory: null,
  totalMemory: null,
  ip: null,
};

// Sincronización de telemetría hacia Cloud Firestore (para monitoreo sin restricciones de red)
let _lastFirestoreSync = 0;
async function syncTelemetryToFirestore(telem) {
  const now = Date.now();
  if (now - _lastFirestoreSync < 20000) return; // máximo cada 20s
  _lastFirestoreSync = now;

  try {
    const body = {
      fields: {
        status: { stringValue: 'online' },
        version: { stringValue: telem.version ? `${telem.version} (Enlace Nube Activo)` : 'RouterOS v7.25.1 (Enlace Nube Activo)' },
        uptime: { stringValue: telem.uptime || 'Activo' },
        cpuLoad: { integerValue: String(telem.cpuLoad !== null && telem.cpuLoad !== undefined ? telem.cpuLoad : 3) },
        freeMemory: { integerValue: String(telem.freeMemory || 524288000) },
        totalMemory: { integerValue: String(telem.totalMemory || 1073741824) },
        syncMode: { stringValue: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)' },
        lastSeen: { stringValue: telem.lastSeen || new Date().toISOString() }
      }
    };

    await fetch('https://firestore.googleapis.com/v1/projects/fichas-royota/databases/(default)/documents/telemetry/mikrotik', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.warn('[Telemetry-Firestore] Error al sincronizar a Firestore:', err.message);
  }
}

// GET /api/mikrotik/test — Prueba de conectividad completa (Monitoreo para el panel)
router.get('/test', async (req, res) => {
  const now = Date.now();
  const lastSeenMs = _routerTelemetry.lastSeen ? new Date(_routerTelemetry.lastSeen).getTime() : 0;
  const isRouterAlive = (now - lastSeenMs) < 60000;

  if (isRouterAlive) {
    return res.json({
      ok: true,
      routerboard: true,
      version: _routerTelemetry.version + ' (Enlace Nube Activo)',
      uptime: _routerTelemetry.uptime || 'Activo',
      cpuLoad: _routerTelemetry.cpuLoad !== null ? _routerTelemetry.cpuLoad : 2,
      freeMemory: _routerTelemetry.freeMemory || 524288000,
      totalMemory: _routerTelemetry.totalMemory || 1073741824,
      syncMode: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)',
      lastSeen: _routerTelemetry.lastSeen,
    });
  }

  // Fallback a test REST si no hay telemetría reciente
  const result = await mikrotik.testConnection();
  res.status(result.ok ? 200 : 502).json(result);
});

// GET /api/mikrotik/profiles — Listar perfiles Hotspot del router
router.get('/profiles', authRequired, async (req, res) => {
  try {
    const profiles = await mikrotik.listProfiles();
    res.json(Array.isArray(profiles) ? profiles : []);
  } catch (err) {
    res.status(502).json({ error: `Error al consultar perfiles: ${err.message}` });
  }
});

// GET /api/mikrotik/users — Usuarios Hotspot en el router
router.get('/users', authRequired, async (req, res) => {
  try {
    res.json(await mikrotik.listHotspotUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar usuarios: ${err.message}` });
  }
});

// GET /api/mikrotik/active — Sesiones activas ahora
router.get('/active', async (req, res) => {
  try {
    res.json(await mikrotik.listActiveUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar sesiones: ${err.message}` });
  }
});

// GET /api/mikrotik/sync-log?limit=100 — Log de sincronización
router.get('/sync-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const logs  = getDb().prepare(`
    SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  res.json(logs);
});

// Token de seguridad compartido para autenticación autónoma del router MikroTik
const SYNC_SECRET = process.env.MIKROTIK_SYNC_TOKEN || 'RoyotaCloud_SyncToken_2026_SecureKey';

// Expresiones regulares estrictas de validación (Prevención de Inyección de Comandos RouterOS)
const REGEX_CODE     = /^[A-Z0-9]{4,16}$/;
const REGEX_PROFILE  = /^[A-Za-z0-9 _-]{1,32}$/;
const REGEX_DURATION = /^\d+[mhd]$/;

// 1x1 GIF transparente para respuesta de beacon
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /api/mikrotik/sync/beacon — Beacon de sincronización inmune a bloqueos CSP (img-src https:)
router.get('/sync/beacon', (req, res) => {
  const codesParam = req.query.codes || req.query.c;
  if (!codesParam) {
    res.setHeader('Content-Type', 'image/gif');
    return res.end(PIXEL_GIF);
  }

  const rawCodes = String(codesParam).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const planName = req.query.plan || '1 Hora Basico';
  const planDur  = req.query.dur  || '1h';
  const planSpd  = req.query.spd  || '5M/2M';
  const planPrc  = parseInt(req.query.prc, 10) || 2000;

  const db = getDb();
  let insertCount = 0;

  try {
    let planRow = db.prepare('SELECT id, duration, profile_name FROM plans WHERE name = ? COLLATE NOCASE').get(planName);
    if (!planRow) {
      const info = db.prepare(`
        INSERT INTO plans (name, duration, speed_limit, price, profile_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(planName, planDur, planSpd, planPrc, planName);
      planRow = { id: info.lastInsertRowid, duration: planDur, profile_name: planName };
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO vouchers (code, plan_id, status, mikrotik_synced, created_at)
      VALUES (?, ?, 'available', 0, datetime('now'))
    `);

    const transaction = db.transaction((codes) => {
      for (const code of codes) {
        if (REGEX_CODE.test(code)) {
          insertStmt.run(code, planRow.id);
          insertCount++;
        }
      }
    });

    transaction(rawCodes);
    console.log(`[Cloud-Sync Beacon] 📡 ${insertCount} fichas encoladas mediante beacon de alta disponibilidad.`);
  } catch (err) {
    console.error('[Cloud-Sync Beacon] Error persistiendo lote:', err.message);
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(PIXEL_GIF);
});

// POST /api/mikrotik/sync/push-batch — Llamado al generar fichas (Persistente y Sanitizado)
router.post('/sync/push-batch', (req, res) => {
  const { vouchers, plan } = req.body;
  if (!Array.isArray(vouchers) || !vouchers.length) {
    return res.status(400).json({ error: 'Lista de fichas requerida' });
  }

  const rawProfile = (plan && plan.name) ? String(plan.name).trim() : '1 Hora Basico';
  const rawDuration = (plan && plan.duration) ? String(plan.duration).trim() : '1h';

  const profileName = REGEX_PROFILE.test(rawProfile) ? rawProfile : '1 Hora Basico';
  const duration    = REGEX_DURATION.test(rawDuration) ? rawDuration : '1h';

  const db = getDb();
  let insertCount = 0;

  try {
    // Resolver o registrar el plan en SQLite si es necesario
    let planRow = null;
    if (plan && plan.name) {
      planRow = db.prepare('SELECT id, duration, profile_name FROM plans WHERE name = ? COLLATE NOCASE').get(plan.name);
      if (!planRow) {
        const prof = (plan.profile_name || plan.name || '1 Hora Basico');
        const dur  = (plan.duration || '1h');
        const spd  = (plan.speed_limit || '5M/2M');
        const prc  = (plan.price || 2000);
        const info = db.prepare(`
          INSERT INTO plans (name, duration, speed_limit, price, profile_name)
          VALUES (?, ?, ?, ?, ?)
        `).run(plan.name, dur, spd, prc, prof);
        planRow = { id: info.lastInsertRowid, duration: dur, profile_name: prof };
      }
    }
    const resolvedPlanId = planRow ? planRow.id : 1;

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO vouchers (code, plan_id, status, mikrotik_synced, created_at)
      VALUES (?, ?, 'available', 0, datetime('now'))
    `);

    const transaction = db.transaction((codes) => {
      for (const code of codes) {
        const clean = String(code).trim().toUpperCase();
        if (REGEX_CODE.test(clean)) {
          insertStmt.run(clean, resolvedPlanId);
          insertCount++;
        }
      }
    });

    transaction(vouchers);
    console.log(`[Cloud-Sync] 💾 ${insertCount} fichas persistidas en base de datos para sincronización.`);
  } catch (err) {
    console.error('[Cloud-Sync] Error persistiendo lote en SQLite:', err.message);
  }

  res.json({ ok: true, queued: insertCount });
});

// GET /api/mikrotik/sync/clear-all — Vaciar cola de sincronización (Reset de pruebas)
router.get('/sync/clear-all', (req, res) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== SYNC_SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const db = getDb();
  try {
    db.prepare('DELETE FROM vouchers').run();
    db.prepare('DELETE FROM voucher_batches').run();
    console.log('[MikroTik-Sync] 🗑️ Todas las fichas en cola de sincronización fueron eliminadas.');
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mikrotik/sync/vouchers.rsc — Descargado autónomamente por el MikroTik (Autenticado por Token)
router.get('/sync/vouchers.rsc', (req, res) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== SYNC_SECRET) {
    return res.status(403).send('# Error: Acceso no autorizado a la cola de aprovisionamiento\n');
  }

  // 1. Capturar telemetría enviada por el script del MikroTik
  const version = req.query.version || req.query.v;
  const uptime = req.query.uptime || req.query.u;
  const cpu = req.query.cpu || req.query.c;
  const mem = req.query.mem || req.query.m;

  _routerTelemetry = {
    lastSeen: new Date().toISOString(),
    version: version ? `RouterOS ${version}` : (_routerTelemetry.version || 'RouterOS v7.25.1'),
    uptime: uptime ? String(uptime).trim() : (_routerTelemetry.uptime || 'Activo'),
    cpuLoad: cpu !== undefined ? parseInt(cpu, 10) : (_routerTelemetry.cpuLoad || 3),
    freeMemory: mem !== undefined ? parseInt(mem, 10) : (_routerTelemetry.freeMemory || 524288000),
    totalMemory: 1073741824,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
  };

  // Sincronizar telemetría hacia Firestore en segundo plano
  syncTelemetryToFirestore(_routerTelemetry);

  const db = getDb();
  let rscCommands = '';

  // 2. Extraer fichas pendientes en base de datos (Persistente ante reinicios del contenedor)
  try {
    const unsynced = db.prepare(`
      SELECT v.id, v.code, p.name AS plan_name, p.profile_name, p.duration, p.speed_limit
      FROM vouchers v
      LEFT JOIN plans p ON v.plan_id = p.id
      WHERE v.mikrotik_synced = 0
      ORDER BY v.id ASC
      LIMIT 100
    `).all();

    if (unsynced.length > 0) {
      rscCommands += '\n/ip hotspot user\n';
      const idsToMark = [];
      unsynced.forEach(v => {
        const clean = String(v.code).trim().toUpperCase();
        if (REGEX_CODE.test(clean)) {
          const prof = (v.profile_name && REGEX_PROFILE.test(v.profile_name) && v.profile_name !== 'default')
            ? v.profile_name
            : ((v.plan_name && REGEX_PROFILE.test(v.plan_name)) ? v.plan_name : '1 Hora Basico');
          const dur  = (v.duration && REGEX_DURATION.test(v.duration)) ? v.duration : '1h';
          rscCommands += `:do { add name="${clean}" password="${clean}" profile="${prof}" limit-uptime="${dur}" comment="Royota Cloud" } on-error={ :do { add name="${clean}" password="${clean}" profile="default" limit-uptime="${dur}" comment="Royota Cloud" } on-error={} }\n`;
          idsToMark.push(v.id);
        }
      });

      if (idsToMark.length > 0) {
        const placeholders = idsToMark.map(() => '?').join(',');
        db.prepare(`UPDATE vouchers SET mikrotik_synced = 1 WHERE id IN (${placeholders})`).run(...idsToMark);
        console.log(`[Cloud-Sync] 📡 Entregadas ${idsToMark.length} fichas autenticadas al MikroTik (${_routerTelemetry.ip}).`);
      }
    }
  } catch (err) {
    console.error('[Cloud-Sync] Error procesando fichas pendientes:', err.message);
  }

  res.setHeader('Content-Type', 'text/plain');
  if (!rscCommands.trim()) {
    return res.send('# Royota Cloud: No pending vouchers\n');
  }

  res.send(rscCommands);
});

module.exports = router;
