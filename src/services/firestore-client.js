/**
 * src/services/firestore-client.js
 * ─────────────────────────────────────────────────────────────
 * Cliente REST autenticado hacia Cloud Firestore usando Cuenta de
 * Servicio de Google Cloud (FIREBASE_SERVICE_ACCOUNT).
 *
 * Permite cerrar las reglas de Firestore (`firestore.rules`) al
 * público mientras el backend de Render opera con privilegios de servidor.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');

let _serviceAccount = null;
let _parsedAttempted = false;
let _warnedNoSa = false;
let _cachedToken = null;
let _tokenExpiresAt = 0;
let _quotaBackoffUntilMs = 0;

function isFirestoreQuotaBackoffActive() {
  return Date.now() < _quotaBackoffUntilMs;
}

function tripFirestoreQuotaBackoff(durationMs = 5 * 60 * 1000) {
  const nextUntil = Date.now() + durationMs;
  if (nextUntil > _quotaBackoffUntilMs) {
    _quotaBackoffUntilMs = nextUntil;
    console.warn(`[FirestoreClient] ⏸️ Cuota 429 detectada; pausando tareas en segundo plano por ${Math.round(durationMs / 1000)}s.`);
  }
}

function getServiceAccount() {
  if (_parsedAttempted) return _serviceAccount;
  _parsedAttempted = true;

  const raw = config.firebase.serviceAccount;
  if (!raw) return null;

  try {
    const jsonText = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonText);
    if (parsed && parsed.client_email && parsed.private_key) {
      _serviceAccount = {
        ...parsed,
        private_key: String(parsed.private_key).replace(/\\n/g, '\n'),
      };
    }
  } catch (err) {
    console.error('[FirestoreClient] Error parseando FIREBASE_SERVICE_ACCOUNT:', err.message);
  }
  return _serviceAccount;
}

function hasServiceAccount() {
  return !!getServiceAccount();
}

function base64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const sa = getServiceAccount();
  if (!sa) {
    if (!_warnedNoSa) {
      _warnedNoSa = true;
      console.warn('[FirestoreClient] FIREBASE_SERVICE_ACCOUNT no configurada; peticiones Firestore irán sin Bearer token.');
    }
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (_cachedToken && nowSec < (_tokenExpiresAt - 300)) {
    return _cachedToken;
  }

  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  }));

  const signingInput = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = base64Url(signer.sign(sa.private_key));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(assertion)}`,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth2 token error (${res.status}): ${errText.slice(0, 180)}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = nowSec + (parseInt(data.expires_in, 10) || 3600);
  return _cachedToken;
}

function getBaseUrl() {
  const projectId = (getServiceAccount()?.project_id) || config.firebase.projectId || 'fichas-royota';
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

/**
 * Ejecuta una petición HTTP contra Firestore REST API.
 * `relPath` puede empezar con `/` (ej. `/telemetry/mikrotik`) o ser URL completa.
 */
async function firestoreFetch(relPath, options = {}) {
  const url = relPath.startsWith('https://')
    ? relPath
    : `${getBaseUrl()}${relPath.startsWith('/') ? '' : '/'}${relPath}`;

  const headers = { ...(options.headers || {}) };
  try {
    const token = await getAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch (err) {
    console.warn('[FirestoreClient] Falló obtención de token OAuth2:', err.message);
  }

  const res = await fetch(url, { ...options, headers });
  if (res.status === 429) {
    tripFirestoreQuotaBackoff(5 * 60 * 1000);
  }
  return res;
}

/**
 * Convierte un objeto plano JS al formato `fields` de Firestore REST API.
 */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    if (v === null) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (typeof v === 'number') {
      fields[k] = Number.isInteger(v)
        ? { integerValue: String(v) }
        : { doubleValue: v };
    } else {
      fields[k] = { stringValue: String(v) };
    }
  }
  return fields;
}

/**
 * Extrae el valor JS nativo de un campo Firestore REST.
 */
function decodeFirestoreValue(val) {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  return undefined;
}

module.exports = {
  hasServiceAccount,
  getAccessToken,
  getBaseUrl,
  firestoreFetch,
  toFirestoreFields,
  decodeFirestoreValue,
  isFirestoreQuotaBackoffActive,
  tripFirestoreQuotaBackoff,
};
