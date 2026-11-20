/**
 * functions/mikrotik.js
 * ─────────────────────────────────────────────────────────────
 * Cliente para la REST API de MikroTik RouterOS v7+ desde Firebase Cloud Functions.
 *
 * Soporta conexión directa por IP, MikroTik Cloud DDNS (*.sn.mynetname.net)
 * y modo simulación (MIKROTIK_MOCK=true).
 */
'use strict';

const https = require('https');
const http  = require('http');

class MikrotikError extends Error {
  constructor(message, httpStatus, body) {
    super(message);
    this.name       = 'MikrotikError';
    this.httpStatus = httpStatus;
    this.body       = body;
  }
}

const _mockUsers = new Map();

function getConfig() {
  return {
    mock:      (process.env.MIKROTIK_MOCK || 'true') === 'true',
    host:      process.env.MIKROTIK_HOST || '192.168.88.1',
    port:      parseInt(process.env.MIKROTIK_PORT || '443', 10),
    user:      process.env.MIKROTIK_USER || 'admin',
    pass:      process.env.MIKROTIK_PASS || '',
    server:    process.env.MIKROTIK_HOTSPOT_SERVER || 'hotspot1',
    useSsl:    (process.env.MIKROTIK_USE_SSL || 'true') !== 'false',
    verifySsl: (process.env.MIKROTIK_VERIFY_SSL || 'false') === 'true',
    timeoutMs: parseInt(process.env.MIKROTIK_TIMEOUT_MS || '8000', 10),
  };
}

let _agent = null;
function getAgent(verifySsl) {
  if (!_agent) {
    _agent = new https.Agent({
      rejectUnauthorized: verifySsl,
      keepAlive:          true,
      maxSockets:         5,
    });
  }
  return _agent;
}

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const protocol = cfg.useSsl ? https : http;
    const auth     = Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
    const bodyStr  = body ? JSON.stringify(body) : null;

    const options = {
      hostname: cfg.host,
      port:     cfg.port,
      path:     `/rest${path}`,
      method,
      agent:    cfg.useSsl ? getAgent(cfg.verifySsl) : undefined,
      headers:  {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = protocol.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(raw); } catch (_) {}

        if (res.statusCode >= 400) {
          const msg = json?.message || json?.detail || `HTTP ${res.statusCode}`;
          return reject(new MikrotikError(`MikroTik: ${msg}`, res.statusCode, json));
        }
        resolve(json);
      });
    });

    req.setTimeout(cfg.timeoutMs, () => {
      req.destroy();
      reject(new MikrotikError(`Timeout al conectar con MikroTik (${cfg.timeoutMs}ms)`, 504));
    });

    req.on('error', err => reject(new MikrotikError(`Error de red MikroTik: ${err.message}`, 502)));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const mikrotik = {
  async createHotspotUser(username, password, options = {}) {
    const cfg = getConfig();
    if (cfg.mock) {
      const mockId = `*MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const user = {
        '.id':             mockId,
        name:              username,
        password,
        server:            options.server || cfg.server,
        profile:           options.profile || 'default',
        'limit-uptime':    options.limitUptime || '1h',
        'rate-limit':      options.rateLimit || '',
        comment:           options.comment || 'Ficha generada por ROYOTA Hotspot',
        disabled:          'false',
        _created:          new Date(),
      };
      _mockUsers.set(username, user);
      return { id: mockId, mock: true, user };
    }

    const payload = {
      name:              username,
      password,
      server:            options.server || cfg.server,
      profile:           options.profile || 'default',
      'limit-uptime':    options.limitUptime || '1h',
      comment:           options.comment || 'Ficha generada por ROYOTA Hotspot',
      disabled:          'false',
    };
    if (options.rateLimit) payload['rate-limit'] = options.rateLimit;
    if (options.limitBytesTotal) payload['limit-bytes-total'] = String(options.limitBytesTotal);

    const res = await apiRequest('PUT', '/ip/hotspot/user', payload);
    return { id: res['.id'] || res.ret, mock: false };
  },

  async deleteHotspotUser(username) {
    const cfg = getConfig();
    if (cfg.mock) {
      const existed = _mockUsers.delete(username);
      return { deleted: existed, mock: true };
    }
    const users = await apiRequest('GET', `/ip/hotspot/user?name=${encodeURIComponent(username)}`);
    if (!Array.isArray(users) || users.length === 0) return { deleted: false };
    const id = users[0]['.id'];
    await apiRequest('DELETE', `/ip/hotspot/user/${id}`);
    return { deleted: true, id };
  },

  async testConnection() {
    const cfg = getConfig();
    if (cfg.mock) {
      return { ok: true, mock: true, message: 'Modo simulación activo' };
    }
    const res = await apiRequest('GET', '/system/resource');
    return {
      ok:       true,
      version:  res.version,
      uptime:   res.uptime,
      cpu:      res['cpu-load'],
      board:    res['board-name'],
    };
  }
};

module.exports = mikrotik;
