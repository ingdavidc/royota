/**
 * functions/index.js
 * ─────────────────────────────────────────────────────────────
 * Backend Serverless para Hotspot Fichas ROYOTA en Firebase.
 *
 * Incluye:
 * 1. Express API exportada como Cloud Function `api`
 * 2. Base de datos Cloud Firestore (Planes, Fichas, Lotes, Ajustes, Ventas)
 * 3. Integración con MikroTik RouterOS v7
 * 4. Tarea programada (Scheduled Function) de limpieza automática
 */
'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const express   = require('express');
const cors      = require('cors');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');

const mikrotik  = require('./mikrotik');

// Inicializar Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// ── Configuraciones Generales ──────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET || 'jwt-fichas-royota-secure-key-2026';
const JWT_EXPIRES_IN = '10h';
const DEFAULT_USER   = process.env.ADMIN_USER || 'admin';
const DEFAULT_PASS   = process.env.ADMIN_PASS || 'admin123';

// ── Generador de Códigos ──────────────────────────────────────
const CHARSETS = {
  numeric: '0123456789',
  alpha:   'ABCDEFGHJKLMNPQRSTUVWXYZ',
  full:    '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', // sin 0, 1, O, I para evitar confusión
};

function generateCode(length = 8, charsetType = 'full', prefix = '') {
  const chars = CHARSETS[charsetType] || CHARSETS.full;
  let result = prefix ? prefix.toUpperCase() : '';
  const needed = length - result.length;
  for (let i = 0; i < Math.max(needed, 4); i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
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

// ── Middleware de Autenticación Admin ─────────────────────────
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado o formato inválido' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ── Inicializar Express App ───────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
//  RUTAS DE CONFIGURACIÓN & PORTAL CAUTIVO
// ═══════════════════════════════════════════════════════════════

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

// GET /api/config & GET /api/settings/public
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
  } catch (err) {
    res.json(DEFAULT_SETTINGS);
  }
});

// GET /api/settings (auth)
app.get('/settings', authRequired, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('general').get();
    res.json(doc.exists ? doc.data() : DEFAULT_SETTINGS);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings (auth)
app.put('/settings', authRequired, async (req, res) => {
  try {
    const payload = req.body;
    await db.collection('settings').doc('general').set(payload, { merge: true });
    const updated = (await db.collection('settings').doc('general').get()).data();
    res.json({ message: 'Configuración guardada en Firestore', settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS DE PLANES DE INTERNET
// ═══════════════════════════════════════════════════════════════

// GET /api/plans (público)
app.get('/plans', async (req, res) => {
  try {
    const snap = await db.collection('plans').where('is_active', '!=', 0).get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plans/all (auth)
app.get('/plans/all', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('plans').get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plans (auth)
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

// PUT /api/plans/:id (auth)
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

// DELETE /api/plans/:id (auth)
app.delete('/plans/:id', authRequired, async (req, res) => {
  try {
    await db.collection('plans').doc(req.params.id).update({ is_active: 0 });
    res.json({ message: 'Plan desactivado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS DE FICHAS (VOUCHERS)
// ═══════════════════════════════════════════════════════════════

// POST /api/vouchers/generate (auth)
app.post('/vouchers/generate', authRequired, async (req, res) => {
  try {
    const { plan_id, quantity = 10, code_length = 8, charset = 'full', prefix = '', note = '' } = req.body;
    const planDoc = await db.collection('plans').doc(String(plan_id)).get();
    if (!planDoc.exists) return res.status(404).json({ error: 'Plan no encontrado' });
    const plan = planDoc.data();

    const count = Math.min(Math.max(parseInt(quantity, 10) || 10, 1), 500);

    // Crear lote
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
      message:     `Lote de ${count} fichas generado`,
      batch_id:    batchRef.id,
      plan_name:   plan.name,
      sample_codes: codes.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vouchers (auth)
app.get('/vouchers', authRequired, async (req, res) => {
  try {
    const { status, plan_id, search, limit = 100 } = req.query;
    let query = db.collection('vouchers');
    if (status)  query = query.where('status', '==', status);
    if (plan_id) query = query.where('plan_id', '==', plan_id);

    const snap = await query.limit(parseInt(limit, 10) || 100).get();
    let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (search) {
      const s = search.toUpperCase();
      list = list.filter(v => v.code.includes(s));
    }

    res.json({ vouchers: list, total: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vouchers/stats (auth)
app.get('/vouchers/stats', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('vouchers').get();
    const stats = { available: 0, sold: 0, active: 0, expired: 0 };
    snap.docs.forEach(d => {
      const st = d.data().status;
      if (stats[st] !== undefined) stats[st]++;
    });

    const salesSnap = await db.collection('sales').get();
    let todayRev = 0, monthRev = 0;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = now.toISOString().slice(0, 7);

    salesSnap.docs.forEach(d => {
      const s = d.data();
      const dt = s.created_at || '';
      if (dt.startsWith(todayStr)) todayRev += (s.amount || 0);
      if (dt.startsWith(monthStr)) monthRev += (s.amount || 0);
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

// GET /api/vouchers/batches (auth)
app.get('/vouchers/batches', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('voucher_batches').orderBy('created_at', 'desc').limit(50).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vouchers/batch/:id (auth)
app.get('/vouchers/batch/:id', authRequired, async (req, res) => {
  try {
    const bDoc = await db.collection('voucher_batches').doc(req.params.id).get();
    const vSnap = await db.collection('vouchers').where('batch_id', '==', req.params.id).get();
    res.json({
      batch:    bDoc.exists ? { id: bDoc.id, ...bDoc.data() } : null,
      vouchers: vSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vouchers/sell (auth)
app.post('/vouchers/sell', authRequired, async (req, res) => {
  try {
    const { voucher_id, payment_method = 'efectivo', buyer_note = '' } = req.body;
    const vRef = db.collection('vouchers').doc(String(voucher_id).toUpperCase());
    const vDoc = await vRef.get();

    if (!vDoc.exists || vDoc.data().status !== 'available') {
      return res.status(400).json({ error: 'Ficha no disponible para venta' });
    }

    const vData = vDoc.data();
    await vRef.update({
      status:         'sold',
      sold_at:        new Date().toISOString(),
      sold_by:        req.admin.username,
      payment_method,
      buyer_note,
    });

    await db.collection('sales').add({
      voucher_code:   vData.code,
      plan_name:      vData.plan_name,
      amount:         vData.price || 0,
      payment_method,
      seller:         req.admin.username,
      created_at:     new Date().toISOString(),
    });

    res.json({ message: 'Venta registrada con éxito', code: vData.code, amount: vData.price });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vouchers/activate (público — Portal Cautivo)
app.post('/vouchers/activate', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Código de ficha requerido' });

    const cleanCode = String(code).toUpperCase().trim();
    const vRef = db.collection('vouchers').doc(cleanCode);
    const vDoc = await vRef.get();

    if (!vDoc.exists) {
      return res.status(404).json({ error: 'Código inválido o no encontrado' });
    }

    const v = vDoc.data();
    if (v.status !== 'available' && v.status !== 'sold') {
      return res.status(400).json({ error: `La ficha ya se encuentra: ${v.status}` });
    }

    // 1. Crear usuario en MikroTik
    await mikrotik.createHotspotUser(v.code, v.code, {
      limitUptime: v.duration,
      rateLimit:   v.speed_limit,
    });

    // 2. Calcular expiración
    const durMs = parseDurationMs(v.duration);
    const expiresAt = new Date(Date.now() + durMs).toISOString();

    // 3. Actualizar en Firestore
    await vRef.update({
      status:       'active',
      activated_at: new Date().toISOString(),
      expires_at:   expiresAt,
    });

    res.json({
      message:    '¡Ficha activada con éxito! Ya puedes navegar.',
      code:       v.code,
      plan:       v.plan_name,
      duration:   v.duration,
      speed:      v.speed_limit,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('Error al activar ficha:', err);
    res.status(500).json({ error: 'No se pudo activar la ficha. Intente de nuevo.' });
  }
});

// GET /api/vouchers/check/:code (público)
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

// ═══════════════════════════════════════════════════════════════
//  AUTENTICACIÓN ADMIN
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    // Comprobar contra Firestore o contra credenciales por defecto
    let isValid = false;
    let adminData = { username: username.trim(), role: 'superadmin', full_name: 'Administrador' };

    const adminDoc = await db.collection('admins').doc(username.trim().toLowerCase()).get();
    if (adminDoc.exists) {
      const data = adminDoc.data();
      if (bcrypt.compareSync(password, data.password)) {
        isValid = true;
        adminData = { username: data.username, role: data.role, full_name: data.full_name || '' };
      }
    } else if (username.trim() === DEFAULT_USER && password === DEFAULT_PASS) {
      isValid = true;
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(adminData, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token, admin: adminData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/auth/me', authRequired, (req, res) => {
  res.json({ admin: req.admin });
});

// Exportar como Cloud Function HTTP 'api'
exports.api = functions.https.onRequest(app);

// ═══════════════════════════════════════════════════════════════
//  TAREA PROGRAMADA: LIMPIEZA DE FICHAS VENCIDAS (Cada 15 min)
// ═══════════════════════════════════════════════════════════════
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
