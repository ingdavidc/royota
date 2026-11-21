/**
 * src/routes/kiosks.js
 * ─────────────────────────────────────────────────────────────
 * Gestión de Kioskos y Puntos de Venta Físicos (Casetas en el Balneario)
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const { getDb } = require('../database');

const router = Router();

// GET /api/kiosks — Listar kioskos (Público: para portal cautivo, bot y admin)
router.get('/', (req, res) => {
  const db = getDb();
  const all = req.query.all === 'true';
  const query = all
    ? 'SELECT * FROM kiosks ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC';
  const kiosks = db.prepare(query).all();
  res.json(kiosks);
});

// POST /api/kiosks — Crear nuevo kiosko (Admin)
router.post('/', authRequired, (req, res) => {
  const { name, location, contact = '', notes = '', sort_order = 0 } = req.body;
  if (!name || !location) {
    return res.status(400).json({ error: 'Nombre y ubicación son obligatorios' });
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO kiosks (name, location, contact, notes, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), location.trim(), contact.trim(), notes.trim(), parseInt(sort_order, 10) || 0);

  const kiosk = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ message: 'Kiosko creado exitosamente', kiosk });
});

// PUT /api/kiosks/:id — Actualizar kiosko (Admin)
router.put('/:id', authRequired, (req, res) => {
  const { name, location, contact = '', notes = '', sort_order = 0, is_active = 1 } = req.body;
  const { id } = req.params;

  const db = getDb();
  const existing = db.prepare('SELECT id FROM kiosks WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Kiosko no encontrado' });
  }

  db.prepare(`
    UPDATE kiosks
    SET name = ?, location = ?, contact = ?, notes = ?, sort_order = ?, is_active = ?
    WHERE id = ?
  `).run(
    name.trim(),
    location.trim(),
    contact.trim(),
    notes.trim(),
    parseInt(sort_order, 10) || 0,
    is_active ? 1 : 0,
    id
  );

  const updated = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(id);
  res.json({ message: 'Kiosko actualizado', kiosk: updated });
});

// PATCH /api/kiosks/:id/toggle — Activar/desactivar kiosko (Admin)
router.patch('/:id/toggle', authRequired, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const k = db.prepare('SELECT is_active FROM kiosks WHERE id = ?').get(id);
  if (!k) return res.status(404).json({ error: 'Kiosko no encontrado' });

  const newState = k.is_active ? 0 : 1;
  db.prepare('UPDATE kiosks SET is_active = ? WHERE id = ?').run(newState, id);
  res.json({ message: `Kiosko ${newState ? 'activado' : 'desactivado'}`, is_active: newState });
});

// DELETE /api/kiosks/:id — Eliminar kiosko (Admin)
router.delete('/:id', authRequired, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  db.prepare('DELETE FROM kiosks WHERE id = ?').run(id);
  res.json({ message: 'Kiosko eliminado exitosamente' });
});

module.exports = router;
