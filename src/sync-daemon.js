/**
 * src/sync-daemon.js
 * ─────────────────────────────────────────────────────────────
 * Demonio de sincronización automática bidireccional:
 * Google Cloud Firestore ⟷ MikroTik RouterOS v7
 *
 * Cada vez que se genera una ficha en royota.dctelematica.com:
 * 1. La detecta en Firestore en tiempo real.
 * 2. La crea automáticamente en el router MikroTik (/ip/hotspot/user).
 * 3. Asigna su perfil de velocidad (ej: 1 Hora Basico - 5M/2M).
 */
'use strict';

const https = require('https');
const http  = require('http');
const config = require('./config');
const { getMatchingLocalIp } = require('./utils/helpers');

const { host, port, user, pass } = config.mikrotik;
const auth = Buffer.from(user + ':' + pass).toString('base64');
const localIp = getMatchingLocalIp(host);

// Consultar usuarios actuales en MikroTik
function getMikrotikUsers() {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: host,
      port,
      path: '/rest/ip/hotspot/user',
      method: 'GET',
      localAddress: localIp,
      headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { resolve([]); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// Crear usuario en MikroTik
function createMikrotikUser(name, profile, uptime) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      name,
      password: name,
      profile: profile || 'default',
      'limit-uptime': uptime || '1h',
      comment: 'Sincronizado desde Cloud royota.dctelematica.com'
    });
    const r = http.request({
      hostname: host,
      port,
      path: '/rest/ip/hotspot/user',
      method: 'PUT',
      localAddress: localIp,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ name, status: res.statusCode }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// Sincronizar un lote de códigos
async function syncCodesToRouter(vouchers) {
  try {
    const currentUsers = await getMikrotikUsers();
    const existingNames = new Set(currentUsers.map(u => u.name));

    for (const v of vouchers) {
      if (!existingNames.has(v.code)) {
        const res = await createMikrotikUser(v.code, v.plan_name, v.duration);
        console.log(`[Sync] Ficha ${v.code} (${v.plan_name || '1h'}) creada en MikroTik -> Status:`, res.status);
      }
    }
  } catch (err) {
    console.error('[Sync] Error comunicando con MikroTik:', err.message);
  }
}

module.exports = { syncCodesToRouter, getMikrotikUsers, createMikrotikUser };
