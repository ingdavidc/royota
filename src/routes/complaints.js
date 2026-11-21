/**
 * src/routes/complaints.js
 * ─────────────────────────────────────────────────────────────
 * Gestión de Peticiones, Quejas, Reclamos y Soporte (PQRS).
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const { getDb } = require('../database');

const router = Router();

// GET /api/complaints — Listar quejas y solicitudes de soporte (Admin)
router.get('/', authRequired, (req, res) => {
  const db = getDb();
  const { status, page = 1, limit = 30 } = req.query;
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

  let where = '';
  const params = [];
  if (status && status !== 'all') {
    where = 'WHERE status = ?';
    params.push(status);
  }

  const complaints = db.prepare(`
    SELECT * FROM complaints
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit, 10), offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM complaints ${where}
  `).get(...params).c;

  const pendingCount = db.prepare(
    "SELECT COUNT(*) AS c FROM complaints WHERE status = 'pending'"
  ).get().c;

  res.json({
    complaints,
    total,
    pending: pendingCount,
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    pages: Math.ceil(total / parseInt(limit, 10)),
  });
});

// PATCH /api/complaints/:id — Resolver o cambiar estado de queja (Admin)
router.patch('/:id', authRequired, (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT id FROM complaints WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Registro no encontrado' });

  const resolvedAt = (status === 'resolved') ? new Date().toISOString() : null;

  db.prepare(`
    UPDATE complaints
    SET status = COALESCE(?, status),
        admin_notes = COALESCE(?, admin_notes),
        resolved_at = ?
    WHERE id = ?
  `).run(status || null, admin_notes !== undefined ? admin_notes : null, resolvedAt, id);

  const updated = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  res.json({ message: 'Queja actualizada', complaint: updated });
});

// DELETE /api/complaints/:id — Eliminar queja (Admin)
router.delete('/:id', authRequired, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  db.prepare('DELETE FROM complaints WHERE id = ?').run(id);
  res.json({ message: 'Registro eliminado' });
});

module.exports = router;
