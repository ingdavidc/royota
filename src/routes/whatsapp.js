/**
 * src/routes/whatsapp.js
 * ─────────────────────────────────────────────────────────────
 * Endpoints administrativos para el bot de WhatsApp.
 *
 * GET  /api/whatsapp/status    → Estado de conexión y código QR
 * POST /api/whatsapp/logout    → Cerrar sesión y forzar nuevo QR
 * GET  /api/whatsapp/payments  → Historial de pagos procesados por WhatsApp
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const { getBotStatus, logoutBot } = require('../services/whatsapp-bot');
const { getDb } = require('../database');

const router = Router();

// Estado de conexión del Bot y Código QR (Público para fácil visualización)
router.get('/status', (req, res) => {
  res.json(getBotStatus());
});

// Cerrar sesión y desvincular número
router.post('/logout', authRequired, async (req, res) => {
  try {
    const result = await logoutBot();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historial de comprobantes procesados con IA
router.get('/payments', authRequired, (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;

  const payments = db.prepare(`
    SELECT wp.*, p.name AS plan_name, p.duration AS plan_duration, v.code AS voucher_code
    FROM whatsapp_payments wp
    LEFT JOIN plans p ON wp.plan_id = p.id
    LEFT JOIN vouchers v ON wp.voucher_id = v.id
    ORDER BY wp.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS count FROM whatsapp_payments').get().count;

  res.json({
    payments,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
});

module.exports = router;
