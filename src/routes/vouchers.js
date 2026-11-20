/**
 * src/routes/vouchers.js
 * ─────────────────────────────────────────────────────────────
 * Rutas completas de gestión de fichas (vouchers).
 *
 * POST /api/vouchers/generate      → Generar lote de fichas
 * GET  /api/vouchers               → Listar fichas con filtros
 * GET  /api/vouchers/stats         → Estadísticas para dashboard
 * GET  /api/vouchers/batches       → Historial de lotes
 * GET  /api/vouchers/batch/:id     → Fichas de un lote
 * POST /api/vouchers/sell          → Marcar ficha como vendida
 * POST /api/vouchers/activate      → Activar ficha (portal cautivo)
 * GET  /api/vouchers/check/:code   → Estado de ficha (portal)
 * POST /api/vouchers/revoke/:id    → Revocar ficha
 */
'use strict';

const { Router } = require('express');
const { getDb }  = require('../database');
const { authRequired }   = require('../middleware/auth');
const mikrotik           = require('../services/mikrotik-api');
const { generateBatch, listBatches, getBatchVouchers, CHARSETS } = require('../services/voucher-generator');

const router = Router();
const _activatingCodes = new Set();

// ── Helper: parsear duración MikroTik a ms ───────────────────
function parseDurationMs(str) {
  if (!str) return 3_600_000; // default 1h
  const m = str.match(/^(\d+)([mhd])$/i);
  if (!m) return 3_600_000;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default:  return 3_600_000;
  }
}

// ════════════════════════════════════════════════════════════════
//  GENERAR LOTE DE FICHAS
// ════════════════════════════════════════════════════════════════
/**
 * POST /api/vouchers/generate
 * Body: {
 *   plan_id: number,
 *   quantity: number (1-1000),
 *   code_length?: number (4-16, default 8),
 *   charset?: 'full'|'numeric'|'alpha' (default 'full'),
 *   group_size?: number (0=sin separador, 4=grupos de 4),
 *   separator?: string (default '-'),
 *   prefix?: string,
 *   note?: string
 * }
 */
router.post('/generate', authRequired, async (req, res) => {
  const {
    plan_id,
    quantity   = 10,
    code_length = 8,
    charset    = 'full',
    group_size  = 0,
    separator  = '-',
    prefix     = '',
    note       = '',
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
      prefix:     prefix.toUpperCase(),
      batchNote:  note,
    });

    // Registrar quién generó el lote
    getDb().prepare(
      'UPDATE voucher_batches SET created_by = ? WHERE id = ?'
    ).run(req.admin.id, result.batchId);

    res.status(201).json({
      message:  `${result.generated} fichas generadas exitosamente`,
      batch_id: result.batchId,
      plan:     result.plan,
      codes:    result.codes,
      generated: result.generated,
    });
  } catch (err) {
    console.error('[Vouchers] Error generando lote:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  LISTAR FICHAS (con filtros y paginación)
// ════════════════════════════════════════════════════════════════
router.get('/', authRequired, (req, res) => {
  const db = getDb();
  const {
    status,
    plan_id,
    batch_id,
    q,          // búsqueda por código
    page  = 1,
    limit = 50,
  } = req.query;

  const conditions = [];
  const params     = [];

  if (status)   { conditions.push('v.status = ?');         params.push(status); }
  if (plan_id)  { conditions.push('v.plan_id = ?');        params.push(plan_id); }
  if (batch_id) { conditions.push('v.batch_id = ?');       params.push(batch_id); }
  if (q)        { conditions.push('v.code LIKE ?');        params.push(`%${q.toUpperCase()}%`); }

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

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
  `).all(...params, parseInt(limit, 10), offset);

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM vouchers v ${where}`
  ).get(...params).c;

  res.json({
    vouchers,
    total,
    page:  parseInt(page, 10),
    limit: parseInt(limit, 10),
    pages: Math.ceil(total / parseInt(limit, 10)),
  });
});

// ════════════════════════════════════════════════════════════════
//  ESTADÍSTICAS PARA DASHBOARD
// ════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════
//  HISTORIAL DE LOTES
// ════════════════════════════════════════════════════════════════
router.get('/batches', authRequired, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json(listBatches(limit));
});

// ════════════════════════════════════════════════════════════════
//  FICHAS DE UN LOTE (para impresión)
// ════════════════════════════════════════════════════════════════
router.get('/batch/:id', authRequired, (req, res) => {
  const { status } = req.query;
  const vouchers = getBatchVouchers(parseInt(req.params.id, 10), status || null);
  if (!vouchers.length) {
    return res.status(404).json({ error: 'Lote no encontrado o vacío' });
  }

  // Incluir info del lote
  const db    = getDb();
  const batch = db.prepare(`
    SELECT b.*, p.name AS plan_name, p.price, p.duration, p.speed_limit
    FROM voucher_batches b JOIN plans p ON b.plan_id = p.id
    WHERE b.id = ?
  `).get(req.params.id);

  res.json({ batch, vouchers });
});

// ════════════════════════════════════════════════════════════════
//  CHARSETS DISPONIBLES (para el formulario de generación)
// ════════════════════════════════════════════════════════════════
router.get('/charsets', authRequired, (req, res) => {
  res.json(
    Object.entries(CHARSETS).map(([key, val]) => ({
      key,
      label:  val.label,
      sample: val.chars.slice(0, 10) + '...',
    }))
  );
});

// ════════════════════════════════════════════════════════════════
//  VENDER FICHA (registro de venta manual)
// ════════════════════════════════════════════════════════════════
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
  const voucher = db.prepare(`
    SELECT v.*, p.price FROM vouchers v
    JOIN plans p ON v.plan_id = p.id
    WHERE v.id = ? AND v.status = 'available'
  `).get(voucher_id);

  if (!voucher) {
    return res.status(404).json({ error: 'Ficha no encontrada o no disponible' });
  }

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE vouchers
      SET status = 'sold', sold_at = datetime('now'),
          sold_by = ?, payment_method = ?, buyer_note = ?
      WHERE id = ?
    `).run(req.admin.id, payment_method, buyer_note, voucher_id);

    db.prepare(`
      INSERT INTO sales (voucher_id, plan_id, amount, payment_method, seller_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(voucher_id, voucher.plan_id, voucher.price, payment_method, req.admin.id, notes);
  });

  transaction();

  res.json({ message: 'Venta registrada', code: voucher.code, amount: voucher.price });
});

// ════════════════════════════════════════════════════════════════
//  ACTIVAR FICHA — Portal cautivo (sin auth requerido)
// ════════════════════════════════════════════════════════════════
router.post('/activate', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido' });

  const cleanCode = String(code).toUpperCase().trim();

  // Prevenir condiciones de carrera por doble clic o peticiones concurrentes
  if (_activatingCodes.has(cleanCode)) {
    return res.status(409).json({ error: 'Esta ficha ya está siendo procesada. Por favor espera un momento.' });
  }

  const db = getDb();

  const voucher = db.prepare(`
    SELECT v.*, p.duration, p.speed_limit, p.name AS plan_name,
           p.data_limit, p.shared_users, p.profile_name
    FROM vouchers v
    JOIN plans p ON v.plan_id = p.id
    WHERE v.code = ? AND v.status IN ('available', 'sold')
  `).get(cleanCode);

  if (!voucher) {
    return res.status(404).json({ error: 'Código inválido, ya utilizado o expirado' });
  }

  _activatingCodes.add(cleanCode);
  const startTime = Date.now();

  try {
    // Crear usuario en el router
    await mikrotik.createHotspotUser(voucher.code, voucher.code, {
      profile:         voucher.profile_name || voucher.plan_name,
      limitUptime:     voucher.duration,
      rateLimit:       voucher.speed_limit,
      limitBytesTotal: voucher.data_limit,
      sharedUsers:     voucher.shared_users,
      comment:         `Ficha generada por sistema ROYOTA`,
    });

    const expiresAt = new Date(Date.now() + parseDurationMs(voucher.duration)).toISOString();

    // Actualizar estado en BD
    db.prepare(`
      UPDATE vouchers
      SET status = 'active', activated_at = datetime('now'),
          expires_at = ?, mikrotik_synced = 1
      WHERE id = ?
    `).run(expiresAt, voucher.id);

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

  } catch (err) {
    console.error('[Activate] Error MikroTik:', err.message);

    db.prepare(`
      INSERT INTO sync_log (action, voucher_code, status, http_status, response, duration_ms)
      VALUES ('create', ?, 'error', ?, ?, ?)
    `).run(voucher.code, err.httpStatus || 0, err.message, Date.now() - startTime);

    return res.status(502).json({
      error: 'No se pudo activar la ficha en este momento. Intenta de nuevo.',
    });
  } finally {
    _activatingCodes.delete(cleanCode);
  }
});

// ════════════════════════════════════════════════════════════════
//  VERIFICAR ESTADO DE FICHA (portal, sin auth)
// ════════════════════════════════════════════════════════════════
router.get('/check/:code', (req, res) => {
  const db = getDb();
  const v = db.prepare(`
    SELECT v.code, v.status, v.activated_at, v.expires_at,
           p.name AS plan_name, p.duration, p.speed_limit
    FROM vouchers v JOIN plans p ON v.plan_id = p.id
    WHERE v.code = ?
  `).get(req.params.code.toUpperCase().trim());

  if (!v) return res.status(404).json({ error: 'Código no encontrado' });
  res.json(v);
});

// ════════════════════════════════════════════════════════════════
//  REVOCAR FICHA
// ════════════════════════════════════════════════════════════════
router.post('/revoke/:id', authRequired, async (req, res) => {
  const db      = getDb();
  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(req.params.id);

  if (!voucher) return res.status(404).json({ error: 'Ficha no encontrada' });
  if (['expired', 'revoked'].includes(voucher.status)) {
    return res.status(400).json({ error: `La ficha ya está en estado: ${voucher.status}` });
  }

  const startTime = Date.now();

  try {
    if (voucher.mikrotik_synced && voucher.status === 'active') {
      // 1. Expulsar la sesión activa inmediatamente del Hotspot
      await mikrotik.kickActiveUser(voucher.code);

      // 2. Eliminar de /ip/hotspot/user
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

module.exports = router;
