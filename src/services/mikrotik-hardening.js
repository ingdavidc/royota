/**
 * src/services/mikrotik-hardening.js
 * ─────────────────────────────────────────────────────────────
 * Generadores deterministas (sin interpolación de entrada de usuario)
 * para despliegue remoto controlado de hardening en MikroTik RouterOS v7
 * con backup previo y dead-man's switch de auto-rollback en ~3 min.
 */
'use strict';

const { getSettings, setSettings } = require('../database');
const { firestoreFetch, toFirestoreFields, decodeFirestoreValue } = require('./firestore-client');

const VALID_HARDENING_STAGES = new Set(['armed', 'dispatched', 'applied', 'confirmed', 'rolled_back', 'rollback_armed', 'confirm_armed']);

function escapeRouterOsSource(code) {
  return String(code || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\r\\n');
}

function getBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || 'https://royota-bot.onrender.com';
}

/**
 * Script de reversión limpia (sin variables $ para máxima fiabilidad en RouterOS).
 */
function getRollbackScriptBody() {
  return [
    ':do { /ip firewall filter remove [find where comment~"^HARDENING:"] } on-error={}',
    ':do { /ip service set winbox address="" } on-error={}',
    ':do { /ip service set ssh address="" } on-error={}',
    ':do { /ip service set www address="" } on-error={}',
    ':do { /ip service set reverse-proxy address="" disabled=no } on-error={}',
    ':do { /ipv6 settings set disable-ipv6=no } on-error={}',
    ':do { /file remove [find where name~"^rguard_"] } on-error={}',
    ':do { /system scheduler remove [find where name="hardening-rollback-guard"] } on-error={}',
    ':log warning "ROYOTA: Rollback de hardening ejecutado."',
  ].join('\n');
}

/**
 * Script de tick del guardia (se ejecuta cada 1 min; tras ~3 min sin confirmación
 * ejecuta rollback automático aunque Cloud Sync o Internet hayan caído).
 */
function getGuardTickScriptBody() {
  return [
    ':if ([:len [/file find name="rguard_ok.txt"]] > 0) do={',
    '  :do { /file remove [find where name~"^rguard_"] } on-error={}',
    '  :do { /system scheduler remove [find where name="hardening-rollback-guard"] } on-error={}',
    '  :log info "ROYOTA: Hardening confirmado y guardia retirada."',
    '} else={',
    '  :if ([:len [/file find name="rguard_1.txt"]] > 0) do={',
    '    :do { /file remove "rguard_1.txt" } on-error={}',
    '  } else={',
    '    :if ([:len [/file find name="rguard_2.txt"]] > 0) do={',
    '      :do { /file remove "rguard_2.txt" } on-error={}',
    '    } else={',
    '      :if ([:len [/file find name="rguard_3.txt"]] > 0) do={',
    '        :do { /file remove "rguard_3.txt" } on-error={}',
    '      } else={',
    '        :if ([:len [/file find name="rguard_4.txt"]] > 0) do={',
    '          :do { /file remove "rguard_4.txt" } on-error={}',
    '        } else={',
    '          /system script run "royota-hardening-rollback"',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

/**
 * Script one-shot para aplicar hardening con respaldo previo, guardia de
 * auto-rollback y autocomprobación inmediata de retorno HTTPS hacia Render.
 */
function buildOneShotHardeningRsc(token, baseUrl = getBaseUrl()) {
  const rollbackEscaped = escapeRouterOsSource(getRollbackScriptBody());
  const guardTickEscaped = escapeRouterOsSource(getGuardTickScriptBody());

  const lines = [
    '# ROYOTA Controlled One-Shot Hardening with Auto-Rollback Guard',
    ':do { /system backup save name="pre-hardening" dont-encrypt=yes } on-error={}',
    ':do { /file remove [find where name~"^rguard_"] } on-error={}',
    ':do { /system scheduler remove [find where name="hardening-rollback-guard"] } on-error={}',
    ':do { /system script remove [find where name="royota-hardening-rollback"] } on-error={}',
    ':do { /system script remove [find where name="royota-guard-tick"] } on-error={}',
    `:do { /system script add name="royota-hardening-rollback" policy=ftp,read,write,policy,test,sensitive source="${rollbackEscaped}" } on-error={}`,
    `:do { /system script add name="royota-guard-tick" policy=ftp,read,write,policy,test,sensitive source="${guardTickEscaped}" } on-error={}`,
    ':do { /system identity print file="rguard_1" } on-error={}',
    ':do { /system identity print file="rguard_2" } on-error={}',
    ':do { /system identity print file="rguard_3" } on-error={}',
    ':do { /system identity print file="rguard_4" } on-error={}',
    ':do { /system scheduler add name="hardening-rollback-guard" start-time=startup interval=1m on-event="royota-guard-tick" policy=ftp,read,write,policy,test,sensitive } on-error={}',
    ':local applyOk true',
    ':do {',
    '  /ip firewall filter',
    '  :if ([:len [find where comment="HARDENING: Permitir admin WiFi (Ing. David)"]] = 0) do={',
    '    add chain=input action=accept in-interface=bridge-hotspot src-address=192.168.20.8 comment="HARDENING: Permitir admin WiFi (Ing. David)"',
    '  }',
    '  :if ([:len [find where comment="HARDENING: Permitir DHCP client WAN"]] = 0) do={',
    '    add chain=input action=accept in-interface-list=WAN protocol=udp dst-port=68 comment="HARDENING: Permitir DHCP client WAN"',
    '  }',
    '  :if ([:len [find where comment="HARDENING: ICMP limitado al router"]] = 0) do={',
    '    add chain=input action=accept protocol=icmp limit=5,5:packet comment="HARDENING: ICMP limitado al router"',
    '  }',
    '  :if ([:len [find where comment="HARDENING: Bloquear resto acceso al router (WAN y Hotspot)"]] = 0) do={',
    '    add chain=input action=drop comment="HARDENING: Bloquear resto acceso al router (WAN y Hotspot)"',
    '  }',
    '  :local rAp [find where comment="1. Permitir APs Ruijie a Internet"]',
    '  :if ([:len [find where comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"]] = 0) do={',
    '    :if ([:len $rAp] > 0) do={',
    '      :local tId ($rAp->0)',
    '      add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2 place-before=$tId comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"',
    '    } else={',
    '      add chain=forward action=drop in-interface=bridge-hotspot out-interface=ether2 comment="HARDENING: Bloquear Hotspot hacia Red Admin ether2"',
    '    }',
    '  }',
    '  :if ([:len [find where comment="HARDENING: Aislamiento L3 entre clientes Hotspot"]] = 0) do={',
    '    :if ([:len $rAp] > 0) do={',
    '      :local tId ($rAp->0)',
    '      add chain=forward action=drop in-interface=bridge-hotspot out-interface=bridge-hotspot src-address=192.168.20.10-192.168.23.250 dst-address=192.168.20.10-192.168.23.250 place-before=$tId comment="HARDENING: Aislamiento L3 entre clientes Hotspot"',
    '    } else={',
    '      add chain=forward action=drop in-interface=bridge-hotspot out-interface=bridge-hotspot src-address=192.168.20.10-192.168.23.250 dst-address=192.168.20.10-192.168.23.250 comment="HARDENING: Aislamiento L3 entre clientes Hotspot"',
    '    }',
    '  }',
    '  /ip service',
    '  set winbox address=192.168.10.0/24,192.168.20.8/32',
    '  set ssh address=192.168.10.0/24,192.168.20.8/32',
    '  set www address=192.168.10.0/24,192.168.20.8/32',
    '  :do { set reverse-proxy address=192.168.10.0/24 disabled=yes } on-error={}',
    '  /ipv6 settings set disable-ipv6=yes',
    '} on-error={',
    '  :set applyOk false',
    '  :do { /system script run "royota-hardening-rollback" } on-error={}',
    '}',
    ':if ($applyOk) do={',
    '  :delay 1s',
    `  :do { /tool fetch url="${baseUrl}/api/mikrotik/hardening-ack?token=${token}&stage=applied" check-certificate=yes output=none } on-error={ :do { /system script run "royota-hardening-rollback" } on-error={} }`,
    '} else={',
    `  :do { /tool fetch url="${baseUrl}/api/mikrotik/hardening-ack?token=${token}&stage=rolled_back" check-certificate=yes output=none } on-error={}`,
    '}',
  ];

  return lines.join('\n') + '\n';
}

/**
 * Script one-shot para confirmar hardening validado y desarmar el guardia.
 */
function buildOneShotHardeningConfirmRsc(token, baseUrl = getBaseUrl()) {
  const lines = [
    '# ROYOTA Confirm Validated Hardening & Disarm Guard',
    ':do { /system identity print file="rguard_ok" } on-error={}',
    ':do { /file remove [find where name~"^rguard_"] } on-error={}',
    ':do { /system scheduler remove [find where name="hardening-rollback-guard"] } on-error={}',
    ':do { /system script remove [find where name="royota-guard-tick"] } on-error={}',
    ':if ([:len [/ip firewall filter find where comment~"^HARDENING:"]] > 0) do={',
    '  :log info "ROYOTA: Hardening validado y confirmado en produccion."',
    `  :do { /tool fetch url="${baseUrl}/api/mikrotik/hardening-ack?token=${token}&stage=confirmed" check-certificate=yes output=none } on-error={}`,
    '} else={',
    '  :log warning "ROYOTA: Confirmacion tardia; el guardia ya habia ejecutado rollback."',
    `  :do { /tool fetch url="${baseUrl}/api/mikrotik/hardening-ack?token=${token}&stage=rolled_back" check-certificate=yes output=none } on-error={}`,
    '}',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Script one-shot para forzar rollback remoto en cualquier momento.
 */
function buildOneShotHardeningRollbackRsc(token, baseUrl = getBaseUrl()) {
  const rollbackEscaped = escapeRouterOsSource(getRollbackScriptBody());
  const lines = [
    '# ROYOTA Remote Controlled Hardening Rollback',
    `:if ([:len [/system script find name="royota-hardening-rollback"]] = 0) do={ :do { /system script add name="royota-hardening-rollback" policy=ftp,read,write,policy,test,sensitive source="${rollbackEscaped}" } on-error={} }`,
    ':do { /system script run "royota-hardening-rollback" } on-error={}',
    `:do { /tool fetch url="${baseUrl}/api/mikrotik/hardening-ack?token=${token}&stage=rolled_back" check-certificate=yes output=none } on-error={}`,
  ];
  return lines.join('\n') + '\n';
}

async function saveHardeningState(stage, detail = '') {
  const updatedAt = new Date().toISOString();
  setSettings({
    mikrotik_hardening_stage: stage,
    mikrotik_hardening_updated_at: updatedAt,
    mikrotik_hardening_detail: String(detail || ''),
  });

  try {
    await firestoreFetch('/telemetry/mikrotik_hardening', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          stage,
          detail: String(detail || ''),
          updated_at: updatedAt,
        }),
      }),
    });
  } catch (_) {}

  return { stage, detail: String(detail || ''), updated_at: updatedAt };
}

async function getHardeningState() {
  const s = getSettings();
  const local = {
    stage: s.mikrotik_hardening_stage || 'idle',
    detail: s.mikrotik_hardening_detail || '',
    updated_at: s.mikrotik_hardening_updated_at || null,
  };

  try {
    const res = await firestoreFetch('/telemetry/mikrotik_hardening');
    if (res.ok) {
      const doc = await res.json();
      if (doc && doc.fields) {
        const fsUpdated = decodeFirestoreValue(doc.fields.updated_at) || null;
        if (!local.updated_at || (fsUpdated && new Date(fsUpdated) >= new Date(local.updated_at))) {
          return {
            stage: decodeFirestoreValue(doc.fields.stage) || local.stage,
            detail: decodeFirestoreValue(doc.fields.detail) || local.detail,
            updated_at: fsUpdated || local.updated_at,
          };
        }
      }
    }
  } catch (_) {}

  return local;
}

module.exports = {
  VALID_HARDENING_STAGES,
  escapeRouterOsSource,
  getRollbackScriptBody,
  getGuardTickScriptBody,
  buildOneShotHardeningRsc,
  buildOneShotHardeningConfirmRsc,
  buildOneShotHardeningRollbackRsc,
  saveHardeningState,
  getHardeningState,
};
