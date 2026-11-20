/**
 * src/services/mikrotik-api.js
 * ─────────────────────────────────────────────────────────────
 * Cliente para la REST API de MikroTik RouterOS v7+
 *
 * Incluye MODO SIMULACIÓN (MIKROTIK_MOCK=true):
 * Permite hacer pruebas completas de venta, activación y corte
 * de fichas aunque el router físico aún no esté conectado.
 */
'use strict';

const https = require('https');
const http  = require('http');
const config = require('../config');

// ── Error tipado para MikroTik ────────────────────────────────
class MikrotikError extends Error {
  constructor(message, httpStatus, body) {
    super(message);
    this.name       = 'MikrotikError';
    this.httpStatus = httpStatus;
    this.body       = body;
  }
}

// ── Almacén en memoria para MODO SIMULACIÓN ───────────────────
const _mockUsers = new Map();

// ── Agente HTTPS reutilizable ─────────────────────────────────
let _agent = null;
function getAgent() {
  if (!_agent && config.mikrotik.useSsl) {
    _agent = new https.Agent({
      rejectUnauthorized: config.mikrotik.verifySsl,
      keepAlive:          true,
      keepAliveMsecs:     10_000,
      maxSockets:         5,
    });
  }
  return _agent;
}

/**
 * Realiza una petición HTTP/HTTPS a la REST API del MikroTik.
 */
function apiRequest(method, path, body = null, retries = 2) {
  return new Promise((resolve, reject) => {
    const { host, port, user, pass, useSsl, timeoutMs } = config.mikrotik;

    const protocol = useSsl ? https : http;
    const auth     = Buffer.from(`${user}:${pass}`).toString('base64');
    const bodyStr  = body ? JSON.stringify(body) : null;

    const options = {
      hostname: host,
      port,
      path:     `/rest${path}`,
      method,
      agent:    useSsl ? getAgent() : undefined,
      headers:  {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = protocol.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = raw ? tryParse(raw) : {};

        if (res.statusCode >= 400) {
          const msg = json?.message || json?.detail || `HTTP ${res.statusCode}`;
          return reject(new MikrotikError(`MikroTik: ${msg}`, res.statusCode, json));
        }

        resolve(json);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout (${timeoutMs}ms) al conectar con MikroTik`));
    });

    req.on('error', (err) => {
      if (retries > 0 && isNetworkError(err)) {
        return apiRequest(method, path, body, retries - 1).then(resolve).catch(reject);
      }
      reject(new MikrotikError(`Error de red al conectar con MikroTik: ${err.message}`, 0, null));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function tryParse(str) {
  try { return JSON.parse(str); }
  catch { return { raw: str }; }
}

function isNetworkError(err) {
  const codes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'];
  return codes.includes(err.code);
}

// ═══════════════════════════════════════════════════════════════
//  FUNCIONES PÚBLICAS (Con soporte para MODO SIMULACIÓN)
// ═══════════════════════════════════════════════════════════════

/**
 * Crear usuario en /ip/hotspot/user del MikroTik.
 */
async function createHotspotUser(username, password, options = {}) {
  const {
    profile         = 'default',
    limitUptime,
    rateLimit,
    limitBytesTotal,
    sharedUsers     = 1,
    comment         = '',
  } = options;

  if (!username) throw new Error('createHotspotUser: username es requerido');
  if (!limitUptime) throw new Error('createHotspotUser: limitUptime es requerido');

  // ── MODO SIMULACIÓN ──────────────────────────────────────────
  if (config.mikrotik.mock) {
    const mockId = '*sim_' + Date.now();
    const mockUser = {
      '.id':          mockId,
      name:           username,
      password:       password || username,
      profile,
      'limit-uptime': limitUptime,
      'rate-limit':   rateLimit,
      uptime:         '0s',
      'bytes-in':     0,
      'bytes-out':    0,
      simulated:      true,
    };
    _mockUsers.set(username, mockUser);
    console.log(`[SIMULADOR MIKROTIK] ✅ Ficha activada: ${username} (Tiempo: ${limitUptime}, Velocidad: ${rateLimit})`);
    return mockUser;
  }

  // ── MODO REAL (Router físico) ────────────────────────────────
  const body = {
    name:           username,
    password:       password || username,
    server:         config.mikrotik.server,
    profile,
    'limit-uptime': limitUptime,
    'shared-users': String(sharedUsers),
  };

  if (rateLimit)        body['rate-limit']         = rateLimit;
  if (limitBytesTotal)  body['limit-bytes-total']   = limitBytesTotal;
  if (comment)          body.comment                = comment;

  return apiRequest('PUT', '/ip/hotspot/user', body);
}

/**
 * Eliminar usuario Hotspot por su ID interno (.id)
 */
async function removeHotspotUser(mikrotikId) {
  if (!mikrotikId) throw new Error('removeHotspotUser: mikrotikId es requerido');

  if (config.mikrotik.mock) {
    for (const [name, u] of _mockUsers.entries()) {
      if (u['.id'] === mikrotikId) {
        _mockUsers.delete(name);
        console.log(`[SIMULADOR MIKROTIK] 🗑️ Usuario eliminado: ${name}`);
        break;
      }
    }
    return { ok: true };
  }

  const id = mikrotikId.startsWith('*') ? mikrotikId : `*${mikrotikId}`;
  return apiRequest('DELETE', `/ip/hotspot/user/${id}`);
}

/**
 * Buscar usuario Hotspot por nombre (código de ficha)
 */
async function findHotspotUser(username) {
  if (config.mikrotik.mock) {
    return _mockUsers.get(username) || null;
  }

  const users = await apiRequest(
    'GET',
    `/ip/hotspot/user?name=${encodeURIComponent(username)}&server=${encodeURIComponent(config.mikrotik.server)}`
  );
  if (Array.isArray(users) && users.length > 0) return users[0];
  return null;
}

/**
 * Listar todos los usuarios Hotspot
 */
async function listHotspotUsers() {
  if (config.mikrotik.mock) {
    return Array.from(_mockUsers.values());
  }
  return apiRequest('GET', `/ip/hotspot/user?server=${encodeURIComponent(config.mikrotik.server)}`);
}

/**
 * Listar usuarios actualmente conectados
 */
async function listActiveUsers() {
  if (config.mikrotik.mock) {
    return Array.from(_mockUsers.values()).map(u => ({
      user:        u.name,
      address:     '192.168.88.' + Math.floor(Math.random() * 200 + 10),
      uptime:      '5m 23s',
      'bytes-in':  1048576 * 15,
      'bytes-out': 1048576 * 45,
    }));
  }
  return apiRequest('GET', `/ip/hotspot/active?server=${encodeURIComponent(config.mikrotik.server)}`);
}

/**
 * Listar perfiles Hotspot disponibles
 */
async function listProfiles() {
  if (config.mikrotik.mock) {
    return [
      { name: 'default' },
      { name: '1 Hora' },
      { name: '1 Dia' },
    ];
  }
  return apiRequest('GET', '/ip/hotspot/user/profile');
}

/**
 * Verificar conectividad con el router
 */
async function testConnection() {
  if (config.mikrotik.mock) {
    return {
      ok:          true,
      routerboard: true,
      version:     'RouterOS v7.16 (MODO SIMULACIÓN ACTIVO)',
      uptime:      '3d 14h 22m',
      cpuLoad:     3,
      freeMemory:  524288000,
      totalMemory: 1073741824,
    };
  }

  try {
    const resource = await apiRequest('GET', '/system/resource');
    return {
      ok:          true,
      routerboard: resource['routerboard'] === 'true',
      version:     resource.version,
      uptime:      resource.uptime,
      cpuLoad:     resource['cpu-load'],
      freeMemory:  resource['free-memory'],
      totalMemory: resource['total-memory'],
    };
  } catch (err) {
    return {
      ok:    false,
      error: err.message || 'Error desconocido al conectar',
    };
  }
}

async function profileExists(profileName) {
  if (config.mikrotik.mock) return true;
  try {
    const profiles = await listProfiles();
    if (!Array.isArray(profiles)) return false;
    return profiles.some((p) => p.name === profileName);
  } catch {
    return false;
  }
}

module.exports = {
  MikrotikError,
  createHotspotUser,
  removeHotspotUser,
  findHotspotUser,
  listHotspotUsers,
  listActiveUsers,
  listProfiles,
  testConnection,
  profileExists,
};
