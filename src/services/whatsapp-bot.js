/**
 * src/services/whatsapp-bot.js
 * ─────────────────────────────────────────────────────────────
 * Servicio de Automatización de WhatsApp con IA para Hotspot Fichas ROYOTA.
 *
 * Módulos de Seguridad y Prevención de Fraudes:
 * 1. Anti-Spam / Rate Limiting (Máx 4 mensajes por minuto).
 * 2. Agrupamiento Debounce (2.5 segundos para evitar respuestas repetitivas).
 * 3. Cooldown de comprobantes (30 segundos entre imágenes).
 * 4. Filtro Anti-Desvío (Silencio de 1 hora si acumula 3 mensajes fuera de tema).
 * 5. Sistema de 3 Strikes con Bloqueo de 24 Horas y Redirección a Casetas Físicas.
 * 6. Integración y sugerencia dinámica de Kioskos / Puntos de Venta Físicos.
 * 7. Aislamiento Total: Generación exclusiva de fichas WSP- sin tocar fichas impresas.
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

// Directorio para almacenar credenciales de sesión de WhatsApp
const AUTH_DIR = path.join(__dirname, '..', '..', 'data', 'baileys_auth');

const logger = pino({ level: 'silent' });

let _sock = null;
let _reconnectTimer = null;
let _isStarting = false;
let _state = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'disabled'
  qr: null,
  qrCodeDataUrl: null,
  user: null,
  lastError: null,
};

// ── Control de concurrencia y seguridad en memoria ────────────
const _processingMessages = new Set();
const _messageTimestamps  = new Map(); // phone -> [timestamps] (Rate limiting)
const _imageLastSent      = new Map(); // phone -> timestamp (Cooldown 30s)
const _debounceTimers     = new Map(); // phone -> timerId (Debounce 2.5s)
const _offTopicTracker    = new Map(); // phone -> { count: number, silencedUntil: number }
const _warnedSuspended    = new Map(); // phone -> timestamp (Evitar spam de aviso de bloqueo)

/**
 * Normaliza una cadena de texto para comparación flexible
 */
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Normaliza número de teléfono o cuenta destino
 */
function cleanPhoneDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

/**
 * Obtiene la lista formateada de kioskos / casetas activas
 */
function getKiosksFormatted(full = false) {
  try {
    const db = getDb();
    const kiosks = db.prepare('SELECT * FROM kiosks WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').all();
    if (!kiosks.length) {
      return '• Taquilla Principal del Balneario (Entrada)';
    }
    return kiosks.map(k => {
      let line = `📍 *${k.name}:* ${k.location}`;
      if (full && k.notes) line += ` _(${k.notes})_`;
      return line;
    }).join('\n');
  } catch (err) {
    return '• Taquilla Principal del Balneario';
  }
}

/**
 * Verifica si un número está actualmente bloqueado por strikes
 */
function checkPhoneBlocked(phone) {
  try {
    const db = getDb();
    const clean = cleanPhoneDigits(phone);
    const row = db.prepare('SELECT strikes, blocked_until, last_reason FROM whatsapp_strikes WHERE phone = ?').get(clean);
    if (!row || !row.blocked_until) return { isBlocked: false, strikes: row ? row.strikes : 0 };

    const blockedUntilDate = new Date(row.blocked_until);
    if (blockedUntilDate > new Date()) {
      return { isBlocked: true, blockedUntil: row.blocked_until, strikes: row.strikes, lastReason: row.last_reason };
    }
    return { isBlocked: false, strikes: row.strikes };
  } catch (err) {
    console.error('[WhatsApp Bot] Error checking block status:', err);
    return { isBlocked: false, strikes: 0 };
  }
}

/**
 * Registra un intento inválido (Strike) y aplica suspensión de 24h al acumular 2 intentos
 */
function recordStrike(phone, reason) {
  const db = getDb();
  const clean = cleanPhoneDigits(phone);
  const existing = db.prepare('SELECT strikes FROM whatsapp_strikes WHERE phone = ?').get(clean);

  const currentStrikes = (existing ? existing.strikes : 0) + 1;
  let blockedUntil = null;
  let isBlocked = false;

  // LÍMITE: Máximo 2 intentos para comprobantes
  if (currentStrikes >= 2) {
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    blockedUntil = in24h;
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

  return { strikes: currentStrikes, isBlocked, blockedUntil };
}

/**
 * Limpia los strikes tras un pago exitoso
 */
function clearStrikes(phone) {
  try {
    const db = getDb();
    const clean = cleanPhoneDigits(phone);
    db.prepare(`
      UPDATE whatsapp_strikes
      SET strikes = 0, blocked_until = NULL, last_reason = 'Pago exitoso verificado', updated_at = datetime('now')
      WHERE phone = ?
    `).run(clean);
  } catch (_) {}
}

/**
 * Rate Limiting: Máximo 4 mensajes por minuto por usuario
 */
function isRateLimited(phone) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxMsgs = 4;

  let timestamps = _messageTimestamps.get(phone) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);

  if (timestamps.length >= maxMsgs) {
    return true;
  }

  timestamps.push(now);
  _messageTimestamps.set(phone, timestamps);
  return false;
}

/**
 * Genera el mensaje del catálogo de planes, medios de pago y casetas físicas
 */
function buildMenuMessage() {
  const db = getDb();
  const plans = db.prepare(
    'SELECT name, duration, speed_limit, price FROM plans WHERE is_active = 1 ORDER BY sort_order ASC, price ASC'
  ).all();

  const businessName = config.business.name || 'Balneario Río Royota';
  const paymentPhone = config.whatsapp.paymentPhone || '3174251419';
  const kiosksList = getKiosksFormatted(false);

  let msg = `📶 *¡Bienvenido a ${businessName}!* 🚀\n`;
  msg += `Compra tu ficha de internet de forma 100% automática.\n\n`;
  msg += `📋 *PLANES DISPONIBLES:*\n`;

  plans.forEach((p, idx) => {
    const formattedPrice = Number(p.price).toLocaleString('es-CO');
    msg += `${idx + 1}️⃣ *${p.name}* (${p.duration}) → *$${formattedPrice} COP*\n`;
  });

  msg += `\n💳 *MEDIOS DE PAGO VIRTUALES:*\n`;
  msg += `• *Daviplata:* \`${paymentPhone}\`\n`;
  msg += `• *Llave Bre-B (Transfiya):* \`${paymentPhone}\`\n\n`;
  msg += `📸 *¿CÓMO COMPRAR EN LÍNEA?*\n`;
  msg += `1. Realiza la transferencia del valor exacto a nuestro número.\n`;
  msg += `2. *Envía la captura de pantalla del comprobante aquí mismo.* 📸\n`;
  msg += `3. Nuestra IA validará tu pago y *te entregará tu código en segundos.* ⚡\n\n`;
  msg += `🏪 *¿PREFIERES PAGAR EN EFECTIVO?*\n`;
  msg += `Puedes adquirir tu ficha física directamente en nuestras casetas autorizadas:\n${kiosksList}\n`;

  return msg;
}

/**
 * Mensaje de suspensión formal cuando un usuario alcanza 2 intentos fallidos
 */
function buildSuspensionMessage() {
  const kiosksList = getKiosksFormatted(true);
  return `🚫 *NÚMERO TEMPORALMENTE SUSPENDIDO* 🚫\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Has alcanzado el límite de *2 intentos no válidos* de comprobante. Por medidas de seguridad y prevención de fraudes, tu número ha sido suspendido por *24 horas* para compras en línea.\n\n` +
    `🏪 *SOLO ES POSIBLE LA COMPRA EN CASETA FÍSICA:*\n` +
    `A partir de este momento, solo es posible adquirir tu ticket de internet directamente en efectivo en cualquiera de nuestras casetas autorizadas en el balneario:\n\n` +
    `${kiosksList}\n\n` +
    `_Te esperamos en el Balneario Río Royota._\n` +
    `━━━━━━━━━━━━━━━━━━━━`;
}

/**
 * Helper para formatear advertencia de strike
 */
function formatStrikeWarning(strike) {
  if (strike.isBlocked) return '';
  const kiosksShort = getKiosksFormatted(false);
  return `\n\n⚠️ *ADVERTENCIA (Intento 1 de 2):* Te queda solo 1 intento más. De no ser aprobado tu comprobante, tu número será suspendido por 24 horas y solo podrás adquirir el ticket en tienda física (casetas autorizadas).\n\n🏪 *Casetas físicas para pago en efectivo:*\n${kiosksShort}`;
}

/**
 * Procesa la imagen del comprobante de pago enviada por el cliente
 */
async function processPaymentReceipt(sock, msg, senderJid) {
  const senderPhone = senderJid.replace('@s.whatsapp.net', '');
  const targetPhone = config.whatsapp.paymentPhone || '3174251419';

  // 1. Cooldown de imágenes: máx 1 imagen cada 30 segundos
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
    // 2. Avisar al usuario que la IA está analizando
    await sock.sendMessage(senderJid, {
      text: '🔍 *Comprobante recibido.* Estamos validando tu pago con nuestra IA, por favor espera unos segundos...',
    }, { quoted: msg });

    // 3. Descargar la imagen
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

    // 4. Analizar con Gemini Vision
    if (!config.whatsapp.geminiApiKey) {
      console.warn('[WhatsApp Bot] Falta GEMINI_API_KEY en configuración.');
      await sock.sendMessage(senderJid, {
        text: '⚠️ El servicio de validación automática por IA no está activo en este momento. Un administrador revisará tu pago manualmente.',
      }, { quoted: msg });
      return;
    }

    const analysis = await analyzeReceipt(imageBuffer, 'image/jpeg');
    console.log('[WhatsApp Bot] Resultado Gemini:', analysis);

    // ── VALIDADOR 0: Detección Forense de Manipulación / Edición Digital ──
    if (analysis.is_tampered) {
      const reason = analysis.tamper_reason || 'Se detectaron alteraciones o tipografía inconsistente en el comprobante.';
      const strike = recordStrike(senderPhone, `Comprobante alterado/editado: ${reason}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `🚫 *Comprobante no válido (Inconsistencias detectadas)*\n\nEl sistema de auditoría detectó posibles alteraciones o edición digital en los datos del comprobante (${reason}).${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 1: ¿Es un comprobante de pago válido y exitoso? ──
    if (!analysis.is_payment_receipt || !analysis.is_successful) {
      const reason = analysis.rejection_reason || 'La imagen no corresponde a un comprobante de pago exitoso o legible.';
      const strike = recordStrike(senderPhone, `Comprobante inválido: ${reason}`);

      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ *No se pudo validar el pago*\n\nMotivo: ${reason}\n\nPor favor envía una captura de pantalla original y nítida donde se observe claramente el valor, el número de aprobación y la cuenta de destino.${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 2: Destino autorizado (Daviplata / Bre-B) ────────
    const cleanedExtractedDest = cleanPhoneDigits(analysis.destination_phone);
    const cleanedTarget = cleanPhoneDigits(targetPhone);

    if (cleanedExtractedDest && !cleanedExtractedDest.includes(cleanedTarget) && !cleanedTarget.includes(cleanedExtractedDest)) {
      const strike = recordStrike(senderPhone, `Destino incorrecto: ${analysis.destination_phone}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ *Cuenta de destino incorrecta*\n\nEl comprobante muestra destino: *${analysis.destination_phone}*, pero el pago debe ser transferido a la cuenta autorizada: *${targetPhone}*.${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 3: Referencia única anti-fraude ─────────────────
    const cleanRef = String(analysis.reference_number || '').trim().toUpperCase();
    if (!cleanRef || cleanRef.length < 3) {
      const strike = recordStrike(senderPhone, 'Referencia no identificada en la imagen');
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `❌ No se pudo identificar el número de referencia o aprobación en el comprobante. Por favor envía una captura más nítida.${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    const db = getDb();
    const existingRef = db.prepare('SELECT id, created_at FROM whatsapp_payments WHERE reference_number = ?').get(cleanRef);
    if (existingRef) {
      const strike = recordStrike(senderPhone, `Comprobante duplicado: ${cleanRef}`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        await sock.sendMessage(senderJid, {
          text: `⚠️ *Comprobante duplicado / Reutilizado*\n\nEste comprobante (Ref: *${cleanRef}*) ya fue registrado y procesado anteriormente el día ${existingRef.created_at}.\nCada comprobante es válido para una única ficha de internet.${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── VALIDADOR 4: Coincidencia de monto con planes ─────────────
    const paidAmount = Number(analysis.amount);
    const activePlans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
    const matchedPlan = activePlans.find(p => Math.abs(p.price - paidAmount) < 50);

    if (!matchedPlan) {
      const strike = recordStrike(senderPhone, `Monto $${paidAmount} no coincide con planes`);
      if (strike.isBlocked) {
        await sock.sendMessage(senderJid, { text: buildSuspensionMessage() }, { quoted: msg });
      } else {
        const formattedPaid = paidAmount.toLocaleString('es-CO');
        let planListStr = activePlans.map(p => `• *${p.name}* (${p.duration}) → *$${p.price.toLocaleString('es-CO')} COP*`).join('\n');
        await sock.sendMessage(senderJid, {
          text: `⚠️ *Monto recibido no coincide con ningún plan*\n\nDetectamos un pago por *$${formattedPaid} COP*, pero actualmente no coincide con el valor exacto de ninguno de nuestros planes disponibles:\n\n${planListStr}${formatStrikeWarning(strike)}`,
        }, { quoted: msg });
      }
      return;
    }

    // ── PAGO VÁLIDO: Limpiar strikes acumulados ────────────────────
    clearStrikes(senderPhone);

    // 🔒 AISLAMIENTO TOTAL: El bot SOLO toma o genera fichas con prefijo WSP-
    // NUNCA toma fichas impresas ni lotes de las casetas físicas.
    let voucher = db.prepare(
      'SELECT * FROM vouchers WHERE plan_id = ? AND status = "available" AND code LIKE "WSP-%" LIMIT 1'
    ).get(matchedPlan.id);

    if (!voucher) {
      console.log(`[WhatsApp Bot] Generando ficha digital exclusiva (WSP-) para el plan ${matchedPlan.name}...`);
      const batchResult = await generateBatch({
        planId: matchedPlan.id,
        quantity: 1,
        codeLength: 8,
        charset: 'full',
        prefix: 'WSP-',
        batchNote: `Venta digital WhatsApp (${senderPhone})`,
      });

      const newCode = batchResult.codes[0];
      voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(newCode);
    }

    // Provisionar en el MikroTik del Balneario (Vía REST directo o encolado para Cloud Sync)
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
      console.warn('[WhatsApp Bot] Aviso sincronización directa MikroTik (se entregará por Cloud Sync al router):', mkErr.message);
    }

    // Registrar la venta y el pago en la BD de forma atómica
    const paymentPlatform = analysis.platform || 'Daviplata/Bre-B';
    const transaction = db.transaction(() => {
      // Marcar ficha como vendida
      db.prepare(`
        UPDATE vouchers
        SET status = 'sold', sold_at = datetime('now'),
            payment_method = ?, buyer_note = ?
        WHERE id = ?
      `).run(paymentPlatform.toLowerCase(), `WhatsApp: ${senderPhone} | Ref: ${cleanRef}`, voucher.id);

      // Registrar venta en historial contable
      db.prepare(`
        INSERT INTO sales (voucher_id, plan_id, amount, payment_method, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(voucher.id, matchedPlan.id, matchedPlan.price, paymentPlatform.toLowerCase(), `Auto-venta WhatsApp (${cleanRef})`);

      // Registrar pago en tabla anti-fraude
      db.prepare(`
        INSERT INTO whatsapp_payments (reference_number, platform, sender_phone, amount, destination, voucher_id, plan_id, raw_analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cleanRef, paymentPlatform, senderPhone, paidAmount, targetPhone, voucher.id, matchedPlan.id, JSON.stringify(analysis));
    });

    transaction();
    console.log(`[WhatsApp Bot] ✅ Venta completada con éxito. Ficha: ${voucher.code} para ${senderPhone}`);

    // Enviar la ficha al cliente
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
      text: `⚠️ Ocurrió un error al procesar tu comprobante: ${err.message}. Un administrador lo revisará en breve.`,
    }, { quoted: msg });
  }
}

/**
 * Inicia la conexión de WhatsApp
 */
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

  // Cerrar y remover listeners del socket previo si existía para evitar sesiones duplicadas
  if (_sock) {
    try {
      _sock.ev.removeAllListeners('connection.update');
      _sock.ev.removeAllListeners('creds.update');
      _sock.ev.removeAllListeners('messages.upsert');
      _sock.end(undefined);
    } catch (_) {}
    _sock = null;
  }

  if (forceClean && fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[WhatsApp Bot] Credenciales limpiadas para generar nuevo QR limpio.');
    } catch (_) {}
  }

  // Asegurar directorio de datos de autenticación
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  _state.status = 'connecting';
  _state.lastError = null;
  console.log('[WhatsApp Bot] Iniciando servicio de WhatsApp con Baileys...');

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
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    _sock = sock;

    // Guardar credenciales al actualizarse
    sock.ev.on('creds.update', saveCreds);

    // Eventos de estado de conexión
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        _state.status = 'qr_ready';
        _state.qr = qr;
        try {
          _state.qrCodeDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        } catch (_) {}

        console.log('\n╔════════════════════════════════════════════════════════════════════╗');
        console.log('║ 📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP PARA VINCULAR EL BOT:   ║');
        console.log('╚════════════════════════════════════════════════════════════════════╝\n');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('\n(También puedes ver el QR desde el Panel de Administración)\n');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === 515;
        const isRegistered = Boolean(state.creds?.registered);

        console.log(`[WhatsApp Bot] Conexión cerrada (Código: ${statusCode}). Registrado: ${isRegistered}`);

        _state.status = 'disconnected';
        _state.qr = null;
        _state.qrCodeDataUrl = null;
        _state.user = null;

        if (isLoggedOut) {
          console.log('[WhatsApp Bot] Sesión cerrada permanentemente (Logged Out). Limpiando credenciales...');
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
          _reconnectTimer = setTimeout(() => startWhatsAppBot(true), 2500);
        } else {
          // Si no es Logout, conservar credenciales para no interrumpir el emparejamiento
          const delay = isRestartRequired ? 1000 : 3000;
          console.log(`[WhatsApp Bot] Reconectando sesión de WhatsApp en ${delay}ms...`);
          _state.status = 'connecting';
          _reconnectTimer = setTimeout(() => startWhatsAppBot(false), delay);
        }
      } else if (connection === 'open') {
        _state.status = 'connected';
        _state.qr = null;
        _state.qrCodeDataUrl = null;
        _state.user = sock.user;

        let rawPhone = (sock.user?.id || '').split(':')[0].replace(/\D/g, '');
        if (rawPhone.length === 10 && rawPhone.startsWith('3')) {
          rawPhone = '57' + rawPhone;
        }

        console.log(`[WhatsApp Bot] ✅ Conectado exitosamente como: ${sock.user?.name || rawPhone}`);

        // AUTO-DETECCIÓN DEL NÚMERO DEL BOT:
        // Se actualiza en la tabla settings para que el portal cautivo envíe
        // a los turistas directamente al WhatsApp de este bot.
        if (rawPhone) {
          try {
            const db = getDb();
            db.prepare("INSERT INTO settings (key, value) VALUES ('whatsapp_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(rawPhone);
            console.log(`[WhatsApp Bot] 📱 'whatsapp_number' guardado automáticamente: ${rawPhone}`);
          } catch (e) {
            console.warn('[WhatsApp Bot] No se pudo guardar en settings local:', e.message);
          }
        }
      }
    });

    // Manejo de mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Ignorar mensajes enviados por el propio bot
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        // Solo atender mensajes directos (no grupos ni estados)
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        // Evitar procesar el mismo mensaje varias veces
        const msgId = msg.key.id;
        if (_processingMessages.has(msgId)) continue;
        _processingMessages.add(msgId);
        setTimeout(() => _processingMessages.delete(msgId), 30000);

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '');

        // ── FILTRO 1: ¿El número está suspendido por 24 horas? ──────
        const blockStatus = checkPhoneBlocked(senderPhone);
        if (blockStatus.isBlocked) {
          const now = Date.now();
          const lastWarned = _warnedSuspended.get(senderPhone) || 0;
          // Solo enviar el aviso de suspensión una vez cada 2 horas para no spamear
          if (now - lastWarned > 2 * 60 * 60 * 1000) {
            _warnedSuspended.set(senderPhone, now);
            await sock.sendMessage(remoteJid, { text: buildSuspensionMessage() }, { quoted: msg });
          }
          continue; // No procesar ninguna petición de números bloqueados
        }

        // ── FILTRO 2: Rate Limiting (Máx 4 mensajes por minuto) ─────
        if (isRateLimited(senderPhone)) {
          console.warn(`[WhatsApp Bot] Rate limit activo para ${senderPhone}`);
          continue; // Ignorar silenciosamente mensajes excesivos
        }

        const messageContent = msg.message;
        if (!messageContent) continue;

        // 1. ¿Es una imagen? (Posible comprobante de pago)
        const isImage = !!(messageContent.imageMessage || (messageContent.documentMessage?.mimetype?.startsWith('image/')));

        if (isImage) {
          // Resetear contador de off-topic porque el usuario está intentando pagar
          _offTopicTracker.delete(senderPhone);
          await processPaymentReceipt(sock, msg, remoteJid);
          continue;
        }

        // 2. ¿Es un mensaje de texto?
        const text = messageContent.conversation || messageContent.extendedTextMessage?.text || '';
        const norm = normalizeText(text);

        if (!norm) continue;

        // ── FILTRO 3: ¿El usuario está en silencio temporal (off-topic)?
        const offTopicData = _offTopicTracker.get(senderPhone) || { count: 0, silencedUntil: 0 };
        if (Date.now() < offTopicData.silencedUntil) {
          continue; // El bot permanece en silencio para este usuario
        }

        // ── DEBOUNCE (2.5 segundos): Agrupar ráfagas de mensajes de texto
        if (_debounceTimers.has(senderPhone)) {
          clearTimeout(_debounceTimers.get(senderPhone));
        }

        const timerId = setTimeout(async () => {
          _debounceTimers.delete(senderPhone);

          // Palabras clave de Quejas, Reclamos, Insatisfacción y Soporte (PQRS)
          const isComplaint =
            norm.includes('queja') ||
            norm.includes('reclamo') ||
            norm.includes('inconforme') ||
            norm.includes('insatisfech') ||
            norm.includes('pesimo') ||
            norm.includes('malo') ||
            norm.includes('no sirve') ||
            norm.includes('no funciona') ||
            norm.includes('no conecta') ||
            norm.includes('lento') ||
            norm.includes('estafa') ||
            norm.includes('robo') ||
            norm.includes('ladron') ||
            norm.includes('devolucion') ||
            norm.includes('devolver') ||
            norm.includes('garantia') ||
            norm.includes('soporte') ||
            norm.includes('problema') ||
            norm.includes('falla') ||
            norm.includes('reclamar') ||
            norm.includes('administrador') ||
            norm.includes('dueno');

          // Palabras clave de consulta de Kioskos / Puntos de Venta
          const isKioskQuery =
            norm.includes('caseta') ||
            norm.includes('kiosko') ||
            norm.includes('kiosco') ||
            norm.includes('efectivo') ||
            norm.includes('donde comprar') ||
            norm.includes('tienda') ||
            norm.includes('punto de venta');

          // Palabras clave de planes y compra
          const isGreetingOrQuery =
            norm.includes('hola') ||
            norm.includes('buen') ||
            norm.includes('precio') ||
            norm.includes('plan') ||
            norm.includes('ficha') ||
            norm.includes('internet') ||
            norm.includes('wifi') ||
            norm.includes('comprar') ||
            norm.includes('cuanto') ||
            norm.includes('menu') ||
            norm.includes('daviplata') ||
            norm.includes('bre-b') ||
            norm.includes('ayuda');

          if (isComplaint) {
            _offTopicTracker.delete(senderPhone);
            const db = getDb();
            let radicado = 'PQRS-0001';
            try {
              const res = db.prepare('INSERT INTO complaints (phone, message, status) VALUES (?, ?, "pending")')
                .run(senderPhone, text);
              radicado = `PQRS-${String(res.lastInsertRowid).padStart(4, '0')}`;
              console.log(`[WhatsApp Bot] 📋 Queja registrada #${radicado} de ${senderPhone}`);
            } catch (cErr) {
              console.error('[WhatsApp Bot] Error guardando queja:', cErr);
            }

            const kiosksFull = getKiosksFormatted(true);
            const complaintMsg =
              `📋 *SOLICITUD DE SOPORTE / QUEJA REGISTRADA*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Radicado: *#${radicado}*\n` +
              `Línea: *${senderPhone}*\n` +
              `Estado: *Pendiente de revisión administrativa*\n\n` +
              `Lamentamos mucho los inconvenientes con el servicio. Tu reporte ha quedado registrado formalmente en nuestro panel y el administrador revisará tu caso a la brevedad para darte solución o gestionar la reposición de tu servicio.\n\n` +
              `🏪 *Soporte Presencial en el Balneario:*\n` +
              `Si te encuentras en el balneario, también puedes acercarte a cualquiera de nuestras casetas autorizadas donde el personal te asistirá directamente:\n\n` +
              `${kiosksFull}\n\n` +
              `_Por favor conserva tu número de radicado #${radicado}._\n` +
              `━━━━━━━━━━━━━━━━━━━━`;
            await sock.sendMessage(remoteJid, { text: complaintMsg });
          } else if (isKioskQuery) {
            _offTopicTracker.delete(senderPhone);
            const kiosksFull = getKiosksFormatted(true);
            const kioskMsg =
              `🏪 *PUNTOS DE VENTA FÍSICOS (CASETAS Y KIOSKOS)* 🏖️\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Puedes comprar tus fichas directamente en efectivo en:\n\n` +
              `${kiosksFull}\n\n` +
              `_Te esperamos en el Balneario Río Royota._`;
            await sock.sendMessage(remoteJid, { text: kioskMsg });
          } else if (isGreetingOrQuery) {
            _offTopicTracker.delete(senderPhone);
            const menu = buildMenuMessage();
            await sock.sendMessage(remoteJid, { text: menu });
          } else {
            // Conversación fuera de tema (Off-topic)
            offTopicData.count += 1;

            if (offTopicData.count >= 3) {
              // Silenciar por 1 hora
              offTopicData.silencedUntil = Date.now() + 60 * 60 * 1000;
              _offTopicTracker.set(senderPhone, offTopicData);

              const silenceMsg =
                `🤖 *Atención:* Para evitar saturación del servicio, se ha pausado la atención automática por 1 hora.\n\n` +
                `Si deseas comprar una ficha de internet, acércate a una de nuestras casetas físicas en el balneario o escribe la palabra *PLANES* más tarde.`;
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
    setTimeout(() => startWhatsAppBot(), 10000);
  }
}

/**
 * Obtener estado actual del bot
 */
function getBotStatus() {
  const db = getDb();
  let botNumber = '';
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_number'").get();
    botNumber = row ? row.value : '';
  } catch (_) {}

  // Si está desconectado y no hay proceso en curso, activar generación/conexión
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

/**
 * Cerrar sesión manual
 */
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
  if (fs.existsSync(AUTH_DIR)) {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  setTimeout(() => startWhatsAppBot(true), 2000);
  return { success: true, message: 'Sesión cerrada. Escanea un nuevo QR.' };
}

/**
 * Reiniciar bot y forzar nuevo QR limpio
 */
async function restartBot() {
  return await startWhatsAppBot(true);
}

module.exports = {
  startWhatsAppBot,
  getBotStatus,
  logoutBot,
  restartBot,
  recordStrike,
  clearStrikes,
  checkPhoneBlocked,
};
