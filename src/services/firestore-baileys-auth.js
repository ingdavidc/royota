'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { hasServiceAccount, firestoreFetch, toFirestoreFields, decodeFirestoreValue } = require('./firestore-client');

const LEGACY_COLLECTION = 'baileys_auth';
const BUNDLE_COLLECTION = 'baileys_auth_bundle';
const BUNDLE_CHUNK_CHARS = 650000;
const DEBOUNCE_GENERAL_MS = 10000;
const DEBOUNCE_CREDS_MS = 1500;

let _lastAuthDir = null;
let _debounceTimer = null;
let _syncPromise = null;
let _pendingResync = false;

function isSafeAuthFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
  if (!filename.endsWith('.json')) return false;
  return /^[a-zA-Z0-9._-]{1,180}\.json$/.test(filename);
}

function safeResolveInDir(dir, filename) {
  if (!isSafeAuthFilename(filename)) return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, filename);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

function decodeDocFields(doc) {
  const out = {};
  if (doc && doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) {
      out[k] = decodeFirestoreValue(v);
    }
  }
  return out;
}

async function getBundleDoc(docId) {
  const res = await firestoreFetch(`/${BUNDLE_COLLECTION}/${encodeURIComponent(docId)}`, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Bundle GET ${docId} HTTP ${res.status}: ${msg.slice(0, 120)}`);
  }
  return decodeDocFields(await res.json());
}

async function setBundleDoc(docId, dataObj) {
  const res = await firestoreFetch(`/${BUNDLE_COLLECTION}/${encodeURIComponent(docId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: toFirestoreFields(dataObj) }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Bundle PATCH ${docId} HTTP ${res.status}: ${msg.slice(0, 120)}`);
  }
}

async function deleteBundleDoc(docId) {
  const res = await firestoreFetch(`/${BUNDLE_COLLECTION}/${encodeURIComponent(docId)}`, { method: 'DELETE' });
  return res.ok || res.status === 404;
}

/**
 * Restores Baileys auth files from the compact gzip bundle (1-2 Firestore reads).
 * Falls back once to legacy per-file `/baileys_auth` collection and auto-migrates to bundle.
 */
async function restoreBaileysAuthFromFirestore(authDir) {
  _lastAuthDir = authDir;
  fs.mkdirSync(authDir, { recursive: true });

  if (!hasServiceAccount()) {
    return fs.existsSync(path.join(authDir, 'creds.json'));
  }

  try {
    const meta = await getBundleDoc('meta');
    if (meta && Number(meta.chunk_count) > 0) {
      const chunkCount = Number(meta.chunk_count);
      const chunks = await Promise.all(
        Array.from({ length: chunkCount }, (_, i) => getBundleDoc(`chunk_${i}`))
      );

      if (chunks.every((c) => c && typeof c.data === 'string')) {
        const b64 = chunks.map((c) => c.data).join('');
        const jsonStr = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
        const parsed = JSON.parse(jsonStr);
        const files = parsed && parsed.files ? parsed.files : {};
        let restored = 0;

        for (const [filename, content] of Object.entries(files)) {
          const full = safeResolveInDir(authDir, filename);
          if (!full || typeof content !== 'string') continue;
          fs.writeFileSync(full, content, 'utf8');
          restored++;
        }

        console.log(`[BaileysAuth] Restaurados ${restored} archivos desde bundle (${chunkCount} chunks).`);
        return fs.existsSync(path.join(authDir, 'creds.json'));
      }
    }
  } catch (err) {
    console.error('[BaileysAuth] Error leyendo bundle:', err.message);
  }

  // Fallback one-time migration from legacy individual docs
  try {
    let pageToken = '';
    let restored = 0;
    do {
      const qs = `?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await firestoreFetch(`/${LEGACY_COLLECTION}${qs}`, { method: 'GET' });
      if (!res.ok) break;
      const data = await res.json();
      for (const doc of data.documents || []) {
        const filename = doc.name.split('/').pop();
        const fields = decodeDocFields(doc);
        const full = safeResolveInDir(authDir, filename);
        if (!full || typeof fields.content !== 'string') continue;
        fs.writeFileSync(full, fields.content, 'utf8');
        restored++;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    if (restored > 0) {
      console.log(`[BaileysAuth] Migrados ${restored} archivos legacy a bundle compacto...`);
      await syncAllAuthFilesToFirestore(authDir).catch(() => {});
    }
    return fs.existsSync(path.join(authDir, 'creds.json'));
  } catch (err) {
    console.error('[BaileysAuth] Error en migración legacy:', err.message);
    return fs.existsSync(path.join(authDir, 'creds.json'));
  }
}

async function performBundleSync(authDir) {
  if (!hasServiceAccount() || !authDir || !fs.existsSync(authDir)) return 0;

  const entries = fs.readdirSync(authDir);
  const filesMap = {};
  let fileCount = 0;

  for (const name of entries) {
    const full = safeResolveInDir(authDir, name);
    if (!full) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      filesMap[name] = fs.readFileSync(full, 'utf8');
      fileCount++;
    } catch (_) { /* ignore transient file race */ }
  }

  if (fileCount === 0) return 0;

  const prevMeta = await getBundleDoc('meta').catch(() => null);
  const prevChunks = Number(prevMeta?.chunk_count || 0);

  const payload = JSON.stringify({ v: 1, files: filesMap });
  const compressedB64 = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 6 }).toString('base64');

  const chunks = [];
  for (let i = 0; i < compressedB64.length; i += BUNDLE_CHUNK_CHARS) {
    chunks.push(compressedB64.slice(i, i + BUNDLE_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');

  await Promise.all(
    chunks.map((data, idx) =>
      setBundleDoc(`chunk_${idx}`, {
        idx,
        data,
        updated_at: new Date().toISOString(),
      })
    )
  );

  await setBundleDoc('meta', {
    chunk_count: chunks.length,
    total_files: fileCount,
    compression: 'gzip-base64',
    bytes_b64: compressedB64.length,
    updated_at: new Date().toISOString(),
  });

  if (prevChunks > chunks.length) {
    for (let i = chunks.length; i < prevChunks; i++) {
      await deleteBundleDoc(`chunk_${i}`).catch(() => {});
    }
  }

  return fileCount;
}

/**
 * Persists all current Baileys auth files as a single gzip-compressed bundle.
 * Coalesces concurrent sync calls safely.
 */
async function syncAllAuthFilesToFirestore(authDir = _lastAuthDir) {
  if (!authDir) return 0;
  _lastAuthDir = authDir;

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  if (_syncPromise) {
    _pendingResync = true;
    return _syncPromise;
  }

  _syncPromise = (async () => {
    let count = 0;
    try {
      count = await performBundleSync(authDir);
      while (_pendingResync) {
        _pendingResync = false;
        count = await performBundleSync(authDir);
      }
    } finally {
      _syncPromise = null;
    }
    return count;
  })();

  return _syncPromise;
}

/**
 * Schedules a debounced bundle write instead of writing per-file docs to Firestore.
 */
async function saveFileToFirestore(authDir, filename) {
  if (!hasServiceAccount()) return;
  if (!isSafeAuthFilename(filename)) return;
  _lastAuthDir = authDir;

  const delayMs = filename === 'creds.json' ? DEBOUNCE_CREDS_MS : DEBOUNCE_GENERAL_MS;
  if (_debounceTimer) {
    if (filename !== 'creds.json') return;
    clearTimeout(_debounceTimer);
  }

  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    syncAllAuthFilesToFirestore(authDir).catch((err) => {
      console.error('[BaileysAuth] Debounced sync error:', err.message);
    });
  }, delayMs);
}

async function clearAllBaileysAuth(authDir = _lastAuthDir) {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  if (authDir && fs.existsSync(authDir)) {
    for (const f of fs.readdirSync(authDir)) {
      const full = safeResolveInDir(authDir, f);
      if (full) fs.rmSync(full, { force: true });
    }
  }

  if (!hasServiceAccount()) return;

  try {
    const meta = await getBundleDoc('meta');
    const n = Number(meta?.chunk_count || 0);
    for (let i = 0; i < n; i++) {
      await deleteBundleDoc(`chunk_${i}`).catch(() => {});
    }
    await deleteBundleDoc('meta').catch(() => {});
  } catch (_) { /* ignore */ }

  // Also clear any legacy individual docs in bounded batches
  try {
    let pageToken = '';
    do {
      const qs = `?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await firestoreFetch(`/${LEGACY_COLLECTION}${qs}`, { method: 'GET' });
      if (!res.ok) break;
      const data = await res.json();
      const docs = data.documents || [];
      await Promise.allSettled(
        docs.map((d) => firestoreFetch(`/${LEGACY_COLLECTION}/${encodeURIComponent(d.name.split('/').pop())}`, { method: 'DELETE' }))
      );
      pageToken = docs.length > 0 && data.nextPageToken ? data.nextPageToken : '';
    } while (pageToken);
  } catch (err) {
    console.error('[BaileysAuth] Error limpiando legacy docs:', err.message);
  }
}

module.exports = {
  restoreBaileysAuthFromFirestore,
  saveFileToFirestore,
  syncAllAuthFilesToFirestore,
  clearAllBaileysAuth,
  isSafeAuthFilename,
};
