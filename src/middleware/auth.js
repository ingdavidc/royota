/**
 * src/middleware/auth.js
 * ─────────────────────────────────────────────────────────────
 * Middleware estricto de autenticación administrativa.
 * Acepta únicamente:
 *  1. JWT local firmado con config.jwt.secret (HS256)
 *  2. Firebase ID Token verificado criptográficamente (RS256) + whitelist
 */
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { verifyFirebaseIdToken } = require('../services/firebase-auth-verifier');

async function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = header.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: 'Token vacío' });
  }

  // 1. Verificar JWT local HS256
  try {
    const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    req.admin = payload;
    return next();
  } catch (_) {
    // Continuar hacia verificación criptográfica de Firebase ID Token
  }

  // 2. Verificar Firebase ID Token RS256 contra llaves de Google + lista blanca
  try {
    req.admin = await verifyFirebaseIdToken(token);
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function superadminRequired(req, res, next) {
  if (req.admin?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Se requiere rol superadmin' });
  }
  next();
}

module.exports = { authRequired, superadminRequired };
