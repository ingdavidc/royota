/**
 * src/routes/mikrotik.js — Estado y diagnóstico del router
 */
'use strict';

const { Router } = require('express');
const { authRequired } = require('../middleware/auth');
const mikrotik = require('../services/mikrotik-api');
const { getDb } = require('../database');

const router = Router();

// Estado de telemetría reportado por el router físico en la nube
let _routerTelemetry = {
  lastSeen: null,
  version: null,
  uptime: null,
  cpuLoad: null,
  freeMemory: null,
  totalMemory: null,
  ip: null,
};

let _profilesNeedSync = true;

// Sincronización de telemetría hacia Cloud Firestore (para monitoreo sin restricciones de red)
let _lastFirestoreSync = 0;
async function syncTelemetryToFirestore(telem) {
  const now = Date.now();
  if (now - _lastFirestoreSync < 20000) return; // máximo cada 20s
  _lastFirestoreSync = now;

  try {
    const body = {
      fields: {
        status: { stringValue: 'online' },
        version: { stringValue: telem.version ? `${telem.version} (Enlace Nube Activo)` : 'RouterOS v7.25.1 (Enlace Nube Activo)' },
        uptime: { stringValue: telem.uptime || 'Activo' },
        cpuLoad: { integerValue: String(telem.cpuLoad !== null && telem.cpuLoad !== undefined ? telem.cpuLoad : 3) },
        freeMemory: { integerValue: String(telem.freeMemory || 524288000) },
        totalMemory: { integerValue: String(telem.totalMemory || 1073741824) },
        syncMode: { stringValue: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)' },
        lastSeen: { stringValue: telem.lastSeen || new Date().toISOString() }
      }
    };

    await fetch('https://firestore.googleapis.com/v1/projects/fichas-royota/databases/(default)/documents/telemetry/mikrotik', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.warn('[Telemetry-Firestore] Error al sincronizar a Firestore:', err.message);
  }
}

// GET /api/mikrotik/test — Prueba de conectividad completa (Monitoreo para el panel)
router.get('/test', async (req, res) => {
  const now = Date.now();
  const lastSeenMs = _routerTelemetry.lastSeen ? new Date(_routerTelemetry.lastSeen).getTime() : 0;
  const isRouterAlive = (now - lastSeenMs) < 60000;

  if (isRouterAlive) {
    return res.json({
      ok: true,
      routerboard: true,
      version: _routerTelemetry.version + ' (Enlace Nube Activo)',
      uptime: _routerTelemetry.uptime || 'Activo',
      cpuLoad: _routerTelemetry.cpuLoad !== null ? _routerTelemetry.cpuLoad : 2,
      freeMemory: _routerTelemetry.freeMemory || 524288000,
      totalMemory: _routerTelemetry.totalMemory || 1073741824,
      syncMode: 'Cloud Sync Autónomo 24/7 (ONT / MikroTik)',
      lastSeen: _routerTelemetry.lastSeen,
    });
  }

  // Fallback a test REST si no hay telemetría reciente
  const result = await mikrotik.testConnection();
  res.status(result.ok ? 200 : 502).json(result);
});

// GET /api/mikrotik/profiles — Listar perfiles Hotspot del router
router.get('/profiles', authRequired, async (req, res) => {
  try {
    const profiles = await mikrotik.listProfiles();
    res.json(Array.isArray(profiles) ? profiles : []);
  } catch (err) {
    res.status(502).json({ error: `Error al consultar perfiles: ${err.message}` });
  }
});

// GET /api/mikrotik/users — Usuarios Hotspot en el router
router.get('/users', authRequired, async (req, res) => {
  try {
    res.json(await mikrotik.listHotspotUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar usuarios: ${err.message}` });
  }
});

// GET /api/mikrotik/active — Sesiones activas ahora
router.get('/active', async (req, res) => {
  try {
    res.json(await mikrotik.listActiveUsers());
  } catch (err) {
    res.status(502).json({ error: `Error al consultar sesiones: ${err.message}` });
  }
});

// GET /api/mikrotik/sync-log?limit=100 — Log de sincronización
router.get('/sync-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const logs  = getDb().prepare(`
    SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  res.json(logs);
});

// Token de seguridad compartido para autenticación autónoma del router MikroTik
const SYNC_SECRET = process.env.MIKROTIK_SYNC_TOKEN || 'RoyotaCloud_SyncToken_2026_SecureKey';

// Expresiones regulares estrictas de validación (Prevención de Inyección de Comandos RouterOS)
const REGEX_CODE     = /^[A-Z0-9]{4,16}$/;
const REGEX_PROFILE  = /^[A-Za-z0-9 _-]{1,32}$/;
const REGEX_DURATION = /^\d+[mhd]$/;
const REGEX_MAC      = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;

// ── IP BINDINGS (Dispositivos Exentos: Smart TVs, Cámaras, etc.) ────
// GET /api/mikrotik/bindings — Listar IP Bindings
router.get('/bindings', async (req, res) => {
  try {
    const db = getDb();
    const local = db.prepare('SELECT * FROM ip_bindings ORDER BY created_at DESC').all();
    res.json(local);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mikrotik/bindings — Guardar IP Binding
router.post('/bindings', async (req, res) => {
  const { mac_address, comment, type, address } = req.body;
  if (!mac_address) return res.status(400).json({ error: 'Dirección MAC es requerida' });
  const cleanMac = String(mac_address).trim().toUpperCase();
  if (!REGEX_MAC.test(cleanMac)) {
    return res.status(400).json({ error: 'Formato de MAC inválido (AA:BB:CC:DD:EE:FF)' });
  }
  const cleanComment = String(comment || 'Dispositivo Exento').slice(0, 80);
  const cleanType = ['bypassed', 'blocked', 'regular'].includes(type) ? type : 'bypassed';
  const cleanAddress = address ? String(address).trim() : '';

  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO ip_bindings (mac_address, comment, type, address, server, is_active, mikrotik_synced, created_at)
      VALUES (?, ?, ?, ?, 'all', 1, 0, datetime('now'))
      ON CONFLICT(mac_address) DO UPDATE SET
        comment = excluded.comment,
        type = excluded.type,
        address = excluded.address,
        is_active = 1,
        mikrotik_synced = 0
    `);
    stmt.run(cleanMac, cleanComment, cleanType, cleanAddress);

    try {
      await mikrotik.createIpBinding(cleanMac, cleanComment, cleanType, cleanAddress);
      db.prepare('UPDATE ip_bindings SET mikrotik_synced = 1 WHERE mac_address = ?').run(cleanMac);
    } catch (_) {}

    res.json({ ok: true, mac: cleanMac, comment: cleanComment, type: cleanType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mikrotik/bindings/:mac — Eliminar IP Binding
router.delete('/bindings/:mac', async (req, res) => {
  const cleanMac = decodeURIComponent(req.params.mac).trim().toUpperCase();
  const db = getDb();
  try {
    db.prepare('DELETE FROM ip_bindings WHERE mac_address = ? COLLATE NOCASE').run(cleanMac);
    db.prepare('INSERT INTO pending_removals (mac_address) VALUES (?)').run(cleanMac);
    try { await mikrotik.removeIpBinding(cleanMac); } catch (_) {}
    res.json({ ok: true, removed: cleanMac });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mikrotik/sync/push-binding — Inyección directa de IP Binding hacia MikroTik
router.post('/sync/push-binding', (req, res) => {
  const { mac_address, comment, type, address } = req.body;
  if (!mac_address) return res.status(400).json({ error: 'MAC requerida' });
  const cleanMac = String(mac_address).trim().toUpperCase();
  if (!REGEX_MAC.test(cleanMac)) {
    return res.status(400).json({ error: 'MAC inválida' });
  }
  const cleanComment = String(comment || 'Dispositivo Exento').slice(0, 80);
  const cleanType = ['bypassed', 'blocked', 'regular'].includes(type) ? type : 'bypassed';
  const cleanAddress = address ? String(address).trim() : '';

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
    console.log(`[Cloud-Sync] 📺 IP Binding ${cleanMac} (${cleanComment}) encolado para MikroTik.`);
  } catch (err) {
    console.error('[Cloud-Sync] Error en push-binding:', err.message);
  }
  res.json({ ok: true, mac: cleanMac });
});

// GET /api/mikrotik/sync/binding-beacon — Beacon anti-CSP para registrar IP Bindings
router.get('/sync/binding-beacon', (req, res) => {
  const { mac, comment, type, address } = req.query;
  if (mac) {
    const cleanMac = String(mac).trim().toUpperCase();
    if (REGEX_MAC.test(cleanMac)) {
      const cleanComment = String(comment || 'Dispositivo Exento').slice(0, 80);
      const cleanType = ['bypassed', 'blocked', 'regular'].includes(type) ? type : 'bypassed';
      const cleanAddress = address ? String(address).trim() : '';
      try {
        const db = getDb();
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
        console.log(`[Cloud-Sync] 📺 IP Binding ${cleanMac} (${cleanComment}) vía beacon.`);
      } catch (_) {}
    }
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(PIXEL_GIF);
});

// GET /api/mikrotik/sync/remove-binding-beacon — Beacon para eliminar IP Binding en MikroTik
router.get('/sync/remove-binding-beacon', (req, res) => {
  const mac = req.query.mac;
  if (mac) {
    const cleanMac = String(mac).trim().toUpperCase();
    try {
      const db = getDb();
      db.prepare('DELETE FROM ip_bindings WHERE mac_address = ? COLLATE NOCASE').run(cleanMac);
      db.prepare('INSERT INTO pending_removals (mac_address) VALUES (?)').run(cleanMac);
      console.log(`[Cloud-Sync] 🗑️ IP Binding ${cleanMac} encolado para remoción en MikroTik.`);
    } catch (_) {}
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(PIXEL_GIF);
});

// 1x1 GIF transparente para respuesta de beacon
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /api/mikrotik/sync/beacon — Beacon de sincronización inmune a bloqueos CSP (img-src https:)
router.get('/sync/beacon', (req, res) => {
  const codesParam = req.query.codes || req.query.c;
  if (!codesParam) {
    res.setHeader('Content-Type', 'image/gif');
    return res.end(PIXEL_GIF);
  }

  const rawCodes = String(codesParam).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const planName = req.query.plan || '1 Hora Basico';
  const planDur  = req.query.dur  || '1h';
  const planSpd  = req.query.spd  || '5M/2M';
  const planPrc  = parseInt(req.query.prc, 10) || 2000;

  const db = getDb();
  let insertCount = 0;

  try {
    let planRow = db.prepare('SELECT id, duration, profile_name FROM plans WHERE name = ? COLLATE NOCASE').get(planName);
    if (!planRow) {
      const info = db.prepare(`
        INSERT INTO plans (name, duration, speed_limit, price, profile_name)
        VALUES (?, ?, ?, ?, ?)
      `).run(planName, planDur, planSpd, planPrc, planName);
      planRow = { id: info.lastInsertRowid, duration: planDur, profile_name: planName };
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO vouchers (code, plan_id, status, mikrotik_synced, created_at)
      VALUES (?, ?, 'available', 0, datetime('now'))
    `);

    const transaction = db.transaction((codes) => {
      for (const code of codes) {
        if (REGEX_CODE.test(code)) {
          insertStmt.run(code, planRow.id);
          insertCount++;
        }
      }
    });

    transaction(rawCodes);
    console.log(`[Cloud-Sync Beacon] 📡 ${insertCount} fichas encoladas mediante beacon de alta disponibilidad.`);
  } catch (err) {
    console.error('[Cloud-Sync Beacon] Error persistiendo lote:', err.message);
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.end(PIXEL_GIF);
});

// POST /api/mikrotik/sync/push-batch — Llamado al generar fichas (Persistente y Sanitizado)
router.post('/sync/push-batch', (req, res) => {
  const { vouchers, plan } = req.body;
  if (!Array.isArray(vouchers) || !vouchers.length) {
    return res.status(400).json({ error: 'Lista de fichas requerida' });
  }

  const rawProfile = (plan && plan.name) ? String(plan.name).trim() : '1 Hora Basico';
  const rawDuration = (plan && plan.duration) ? String(plan.duration).trim() : '1h';

  const profileName = REGEX_PROFILE.test(rawProfile) ? rawProfile : '1 Hora Basico';
  const duration    = REGEX_DURATION.test(rawDuration) ? rawDuration : '1h';

  const db = getDb();
  let insertCount = 0;

  try {
    // Resolver o registrar el plan en SQLite si es necesario
    let planRow = null;
    if (plan && plan.name) {
      planRow = db.prepare('SELECT id, duration, profile_name FROM plans WHERE name = ? COLLATE NOCASE').get(plan.name);
      if (!planRow) {
        const prof = (plan.profile_name || plan.name || '1 Hora Basico');
        const dur  = (plan.duration || '1h');
        const spd  = (plan.speed_limit || '5M/2M');
        const prc  = (plan.price || 2000);
        const info = db.prepare(`
          INSERT INTO plans (name, duration, speed_limit, price, profile_name)
          VALUES (?, ?, ?, ?, ?)
        `).run(plan.name, dur, spd, prc, prof);
        planRow = { id: info.lastInsertRowid, duration: dur, profile_name: prof };
      }
    }
    const resolvedPlanId = planRow ? planRow.id : 1;

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
    console.log(`[Cloud-Sync] 💾 ${insertCount} fichas persistidas en base de datos para sincronización.`);
  } catch (err) {
    console.error('[Cloud-Sync] Error persistiendo lote en SQLite:', err.message);
  }

  res.json({ ok: true, queued: insertCount });
});

// GET /api/mikrotik/sync/plan-beacon — Recibe altas/cambios de planes anti-CSP
router.get('/sync/plan-beacon', (req, res) => {
  const { name, duration, speed, price, shared, is_active } = req.query;
  if (!name) return res.status(400).send('Name required');
  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM plans WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) {
      db.prepare(`
        UPDATE plans SET
          duration = ?, speed_limit = ?, price = ?, shared_users = ?, is_active = ?, profile_name = ?
        WHERE id = ?
      `).run(duration || '1h', speed || '5M/5M', parseFloat(price) || 0, parseInt(shared, 10) || 1, is_active === '0' ? 0 : 1, name, existing.id);
    } else {
      db.prepare(`
        INSERT INTO plans (name, duration, speed_limit, price, shared_users, is_active, profile_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, duration || '1h', speed || '5M/5M', parseFloat(price) || 0, parseInt(shared, 10) || 1, 1, name);
    }
    _profilesNeedSync = true;
    console.log(`[Plan-Sync] 📋 Plan '${name}' registrado/actualizado para sincronización en router.`);
  } catch (err) {
    console.error('[Plan-Beacon] Error:', err.message);
  }

  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(pixel);
});

// GET /api/mikrotik/sync/clear-all — Vaciar cola de sincronización (Reset de pruebas)
router.get('/sync/clear-all', (req, res) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== SYNC_SECRET) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const db = getDb();
  try {
    db.prepare('DELETE FROM vouchers').run();
    db.prepare('DELETE FROM voucher_batches').run();
    console.log('[MikroTik-Sync] 🗑️ Todas las fichas en cola de sincronización fueron eliminadas.');
    res.json({ ok: true, cleared: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mikrotik/sync/vouchers.rsc — Descargado autónomamente por el MikroTik (Autenticado por Token)
router.get('/sync/vouchers.rsc', (req, res) => {
  const token = req.query.token || req.headers['x-sync-token'];
  if (token !== SYNC_SECRET) {
    return res.status(403).send('# Error: Acceso no autorizado a la cola de aprovisionamiento\n');
  }

  // 1. Capturar telemetría enviada por el script del MikroTik
  const version = req.query.version || req.query.v;
  const uptime = req.query.uptime || req.query.u;
  const cpu = req.query.cpu || req.query.c;
  const mem = req.query.mem || req.query.m;

  _routerTelemetry = {
    lastSeen: new Date().toISOString(),
    version: version ? `RouterOS ${version}` : (_routerTelemetry.version || 'RouterOS v7.25.1'),
    uptime: uptime ? String(uptime).trim() : (_routerTelemetry.uptime || 'Activo'),
    cpuLoad: cpu !== undefined ? parseInt(cpu, 10) : (_routerTelemetry.cpuLoad || 3),
    freeMemory: mem !== undefined ? parseInt(mem, 10) : (_routerTelemetry.freeMemory || 524288000),
    totalMemory: 1073741824,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
  };

  // Sincronizar telemetría hacia Firestore en segundo plano
  syncTelemetryToFirestore(_routerTelemetry);

  const db = getDb();
  let rscCommands = '';

  // 2. Sincronizar perfiles de usuario correspondientes a los planes
  if (_profilesNeedSync) {
    try {
      const activePlans = db.prepare('SELECT * FROM plans WHERE is_active = 1').all();
      if (activePlans.length > 0) {
        rscCommands += '/ip hotspot user profile\n';
        activePlans.forEach(p => {
          const cleanName = String(p.name).trim();
          const speed = p.speed_limit || '5M/5M';
          const shared = p.shared_users || 1;
          rscCommands += `:if ([:len [find name="${cleanName}"]] = 0) do={ add name="${cleanName}" rate-limit="${speed}" shared-users=${shared} keepalive-timeout=2m status-autorefresh=1m transparent-proxy=no } else={ set [find name="${cleanName}"] rate-limit="${speed}" shared-users=${shared} }\n`;
        });
      }
      _profilesNeedSync = false;
    } catch (pErr) {
      console.error('[Cloud-Sync] Error generando perfiles RSC:', pErr.message);
    }
  }

  // 3. Extraer fichas pendientes en base de datos (Persistente ante reinicios del contenedor)
  try {
    const unsynced = db.prepare(`
      SELECT v.id, v.code, p.name AS plan_name, p.profile_name, p.duration, p.speed_limit
      FROM vouchers v
      LEFT JOIN plans p ON v.plan_id = p.id
      WHERE v.mikrotik_synced = 0
      ORDER BY v.id ASC
      LIMIT 100
    `).all();

    if (unsynced.length > 0) {
      rscCommands += '\n/ip hotspot user\n';
      const idsToMark = [];
      unsynced.forEach(v => {
        const clean = String(v.code).trim().toUpperCase();
        if (REGEX_CODE.test(clean)) {
          const prof = (v.profile_name && REGEX_PROFILE.test(v.profile_name) && v.profile_name !== 'default')
            ? v.profile_name
            : ((v.plan_name && REGEX_PROFILE.test(v.plan_name)) ? v.plan_name : '1 Hora Basico');
          const dur  = (v.duration && REGEX_DURATION.test(v.duration)) ? v.duration : '1h';
          rscCommands += `:do { add name="${clean}" password="${clean}" profile="${prof}" limit-uptime="${dur}" comment="Royota Cloud" } on-error={ :do { add name="${clean}" password="${clean}" profile="default" limit-uptime="${dur}" comment="Royota Cloud" } on-error={} }\n`;
          idsToMark.push(v.id);
        }
      });

      if (idsToMark.length > 0) {
        const placeholders = idsToMark.map(() => '?').join(',');
        db.prepare(`UPDATE vouchers SET mikrotik_synced = 1 WHERE id IN (${placeholders})`).run(...idsToMark);
        console.log(`[Cloud-Sync] 📡 Entregadas ${idsToMark.length} fichas autenticadas al MikroTik (${_routerTelemetry.ip}).`);
      }
    }
  } catch (err) {
    console.error('[Cloud-Sync] Error procesando fichas pendientes:', err.message);
  }

  // 4. Extraer IP Bindings pendientes para inyección al MikroTik
  try {
    const unsyncedBindings = db.prepare(`
      SELECT id, mac_address, comment, type, address
      FROM ip_bindings
      WHERE mikrotik_synced = 0 AND is_active = 1
      LIMIT 20
    `).all();

    if (unsyncedBindings.length > 0) {
      rscCommands += '\n/ip hotspot ip-binding\n';
      const bIds = [];
      unsyncedBindings.forEach(b => {
        const addrClause = b.address ? ` address="${b.address}"` : '';
        const commClean = b.comment ? b.comment.replace(/"/g, '') : 'Royota Cloud';
        rscCommands += `:do { add mac-address="${b.mac_address}" type=${b.type}${addrClause} comment="${commClean}" server=all } on-error={ :do { set [find mac-address="${b.mac_address}"] type=${b.type}${addrClause} comment="${commClean}" } on-error={} }\n`;
        bIds.push(b.id);
      });
      if (bIds.length > 0) {
        const placeholders = bIds.map(() => '?').join(',');
        db.prepare(`UPDATE ip_bindings SET mikrotik_synced = 1 WHERE id IN (${placeholders})`).run(...bIds);
        console.log(`[Cloud-Sync] 📺 Entregados ${bIds.length} IP Bindings autenticados al MikroTik.`);
      }
    }
  } catch (bErr) {
    console.error('[Cloud-Sync] Error procesando IP Bindings pendientes:', bErr.message);
  }

  // 5. Extraer eliminaciones pendientes de IP Bindings para remoción en el MikroTik
  try {
    const removals = db.prepare('SELECT id, mac_address FROM pending_removals LIMIT 20').all();
    if (removals.length > 0) {
      rscCommands += '\n/ip hotspot ip-binding\n';
      const rIds = [];
      removals.forEach(r => {
        rscCommands += `:do { remove [find mac-address="${r.mac_address}"] } on-error={}\n`;
        rIds.push(r.id);
      });
      if (rIds.length > 0) {
        const ph = rIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM pending_removals WHERE id IN (${ph})`).run(...rIds);
        console.log(`[Cloud-Sync] 🗑️ Entregadas ${rIds.length} eliminaciones de IP Binding al MikroTik.`);
      }
    }
  } catch (rErr) {
    console.error('[Cloud-Sync] Error procesando eliminaciones pendientes:', rErr.message);
  }

  res.setHeader('Content-Type', 'text/plain');
  if (!rscCommands.trim()) {
    return res.send('# Royota Cloud: No pending vouchers\n');
  }

  res.send(rscCommands);
});

module.exports = router;
