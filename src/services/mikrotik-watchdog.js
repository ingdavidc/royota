/**
 * src/services/mikrotik-watchdog.js
 * ─────────────────────────────────────────────────────────────
 * Watchdog de disponibilidad del sitio (MikroTik Cloud Sync):
 * Envía alerta automática por WhatsApp cuando el router supera el
 * umbral de minutos sin pulso (default: 3 min) y notifica cuando
 * vuelve a estar en línea. Persiste el estado en Firestore para
 * evitar alertas duplicadas tras reinicios de Render.
 */
'use strict';

const config = require('../config');
const { firestoreFetch, toFirestoreFields, decodeFirestoreValue } = require('./firestore-client');
const { getLatestTelemetry } = require('./mikrotik-telemetry');
const { getBotStatus, sendDirectWhatsAppMessage } = require('./whatsapp-bot');

let _interval = null;
let _startupTimer = null;
let _isChecking = false;
let _alertState = null;

function formatBogotaTime(isoOrMs) {
  if (!isoOrMs) return '—';
  try {
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: config.tz || 'America/Bogota',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(isoOrMs));
  } catch (_) {
    return String(isoOrMs);
  }
}

function formatDurationMs(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hrs} h ${mins} min` : `${hrs} h`;
}

async function defaultReadAlertDoc() {
  try {
    const res = await firestoreFetch('/telemetry/mikrotik_alert');
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || !doc.fields) return null;
    return {
      alertSent:          !!decodeFirestoreValue(doc.fields.alertSent),
      alertedForLastSeen: decodeFirestoreValue(doc.fields.alertedForLastSeen) || '',
      alertedAt:          decodeFirestoreValue(doc.fields.alertedAt) || '',
      recoveredAt:        decodeFirestoreValue(doc.fields.recoveredAt) || '',
    };
  } catch (_) {
    return null;
  }
}

async function defaultWriteAlertDoc(state) {
  const res = await firestoreFetch('/telemetry/mikrotik_alert', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFirestoreFields({
        alertSent:          !!state.alertSent,
        alertedForLastSeen: state.alertedForLastSeen || '',
        alertedAt:          state.alertedAt || '',
        recoveredAt:        state.recoveredAt || '',
        alertPhone:         config.watchdog.alertPhone || '',
      }),
    }),
  });
  return res.ok;
}

/**
 * Ejecuta una iteración del watchdog. Retorna el resultado para pruebas/diagnóstico.
 */
async function checkWatchdogOnce(deps = {}) {
  const cfg            = deps.config || config;
  const getTelemFn     = deps.getTelemetry || getLatestTelemetry;
  const getBotFn       = deps.getBotStatus || getBotStatus;
  const sendWaFn       = deps.sendMessage || sendDirectWhatsAppMessage;
  const readAlertFn    = deps.readAlertDoc || defaultReadAlertDoc;
  const writeAlertFn   = deps.writeAlertDoc || defaultWriteAlertDoc;
  const now            = deps.nowMs !== undefined ? deps.nowMs : Date.now();
  const stateRef       = deps.stateRef || null;

  if (!cfg.watchdog?.enabled || !cfg.watchdog?.alertPhone || cfg.mikrotik?.mock) {
    return { action: 'disabled' };
  }

  const telem = await getTelemFn();
  if (!telem || !telem.lastSeen) {
    return { action: 'no-telemetry' };
  }

  const lastSeenMs = new Date(telem.lastSeen).getTime();
  if (!Number.isFinite(lastSeenMs)) {
    return { action: 'invalid-last-seen' };
  }

  let currentState = stateRef ? stateRef.current : _alertState;
  if (!currentState) {
    currentState = (await readAlertFn()) || {
      alertSent: false,
      alertedForLastSeen: '',
      alertedAt: '',
      recoveredAt: '',
    };
    if (stateRef) stateRef.current = currentState;
    else _alertState = currentState;
  }

  const thresholdMs = (cfg.watchdog.offlineMinutes || 3) * 60_000;
  const ageMs = Math.max(0, now - lastSeenMs);
  const botStatus = getBotFn();
  const businessName = cfg.business?.name || 'WiFi ROYOTA';

  // 1. Router sin reporte >= umbral configurado (por defecto 3 minutos)
  if (ageMs >= thresholdMs) {
    if (currentState.alertSent && currentState.alertedForLastSeen === telem.lastSeen) {
      return { action: 'already-alerted', ageMs };
    }

    if (!botStatus || botStatus.status !== 'connected') {
      return { action: 'waiting-whatsapp', ageMs };
    }

    const cleanVer = String(telem.version || 'RouterOS v7').replace(/\s*\(Enlace Nube Activo\)\s*$/i, '');
    const alertMsg =
      `🚨 *ALERTA CAÍDA EN SITIO — ${businessName}*\n\n` +
      `El router MikroTik lleva *${formatDurationMs(ageMs)}* sin reportar pulso Cloud Sync.\n` +
      `• *Último reporte:* ${formatBogotaTime(lastSeenMs)}\n` +
      `• *Versión:* ${cleanVer}\n` +
      `• *Último uptime:* ${telem.uptime || '—'}\n\n` +
      `Posible corte de energía eléctrica o caída del enlace de internet en el Balneario. Te avisaré automáticamente cuando vuelva a conectarse.`;

    await sendWaFn(cfg.watchdog.alertPhone, alertMsg);

    const nextState = {
      alertSent: true,
      alertedForLastSeen: telem.lastSeen,
      alertedAt: new Date(now).toISOString(),
      recoveredAt: currentState.recoveredAt || '',
    };
    if (stateRef) stateRef.current = nextState;
    else _alertState = nextState;

    await writeAlertFn(nextState).catch(() => {});
    console.warn(`[Watchdog] 🚨 Alerta de caída enviada por WhatsApp a ${cfg.watchdog.alertPhone} (último pulso hace ${formatDurationMs(ageMs)}).`);
    return { action: 'sent-offline-alert', ageMs };
  }

  // 2. Router recuperó conectividad después de una caída alertada
  if (currentState.alertSent) {
    if (!botStatus || botStatus.status !== 'connected') {
      return { action: 'waiting-whatsapp-recovery', ageMs };
    }

    const downStartMs = currentState.alertedForLastSeen
      ? new Date(currentState.alertedForLastSeen).getTime()
      : (currentState.alertedAt ? new Date(currentState.alertedAt).getTime() : now);
    const downtimeMs = Number.isFinite(downStartMs) ? Math.max(60_000, now - downStartMs) : 0;

    const recoveryMsg =
      `✅ *SITIO EN LÍNEA NUEVAMENTE — ${businessName}*\n\n` +
      `El router MikroTik volvió a comunicarse con la plataforma.\n` +
      `• *Reconexión detectada:* ${formatBogotaTime(now)}\n` +
      (downtimeMs ? `• *Duración aproximada del corte:* ${formatDurationMs(downtimeMs)}\n` : '') +
      `• *Uptime reportado:* ${telem.uptime || 'Activo'}`;

    await sendWaFn(cfg.watchdog.alertPhone, recoveryMsg);

    const nextState = {
      alertSent: false,
      alertedForLastSeen: currentState.alertedForLastSeen || '',
      alertedAt: currentState.alertedAt || '',
      recoveredAt: new Date(now).toISOString(),
    };
    if (stateRef) stateRef.current = nextState;
    else _alertState = nextState;

    await writeAlertFn(nextState).catch(() => {});
    console.log(`[Watchdog] ✅ Alerta de recuperación enviada por WhatsApp a ${cfg.watchdog.alertPhone}.`);
    return { action: 'sent-recovery-alert', downtimeMs };
  }

  return { action: 'online-ok', ageMs };
}

async function runWatchdogTick() {
  if (_isChecking) return;
  _isChecking = true;
  try {
    await checkWatchdogOnce();
  } catch (err) {
    console.warn('[Watchdog] Error en verificación periódica:', err.message);
  } finally {
    _isChecking = false;
  }
}

function startMikrotikWatchdog() {
  if (!config.watchdog?.enabled || config.mikrotik?.mock) {
    console.log('[Watchdog] Deshabilitado (modo simulación o ALERT_ENABLED=false).');
    return;
  }
  if (_interval || _startupTimer) return;

  console.log(`[Watchdog] ✅ Monitoreo activo: alerta WhatsApp a ${config.watchdog.alertPhone} tras ${config.watchdog.offlineMinutes} min sin pulso.`);

  // Espera breve inicial para que WhatsApp/Baileys complete la conexión al arrancar
  _startupTimer = setTimeout(() => {
    _startupTimer = null;
    runWatchdogTick();
    _interval = setInterval(runWatchdogTick, config.watchdog.checkIntervalMs || 30_000);
  }, 15_000);
}

function stopMikrotikWatchdog() {
  if (_startupTimer) {
    clearTimeout(_startupTimer);
    _startupTimer = null;
  }
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = {
  startMikrotikWatchdog,
  stopMikrotikWatchdog,
  checkWatchdogOnce,
};
