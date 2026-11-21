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

// Listado de números bloqueados o con strikes de seguridad
router.get('/strikes', authRequired, (req, res) => {
  const db = getDb();
  const strikes = db.prepare(`
    SELECT phone, strikes, blocked_until, last_reason, updated_at,
           CASE WHEN blocked_until IS NOT NULL AND datetime(blocked_until) > datetime('now') THEN 1 ELSE 0 END AS is_blocked
    FROM whatsapp_strikes
    ORDER BY is_blocked DESC, updated_at DESC
  `).all();
  res.json(strikes);
});

// Desbloquear número manualmente
router.post('/unblock', authRequired, (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone es requerido' });

  const cleanPhone = String(phone).replace(/\D/g, '');
  const db = getDb();
  db.prepare(`
    UPDATE whatsapp_strikes
    SET strikes = 0, blocked_until = NULL, last_reason = 'Desbloqueado por administrador', updated_at = datetime('now')
    WHERE phone = ?
  `).run(cleanPhone);

  res.json({ message: `Número ${cleanPhone} desbloqueado exitosamente` });
});

module.exports = router;
