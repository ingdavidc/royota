const config = require('./config');
const http = require('http');
const os = require('os');

function getMatchingLocalIp(targetHost) {
  try {
    const interfaces = os.networkInterfaces();
    const parts = targetHost.split('.');
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

const { host, port, user, pass } = config.mikrotik;
const auth = Buffer.from(user + ':' + pass).toString('base64');
const localIp = getMatchingLocalIp(host);

async function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: host,
      port,
      path: '/rest' + path,
      method,
      localAddress: localIp,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
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
  // 1. Script de descarga e importación autónomo
  const scriptSource = `:do {
  /tool fetch url="https://royota-bot.onrender.com/api/mikrotik/sync/vouchers.rsc" dst-path="sync.rsc" check-certificate=no
  :delay 1s
  :if ([/file find name="sync.rsc"] != "") do={
    /import file-name="sync.rsc"
    /file remove "sync.rsc"
    :log info "MikroTik Cloud: Sincronizacion de fichas completada"
  }
} on-error={}`;

  // Check if exists
  const existingScripts = await req('GET', '/system/script');
  const found = existingScripts.data.find(s => s.name === 'sync-cloud-vouchers');
  if (found) {
    await req('PATCH', '/system/script/' + found['.id'], { source: scriptSource });
    console.log('Script updated');
  } else {
    await req('PUT', '/system/script', {
      name: 'sync-cloud-vouchers',
      source: scriptSource,
      policy: 'ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon'
    });
    console.log('Script created');
  }

  // 2. Scheduler cada 20 segundos
  const existingScheds = await req('GET', '/system/scheduler');
  const sFound = existingScheds.data.find(s => s.name === 'cloud-sync-scheduler');
  if (sFound) {
    await req('PATCH', '/system/scheduler/' + sFound['.id'], {
      interval: '20s',
      'on-event': 'sync-cloud-vouchers'
    });
    console.log('Scheduler updated');
  } else {
    await req('PUT', '/system/scheduler', {
      name: 'cloud-sync-scheduler',
      interval: '20s',
      'on-event': 'sync-cloud-vouchers',
      'start-time': 'startup'
    });
    console.log('Scheduler created');
  }
})();
