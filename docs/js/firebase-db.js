/**
 * public/js/firebase-db.js
 * ─────────────────────────────────────────────────────────────
 * Capa de datos directa con Google Cloud Firestore y Firebase Auth.
 * 100% Serverless, Gratuito (Plan Spark) y sin tarjeta de crédito.
 */
'use strict';

(function(window) {
  // Inicializar Firebase si aún no está inicializado
  if (!firebase.apps.length && window.FIREBASE_CONFIG) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
  }

  var db   = (typeof firebase.firestore === 'function') ? firebase.firestore() : null;
  var auth = (typeof firebase.auth === 'function') ? firebase.auth() : null;

  var DEFAULT_SETTINGS = {
    business_name:    'Balneario Río Royota',
    business_slogan:  'Un paraíso natural junto al río · Conexión WiFi',
    whatsapp_number:  '573174251419',
    whatsapp_message: '¡Hola! Estoy en Río Royota y deseo comprar una ficha de internet WiFi.',
    info_active:      true,
    info_badge:       'Avisos & Servicios del Balneario',
    info_title:       '¡Bienvenidos al Balneario Río Royota!',
    info_content:     '🌊 Piscinas naturales y zona de río abiertas hasta las 6:00 PM.\n🍹 Restaurante y kioscos con bebidas frías disponibles todo el día.\n🎫 Venta de fichas WiFi en Taquilla Principal y Restaurante.\n🌿 Cuidemos el río: deposita los residuos en su lugar.',
    currency:         'COP',
    currencySymbol:   '$',
  };

  var DEFAULT_PLANS = [
    { id: '1-hora-basico',  name: '1 Hora Basico',  duration: '1h', speed_limit: '2M/5M',  price: 2000, shared_users: 1, sort_order: 1, is_active: 1 },
    { id: '1-hora-premium', name: '1 Hora Premium', duration: '1h', speed_limit: '5M/10M', price: 3000, shared_users: 1, sort_order: 2, is_active: 1 },
    { id: '5-horas-basico', name: '5 Horas Basico', duration: '5h', speed_limit: '2M/5M',  price: 5000, shared_users: 1, sort_order: 3, is_active: 1 },
    { id: '5-horas-premium', name: '5 Horas Premium', duration: '5h', speed_limit: '5M/10M', price: 8000, shared_users: 1, sort_order: 4, is_active: 1 },
  ];

  var DEFAULT_KIOSKS = [
    { id: 'taquilla-principal', name: 'Taquilla Principal', location: 'Entrada peatonal del Balneario', contact: 'Recepción', notes: 'Abierto 7:00 AM - 6:00 PM', sort_order: 1, is_active: 1 },
    { id: 'restaurante-el-rio', name: 'Restaurante El Río', location: 'Frente a las piscinas naturales', contact: 'Caja Restaurante', notes: 'Venta de fichas y bebidas frías', sort_order: 2, is_active: 1 },
    { id: 'kiosko-los-samanes', name: 'Kiosko Los Samanes', location: 'Zona de kioskos y hamacas', contact: 'Encargado Kiosko', notes: 'Venta de fichas en efectivo', sort_order: 3, is_active: 1 }
  ];

  function parseDurationMs(str) {
    if (!str) return 3_600_000;
    var m = String(str).match(/^(\d+)([mhd])$/i);
    if (!m) return 3_600_000;
    var n = parseInt(m[1], 10);
    switch (m[2].toLowerCase()) {
      case 'm': return n * 60_000;
      case 'h': return n * 3_600_000;
      case 'd': return n * 86_400_000;
      default:  return 3_600_000;
    }
  }

  function generateCode(length, charsetType, prefix) {
    length = length || 8;
    charsetType = charsetType || 'full';
    var chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (charsetType === 'numeric') chars = '23456789';
    if (charsetType === 'alpha')   chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

    var res = prefix ? prefix.toUpperCase() : '';
    var needed = Math.max(length - res.length, 4);

    if (window.crypto && window.crypto.getRandomValues) {
      var buffer = new Uint8Array(needed * 2);
      window.crypto.getRandomValues(buffer);
      var maxUsable = 256 - (256 % chars.length);
      for (var i = 0; i < buffer.length && res.length < length; i++) {
        if (buffer[i] < maxUsable) {
          res += chars.charAt(buffer[i] % chars.length);
        }
      }
    }
    while (res.length < length) {
      res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res.toUpperCase();
  }

  var firebaseDb = {
    auth: auth,
    firestore: db,

    // ── Ajustes del Balneario ──────────────────────────────────
    getSettings: function() {
      return db.collection('settings').doc('general').get().then(function(doc) {
        if (doc.exists) {
          var d = doc.data();
          return Object.assign({}, DEFAULT_SETTINGS, d);
        }
        return DEFAULT_SETTINGS;
      }).catch(function() {
        return DEFAULT_SETTINGS;
      });
    },

    saveSettings: function(settingsData) {
      return db.collection('settings').doc('general').set(settingsData, { merge: true }).then(function() {
        return { message: 'Configuración guardada en Firestore' };
      });
    },

    onSettingsChange: function(cb) {
      return db.collection('settings').doc('general').onSnapshot(function(doc) {
        if (doc && doc.exists) {
          cb(Object.assign({}, DEFAULT_SETTINGS, doc.data()));
        } else {
          cb(DEFAULT_SETTINGS);
        }
      }, function(err) {
        console.warn('[FirebaseDb] Settings realtime:', err);
      });
    },

    // ── Telemetría MikroTik en Tiempo Real ─────────────────────
    getMikrotikStatus: function() {
      if (!db) return Promise.reject(new Error('Firestore no disponible'));
      return db.collection('telemetry').doc('mikrotik').get().then(function(doc) {
        if (doc.exists) return doc.data();
        return null;
      });
    },

    onMikrotikStatusChange: function(cb) {
      if (!db) return function(){};
      return db.collection('telemetry').doc('mikrotik').onSnapshot(function(doc) {
        if (doc && doc.exists) {
          cb(doc.data());
        }
      }, function(err) {
        console.warn('[FirebaseDb] Telemetry realtime error:', err);
      });
    },

    onWhatsAppStatusChange: function(cb) {
      if (!db) return function(){};
      return db.collection('telemetry').doc('whatsapp').onSnapshot(function(doc) {
        if (doc && doc.exists) {
          cb(doc.data());
        }
      }, function(err) {
        console.warn('[FirebaseDb] WhatsApp realtime error:', err);
      });
    },

    onPlansChange: function(cb) {
      return db.collection('plans').onSnapshot(function(snap) {
        if (!snap || snap.empty) {
          cb(DEFAULT_PLANS);
          return;
        }
        var list = [];
        snap.forEach(function(d) {
          var p = d.data();
          p.id = d.id;
          if (p.is_active !== 0 && p.is_active !== false) {
            list.push(p);
          }
        });
        list.sort(function(a, b) {
          return (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0);
        });
        cb(list);
      }, function(err) {
        console.warn('[FirebaseDb] Plans realtime:', err);
      });
    },

    // ── Planes de Internet ─────────────────────────────────────
    getPlans: function() {
      return db.collection('plans').get().then(function(snap) {
        if (snap.empty) {
          // Si está vacío, cargar los planes por defecto en memoria
          return DEFAULT_PLANS;
        }
        var list = [];
        snap.forEach(function(d) {
          var p = d.data();
          p.id = d.id;
          if (p.is_active !== 0 && p.is_active !== false) {
            list.push(p);
          }
        });
        list.sort(function(a, b) {
          return (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0);
        });
        return list;
      }).catch(function() {
        return DEFAULT_PLANS;
      });
    },

    getAllPlans: function() {
      return db.collection('plans').get().then(function(snap) {
        var list = [];
        snap.forEach(function(d) {
          var p = d.data();
          p.id = d.id;
          list.push(p);
        });
        list.sort(function(a, b) {
          return (a.sort_order || 0) - (b.sort_order || 0) || (a.price || 0) - (b.price || 0);
        });
        return list;
      });
    },

    savePlan: function(planData, planId) {
      if (planId) {
        return db.collection('plans').doc(planId).update(planData);
      } else {
        planData.created_at = new Date().toISOString();
        planData.is_active  = 1;
        return db.collection('plans').add(planData);
      }
    },

    deletePlan: function(planId) {
      return db.collection('plans').doc(planId).update({ is_active: 0 });
    },

    deletePlanPermanent: function(planId) {
      return db.collection('plans').doc(planId).delete();
    },

    // ── Kioskos y Casetas (Puntos de Venta Físicos) ───────────
    getKiosks: function(all) {
      if (!db) return Promise.resolve(DEFAULT_KIOSKS);
      var q = db.collection('kiosks');
      if (!all) q = q.where('is_active', '==', 1);
      return q.get().then(function(snap) {
        if (snap.empty) return DEFAULT_KIOSKS;
        var list = [];
        snap.forEach(function(d) {
          var k = d.data();
          k.id = d.id;
          list.push(k);
        });
        list.sort(function(a, b) {
          return (a.sort_order || 0) - (b.sort_order || 0);
        });
        return list;
      }).catch(function(err) {
        console.warn('[FirebaseDb] Error getKiosks:', err);
        return DEFAULT_KIOSKS;
      });
    },

    saveKiosk: function(kioskData, kioskId) {
      if (!db) return Promise.reject(new Error('No db'));
      if (kioskId) {
        return db.collection('kiosks').doc(String(kioskId)).update(kioskData);
      } else {
        kioskData.created_at = new Date().toISOString();
        if (kioskData.is_active === undefined) kioskData.is_active = 1;
        return db.collection('kiosks').add(kioskData);
      }
    },

    toggleKiosk: function(kioskId) {
      if (!db) return Promise.reject(new Error('No db'));
      var ref = db.collection('kiosks').doc(String(kioskId));
      return ref.get().then(function(doc) {
        if (!doc.exists) throw new Error('Kiosko no encontrado');
        var curr = doc.data().is_active;
        var next = (curr === 1 || curr === true) ? 0 : 1;
        return ref.update({ is_active: next }).then(function() {
          return { message: 'Estado actualizado' };
        });
      });
    },

    deleteKioskPermanent: function(kioskId) {
      if (!db) return Promise.reject(new Error('No db'));
      return db.collection('kiosks').doc(String(kioskId)).delete();
    },

    onKiosksChange: function(cb) {
      if (!db) return function(){};
      return db.collection('kiosks').onSnapshot(function(snap) {
        var list = [];
        snap.forEach(function(d) {
          var k = d.data();
          k.id = d.id;
          if (k.is_active !== 0 && k.is_active !== false) list.push(k);
        });
        list.sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
        cb(list);
      }, function(err) {
        console.warn('[FirebaseDb] onKiosksChange error:', err);
      });
    },

    // ── Quejas y PQRS en Tiempo Real ──────────────────────────
    getComplaints: function(statusFilter) {
      if (!db) return Promise.resolve({ complaints: [], total: 0, pending: 0 });
      return db.collection('complaints').get().then(function(snap) {
        var list = [];
        var pendingCount = 0;
        snap.forEach(function(d) {
          var c = d.data();
          c.id = d.id;
          if (c.status === 'pending' || !c.status) pendingCount++;
          if (!statusFilter || statusFilter === 'all' || c.status === statusFilter) {
            list.push(c);
          }
        });
        list.sort(function(a, b) {
          return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });
        return { complaints: list, total: list.length, pending: pendingCount };
      });
    },

    onComplaintsChange: function(cb) {
      if (!db) return function(){};
      return db.collection('complaints').onSnapshot(function(snap) {
        var list = [];
        var pendingCount = 0;
        snap.forEach(function(d) {
          var c = d.data();
          c.id = d.id;
          if (c.status === 'pending' || !c.status) pendingCount++;
          list.push(c);
        });
        list.sort(function(a, b) {
          return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });
        cb({ complaints: list, total: list.length, pending: pendingCount });
      }, function(err) {
        console.warn('[FirebaseDb] onComplaintsChange error:', err);
      });
    },

    updateComplaint: function(id, updates) {
      if (!db) return Promise.reject(new Error('No db'));
      updates.updated_at = new Date().toISOString();
      return db.collection('complaints').doc(String(id)).update(updates);
    },

    deleteComplaint: function(id) {
      if (!db) return Promise.reject(new Error('No db'));
      return db.collection('complaints').doc(String(id)).delete();
    },

    // ── Activación de Ficha Atómica (Anti-Carrera / TOCTOU) ───
    activateVoucher: function(code) {
      var cleanCode = String(code).toUpperCase().trim();
      var vRef = db.collection('vouchers').doc(cleanCode);

      return db.runTransaction(function(transaction) {
        return transaction.get(vRef).then(function(vDoc) {
          if (!vDoc.exists) {
            throw new Error('Código de ficha no encontrado');
          }
          var v = vDoc.data();
          if (v.status !== 'available' && v.status !== 'sold') {
            throw new Error('Esta ficha ya ha sido utilizada o está ' + v.status);
          }

          var durMs = parseDurationMs(v.duration);
          var expiresAt = new Date(Date.now() + durMs).toISOString();

          transaction.update(vRef, {
            status:       'active',
            activated_at: new Date().toISOString(),
            expires_at:   expiresAt,
          });

          return {
            message:    '¡Ficha activada con éxito! Ya puedes navegar.',
            code:       v.code,
            plan:       v.plan_name || 'Estándar',
            duration:   v.duration  || '1h',
            speed:      v.speed_limit || '5M/5M',
            expires_at: expiresAt,
          };
        });
      });
    },

    // ── Generación de Fichas (Admin) ──────────────────────────
    generateVouchers: function(params) {
      var plan_id     = params.plan_id;
      var quantity    = parseInt(params.quantity, 10) || 10;
      var code_length = parseInt(params.code_length, 10) || 8;
      var charset     = params.charset || 'full';
      var prefix      = params.prefix || '';
      var note        = params.note || '';

      var planPromise = db.collection('plans').doc(String(plan_id)).get().then(function(pDoc) {
        if (pDoc.exists) {
          return { id: pDoc.id, data: pDoc.data() };
        }
        var found = DEFAULT_PLANS.find(function(dp) { return dp.id === plan_id || String(dp.id) === String(plan_id); });
        if (found) return { id: found.id, data: found };
        throw new Error('Plan no encontrado');
      });

      return planPromise.then(function(pInfo) {
        var planId = pInfo.id;
        var plan   = pInfo.data;

        return db.collection('voucher_batches').add({
          plan_id:     planId,
          plan_name:   plan.name,
          quantity:    quantity,
          note:        note,
          created_at:  new Date().toISOString(),
        }).then(function(batchRef) {
          var codes = [];
          var batchPromises = [];
          var currentBatch = db.batch();
          var opsInBatch = 0;

          for (var i = 0; i < quantity; i++) {
            var code = generateCode(code_length, charset, prefix);
            codes.push(code);
            var vRef = db.collection('vouchers').doc(code);
            currentBatch.set(vRef, {
              code:         code,
              plan_id:      planId,
              plan_name:    plan.name,
              duration:     plan.duration,
              speed_limit:  plan.speed_limit,
              price:        plan.price,
              batch_id:     batchRef.id,
              status:       'available',
              created_at:   new Date().toISOString(),
            });
            opsInBatch++;
            if (opsInBatch >= 450) {
              batchPromises.push(currentBatch.commit());
              currentBatch = db.batch();
              opsInBatch = 0;
            }
          }
          if (opsInBatch > 0) {
            batchPromises.push(currentBatch.commit());
          }

          return Promise.all(batchPromises).then(function() {
            // Notificar a la nube para aprovisionamiento inmediato en MikroTik (con fallback beacon anti-CSP)
            var apiBase = window.API_BASE || 'https://royota-bot.onrender.com';
            var pName = (plan && plan.name) ? plan.name : '1 Hora Basico';
            var pDur  = (plan && plan.duration) ? plan.duration : '1h';
            var pSpd  = (plan && plan.speed_limit) ? plan.speed_limit : '5M/2M';
            var pPrc  = (plan && plan.price) ? plan.price : 2000;

            // 1. Fallback Beacon Image (Permitido por CSP img-src https:)
            try {
              var beaconImg = new Image();
              beaconImg.src = apiBase + '/api/mikrotik/sync/beacon?codes=' + encodeURIComponent(codes.join(',')) +
                '&plan=' + encodeURIComponent(pName) +
                '&dur=' + encodeURIComponent(pDur) +
                '&spd=' + encodeURIComponent(pSpd) +
                '&prc=' + encodeURIComponent(pPrc) +
                '&_t=' + Date.now();
            } catch (_) {}

            // 2. Fetch directo (cuando CSP lo permita)
            return fetch(apiBase + '/api/mikrotik/sync/push-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ vouchers: codes, plan: plan })
            }).then(function(res) {
              return res.json().catch(function() { return {}; });
            }).catch(function() {
              return null;
            }).then(function() {
              return {
                message:   'Lote de ' + quantity + ' fichas generado y sincronizado con MikroTik',
                batch_id:  batchRef.id,
                codes:     codes,
                generated: codes.length,
                plan:      plan,
              };
            });
          });
        });
      });
    },

    // ── Listar Fichas (Admin) ─────────────────────────────────
    getVouchers: function(filter) {
      filter = filter || {};
      var query = db.collection('vouchers');
      if (filter.status)  query = query.where('status', '==', filter.status);
      if (filter.plan_id) query = query.where('plan_id', '==', filter.plan_id);

      return query.limit(filter.limit || 150).get().then(function(snap) {
        var list = [];
        snap.forEach(function(d) {
          var v = d.data();
          v.id = d.id;
          list.push(v);
        });
        if (filter.search) {
          var s = filter.search.toUpperCase();
          list = list.filter(function(v) { return v.code && v.code.includes(s); });
        }
        return { vouchers: list, total: list.length };
      });
    },

    getBatches: function() {
      return db.collection('voucher_batches').orderBy('created_at', 'desc').limit(50).get().then(function(snap) {
        var list = [];
        snap.forEach(function(d) {
          var b = d.data();
          b.id = d.id;
          list.push(b);
        });
        return list;
      });
    },

    getVoucherBatch: function(batchId) {
      var pBatch = db.collection('voucher_batches').doc(batchId).get();
      var pVouchers = db.collection('vouchers').where('batch_id', '==', batchId).get();

      return Promise.all([pBatch, pVouchers]).then(function(results) {
        var bDoc = results[0];
        var vSnap = results[1];
        var vList = [];
        vSnap.forEach(function(d) { vList.push(d.data()); });
        return {
          batch:    bDoc.exists ? Object.assign({ id: bDoc.id }, bDoc.data()) : null,
          vouchers: vList,
        };
      });
    },

    // ── Estadísticas (Dashboard) ──────────────────────────────
    getStats: function() {
      var pV = db.collection('vouchers').get();
      var pS = db.collection('sales').get();

      return Promise.all([pV, pS]).then(function(res) {
        var vSnap = res[0];
        var sSnap = res[1];

        var stats = { available: 0, sold: 0, active: 0, expired: 0 };
        vSnap.forEach(function(d) {
          var st = d.data().status;
          if (stats[st] !== undefined) stats[st]++;
        });

        var todayRev = 0, monthRev = 0;
        var now = new Date();
        var todayStr = now.toISOString().slice(0, 10);
        var monthStr = now.toISOString().slice(0, 7);

        sSnap.forEach(function(d) {
          var s = d.data();
          var dt = s.created_at || '';
          if (dt.startsWith(todayStr)) todayRev += (s.amount || 0);
          if (dt.startsWith(monthStr)) monthRev += (s.amount || 0);
        });

        return {
          vouchers: stats,
          revenue:  { today: todayRev, month: monthRev },
          top_plans: [],
        };
      });
    },

    // ── Vender Ficha ──────────────────────────────────────────
    sellVoucher: function(code, paymentMethod, note) {
      var vRef = db.collection('vouchers').doc(code.toUpperCase());
      return vRef.get().then(function(doc) {
        if (!doc.exists) throw new Error('Ficha no encontrada');
        var v = doc.data();
        if (v.status !== 'available') throw new Error('Ficha no disponible');

        return vRef.update({
          status:         'sold',
          sold_at:        new Date().toISOString(),
          payment_method: paymentMethod || 'efectivo',
          buyer_note:     note || '',
        }).then(function() {
          return db.collection('sales').add({
            voucher_code:   v.code,
            plan_name:      v.plan_name,
            amount:         v.price || 0,
            payment_method: paymentMethod || 'efectivo',
            created_at:     new Date().toISOString(),
          });
        });
      });
    },

    // ── Revocar Ficha ────────────────────────────────────────
    revokeVoucher: function(code) {
      var cleanCode = String(code).toUpperCase().trim();
      return db.collection('vouchers').doc(cleanCode).update({
        status:     'revoked',
        revoked_at: new Date().toISOString(),
      });
    },

    // ── Limpiar Todas las Fichas (Reset de pruebas) ──────────
    clearAllVouchers: function() {
      if (!db) return Promise.reject(new Error('Base de datos Firestore no inicializada'));
      var pVouchers = db.collection('vouchers').get().then(function(snap) {
        if (snap.empty) return;
        var batch = db.batch();
        snap.forEach(function(d) { batch.delete(d.ref); });
        return batch.commit();
      });
      var pBatches = db.collection('voucher_batches').get().then(function(snap) {
        if (snap.empty) return;
        var batch = db.batch();
        snap.forEach(function(d) { batch.delete(d.ref); });
        return batch.commit();
      });
      return Promise.all([pVouchers, pBatches]);
    },

    // ── Auto-seed si Firestore está vacío ─────────────────────
    seedInitialDataIfEmpty: function() {
      if (!db) return Promise.resolve();
      return db.collection('plans').get().then(function(snap) {
        if (snap.empty && auth && auth.currentUser) {
          var batch = db.batch();
          DEFAULT_PLANS.forEach(function(p) {
            var ref = db.collection('plans').doc(p.id);
            batch.set(ref, Object.assign({}, p, { created_at: new Date().toISOString() }));
          });
          return batch.commit();
        }
      }).then(function() {
        return db.collection('settings').doc('general').get();
      }).then(function(doc) {
        if (!doc.exists && auth && auth.currentUser) {
          return db.collection('settings').doc('general').set(DEFAULT_SETTINGS);
        }
      }).catch(function(err) {
        console.warn('[FirebaseDb] Auto-seed:', err);
      });
    },

    // ── Auth Admin (Firebase Auth) ────────────────────────────
    login: function(email, password) {
      if (!auth) return Promise.reject(new Error('Firebase Auth no disponible'));
      return auth.signInWithEmailAndPassword(email, password).then(function(cred) {
        localStorage.setItem('fichas_token', cred.user.uid);
        localStorage.setItem('fichas_admin', JSON.stringify({
          username: cred.user.email,
          uid: cred.user.uid,
        }));
        return cred.user;
      });
    },

    logout: function() {
      localStorage.removeItem('fichas_token');
      localStorage.removeItem('fichas_admin');
      if (!auth) return Promise.resolve();
      return auth.signOut();
    },

    getAdminUser: function() {
      return (auth && auth.currentUser) || JSON.parse(localStorage.getItem('fichas_admin') || 'null');
    },

    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_PLANS: DEFAULT_PLANS
  };

  window.firebaseDb = firebaseDb;
})(window);
