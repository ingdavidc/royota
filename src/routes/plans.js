/**
 * src/routes/plans.js  — CRUD completo de planes
 */
'use strict';

const { Router } = require('express');
const { getDb }  = require('../database');
const { authRequired } = require('../middleware/auth');

const router = Router();

// Expresión regular para validar formato de duración MikroTik
const DURATION_RE  = /^\d+[mhd]$/i;
// Formato velocidad: 5M/5M, 2048k/2048k, etc.
const SPEED_RE     = /^\d+[MkGmkg]\/\d+[MkGmkg]$/;

function validatePlan(body) {
  const { name, duration, speed_limit, price } = body;
  if (!name?.trim())                       return 'name es requerido';
  if (!DURATION_RE.test(duration))         return 'duration inválido (ej: 30m, 1h, 1d, 7d)';
  if (!SPEED_RE.test(speed_limit))         return 'speed_limit inválido (ej: 5M/5M)';
  if (price == null || isNaN(price) || price < 0) return 'price debe ser un número >= 0';
  return null;
}

// GET /api/plans — Planes activos (público: para portal y dropdowns)
router.get('/', (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    'SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order ASC, price ASC'
  ).all());
});

// GET /api/plans/all — Todos los planes (admin)
router.get('/all', authRequired, (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    'SELECT * FROM plans ORDER BY sort_order ASC, price ASC'
  ).all());
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
    name.trim(), duration.toLowerCase(), speed_limit,
    parseFloat(price), data_limit || null,
    parseInt(shared_users, 10) || 1,
    profile_name || 'default',
    description  || '',
    parseInt(sort_order, 10) || 0
  );

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
    name.trim(), duration.toLowerCase(), speed_limit,
    parseFloat(price), data_limit || null,
    parseInt(shared_users, 10) || 1,
    profile_name || 'default',
    description  || '',
    parseInt(sort_order, 10) || 0,
    is_active !== undefined ? (is_active ? 1 : 0) : 1,
    req.params.id
  ).changes;

  if (!changes) return res.status(404).json({ error: 'Plan no encontrado' });
  res.json({ message: 'Plan actualizado' });
});

// DELETE /api/plans/:id — Desactivar (soft delete)
router.delete('/:id', authRequired, (req, res) => {
  const changes = getDb().prepare(
    'UPDATE plans SET is_active = 0 WHERE id = ?'
  ).run(req.params.id).changes;

  if (!changes) return res.status(404).json({ error: 'Plan no encontrado' });
  res.json({ message: 'Plan desactivado' });
});

module.exports = router;
