/**
 * src/services/whatsapp-bot.js
 * ─────────────────────────────────────────────────────────────
 * Servicio de Automatización de WhatsApp con IA para Hotspot Fichas ROYOTA.
 *
 * Endurecimientos aplicados:
 *  - Autenticación Firestore vía Service Account (`firestore-client.js`)
 *  - Validación obligatoria de destino, confianza mínima (>= 0.80) y referencia
 *  - Persistencia dual SQLite + Firestore de pagos (`whatsapp_payments`) y strikes (`whatsapp_strikes`)
 *  - Reserva atómica anti-TOCTOU de fichas WSP- dentro de transacción SQLite
 *  - Mensajes de error genéricos hacia el cliente final
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} = require('@whiskeysockets/baileys');

const config = require('../config');
const { getDb } = require('../database');
const { generateBatch } = require('./voucher-generator');
const { analyzeReceipt } = require('./gemini-vision');
const { firestoreFetch, toFirestoreFields } = require('./firestore-client');
const {
  restoreBaileysAuthFromFirestore,
  saveFileToFirestore,
  syncAllAuthFilesToFirestore,
  clearAllBaileysAuth,
} = require('./firestore-baileys-auth');

const AUTH_DIR = path.join(__dirname, '..', '..', 'data', 'baileys_auth');
const logger = pino({ level: 'silent' });
const MIN_AI_CONFIDENCE = 0.80;

let _sock = null;
let _reconnectTimer = null;
let _state = {
  status: 'disconnected',
  qr: null,
  qrCodeDataUrl: null,
  user: null,
  lastError: null,
};

async function syncWhatsAppStateToFirestore() {
  try {
    let rawPhone = '573174251419';
    if (_state.user && _state.user.id) {
      rawPhone = _state.user.id.split(':')[0].replace(/\D/g, '');
    }
    await firestoreFetch('/telemetry/whatsapp', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          status: _state.status || 'disconnected',
          qrCodeDataUrl: _state.qrCodeDataUrl || '',
          botPhone: rawPhone,
          user: _state.user ? JSON.stringify(_state.user) : '',
          updatedAt: new Date().toISOString(),
        }),
      }),
    });
  } catch (_) {}
}

const _processingMessages = new Set();
const _messageTimestamps  = new Map();
const _imageLastSent      = new Map();
const _debounceTimers     = new Map();
const _offTopicTracker    = new Map();
const _warnedSuspended    = new Map();
const _outboxDispatching  = new Set();

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function cleanPhoneDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

let _cachedLiveKiosks = null;
let _lastKiosksFetch = 0;

function invalidateKiosksCache() {
  _cachedLiveKiosks = null;
  _lastKiosksFetch = 0;
}

async function getLiveKiosks() {
  const now = Date.now();
  if (_cachedLiveKiosks && (now - _lastKiosksFetch < 10_000)) {
    return _cachedLiveKiosks;
  }

  try {
    const res = await firestoreFetch('/kiosks?pageSize=50');
    if (res.ok) {
      const data = await res.json();
      if (data.documents && data.documents.length) {
        const firestoreKiosks = [];
        data.documents.forEach((doc) => {
          const f = doc.fields || {};
          let isActive = 1;
          if (f.is_active) {
            if (f.is_active.booleanValue !== undefined) {
              isActive = f.is_active.booleanValue ? 1 : 0;
            } else if (f.is_active.integerValue !== undefined) {
              isActive = Number(f.is_active.integerValue);
            }
          }
          if (isActive === 1) {
            firestoreKiosks.push({
              id: doc.name.split('/').pop(),
              name: f.name ? f.name.stringValue : 'Caseta Autorizada',
              location: f.location ? f.location.stringValue : '',
              contact: f.contact ? f.contact.stringValue : '',
              notes: f.notes ? f.notes.stringValue : '',
              sort_order: f.sort_order ? Number(f.sort_order.integerValue || 0) : 0,
              is_active: 1,
            });
          }
        });

        if (firestoreKiosks.length) {
          firestoreKiosks.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
          _cachedLiveKiosks = firestoreKiosks;
          _lastKiosksFetch = now;

          try {
            const db = getDb();
            const syncTrans = db.transaction(() => {
              db.prepare('UPDATE kiosks SET is_active = 0').run();
              for (const k of firestoreKiosks) {
                const existing = db.prepare('SELECT id FROM kiosks WHERE name = ?').get(k.name);
                if (existing) {
                  db.prepare(`
                    UPDATE kiosks
                    SET location = ?, contact = ?, notes = ?, sort_order = ?, is_active = 1
                    WHERE id = ?
                  `).run(k.location, k.contact, k.notes, k.sort_order, existing.id);
                  k.sqlite_id = existing.id;
                } else {
                  const ins = db.prepare(`
                    INSERT INTO kiosks (name, location, contact, notes, sort_order, is_active)
                    VALUES (?, ?, ?, ?, ?, 1)
                  `).run(k.name, k.location, k.contact, k.notes, k.sort_order);
                  k.sqlite_id = ins.lastInsertRowid;
                }
              }
            });
            syncTrans();
          } catch (_) {}

          return _cachedLiveKiosks;
        }
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Bot] Error consultando casetas/kioskos en Firestore:', err.message);
  }

  try {
    const db = getDb();
    const localKiosks = db.prepare('SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
    if (localKiosks && localKiosks.length) {
      _cachedLiveKiosks = localKiosks;
      return localKiosks;
    }
  } catch (_) {}

  return [
    { name: 'Estadero El Viajero', location: 'Al lado de Pan de Yuca', contact: 'Recepción', notes: 'Abierto 8:00 AM - 10:00 PM' },
  ];
}

function formatKiosksList(kiosks, full = false) {
  if (!kiosks || !kiosks.length) {
    return '• Estadero El Viajero (Al lado de Pan de Yuca)';
  }
  return kiosks.map((k) => {
    let line = `📍 *${k.name}:* ${k.location}`;
    if (full && k.notes) line += ` _(${k.notes})_`;
    return line;
  }).join('\n');
}

function getKiosksFormattedSync(full = false) {
  if (_cachedLiveKiosks && _cachedLiveKiosks.length) {
    return formatKiosksList(_cachedLiveKiosks, full);
  }
  try {
    const db = getDb();
    const kiosks = db.prepare('SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
    if (kiosks && kiosks.length) {
      return formatKiosksList(kiosks, full);
    }
  } catch (_) {}
  return '• Estadero El Viajero (Al lado de Pan de Yuca)';
}

async function getKiosksFormatted(full = false) {
  try {
    const kiosks = await getLiveKiosks();
    return formatKiosksList(kiosks, full);
  } catch (_) {
    return getKiosksFormattedSync(full);
  }
}

async function checkPhoneBlocked(phone) {
  const clean = cleanPhoneDigits(phone);
  try {
    const db = getDb();
    const row = db.prepare('SELECT strikes, blocked_until, last_reason FROM whatsapp_strikes WHERE phone = ?').get(clean);
    if (row && row.blocked_until && new Date(row.blocked_until) > new Date()) {
      return { isBlocked: true, blockedUntil: row.blocked_until, strikes: row.strikes, lastReason: row.last_reason };
    }

    // Respaldo persistente en Firestore tras reinicios efímeros de contenedor
    const res = await firestoreFetch(`/whatsapp_strikes/${encodeURIComponent(clean)}`);
    if (res.ok) {
      const doc = await res.json();
      const f = doc.fields || {};
      const blockedUntil = f.blocked_until?.stringValue || null;
      const strikes = Number(f.strikes?.integerValue || 0);
      const lastReason = f.last_reason?.stringValue || '';
      if (blockedUntil && new Date(blockedUntil) > new Date()) {
        db.prepare(`
          INSERT INTO whatsapp_strikes (phone, strikes, blocked_until, last_reason, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(phone) DO UPDATE SET
            strikes = excluded.strikes,
            blocked_until = excluded.blocked_until,
            last_reason = excluded.last_reason
        `).run(clean, strikes, blockedUntil, lastReason);
        return { isBlocked: true, blockedUntil, strikes, lastReason };
      }
      return { isBlocked: false, strikes };
    }

    return { isBlocked: false, strikes: row ? row.strikes : 0 };
  } catch (err) {
    console.error('[WhatsApp Bot] Error checking block status:', err);
    return { isBlocked: false, strikes: 0 };
  }
}

function recordStrike(phone, reason) {
  const db = getDb();
  const clean = cleanPhoneDigits(phone);
  const existing = db.prepare('SELECT strikes FROM whatsapp_strikes WHERE phone = ?').get(clean);

  const currentStrikes = (existing ? existing.strikes : 0) + 1;
  let blockedUntil = null;
  let isBlocked = false;

  if (currentStrikes >= 2) {
    blockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    isBlocked = true;
    console.warn(`[WhatsApp Bot] 🚫 Número ${clean} BLOQUEADO por 24 horas (2do intento no válido: ${reason})`);
  } else {
    console.warn(`[WhatsApp Bot] ⚠️ Strike #${currentStrikes} asignado a ${clean} (${reason})`);
  }

  db.prepare(`
    INSERT INTO whatsapp_strikes (phone, strikes, blocked_until, last_reason, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      strikes = excluded.strikes,
      blocked_until = excluded.blocked_until,
      last_reason = excluded.last_reason,
      updated_at = datetime('now')
  `).run(clean, currentStrikes, blockedUntil, reason);

  // Espejar en Firestore para sobrevivir reinicios de Render
  firestoreFetch(`/whatsapp_strikes/${encodeURIComponent(clean)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFirestoreFields({
        phone: clean,
        strikes: currentStrikes,
        blocked_until: blockedUntil || '',
        last_reason: String(reason).slice(0, 200),
        updated_at: new Date().toISOString(),
      }),
    }),
  }).catch(() => {});

  return { strikes: currentStrikes, isBlocked, blockedUntil };
}

function clearStrikes(phone) {
  try {
    const db = getDb();
    const clean = cleanPhoneDigits(phone);
    db.prepare(`
      UPDATE whatsapp_strikes
      SET strikes = 0, blocked_until = NULL, last_reason = 'Pago exitoso verificado', updated_at = datetime('now')
      WHERE phone = ?
    `).run(clean);

    firestoreFetch(`/whatsapp_strikes/${encodeURIComponent(clean)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          phone: clean,
          strikes: 0,
          blocked_until: '',
          last_reason: 'Pago exitoso verificado',
          updated_at: new Date().toISOString(),
        }),
      }),
    }).catch(() => {});
  } catch (_) {}
}

function isRateLimited(phone) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxMsgs = 4;

  let timestamps = _messageTimestamps.get(phone) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);

  if (timestamps.length >= maxMsgs) return true;

  timestamps.push(now);
  _messageTimestamps.set(phone, timestamps);
  return false;
}

let _cachedLivePlans = null;
let _lastPlansFetch = 0;

async function getLivePlans() {
  const now = Date.now();
  if (_cachedLivePlans && (now - _lastPlansFetch < 10_000)) {
    return _cachedLivePlans;
  }

  try {
    const res = await firestoreFetch('/plans?pageSize=50');
    if (res.ok) {
      const data = await res.json();
      if (data.documents && data.documents.length) {
        const firestorePlans = [];
        data.documents.forEach((doc) => {
          const f = doc.fields || {};
          const isActive = f.is_active ? Number(f.is_active.integerValue ?? f.is_active.booleanValue ?? 1) : 1;
          if (isActive === 1) {
            firestorePlans.push({
              id: doc.name.split('/').pop(),
              name: f.name ? f.name.stringValue : 'Plan WiFi',
              duration: f.duration ? f.duration.stringValue : '1h',
              speed_limit: f.speed_limit ? f.speed_limit.stringValue : '2M/3M',
              price: f.price ? Number(f.price.integerValue || f.price.doubleValue || 0) : 0,
              sort_order: f.sort_order ? Number(f.sort_order.integerValue || 0) : 0,
              profile_name: f.profile_name ? f.profile_name.stringValue : 'default',
            });
          }
        });

        if (firestorePlans.length) {
          firestorePlans.sort((a, b) => (a.sort_order - b.sort_order) || (a.price - b.price));
          _cachedLivePlans = firestorePlans;
          _lastPlansFetch = now;

          try {
            const db = getDb();
            const syncTrans = db.transaction(() => {
              for (const p of firestorePlans) {
                const existing = db.prepare('SELECT id FROM plans WHERE name = ?').get(p.name);
                if (existing) {
                  db.prepare(`
                    UPDATE plans
                    SET duration = ?, speed_limit = ?, price = ?, profile_name = ?, is_active = 1, sort_order = ?
                    WHERE id = ?
                  `).run(p.duration, p.speed_limit, p.price, p.profile_name || 'default', p.sort_order, existing.id);
                  p.sqlite_id = existing.id;
                } else {
                  const ins = db.prepare(`
                    INSERT INTO plans (name, duration, speed_limit, price, profile_name, is_active, sort_order)
                    VALUES (?, ?, ?, ?, ?, 1, ?)
                  `).run(p.name, p.duration, p.speed_limit, p.price, p.profile_name || 'default', p.sort_order);
                  p.sqlite_id = ins.lastInsertRowid;
                }
              }
            });
            syncTrans();
          } catch (_) {}

          return _cachedLivePlans;
        }
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Bot] Error consultando planes en Firestore:', err.message);
  }

  try {
    const db = getDb();
    const localPlans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order ASC, price ASC').all();
    if (localPlans && localPlans.length) {
      _cachedLivePlans = localPlans;
      return localPlans;
    }
  } catch (_) {}

  return [
    { name: '1 Hora Basico', duration: '1h', speed_limit: '2M/3M', price: 2000 },
    { name: '1 Hora Premium', duration: '1h', speed_limit: '5M/10M', price: 3000 },
    { name: '5 Horas Basico', duration: '5h', speed_limit: '2M/3M', price: 5000 },
    { name: '5 Horas Premium', duration: '5h', speed_limit: '5M/10M', price: 8000 },
    { name: '1 Dia Basico', duration: '1d', speed_limit: '2M/3M', price: 8000 },
    { name: '1 Dia Premium', duration: '1d', speed_limit: '5M/10M', price: 10000 },
  ];
}

async function buildMenuMessage() {
  const plans = await getLivePlans();
  const businessName = config.business.name || 'Balneario Río Royota';
  const paymentPhone = config.whatsapp.paymentPhone || '3174251419';
  const kiosksList = await getKiosksFormatted(false);

  let msg = `📶 *¡Bienvenido a ${businessName}!* 🚀\n`;
  msg += `Compra tu ficha de internet de forma 100% automática.\n\n`;
  msg += `📋 *PLANES DISPONIBLES:*\n`;

  plans.forEach((p, idx) => {
    const formattedPrice = Number(p.price).toLocaleString('es-CO');
    msg += `${idx + 1}️⃣ *${p.name}* (${p.duration}) → *$${formattedPrice} COP*\n`;
  });

  msg += `\n💳 *MEDIOS DE PAGO VIRTUALES:*\n`;
  msg += `• *Daviplata:* \`${paymentPhone}\`\n`;
  msg += `• *Llave Bre-B:* \`${paymentPhone}\`\n`;
  msg += `⚠️ _Solo recibimos Daviplata o Llave Bre-B (NO se acepta Transfiya)._\n\n`;
  msg += `📸 *¿CÓMO COMPRAR EN LÍNEA?*\n`;
  msg += `1. Realiza la transferencia del valor exacto a nuestro número.\n`;
  msg += `2. *Envía la captura de pantalla del comprobante aquí mismo.* 📸\n`;
  msg += `3. Nuestra IA validará tu pago y *te entregará tu código en segundos.* ⚡\n\n`;
  msg += `🏪 *¿PREFIERES PAGAR EN EFECTIVO?*\n`;
  msg += `Puedes adquirir tu ficha física directamente en nuestras casetas autorizadas:\n${kiosksList}\n`;

  return msg;
}

async function buildSuspensionMessage() {
  const kiosksList = await getKiosksFormatted(true);
  return `🚫 *NÚMERO TEMPORALMENTE SUSPENDIDO* 🚫\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Has alcanzado el límite de *2 intentos no válidos* de comprobante. Por medidas de seguridad y prevención de fraudes, tu número ha sido suspendido por *24 horas* para compras en línea.\n\n` +
    `🏪 *SOLO ES POSIBLE LA COMPRA EN CASETA FÍSICA:*\n` +
    `A partir de este momento, solo es posible adquirir tu ticket de internet directamente en efectivo en cualquiera de nuestras casetas autorizadas en el balneario:\n\n` +
    `${kiosksList}\n\n` +
    `_Te esperamos en el Balneario Río Royota._\n` +
    `━━━━━━━━━━━━━━━━━━━━`;
}

async function formatStrikeWarning(strike) {
  if (strike.isBlocked) return '';
  const kiosksShort = await getKiosksFormatted(false);
  return `\n\n⚠️ *ADVERTENCIA (Intento 1 de 2):* Te queda solo 1 intento más. De no ser aprobado tu comprobante, tu número será suspendido por 24 horas y solo podrás adquirir el ticket en tienda física (casetas autorizadas).\n\n🏪 *Casetas físicas para pago en efectivo:*\n${kiosksShort}`;
}

/**
 * Verifica duplicado tanto en SQLite local como en Firestore persistente.
 */
async function findExistingPaymentRef(cleanRef) {
  const db = getDb();
  const localRef = db.prepare('SELECT id, created_at FROM whatsapp_payments WHERE reference_number = ?').get(cleanRef);
  if (localRef) return localRef;

  try {
    const res = await firestoreFetch(`/whatsapp_payments/${encodeURIComponent(cleanRef)}`);
    if (res.ok) {
      const doc = await res.json();
      return {
        id: cleanRef,
        created_at: doc.fields?.created_at?.stringValue || 'fecha registrada',
      };
    }
  } catch (_) {}
  return null;
}

/**
 * Procesa la imagen del comprobante de pago enviada por el cliente
 */
async function processPaymentReceipt(sock, msg, senderJid) {
  const senderPhone = senderJid.replace('@s.whatsapp.net', '');
  const targetPhone = config.whatsapp.paymentPhone || '3174251419';

  const now = Date.now();
  const lastImgTime = _imageLastSent.get(senderPhone) || 0;
  if (now - lastImgTime < 30 * 1000) {
    const waitSec = Math.ceil((30 * 1000 - (now - lastImgTime)) / 1000);
    await sock.sendMessage(senderJid, {
      text: `⏱️ *Espera un momento:* Para evitar saturación, solo puedes enviar un comprobante cada 30 segundos. Por favor espera ${waitSec} segundos.`,
    }, { quoted: msg });
    return;
  }
  _imageLastSent.set(senderPhone, now);

  try {
    await sock.sendMessage(senderJid, {
      text: '🔍 *Comprobante recibido.* Estamos validando tu pago con nuestra IA, por favor espera unos segundos...',
    }, { quoted: msg });

    const imageBuffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    if (!imageBuffer) {
      await sock.sendMessage(senderJid, {
        text: '❌ No se pudo descargar la imagen del comprobante. Por favor intenta enviarla nuevamente.',
      }, { quoted: msg });
      return;
    }

    if (!config.whatsapp.geminiApiKey) {
      console.warn('[WhatsApp Bot] Falta GEMINI_API_KEY en configuración.');
      await sock.sendMessage(senderJid, {
        text: '⚠️ El servicio de validación automática por IA no está activo en este momento. Un administrador revisará tu pago manualmente.',
      }, { quoted: msg });
      return;
    }

    const analysis = await analyzeReceipt(imageBuffer, 'image/jpeg');
    console.log('[WhatsApp Bot] Resultado Gemini:', analysis);

    // ── VALIDADOR 0: Detección Forense de Manipulación ───────────────
    if (analysis.is_tampered) {
      const reason = analysis.tamper_reason || 'Se detectaron alteraciones o tipografía inconsistente en el comprobante.';
      const strike = recordStrike(senderPhone, `Comprobante alterado/editado: ${reason}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `🚫 *Comprobante no válido (Inconsistencias detectadas)*\n\nEl sistema de auditoría detectó posibles alteraciones o edición digital en los datos del comprobante (${reason}).${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 1: Recibo válido, exitoso y confianza mínima >= 0.80 ──
    const confidence = Number(analysis.confidence || 0);
    if (!analysis.is_payment_receipt || !analysis.is_successful || confidence < MIN_AI_CONFIDENCE) {
      const reason = confidence < MIN_AI_CONFIDENCE && analysis.is_payment_receipt
        ? 'La captura no tiene nitidez suficiente para verificar todos los datos con seguridad.'
        : (analysis.rejection_reason || 'La imagen no corresponde a un comprobante de pago exitoso o legible.');
      const strike = recordStrike(senderPhone, `Comprobante inválido/baja confianza (${confidence}): ${reason}`);

      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ *No se pudo validar el pago*\n\nMotivo: ${reason}\n\nPor favor envía una captura de pantalla original y nítida donde se observe claramente el valor, el número de aprobación y la cuenta de destino.${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 1.5: Rechazo estricto de Transfiya ─────────────────
    const platformUpper = (analysis.platform || '').toUpperCase();
    if (platformUpper.includes('TRANSFIYA') || (analysis.notes && String(analysis.notes).toUpperCase().includes('TRANSFIYA'))) {
      const strike = recordStrike(senderPhone, 'Intento de pago con Transfiya (no aceptado)');
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ *Medio de pago no aceptado*\n\nPor políticas estrictas de seguridad contra fraude, *NO recibimos transferencias por Transfiya*.\n\nÚnicamente aceptamos pagos directos por:\n• *Daviplata* al número: \`${targetPhone}\`\n• *Llave Bre-B* al número: \`${targetPhone}\`\n\nSi deseas pagar en efectivo, escribe *CASETAS*.${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 2: Destino obligatorio y coincidente ───────────────
    const cleanedExtractedDest = cleanPhoneDigits(analysis.destination_phone);
    const cleanedTarget = cleanPhoneDigits(targetPhone);

    if (!cleanedExtractedDest || cleanedExtractedDest.length < 7 || (!cleanedExtractedDest.includes(cleanedTarget) && !cleanedTarget.includes(cleanedExtractedDest))) {
      const shownDest = analysis.destination_phone ? `*${analysis.destination_phone}*` : 'no visible/legible';
      const strike = recordStrike(senderPhone, `Destino inválido o no visible: ${analysis.destination_phone || 'vacío'}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ *Cuenta de destino incorrecta o no visible*\n\nEl comprobante muestra destino ${shownDest}, pero debe verse claramente la cuenta autorizada: *${targetPhone}*.${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 2.5: Vigencia básica de fecha (si viene explícita) ──
    const dateTimeStr = String(analysis.date_time || '');
    const isoMatch = dateTimeStr.match(/(20\d{2})[-/](\d{2})[-/](\d{2})/);
    if (isoMatch) {
      const parsedReceiptDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
      const todayColombia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
      if (parsedReceiptDate < todayColombia) {
        const diffDays = Math.floor((new Date(todayColombia) - new Date(parsedReceiptDate)) / 86_400_000);
        if (diffDays > 1) {
          const strike = recordStrike(senderPhone, `Comprobante con fecha antigua (${parsedReceiptDate})`);
          if (strike.isBlocked) {
            await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
          } else {
            await sock.sendMessage(senderJid, {
              text: `❌ *Comprobante expirado*\n\nLa fecha detectada en el recibo (${parsedReceiptDate}) no corresponde a una transferencia de hoy.${await formatStrikeWarning(strike)}`,
            }, { quoted: msg });
          }
          return;
        }
      }
    }

    // ── VALIDADOR 3: Referencia única anti-fraude (SQLite + Firestore) ─
    const cleanRef = String(analysis.reference_number || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!cleanRef || cleanRef.length < 3) {
      const strike = recordStrike(senderPhone, 'Referencia no identificada en la imagen');
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ No se pudo identificar el número de referencia o aprobación en el comprobante. Por favor envía una captura más nítida.${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    const existingRef = await findExistingPaymentRef(cleanRef);
    if (existingRef) {
      const strike = recordStrike(senderPhone, `Comprobante duplicado: ${cleanRef}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `⚠️ *Comprobante duplicado / Reutilizado*\n\nEste comprobante (Ref: *${cleanRef}*) ya fue registrado anteriormente el día ${existingRef.created_at}.\nCada comprobante es válido para una única ficha de internet.${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 4: Coincidencia exacta de monto con planes ─────────
    const paidAmount = Number(analysis.amount);
    const activePlans = await getLivePlans();
    const matchedPlan = activePlans.find((p) => Math.abs(p.price - paidAmount) < 50);

    if (!matchedPlan) {
      const strike = recordStrike(senderPhone, `Monto $${paidAmount} no coincide con planes`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: await buildSuspensionMessage() }, { quoted: msg });
      } else {
        const formattedPaid = paidAmount.toLocaleString('es-CO');
        const planListStr = activePlans.map((p) => `• *${p.name}* (${p.duration}) → *$${p.price.toLocaleString('es-CO')} COP*`).join('\n');
        await sock.sendMessage(senderJid, {
          text: `⚠️ *Monto recibido no coincide con ningún plan*\n\nDetectamos un pago por *$${formattedPaid} COP*, pero no coincide con el valor de nuestros planes disponibles:\n\n${planListStr}${await formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    clearStrikes(senderPhone);

    const db = getDb();
    let planIdForVoucher = matchedPlan.sqlite_id;
    if (!planIdForVoucher) {
      const localPlan = db.prepare('SELECT id FROM plans WHERE name = ? COLLATE NOCASE').get(matchedPlan.name);
      if (localPlan) {
        planIdForVoucher = localPlan.id;
      } else {
        const ins = db.prepare(`
          INSERT INTO plans (name, duration, speed_limit, price, profile_name, is_active, sort_order)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(matchedPlan.name, matchedPlan.duration || '1h', matchedPlan.speed_limit || '5M/2M', matchedPlan.price || 2000, matchedPlan.profile_name || 'default', matchedPlan.sort_order || 0);
        planIdForVoucher = ins.lastInsertRowid;
      }
    }

    const paymentPlatform = analysis.platform || 'Daviplata/Bre-B';

    // ── RESERVA Y VENTA ATÓMICA ANTI-TOCTOU DENTRO DE TRANSACCIÓN ──
    let voucher = null;
    const preBatch = () => generateBatch({
      planId: planIdForVoucher,
      quantity: 1,
      codeLength: 8,
      charset: 'full',
      prefix: 'WSP-',
      batchNote: `Venta digital WhatsApp (${senderPhone})`,
    });

    const claimVoucherTx = db.transaction(() => {
      const candidate = db.prepare(
        'SELECT * FROM vouchers WHERE plan_id = ? AND status = "available" AND code LIKE "WSP-%" LIMIT 1'
      ).get(planIdForVoucher);

      if (!candidate) return null;

      const upd = db.prepare(`
        UPDATE vouchers
        SET status = 'sold', sold_at = datetime('now'),
            payment_method = ?, buyer_note = ?
        WHERE id = ? AND status = 'available'
      `).run(paymentPlatform.toLowerCase(), `WhatsApp: ${senderPhone} | Ref: ${cleanRef}`, candidate.id);

      if (upd.changes !== 1) return null;

      db.prepare(`
        INSERT INTO sales (voucher_id, plan_id, amount, payment_method, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(candidate.id, planIdForVoucher, matchedPlan.price, paymentPlatform.toLowerCase(), `Auto-venta WhatsApp (${cleanRef})`);

      db.prepare(`
        INSERT INTO whatsapp_payments (reference_number, platform, sender_phone, amount, destination, voucher_id, plan_id, raw_analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cleanRef, paymentPlatform, senderPhone, paidAmount, targetPhone, candidate.id, planIdForVoucher, JSON.stringify(analysis));

      return candidate;
    });

    voucher = claimVoucherTx();
    if (!voucher) {
      await preBatch();
      voucher = claimVoucherTx();
    }

    if (!voucher) {
      throw new Error('No se pudo asignar la ficha de manera atómica');
    }

    // Provisionar en el MikroTik del Balneario (REST directo o Cloud Sync)
    try {
      if (!config.mikrotik.mock) {
        const mikrotik = require('./mikrotik-api');
        await mikrotik.createHotspotUser(voucher.code, voucher.code, {
          profile: matchedPlan.profile_name || 'default',
          limitUptime: matchedPlan.duration,
          rateLimit: matchedPlan.speed_limit,
          sharedUsers: matchedPlan.shared_users || 1,
          comment: `WhatsApp: ${senderPhone} | Ref: ${cleanRef}`,
        });
        db.prepare('UPDATE vouchers SET mikrotik_synced = 1 WHERE id = ?').run(voucher.id);
      }
    } catch (mkErr) {
      console.warn('[WhatsApp Bot] Aviso sync directo MikroTik (se entregará por Cloud Sync):', mkErr.message);
    }

    // Persistir referencia anti-duplicados en Firestore
    firestoreFetch(`/whatsapp_payments/${encodeURIComponent(cleanRef)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          reference_number: cleanRef,
          platform: paymentPlatform,
          sender_phone: senderPhone,
          amount: paidAmount,
          voucher_code: voucher.code,
          created_at: new Date().toISOString(),
        }),
      }),
    }).catch(() => {});

    // Sincronizar ficha vendida en Cloud Firestore
    firestoreFetch(`/vouchers/${encodeURIComponent(voucher.code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          code: voucher.code,
          plan_name: matchedPlan.name,
          duration: matchedPlan.duration || '1h',
          speed_limit: matchedPlan.speed_limit || '5M/2M',
          price: Number(matchedPlan.price || 2000),
          status: 'sold',
          payment_method: paymentPlatform.toLowerCase(),
          buyer_note: `WhatsApp: ${senderPhone} | Ref: ${cleanRef}`,
          sold_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }),
      }),
    }).catch((fErr) => console.warn('[WhatsApp Bot] Aviso sincronizando ficha a Firestore:', fErr.message));

    console.log(`[WhatsApp Bot] ✅ Venta completada. Ficha: ${voucher.code} para ${senderPhone}`);

    const successMsg = `🎉 *¡PAGO VERIFICADO EXITOSAMENTE!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📋 *Plan:* ${matchedPlan.name}\n` +
      `⏱️ *Duración:* ${matchedPlan.duration}\n` +
      `💰 *Monto:* $${matchedPlan.price.toLocaleString('es-CO')} COP\n` +
      `🏦 *Medio:* ${paymentPlatform}\n` +
      `🔢 *Comprobante:* \`${cleanRef}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎫 *TU CÓDIGO DE INTERNET:*\n\n` +
      `👉  *\`${voucher.code}\`*  👈\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📶 *INSTRUCCIONES DE CONEXIÓN:*\n` +
      `1. Conéctate a la red Wi-Fi de *${config.business.name || 'ROYOTA'}*.\n` +
      `2. Abre tu navegador y en el portal cautivo ingresa el código exacto: *${voucher.code}*.\n` +
      `3. ¡Listo! Tu tiempo comenzará a contar a partir de tu primer inicio de sesión.\n\n` +
      `_¡Gracias por tu compra! Conserva este mensaje._`;

    await sock.sendMessage(senderJid, { text: successMsg }, { quoted: msg });
  } catch (err) {
    console.error('[WhatsApp Bot] Error procesando comprobante:', err);
    await sock.sendMessage(senderJid, {
      text: '⚠️ Ocurrió un inconveniente técnico al validar tu comprobante. Por favor intenta de nuevo en unos momentos o acércate a una caseta física.',
    }, { quoted: msg });
  }
}

async function startWhatsAppBot(forceClean = false) {
  if (!config.whatsapp.enabled) {
    console.log('[WhatsApp Bot] Desactivado en configuración (WHATSAPP_ENABLED=false).');
    _state.status = 'disabled';
    return;
  }

  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  if (_sock) {
    try {
      _sock.ev.removeAllListeners('connection.update');
      _sock.ev.removeAllListeners('creds.update');
      _sock.ev.removeAllListeners('messages.upsert');
      _sock.end(undefined);
    } catch (_) {}
    _sock = null;
  }

  if (forceClean) {
    console.log('[WhatsApp Bot] Limpiando credenciales locales y en Firestore para nuevo QR...');
    await clearAllBaileysAuth(AUTH_DIR);
  } else {
    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      console.log('[WhatsApp Bot] Verificando respaldo de sesión en Firestore...');
      await restoreBaileysAuthFromFirestore(AUTH_DIR);
    }
  }

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  _state.status = 'connecting';
  _state.lastError = null;
  console.log('[WhatsApp Bot] Iniciando servicio de WhatsApp con Baileys...');

  getLivePlans().catch(() => {});
  getLiveKiosks().catch(() => {});

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });

    _sock = sock;

    let _keySyncTimer = null;
    function triggerKeysSync() {
      if (_keySyncTimer) clearTimeout(_keySyncTimer);
      _keySyncTimer = setTimeout(() => {
        syncAllAuthFilesToFirestore(AUTH_DIR).catch(() => {});
      }, 3000);
    }

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        await saveFileToFirestore(AUTH_DIR, 'creds.json');
        triggerKeysSync();
      } catch (err) {
        console.warn('[WhatsApp Bot] Error guardando creds:', err.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        _state.status = 'qr_ready';
        _state.qr = qr;
        try {
          _state.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        } catch (_) {}

        console.log('\n📱 Nuevo código QR disponible en Panel Admin.\n');
        qrcodeTerminal.generate(qr, { small: true });
        syncWhatsAppStateToFirestore();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === 515;
        const isRegistered = Boolean(state.creds?.registered);

        console.log(`[WhatsApp Bot] Conexión cerrada (Código: ${statusCode}). Registrado: ${isRegistered}`);

        if (isLoggedOut) {
          _state.status = 'disconnected';
          _state.qr = null;
          _state.qrCodeDataUrl = null;
          _state.user = null;
          syncWhatsAppStateToFirestore();
          await clearAllBaileysAuth(AUTH_DIR);
          _reconnectTimer = setTimeout(() => startWhatsAppBot(true), 2500);
        } else {
          const delay = isRestartRequired ? 1000 : 2500;
          _state.status = 'connecting';
          if (!isRegistered) syncWhatsAppStateToFirestore();
          _reconnectTimer = setTimeout(() => startWhatsAppBot(false), delay);
        }
      } else if (connection === 'open') {
        _state.status = 'connected';
        _state.qr = null;
        _state.qrCodeDataUrl = null;
        _state.user = sock.user;
        syncWhatsAppStateToFirestore();

        syncAllAuthFilesToFirestore(AUTH_DIR).catch(() => {});

        let rawPhone = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
        if (rawPhone.length === 10 && rawPhone.startsWith('3')) {
          rawPhone = '57' + rawPhone;
        }

        console.log(`[WhatsApp Bot] ✅ Conectado exitosamente como: ${sock.user?.name || rawPhone}`);
        startOutboxPolling();

        if (rawPhone) {
          try {
            const db = getDb();
            db.prepare("INSERT INTO settings (key, value) VALUES ('whatsapp_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(rawPhone);
          } catch (_) {}
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        const msgId = msg.key.id;
        if (_processingMessages.has(msgId)) continue;
        _processingMessages.add(msgId);
        setTimeout(() => _processingMessages.delete(msgId), 30_000);

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '');

        const blockStatus = await checkPhoneBlocked(senderPhone);
        if (blockStatus.isBlocked) {
          const now = Date.now();
          const lastWarned = _warnedSuspended.get(senderPhone) || 0;
          if (now - lastWarned > 2 * 60 * 60 * 1000) {
            _warnedSuspended.set(senderPhone, now);
            await sock.sendMessage(remoteJid, { text: await buildSuspensionMessage() }, { quoted: msg });
          }
          continue;
        }

        if (isRateLimited(senderPhone)) continue;

        const messageContent = msg.message;
        if (!messageContent) continue;

        const isImage = !!(messageContent.imageMessage || (messageContent.documentMessage?.mimetype?.startsWith('image/')));
        if (isImage) {
          _offTopicTracker.delete(senderPhone);
          await processPaymentReceipt(sock, msg, remoteJid);
          continue;
        }

        const text = messageContent.conversation || messageContent.extendedTextMessage?.text || '';
        const norm = normalizeText(text);
        if (!norm) continue;

        const offTopicData = _offTopicTracker.get(senderPhone) || { count: 0, silencedUntil: 0 };
        if (Date.now() < offTopicData.silencedUntil) continue;

        if (_debounceTimers.has(senderPhone)) {
          clearTimeout(_debounceTimers.get(senderPhone));
        }

        const timerId = setTimeout(async () => {
          _debounceTimers.delete(senderPhone);

          const isComplaint =
            norm.includes('queja') || norm.includes('reclamo') || norm.includes('inconforme') ||
            norm.includes('insatisfech') || norm.includes('pesimo') || norm.includes('malo') ||
            norm.includes('no sirve') || norm.includes('no funciona') || norm.includes('no conecta') ||
            norm.includes('lento') || norm.includes('estafa') || norm.includes('robo') ||
            norm.includes('ladron') || norm.includes('devolucion') || norm.includes('devolver') ||
            norm.includes('garantia') || norm.includes('soporte') || norm.includes('problema') ||
            norm.includes('falla') || norm.includes('reclamar') || norm.includes('administrador') ||
            norm.includes('dueno');

          const isKioskQuery =
            norm.includes('caseta') || norm.includes('kiosko') || norm.includes('kiosco') ||
            norm.includes('efectivo') || norm.includes('donde comprar') || norm.includes('tienda') ||
            norm.includes('punto de venta');

          const isGreetingOrQuery =
            norm.includes('hola') || norm.includes('buen') || norm.includes('precio') ||
            norm.includes('plan') || norm.includes('ficha') || norm.includes('internet') ||
            norm.includes('wifi') || norm.includes('comprar') || norm.includes('cuanto') ||
            norm.includes('menu') || norm.includes('daviplata') || norm.includes('bre-b') ||
            norm.includes('ayuda');

          if (isComplaint) {
            _offTopicTracker.delete(senderPhone);
            const db = getDb();
            const senderName = msg.pushName || 'Cliente';
            let cleanPhone = senderPhone.replace('@s.whatsapp.net', '').replace('@lid', '').trim();
            if (cleanPhone.length === 10 && cleanPhone.startsWith('3')) {
              cleanPhone = '57' + cleanPhone;
            }

            let realPhone = null;
            if (remoteJid.endsWith('@lid')) {
              try {
                const resolvedPn = await sock.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
                if (resolvedPn) {
                  const pnStr = typeof resolvedPn === 'string' ? resolvedPn : (resolvedPn.pn || '');
                  const parsed = pnStr.split('@')[0].split(':')[0].replace(/\D/g, '');
                  if (parsed) realPhone = parsed;
                }
              } catch (_) {}
            }

            if (realPhone) {
              cleanPhone = realPhone.length === 10 && realPhone.startsWith('3') ? ('57' + realPhone) : realPhone;
            }

            let radicado = 'PQRS-0001';
            try {
              const res = await firestoreFetch('/complaints?pageSize=300');
              if (res.ok) {
                const fData = await res.json();
                const totalC = (fData.documents || []).length + 1;
                radicado = `PQRS-${String(totalC).padStart(4, '0')}`;
              }
            } catch (_) {
              try {
                const row = db.prepare('SELECT COUNT(*) AS c FROM complaints').get();
                radicado = `PQRS-${String((row?.c || 0) + 1).padStart(4, '0')}`;
              } catch (_) {}
            }

            try {
              db.prepare('INSERT INTO complaints (phone, message, status) VALUES (?, ?, "pending")')
                .run(cleanPhone, text);
            } catch (_) {}

            try {
              await firestoreFetch('/complaints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  fields: toFirestoreFields({
                    radicado,
                    phone: cleanPhone,
                    jid: remoteJid,
                    client_name: senderName,
                    message: text,
                    status: 'pending',
                    admin_notes: '',
                    created_at: new Date().toISOString(),
                  }),
                }),
              });
            } catch (fErr) {
              console.error('[WhatsApp Bot] Error guardando queja en Firestore:', fErr.message);
            }

            let lineDisplay = cleanPhone;
            if (remoteJid.endsWith('@lid') && (!realPhone || cleanPhone.length > 12)) {
              lineDisplay = senderName !== 'Cliente' && senderName !== 'Turista' ? senderName : 'WhatsApp Directo';
            } else {
              lineDisplay = cleanPhone.startsWith('+') ? cleanPhone : ('+' + cleanPhone);
            }

            const complaintMsg =
              `📋 *SOLICITUD DE SOPORTE / QUEJA REGISTRADA*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Radicado: *#${radicado}*\n` +
              `Cliente: *${senderName}*\n` +
              `Línea: *${lineDisplay}*\n` +
              `Estado: *Pendiente de revisión administrativa*\n\n` +
              `Lamentamos los inconvenientes con el servicio. Tu reporte ha quedado registrado formalmente en nuestro panel y el administrador revisará tu caso a la brevedad.\n\n` +
              `_Por favor conserva tu número de radicado #${radicado}._\n` +
              `━━━━━━━━━━━━━━━━━━━━`;
            await sock.sendMessage(remoteJid, { text: complaintMsg });
          } else if (isKioskQuery) {
            _offTopicTracker.delete(senderPhone);
            const kiosksFull = await getKiosksFormatted(true);
            const kioskMsg =
              `🏪 *PUNTOS DE VENTA FÍSICOS (CASETAS Y KIOSKOS)* 🏖️\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Puedes comprar tus fichas directamente en efectivo en:\n\n` +
              `${kiosksFull}\n\n` +
              `_Te esperamos en el Balneario Río Royota._`;
            await sock.sendMessage(remoteJid, { text: kioskMsg });
          } else if (isGreetingOrQuery) {
            _offTopicTracker.delete(senderPhone);
            const menu = await buildMenuMessage();
            await sock.sendMessage(remoteJid, { text: menu });
          } else {
            offTopicData.count += 1;
            if (offTopicData.count >= 3) {
              offTopicData.silencedUntil = Date.now() + 60 * 60 * 1000;
              _offTopicTracker.set(senderPhone, offTopicData);
              const silenceMsg =
                `🤖 *Atención:* Para evitar saturación del servicio, se ha pausado la atención automática por 1 hora.\n\n` +
                `Si deseas comprar una ficha de internet, acércate a una de nuestras casetas físicas o escribe *PLANES* más tarde.`;
              await sock.sendMessage(remoteJid, { text: silenceMsg });
            } else {
              _offTopicTracker.set(senderPhone, offTopicData);
              const offTopicMsg =
                `👋 ¡Hola! Soy el asistente virtual de *WiFi ROYOTA*.\n\n` +
                `Solo puedo atender consultas de compra de fichas de internet. Escribe *PLANES* para ver los precios o envía la foto de tu pago por Daviplata / Bre-B para recibir tu ficha.\n\n` +
                `Si deseas pagar en efectivo, escribe *CASETAS*.`;
              await sock.sendMessage(remoteJid, { text: offTopicMsg });
            }
          }
        }, 2500);

        _debounceTimers.set(senderPhone, timerId);
      }
    });
  } catch (err) {
    console.error('[WhatsApp Bot] Error al inicializar:', err);
    _state.status = 'disconnected';
    _state.lastError = err.message;
    setTimeout(() => startWhatsAppBot(), 10_000);
  }
}

function getBotStatus() {
  const db = getDb();
  let botNumber = '';
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_number'").get();
    botNumber = row ? row.value : '';
  } catch (_) {}

  if (_state.status === 'disconnected' && !_sock && !_reconnectTimer) {
    startWhatsAppBot(false).catch(() => {});
  }

  const rawBotPhone = _state.user?.id
    ? _state.user.id.split(':')[0].replace(/\D/g, '')
    : botNumber;

  return {
    ..._state,
    botPhone: rawBotPhone || null,
    paymentPhone: config.whatsapp.paymentPhone,
    hasGeminiKey: !!config.whatsapp.geminiApiKey,
  };
}

async function logoutBot() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_sock) {
    try {
      _sock.ev.removeAllListeners('connection.update');
      _sock.ev.removeAllListeners('creds.update');
      _sock.ev.removeAllListeners('messages.upsert');
      await _sock.logout();
    } catch (_) {}
    _sock = null;
  }
  _state.status = 'disconnected';
  _state.user = null;
  _state.qr = null;
  _state.qrCodeDataUrl = null;
  await clearAllBaileysAuth(AUTH_DIR);
  await syncWhatsAppStateToFirestore();
  setTimeout(() => startWhatsAppBot(true), 2000);
  return { success: true, message: 'Sesión de WhatsApp cerrada y credenciales eliminadas. Escanea un nuevo QR.' };
}

async function restartBot() {
  return await startWhatsAppBot(false);
}

let _outboxPollingInterval = null;

async function checkWhatsAppOutbox() {
  if (!_sock || _state.status !== 'connected') return;

  try {
    const res = await firestoreFetch('/whatsapp_outbox?pageSize=15');
    if (!res.ok) return;

    const data = await res.json();
    if (!data.documents || !data.documents.length) return;

    for (const doc of data.documents) {
      const f = doc.fields || {};
      const sent = f.sent ? f.sent.booleanValue : false;
      if (sent) continue;

      const docId = doc.name.split('/').pop();
      if (_outboxDispatching.has(docId)) continue;

      const phone = f.phone ? f.phone.stringValue : '';
      const target = f.target ? f.target.stringValue : (f.jid ? f.jid.stringValue : phone);
      const message = f.message ? f.message.stringValue : '';
      const complaintId = f.complaint_id ? f.complaint_id.stringValue : null;
      const statusVal = f.status ? f.status.stringValue : 'resolved';

      if (!target || !message) continue;

      _outboxDispatching.add(docId);
      try {
        await sendDirectWhatsAppMessage(target, message);

        await firestoreFetch(`/whatsapp_outbox/${encodeURIComponent(docId)}?updateMask.fieldPaths=sent&updateMask.fieldPaths=sent_at`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: toFirestoreFields({
              sent: true,
              sent_at: new Date().toISOString(),
            }),
          }),
        });

        if (complaintId) {
          const noteEntry = `[WhatsApp ${new Date().toLocaleTimeString('es-CO')}]: ${message}`;
          await firestoreFetch(`/complaints/${encodeURIComponent(complaintId)}?updateMask.fieldPaths=status&updateMask.fieldPaths=admin_notes&updateMask.fieldPaths=updated_at`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: toFirestoreFields({
                status: statusVal,
                admin_notes: noteEntry,
                updated_at: new Date().toISOString(),
              }),
            }),
          }).catch(() => {});
        }
      } catch (sendErr) {
        console.error(`[WhatsApp Outbox] ❌ Error enviando a ${target}:`, sendErr.message);
      } finally {
        _outboxDispatching.delete(docId);
      }
    }
  } catch (_) {}
}

function startOutboxPolling() {
  if (_outboxPollingInterval) clearInterval(_outboxPollingInterval);
  checkWhatsAppOutbox();
  _outboxPollingInterval = setInterval(checkWhatsAppOutbox, 3500);
}

async function sendDirectWhatsAppMessage(phoneOrJid, messageText) {
  if (!_sock || _state.status !== 'connected') {
    throw new Error('El bot de WhatsApp no está conectado actualmente. Verifica que el bot esté en verde en el panel.');
  }

  const raw = String(phoneOrJid || '').trim();
  let jid = '';
  if (raw.endsWith('@lid') || raw.endsWith('@s.whatsapp.net')) {
    jid = raw;
  } else if (raw.length > 12 && !raw.startsWith('57')) {
    jid = raw + '@lid';
  } else {
    let clean = raw.replace(/\D/g, '');
    if (clean.length === 10 && clean.startsWith('3')) {
      clean = '57' + clean;
    }
    if (!clean || clean.length < 8) {
      throw new Error('Número de teléfono o destinatario inválido: ' + phoneOrJid);
    }
    jid = clean + '@s.whatsapp.net';
  }

  const text = String(messageText || '').trim();
  if (!text) {
    throw new Error('El mensaje no puede estar vacío');
  }

  await _sock.sendMessage(jid, { text });
  console.log(`[WhatsApp Bot] 💬 Mensaje directo enviado desde el panel a ${jid}`);
  return { success: true, message: `Mensaje enviado exitosamente a ${jid}` };
}

module.exports = {
  startWhatsAppBot,
  getBotStatus,
  logoutBot,
  restartBot,
  recordStrike,
  clearStrikes,
  checkPhoneBlocked,
  sendDirectWhatsAppMessage,
  getLivePlans,
  getLiveKiosks,
  invalidateKiosksCache,
};
