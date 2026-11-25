/**
 * src/services/firebase-auth-verifier.js
 * ─────────────────────────────────────────────────────────────
 * Verificación criptográfica RS256 de Firebase ID Tokens contra las
 * llaves públicas oficiales de Google y lista blanca administrativa.
 */
'use strict';

const jwt    = require('jsonwebtoken');
const config = require('../config');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let _cachedCerts = null;
let _certsExpiresAt = 0;

async function fetchGoogleCerts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedCerts && now < _certsExpiresAt) {
    return _cachedCerts;
  }

  const res = await fetch(CERTS_URL);
  if (!res.ok) {
    throw new Error(`No se pudieron descargar llaves Firebase (${res.status})`);
  }

  const certs = await res.json();
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) * 1000 : 3600_000;

  _cachedCerts = certs;
  _certsExpiresAt = now + maxAgeMs;
  return certs;
}

/**
 * Verifica un Firebase ID Token RS256 y valida que pertenezca a un admin autorizado.
 */
async function verifyFirebaseIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Token vacío');
  }

  const decodedComplete = jwt.decode(idToken, { complete: true });
  if (!decodedComplete || !decodedComplete.header) {
    throw new Error('Token malformado');
  }

  const { alg, kid } = decodedComplete.header;
  if (alg !== 'RS256' || !kid) {
    throw new Error('Algoritmo o kid de Firebase inválido');
  }

  let certs = await fetchGoogleCerts(false);
  if (!certs[kid]) {
    certs = await fetchGoogleCerts(true);
  }
  const certPem = certs[kid];
  if (!certPem) {
    throw new Error('Llave pública de firma Firebase no encontrada');
  }

  const projectId = config.firebase.projectId;
  const payload = jwt.verify(idToken, certPem, {
    algorithms: ['RS256'],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Subject UID ausente en Firebase ID token');
  }

  const uid = payload.sub;
  const email = (payload.email || '').toLowerCase();
  const allowedUids = config.firebase.allowedAdminUids;
  const allowedEmails = config.firebase.allowedAdminEmails;

  const isAllowedUid = allowedUids.length > 0 && allowedUids.includes(uid);
  const isAllowedEmail = email && allowedEmails.length > 0 && allowedEmails.includes(email);

  if (!isAllowedUid && !isAllowedEmail) {
    throw new Error('Usuario Firebase no autorizado para administración');
  }

  return {
    id: null,
    uid,
    email: payload.email || '',
    username: payload.email || uid,
    role: 'superadmin',
    authType: 'firebase',
  };
}

module.exports = { verifyFirebaseIdToken };
