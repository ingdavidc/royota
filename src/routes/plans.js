/**
 * src/routes/plans.js — CRUD completo de planes con validación estricta
 */
'use strict';

const { Router } = require('express');
const { getDb }  = require('../database');
const { authRequired } = require('../middleware/auth');
const { getPlansLive, invalidatePlansCache } = require('../services/firestore-store');

const router = Router();

const NAME_RE      = /^[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ ._-]{1,50}$/;
const PROFILE_RE   = /^[A-Za-z0-9 _.-]{1,32}$/;
const DURATION_RE  = /^\d+[mhd]$/i;
const SPEED_RE     = /^\d+[MkGmkg]\/\d+[MkGmkg]$/;

function validatePlan(body) {
  const { name, duration, speed_limit, price, profile_name, shared_users } = body;
  const cleanName = String(name || '').trim();
  if (!cleanName || !NAME_RE.test(cleanName)) {
    return 'name inválido (máx 50 caracteres alfanuméricos, espacios, guiones o puntos)';
  }
  if (!DURATION_RE.test(String(duration || '').trim())) {
    return 'duration inválido (ej: 30m, 1h, 1d, 7d)';
  }
  if (!SPEED_RE.test(String(speed_limit || '').trim())) {
    return 'speed_limit inválido (ej: 5M/5M)';
  }
  if (price == null || isNaN(price) || Number(price) < 0) {
    return 'price debe ser un número >= 0';
  }
  if (profile_name && !PROFILE_RE.test(String(profile_name).trim())) {
    return 'profile_name inválido';
  }
  if (shared_users !== undefined) {
    const su = parseInt(shared_users, 10);
    if (isNaN(su) || su < 1 || su > 20) return 'shared_users debe estar entre 1 y 20';
  }
  return null;
}

// GET /api/plans — Planes activos (SSOT Firestore -> SQLite fallback)
router.get('/', async (req, res) => {
  try {
    const plans = await getPlansLive({ db: getDb() });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plans/all — Todos los planes (admin)
router.get('/all', authRequired, async (req, res) => {
  try {
    const plans = await getPlansLive({ includeInactive: true, db: getDb() });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plans/:id — Un plan específico
router.get('/:id', authRequired, (req, res) => {
  const plan = getDb().prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan no encontrado' });
  res.json(plan);
});

// POST /api/plans — Crear plan
router.post('/', authRequired, (req, res) => {
  const { name, duration, speed_limit, price, data_limit,
          shared_users, profile_name, description, sort_order } = req.body;

  const err = validatePlan(req.body);
  if (err) return res.status(400).json({ error: err });

  const result = getDb().prepare(`
    INSERT INTO plans (name, duration, speed_limit, price, data_limit,
                       shared_users, profile_name, description, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(name).trim(),
    String(duration).trim().toLowerCase(),
    String(speed_limit).trim(),
    parseFloat(price),
    data_limit ? String(data_limit).trim() : null,
    parseInt(shared_users, 10) || 1,
    (profile_name ? String(profile_name).trim() : 'default') || 'default',
    String(description || '').slice(0, 200),
    parseInt(sort_order, 10) || 0
  );

  invalidatePlansCache();
  res.status(201).json({ id: result.lastInsertRowid, message: 'Plan creado' });
});

// PUT /api/plans/:id — Actualizar plan
router.put('/:id', authRequired, (req, res) => {
  const err = validatePlan(req.body);
  if (err) return res.status(400).json({ error: err });

  const { name, duration, speed_limit, price, data_limit,
          shared_users, profile_name, description, sort_order, is_active } = req.body;

  const changes = getDb().prepare(`
    UPDATE plans SET
      name = ?, duration = ?, speed_limit = ?, price = ?,
      data_limit = ?, shared_users = ?, profile_name = ?,
      description = ?, sort_order = ?, is_active = ?
    WHERE id = ?
  `).run(
    String(name).trim(),
    String(duration).trim().toLowerCase(),
    String(speed_limit).trim(),
    parseFloat(price),
    data_limit ? String(data_limit).trim() : null,
    parseInt(shared_users, 10) || 1,
    (profile_name ? String(profile_name).trim() : 'default') || 'default',
    String(description || '').slice(0, 200),
    parseInt(sort_order, 10) || 0,
    is_active !== undefined ? (is_active ? 1 : 0) : 1,
    req.params.id
  ).changes;

  if (!changes) return res.status(404).json({ error: 'Plan no encontrado' });
  invalidatePlansCache();
  res.json({ message: 'Plan actualizado' });
});

// DELETE /api/plans/:id — Desactivar (soft delete)
router.delete('/:id', authRequired, (req, res) => {
  const changes = getDb().prepare(
    'UPDATE plans SET is_active = 0 WHERE id = ?'
  ).run(req.params.id).changes;

  if (!changes) return res.status(404).json({ error: 'Plan no encontrado' });
  invalidatePlansCache();
  res.json({ message: 'Plan desactivado' });
});

module.exports = router;
