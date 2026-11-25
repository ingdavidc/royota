'use strict';
const config = require('./config');
const http   = require('http');
const https  = require('https');
const { getMatchingLocalIp } = require('./utils/helpers');

const { host, port, user, pass, useSsl, verifySsl, syncToken } = config.mikrotik;
if (!pass) {
  console.error('Falta MIKROTIK_PASS en .env');
  process.exit(1);
}
if (!syncToken) {
  console.error('Falta MIKROTIK_SYNC_TOKEN en .env');
  process.exit(1);
}

const auth = Buffer.from(`${user}:${pass}`).toString('base64');
const localIp = getMatchingLocalIp(host);
const proto = useSsl ? https : http;

async function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const r = proto.request({
      hostname: host,
      port,
      path: '/rest' + path,
      method,
      rejectUnauthorized: verifySsl,
      ...(localIp ? { localAddress: localIp } : {}),
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

(async () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://royota-bot.onrender.com';
  const scriptSource = `:do {
  :local cpu [/system resource get cpu-load]
  :local up [/system resource get uptime]
  :local ver [/system resource get version]
  :local mem [/system resource get free-memory]
  /tool fetch url="${baseUrl}/api/mikrotik/sync/vouchers.rsc?token=${syncToken}&cpu=$cpu&uptime=$up&version=$ver&mem=$mem" dst-path="sync.rsc" check-certificate=yes
  :delay 1s
  :if ([/file find name="sync.rsc"] != "") do={
    /import file-name="sync.rsc"
    /file remove "sync.rsc"
    :log info "MikroTik Cloud: Sincronizacion de fichas completada"
  }
} on-error={}`;

  const existingScripts = await req('GET', '/system/script');
  const found = existingScripts.data.find((s) => s.name === 'sync-cloud-vouchers');
  if (found) {
    await req('PATCH', '/system/script/' + found['.id'], {
      source: scriptSource,
      policy: 'read,write,test',
    });
    console.log('Script updated');
  } else {
    await req('PUT', '/system/script', {
      name: 'sync-cloud-vouchers',
      source: scriptSource,
      policy: 'read,write,test',
    });
    console.log('Script created');
  }

  const existingScheds = await req('GET', '/system/scheduler');
  const sFound = existingScheds.data.find((s) => s.name === 'cloud-sync-scheduler');
  if (sFound) {
    await req('PATCH', '/system/scheduler/' + sFound['.id'], {
      interval: '15s',
      'on-event': 'sync-cloud-vouchers',
    });
    console.log('Scheduler updated');
  } else {
    await req('PUT', '/system/scheduler', {
      name: 'cloud-sync-scheduler',
      interval: '15s',
      'on-event': 'sync-cloud-vouchers',
      'start-time': 'startup',
    });
    console.log('Scheduler created');
  }
})();
