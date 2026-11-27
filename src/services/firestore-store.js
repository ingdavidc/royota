'use strict';

const crypto = require('crypto');
const config = require('../config');
const {
  hasServiceAccount,
  firestoreFetch,
  toFirestoreFields,
  decodeFirestoreValue,
  isFirestoreQuotaBackoffActive,
} = require('./firestore-client');
const {
  parseDurationMs,
  getBogotaDateStr,
  getBogotaMidnightMs,
} = require('../utils/helpers');

const CODE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const REGEX_CODE = /^[A-Z0-9_-]{3,24}$/;
const REGEX_MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const REGEX_PROFILE = /^[A-Za-z0-9 _.-]{1,32}$/;
const REGEX_DURATION = /^([1-9]\d{0,3})([mhdw])$/;
const REGEX_SPEED = /^(\d+[kKmMgG]?)\/(\d+[kKmMgG]?)$/;

const BOT_POOL_TARGET_PER_PLAN = 5;
const PAY_POOL_TARGET = 6;
const MAX_PENDING_OPS_PER_BATCH = 12;
const QUEUE_STALE_POLL_MS = 10 * 60 * 1000;
const POOL_RESTOCK_POLL_MS = 6 * 60 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const PAYMENT_PASS_TTL_MS = 3 * 60 * 1000;
const TRIAL_MAX_ATTEMPTS_PER_DAY = 2;

const _cache = {
  settings: { value: null, ts: 0 },
  plans: { value: null, ts: 0 },
  kiosks: { value: null, ts: 0 },
};

const _queueState = {
  initialized: false,
  lastFirestorePullMs: 0,
  lastPoolCheckMs: 0,
  ops: new Map(), // opId -> op object
};

// -------------------- Sanitization & Date Helpers --------------------

function normalizeCode(raw) {
  const code = String(raw || '').trim().toUpperCase();
  return REGEX_CODE.test(code) ? code : null;
}

function normalizeMac(raw) {
  const mac = String(raw || '').trim().toUpperCase().replace(/-/g, ':');
  return REGEX_MAC.test(mac) ? mac : null;
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function generateRandomCode(prefix = '', randomLen = 6) {
  const bytes = crypto.randomBytes(randomLen);
  let out = prefix;
  for (let i = 0; i < randomLen; i++) {
    out += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
  }
  return out;
}

/**
 * Resolves a MikroTik profile name safely without letting multi-speed plans
 * accidentally overwrite the shared "default" profile rate-limit.
 */
function resolveEffectiveProfileName(plan) {
  const rawProfile = String(plan?.profile_name || '').trim();
  const planName = String(plan?.name || '').trim();
  const speed = String(plan?.speed_limit || '').trim();

  if (rawProfile && rawProfile !== 'default' && REGEX_PROFILE.test(rawProfile)) {
    return rawProfile;
  }

  if (planName && REGEX_PROFILE.test(planName)) {
    return planName;
  }

  if (speed && REGEX_SPEED.test(speed)) {
    const slug = 'royota-' + speed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (REGEX_PROFILE.test(slug)) return slug;
  }

  return REGEX_PROFILE.test(rawProfile) ? rawProfile : 'default';
}

function computeVoucherExpiryIso(activatedAtInput, durationStr) {
  const activatedDate = activatedAtInput instanceof Date
    ? activatedAtInput
    : new Date(activatedAtInput || Date.now());
  const activatedMs = activatedDate.getTime();
  const durMs = parseDurationMs(durationStr || '1h') || 3600000;
  const endMs = Math.min(activatedMs + durMs, getBogotaMidnightMs(activatedDate));
  return new Date(endMs).toISOString();
}

function isVoucherExpiredSSOT(voucher, nowInput = Date.now()) {
  if (!voucher) return true;
  if (voucher.status === 'expired' || voucher.status === 'revoked') return true;
  if (voucher.status !== 'active') return false;

  const nowDate = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowMs = nowDate.getTime();

  if (voucher.expires_at) {
    const expMs = new Date(voucher.expires_at).getTime();
    if (!Number.isNaN(expMs) && expMs <= nowMs) return true;
  }

  if (voucher.activated_at) {
    const actDate = new Date(voucher.activated_at);
    if (!Number.isNaN(actDate.getTime())) {
      if (getBogotaDateStr(actDate) < getBogotaDateStr(nowDate)) {
        return true;
      }
    }
  }

  return false;
}

// -------------------- Low-Level Firestore REST Helpers --------------------

function normalizeRelPath(relPath) {
  const p = String(relPath || '');
  return p.startsWith('/') ? p : `/${p}`;
}

function decodeDoc(doc) {
  if (!doc || !doc.name) return null;
  const out = {
    _id: doc.name.split('/').pop(),
    _updateTime: doc.updateTime || null,
  };
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) {
      out[k] = decodeFirestoreValue(v);
    }
  }
  return out;
}

function sanitizeFlatFields(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_') || v === undefined) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    } else {
      clean[k] = JSON.stringify(v);
    }
  }
  return clean;
}

function makeFirestoreHttpError(opLabel, res, body) {
  const err = new Error(`${opLabel} failed (${res.status}): ${String(body || '').slice(0, 180)}`);
  err.status = res.status;
  err.isQuotaExceeded = res.status === 429;
  return err;
}

async function getDoc(relPath) {
  const res = await firestoreFetch(normalizeRelPath(relPath), { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw makeFirestoreHttpError(`Firestore GET ${relPath}`, res, body);
  }
  return decodeDoc(await res.json());
}

async function setDoc(relPath, dataObj, options = {}) {
  const flat = sanitizeFlatFields(dataObj);
  const params = [];
  if (options.merge !== false) {
    for (const key of Object.keys(flat)) {
      params.push(`updateMask.fieldPaths=${encodeURIComponent(key)}`);
    }
  }
  if (options.updateTime) {
    params.push(`currentDocument.updateTime=${encodeURIComponent(options.updateTime)}`);
  } else if (options.exists === true) {
    params.push('currentDocument.exists=true');
  } else if (options.exists === false) {
    params.push('currentDocument.exists=false');
  }

  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  const res = await firestoreFetch(`${normalizeRelPath(relPath)}${qs}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: toFirestoreFields(flat) }),
  });

  if (res.status === 409 || res.status === 412) {
    const err = new Error('FIRESTORE_PRECONDITION_FAILED');
    err.code = 'PRECONDITION_FAILED';
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw makeFirestoreHttpError(`Firestore PATCH ${relPath}`, res, body);
  }

  return decodeDoc(await res.json());
}

async function createDoc(collectionPath, dataObj, docId = null) {
  const flat = sanitizeFlatFields(dataObj);
  if (docId) {
    return setDoc(`/${collectionPath}/${encodeURIComponent(docId)}`, flat, {
      merge: false,
      exists: false,
    });
  }
  const res = await firestoreFetch(`/${collectionPath}`, {
    method: 'POST',
    body: JSON.stringify({ fields: toFirestoreFields(flat) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw makeFirestoreHttpError(`Firestore POST ${collectionPath}`, res, body);
  }
  return decodeDoc(await res.json());
}

async function deleteDoc(relPath) {
  const res = await firestoreFetch(normalizeRelPath(relPath), { method: 'DELETE' });
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw makeFirestoreHttpError(`Firestore DELETE ${relPath}`, res, body);
  }
  return true;
}

async function runQuery(structuredQuery) {
  const res = await firestoreFetch(':runQuery', {
    method: 'POST',
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw makeFirestoreHttpError('Firestore runQuery', res, body);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  const docs = [];
  for (const row of rows) {
    if (row && row.document) docs.push(decodeDoc(row.document));
  }
  return docs;
}

async function listCollection(collectionPath, pageSize = 300) {
  const docs = [];
  let pageToken = '';
  do {
    const qs = `?pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await firestoreFetch(`/${collectionPath}${qs}`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw makeFirestoreHttpError(`Firestore LIST ${collectionPath}`, res, body);
    }
    const json = await res.json();
    if (Array.isArray(json.documents)) {
      for (const d of json.documents) docs.push(decodeDoc(d));
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return docs;
}

// -------------------- Settings, Plans & Kiosks SSOT --------------------

function invalidateSettingsCache() {
  _cache.settings = { value: null, ts: 0 };
}

function invalidatePlansCache() {
  _cache.plans = { value: null, ts: 0 };
}

function invalidateKiosksCache() {
  _cache.kiosks = { value: null, ts: 0 };
}

function normalizeSettingsMap(raw) {
  const s = raw || {};
  return {
    business_name: String(s.business_name || 'Río Royota - WiFi'),
    business_slogan: String(s.business_slogan || 'Un paraíso natural junto al río · Conexión WiFi'),
    whatsapp_number: String(s.whatsapp_number || config.whatsapp.paymentPhone || '573203778210'),
    whatsapp_message: String(s.whatsapp_message || 'Hola! Deseo comprar una ficha de internet WiFi.'),
    payment_phone: String(s.payment_phone || config.whatsapp.paymentPhone || '3174251419'),
    payment_holder_name: String(s.payment_holder_name || ''),
    online_purchase_active: String(s.online_purchase_active !== undefined ? s.online_purchase_active : '1'),
    wompi_mode: s.wompi_mode === 'sandbox' ? 'sandbox' : (s.wompi_mode === 'production' ? 'production' : (config.wompi?.mode || 'production')),
    info_active: String(s.info_active !== undefined ? s.info_active : '1'),
    info_badge: String(s.info_badge || 'Avisos & Servicios del Balneario'),
    info_title: String(s.info_title || '¡Bienvenidos al Río Royota!'),
    info_content: String(s.info_content || ''),
  };
}

function readSettingsFromSqlite(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return normalizeSettingsMap(obj);
}

async function getSettingsLive({ force = false, db = null } = {}) {
  const now = Date.now();
  if (!force && _cache.settings.value && (now - _cache.settings.ts) < LIVE_CACHE_TTL_MS) {
    return _cache.settings.value;
  }

  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive()) {
    try {
      const doc = await getDoc('/settings/general');
      if (doc) {
        const normalized = normalizeSettingsMap(doc);
        _cache.settings = { value: normalized, ts: now };
        return normalized;
      }
    } catch (err) {
      console.error('[FirestoreStore] getSettingsLive fallback:', err.message);
      if (_cache.settings.value) return _cache.settings.value;
    }
  } else if (_cache.settings.value) {
    return _cache.settings.value;
  }

  const fallback = db ? readSettingsFromSqlite(db) : normalizeSettingsMap({});
  _cache.settings = { value: fallback, ts: now };
  return fallback;
}

async function updateSettingsLive(patchObj, db = null) {
  const clean = sanitizeFlatFields(patchObj);
  if (db) {
    try {
      const upsert = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      for (const [k, v] of Object.entries(clean)) {
        upsert.run(k, String(v ?? ''));
      }
    } catch (err) {
      console.error('[FirestoreStore] SQLite settings mirror warn:', err.message);
    }
  }
  if (hasServiceAccount()) {
    await setDoc('/settings/general', clean, { merge: true });
  }
  invalidateSettingsCache();
  return getSettingsLive({ force: true, db });
}

async function getPlansLive({ force = false, includeInactive = false, db = null } = {}) {
  const now = Date.now();
  if (!includeInactive && !force && _cache.plans.value && (now - _cache.plans.ts) < LIVE_CACHE_TTL_MS) {
    return _cache.plans.value;
  }

  let plans = null;
  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive()) {
    try {
      const docs = includeInactive
        ? await listCollection('plans', 100)
        : await runQuery({
            from: [{ collectionId: 'plans' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'is_active' },
                op: 'EQUAL',
                value: { integerValue: '1' },
              },
            },
          });
      plans = docs
        .map((d) => ({
          id: d._id,
          firestore_id: d._id,
          name: String(d.name || ''),
          duration: String(d.duration || '1h'),
          speed_limit: String(d.speed_limit || '2M/3M'),
          price: Number(d.price || 0),
          data_limit: d.data_limit || null,
          shared_users: Number(d.shared_users || 1),
          profile_name: String(d.profile_name || 'default'),
          description: String(d.description || ''),
          is_active: Number(d.is_active ?? 1),
          created_at: d.created_at || null,
        }))
        .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));

      if (!includeInactive) {
        _cache.plans = { value: plans, ts: now };
      }
      return plans;
    } catch (err) {
      console.error('[FirestoreStore] getPlansLive fallback:', err.message);
      if (!includeInactive && _cache.plans.value) return _cache.plans.value;
    }
  } else if (!includeInactive && _cache.plans.value) {
    return _cache.plans.value;
  }

  if (db) {
    const sql = includeInactive
      ? 'SELECT * FROM plans ORDER BY price ASC'
      : 'SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC';
    plans = db.prepare(sql).all();
    if (!includeInactive) _cache.plans = { value: plans, ts: now };
    return plans;
  }

  return [];
}

function findPlanForVoucher(plans, voucher) {
  if (!Array.isArray(plans) || !voucher) return null;
  const pid = String(voucher.plan_id || '');
  const pName = String(voucher.plan_name || '').trim().toLowerCase();
  return (
    plans.find((p) => String(p.id) === pid || String(p.firestore_id) === pid) ||
    plans.find((p) => String(p.name || '').trim().toLowerCase() === pName) ||
    null
  );
}

async function getKiosksLive({ force = false, db = null } = {}) {
  const now = Date.now();
  if (!force && _cache.kiosks.value && (now - _cache.kiosks.ts) < LIVE_CACHE_TTL_MS) {
    return _cache.kiosks.value;
  }

  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive()) {
    try {
      const docs = await runQuery({
        from: [{ collectionId: 'kiosks' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'is_active' },
            op: 'EQUAL',
            value: { integerValue: '1' },
          },
        },
      });
      const list = docs
        .map((d) => ({ id: d._id, ...d }))
        .sort((a, b) => Number(a.sort_order ?? 99) - Number(b.sort_order ?? 99));
      _cache.kiosks = { value: list, ts: now };
      return list;
    } catch (err) {
      console.error('[FirestoreStore] getKiosksLive fallback:', err.message);
      if (_cache.kiosks.value) return _cache.kiosks.value;
    }
  } else if (_cache.kiosks.value) {
    return _cache.kiosks.value;
  }

  if (db) {
    const rows = db.prepare('SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
    _cache.kiosks = { value: rows, ts: now };
    return rows;
  }
  return [];
}

// -------------------- Queue & Pool Management --------------------

function toQueueOp(raw) {
  if (!raw || !raw.op_id) return null;
  return {
    op_id: String(raw.op_id),
    action: String(raw.action || ''),
    code: raw.code ? String(raw.code) : '',
    profile_name: raw.profile_name ? String(raw.profile_name) : 'default',
    speed_limit: raw.speed_limit ? String(raw.speed_limit) : '',
    duration: raw.duration ? String(raw.duration) : '',
    shared_users: Number(raw.shared_users || 1),
    comment: raw.comment ? String(raw.comment) : '',
    pool_type: raw.pool_type ? String(raw.pool_type) : '',
    mac: raw.mac ? String(raw.mac) : '',
    address: raw.address ? String(raw.address) : '',
    bind_type: raw.bind_type ? String(raw.bind_type) : 'bypassed',
    plan_id: raw.plan_id ? String(raw.plan_id) : '',
    plan_name: raw.plan_name ? String(raw.plan_name) : '',
    status: String(raw.status || 'pending'),
    created_at: raw.created_at || new Date().toISOString(),
  };
}

async function enqueueMikrotikOp(opInput) {
  const op = toQueueOp(opInput);
  if (!op) return null;

  _queueState.ops.set(op.op_id, op);

  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive()) {
    try {
      await setDoc(`/mikrotik_queue/${encodeURIComponent(op.op_id)}`, {
        ...op,
        status: 'pending',
      }, { merge: false });
    } catch (err) {
      console.warn('[FirestoreStore] enqueueMikrotikOp Firestore warn (cola en memoria activa):', err.message);
    }
  }
  return op;
}

async function pullPendingQueueFromFirestore() {
  if (!hasServiceAccount() || isFirestoreQuotaBackoffActive()) return;
  const docs = await runQuery({
    from: [{ collectionId: 'mikrotik_queue' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'status' },
        op: 'EQUAL',
        value: { stringValue: 'pending' },
      },
    },
    limit: 60,
  });
  for (const d of docs) {
    const op = toQueueOp(d);
    if (op) _queueState.ops.set(op.op_id, op);
  }
  _queueState.lastFirestorePullMs = Date.now();
}

async function getPendingMikrotikOps({ forceFirestore = false, db = null } = {}) {
  const now = Date.now();
  const stale = !_queueState.initialized || (now - _queueState.lastFirestorePullMs) >= QUEUE_STALE_POLL_MS;
  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive() && (forceFirestore || stale)) {
    _queueState.initialized = true;
    _queueState.lastFirestorePullMs = now;
    try {
      await pullPendingQueueFromFirestore();
    } catch (err) {
      console.error('[FirestoreStore] pullPendingQueue err:', err.message);
    }
  }

  // Verificar inventario pre-provisionado únicamente al arranque y cada 6h (los consumos ya reponen 1x1)
  const poolDue = _queueState.lastPoolCheckMs === 0 || (now - _queueState.lastPoolCheckMs) >= POOL_RESTOCK_POLL_MS;
  if (hasServiceAccount() && !isFirestoreQuotaBackoffActive() && poolDue) {
    _queueState.lastPoolCheckMs = now;
    ensurePoolsStocked({ db }).catch((err) => {
      console.error('[FirestoreStore] background pool stock err:', err.message);
    });
  }

  return Array.from(_queueState.ops.values())
    .filter((o) => o.status === 'pending')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, MAX_PENDING_OPS_PER_BATCH);
}

async function ackMikrotikOps({ opIds = [], voucherCodes = [], payPassCodes = [], db = null } = {}) {
  const nowIso = new Date().toISOString();

  for (const id of opIds) {
    _queueState.ops.delete(id);
  }

  if (db && voucherCodes.length > 0) {
    try {
      const upd = db.prepare('UPDATE vouchers SET mikrotik_synced = 1 WHERE code = ?');
      for (const code of voucherCodes) upd.run(code);
    } catch (_) { /* ignore */ }
  }

  if (!hasServiceAccount()) return;

  await Promise.allSettled([
    ...opIds.map((opId) => deleteDoc(`/mikrotik_queue/${encodeURIComponent(opId)}`)),
    ...voucherCodes.map((code) =>
      setDoc(`/vouchers/${encodeURIComponent(code)}`, { mikrotik_synced: true, synced_at: nowIso })
    ),
    ...payPassCodes.map((code) =>
      setDoc(`/payment_pass_pool/${encodeURIComponent(code)}`, { mikrotik_synced: true, synced_at: nowIso })
    ),
  ]);
}

async function enqueuePlanPoolRefill(plan, countNeeded) {
  if (!plan || countNeeded <= 0) return 0;
  const profileName = resolveEffectiveProfileName(plan);
  let created = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < countNeeded; i++) {
    let code = generateRandomCode('WSP-', 5);
    // Guarantee non-collision via createDoc exists=false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await createDoc('vouchers', {
          code,
          plan_id: String(plan.id),
          plan_name: String(plan.name),
          duration: String(plan.duration),
          speed_limit: String(plan.speed_limit || '2M/3M'),
          price: Number(plan.price || 0),
          shared_users: Number(plan.shared_users || 1),
          profile_name: profileName,
          batch_id: 'BOT-POOL',
          pool_type: 'bot_pool',
          status: 'available',
          mikrotik_synced: false,
          created_at: nowIso,
        }, code);
        break;
      } catch (err) {
        if (err.code === 'PRECONDITION_FAILED') {
          code = generateRandomCode('WSP-', 5);
          continue;
        }
        throw err;
      }
    }

    await enqueueMikrotikOp({
      op_id: `CREATE_WSP_${code}`,
      action: 'create_user',
      code,
      profile_name: profileName,
      speed_limit: String(plan.speed_limit || '2M/3M'),
      duration: String(plan.duration),
      shared_users: Number(plan.shared_users || 1),
      comment: `WSP-POOL ${plan.name}`,
      pool_type: 'bot_pool',
      plan_id: String(plan.id),
      plan_name: String(plan.name),
      created_at: nowIso,
    });
    created++;
  }
  return created;
}

async function enqueuePayPassRefill(countNeeded) {
  if (countNeeded <= 0) return 0;
  let created = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < countNeeded; i++) {
    let code = generateRandomCode('P', 5);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await createDoc('payment_pass_pool', {
          code,
          status: 'ready',
          mikrotik_synced: false,
          created_at: nowIso,
        }, code);
        break;
      } catch (err) {
        if (err.code === 'PRECONDITION_FAILED') {
          code = generateRandomCode('P', 5);
          continue;
        }
        throw err;
      }
    }

    await enqueueMikrotikOp({
      op_id: `CREATE_PAY_${code}`,
      action: 'create_pay_pass',
      code,
      profile_name: 'royota-pay',
      speed_limit: '1M/1M',
      duration: '3m',
      shared_users: 1,
      comment: `PAYPOOL ${code}`,
      pool_type: 'pay_pass',
      created_at: nowIso,
    });
    created++;
  }
  return created;
}

async function ensurePoolsStocked({ force = false, db = null } = {}) {
  if (!hasServiceAccount()) return { botCreated: 0, payCreated: 0 };

  const now = Date.now();
  if (!force && _queueState.lastPoolCheckMs > 0 && (now - _queueState.lastPoolCheckMs) < 15000 && _queueState.initialized) {
    // caller can explicitly set force=true when claiming/booting
  }

  let botCreated = 0;
  let payCreated = 0;

  try {
    const [plans, poolVouchers, payDocs] = await Promise.all([
      getPlansLive({ db }),
      runQuery({
        from: [{ collectionId: 'vouchers' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'pool_type' },
            op: 'EQUAL',
            value: { stringValue: 'bot_pool' },
          },
        },
        limit: 120,
      }),
      runQuery({
        from: [{ collectionId: 'payment_pass_pool' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: 'ready' },
          },
        },
        limit: 30,
      }),
    ]);

    for (const plan of plans) {
      const availableForPlan = poolVouchers.filter(
        (v) => v.status === 'available' && String(v.plan_id) === String(plan.id)
      );
      const missing = BOT_POOL_TARGET_PER_PLAN - availableForPlan.length;
      if (missing > 0) {
        botCreated += await enqueuePlanPoolRefill(plan, missing);
      }
    }

    const readyPay = payDocs.filter((p) => p.status === 'ready');
    const missingPay = PAY_POOL_TARGET - readyPay.length;
    if (missingPay > 0) {
      payCreated += await enqueuePayPassRefill(missingPay);
    }

    _queueState.lastPoolCheckMs = Date.now();
  } catch (err) {
    console.error('[FirestoreStore] ensurePoolsStocked err:', err.message);
  }

  return { botCreated, payCreated };
}

/**
 * Claims a pre-provisioned WSP- voucher from Firestore bot_pool (0s router latency when synced).
 * Falls back to queueing a fresh WSP- voucher immediately if pool temporarily empty.
 */
async function claimBotPoolVoucherSSOT({
  plan,
  senderPhone,
  paymentId = null,
  paymentMethod = 'whatsapp_bot',
  db = null,
} = {}) {
  const nowIso = new Date().toISOString();
  const todayBogota = getBogotaDateStr();
  const profileName = resolveEffectiveProfileName(plan);

  if (hasServiceAccount()) {
    try {
      const poolVouchers = await runQuery({
        from: [{ collectionId: 'vouchers' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'pool_type' },
            op: 'EQUAL',
            value: { stringValue: 'bot_pool' },
          },
        },
        limit: 80,
      });

      const candidates = poolVouchers
        .filter((v) => v.status === 'available' && String(v.plan_id) === String(plan.id))
        .sort((a, b) => Number(Boolean(b.mikrotik_synced)) - Number(Boolean(a.mikrotik_synced)));

      for (const candidate of candidates) {
        try {
          const claimed = await setDoc(
            `/vouchers/${encodeURIComponent(candidate.code)}`,
            {
              status: 'sold',
              is_sold: true,
              sold_at: nowIso,
              payment_method: paymentMethod,
              customer_phone: String(senderPhone || ''),
              payment_id: paymentId ? String(paymentId) : null,
            },
            { merge: true, updateTime: candidate._updateTime }
          );

          await createDoc('sales', {
            voucher_id: claimed.code,
            voucher_code: claimed.code,
            plan_id: String(plan.id),
            plan_name: String(plan.name),
            amount: Number(plan.price || 0),
            payment_method: paymentMethod,
            customer_phone: String(senderPhone || ''),
            date: todayBogota,
            notes: `Venta automática Bot WhatsApp (${senderPhone || ''})`,
            created_at: nowIso,
          });

          if (!candidate.mikrotik_synced) {
            await enqueueMikrotikOp({
              op_id: `CREATE_WSP_${claimed.code}`,
              action: 'create_user',
              code: claimed.code,
              profile_name: profileName,
              speed_limit: String(plan.speed_limit || '2M/3M'),
              duration: String(plan.duration),
              shared_users: Number(plan.shared_users || 1),
              comment: `WSP-SOLD ${senderPhone || ''}`,
              pool_type: 'bot_pool',
              plan_id: String(plan.id),
              plan_name: String(plan.name),
              created_at: nowIso,
            });
          }

          // Asynchronously replenish back to target
          enqueuePlanPoolRefill(plan, 1).catch(() => {});

          return {
            code: claimed.code,
            instantReady: Boolean(candidate.mikrotik_synced),
            voucher: claimed,
          };
        } catch (err) {
          if (err.code === 'PRECONDITION_FAILED') continue;
          throw err;
        }
      }

      // Pool empty: create on demand and trigger pool backfill
      const code = generateRandomCode('WSP-', 5);
      const created = await createDoc('vouchers', {
        code,
        plan_id: String(plan.id),
        plan_name: String(plan.name),
        duration: String(plan.duration),
        speed_limit: String(plan.speed_limit || '2M/3M'),
        price: Number(plan.price || 0),
        shared_users: Number(plan.shared_users || 1),
        profile_name: profileName,
        batch_id: 'BOT-WSP',
        pool_type: 'bot_pool',
        status: 'sold',
        is_sold: true,
        sold_at: nowIso,
        payment_method: paymentMethod,
        customer_phone: String(senderPhone || ''),
        payment_id: paymentId ? String(paymentId) : null,
        mikrotik_synced: false,
        created_at: nowIso,
      }, code);

      await enqueueMikrotikOp({
        op_id: `CREATE_WSP_${code}`,
        action: 'create_user',
        code,
        profile_name: profileName,
        speed_limit: String(plan.speed_limit || '2M/3M'),
        duration: String(plan.duration),
        shared_users: Number(plan.shared_users || 1),
        comment: `WSP-SOLD ${senderPhone || ''}`,
        pool_type: 'bot_pool',
        plan_id: String(plan.id),
        plan_name: String(plan.name),
        created_at: nowIso,
      });

      await createDoc('sales', {
        voucher_id: code,
        voucher_code: code,
        plan_id: String(plan.id),
        plan_name: String(plan.name),
        amount: Number(plan.price || 0),
        payment_method: paymentMethod,
        customer_phone: String(senderPhone || ''),
        date: todayBogota,
        notes: `Venta automática Bot WhatsApp (${senderPhone || ''})`,
        created_at: nowIso,
      });

      enqueuePlanPoolRefill(plan, BOT_POOL_TARGET_PER_PLAN).catch(() => {});

      return { code, instantReady: false, voucher: created };
    } catch (err) {
      console.error('[FirestoreStore] claimBotPoolVoucherSSOT err:', err.message);
    }
  }

  // SQLite-only fallback (dev / tests)
  const code = generateRandomCode('WSP-', 5);
  if (db) {
    const planIdNum = Number(plan.id) || 1;
    const bInfo = db.prepare(`
      INSERT INTO voucher_batches (plan_id, quantity, prefix, note)
      VALUES (?, 1, 'WSP-', ?)
    `).run(planIdNum, `Bot WhatsApp (${senderPhone})`);
    const vInfo = db.prepare(`
      INSERT INTO vouchers (code, plan_id, batch_id, status, sold_at, mikrotik_synced)
      VALUES (?, ?, ?, 'sold', CURRENT_TIMESTAMP, 0)
    `).run(code, planIdNum, bInfo.lastInsertRowid);
    db.prepare(`
      INSERT INTO sales (voucher_id, plan_id, amount, payment_method, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(vInfo.lastInsertRowid, planIdNum, Number(plan.price || 0), paymentMethod, `Bot WhatsApp (${senderPhone})`);
  }
  return { code, instantReady: false, voucher: { code } };
}

// -------------------- Portal Activation & Expiration SSOT --------------------

function computeRemainingSeconds(expiresAtIso) {
  if (!expiresAtIso) return 0;
  const diff = Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000);
  return diff > 0 ? diff : 0;
}

async function getVoucherSSOT(code, db = null, { throwOnOutage = false } = {}) {
  const cleanCode = normalizeCode(code);
  if (!cleanCode) return null;

  let firestoreErr = null;
  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/vouchers/${encodeURIComponent(cleanCode)}`);
      if (doc) return doc;
    } catch (err) {
      firestoreErr = err;
      console.error('[FirestoreStore] getVoucherSSOT err:', err.message);
    }
  }

  if (db) {
    const row = db.prepare(`
      SELECT v.*, p.duration AS plan_duration, p.speed_limit AS plan_speed,
             p.name AS plan_name, p.profile_name, p.shared_users, p.price AS plan_price
      FROM vouchers v
      LEFT JOIN plans p ON v.plan_id = p.id
      WHERE v.code = ?
    `).get(cleanCode);
    if (row) {
      return {
        ...row,
        duration: row.plan_duration || row.duration,
        speed_limit: row.plan_speed || row.speed_limit,
        price: row.plan_price ?? row.price ?? 0,
        _fromSqlite: true,
      };
    }
  }

  if (firestoreErr && throwOnOutage) {
    const outage = new Error('Base de datos temporalmente no disponible');
    outage.status = 503;
    outage.isQuotaExceeded = Boolean(firestoreErr.isQuotaExceeded);
    throw outage;
  }

  return null;
}

async function activateVoucherSSOT({ code, mac = null, db = null } = {}) {
  const cleanCode = normalizeCode(code);
  if (!cleanCode) {
    return { ok: false, status: 400, error: 'Código de ficha inválido.' };
  }
  const cleanMac = mac ? normalizeMac(mac) : null;

  // Attempt up to 2 tries on Firestore precondition races
  let firestoreOutageErr = null;
  if (hasServiceAccount()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let v = null;
      try {
        v = await getDoc(`/vouchers/${encodeURIComponent(cleanCode)}`);
      } catch (err) {
        firestoreOutageErr = err;
        console.error('[FirestoreStore] activate read err:', err.message);
        break; // fallback to SQLite only on Firestore outage
      }

      // If missing in Firestore, check SQLite before returning 404
      if (!v && db) {
        const sqlRow = db.prepare(`
          SELECT v.*, p.duration AS plan_duration, p.speed_limit AS plan_speed,
                 p.name AS plan_name, p.profile_name, p.shared_users, p.price AS plan_price
          FROM vouchers v
          LEFT JOIN plans p ON v.plan_id = p.id
          WHERE v.code = ?
        `).get(cleanCode);
        if (sqlRow) {
          v = {
            ...sqlRow,
            duration: sqlRow.plan_duration || sqlRow.duration || '1h',
            speed_limit: sqlRow.plan_speed || sqlRow.speed_limit || '2M/3M',
            price: Number(sqlRow.plan_price ?? sqlRow.price ?? 0),
            _fromSqliteOnly: true,
          };
        }
      }

      if (!v) {
        return { ok: false, status: 404, error: 'Ficha no encontrada. Verifica el código e intenta nuevamente.' };
      }

      if (v.status === 'revoked') {
        return { ok: false, status: 400, error: 'Esta ficha ha sido revocada.' };
      }

      if (v.status === 'expired') {
        return { ok: false, status: 400, error: 'Esta ficha ya ha expirado.' };
      }

      const plans = await getPlansLive({ db });
      const matchedPlan = findPlanForVoucher(plans, v);
      const duration = String(v.duration || matchedPlan?.duration || '1h');
      const speedLimit = String(v.speed_limit || matchedPlan?.speed_limit || '2M/3M');
      const planName = String(v.plan_name || matchedPlan?.name || 'WiFi');
      const price = Number(v.price ?? matchedPlan?.price ?? 0);
      const sharedUsers = Number(v.shared_users ?? matchedPlan?.shared_users ?? 1);
      const profileName = resolveEffectiveProfileName({
        name: planName,
        profile_name: v.profile_name || matchedPlan?.profile_name || 'default',
        speed_limit: speedLimit,
      });

      const needsMikrotikSync = v.mikrotik_synced !== true && v.mikrotik_synced !== 1;

      if (v.status === 'active') {
        if (isVoucherExpiredSSOT(v)) {
          const expNow = new Date().toISOString();
          await setDoc(`/vouchers/${encodeURIComponent(cleanCode)}`, {
            status: 'expired',
            expired_at: expNow,
            expire_reason: 'medianoche_estricta',
          }).catch(() => {});
          return { ok: false, status: 400, error: 'Esta ficha ya ha expirado.' };
        }

        // Valid active session -> ensure user exists on MikroTik if never ACKed, and allow re-login
        if (needsMikrotikSync) {
          await enqueueMikrotikOp({
            op_id: `CREATE_${cleanCode}`,
            action: 'create_user',
            code: cleanCode,
            profile_name: profileName,
            speed_limit: speedLimit,
            duration,
            shared_users: sharedUsers,
            comment: 'Ficha Portal Reingreso',
            plan_id: String(v.plan_id || ''),
            plan_name: planName,
            created_at: new Date().toISOString(),
          }).catch(() => {});
        }

        const remainingSeconds = computeRemainingSeconds(v.expires_at);
        if (cleanMac) {
          unblockWaTrialSSOT({ mac: cleanMac, db }).catch(() => {});
        }
        return {
          ok: true,
          reused: true,
          queuedForMikrotik: needsMikrotikSync,
          voucher: {
            code: cleanCode,
            status: 'active',
            plan_name: planName,
            duration,
            speed_limit: speedLimit,
            profile_name: profileName,
            activated_at: v.activated_at,
            expires_at: v.expires_at,
            remainingSeconds,
          },
        };
      }

      if (v.status !== 'available' && v.status !== 'sold') {
        return { ok: false, status: 400, error: 'Esta ficha no está disponible para activación.' };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAtIso = computeVoucherExpiryIso(now, duration);

      const updateFields = {
        code: cleanCode,
        status: 'active',
        activated_at: nowIso,
        expires_at: expiresAtIso,
        is_sold: true,
        sold_at: v.sold_at || nowIso,
        plan_id: String(v.plan_id || matchedPlan?.id || ''),
        plan_name: planName,
        duration,
        speed_limit: speedLimit,
        price,
        ...(cleanMac ? { mac_address: cleanMac } : {}),
      };

      try {
        if (v._fromSqliteOnly) {
          await createDoc('vouchers', updateFields, cleanCode);
        } else {
          await setDoc(
            `/vouchers/${encodeURIComponent(cleanCode)}`,
            updateFields,
            v._updateTime ? { merge: true, updateTime: v._updateTime } : { merge: true }
          );
        }
      } catch (err) {
        if (err.code === 'PRECONDITION_FAILED' && attempt === 0) continue;
        throw err;
      }

      // Bill only if transitioning from 'available'
      if (v.status === 'available') {
        await createDoc('sales', {
          voucher_id: cleanCode,
          voucher_code: cleanCode,
          plan_id: String(v.plan_id || matchedPlan?.id || ''),
          plan_name: planName,
          amount: price,
          payment_method: 'activacion_portal',
          date: getBogotaDateStr(now),
          notes: 'Auto-facturación por activación en portal',
          created_at: nowIso,
        }).catch((err) => console.error('[FirestoreStore] sale record err:', err.message));
      }

      if (cleanMac) {
        await unblockWaTrialSSOT({ mac: cleanMac, db }).catch(() => {});
      }

      if (needsMikrotikSync) {
        await enqueueMikrotikOp({
          op_id: `CREATE_${cleanCode}`,
          action: 'create_user',
          code: cleanCode,
          profile_name: profileName,
          speed_limit: speedLimit,
          duration,
          shared_users: sharedUsers,
          comment: 'Ficha Portal',
          plan_id: String(v.plan_id || ''),
          plan_name: planName,
          created_at: nowIso,
        }).catch(() => {});
      }

      // Mirror in SQLite best-effort
      if (db) {
        try {
          db.prepare(`
            UPDATE vouchers
            SET status = 'active', activated_at = ?, expires_at = ?,
                sold_at = COALESCE(sold_at, ?)
            WHERE code = ?
          `).run(nowIso, expiresAtIso, nowIso, cleanCode);
        } catch (_) { /* ignore */ }
      }

      return {
        ok: true,
        reused: false,
        queuedForMikrotik: needsMikrotikSync,
        voucher: {
          code: cleanCode,
          status: 'active',
          plan_name: planName,
          duration,
          speed_limit: speedLimit,
          profile_name: profileName,
          activated_at: nowIso,
          expires_at: expiresAtIso,
          remainingSeconds: computeRemainingSeconds(expiresAtIso),
        },
      };
    }
  }

  // SQLite-only fallback
  if (!db) {
    return {
      ok: false,
      status: 503,
      errorCode: 'FIRESTORE_UNAVAILABLE',
      error: 'Servicio temporalmente no disponible.',
    };
  }

  const row = db.prepare(`
    SELECT v.*, p.duration, p.speed_limit, p.name AS plan_name,
           p.shared_users, p.profile_name, p.price
    FROM vouchers v
    LEFT JOIN plans p ON v.plan_id = p.id
    WHERE v.code = ?
  `).get(cleanCode);

  if (!row) {
    if (firestoreOutageErr) {
      return {
        ok: false,
        status: 503,
        errorCode: 'FIRESTORE_UNAVAILABLE',
        error: 'Base de datos temporalmente saturada. Intentando validación directa con el router...',
      };
    }
    return { ok: false, status: 404, error: 'Ficha no encontrada. Verifica el código e intenta nuevamente.' };
  }
  if (row.status === 'revoked') {
    return { ok: false, status: 400, error: 'Esta ficha ha sido revocada.' };
  }
  if (row.status === 'expired') {
    return { ok: false, status: 400, error: 'Esta ficha ya ha expirado.' };
  }
  if (row.status === 'active') {
    if (isVoucherExpiredSSOT(row)) {
      db.prepare("UPDATE vouchers SET status = 'expired' WHERE id = ?").run(row.id);
      return { ok: false, status: 400, error: 'Esta ficha ya ha expirado.' };
    }
    return {
      ok: true,
      reused: true,
      voucher: {
        code: cleanCode,
        status: 'active',
        plan_name: row.plan_name || 'WiFi',
        duration: row.duration || '1h',
        speed_limit: row.speed_limit || '2M/3M',
        activated_at: row.activated_at,
        expires_at: row.expires_at,
        remainingSeconds: computeRemainingSeconds(row.expires_at),
      },
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = computeVoucherExpiryIso(now, row.duration || '1h');
  const prevStatus = row.status;

  db.transaction(() => {
    db.prepare(`
      UPDATE vouchers
      SET status = 'active',
          activated_at = ?,
          expires_at = ?,
          sold_at = COALESCE(sold_at, ?)
      WHERE id = ?
    `).run(nowIso, expiresAtIso, nowIso, row.id);

    if (prevStatus === 'available') {
      db.prepare(`
        INSERT INTO sales (voucher_id, plan_id, amount, payment_method, notes)
        VALUES (?, ?, ?, 'activacion_portal', 'Auto-facturación por activación en portal')
      `).run(row.id, row.plan_id, row.price || 0);
    }

    if (cleanMac) {
      db.prepare("UPDATE wa_trials SET attempts = 0, blocked = 0, unblocked = 1, updated_at = datetime('now') WHERE mac = ?").run(cleanMac);
    }
  })();

  return {
    ok: true,
    reused: false,
    voucher: {
      code: cleanCode,
      status: 'active',
      plan_name: row.plan_name || 'WiFi',
      duration: row.duration || '1h',
      speed_limit: row.speed_limit || '2M/3M',
      activated_at: nowIso,
      expires_at: expiresAtIso,
      remainingSeconds: computeRemainingSeconds(expiresAtIso),
    },
  };
}

async function expireStaleVouchersSSOT(db = null, { skipFirestore = false } = {}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiredCodes = [];

  if (db) {
    try {
      const candidates = db.prepare(`
        SELECT id, code, activated_at, expires_at, status, mikrotik_synced
        FROM vouchers
        WHERE status = 'active'
      `).all();
      const stale = candidates.filter((v) => isVoucherExpiredSSOT(v, now));
      if (stale.length > 0) {
        const upd = db.prepare("UPDATE vouchers SET status = 'expired' WHERE id = ?");
        db.transaction(() => {
          for (const v of stale) {
            upd.run(v.id);
            expiredCodes.push(v.code);
          }
        })();
        for (const v of stale) {
          if (v.mikrotik_synced) {
            await enqueueMikrotikOp({
              op_id: `REMOVE_${v.code}`,
              action: 'remove_user',
              code: v.code,
              created_at: nowIso,
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[FirestoreStore] SQLite expire check err:', err.message);
    }
  }

  if (hasServiceAccount() && !skipFirestore && !isFirestoreQuotaBackoffActive()) {
    try {
      const activeDocs = await runQuery({
        from: [{ collectionId: 'vouchers' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: 'active' },
          },
        },
        limit: 200,
      });

      const staleFs = activeDocs.filter((v) => isVoucherExpiredSSOT(v, now));
      for (const v of staleFs) {
        await setDoc(`/vouchers/${encodeURIComponent(v.code)}`, {
          status: 'expired',
          expired_at: nowIso,
          expire_reason: 'medianoche_o_tiempo',
        }).catch(() => {});
        if (!expiredCodes.includes(v.code)) expiredCodes.push(v.code);
        await enqueueMikrotikOp({
          op_id: `REMOVE_${v.code}`,
          action: 'remove_user',
          code: v.code,
          created_at: nowIso,
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[FirestoreStore] Firestore expire check err:', err.message);
    }
  }

  return expiredCodes;
}

// -------------------- Temporary Payment Pass (Replaces Trial Bypass) --------------------

async function getWaTrialStatusSSOT({ mac, db = null } = {}) {
  const cleanMac = normalizeMac(mac);
  if (!cleanMac) return { attempts: 0, remaining: TRIAL_MAX_ATTEMPTS_PER_DAY, blocked: false };

  const today = getBogotaDateStr();

  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/wa_trials/${encodeURIComponent(cleanMac)}`);
      if (!doc) return { attempts: 0, remaining: TRIAL_MAX_ATTEMPTS_PER_DAY, blocked: false };
      const sameDay = !doc.last_date || doc.last_date === today;
      const attempts = sameDay ? Number(doc.attempts || 0) : 0;
      const blocked = sameDay && (Boolean(doc.blocked) || attempts >= TRIAL_MAX_ATTEMPTS_PER_DAY);
      return {
        attempts,
        remaining: Math.max(0, TRIAL_MAX_ATTEMPTS_PER_DAY - attempts),
        blocked,
      };
    } catch (err) {
      console.error('[FirestoreStore] getWaTrialStatus err:', err.message);
    }
  }

  if (db) {
    const row = db.prepare('SELECT attempts, blocked FROM wa_trials WHERE mac = ? AND date_str = ?').get(cleanMac, today);
    if (row) {
      const attempts = Number(row.attempts || 0);
      return {
        attempts,
        remaining: Math.max(0, TRIAL_MAX_ATTEMPTS_PER_DAY - attempts),
        blocked: row.blocked === 1 || attempts >= TRIAL_MAX_ATTEMPTS_PER_DAY,
      };
    }
  }
  return { attempts: 0, remaining: TRIAL_MAX_ATTEMPTS_PER_DAY, blocked: false };
}

async function unblockWaTrialSSOT({ mac, db = null } = {}) {
  const cleanMac = normalizeMac(mac);
  if (!cleanMac) return;
  const nowIso = new Date().toISOString();

  if (db) {
    try {
      db.prepare("UPDATE wa_trials SET attempts = 0, blocked = 0, unblocked = 1, updated_at = datetime('now') WHERE mac = ?").run(cleanMac);
    } catch (_) { /* ignore */ }
  }

  if (hasServiceAccount()) {
    await setDoc(`/wa_trials/${encodeURIComponent(cleanMac)}`, {
      attempts: 0,
      blocked: false,
      unblocked: true,
      unblocked_at: nowIso,
    }).catch(() => {});
  }
}

async function requestTempPaymentPassSSOT({ mac, db = null } = {}) {
  const cleanMac = normalizeMac(mac);
  if (!cleanMac) {
    return { allowed: false, status: 400, reason: 'INVALID_MAC', error: 'Dirección MAC inválida.' };
  }

  const settings = await getSettingsLive({ db });
  if (settings.online_purchase_active === '0') {
    return {
      allowed: false,
      status: 403,
      reason: 'ONLINE_PAUSED',
      error: 'La compra automática en línea está pausada temporalmente. Adquiere tu ficha en las casetas autorizadas.',
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const today = getBogotaDateStr(now);

  // Check active/existing temp pass within 3m window first so user doesn't waste an attempt on double click
  let doc = null;
  if (hasServiceAccount()) {
    doc = await getDoc(`/wa_trials/${encodeURIComponent(cleanMac)}`);
    if (
      doc &&
      doc.last_date === today &&
      doc.temp_code &&
      doc.temp_expires_at &&
      new Date(doc.temp_expires_at).getTime() > (now.getTime() + 20000)
    ) {
      return {
        allowed: true,
        reused: true,
        tempCode: doc.temp_code,
        ready: true,
        attempts: Number(doc.attempts || 1),
        remaining: Math.max(0, TRIAL_MAX_ATTEMPTS_PER_DAY - Number(doc.attempts || 1)),
        expiresAt: doc.temp_expires_at,
      };
    }

    const prevAttempts = doc && doc.last_date === today ? Number(doc.attempts || 0) : 0;
    const isBlocked = doc && doc.last_date === today && (Boolean(doc.blocked) || prevAttempts >= TRIAL_MAX_ATTEMPTS_PER_DAY);
    if (isBlocked) {
      return {
        allowed: false,
        status: 403,
        reason: 'TRIAL_LIMIT_EXCEEDED',
        attempts: prevAttempts,
        remaining: 0,
        error: 'Límite diario de pases de pago alcanzado en este dispositivo. Compra en taquilla o ingresa tu PIN.',
      };
    }

    // Claim a pre-provisioned payment pass from payment_pass_pool
    let claimedPassCode = null;
    let instantReady = false;
    const readyPasses = await runQuery({
      from: [{ collectionId: 'payment_pass_pool' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'ready' },
        },
      },
      limit: 15,
    });

    readyPasses.sort((a, b) => Number(Boolean(b.mikrotik_synced)) - Number(Boolean(a.mikrotik_synced)));

    for (const p of readyPasses) {
      try {
        await setDoc(
          `/payment_pass_pool/${encodeURIComponent(p.code)}`,
          {
            status: 'claimed',
            mac_address: cleanMac,
            claimed_at: nowIso,
          },
          { merge: true, updateTime: p._updateTime }
        );
        claimedPassCode = p.code;
        instantReady = Boolean(p.mikrotik_synced);
        if (!instantReady) {
          await enqueueMikrotikOp({
            op_id: `CREATE_PAY_${claimedPassCode}`,
            action: 'create_pay_pass',
            code: claimedPassCode,
            profile_name: 'royota-pay',
            speed_limit: '1M/1M',
            duration: '3m',
            shared_users: 1,
            comment: `PAYPOOL ${claimedPassCode}`,
            pool_type: 'pay_pass',
            created_at: nowIso,
          });
        }
        break;
      } catch (err) {
        if (err.code === 'PRECONDITION_FAILED') continue;
        throw err;
      }
    }

    if (!claimedPassCode) {
      claimedPassCode = generateRandomCode('P', 5);
      await createDoc('payment_pass_pool', {
        code: claimedPassCode,
        status: 'claimed',
        mac_address: cleanMac,
        mikrotik_synced: false,
        claimed_at: nowIso,
        created_at: nowIso,
      }, claimedPassCode);

      await enqueueMikrotikOp({
        op_id: `CREATE_PAY_${claimedPassCode}`,
        action: 'create_pay_pass',
        code: claimedPassCode,
        profile_name: 'royota-pay',
        speed_limit: '1M/1M',
        duration: '3m',
        shared_users: 1,
        comment: `PAYPOOL ${claimedPassCode}`,
        pool_type: 'pay_pass',
        created_at: nowIso,
      });
    }

    // Refill 1 pool pass asynchronously
    enqueuePayPassRefill(1).catch(() => {});

    const newAttempts = prevAttempts + 1;
    const tempExpiresAt = new Date(now.getTime() + PAYMENT_PASS_TTL_MS).toISOString();
    await setDoc(`/wa_trials/${encodeURIComponent(cleanMac)}`, {
      attempts: newAttempts,
      blocked: newAttempts >= TRIAL_MAX_ATTEMPTS_PER_DAY,
      unblocked: false,
      last_date: today,
      last_attempt_at: nowIso,
      temp_code: claimedPassCode,
      temp_expires_at: tempExpiresAt,
    });

    if (db) {
      try {
        db.prepare(`
          INSERT INTO wa_trials (mac, date_str, attempts, blocked, unblocked, last_attempt_at, updated_at)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
          ON CONFLICT(mac, date_str) DO UPDATE SET
            attempts = excluded.attempts,
            blocked = excluded.blocked,
            unblocked = 0,
            last_attempt_at = excluded.last_attempt_at,
            updated_at = datetime('now')
        `).run(cleanMac, today, newAttempts, newAttempts >= TRIAL_MAX_ATTEMPTS_PER_DAY ? 1 : 0, nowIso);
      } catch (_) { /* ignore */ }
    }

    return {
      allowed: true,
      reused: false,
      tempCode: claimedPassCode,
      ready: instantReady,
      attempts: newAttempts,
      remaining: Math.max(0, TRIAL_MAX_ATTEMPTS_PER_DAY - newAttempts),
      expiresAt: tempExpiresAt,
    };
  }

  // SQLite-only fallback (local/offline dev)
  if (!db) {
    return { allowed: false, status: 503, error: 'Servicio no disponible' };
  }

  const row = db.prepare('SELECT attempts, blocked FROM wa_trials WHERE mac = ? AND date_str = ?').get(cleanMac, today);
  if (row && (row.blocked === 1 || row.attempts >= TRIAL_MAX_ATTEMPTS_PER_DAY)) {
    return {
      allowed: false,
      status: 403,
      reason: 'TRIAL_LIMIT_EXCEEDED',
      attempts: row.attempts,
      remaining: 0,
      error: 'Límite diario alcanzado.',
    };
  }
  const newAttempts = (row?.attempts || 0) + 1;
  db.prepare(`
    INSERT INTO wa_trials (mac, date_str, attempts, blocked, unblocked, last_attempt_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(mac, date_str) DO UPDATE SET
      attempts = excluded.attempts,
      blocked = excluded.blocked,
      unblocked = 0,
      last_attempt_at = excluded.last_attempt_at,
      updated_at = datetime('now')
  `).run(cleanMac, today, newAttempts, newAttempts >= TRIAL_MAX_ATTEMPTS_PER_DAY ? 1 : 0, nowIso);

  return {
    allowed: true,
    reused: false,
    tempCode: generateRandomCode('P', 5),
    ready: false,
    attempts: newAttempts,
    remaining: Math.max(0, TRIAL_MAX_ATTEMPTS_PER_DAY - newAttempts),
    expiresAt: new Date(now.getTime() + PAYMENT_PASS_TTL_MS).toISOString(),
  };
}

// -------------------- WhatsApp Payments, Strikes & Complaints SSOT --------------------

async function hasDuplicateTransactionRefSSOT({ refCode, db = null } = {}) {
  const cleanRef = String(refCode || '').trim().toUpperCase();
  if (!cleanRef || cleanRef.length < 3) return null;

  if (db) {
    try {
      const local = db.prepare(
        'SELECT id, created_at FROM whatsapp_payments WHERE reference_number = ? LIMIT 1'
      ).get(cleanRef);
      if (local) return local;
    } catch (_) { /* ignore */ }
  }

  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/whatsapp_payments/${encodeURIComponent(cleanRef)}`);
      if (doc) {
        return {
          id: cleanRef,
          created_at: doc.created_at || 'fecha registrada',
        };
      }
    } catch (err) {
      console.error('[FirestoreStore] hasDuplicateRef err:', err.message);
    }
  }
  return null;
}

async function recordWhatsappPaymentSSOT(paymentObj, db = null) {
  const cleanRef = String(paymentObj.reference_number || paymentObj.id || '').trim().toUpperCase();
  const docId = cleanRef || `wp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = paymentObj.created_at || new Date().toISOString();

  if (hasServiceAccount()) {
    await setDoc(`/whatsapp_payments/${encodeURIComponent(docId)}`, {
      reference_number: cleanRef || docId,
      platform: String(paymentObj.platform || 'Daviplata/Bre-B'),
      sender_phone: String(paymentObj.sender_phone || ''),
      amount: Number(paymentObj.amount || 0),
      destination: String(paymentObj.destination || ''),
      voucher_code: String(paymentObj.voucher_code || ''),
      plan_name: String(paymentObj.plan_name || ''),
      created_at: nowIso,
    }, { merge: false }).catch((err) => console.error('[FirestoreStore] recordWhatsappPayment err:', err.message));
  }

  if (db) {
    try {
      db.prepare(`
        INSERT INTO whatsapp_payments (
          reference_number, platform, sender_phone, amount, destination,
          voucher_id, plan_id, raw_analysis
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanRef || docId,
        String(paymentObj.platform || 'Daviplata/Bre-B'),
        String(paymentObj.sender_phone || ''),
        Number(paymentObj.amount || 0),
        String(paymentObj.destination || ''),
        Number(paymentObj.sqlite_voucher_id) || null,
        Number(paymentObj.sqlite_plan_id) || null,
        String(paymentObj.raw_analysis || '{}')
      );
    } catch (_) { /* ignore */ }
  }
  return { id: docId, reference_number: cleanRef || docId, created_at: nowIso };
}

async function getStrikesSSOT(phone, db = null) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return { strikes: 0, blocked_until: null, blocked: false, last_reason: '' };

  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/whatsapp_strikes/${encodeURIComponent(cleanPhone)}`);
      if (doc) {
        const blocked = Boolean(doc.blocked_until && new Date(doc.blocked_until).getTime() > Date.now());
        return {
          strikes: Number(doc.strikes || 0),
          blocked_until: doc.blocked_until || null,
          blocked,
          last_reason: String(doc.last_reason || ''),
        };
      }
      return { strikes: 0, blocked_until: null, blocked: false, last_reason: '' };
    } catch (err) {
      console.error('[FirestoreStore] getStrikes err:', err.message);
    }
  }

  if (db) {
    const row = db.prepare('SELECT strikes, blocked_until, last_reason FROM whatsapp_strikes WHERE phone = ?').get(cleanPhone);
    if (row) {
      const blocked = Boolean(row.blocked_until && new Date(row.blocked_until).getTime() > Date.now());
      return {
        strikes: row.strikes || 0,
        blocked_until: row.blocked_until || null,
        blocked,
        last_reason: String(row.last_reason || ''),
      };
    }
  }
  return { strikes: 0, blocked_until: null, blocked: false, last_reason: '' };
}

async function recordStrikeSSOT(phone, db = null, threshold = 3, reason = '') {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return { strikes: 0, blocked: false, blockedUntil: null };

  const cur = await getStrikesSSOT(cleanPhone, db);
  const newStrikes = cur.strikes + 1;
  const shouldBlock = newStrikes >= threshold;
  const blockedUntil = shouldBlock ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
  const nowIso = new Date().toISOString();
  const cleanReason = String(reason || '').slice(0, 200);

  if (hasServiceAccount()) {
    await setDoc(`/whatsapp_strikes/${encodeURIComponent(cleanPhone)}`, {
      phone: cleanPhone,
      strikes: newStrikes,
      blocked_until: blockedUntil,
      last_reason: cleanReason,
      updated_at: nowIso,
    }).catch((err) => console.error('[FirestoreStore] recordStrike err:', err.message));
  }

  if (db) {
    try {
      db.prepare(`
        INSERT INTO whatsapp_strikes (phone, strikes, blocked_until, last_reason, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(phone) DO UPDATE SET
          strikes = excluded.strikes,
          blocked_until = excluded.blocked_until,
          last_reason = excluded.last_reason,
          updated_at = datetime('now')
      `).run(cleanPhone, newStrikes, blockedUntil, cleanReason);
    } catch (_) { /* ignore */ }
  }

  return { strikes: newStrikes, blocked: shouldBlock, isBlocked: shouldBlock, blockedUntil };
}

async function clearStrikesSSOT(phone, db = null) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return;

  if (hasServiceAccount()) {
    await setDoc(`/whatsapp_strikes/${encodeURIComponent(cleanPhone)}`, {
      phone: cleanPhone,
      strikes: 0,
      blocked_until: null,
      last_reason: 'Pago exitoso verificado',
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  }
  if (db) {
    try {
      db.prepare("UPDATE whatsapp_strikes SET strikes = 0, blocked_until = NULL, last_reason = 'Pago exitoso verificado', updated_at = datetime('now') WHERE phone = ?").run(cleanPhone);
    } catch (_) { /* ignore */ }
  }
}

module.exports = {
  REGEX_CODE,
  REGEX_MAC,
  REGEX_PROFILE,
  REGEX_DURATION,
  REGEX_SPEED,
  BOT_POOL_TARGET_PER_PLAN,
  PAY_POOL_TARGET,
  MAX_PENDING_OPS_PER_BATCH,
  PAYMENT_PASS_TTL_MS,
  TRIAL_MAX_ATTEMPTS_PER_DAY,
  normalizeCode,
  normalizeMac,
  normalizePhone,
  generateRandomCode,
  resolveEffectiveProfileName,
  computeVoucherExpiryIso,
  isVoucherExpiredSSOT,
  decodeDoc,
  getDoc,
  setDoc,
  createDoc,
  deleteDoc,
  runQuery,
  listCollection,
  invalidateSettingsCache,
  invalidatePlansCache,
  invalidateKiosksCache,
  getSettingsLive,
  updateSettingsLive,
  getPlansLive,
  findPlanForVoucher,
  getKiosksLive,
  enqueueMikrotikOp,
  getPendingMikrotikOps,
  ackMikrotikOps,
  ensurePoolsStocked,
  claimBotPoolVoucherSSOT,
  getVoucherSSOT,
  activateVoucherSSOT,
  expireStaleVouchersSSOT,
  getWaTrialStatusSSOT,
  requestTempPaymentPassSSOT,
  unblockWaTrialSSOT,
  hasDuplicateTransactionRefSSOT,
  recordWhatsappPaymentSSOT,
  getStrikesSSOT,
  recordStrikeSSOT,
  clearStrikesSSOT,
};
