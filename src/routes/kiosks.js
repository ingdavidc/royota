/**
 * src/routes/kiosks.js
 * ─────────────────────────────────────────────────────────────
 * Gestión de Kioskos y Puntos de Venta Físicos (Casetas en el Balneario)
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const { getDb } = require('../database');
const { getLiveKiosks, invalidateKiosksCache } = require('../services/whatsapp-bot');

const router = Router();

// GET /api/kiosks — Listar kioskos activos (Público: portal cautivo y bot)
// ?all=true reservado para admins autenticados
router.get('/', async (req, res) => {
  const all = req.query.all === 'true';
  if (!all) {
    try {
      const live = await getLiveKiosks();
      if (live && live.length) {
        return res.json(live);
      }
    } catch (_) {}
  }
  const db = getDb();
  const query = all
    ? 'SELECT * FROM kiosks ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC';
  const kiosks = db.prepare(query).all();
  res.json(kiosks);
});

// POST /api/kiosks/sync — Sincronización explícita desde panel (Autenticado)
router.post('/sync', authRequired, async (req, res) => {
  try {
    invalidateKiosksCache();
    const live = await getLiveKiosks();
    res.json({ message: 'Kioskos sincronizados con éxito desde Firestore', count: live.length, kiosks: live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  `).run(String(name).trim(), String(location).trim(), String(contact).trim(), String(notes).trim(), parseInt(sort_order, 10) || 0);

  invalidateKiosksCache();
  const kiosk = db.prepare('SELECT * FROM kiosks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ message: 'Kiosko creado exitosamente', kiosk });
});

// PUT /api/kiosks/:id — Actualizar kiosko (Admin)
router.put('/:id', authRequired, (req, res) => {
  const { name, location, contact = '', notes = '', sort_order = 0, is_active = 1 } = req.body;
  const { id } = req.params;
  if (!name || !location) {
    return res.status(400).json({ error: 'Nombre y ubicación son obligatorios' });
  }

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
    String(name).trim(),
    String(location).trim(),
    String(contact).trim(),
    String(notes).trim(),
    parseInt(sort_order, 10) || 0,
    is_active ? 1 : 0,
    id
  );

  invalidateKiosksCache();
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
  invalidateKiosksCache();
  res.json({ message: `Kiosko ${newState ? 'activado' : 'desactivado'}`, is_active: newState });
});

// DELETE /api/kiosks/:id — Eliminar kiosko (Admin)
router.delete('/:id', authRequired, (req, res) => {
  const { id } = req.params;
  const db = getDb();
  db.prepare('DELETE FROM kiosks WHERE id = ?').run(id);
  invalidateKiosksCache();
  res.json({ message: 'Kiosko eliminado exitosamente' });
});

module.exports = router;
