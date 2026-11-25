/**
 * src/utils/helpers.js
 * ─────────────────────────────────────────────────────────────
 * Utilidades compartidas (DRY): duraciones, zona horaria Bogotá,
 * comparación segura de tokens e IP de interfaz local.
 */
'use strict';

const crypto = require('crypto');
const os     = require('os');

/**
 * Parsea una duración estilo RouterOS ('30m', '1h', '2d') a milisegundos.
 */
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

/**
 * Fecha actual YYYY-MM-DD en zona horaria America/Bogota.
 */
function getBogotaDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date);
}

/**
 * Marca de tiempo de medianoche (23:59:59.999) del día actual en Colombia.
 */
function getBogotaMidnightMs(date = new Date()) {
  const dateStr = getBogotaDateStr(date);
  return new Date(`${dateStr}T23:59:59.999-05:00`).getTime();
}

/**
 * Comparación en tiempo constante (sin fuga de longitud).
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Resuelve la IP local coincidente con la subred destino (evita interferencia VPN).
 */
function getMatchingLocalIp(targetHost) {
  if (process.env.LOCAL_IP) return process.env.LOCAL_IP;
  try {
    const interfaces = os.networkInterfaces();
    const parts = String(targetHost || '').split('.');
    if (parts.length === 4) {
      const prefix = parts.slice(0, 3).join('.') + '.';
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith(prefix)) {
            return iface.address;
          }
        }
      }
    }
  } catch (_) {}
  return undefined;
}

module.exports = {
  parseDurationMs,
  getBogotaDateStr,
  getBogotaMidnightMs,
  timingSafeEqualStr,
  getMatchingLocalIp,
};
