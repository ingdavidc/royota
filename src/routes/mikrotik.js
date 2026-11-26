/**
 * src/routes/mikrotik.js
 * ─────────────────────────────────────────────────────────────
 * Estado, diagnóstico, IP Bindings, Cloud Sync ACK, sanitización
 * anti-inyección RouterOS y colector temporal de auditoría (Opción A).
 */
'use strict';

const { Router } = require('express');
const config     = require('../config');
const { authRequired } = require('../middleware/auth');
const mikrotik   = require('../services/mikrotik-api');
const { getDb, getSettings, setSettings } = require('../database');
const { firestoreFetch, toFirestoreFields } = require('../services/firestore-client');
const { recordTelemetry, getLatestTelemetry, getTelemetrySnapshot } = require('../services/mikrotik-telemetry');
const hardening = require('../services/mikrotik-hardening');
const { timingSafeEqualStr } = require('../utils/helpers');

const router = Router();

let _profilesNeedSync = true;
let _auditArmed = false;
let _auditLastDispatchedMs = 0;
let _hardeningAction = null; // 'apply' | 'confirm' | 'rollback' | null
let _hardeningLastDispatchedMs = 0;

// Rastrea IDs ya entregados al router en espera de ACK (evita re-inyección repetida en ventanas de 3s)
const _inFlightSync = {
  vouchers: new Map(),
  bindings: new Map(),
  removals: new Map(),
};

function isInFlight(map, id) {
  const ts = map.get(id);
  return ts && (Date.now() - ts) < 15_000;
}

function markInFlight(map, id) {
  map.set(id, Date.now());
}

// Expresiones regulares estrictas anti-inyección RouterOS
const REGEX_CODE     = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
const REGEX_PROFILE  = /^[A-Za-z0-9 _.-]{1,32}$/;
const REGEX_DURATION = /^\d+[mhd]$/;
const REGEX_SPEED    = /^\d+[MkGmkg]\/\d+[MkGmkg]$/;
const REGEX_MAC      = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const REGEX_IPV4     = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const REGEX_NUM_LIST = /^\d+(,\d+)*$/;
const REGEX_AUDIT_PART = /^raud_[a-z0-9_]+\.(txt|rsc)$/;

function normalizeMac(raw) {
  return String(raw || '').trim().toUpperCase().replace(/-/g, ':');
}

function sanitizeRouterOsStr(str, fallback = 'Royota Cloud', maxLen = 64) {
  const cleaned = String(str || '')
    .replace(/["$\\[\]{};\r\n\t\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function verifySyncToken(req) {
  const expected = config.mikrotik.syncToken;
  if (!expected) {
    console.warn('[MikroTik-Sync] ⚠️ MIKROTIK_SYNC_TOKEN no configurado en variables de entorno.');
    return false;
  }
  const provided = String(req.query.token || req.headers['x-sync-token'] || '');
  return timingSafeEqualStr(provided, expected);
}

// GET /api/mikrotik/test — Estado de conectividad (Admin autenticado)
router.get('/test', authRequired, async (req, res) => {
  const now = Date.now();
  const telem = await getLatestTelemetry();

  const lastSeenMs = telem.lastSeen ? new Date(telem.lastSeen).getTime() : 0;
  const ageMs = lastSeenMs ? Math.max(0, now - lastSeenMs) : Infinity;
  const isRouterAlive = ageMs < 90_000;

  if (isRouterAlive) {
    const cleanVer = String(telem.version || 'RouterOS v7').replace(/\s*\(Enlace Nube Activo\)\s*$/i, '');
    return res.json({
      ok: true,
      routerboard: true,
      version: `${cleanVer} (Enlace Nube Activo)`,
      uptime: telem.uptime || 'Activo',
      cpuLoad: telem.cpuLoad !== null && telem.cpuLoad !== undefined ? telem.cpuLoad : 2,
      freeMemory: telem.freeMemory || 524288000,
      totalMemory: telem.totalMemory || 1073741824,
      syncMode: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)',
      lastSeen: telem.lastSeen,
    });
  }

  if (config.mikrotik.cloudSyncOnly) {
    const offlineMins = Number.isFinite(ageMs) ? Math.floor(ageMs / 60_000) : null;
    const lastSeenInfo = telem.lastSeen
      ? `Último pulso Cloud Sync hace ${offlineMins} min (${telem.lastSeen})`
      : 'Sin pulso Cloud Sync registrado aún';
    return res.status(502).json({
      ok: false,
      cloudSyncOnly: true,
      lastSeen: telem.lastSeen || null,
      version: telem.version || null,
      uptime: telem.uptime || null,
      error: `Router sin conexión Cloud Sync (${lastSeenInfo}). Conexión directa no disponible detrás de CGNAT del ISP.`,
    });
  }

  const result = await mikrotik.testConnection();
  res.status(result.ok ? 200 : 502).json(result);
});

// GET /api/mikrotik/profiles — Listar perfiles Hotspot
router.get('/profiles', authRequired, async (req, res) => {
  if (config.mikrotik.cloudSyncOnly) {
    return res.status(502).json({ error: 'Consulta directa REST no disponible en modo Cloud Sync (CGNAT)' });
  }
  try {
    const profiles = await mikrotik.listProfiles();
    res.json(Array.isArray(profiles) ? profiles : []);
  } catch (err) {
    res.status(502).json({ error: `Error al consultar perfiles: ${err.message}` });
  }
});

// GET /api/mikrotik/users — Usuarios Hotspot en el router
router.get('/users', authRequired, async (req, res) => {
  if (config.mikrotik.cloudSyncOnly) {
    return res.status(502).json({ error: 'Consulta directa REST no disponible en modo Cloud Sync (CGNAT)' });
  }
  try {
    res.json(await mikrotik.listHotspotUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar usuarios: ${err.message}` });
  }
});

// GET /api/mikrotik/active — Sesiones activas (Admin autenticado)
router.get('/active', authRequired, async (req, res) => {
  if (config.mikrotik.cloudSyncOnly) {
    return res.status(502).json({ error: 'Consulta directa REST no disponible en modo Cloud Sync (CGNAT)' });
  }
  try {
    res.json(await mikrotik.listActiveUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar sesiones: ${err.message}` });
  }
});

// GET /api/mikrotik/sync-log?limit=100 — Log de sincronización (Admin autenticado)
router.get('/sync-log', authRequired, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const logs  = getDb().prepare(
    'SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json(logs);
});

// GET /api/mikrotik/sync/setup-script — Comando Cloud Sync con el token desde entorno (solo Admin)
router.get('/sync/setup-script', authRequired, (req, res) => {
  const tokenPlaceholder = config.mikrotik.syncToken || '<CONFIGURAR_MIKROTIK_SYNC_TOKEN_EN_RENDER>';
  const apiUrl = process.env.RENDER_EXTERNAL_URL || 'https://royota-bot.onrender.com';
  const scriptCmd = `/system script add name="sync-cloud-vouchers" policy=read,write,test source=":do {\\r\\n :local cpu [/system resource get cpu-load];\\r\\n :local up [/system resource get uptime];\\r\\n :local ver [/system resource get version];\\r\\n :local mem [/system resource get free-memory];\\r\\n /tool fetch url=\\"${apiUrl}/api/mikrotik/sync/vouchers.rsc?token=${tokenPlaceholder}&cpu=\\$cpu&uptime=\\$up&version=\\$ver&mem=\\$mem\\" dst-path=\\"sync.rsc\\" check-certificate=yes;\\r\\n :delay 500ms;\\r\\n :local f [/file find name=\\"sync.rsc\\"];\\r\\n :if (\\$f != \\"\\") do={\\r\\n :local fSize [/file get \\$f size];\\r\\n :if (\\$fSize > 40) do={\\r\\n /import file-name=\\"sync.rsc\\";\\r\\n };\\r\\n /file remove \\"sync.rsc\\";\\r\\n };\\r\\n} on-error={}"\n\n/system scheduler add interval=15s name="cloud-sync-scheduler" on-event="sync-cloud-vouchers" start-time=startup`;
  res.json({ script: scriptCmd, tokenConfigured: !!config.mikrotik.syncToken });
});

// ── IP BINDINGS (Dispositivos Exentos: Smart TVs, Cámaras, etc.) ──
router.get('/bindings', authRequired, async (req, res) => {
  try {
    const local = getDb().prepare('SELECT * FROM ip_bindings ORDER BY created_at DESC').all();
    res.json(local);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bindings', authRequired, async (req, res) => {
  const { mac_address, comment, type, address } = req.body;
  if (!mac_address) return res.status(400).json({ error: 'Dirección MAC es requerida' });

  const cleanMac = normalizeMac(mac_address);
  if (!REGEX_MAC.test(cleanMac)) {
    return res.status(400).json({ error: 'Formato de MAC inválido (AA:BB:CC:DD:EE:FF)' });
  }

  const cleanAddress = address ? String(address).trim() : '';
  if (cleanAddress && !REGEX_IPV4.test(cleanAddress)) {
    return res.status(400).json({ error: 'Dirección IPv4 inválida' });
  }

  const cleanComment = sanitizeRouterOsStr(comment, 'Dispositivo Exento', 80);
  const cleanType = ['bypassed', 'blocked', 'regular'].includes(type) ? type : 'bypassed';

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO ip_bindings (mac_address, comment, type, address, server, is_active, mikrotik_synced, created_at)
      VALUES (?, ?, ?, ?, 'all', 1, 0, datetime('now'))
      ON CONFLICT(mac_address) DO UPDATE SET
        comment = excluded.comment,
        type = excluded.type,
        address = excluded.address,
        is_active = 1,
        mikrotik_synced = 0
    `).run(cleanMac, cleanComment, cleanType, cleanAddress);

    if (!config.mikrotik.cloudSyncOnly) {
      try {
        await mikrotik.createIpBinding(cleanMac, cleanComment, cleanType, cleanAddress);
        db.prepare('UPDATE ip_bindings SET mikrotik_synced = 1 WHERE mac_address = ?').run(cleanMac);
      } catch (_) {}
    }

    res.json({ ok: true, mac: cleanMac, comment: cleanComment, type: cleanType, address: cleanAddress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/bindings/:mac', authRequired, async (req, res) => {
  const cleanMac = normalizeMac(decodeURIComponent(req.params.mac || ''));
  if (!REGEX_MAC.test(cleanMac)) {
    return res.status(400).json({ error: 'Formato de MAC inválido' });
  }
  const db = getDb();
  try {
    db.prepare('DELETE FROM ip_bindings WHERE mac_address = ? COLLATE NOCASE').run(cleanMac);
    db.prepare('INSERT INTO pending_removals (mac_address) VALUES (?)').run(cleanMac);
    if (!config.mikrotik.cloudSyncOnly) {
      try { await mikrotik.removeIpBinding(cleanMac); } catch (_) {}
    }
    res.json({ ok: true, removed: cleanMac });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mikrotik/sync/push-binding — Encolar IP Binding (Admin autenticado)
router.post('/sync/push-binding', authRequired, (req, res) => {
  const { mac_address, comment, type, address } = req.body;
  if (!mac_address) return res.status(400).json({ error: 'MAC requerida' });

  const cleanMac = normalizeMac(mac_address);
  if (!REGEX_MAC.test(cleanMac)) {
    return res.status(400).json({ error: 'MAC inválida' });
  }

  const cleanAddress = address ? String(address).trim() : '';
  if (cleanAddress && !REGEX_IPV4.test(cleanAddress)) {
    return res.status(400).json({ error: 'IPv4 inválida' });
  }

  const cleanComment = sanitizeRouterOsStr(comment, 'Dispositivo Exento', 80);
  const cleanType = ['bypassed', 'blocked', 'regular'].includes(type) ? type : 'bypassed';

  try {
    getDb().prepare(`
      INSERT INTO ip_bindings (mac_address, comment, type, address, server, is_active, mikrotik_synced, created_at)
      VALUES (?, ?, ?, ?, 'all', 1, 0, datetime('now'))
      ON CONFLICT(mac_address) DO UPDATE SET
        comment = excluded.comment,
        type = excluded.type,
        address = excluded.address,
        is_active = 1,
        mikrotik_synced = 0
    `).run(cleanMac, cleanComment, cleanType, cleanAddress);
    console.log(`[Cloud-Sync] 📺 IP Binding ${cleanMac} (${cleanComment}) encolado.`);
    res.json({ ok: true, mac: cleanMac });
  } catch (err) {
    console.error('[Cloud-Sync] Error en push-binding:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mikrotik/sync/push-batch — Encolar lote generado (Admin autenticado)
router.post('/sync/push-batch', authRequired, (req, res) => {
  const { vouchers, plan } = req.body;
  if (!Array.isArray(vouchers) || !vouchers.length) {
    return res.status(400).json({ error: 'Lista de fichas requerida' });
  }

  const rawProfile  = (plan && plan.name) ? sanitizeRouterOsStr(plan.name, '1 Hora Basico', 32) : '1 Hora Basico';
  const rawDuration = (plan && plan.duration) ? String(plan.duration).trim().toLowerCase() : '1h';
  const rawSpeed    = (plan && plan.speed_limit) ? String(plan.speed_limit).trim() : '5M/2M';

  const profileName = REGEX_PROFILE.test(rawProfile) ? rawProfile : '1 Hora Basico';
  const duration    = REGEX_DURATION.test(rawDuration) ? rawDuration : '1h';
  const speedLimit  = REGEX_SPEED.test(rawSpeed) ? rawSpeed : '5M/2M';
  const sharedUsers = Math.min(20, Math.max(1, parseInt(plan?.shared_users, 10) || 1));

  const db = getDb();
  let insertCount = 0;

  try {
    let planRow = db.prepare('SELECT id, duration, profile_name FROM plans WHERE name = ? COLLATE NOCASE').get(profileName);
    if (!planRow) {
      const prc = Math.max(0, parseFloat(plan?.price) || 2000);
      const info = db.prepare(`
        INSERT INTO plans (name, duration, speed_limit, price, shared_users, profile_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(profileName, duration, speedLimit, prc, sharedUsers, profileName);
      planRow = { id: info.lastInsertRowid, duration, profile_name: profileName };
    }
    const resolvedPlanId = planRow.id;

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO vouchers (code, plan_id, status, mikrotik_synced, created_at)
      VALUES (?, ?, 'available', 0, datetime('now'))
    `);

    const transaction = db.transaction((codes) => {
      for (const code of codes) {
        const clean = String(code).trim().toUpperCase();
        if (REGEX_CODE.test(clean)) {
          insertStmt.run(clean, resolvedPlanId);
          insertCount++;
        }
      }
    });

    transaction(vouchers);
    _profilesNeedSync = true;
    console.log(`[Cloud-Sync] 💾 ${insertCount} fichas persistidas para sincronización.`);
  } catch (err) {
    console.error('[Cloud-Sync] Error persistiendo lote en SQLite:', err.message);
  }

  res.json({ ok: true, queued: insertCount });
});

// POST /api/mikrotik/sync/plan-sync — Registrar/actualizar plan para sincronización en router (Admin autenticado)
router.post('/sync/plan-sync', authRequired, (req, res) => {
  const { name, duration, speed_limit, speed, price, shared_users, shared, is_active } = req.body;
  const cleanName = sanitizeRouterOsStr(name, '', 32);
  if (!cleanName || !REGEX_PROFILE.test(cleanName)) {
    return res.status(400).json({ error: 'Nombre de plan inválido' });
  }

  const dur = REGEX_DURATION.test(String(duration || '').trim().toLowerCase()) ? String(duration).trim().toLowerCase() : '1h';
  const spdRaw = String(speed_limit || speed || '5M/5M').trim();
  const spd = REGEX_SPEED.test(spdRaw) ? spdRaw : '5M/5M';
  const shr = Math.min(20, Math.max(1, parseInt(shared_users || shared, 10) || 1));
  const prc = Math.max(0, parseFloat(price) || 0);
  const activeFlag = (is_active === 0 || is_active === '0' || is_active === false) ? 0 : 1;

  const db = getDb();
  const existing = db.prepare('SELECT id FROM plans WHERE name = ? COLLATE NOCASE').get(cleanName);
  if (existing) {
    db.prepare(`
      UPDATE plans SET duration = ?, speed_limit = ?, price = ?, shared_users = ?, is_active = ?, profile_name = ?
      WHERE id = ?
    `).run(dur, spd, prc, shr, activeFlag, cleanName, existing.id);
  } else {
    db.prepare(`
      INSERT INTO plans (name, duration, speed_limit, price, shared_users, is_active, profile_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cleanName, dur, spd, prc, shr, activeFlag, cleanName);
  }
  _profilesNeedSync = true;
  res.json({ ok: true, plan: cleanName });
});

// ── OPCIÓN A: COLECTOR AUTOMÁTICO DE AUDITORÍA MIKROTIK (SOLO LECTURA) ──
const AUDIT_FILE_SPEC = [
  { key: 'bridge_export', file: 'raud_bridge.rsc', cmd: '/interface bridge export file="raud_bridge"' },
  { key: 'bridge_ports',  file: 'raud_bport.txt',  cmd: '/interface bridge port print detail without-paging file="raud_bport"' },
  { key: 'ip_address',    file: 'raud_addr.rsc',   cmd: '/ip address export file="raud_addr"' },
  { key: 'ip_dhcp',       file: 'raud_dhcp.rsc',   cmd: '/ip dhcp-server export file="raud_dhcp"' },
  { key: 'hotspot_srv',   file: 'raud_hs.txt',     cmd: '/ip hotspot print detail without-paging file="raud_hs"' },
  { key: 'hotspot_prof',  file: 'raud_hsprof.txt', cmd: '/ip hotspot profile print detail without-paging file="raud_hsprof"' },
  { key: 'ip_bindings',   file: 'raud_bind.txt',   cmd: '/ip hotspot ip-binding print detail without-paging file="raud_bind"' },
  { key: 'walled_garden', file: 'raud_wg.txt',     cmd: '/ip hotspot walled-garden print without-paging file="raud_wg"' },
  { key: 'walled_ip',     file: 'raud_wgip.txt',   cmd: '/ip hotspot walled-garden ip print without-paging file="raud_wgip"' },
  { key: 'firewall_flt',  file: 'raud_fw.txt',     cmd: '/ip firewall filter print all without-paging file="raud_fw"' },
  { key: 'firewall_nat',  file: 'raud_nat.txt',    cmd: '/ip firewall nat print without-paging file="raud_nat"' },
  { key: 'ip_service',    file: 'raud_svc.txt',    cmd: '/ip service print without-paging file="raud_svc"' },
  { key: 'ipv6_settings', file: 'raud_ipv6.txt',   cmd: '/ipv6 settings print file="raud_ipv6"' },
  { key: 'scheduler',     file: 'raud_sched.txt',  cmd: '/system scheduler print detail without-paging file="raud_sched"' },
];

function buildOneShotAuditRsc(token) {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://royota-bot.onrender.com';
  const lines = [
    '# ROYOTA One-Shot Read-Only Security Audit',
    ':do {',
  ];
  for (const spec of AUDIT_FILE_SPEC) {
    lines.push(`  :do { ${spec.cmd} } on-error={}`);
  }
  lines.push('  :delay 1500ms');
  const fileList = AUDIT_FILE_SPEC.map((s) => `"${s.file}"`).join(';');
  lines.push(`  :foreach fname in={${fileList}} do={`);
  lines.push('    :local f [/file find name=$fname]');
  lines.push('    :if ($f != "") do={');
  lines.push('      :local body [/file get $f contents]');
  lines.push('      :if ([:len $body] > 0) do={');
  lines.push(`        :do { /tool fetch url="${baseUrl}/api/mikrotik/audit-upload?token=${token}&part=$fname" http-method=post http-header-field="Content-Type: text/plain" http-data=$body check-certificate=no output=none } on-error={}`);
  lines.push('      }');
  lines.push('      :do { /file remove $f } on-error={}');
  lines.push('    }');
  lines.push('  }');
  lines.push('} on-error={}');
  return lines.join('\n') + '\n';
}

// POST /api/mikrotik/audit-upload — Recibe secciones de solo lectura enviadas por el router
router.post('/audit-upload', async (req, res) => {
  if (!verifySyncToken(req)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const part = String(req.query.part || '').trim();
  if (!REGEX_AUDIT_PART.test(part)) {
    return res.status(400).json({ error: 'Nombre de sección inválido' });
  }

  const content = typeof req.body === 'string'
    ? req.body
    : (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '');

  const settings = getSettings();
  let report = {};
  try {
    report = settings.mikrotik_audit_report ? JSON.parse(settings.mikrotik_audit_report) : {};
  } catch (_) {
    report = {};
  }

  report[part] = content.slice(0, 65_000);
  const updatedAt = new Date().toISOString();
  setSettings({
    mikrotik_audit_done: '1',
    mikrotik_audit_updated_at: updatedAt,
    mikrotik_audit_report: JSON.stringify(report),
  });

  // Espejar también en Firestore para consulta remota
  try {
    await firestoreFetch('/telemetry/mikrotik_audit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          updated_at: updatedAt,
          parts_count: Object.keys(report).length,
          report_json: JSON.stringify(report).slice(0, 800_000),
        }),
      }),
    });
  } catch (_) {}

  console.log(`[MikroTik-Audit] 📥 Sección recibida (${part}, ${content.length} bytes). Total secciones: ${Object.keys(report).length}`);
  res.json({ ok: true, part, bytes: content.length });
});

// GET /api/mikrotik/audit-report — Consultar reporte recolectado (Admin autenticado)
router.get('/audit-report', authRequired, (req, res) => {
  const s = getSettings();
  let report = {};
  try {
    report = s.mikrotik_audit_report ? JSON.parse(s.mikrotik_audit_report) : {};
  } catch (_) {}
  res.json({
    done: s.mikrotik_audit_done === '1',
    updated_at: s.mikrotik_audit_updated_at || null,
    parts_received: Object.keys(report),
    report,
  });
});

// POST /api/mikrotik/audit-trigger — Re-armar recolección única de auditoría (Admin autenticado)
router.post('/audit-trigger', authRequired, (req, res) => {
  _auditArmed = true;
  _auditLastDispatchedMs = 0;
  setSettings({ mikrotik_audit_done: '0' });
  res.json({ ok: true, message: 'Auditoría one-shot armada para el próximo pulso único del router.' });
});

// POST /api/mikrotik/hardening-trigger — Desplegar hardening controlado con auto-rollback 3 min
router.post('/hardening-trigger', authRequired, async (req, res) => {
  _hardeningAction = 'apply';
  _hardeningLastDispatchedMs = 0;
  const state = await hardening.saveHardeningState('armed', 'Despliegue controlado armado; esperando próximo pulso Cloud Sync.');
  res.json({ ok: true, ...state });
});

// POST /api/mikrotik/hardening-confirm — Confirmar hardening validado y desarmar guardia auto-rollback
router.post('/hardening-confirm', authRequired, async (req, res) => {
  _hardeningAction = 'confirm';
  _hardeningLastDispatchedMs = 0;
  const state = await hardening.saveHardeningState('confirm_armed', 'Confirmación armada para desactivar guardia auto-rollback.');
  res.json({ ok: true, ...state });
});

// POST /api/mikrotik/hardening-rollback — Forzar rollback remoto inmediato en el próximo pulso
router.post('/hardening-rollback', authRequired, async (req, res) => {
  _hardeningAction = 'rollback';
  _hardeningLastDispatchedMs = 0;
  const state = await hardening.saveHardeningState('rollback_armed', 'Rollback remoto armado para el próximo pulso.');
  res.json({ ok: true, ...state });
});

// GET /api/mikrotik/hardening-status — Consultar estado de hardening/auto-rollback
router.get('/hardening-status', authRequired, async (req, res) => {
  const state = await hardening.getHardeningState();
  res.json({ ok: true, pendingAction: _hardeningAction, ...state });
});

// GET /api/mikrotik/hardening-ack — Confirmación del router tras aplicar/confirmar/revertir hardening
router.get('/hardening-ack', async (req, res) => {
  if (!verifySyncToken(req)) {
    return res.status(403).send('# unauthorized\n');
  }
  const stage = String(req.query.stage || '').trim();
  if (!hardening.VALID_HARDENING_STAGES.has(stage)) {
    return res.status(400).send('# invalid stage\n');
  }
  await hardening.saveHardeningState(stage, `Router reportó stage=${stage} vía HTTPS.`);
  console.log(`[MikroTik-Hardening] ✅ ACK recibido del router: stage=${stage}`);
  res.setHeader('Content-Type', 'text/plain');
  res.send(`# hardening-ack ${stage}\n`);
});

// GET /api/mikrotik/sync/ack — Confirmación del router tras aplicar sync.rsc
router.get('/sync/ack', (req, res) => {
  if (!verifySyncToken(req)) {
    return res.status(403).send('# unauthorized\n');
  }
  const db = getDb();
  const vRaw = String(req.query.v || '').trim();
  const bRaw = String(req.query.b || '').trim();
  const rRaw = String(req.query.r || '').trim();

  try {
    if (REGEX_NUM_LIST.test(vRaw)) {
      const ids = vRaw.split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`UPDATE vouchers SET mikrotik_synced = 1 WHERE id IN (${ph})`).run(...ids);
        ids.forEach((id) => _inFlightSync.vouchers.delete(id));
      }
    }
    if (REGEX_NUM_LIST.test(bRaw)) {
      const ids = bRaw.split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`UPDATE ip_bindings SET mikrotik_synced = 1 WHERE id IN (${ph})`).run(...ids);
        ids.forEach((id) => _inFlightSync.bindings.delete(id));
      }
    }
    if (REGEX_NUM_LIST.test(rRaw)) {
      const ids = rRaw.split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM pending_removals WHERE id IN (${ph})`).run(...ids);
        ids.forEach((id) => _inFlightSync.removals.delete(id));
      }
    }
  } catch (err) {
    console.error('[Cloud-Sync ACK] Error:', err.message);
  }
  res.setHeader('Content-Type', 'text/plain');
  res.send('# ack ok\n');
});

// GET /api/mikrotik/sync/vouchers.rsc — Descargado autónomamente por el MikroTik (Token requerido)
router.get('/sync/vouchers.rsc', (req, res) => {
  if (!verifySyncToken(req)) {
    return res.status(403).send('# Error: Acceso no autorizado a la cola de aprovisionamiento\n');
  }

  const version = req.query.version || req.query.v;
  const uptime  = req.query.uptime  || req.query.u;
  const cpu     = req.query.cpu     || req.query.c;
  const mem     = req.query.mem     || req.query.m;

  const prev = getTelemetrySnapshot();
  recordTelemetry({
    lastSeen: new Date().toISOString(),
    version: version ? `RouterOS ${sanitizeRouterOsStr(version, 'v7', 24)}` : (prev.version || 'RouterOS v7.25.1'),
    uptime: uptime ? sanitizeRouterOsStr(uptime, 'Activo', 32) : (prev.uptime || 'Activo'),
    cpuLoad: cpu !== undefined ? (parseInt(cpu, 10) || 0) : (prev.cpuLoad || 3),
    freeMemory: mem !== undefined ? (parseInt(mem, 10) || 0) : (prev.freeMemory || 524288000),
    totalMemory: 1073741824,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
  });

  const db = getDb();
  let rscCommands = '';

  // 1. Despliegue/confirmación/rollback one-shot de hardening controlado (prioritario, 1 disparo)
  let dispatchedHardening = false;
  try {
    if (_hardeningAction && (Date.now() - _hardeningLastDispatchedMs) > 15_000) {
      const action = _hardeningAction;
      _hardeningAction = null;
      _hardeningLastDispatchedMs = Date.now();
      dispatchedHardening = true;
      if (action === 'apply') {
        rscCommands += hardening.buildOneShotHardeningRsc(config.mikrotik.syncToken) + '\n';
        hardening.saveHardeningState('dispatched', 'Script de hardening con guardia 3-min enviado al router.').catch(() => {});
      } else if (action === 'confirm') {
        rscCommands += hardening.buildOneShotHardeningConfirmRsc(config.mikrotik.syncToken) + '\n';
      } else if (action === 'rollback') {
        rscCommands += hardening.buildOneShotHardeningRollbackRsc(config.mikrotik.syncToken) + '\n';
      }
      console.log(`[MikroTik-Hardening] 📡 Script one-shot (${action}) enviado al router.`);
    }
  } catch (err) {
    console.warn('[MikroTik-Hardening] Aviso preparando script:', err.message);
  }

  // 2. Colector de auditoría Opción A (solo si fue armado manualmente, máximo 1 envío)
  try {
    if (!dispatchedHardening && _auditArmed && (Date.now() - _auditLastDispatchedMs) > 120_000) {
      _auditArmed = false;
      _auditLastDispatchedMs = Date.now();
      rscCommands += buildOneShotAuditRsc(config.mikrotik.syncToken) + '\n';
      console.log('[MikroTik-Audit] 📡 Instrucción one-shot de auditoría enviada al router (1 disparo).');
    }
  } catch (err) {
    console.warn('[MikroTik-Audit] Aviso preparando colector:', err.message);
  }

  // 2. Sincronizar perfiles Hotspot con validación estricta anti-inyección
  if (_profilesNeedSync) {
    try {
      const activePlans = db.prepare('SELECT * FROM plans WHERE is_active = 1').all();
      const validProfiles = activePlans.filter((p) =>
        REGEX_PROFILE.test(String(p.name || '').trim()) &&
        REGEX_SPEED.test(String(p.speed_limit || '5M/5M').trim())
      );
      if (validProfiles.length > 0) {
        rscCommands += '/ip hotspot user profile\n';
        validProfiles.forEach((p) => {
          const cleanName = String(p.name).trim();
          const speed = String(p.speed_limit || '5M/5M').trim();
          const shared = Math.min(20, Math.max(1, parseInt(p.shared_users, 10) || 1));
          rscCommands += `:if ([:len [find name="${cleanName}"]] = 0) do={ add name="${cleanName}" rate-limit="${speed}" shared-users=${shared} keepalive-timeout=2m status-autorefresh=1m transparent-proxy=no } else={ set [find name="${cleanName}"] rate-limit="${speed}" shared-users=${shared} }\n`;
        });
      }
      _profilesNeedSync = false;
    } catch (pErr) {
      console.error('[Cloud-Sync] Error generando perfiles RSC:', pErr.message);
    }
  }

  const ackVouchers = [];
  const ackBindings = [];
  const ackRemovals = [];

  // 3. Fichas pendientes (validadas antes de interpolar)
  try {
    const unsynced = db.prepare(`
      SELECT v.id, v.code, p.name AS plan_name, p.profile_name, p.duration
      FROM vouchers v
      LEFT JOIN plans p ON v.plan_id = p.id
      WHERE v.mikrotik_synced = 0
      ORDER BY v.id ASC
      LIMIT 100
    `).all().filter((v) => !isInFlight(_inFlightSync.vouchers, v.id));

    if (unsynced.length > 0) {
      const lines = [];
      unsynced.forEach((v) => {
        const clean = String(v.code || '').trim().toUpperCase();
        if (REGEX_CODE.test(clean)) {
          const prof = (v.profile_name && REGEX_PROFILE.test(v.profile_name) && v.profile_name !== 'default')
            ? v.profile_name
            : ((v.plan_name && REGEX_PROFILE.test(v.plan_name)) ? v.plan_name : '1 Hora Basico');
          const dur = (v.duration && REGEX_DURATION.test(v.duration)) ? v.duration : '1h';
          lines.push(`:do { add name="${clean}" password="${clean}" profile="${prof}" limit-uptime="${dur}" comment="Royota Cloud" } on-error={ :do { add name="${clean}" password="${clean}" profile="default" limit-uptime="${dur}" comment="Royota Cloud" } on-error={} }`);
          ackVouchers.push(v.id);
          markInFlight(_inFlightSync.vouchers, v.id);
        }
      });
      if (lines.length) {
        rscCommands += '\n/ip hotspot user\n' + lines.join('\n') + '\n';
      }
    }
  } catch (err) {
    console.error('[Cloud-Sync] Error procesando fichas pendientes:', err.message);
  }

  // 4. IP Bindings pendientes (MAC, IPv4, type y comment estrictamente validados)
  try {
    const unsyncedBindings = db.prepare(`
      SELECT id, mac_address, comment, type, address
      FROM ip_bindings
      WHERE mikrotik_synced = 0 AND is_active = 1
      LIMIT 20
    `).all().filter((b) => !isInFlight(_inFlightSync.bindings, b.id));

    if (unsyncedBindings.length > 0) {
      const lines = [];
      unsyncedBindings.forEach((b) => {
        const cleanMac = normalizeMac(b.mac_address);
        if (!REGEX_MAC.test(cleanMac)) return;
        const cleanType = ['bypassed', 'blocked', 'regular'].includes(b.type) ? b.type : 'bypassed';
        const cleanAddr = (b.address && REGEX_IPV4.test(String(b.address).trim())) ? String(b.address).trim() : '';
        const addrClause = cleanAddr ? ` address="${cleanAddr}"` : '';
        const commClean = sanitizeRouterOsStr(b.comment, 'Royota Cloud', 64);

        lines.push(`:do { add mac-address="${cleanMac}" type=${cleanType}${addrClause} comment="${commClean}" server=all } on-error={ :do { set [find mac-address="${cleanMac}"] type=${cleanType}${addrClause} comment="${commClean}" } on-error={} }`);
        ackBindings.push(b.id);
        markInFlight(_inFlightSync.bindings, b.id);
      });
      if (lines.length) {
        rscCommands += '\n/ip hotspot ip-binding\n' + lines.join('\n') + '\n';
      }
    }
  } catch (bErr) {
    console.error('[Cloud-Sync] Error procesando IP Bindings:', bErr.message);
  }

  // 5. Eliminaciones pendientes (MAC validada estrictamente contra REGEX_MAC)
  try {
    const removals = db.prepare('SELECT id, mac_address FROM pending_removals LIMIT 20')
      .all()
      .filter((r) => !isInFlight(_inFlightSync.removals, r.id));

    if (removals.length > 0) {
      const lines = [];
      removals.forEach((r) => {
        const cleanMac = normalizeMac(r.mac_address);
        if (!REGEX_MAC.test(cleanMac)) return;
        lines.push(`:do { remove [find mac-address="${cleanMac}"] } on-error={}`);
        ackRemovals.push(r.id);
        markInFlight(_inFlightSync.removals, r.id);
      });
      if (lines.length) {
        rscCommands += '\n/ip hotspot ip-binding\n' + lines.join('\n') + '\n';
      }
    }
  } catch (rErr) {
    console.error('[Cloud-Sync] Error procesando eliminaciones pendientes:', rErr.message);
  }

  // 6. Enviar ACK al final solo si el router aplicó los comandos
  if (ackVouchers.length || ackBindings.length || ackRemovals.length) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://royota-bot.onrender.com';
    const ackUrl = `${baseUrl}/api/mikrotik/sync/ack?token=${config.mikrotik.syncToken}&v=${ackVouchers.join(',')}&b=${ackBindings.join(',')}&r=${ackRemovals.join(',')}`;
    rscCommands += `\n:do { /tool fetch url="${ackUrl}" check-certificate=no output=none } on-error={}\n`;
  }

  res.setHeader('Content-Type', 'text/plain');
  if (!rscCommands.trim()) {
    return res.send('# Royota Cloud: No pending vouchers\n');
  }

  res.send(rscCommands);
});

module.exports = router;
