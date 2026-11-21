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

// Memoria en la nube para cola adicional
let _pendingRsc = '';

// POST /api/mikrotik/sync/push-batch — Llamado al generar fichas
router.post('/sync/push-batch', (req, res) => {
  const { vouchers, plan } = req.body;
  if (!Array.isArray(vouchers) || !vouchers.length) {
    return res.status(400).json({ error: 'Lista de fichas requerida' });
  }

  const profileName = (plan && plan.name) ? plan.name : '1 Hora';
  const duration = (plan && plan.duration) ? plan.duration : '1h';

  let rscCommands = '\n/ip hotspot user\n';
  vouchers.forEach(code => {
    const clean = String(code).trim().toUpperCase();
    rscCommands += `:do { add name="${clean}" password="${clean}" profile="${profileName}" limit-uptime="${duration}" comment="Royota Cloud" } on-error={ :do { add name="${clean}" password="${clean}" profile="default" limit-uptime="${duration}" comment="Royota Cloud" } on-error={} }\n`;
  });

  _pendingRsc += rscCommands;
  console.log(`[Cloud-Sync] ${vouchers.length} fichas encoladas en memoria para el MikroTik.`);
  res.json({ ok: true, queued: vouchers.length });
});

// GET /api/mikrotik/sync/vouchers.rsc — Descargado autónomamente por el MikroTik en el Balneario
router.get('/sync/vouchers.rsc', (req, res) => {
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

  const db = getDb();
  let rscCommands = '';

  // 2. Extraer fichas pendientes en base de datos (tanto de WhatsApp como de lotes creados en Admin)
  try {
    const unsynced = db.prepare(`
      SELECT v.id, v.code, p.name AS profile_name, p.duration, p.speed_limit
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
        const prof = v.profile_name || 'default';
        const dur = v.duration || '1h';
        rscCommands += `:do { add name="${clean}" password="${clean}" profile="${prof}" limit-uptime="${dur}" comment="Royota Cloud" } on-error={ :do { add name="${clean}" password="${clean}" profile="default" limit-uptime="${dur}" comment="Royota Cloud" } on-error={} }\n`;
        idsToMark.push(v.id);
      });

      if (idsToMark.length > 0) {
        const placeholders = idsToMark.map(() => '?').join(',');
        db.prepare(`UPDATE vouchers SET mikrotik_synced = 1 WHERE id IN (${placeholders})`).run(...idsToMark);
        console.log(`[Cloud-Sync] 📡 Entregadas ${idsToMark.length} fichas al MikroTik (${_routerTelemetry.ip}).`);
      }
    }
  } catch (err) {
    console.error('[Cloud-Sync] Error procesando fichas pendientes:', err.message);
  }

  // 3. Agregar comandos de memoria si existían
  if (_pendingRsc && _pendingRsc.trim() !== '') {
    rscCommands += _pendingRsc;
    _pendingRsc = '';
  }

  res.setHeader('Content-Type', 'text/plain');
  if (!rscCommands.trim()) {
    return res.send('# Royota Cloud: No pending vouchers\n');
  }

  res.send(rscCommands);
});

module.exports = router;
