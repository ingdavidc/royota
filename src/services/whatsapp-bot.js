/**
 * src/services/whatsapp-bot.js
 * ─────────────────────────────────────────────────────────────
 * Servicio de Automatización de WhatsApp con IA para Hotspot Fichas ROYOTA.
 *
 * Utiliza Baileys (@whiskeysockets/baileys) para conexión directa nativa
 * sin necesidad de contenedores adicionales ni Chrome headless.
 *
 * Flujo:
 * 1. Responde automáticamente consultas de planes y métodos de pago.
 * 2. Recibe imágenes de comprobantes (Daviplata / Llave Bre-B / Transfiya).
 * 3. Analiza el comprobante con Google Gemini Flash (visión multimodal).
 * 4. Valida monto, cuenta de destino y número de comprobante contra duplicados.
 * 5. Genera o despacha una ficha activa y la entrega de inmediato en el chat.
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
} = require('@whiskeysockets/baileys');

const config = require('../config');
const { getDb } = require('../database');
const { generateBatch } = require('./voucher-generator');
const { analyzeReceipt } = require('./gemini-vision');

// Directorio para almacenar credenciales de sesión de WhatsApp
const AUTH_DIR = path.join(__dirname, '..', '..', 'data', 'baileys_auth');

const logger = pino({ level: 'silent' });

let _sock = null;
let _state = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'disabled'
  qr: null,
  qrCodeDataUrl: null,
  user: null,
  lastError: null,
};

// Control de concurrencia para evitar doble procesamiento de un mismo mensaje
const _processingMessages = new Set();

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
 * Genera el mensaje del catálogo de planes y medios de pago
 */
function buildMenuMessage() {
  const db = getDb();
  const plans = db.prepare(
    'SELECT name, duration, speed_limit, price FROM plans WHERE is_active = 1 ORDER BY sort_order ASC, price ASC'
  ).all();

  const businessName = config.business.name || 'WiFi ROYOTA';
  const paymentPhone = config.whatsapp.paymentPhone || '3174251419';

  let msg = `📶 *¡Bienvenido a ${businessName}!* 🚀\n`;
  msg += `Compra tu ficha de internet de forma 100% automática.\n\n`;
  msg += `📋 *PLANES DISPONIBLES:*\n`;

  plans.forEach((p, idx) => {
    const formattedPrice = Number(p.price).toLocaleString('es-CO');
    msg += `${idx + 1}️⃣ *${p.name}* (${p.duration}) → *$${formattedPrice} COP*\n`;
  });

  msg += `\n💳 *MEDIOS DE PAGO AUTORIZADOS:*\n`;
  msg += `• *Daviplata:* \`${paymentPhone}\`\n`;
  msg += `• *Llave Bre-B (Transfiya):* \`${paymentPhone}\`\n\n`;
  msg += `📸 *¿CÓMO COMPRAR?*\n`;
  msg += `1. Realiza la transferencia del valor exacto del plan deseado a nuestro número.\n`;
  msg += `2. *Envía la captura de pantalla del comprobante aquí mismo.* 📸\n`;
  msg += `3. Nuestra IA validará tu pago y *te entregará tu código de ficha en segundos.* ⚡\n`;

  return msg;
}

/**
 * Procesa la imagen del comprobante de pago enviada por el cliente
 */
async function processPaymentReceipt(sock, msg, senderJid) {
  const senderPhone = senderJid.replace('@s.whatsapp.net', '');
  const targetPhone = config.whatsapp.paymentPhone || '3174251419';

  try {
    // 1. Reaccionar o avisar al usuario
    await sock.sendMessage(senderJid, {
      text: '🔍 *Comprobante recibido.* Estamos validando tu pago con nuestra IA, por favor espera unos segundos...',
    }, { quoted: msg });

    // 2. Descargar la imagen
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

    // 3. Analizar con Gemini Vision
    if (!config.whatsapp.geminiApiKey) {
      console.warn('[WhatsApp Bot] Falta GEMINI_API_KEY en configuración.');
      await sock.sendMessage(senderJid, {
        text: '⚠️ El servicio de validación automática por IA no está activo en este momento. Un administrador revisará tu pago manualmente.',
      }, { quoted: msg });
      return;
    }

    const analysis = await analyzeReceipt(imageBuffer, 'image/jpeg');
    console.log('[WhatsApp Bot] Resultado Gemini:', analysis);

    // 4. Validar si es un comprobante de pago
    if (!analysis.is_payment_receipt || !analysis.is_successful) {
      const reason = analysis.rejection_reason || 'La imagen no corresponde a un comprobante de pago exitoso.';
      await sock.sendMessage(senderJid, {
        text: `❌ *No se pudo validar el pago*\n\nMotivo: ${reason}\n\nPor favor envía una captura nítida donde se observe el valor, el número de aprobación y la cuenta de destino.`,
      }, { quoted: msg });
      return;
    }

    // 5. Validar número de destino (Daviplata / Bre-B)
    const cleanedExtractedDest = cleanPhoneDigits(analysis.destination_phone);
    const cleanedTarget = cleanPhoneDigits(targetPhone);

    if (cleanedExtractedDest && !cleanedExtractedDest.includes(cleanedTarget) && !cleanedTarget.includes(cleanedExtractedDest)) {
      await sock.sendMessage(senderJid, {
        text: `❌ *Cuenta de destino incorrecta*\n\nEl comprobante muestra destino: *${analysis.destination_phone}*, pero el pago debe ser a la cuenta: *${targetPhone}*.\nSi crees que es un error, por favor comunícate con soporte.`,
      }, { quoted: msg });
      return;
    }

    // 6. Validar referencia anti-fraude (Prevención de comprobantes duplicados)
    const cleanRef = String(analysis.reference_number || '').trim().toUpperCase();
    if (!cleanRef || cleanRef.length < 3) {
      await sock.sendMessage(senderJid, {
        text: '❌ No se pudo identificar el número de referencia o aprobación en el comprobante. Por favor envía una imagen más clara.',
      }, { quoted: msg });
      return;
    }

    const db = getDb();
    const existingRef = db.prepare('SELECT id, created_at FROM whatsapp_payments WHERE reference_number = ?').get(cleanRef);
    if (existingRef) {
      await sock.sendMessage(senderJid, {
        text: `⚠️ *Comprobante duplicado*\n\nEste comprobante (Ref: *${cleanRef}*) ya fue registrado y procesado anteriormente el día ${existingRef.created_at}.\nCada comprobante es válido para una única ficha.`,
      }, { quoted: msg });
      return;
    }

    // 7. Buscar plan que coincida con el monto pagado
    const paidAmount = Number(analysis.amount);
    const activePlans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
    const matchedPlan = activePlans.find(p => Math.abs(p.price - paidAmount) < 50);

    if (!matchedPlan) {
      const formattedPaid = paidAmount.toLocaleString('es-CO');
      let planListStr = activePlans.map(p => `• ${p.name}: $${p.price.toLocaleString('es-CO')}`).join('\n');
      await sock.sendMessage(senderJid, {
        text: `⚠️ *Monto no coincide con ningún plan*\n\nDetectamos un pago de *$${formattedPaid} COP*, pero actualmente no coincide con el valor exacto de nuestros planes:\n\n${planListStr}\n\nPor favor comunícate con un administrador para revisar tu caso.`,
      }, { quoted: msg });
      return;
    }

    // 8. Obtener o generar la ficha para el plan
    let voucher = db.prepare(
      'SELECT * FROM vouchers WHERE plan_id = ? AND status = "available" LIMIT 1'
    ).get(matchedPlan.id);

    if (!voucher) {
      console.log(`[WhatsApp Bot] No hay fichas libres para el plan ${matchedPlan.name}, generando una automáticamente...`);
      const batchResult = await generateBatch({
        planId: matchedPlan.id,
        quantity: 1,
        codeLength: 8,
        charset: 'full',
        prefix: 'ROY-',
        batchNote: `Auto-generada por WhatsApp Bot para cliente ${senderPhone}`,
      });

      const newCode = batchResult.codes[0];
      voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(newCode);
    }

    // 9. Registrar la venta y el pago en la BD de forma atómica
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

    // 10. Enviar la ficha al cliente
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
async function startWhatsAppBot() {
  if (!config.whatsapp.enabled) {
    console.log('[WhatsApp Bot] Desactivado en configuración (WHATSAPP_ENABLED=false).');
    _state.status = 'disabled';
    return;
  }

  // Asegurar directorio de datos de autenticación
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  _state.status = 'connecting';
  console.log('[WhatsApp Bot] Iniciando servicio de WhatsApp con Baileys...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: ['Hotspot Fichas ROYOTA', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
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
          _state.qrCodeDataUrl = await QRCode.toDataURL(qr);
        } catch (_) {}

        console.log('\n╔════════════════════════════════════════════════════════════════════╗');
        console.log('║ 📱 ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP PARA VINCULAR EL BOT:   ║');
        console.log('╚════════════════════════════════════════════════════════════════════╝\n');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('\n(También puedes ver el QR desde el Panel de Administración)\n');
      }

      if (connection === 'close') {
        _state.status = 'disconnected';
        _state.qr = null;
        _state.qrCodeDataUrl = null;
        _state.user = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WhatsApp Bot] Conexión cerrada (Código: ${statusCode}). ¿Reconectar?: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => startWhatsAppBot(), 5000);
        } else {
          console.log('[WhatsApp Bot] Sesión cerrada permanentemente. Limpiando credenciales...');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          setTimeout(() => startWhatsAppBot(), 3000);
        }
      } else if (connection === 'open') {
        _state.status = 'connected';
        _state.qr = null;
        _state.qrCodeDataUrl = null;
        _state.user = sock.user;
        console.log(`[WhatsApp Bot] ✅ Conectado exitosamente como: ${sock.user?.name || sock.user?.id}`);
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

        const messageContent = msg.message;
        if (!messageContent) continue;

        // 1. ¿Es una imagen? (Posible comprobante de pago)
        const isImage = !!(messageContent.imageMessage || (messageContent.documentMessage?.mimetype?.startsWith('image/')));

        if (isImage) {
          await processPaymentReceipt(sock, msg, remoteJid);
          continue;
        }

        // 2. ¿Es un mensaje de texto?
        const text = messageContent.conversation || messageContent.extendedTextMessage?.text || '';
        const norm = normalizeText(text);

        if (!norm) continue;

        // Palabras clave que disparan el menú / información
        const isGreetingOrQuery =
          norm.includes('hola') ||
          norm.includes('buen') ||
          norm.includes('precio') ||
          norm.includes('plan') ||
          norm.includes('ficha') ||
          norm.includes('internet') ||
          norm.includes('comprar') ||
          norm.includes('cuanto') ||
          norm.includes('menu') ||
          norm.includes('daviplata') ||
          norm.includes('bre-b') ||
          norm.includes('ayuda');

        if (isGreetingOrQuery) {
          const menu = buildMenuMessage();
          await sock.sendMessage(remoteJid, { text: menu }, { quoted: msg });
        } else {
          // Respuesta cordial de guía
          const quickHelp = `👋 ¡Hola! Para ver nuestros planes y precios de internet envía la palabra *PLANES*.\n\n` +
            `Si ya realizaste tu pago a nuestro Daviplata o Llave Bre-B (*${config.whatsapp.paymentPhone || '3174251419'}*), envía la foto de tu comprobante y recibirás tu ficha al instante. 🎫`;
          await sock.sendMessage(remoteJid, { text: quickHelp }, { quoted: msg });
        }
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
  return {
    ..._state,
    paymentPhone: config.whatsapp.paymentPhone,
    hasGeminiKey: !!config.whatsapp.geminiApiKey,
  };
}

/**
 * Cerrar sesión manual
 */
async function logoutBot() {
  if (_sock) {
    try {
      await _sock.logout();
    } catch (_) {}
  }
  _state.status = 'disconnected';
  _state.user = null;
  _state.qr = null;
  _state.qrCodeDataUrl = null;
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  setTimeout(() => startWhatsAppBot(), 2000);
  return { success: true, message: 'Sesión cerrada. Escanea un nuevo QR.' };
}

module.exports = {
  startWhatsAppBot,
  getBotStatus,
  logoutBot,
};
