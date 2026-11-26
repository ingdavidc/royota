/**
 * src/routes/vouchers.js
 * ─────────────────────────────────────────────────────────────
 * Rutas completas de gestión de fichas (vouchers) con protección
 * atómica anti-TOCTOU y validación de MAC/cortesías.
 */
'use strict';

const { Router } = require('express');
const config     = require('../config');
const { getDb }  = require('../database');
const { authRequired }   = require('../middleware/auth');
const mikrotik           = require('../services/mikrotik-api');
const { generateBatch, listBatches, getBatchVouchers, CHARSETS } = require('../services/voucher-generator');
const { parseDurationMs, getBogotaDateStr, getBogotaMidnightMs } = require('../utils/helpers');

const router = Router();
const _activatingCodes = new Set();
const REGEX_MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const REGEX_CODE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;

// ── GENERAR LOTE DE FICHAS ────────────────────────────────────
router.post('/generate', authRequired, async (req, res) => {
  const {
    plan_id,
    quantity    = 10,
    code_length = 8,
    charset     = 'full',
    group_size  = 0,
    separator   = '-',
    prefix      = '',
    note        = '',
  } = req.body;

  if (!plan_id) {
    return res.status(400).json({ error: 'plan_id es requerido' });
  }

  try {
    const result = await generateBatch({
      planId:     plan_id,
      quantity:   parseInt(quantity, 10),
      codeLength: parseInt(code_length, 10),
      charset,
      groupSize:  parseInt(group_size, 10),
      separator,
      prefix:     String(prefix || '').toUpperCase(),
      batchNote:  note,
    });

    if (req.admin.id) {
      getDb().prepare(
        'UPDATE voucher_batches SET created_by = ? WHERE id = ?'
      ).run(req.admin.id, result.batchId);
    }

    res.status(201).json({
      message:   `${result.generated} fichas generadas exitosamente`,
      batch_id:  result.batchId,
      plan:      result.plan,
      codes:     result.codes,
      generated: result.generated,
    });
  } catch (err) {
    console.error('[Vouchers] Error generando lote:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── ELIMINAR TODAS LAS FICHAS (Requiere Admin Autenticado) ────
router.post('/clear-all', authRequired, (req, res) => {
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM sales').run();
      db.prepare('DELETE FROM whatsapp_payments').run();
      db.prepare('DELETE FROM vouchers').run();
      db.prepare('DELETE FROM voucher_batches').run();
    });
    tx();
    console.log('[Vouchers] 🗑️ Todas las fichas locales y en cola fueron eliminadas por admin:', req.admin.username);
    res.json({ ok: true, message: 'Todas las fichas han sido eliminadas' });
  } catch (err) {
    console.error('[Vouchers] Error al limpiar fichas:', err);
    res.status(500).json({ error: 'Error al limpiar fichas' });
  }
});

// ── LISTAR FICHAS (con filtros y paginación) ──────────────────
router.get('/', authRequired, (req, res) => {
  const db = getDb();
  const {
    status,
    plan_id,
    batch_id,
    q,
    page  = 1,
    limit = 50,
  } = req.query;

  const parsedLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const parsedPage  = Math.max(1, parseInt(page, 10) || 1);

  const conditions = [];
  const params     = [];

  if (status)   { conditions.push('v.status = ?');         params.push(status); }
  if (plan_id)  { conditions.push('v.plan_id = ?');        params.push(plan_id); }
  if (batch_id) { conditions.push('v.batch_id = ?');       params.push(batch_id); }
  if (q)        { conditions.push('v.code LIKE ?');        params.push(`%${String(q).toUpperCase()}%`); }

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (parsedPage - 1) * parsedLimit;

  const vouchers = db.prepare(`
    SELECT v.id, v.code, v.status, v.created_at, v.sold_at, v.activated_at,
           v.expires_at, v.payment_method, v.buyer_note, v.mikrotik_synced,
           p.name  AS plan_name,
           p.duration, p.speed_limit, p.price,
           b.id    AS batch_id,
           a.username AS sold_by_name
    FROM vouchers v
    JOIN  plans p ON v.plan_id = p.id
    LEFT  JOIN voucher_batches b ON v.batch_id = b.id
    LEFT  JOIN admins a ON v.sold_by = a.id
    ${where}
    ORDER BY v.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, parsedLimit, offset);

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM vouchers v ${where}`
  ).get(...params).c;

  res.json({
    vouchers,
    total,
    page:  parsedPage,
    limit: parsedLimit,
    pages: Math.ceil(total / parsedLimit),
  });
});

// ── ESTADÍSTICAS PARA DASHBOARD ───────────────────────────────
router.get('/stats', authRequired, (req, res) => {
  const db = getDb();

  const countByStatus = db.prepare(`
    SELECT status, COUNT(*) AS count FROM vouchers GROUP BY status
  `).all().reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {});

  const revenueToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM sales WHERE date(created_at) = date('now')
  `).get().total;

  const revenueMonth = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM sales WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get().total;

  const revenueTotal = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM sales'
  ).get().total;

  const topPlans = db.prepare(`
    SELECT p.name, COUNT(s.id) AS sales_count, SUM(s.amount) AS revenue
    FROM sales s JOIN plans p ON s.plan_id = p.id
    WHERE strftime('%Y-%m', s.created_at) = strftime('%Y-%m', 'now')
    GROUP BY s.plan_id ORDER BY revenue DESC LIMIT 5
  `).all();

  res.json({
    vouchers: {
      total:     Object.values(countByStatus).reduce((s, n) => s + n, 0),
      available: countByStatus.available || 0,
      sold:      countByStatus.sold      || 0,
      active:    countByStatus.active    || 0,
      expired:   countByStatus.expired   || 0,
      revoked:   countByStatus.revoked   || 0,
    },
    revenue: {
      today: revenueToday,
      month: revenueMonth,
      total: revenueTotal,
    },
    top_plans: topPlans,
  });
});

// ── HISTORIAL DE LOTES ────────────────────────────────────────
router.get('/batches', authRequired, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  res.json(listBatches(limit));
});

// ── FICHAS DE UN LOTE (para impresión) ────────────────────────
router.get('/batch/:id', authRequired, (req, res) => {
  const { status } = req.query;
  const vouchers = getBatchVouchers(parseInt(req.params.id, 10), status || null);
  if (!vouchers.length) {
    return res.status(404).json({ error: 'Lote no encontrado o vacío' });
  }

  const db    = getDb();
  const batch = db.prepare(`
    SELECT b.*, p.name AS plan_name, p.price, p.duration, p.speed_limit
    FROM voucher_batches b JOIN plans p ON b.plan_id = p.id
    WHERE b.id = ?
  `).get(req.params.id);

  res.json({ batch, vouchers });
});

// ── CHARSETS DISPONIBLES ──────────────────────────────────────
router.get('/charsets', authRequired, (req, res) => {
  res.json(
    Object.entries(CHARSETS).map(([key, val]) => ({
      key,
      label:  val.label,
      sample: val.chars.slice(0, 10) + '...',
    }))
  );
});

// ── VENDER FICHA (registro de venta manual atómico) ───────────
router.post('/sell', authRequired, (req, res) => {
  const {
    voucher_id,
    payment_method = 'efectivo',
    notes          = '',
    buyer_note     = '',
  } = req.body;

  if (!voucher_id) {
    return res.status(400).json({ error: 'voucher_id es requerido' });
  }

  const db = getDb();
  const sellerId = req.admin.id || null;

  const transaction = db.transaction(() => {
    const voucher = db.prepare(`
      SELECT v.*, p.price FROM vouchers v
      JOIN plans p ON v.plan_id = p.id
      WHERE v.id = ? AND v.status = 'available'
    `).get(voucher_id);

    if (!voucher) return null;

    const upd = db.prepare(`
      UPDATE vouchers
      SET status = 'sold', sold_at = datetime('now'),
          sold_by = ?, payment_method = ?, buyer_note = ?
      WHERE id = ? AND status = 'available'
    `).run(sellerId, payment_method, buyer_note, voucher_id);

    if (upd.changes !== 1) return null;

    db.prepare(`
      INSERT INTO sales (voucher_id, plan_id, amount, payment_method, seller_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(voucher_id, voucher.plan_id, voucher.price, payment_method, sellerId, notes);

    return voucher;
  });

  const sold = transaction();
  if (!sold) {
    return res.status(404).json({ error: 'Ficha no encontrada o no disponible' });
  }

  res.json({ message: 'Venta registrada', code: sold.code, amount: sold.price });
});

// ── ACTIVAR FICHA — Portal cautivo (Atómico anti-TOCTOU) ──────
router.post('/activate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido' });

  const cleanCode = String(code).toUpperCase().trim();
  if (!REGEX_CODE.test(cleanCode)) {
    return res.status(400).json({ error: 'Formato de código inválido' });
  }

  if (_activatingCodes.has(cleanCode)) {
    return res.status(409).json({ error: 'Esta ficha ya está siendo procesada. Por favor espera un momento.' });
  }

  _activatingCodes.add(cleanCode);
  const startTime = Date.now();
  const db = getDb();

  try {
    // Reserva atómica previa antes de llamar al router para eliminar condición TOCTOU
    let voucher = null;
    let prevStatus = null;
    let expiresAt = null;

    const claimTx = db.transaction(() => {
      const row = db.prepare(`
        SELECT v.*, p.duration, p.speed_limit, p.name AS plan_name,
               p.data_limit, p.shared_users, p.profile_name, p.price
        FROM vouchers v
        JOIN plans p ON v.plan_id = p.id
        WHERE v.code = ? AND v.status IN ('available', 'sold')
      `).get(cleanCode);

      if (!row) return false;

      const durMs = parseDurationMs(row.duration);
      const finalExpiryMs = Math.min(Date.now() + durMs, getBogotaMidnightMs());
      expiresAt = new Date(finalExpiryMs).toISOString();
      prevStatus = row.status;

      const upd = db.prepare(`
        UPDATE vouchers
        SET status = 'active', sold_at = COALESCE(sold_at, datetime('now')),
            activated_at = datetime('now'), expires_at = ?
        WHERE id = ? AND status IN ('available', 'sold')
      `).run(expiresAt, row.id);

      if (upd.changes !== 1) return false;
      voucher = row;
      return true;
    });

    if (!claimTx() || !voucher) {
      return res.status(404).json({ error: 'Código inválido, ya utilizado o expirado' });
    }

    if (!config.mikrotik.cloudSyncOnly) {
      try {
        await mikrotik.createHotspotUser(voucher.code, voucher.code, {
          profile:         voucher.profile_name || voucher.plan_name,
          limitUptime:     voucher.duration,
          rateLimit:       voucher.speed_limit,
          limitBytesTotal: voucher.data_limit,
          sharedUsers:     voucher.shared_users,
          comment:         'Ficha generada por sistema ROYOTA',
        });

        db.prepare('UPDATE vouchers SET mikrotik_synced = 1 WHERE id = ?').run(voucher.id);
      } catch (mkErr) {
        // Revertir reclamo atómico si falló la creación directa en MikroTik
        db.prepare(`
          UPDATE vouchers
          SET status = ?, activated_at = NULL, expires_at = NULL
          WHERE id = ?
        `).run(prevStatus, voucher.id);

        db.prepare(`
          INSERT INTO sync_log (action, voucher_code, status, http_status, response, duration_ms)
          VALUES ('create', ?, 'error', ?, ?, ?)
        `).run(voucher.code, mkErr.httpStatus || 0, mkErr.message, Date.now() - startTime);

        return res.status(502).json({
          error: 'No se pudo activar la ficha en este momento. Intenta de nuevo.',
        });
      }
    }

    if (prevStatus === 'available') {
      try {
        db.prepare(`
          INSERT INTO sales (voucher_id, plan_id, amount, payment_method, notes)
          VALUES (?, ?, ?, 'activacion_portal', 'Auto-facturación por activación en portal')
        `).run(voucher.id, voucher.plan_id, voucher.price || 0);
      } catch (errSale) {
        console.warn('[Vouchers] Aviso registrando auto-facturación:', errSale.message);
      }
    }

    // Solo desbloquear wa_trials si la MAC enviada tiene formato válido tras activación real
    if (req.body.mac) {
      const cleanMac = String(req.body.mac).trim().toUpperCase().replace(/-/g, ':');
      if (REGEX_MAC.test(cleanMac)) {
        try {
          db.prepare(`
            UPDATE wa_trials
            SET blocked = 0, unblocked = 1, attempts = 0, updated_at = datetime('now')
            WHERE mac = ?
          `).run(cleanMac);
        } catch (_) {}
      }
    }

    db.prepare(`
      INSERT INTO sync_log (action, voucher_code, status, http_status, response, duration_ms)
      VALUES ('create', ?, 'success', 201, 'Usuario creado en MikroTik', ?)
    `).run(voucher.code, Date.now() - startTime);

    return res.json({
      message:    '¡Ficha activada! Ya puedes navegar.',
      code:       voucher.code,
      plan:       voucher.plan_name,
      duration:   voucher.duration,
      speed:      voucher.speed_limit,
      expires_at: expiresAt,
    });
  } finally {
    _activatingCodes.delete(cleanCode);
  }
});

// ── VERIFICAR ESTADO DE FICHA (portal, sin auth) ──────────────
router.get('/check/:code', (req, res) => {
  const cleanCode = String(req.params.code || '').toUpperCase().trim();
  if (!REGEX_CODE.test(cleanCode)) {
    return res.status(400).json({ error: 'Formato de código inválido' });
  }
  const db = getDb();
  const v = db.prepare(`
    SELECT v.code, v.status, v.activated_at, v.expires_at,
           p.name AS plan_name, p.duration, p.speed_limit
    FROM vouchers v JOIN plans p ON v.plan_id = p.id
    WHERE v.code = ?
  `).get(cleanCode);

  if (!v) return res.status(404).json({ error: 'Código no encontrado' });
  res.json(v);
});

// ── REVOCAR FICHA ─────────────────────────────────────────────
router.post('/revoke/:id', authRequired, async (req, res) => {
  const db      = getDb();
  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(req.params.id);

  if (!voucher) return res.status(404).json({ error: 'Ficha no encontrada' });
  if (['expired', 'revoked'].includes(voucher.status)) {
    return res.status(400).json({ error: `La ficha ya está en estado: ${voucher.status}` });
  }

  const startTime = Date.now();

  try {
    if (voucher.mikrotik_synced && voucher.status === 'active' && !config.mikrotik.cloudSyncOnly) {
      await mikrotik.kickActiveUser(voucher.code);
      const mkUser = await mikrotik.findHotspotUser(voucher.code);
      if (mkUser) await mikrotik.removeHotspotUser(mkUser['.id']);
    }

    db.prepare("UPDATE vouchers SET status = 'revoked' WHERE id = ?").run(voucher.id);

    db.prepare(`
      INSERT INTO sync_log (action, voucher_code, status, response, duration_ms)
      VALUES ('delete', ?, 'success', 'Ficha revocada por admin', ?)
    `).run(voucher.code, Date.now() - startTime);

    res.json({ message: 'Ficha revocada exitosamente' });
  } catch (err) {
    console.error('[Revoke] Error:', err.message);
    res.status(500).json({ error: `Error al revocar: ${err.message}` });
  }
});

// ── CORTESÍA WHATSAPP (2 minutos x 2 intentos diarios, MAC validada) ──
router.get('/trial/status', (req, res) => {
  const mac = String(req.query.mac || '').trim().toUpperCase().replace(/-/g, ':');
  const dateStr = getBogotaDateStr();
  if (!REGEX_MAC.test(mac)) {
    return res.json({ date: dateStr, attempts: 0, blocked: false, remaining: 2, unblocked: false });
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM wa_trials WHERE mac = ? AND date_str = ?').get(mac, dateStr);

  if (!row) {
    return res.json({ mac, date: dateStr, attempts: 0, remaining: 2, blocked: false, unblocked: false });
  }

  const isBlocked = row.blocked === 1 && row.unblocked === 0;
  res.json({
    mac,
    date: dateStr,
    attempts: row.attempts,
    remaining: Math.max(0, 2 - row.attempts),
    blocked: isBlocked,
    unblocked: row.unblocked === 1,
  });
});

router.post('/trial/request', async (req, res) => {
  const rawMac = String(req.body?.mac || '').trim().toUpperCase().replace(/-/g, ':');
  if (!REGEX_MAC.test(rawMac)) {
    return res.status(400).json({
      error: 'Se requiere una dirección MAC válida del Hotspot para solicitar cortesía.',
    });
  }

  const dateStr = getBogotaDateStr();
  const db = getDb();

  const trialTx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM wa_trials WHERE mac = ? AND date_str = ?').get(rawMac, dateStr);

    if (existing && existing.blocked === 1 && existing.unblocked === 0) {
      return { blocked: true, attempts: existing.attempts };
    }

    const currentAttempts = existing ? existing.attempts : 0;
    if (currentAttempts >= 2 && (!existing || existing.unblocked === 0)) {
      db.prepare("UPDATE wa_trials SET blocked = 1, updated_at = datetime('now') WHERE id = ?").run(existing.id);
      return { blocked: true, attempts: 2 };
    }

    const newAttempts = currentAttempts + 1;
    const isBlocked = newAttempts >= 2 ? 1 : 0;

    if (existing) {
      db.prepare(`
        UPDATE wa_trials
        SET attempts = ?, blocked = ?, unblocked = 0, last_attempt_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(newAttempts, isBlocked, existing.id);
    } else {
      db.prepare(`
        INSERT INTO wa_trials (mac, date_str, attempts, blocked, unblocked, last_attempt_at)
        VALUES (?, ?, ?, ?, 0, datetime('now'))
      `).run(rawMac, dateStr, newAttempts, isBlocked);
    }

    return { blocked: false, newAttempts, isBlocked };
  });

  const outcome = trialTx();
  if (outcome.blocked) {
    return res.status(403).json({
      error: 'Has agotado tus 2 intentos gratuitos del día de hoy. Por favor adquiere una ficha física en las casetas autorizadas.',
      blocked: true,
      attempts: outcome.attempts,
      remaining: 0,
    });
  }

  const macSuffix = rawMac.replace(/[^A-F0-9]/g, '').slice(-6);
  const trialUser = `WA-${macSuffix}-${outcome.newAttempts}`;

  if (!config.mikrotik.cloudSyncOnly) {
    try {
      await mikrotik.createHotspotUser(trialUser, trialUser, {
        profile:     'default',
        limitUptime: '2m',
        rateLimit:   '5M/5M',
        comment:     `Cortesia WhatsApp 2m (${outcome.newAttempts}/2)`,
      });
    } catch (err) {
      console.warn('[Trial] Aviso creando usuario en MikroTik:', err.message);
    }
  }

  const msg = outcome.newAttempts === 1
    ? '¡2 minutos de navegación otorgados! Realiza tu transferencia y envía el comprobante por WhatsApp.'
    : '¡Última oportunidad! Te quedan 2 minutos para completar tu pago y enviar el comprobante.';

  res.json({
    ok: true,
    code: trialUser,
    attempt: outcome.newAttempts,
    remaining: Math.max(0, 2 - outcome.newAttempts),
    blocked: outcome.isBlocked === 1,
    duration: '2m',
    message: msg,
  });
});

module.exports = router;
