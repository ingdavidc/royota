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
const { getBotStatus, logoutBot, restartBot, sendDirectWhatsAppMessage } = require('../services/whatsapp-bot');
const { getDb } = require('../database');

const router = Router();

// Enviar mensaje de WhatsApp a un cliente directamente desde el panel
router.post('/send-message', authRequired, async (req, res) => {
  const { phone, message, complaint_id, status } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone y message son requeridos' });
  }

  try {
    const result = await sendDirectWhatsAppMessage(phone, message);

    // Si viene asociado a un caso de PQRS, actualizar estado y notas
    if (complaint_id) {
      const nowStr = new Date().toISOString();
      const noteEntry = `[WhatsApp ${new Date().toLocaleTimeString('es-CO')}]: ${message}`;

      try {
        const db = getDb();
        db.prepare(`
          UPDATE complaints
          SET admin_notes = CASE WHEN admin_notes IS NULL OR admin_notes = '' THEN ? ELSE admin_notes || '\n' || ? END,
              status = COALESCE(?, status),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(noteEntry, noteEntry, status || 'resolved', complaint_id);
      } catch (_) {}

      try {
        // Actualizar en Firestore para persistencia permanente
        await fetch(`https://firestore.googleapis.com/v1/projects/fichas-royota/databases/(default)/documents/complaints/${complaint_id}?updateMask.fieldPaths=status&updateMask.fieldPaths=admin_notes&updateMask.fieldPaths=updated_at`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              status: { stringValue: status || 'resolved' },
              admin_notes: { stringValue: noteEntry },
              updated_at: { stringValue: nowStr }
            }
          })
        });
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    console.error('[WhatsApp Send Message] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Estado de conexión del Bot y Código QR (Público para fácil visualización)
router.get('/status', (req, res) => {
  res.json(getBotStatus());
});

// Reiniciar bot y forzar generación de nuevo código QR
router.post('/restart', async (req, res) => {
  try {
    const result = await restartBot();
    res.json(result || { success: true, message: 'Bot reiniciado con éxito. Generando código QR...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whatsapp/restart-beacon — Baliza anti-CSP para reiniciar bot y generar QR
router.get('/restart-beacon', async (req, res) => {
  try {
    await restartBot();
  } catch (err) {
    console.error('[WhatsApp] Error restart-beacon:', err.message);
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(pixel);
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

// GET /api/whatsapp/logout-beacon — Baliza anti-CSP para desvincular WhatsApp
router.get('/logout-beacon', async (req, res) => {
  try {
    await logoutBot();
  } catch (err) {
    console.error('[WhatsApp] Error logout-beacon:', err.message);
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(pixel);
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
