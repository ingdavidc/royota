/**
 * src/services/wompi-service.js
 * ─────────────────────────────────────────────────────────────
 * Servicio de pasarela Wompi para Balneario Río Royota:
 * - Generación de Links de Pago y QR dinámico interoperable (Nequi / Bancolombia / PSE).
 * - Verificación criptográfica de Webhooks (SHA-256).
 * - Búsqueda por reference o payment_link_id y reconciliación directa con Wompi API.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');
const config = require('../config');
const { hasServiceAccount } = require('./firestore-client');
const {
  getSettingsLive,
  getDoc,
  setDoc,
  createDoc,
  runQuery,
} = require('./firestore-store');

// Cachés en memoria para órdenes activas y throttling de reconciliación
const _ordersMemory = new Map();
const _ordersByLinkIdMemory = new Map();
const _lastReconcileCheckMs = new Map();

/**
 * Obtiene la configuración efectiva de Wompi (Producción vs Sandbox).
 * Lee de Firestore settings ('wompi_mode') salvo que se fuerce `overrideMode`.
 */
async function getEffectiveWompiConfig(overrideMode = null) {
  let mode = overrideMode || config.wompi.mode || 'production';

  if (!overrideMode) {
    try {
      const liveSettings = await getSettingsLive();
      if (liveSettings && (liveSettings.wompi_mode === 'production' || liveSettings.wompi_mode === 'sandbox')) {
        mode = liveSettings.wompi_mode;
      }
    } catch (_e) {
      // Si falla la lectura en vivo, usa el modo por defecto de config
    }
  }

  const creds = mode === 'sandbox' ? config.wompi.sandbox : config.wompi.production;

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

function cacheOrder(orderDoc) {
  if (!orderDoc || !orderDoc.reference) return;
  _ordersMemory.set(orderDoc.reference, orderDoc);
  if (orderDoc.link_id) {
    _ordersByLinkIdMemory.set(String(orderDoc.link_id), orderDoc.reference);
  }
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
    sku: `PLAN_${String(plan.id).slice(0, 30)}`,
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
    status: 'PENDING', // PENDING | APPROVED | DECLINED | VOIDED | ERROR
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

  cacheOrder(orderDoc);

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

  if (hasServiceAccount()) {
    try {
      const doc = await getDoc(`/payment_orders/${encodeURIComponent(reference)}`);
      if (doc) {
        cacheOrder(doc);
        return doc;
      }
    } catch (_e) {
      // fallback a memoria
    }
  }

  return _ordersMemory.get(reference) || null;
}

/**
 * Busca una orden usando el `link_id` generado por Wompi (ej. `abc123` o `test_7SyVDv`).
 */
async function getPaymentOrderByLinkId(linkId) {
  if (!linkId) return null;
  const cleanLinkId = String(linkId).trim();

  const cachedRef = _ordersByLinkIdMemory.get(cleanLinkId);
  if (cachedRef) {
    const order = await getPaymentOrder(cachedRef);
    if (order) return order;
  }

  if (hasServiceAccount()) {
    try {
      const docs = await runQuery({
        from: [{ collectionId: 'payment_orders' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'link_id' },
            op: 'EQUAL',
            value: { stringValue: cleanLinkId },
          },
        },
        limit: 1,
      });
      if (docs && docs.length > 0) {
        const order = docs[0];
        cacheOrder(order);
        return order;
      }
    } catch (err) {
      console.warn('[WompiService] getPaymentOrderByLinkId Firestore warn:', err.message);
    }
  }

  // Último respaldo recorriendo órdenes en memoria
  for (const order of _ordersMemory.values()) {
    if (String(order.link_id || '') === cleanLinkId) {
      return order;
    }
  }
  return null;
}

/**
 * Encuentra la orden asociada a una transacción de Wompi por `reference` o `payment_link_id`.
 * (Nota: Los Payment Links de Wompi generan referencias propias `<linkId>_<ts>_<rand>`).
 */
async function findOrderForTransaction(transaction) {
  if (!transaction) return null;

  if (transaction.reference) {
    const direct = await getPaymentOrder(transaction.reference);
    if (direct) return direct;
  }

  if (transaction.payment_link_id) {
    const byLink = await getPaymentOrderByLinkId(transaction.payment_link_id);
    if (byLink) return byLink;
  }

  if (transaction.reference && String(transaction.reference).includes('_')) {
    const parts = String(transaction.reference).split('_');
    const candidates = [parts[0]];
    if (parts.length >= 2) candidates.push(`${parts[0]}_${parts[1]}`);
    for (const candidate of candidates) {
      const byPrefix = await getPaymentOrderByLinkId(candidate);
      if (byPrefix) return byPrefix;
    }
  }

  return null;
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

  cacheOrder(updated);

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
 * Consulta directamente la API de Wompi para reconciliar una orden aún PENDING
 * (respaldo activo si el webhook tarda o si el cliente vuelve por redirect_url con ?id=...).
 */
async function reconcilePendingOrderFromWompi(order, txIdHint = null) {
  if (!order || order.status !== 'PENDING') return null;

  const cleanTxHint = txIdHint ? String(txIdHint).trim() : '';
  const now = Date.now();
  const lastCheck = _lastReconcileCheckMs.get(order.reference) || 0;

  // Sin txIdHint explícito, consultar Wompi máximo cada 5s por orden para no saturar API
  if (!cleanTxHint && (now - lastCheck) < 5000) {
    return null;
  }
  _lastReconcileCheckMs.set(order.reference, now);

  try {
    const wompiConf = await getEffectiveWompiConfig(order.wompi_mode || null);

    // 1. Si tenemos el ID exacto de transacción (?id=... en redirect_url de Wompi)
    if (cleanTxHint) {
      const resp = await httpsRequest(`${wompiConf.apiUrl}/transactions/${encodeURIComponent(cleanTxHint)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${wompiConf.privateKey}` },
      });
      const tx = resp.data?.data;
      if (resp.statusCode === 200 && tx) {
        const matchesOrder =
          (order.link_id && String(tx.payment_link_id || '') === String(order.link_id)) ||
          (tx.reference && String(tx.reference) === String(order.reference)) ||
          (order.link_id && String(tx.reference || '').startsWith(`${order.link_id}_`));
        if (matchesOrder) return tx;
      }
    }

    // 2. Consultar transacciones recientes en el rango de hoy/ayer y cruzar por payment_link_id
    if (!order.link_id) return null;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const queryUrl = `${wompiConf.apiUrl}/transactions?from_date=${yesterday}&until_date=${tomorrow}&page=1&page_size=25&payment_link_id=${encodeURIComponent(order.link_id)}`;

    const listResp = await httpsRequest(queryUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${wompiConf.privateKey}` },
    });

    if (listResp.statusCode !== 200 || !Array.isArray(listResp.data?.data)) {
      return null;
    }

    const matching = listResp.data.data.filter(
      (tx) =>
        String(tx.payment_link_id || '') === String(order.link_id) ||
        String(tx.reference || '') === String(order.reference) ||
        String(tx.reference || '').startsWith(`${order.link_id}_`)
    );

    if (!matching.length) return null;

    // Priorizar APPROVED si existe alguno aprobado para este link
    const approved = matching.find((tx) => tx.status === 'APPROVED');
    if (approved) return approved;

    return matching.find((tx) => tx.status && tx.status !== 'PENDING') || matching[0];
  } catch (err) {
    console.warn('[WompiService] Reconciliación activa warn:', err.message);
    return null;
  }
}

/**
 * Valida la firma criptográfica (checksum SHA-256) de los Webhooks de Wompi.
 * Concatenación: properties_values + timestamp + events_secret.
 */
function verifyWebhookChecksum(body, customEventsSecret = null, headerChecksum = null) {
  if (!body || !body.signature || !body.data) return false;

  const { signature, timestamp } = body;
  const properties = signature.properties;
  const receivedChecksum = String(signature.checksum || headerChecksum || '').toLowerCase();

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

  // Timestamps candidatos según versión de evento Wompi
  const tsCandidates = [];
  if (signature.timestamp !== undefined && signature.timestamp !== null) tsCandidates.push(String(signature.timestamp));
  if (timestamp !== undefined && timestamp !== null && !tsCandidates.includes(String(timestamp))) {
    tsCandidates.push(String(timestamp));
  }
  if (!tsCandidates.length) tsCandidates.push('');

  // Secretos a evaluar (custom, Producción y Sandbox)
  const secretsToTry = [];
  if (customEventsSecret) secretsToTry.push(customEventsSecret);
  secretsToTry.push(config.wompi.production.eventsSecret);
  secretsToTry.push(config.wompi.sandbox.eventsSecret);

  for (const ts of tsCandidates) {
    for (const secret of secretsToTry) {
      if (!secret) continue;
      const testString = `${concatenated}${ts}${secret}`;
      const hash = crypto.createHash('sha256').update(testString).digest('hex').toLowerCase();
      if (hash === receivedChecksum) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  getEffectiveWompiConfig,
  createPaymentOrder,
  getPaymentOrder,
  getPaymentOrderByLinkId,
  findOrderForTransaction,
  updatePaymentOrder,
  reconcilePendingOrderFromWompi,
  verifyWebhookChecksum,
  generatePaymentReference,
};
