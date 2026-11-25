/**
 * src/services/firestore-baileys-auth.js
 * ─────────────────────────────────────────────────────────────
 * Capa de Persistencia Autenticada en Firestore para Baileys WhatsApp.
 * Incluye sanitización estricta contra Path Traversal y paginación.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { firestoreFetch, toFirestoreFields } = require('./firestore-client');

const AUTH_COLLECTION = 'baileys_auth';
const SAFE_AUTH_FILE_RE = /^[A-Za-z0-9._-]+\.json$/;
const _syncedHashes = new Map();

/**
 * Valida que el ID de documento sea un nombre de archivo seguro dentro de authDir.
 */
function resolveSafeAuthPath(authDir, rawFilename) {
  const filename = String(rawFilename || '');
  const base = path.basename(filename);
  if (filename !== base || !SAFE_AUTH_FILE_RE.test(base) || base === '.' || base === '..') {
    return null;
  }
  const root = path.resolve(authDir);
  const full = path.resolve(root, base);
  if (!full.startsWith(root + path.sep)) {
    return null;
  }
  return { filename: base, fullPath: full };
}

/**
 * Restaura todos los archivos de autenticación desde Firestore (con paginación completa).
 */
async function restoreBaileysAuthFromFirestore(authDir) {
  try {
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    let pageToken = '';
    let restoredCount = 0;
    let registered = false;

    do {
      const qs = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await firestoreFetch(`/${AUTH_COLLECTION}?${qs}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[Firestore Auth] ⚠️ No se pudo consultar Firestore (HTTP ${res.status})`);
        return { restored: restoredCount > 0, count: restoredCount, registered };
      }

      const data = await res.json();
      const documents = data.documents || [];

      for (const doc of documents) {
        try {
          const docId = decodeURIComponent(doc.name.split('/').pop());
          const safe = resolveSafeAuthPath(authDir, docId);
          if (!safe) {
            console.warn(`[Firestore Auth] ⛔ ID de archivo sospechoso omitido: ${docId}`);
            continue;
          }

          const content = doc.fields?.content?.stringValue;
          if (!content) continue;

          fs.writeFileSync(safe.fullPath, content, 'utf8');
          _syncedHashes.set(safe.filename, content);
          restoredCount++;

          if (safe.filename === 'creds.json') {
            try {
              const parsed = JSON.parse(content);
              if (parsed.registered) registered = true;
            } catch (_) {}
          }
        } catch (err) {
          console.warn('[Firestore Auth] Error escribiendo archivo restaurado:', err.message);
        }
      }

      pageToken = data.nextPageToken || '';
    } while (pageToken);

    if (restoredCount === 0) {
      console.log('[Firestore Auth] ℹ️ No hay sesión previa guardada en Firestore.');
      return { restored: false, count: 0, registered: false };
    }

    console.log(`[Firestore Auth] 💾 Sesión restaurada (${restoredCount} archivos, Registrado: ${registered}).`);
    return { restored: true, count: restoredCount, registered };
  } catch (err) {
    console.error('[Firestore Auth] ❌ Error restaurando sesión desde Firestore:', err.message);
    return { restored: false, count: 0, registered: false };
  }
}

/**
 * Guarda un archivo individual en Firestore.
 */
async function saveFileToFirestore(authDir, filename) {
  try {
    const safe = resolveSafeAuthPath(authDir, filename);
    if (!safe) return;

    if (!fs.existsSync(safe.fullPath)) {
      await firestoreFetch(`/${AUTH_COLLECTION}/${encodeURIComponent(safe.filename)}`, {
        method: 'DELETE',
      }).catch(() => {});
      _syncedHashes.delete(safe.filename);
      return;
    }

    const content = fs.readFileSync(safe.fullPath, 'utf8');
    if (_syncedHashes.get(safe.filename) === content) return;

    const res = await firestoreFetch(`/${AUTH_COLLECTION}/${encodeURIComponent(safe.filename)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFirestoreFields({
          content,
          updatedAt: new Date().toISOString(),
        }),
      }),
    });

    if (res.ok) {
      _syncedHashes.set(safe.filename, content);
    }
  } catch (err) {
    console.warn(`[Firestore Auth] Error al sincronizar ${filename}:`, err.message);
  }
}

/**
 * Sincroniza todos los archivos de sesión locales hacia Firestore.
 */
async function syncAllAuthFilesToFirestore(authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir).filter((f) => SAFE_AUTH_FILE_RE.test(f));

    for (const f of files) {
      await saveFileToFirestore(authDir, f);
    }
  } catch (err) {
    console.warn('[Firestore Auth] Error en sincronización masiva:', err.message);
  }
}

/**
 * Elimina por completo la sesión de WhatsApp de Firestore y del disco local.
 */
async function clearAllBaileysAuth(authDir) {
  try {
    console.log('[Firestore Auth] 🗑️ Eliminando sesión permanente de WhatsApp en Firestore...');
    let pageToken = '';
    do {
      const qs = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await firestoreFetch(`/${AUTH_COLLECTION}?${qs}`);
      if (!res.ok) break;
      const data = await res.json();
      const docs = data.documents || [];
      for (const d of docs) {
        await firestoreFetch(`https://firestore.googleapis.com/v1/${d.name}`, {
          method: 'DELETE',
        }).catch(() => {});
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    _syncedHashes.clear();

    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    console.log('[Firestore Auth] ✅ Sesión eliminada por completo.');
  } catch (err) {
    console.error('[Firestore Auth] Error al limpiar sesión:', err.message);
  }
}

module.exports = {
  restoreBaileysAuthFromFirestore,
  saveFileToFirestore,
  syncAllAuthFilesToFirestore,
  clearAllBaileysAuth,
};
