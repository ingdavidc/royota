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

module.exports = router;
