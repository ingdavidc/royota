/**
 * src/routes/mikrotik.js — Estado y diagnóstico del router
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const mikrotik = require('../services/mikrotik-api');
const { getDb } = require('../database');

const router = Router();

// GET /api/mikrotik/test — Prueba de conectividad completa
router.get('/test', authRequired, async (req, res) => {
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
router.get('/active', authRequired, async (req, res) => {
  try {
    res.json(await mikrotik.listActiveUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar sesiones: ${err.message}` });
  }
});

// GET /api/mikrotik/sync-log?limit=100 — Log de sincronización
router.get('/sync-log', authRequired, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const logs  = getDb().prepare(`
    SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  res.json(logs);
});

// Memoria en la nube para la cola de aprovisionamiento autónomo
let _pendingRsc = '';

// POST /api/mikrotik/sync/push-batch — Llamado desde royota.dctelematica.com al generar fichas
router.post('/sync/push-batch', (req, res) => {
  const { vouchers, plan } = req.body;
  if (!Array.isArray(vouchers) || !vouchers.length) {
    return res.status(400).json({ error: 'Lista de fichas requerida' });
  }

  const profileName = (plan && plan.name) ? plan.name : '1 Hora Basico';
  const duration = (plan && plan.duration) ? plan.duration : '1h';

  let rscCommands = '\n/ip hotspot user\n';
  vouchers.forEach(code => {
    const clean = String(code).trim().toUpperCase();
    rscCommands += `:do { add name="${clean}" password="${clean}" profile="${profileName}" limit-uptime="${duration}" comment="Royota Cloud" } on-error={}\n`;
  });

  _pendingRsc += rscCommands;
  console.log(`[Cloud-Sync] ${vouchers.length} fichas encoladas para el MikroTik.`);
  res.json({ ok: true, queued: vouchers.length });
});

// GET /api/mikrotik/sync/vouchers.rsc — Descargado autónomamente por el MikroTik en el sitio
router.get('/sync/vouchers.rsc', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  if (!_pendingRsc || _pendingRsc.trim() === '') {
    return res.send('# No pending vouchers\n');
  }
  const toSend = _pendingRsc;
  _pendingRsc = ''; // Limpiar cola una vez entregada al router
  res.send(toSend);
});

module.exports = router;
