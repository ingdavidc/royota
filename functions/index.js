/**
 * functions/index.js
 * ─────────────────────────────────────────────────────────────
 * Backend Serverless para Hotspot Fichas ROYOTA en Firebase.
 */
'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const express   = require('express');
const cors      = require('cors');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');

const mikrotik  = require('./mikrotik');

admin.initializeApp();
const db = admin.firestore();

// Evitar secreto JWT predecible si no está definido en variables de entorno
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.includes('jwt-fichas-royota-secure-key')) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.error('[Functions] ⚠️ JWT_SECRET no configurado en entorno; usando clave efímera aleatoria.');
}
const JWT_EXPIRES_IN = '10h';

const ALLOWED_ORIGINS = [
  'https://royota.dctelematica.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const CHARSETS = {
  numeric: '0123456789',
  alpha:   'ABCDEFGHJKLMNPQRSTUVWXYZ',
  full:    '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
};

function generateCode(length = 8, charsetType = 'full', prefix = '') {
  const chars = CHARSETS[charsetType] || CHARSETS.full;
  let result = prefix ? prefix.toUpperCase() : '';
  const needed = Math.max(length - result.length, 4);
  const maxUsable = 256 - (256 % chars.length);

  while (result.length < length) {
    const bytes = crypto.randomBytes(needed * 2);
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      if (bytes[i] < maxUsable) {
        result += chars[bytes[i] % chars.length];
      }
    }
  }
  return result.toUpperCase();
}

function parseDurationMs(str) {
  if (!str) return 3_600_000;
  const m = String(str).match(/^(\d+)([mhd])$/i);
  if (!m) return 3_600_000;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default:  return 3_600_000;
  }
}

function getBogotaMidnightMs() {
  const bogotaDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return new Date(`${bogotaDateStr}T23:59:59.999-05:00`).getTime();
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado o formato inválido' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.admin = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return next();
  } catch (_) {
    // Fallback: verificar Firebase ID Token si viene del SDK cliente
    admin.auth().verifyIdToken(token)
      .then((decoded) => {
        req.admin = { uid: decoded.uid, username: decoded.email || decoded.uid, role: 'superadmin' };
        next();
      })
      .catch(() => res.status(401).json({ error: 'Token inválido o expirado' }));
  }
}

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
}));
app.use(express.json());

const DEFAULT_SETTINGS = {
  business_name:    'Balneario Río Royota',
  business_slogan:  'El paraíso natural junto al río · Conexión WiFi de alta velocidad',
  whatsapp_number:  '573123456789',
  whatsapp_message: '¡Hola! Estoy en el Balneario Río Royota y deseo comprar una ficha de internet WiFi.',
  info_active:      true,
  info_badge:       'Avisos & Servicios del Balneario',
  info_title:       '¡Bienvenidos al Balneario Río Royota!',
  info_content:     '🌊 Zona de río y piscinas naturales abiertas de 8:00 AM a 6:00 PM.\n🍹 Kioscos, restaurante y venta de bebidas disponibles.\n🎫 Venta de fichas WiFi en Taquilla Principal y Restaurante.\n🌿 Cuidemos el río: por favor deposita los residuos en los contenedores.',
  currency:         'COP',
  currencySymbol:   '$',
};

app.get(['/config', '/settings/public'], async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('general').get();
    const data = doc.exists ? doc.data() : DEFAULT_SETTINGS;
    res.json({
      ...DEFAULT_SETTINGS,
      ...data,
      businessName:   data.business_name || DEFAULT_SETTINGS.business_name,
      currency:       data.currency || 'COP',
      currencySymbol: data.currencySymbol || '$',
    });
  } catch (_) {
    res.json(DEFAULT_SETTINGS);
  }
});

app.get('/settings', authRequired, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('general').get();
    res.json(doc.exists ? doc.data() : DEFAULT_SETTINGS);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/settings', authRequired, async (req, res) => {
  try {
    await db.collection('settings').doc('general').set(req.body, { merge: true });
    const updated = (await db.collection('settings').doc('general').get()).data();
    res.json({ message: 'Configuración guardada en Firestore', settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/plans', async (req, res) => {
  try {
    const snap = await db.collection('plans').where('is_active', '!=', 0).get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/plans/all', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('plans').get();
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/plans', authRequired, async (req, res) => {
  try {
    const { name, duration, speed_limit, price, shared_users, sort_order, description } = req.body;
    if (!name || !duration || !speed_limit || price == null) {
      return res.status(400).json({ error: 'Campos requeridos incompletos' });
    }
    const docRef = await db.collection('plans').add({
      name:         name.trim(),
      duration:     duration.toLowerCase().trim(),
      speed_limit:  speed_limit.trim(),
      price:        parseFloat(price),
      shared_users: parseInt(shared_users, 10) || 1,
      sort_order:   parseInt(sort_order, 10) || 0,
      description:  description || '',
      is_active:    1,
      created_at:   new Date().toISOString(),
    });
    res.status(201).json({ id: docRef.id, message: 'Plan creado con éxito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/plans/:id', authRequired, async (req, res) => {
  try {
    const { name, duration, speed_limit, price, shared_users, sort_order, description, is_active } = req.body;
    await db.collection('plans').doc(req.params.id).update({
      name:         name.trim(),
      duration:     duration.toLowerCase().trim(),
      speed_limit:  speed_limit.trim(),
      price:        parseFloat(price),
      shared_users: parseInt(shared_users, 10) || 1,
      sort_order:   parseInt(sort_order, 10) || 0,
      description:  description || '',
      is_active:    is_active !== undefined ? (is_active ? 1 : 0) : 1,
    });
    res.json({ message: 'Plan actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/plans/:id', authRequired, async (req, res) => {
  try {
    await db.collection('plans').doc(req.params.id).update({ is_active: 0 });
    res.json({ message: 'Plan desactivado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/vouchers/generate', authRequired, async (req, res) => {
  try {
    const { plan_id, quantity = 10, code_length = 8, charset = 'full', prefix = '', note = '' } = req.body;
    const planDoc = await db.collection('plans').doc(String(plan_id)).get();
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan no encontrado' });
    const plan = planDoc.data();

    const count = Math.min(Math.max(parseInt(quantity, 10) || 10, 1), 450);

    const batchRef = await db.collection('voucher_batches').add({
      plan_id:     planDoc.id,
      plan_name:   plan.name,
      quantity:    count,
      note:        note || '',
      created_by:  req.admin.username,
      created_at:  new Date().toISOString(),
    });

    const batch = db.batch();
    const codes = [];

    for (let i = 0; i < count; i++) {
      const code = generateCode(code_length, charset, prefix);
      codes.push(code);
      const voucherRef = db.collection('vouchers').doc(code);
      batch.set(voucherRef, {
        code,
        plan_id:      planDoc.id,
        plan_name:    plan.name,
        duration:     plan.duration,
        speed_limit:  plan.speed_limit,
        price:        plan.price,
        batch_id:     batchRef.id,
        status:       'available',
        created_at:   new Date().toISOString(),
      });
    }

    await batch.commit();

    res.status(201).json({
      message:      `Lote de ${count} fichas generado`,
      batch_id:     batchRef.id,
      plan_name:    plan.name,
      sample_codes: codes.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/vouchers', authRequired, async (req, res) => {
  try {
    const { status, plan_id, search, limit = 100 } = req.query;
    let query = db.collection('vouchers');
    if (status)  query = query.where('status', '==', status);
    if (plan_id) query = query.where('plan_id', '==', plan_id);

    const snap = await query.limit(Math.min(200, parseInt(limit, 10) || 100)).get();
    let list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (search) {
      const s = String(search).toUpperCase();
      list = list.filter((v) => v.code.includes(s));
    }

    res.json({ vouchers: list, total: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/vouchers/stats', authRequired, async (req, res) => {
  try {
    const [availAgg, soldAgg, activeAgg, expAgg] = await Promise.all([
      db.collection('vouchers').where('status', '==', 'available').count().get(),
      db.collection('vouchers').where('status', '==', 'sold').count().get(),
      db.collection('vouchers').where('status', '==', 'active').count().get(),
      db.collection('vouchers').where('status', '==', 'expired').count().get(),
    ]);

    const stats = {
      available: availAgg.data().count,
      sold:      soldAgg.data().count,
      active:    activeAgg.data().count,
      expired:   expAgg.data().count,
    };

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = now.toISOString().slice(0, 7);
    const monthStartIso = `${monthStr}-01T00:00:00.000Z`;

    const salesSnap = await db.collection('sales').where('created_at', '>=', monthStartIso).get();
    let todayRev = 0, monthRev = 0;

    salesSnap.docs.forEach((d) => {
      const s = d.data();
      const dt = s.created_at || '';
      if (dt.startsWith(todayStr)) todayRev += (s.amount || 0);
      monthRev += (s.amount || 0);
    });

    res.json({
      vouchers: stats,
      revenue:  { today: todayRev, month: monthRev },
      top_plans: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/vouchers/batches', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('voucher_batches').orderBy('created_at', 'desc').limit(50).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/vouchers/batch/:id', authRequired, async (req, res) => {
  try {
    const bDoc = await db.collection('voucher_batches').doc(req.params.id).get();
    const vSnap = await db.collection('vouchers').where('batch_id', '==', req.params.id).get();
    res.json({
      batch:    bDoc.exists ? { id: bDoc.id, ...bDoc.data() } : null,
      vouchers: vSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/vouchers/sell', authRequired, async (req, res) => {
  try {
    const { voucher_id, payment_method = 'efectivo', buyer_note = '' } = req.body;
    const vRef = db.collection('vouchers').doc(String(voucher_id).toUpperCase());

    const soldData = await db.runTransaction(async (tx) => {
      const vDoc = await tx.get(vRef);
      if (!vDoc.exists || vDoc.data().status !== 'available') {
        throw new Error('UNAVAILABLE');
      }
      const vData = vDoc.data();
      const nowIso = new Date().toISOString();
      tx.update(vRef, {
        status:         'sold',
        sold_at:        nowIso,
        sold_by:        req.admin.username,
        payment_method,
        buyer_note,
      });
      const saleRef = db.collection('sales').doc();
      tx.set(saleRef, {
        voucher_code:   vData.code,
        plan_name:      vData.plan_name,
        amount:         vData.price || 0,
        payment_method,
        seller:         req.admin.username,
        created_at:     nowIso,
      });
      return vData;
    });

    res.json({ message: 'Venta registrada con éxito', code: soldData.code, amount: soldData.price });
  } catch (err) {
    if (err.message === 'UNAVAILABLE') {
      return res.status(400).json({ error: 'Ficha no disponible para venta' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vouchers/activate — Transaccional anti-TOCTOU
app.post('/vouchers/activate', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código de ficha requerido' });

    const cleanCode = String(code).toUpperCase().trim();
    const vRef = db.collection('vouchers').doc(cleanCode);

    const claim = await db.runTransaction(async (tx) => {
      const vDoc = await tx.get(vRef);
      if (!vDoc.exists) throw new Error('NOT_FOUND');
      const v = vDoc.data();
      if (v.status !== 'available' && v.status !== 'sold') {
        throw new Error(`ALREADY_USED:${v.status}`);
      }

      const durMs = parseDurationMs(v.duration);
      const finalExpiryMs = Math.min(Date.now() + durMs, getBogotaMidnightMs());
      const expiresAt = new Date(finalExpiryMs).toISOString();
      const nowIso = new Date().toISOString();

      tx.update(vRef, {
        status:       'active',
        is_sold:      true,
        sold_at:      v.sold_at || nowIso,
        activated_at: nowIso,
        expires_at:   expiresAt,
      });

      return { v, expiresAt, prevStatus: v.status };
    });

    try {
      await mikrotik.createHotspotUser(claim.v.code, claim.v.code, {
        limitUptime: claim.v.duration,
        rateLimit:   claim.v.speed_limit,
      });
    } catch (mkErr) {
      await vRef.update({ status: claim.prevStatus, activated_at: null, expires_at: null });
      throw mkErr;
    }

    res.json({
      message:    '¡Ficha activada con éxito! Ya puedes navegar.',
      code:       claim.v.code,
      plan:       claim.v.plan_name,
      duration:   claim.v.duration,
      speed:      claim.v.speed_limit,
      expires_at: claim.expiresAt,
    });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Código inválido o no encontrado' });
    }
    if (err.message && err.message.startsWith('ALREADY_USED:')) {
      return res.status(400).json({ error: `La ficha ya se encuentra: ${err.message.split(':')[1]}` });
    }
    console.error('Error al activar ficha:', err);
    res.status(500).json({ error: 'No se pudo activar la ficha. Intente de nuevo.' });
  }
});

app.get('/vouchers/check/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    const vDoc = await db.collection('vouchers').doc(code).get();
    if (!vDoc.exists) return res.status(404).json({ error: 'Código no encontrado' });
    const v = vDoc.data();
    res.json({
      code:         v.code,
      status:       v.status,
      plan:         v.plan_name,
      duration:     v.duration,
      expires_at:   v.expires_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login — Sin credenciales por defecto hardcodeadas
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const adminDoc = await db.collection('admins').doc(username.trim().toLowerCase()).get();
    if (!adminDoc.exists) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const data = adminDoc.data();
    if (!data.password || !bcrypt.compareSync(password, data.password)) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const adminData = { username: data.username, role: data.role || 'admin', full_name: data.full_name || '' };
    const token = jwt.sign(adminData, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
    res.json({ token, admin: adminData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/me', authRequired, (req, res) => {
  res.json({ admin: req.admin });
});

exports.api = functions.https.onRequest(app);

exports.cleanupExpiredVouchers = functions.pubsub.schedule('every 15 minutes').onRun(async () => {
  const nowIso = new Date().toISOString();
  const snap = await db.collection('vouchers')
    .where('status', '==', 'active')
    .where('expires_at', '<=', nowIso)
    .get();

  console.log(`[Cleanup] Fichas expiradas encontradas: ${snap.size}`);

  for (const doc of snap.docs) {
    const v = doc.data();
    try {
      await mikrotik.deleteHotspotUser(v.code);
    } catch (_) {}
    await doc.ref.update({ status: 'expired' });
  }
  return null;
});
