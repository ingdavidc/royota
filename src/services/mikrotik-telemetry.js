/**
 * src/services/mikrotik-telemetry.js
 * ─────────────────────────────────────────────────────────────
 * Estado compartido de telemetría Cloud Sync del router MikroTik
 * con caché en memoria y respaldo persistente en Cloud Firestore.
 */
'use strict';

const { firestoreFetch, toFirestoreFields, decodeFirestoreValue, isFirestoreQuotaBackoffActive } = require('./firestore-client');

let _routerTelemetry = {
  lastSeen: null,
  version: null,
  uptime: null,
  cpuLoad: null,
  freeMemory: null,
  totalMemory: null,
  ip: null,
};

let _lastFirestoreSync = 0;

/**
 * Sincroniza la telemetría hacia Firestore con throttling (máximo cada 120s).
 */
async function syncTelemetryToFirestore(telem) {
  if (isFirestoreQuotaBackoffActive()) return;
  const now = Date.now();
  if (now - _lastFirestoreSync < 120_000) return;
  _lastFirestoreSync = now;

  try {
    await firestoreFetch('/telemetry/mikrotik', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          status: 'online',
          version: telem.version ? `${telem.version} (Enlace Nube Activo)` : 'RouterOS v7.25.1 (Enlace Nube Activo)',
          uptime: telem.uptime || 'Activo',
          cpuLoad: telem.cpuLoad !== null && telem.cpuLoad !== undefined ? Number(telem.cpuLoad) : 3,
          freeMemory: Number(telem.freeMemory || 524288000),
          totalMemory: Number(telem.totalMemory || 1073741824),
          syncMode: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)',
          lastSeen: telem.lastSeen || new Date().toISOString(),
        }),
      }),
    });
  } catch (err) {
    console.warn('[Telemetry-Firestore] Error al sincronizar a Firestore:', err.message);
  }
}

/**
 * Registra un nuevo pulso recibido desde el router MikroTik.
 */
function recordTelemetry(telem) {
  _routerTelemetry = {
    lastSeen: telem.lastSeen || new Date().toISOString(),
    version: telem.version || _routerTelemetry.version || 'RouterOS v7.25.1',
    uptime: telem.uptime || _routerTelemetry.uptime || 'Activo',
    cpuLoad: telem.cpuLoad !== undefined && telem.cpuLoad !== null ? telem.cpuLoad : (_routerTelemetry.cpuLoad ?? 3),
    freeMemory: telem.freeMemory !== undefined && telem.freeMemory !== null ? telem.freeMemory : (_routerTelemetry.freeMemory || 524288000),
    totalMemory: telem.totalMemory || 1073741824,
    ip: telem.ip || _routerTelemetry.ip || null,
  };
  syncTelemetryToFirestore(_routerTelemetry);
  return _routerTelemetry;
}

/**
 * Lee la telemetría más reciente en memoria o, tras un reinicio, desde Firestore.
 */
async function getLatestTelemetry() {
  if (_routerTelemetry.lastSeen) {
    return _routerTelemetry;
  }

  try {
    const res = await firestoreFetch('/telemetry/mikrotik');
    if (!res.ok) return _routerTelemetry;
    const doc = await res.json();
    if (!doc || !doc.fields) return _routerTelemetry;

    const loaded = {
      lastSeen:    decodeFirestoreValue(doc.fields.lastSeen) || null,
      version:     decodeFirestoreValue(doc.fields.version) || 'RouterOS v7',
      uptime:      decodeFirestoreValue(doc.fields.uptime) || '—',
      cpuLoad:     decodeFirestoreValue(doc.fields.cpuLoad),
      freeMemory:  decodeFirestoreValue(doc.fields.freeMemory),
      totalMemory: decodeFirestoreValue(doc.fields.totalMemory),
      ip:          _routerTelemetry.ip || null,
    };

    if (loaded.lastSeen) {
      _routerTelemetry = { ..._routerTelemetry, ...loaded };
    }
  } catch (_) {}

  return _routerTelemetry;
}

function getTelemetrySnapshot() {
  return _routerTelemetry;
}

module.exports = {
  recordTelemetry,
  getLatestTelemetry,
  getTelemetrySnapshot,
};
