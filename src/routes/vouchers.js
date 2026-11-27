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
const { getBogotaDateStr } = require('../utils/helpers');
const {
  REGEX_CODE,
  REGEX_MAC,
  activateVoucherSSOT,
  getVoucherSSOT,
  getWaTrialStatusSSOT,
  requestTempPaymentPassSSOT,
  setDoc,
  enqueueMikrotikOp,
} = require('../services/firestore-store');
const { hasServiceAccount } = require('../services/firestore-client');

const router = Router();
const _activatingCodes = new Set();

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

  const bogotaDate = getBogotaDateStr();
  const bogotaStartUtc = new Date(`${bogotaDate}T05:00:00.000Z`).toISOString().replace('T', ' ').slice(0, 19);
  const bogotaEndUtc = new Date(new Date(`${bogotaDate}T05:00:00.000Z`).getTime() + 86400000 - 1).toISOString().replace('T', ' ').slice(0, 19);

  const revenueToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM sales WHERE created_at >= ? AND created_at <= ?
  `).get(bogotaStartUtc, bogotaEndUtc).total;

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
    const result = await activateVoucherSSOT({
      code: cleanCode,
      mac: req.body?.mac,
      db,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error || 'Código inválido, ya utilizado o expirado',
      });
    }

    const v = result.voucher;

    if (!result.reused && !config.mikrotik.cloudSyncOnly) {
      try {
        await mikrotik.createHotspotUser(v.code, v.code, {
          profile:         v.profile_name || v.plan_name,
          limitUptime:     v.duration,
          rateLimit:       v.speed_limit,
          sharedUsers:     1,
          comment:         'Ficha generada por sistema ROYOTA',
        });
      } catch (mkErr) {
        console.warn('[Activate] Aviso push directo MikroTik (usará Cloud Sync):', mkErr.message);
      }
    }

    try {
      db.prepare(`
        INSERT INTO sync_log (action, voucher_code, status, http_status, response, duration_ms)
        VALUES ('create', ?, 'success', 200, ?, ?)
      `).run(v.code, result.reused ? 'Reingreso sesión activa' : 'Ficha activada SSOT', Date.now() - startTime);
    } catch (_) {}

    return res.json({
      message:          result.reused ? 'Sesión activa restaurada. ¡Bienvenido de nuevo!' : '¡Ficha activada! Ya puedes navegar.',
      code:             v.code,
      plan:             v.plan_name,
      duration:         v.duration,
      speed:            v.speed_limit,
      expires_at:       v.expires_at,
      remainingSeconds: v.remainingSeconds,
      reused:           Boolean(result.reused),
    });
  } finally {
    _activatingCodes.delete(cleanCode);
  }
});

// ── VERIFICAR ESTADO DE FICHA (portal, sin auth) ──────────────
router.get('/check/:code', async (req, res) => {
  const cleanCode = String(req.params.code || '').toUpperCase().trim();
  if (!REGEX_CODE.test(cleanCode)) {
    return res.status(400).json({ error: 'Formato de código inválido' });
  }
  const v = await getVoucherSSOT(cleanCode, getDb());
  if (!v) return res.status(404).json({ error: 'Código no encontrado' });

  res.json({
    code: v.code,
    status: v.status,
    activated_at: v.activated_at || null,
    expires_at: v.expires_at || null,
    plan_name: v.plan_name || '',
    duration: v.duration || '',
    speed_limit: v.speed_limit || '',
  });
});

// ── REVOCAR FICHA ─────────────────────────────────────────────
router.post('/revoke/:id', authRequired, async (req, res) => {
  const db      = getDb();
  const paramId = String(req.params.id || '').trim();
  let voucher   = db.prepare('SELECT * FROM vouchers WHERE id = ? OR code = ?').get(paramId, paramId.toUpperCase());

  if (!voucher && hasServiceAccount()) {
    voucher = await getVoucherSSOT(paramId.toUpperCase(), null);
  }

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

    if (voucher.id) {
      db.prepare("UPDATE vouchers SET status = 'revoked' WHERE id = ?").run(voucher.id);
    }

    if (hasServiceAccount()) {
      await setDoc(`/vouchers/${encodeURIComponent(voucher.code)}`, {
        status: 'revoked',
        revoked_at: new Date().toISOString(),
      }).catch(() => {});
      await enqueueMikrotikOp({
        op_id: `REMOVE_${voucher.code}`,
        action: 'remove_user',
        code: voucher.code,
      }).catch(() => {});
    }

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

// ── PASE TEMPORAL DE PAGO (3 min x 2 intentos/día, SSOT Firestore, reemplaza trial bypass) ─
router.get('/trial/status', async (req, res) => {
  const rawMac = String(req.query.mac || '').trim().toUpperCase().replace(/-/g, ':');
  const dateStr = getBogotaDateStr();
  if (!REGEX_MAC.test(rawMac)) {
    return res.json({ date: dateStr, attempts: 0, blocked: false, remaining: 2, unblocked: false });
  }
  const st = await getWaTrialStatusSSOT({ mac: rawMac, db: getDb() });
  res.json({
    mac: rawMac,
    date: dateStr,
    attempts: st.attempts,
    remaining: st.remaining,
    blocked: st.blocked,
    unblocked: !st.blocked && st.attempts === 0,
  });
});

router.post('/trial/request', async (req, res) => {
  const rawMac = String(req.body?.mac || '').trim().toUpperCase().replace(/-/g, ':');
  if (!REGEX_MAC.test(rawMac)) {
    return res.status(400).json({
      error: 'Se requiere una dirección MAC válida del Hotspot para solicitar el pase de pago.',
    });
  }

  const db = getDb();
  const outcome = await requestTempPaymentPassSSOT({ mac: rawMac, db });

  if (!outcome.allowed) {
    return res.status(outcome.status || 403).json({
      error: outcome.error,
      reason: outcome.reason,
      blocked: outcome.reason === 'TRIAL_LIMIT_EXCEEDED',
      attempts: outcome.attempts || 0,
      remaining: outcome.remaining || 0,
    });
  }

  if (!config.mikrotik.cloudSyncOnly) {
    try {
      await mikrotik.createHotspotUser(outcome.tempCode, outcome.tempCode, {
        profile:     'royota-pay',
        limitUptime: '3m',
        rateLimit:   '1M/1M',
        comment:     `PAYPOOL ${outcome.tempCode}`,
      });
      outcome.ready = true;
    } catch (err) {
      console.warn('[Trial] Aviso creando pase temporal directo:', err.message);
    }
  }

  const msg = outcome.attempts === 1
    ? '¡Pase de pago por 3 minutos activado! Realiza tu transferencia y envía el comprobante por WhatsApp.'
    : '¡Último pase de pago de hoy (3 minutos)! Completa tu pago y envía el comprobante por WhatsApp.';

  res.json({
    ok: true,
    code: outcome.tempCode,
    password: outcome.tempCode,
    ready: Boolean(outcome.ready),
    retryWaitMs: outcome.ready ? 0 : 4000,
    reused: Boolean(outcome.reused),
    attempt: outcome.attempts,
    remaining: outcome.remaining,
    blocked: false,
    duration: '3m',
    expiresAt: outcome.expiresAt,
    message: msg,
  });
});

module.exports = router;
