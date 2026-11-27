/**
 * src/services/wompi-service.js
 * ─────────────────────────────────────────────────────────────
 * Servicio de pasarela Wompi para Balneario Río Royota:
 * - Generación de Links de Pago y QR dinámico interoperable (Nequi / Bancolombia / PSE).
 * - Verificación criptográfica de Webhooks (SHA-256).
 * - Consulta de transacciones y conciliación contra Firestore SSOT.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');
const config = require('../config');
const { getSettingsLive } = require('./firestore-store');
const {
  hasServiceAccount,
  getDoc,
  setDoc,
  createDoc,
} = require('./firestore-client');

// Caché en memoria para órdenes activas (soporta fallos de red / modo local)
const _ordersMemory = new Map();

/**
 * Obtiene la configuración efectiva de Wompi (Sandbox vs Producción)
 * Leyendo de Firestore settings si existe la propiedad 'wompi_mode'.
 */
async function getEffectiveWompiConfig(overrideMode = null) {
  let mode = overrideMode || config.wompi.mode || 'sandbox';

  try {
    const liveSettings = await getSettingsLive();
    if (liveSettings && (liveSettings.wompi_mode === 'production' || liveSettings.wompi_mode === 'sandbox')) {
      mode = liveSettings.wompi_mode;
    }
  } catch (_e) {
    // Si falla la lectura en vivo, usa el modo por defecto de config
  }

  const creds = mode === 'production' ? config.wompi.production : config.wompi.sandbox;

  return {
    mode,
    publicKey: creds.publicKey,
    privateKey: creds.privateKey,
    eventsSecret: creds.eventsSecret,
    integritySecret: creds.integritySecret,
    apiUrl: creds.apiUrl,
    checkoutUrl: creds.checkoutUrl,
  };
}

/**
 * Helper para realizar peticiones HTTPS nativas con Promise y timeout.
 */
function httpsRequest(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 12000,
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (_e) {
          parsed = { raw: data };
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout en petición a Wompi (${reqOptions.timeout}ms)`));
    });

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

/**
 * Genera una referencia única de pago segura y no predecible.
 */
function generatePaymentReference(planId) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `RYT-P${planId}-${ts}-${rand}`;
}

/**
 * Crea un Link de Pago de un solo uso en Wompi y genera el QR Dinámico.
 */
async function createPaymentOrder({
  plan,
  clientPhone = '',
  clientMac = '',
  redirectUrl = null,
  overrideMode = null,
}) {
  if (!plan || !plan.price) {
    throw new Error('Plan inválido o sin precio definido');
  }

  const wompiConf = await getEffectiveWompiConfig(overrideMode);
  const reference = generatePaymentReference(plan.id);
  const amountInCents = Math.round(Number(plan.price) * 100);

  const payload = {
    name: `WiFi ${plan.name} - Río Royota`,
    description: `Acceso WiFi ${plan.duration || ''} (${plan.speed_limit || 'Alta velocidad'})`,
    single_use: true,
    collect_shipping: false,
    currency: 'COP',
    amount_in_cents: amountInCents,
    sku: `PLAN_${plan.id}`,
    redirect_url: redirectUrl || `https://royota.dctelematica.com/?modo=wompi_retorno&ref=${encodeURIComponent(reference)}`,
  };

  const response = await httpsRequest(`${wompiConf.apiUrl}/payment_links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wompiConf.privateKey}`,
      'Content-Type': 'application/json',
    },
  }, payload);

  if (response.statusCode < 200 || response.statusCode >= 300 || !response.data?.data?.id) {
    const errMsg = response.data?.error?.messages
      ? JSON.stringify(response.data.error.messages)
      : response.data?.error?.type || `HTTP ${response.statusCode}`;
    throw new Error(`Error al crear link de pago en Wompi: ${errMsg}`);
  }

  const linkId = response.data.data.id;
  const paymentUrl = `${wompiConf.checkoutUrl}/l/${linkId}`;

  // Generar imagen QR en DataURL PNG de alta legibilidad
  const qrDataUrl = await QRCode.toDataURL(paymentUrl, {
    width: 320,
    margin: 2,
    color: {
      dark: '#002830',
      light: '#ffffff',
    },
    errorCorrectionLevel: 'M',
  });

  const nowIso = new Date().toISOString();
  const orderDoc = {
    reference,
    link_id: linkId,
    plan_id: String(plan.id),
    plan_name: String(plan.name),
    amount: Number(plan.price),
    amount_in_cents: amountInCents,
    status: 'PENDING', // PENDING | APPROVED | DECLINED | VOIDED
    payment_url: paymentUrl,
    qr_data_url: qrDataUrl,
    client_phone: clientPhone || '',
    client_mac: clientMac || '',
    wompi_mode: wompiConf.mode,
    voucher_code: null,
    instant_ready: false,
    created_at: nowIso,
    updated_at: nowIso,
  };

  // Guardar en memoria
  _ordersMemory.set(reference, orderDoc);

  // Guardar en Firestore SSOT si está disponible
  if (hasServiceAccount()) {
    try {
      await createDoc('payment_orders', orderDoc, reference);
    } catch (err) {
      console.warn('[WompiService] No se pudo guardar orden en Firestore, usando caché local:', err.message);
    }
  }

  return {
    reference,
    linkId,
    paymentUrl,
    qrDataUrl,
    amount: plan.price,
    planName: plan.name,
    duration: plan.duration,
    mode: wompiConf.mode,
  };
}

/**
 * Obtiene el estado actual de una orden de pago por su referencia.
 */
async function getPaymentOrder(reference) {
  if (!reference) return null;

  // 1. Buscar en Firestore si está disponible
  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/payment_orders/${encodeURIComponent(reference)}`);
      if (doc) {
        _ordersMemory.set(reference, doc);
        return doc;
      }
    } catch (_e) {
      // fallback a memoria
    }
  }

  // 2. Fallback a memoria
  return _ordersMemory.get(reference) || null;
}

/**
 * Actualiza el estado de una orden de pago en Firestore y memoria.
 */
async function updatePaymentOrder(reference, updates = {}) {
  const existing = (await getPaymentOrder(reference)) || {};
  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  _ordersMemory.set(reference, updated);

  if (hasServiceAccount()) {
    try {
      await setDoc(`/payment_orders/${encodeURIComponent(reference)}`, updates, { merge: true });
    } catch (err) {
      console.error('[WompiService] Error al actualizar orden en Firestore:', err.message);
    }
  }

  return updated;
}

/**
 * Valida la firma criptográfica (checksum SHA-256) de los Webhooks de Wompi.
 * Concatenación: properties_values + timestamp + events_secret.
 */
function verifyWebhookChecksum(body, customEventsSecret = null) {
  if (!body || !body.signature || !body.data) return false;

  const { signature, timestamp } = body;
  const properties = signature.properties;
  const receivedChecksum = String(signature.checksum || '').toLowerCase();

  if (!Array.isArray(properties) || !properties.length || !receivedChecksum) {
    return false;
  }

  // Extraer valores dinámicos especificados en signature.properties
  let concatenated = '';
  for (const propPath of properties) {
    const parts = propPath.split('.');
    let cur = body.data;
    for (const p of parts) {
      cur = cur != null ? cur[p] : undefined;
    }
    concatenated += (cur !== undefined && cur !== null) ? String(cur) : '';
  }

  // Concatenar el timestamp (signature.timestamp o body.timestamp)
  const ts = signature.timestamp !== undefined ? signature.timestamp : (timestamp !== undefined ? timestamp : '');
  concatenated += String(ts);

  // Secretos a evaluar (permitir el secreto configurado en Sandbox y Producción)
  const secretsToTry = [];
  if (customEventsSecret) secretsToTry.push(customEventsSecret);
  secretsToTry.push(config.wompi.sandbox.eventsSecret);
  secretsToTry.push(config.wompi.production.eventsSecret);

  for (const secret of secretsToTry) {
    if (!secret) continue;
    const testString = `${concatenated}${secret}`;
    const hash = crypto.createHash('sha256').update(testString).digest('hex').toLowerCase();
    if (hash === receivedChecksum) {
      return true;
    }
  }

  return false;
}

module.exports = {
  getEffectiveWompiConfig,
  createPaymentOrder,
  getPaymentOrder,
  updatePaymentOrder,
  verifyWebhookChecksum,
  generatePaymentReference,
};
