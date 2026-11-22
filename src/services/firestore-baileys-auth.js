/**
 * src/services/firestore-baileys-auth.js
 * ─────────────────────────────────────────────────────────────
 * Capa de Persistencia en la Nube (Firestore) para Baileys WhatsApp.
 * 
 * Resuelve definitivamente la pérdida de sesión en entornos efímeros (como Render):
 * 1. Restaura credenciales y llaves criptográficas desde Firestore al arrancar.
 * 2. Guarda automáticamente creds.json y llaves de sesión en la colección 'baileys_auth'.
 * 3. Permite que la vinculación sea PERMANENTE: no se pierde al reiniciar, actualizar la página,
 *    desplegar cambios ni al cerrar el módulo administrativo.
 * 4. Solo se limpia cuando el usuario hace clic expresamente en "Desvincular WhatsApp".
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/fichas-royota/databases/(default)/documents/baileys_auth';

// Caché en memoria de hashes de archivos para evitar subir datos duplicados
const _syncedHashes = new Map();

/**
 * Restaura todos los archivos de autenticación desde Firestore a la carpeta local
 */
async function restoreBaileysAuthFromFirestore(authDir) {
  try {
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const res = await fetch(`${FIRESTORE_BASE}?pageSize=300`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      console.warn(`[Firestore Auth] ⚠️ No se pudo consultar Firestore (HTTP ${res.status})`);
      return { restored: false, count: 0, registered: false };
    }

    const data = await res.json();
    const documents = data.documents || [];

    if (!documents.length) {
      console.log('[Firestore Auth] ℹ️ No hay sesión previa guardada en Firestore.');
      return { restored: false, count: 0, registered: false };
    }

    let restoredCount = 0;
    let registered = false;

    for (const doc of documents) {
      try {
        const docId = decodeURIComponent(doc.name.split('/').pop());
        const content = doc.fields?.content?.stringValue;
        if (!content) continue;

        const targetFile = path.join(authDir, docId);
        fs.writeFileSync(targetFile, content, 'utf8');
        _syncedHashes.set(docId, content);
        restoredCount++;

        if (docId === 'creds.json') {
          try {
            const parsed = JSON.parse(content);
            if (parsed.registered) {
              registered = true;
            }
          } catch (_) {}
        }
      } catch (err) {
        console.warn('[Firestore Auth] Error escribiendo archivo restaurado:', err.message);
      }
    }

    console.log(`[Firestore Auth] 💾 Sesión de WhatsApp restaurada exitosamente (${restoredCount} archivos, Registrado: ${registered}).`);
    return { restored: restoredCount > 0, count: restoredCount, registered };
  } catch (err) {
    console.error('[Firestore Auth] ❌ Error al restaurar sesión de WhatsApp desde Firestore:', err.message);
    return { restored: false, count: 0, registered: false };
  }
}

/**
 * Guarda un archivo individual en Firestore
 */
async function saveFileToFirestore(authDir, filename) {
  try {
    const filePath = path.join(authDir, filename);
    if (!fs.existsSync(filePath)) {
      // Si el archivo ya no existe, borrarlo de Firestore
      await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(filename)}`, { method: 'DELETE' }).catch(() => {});
      _syncedHashes.delete(filename);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    if (_syncedHashes.get(filename) === content) {
      return; // Sin cambios, no saturar la red
    }

    const body = {
      fields: {
        content: { stringValue: content },
        updatedAt: { stringValue: new Date().toISOString() },
      }
    };

    const res = await fetch(`${FIRESTORE_BASE}/${encodeURIComponent(filename)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      _syncedHashes.set(filename, content);
    }
  } catch (err) {
    console.warn(`[Firestore Auth] Error al sincronizar ${filename}:`, err.message);
  }
}

/**
 * Sincroniza todos los archivos de sesión locales hacia Firestore
 */
async function syncAllAuthFilesToFirestore(authDir) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files = fs.readdirSync(authDir).filter(f => f.endsWith('.json'));

    for (const f of files) {
      await saveFileToFirestore(authDir, f);
    }
  } catch (err) {
    console.warn('[Firestore Auth] Error en sincronización masiva:', err.message);
  }
}

/**
 * Elimina por completo la sesión de WhatsApp de Firestore y del disco local
 */
async function clearAllBaileysAuth(authDir) {
  try {
    console.log('[Firestore Auth] 🗑️ Eliminando sesión permanente de WhatsApp en Firestore...');
    const res = await fetch(`${FIRESTORE_BASE}?pageSize=300`);
    if (res.ok) {
      const data = await res.json();
      const docs = data.documents || [];
      for (const d of docs) {
        await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE' }).catch(() => {});
      }
    }
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
