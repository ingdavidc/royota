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
    business_slogan:  'El paraíso natural junto al río · Conexión WiFi',
    whatsapp_number:  '573123456789',
    whatsapp_message: '¡Hola! Estoy en el Balneario Río Royota y deseo comprar una ficha de internet WiFi.',
    info_active:      true,
    info_badge:       'Avisos & Servicios del Balneario',
    info_title:       '¡Bienvenidos al Balneario Río Royota!',
    info_content:     '🌊 Piscinas naturales y zona de río abiertas hasta las 6:00 PM.\n🍹 Restaurante y kioscos con bebidas frías disponibles todo el día.\n🎫 Venta de fichas WiFi en Taquilla Principal y Restaurante.\n🌿 Cuidemos el río: deposita los residuos en su lugar.',
    currency:         'COP',
    currencySymbol:   '$',
  };

  var DEFAULT_PLANS = [
    { id: 'plan_30m', name: '30 Minutos',  duration: '30m',  speed_limit: '3M/3M',   price: 2000,  shared_users: 1, sort_order: 1, is_active: 1 },
    { id: 'plan_1h',  name: '1 Hora',      duration: '1h',   speed_limit: '5M/5M',   price: 3000,  shared_users: 1, sort_order: 2, is_active: 1 },
    { id: 'plan_2h',  name: '2 Horas',     duration: '2h',   speed_limit: '5M/5M',   price: 5000,  shared_users: 1, sort_order: 3, is_active: 1 },
    { id: 'plan_5h',  name: '5 Horas',     duration: '5h',   speed_limit: '8M/8M',   price: 8000,  shared_users: 1, sort_order: 4, is_active: 1 },
    { id: 'plan_1d',  name: '1 Día',       duration: '1d',   speed_limit: '10M/10M', price: 12000, shared_users: 2, sort_order: 5, is_active: 1 },
    { id: 'plan_3d',  name: '3 Días',      duration: '3d',   speed_limit: '10M/10M', price: 25000, shared_users: 2, sort_order: 6, is_active: 1 },
    { id: 'plan_7d',  name: '7 Días',      duration: '7d',   speed_limit: '15M/15M', price: 45000, shared_users: 3, sort_order: 7, is_active: 1 },
    { id: 'plan_30d', name: '30 Días',     duration: '30d',  speed_limit: '20M/20M', price: 120000,shared_users: 3, sort_order: 8, is_active: 1 },
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

    // ── Activación de Ficha (Portal Cautivo) ───────────────────
    activateVoucher: function(code) {
      var cleanCode = String(code).toUpperCase().trim();
      var vRef = db.collection('vouchers').doc(cleanCode);

      return vRef.get().then(function(vDoc) {
        if (!vDoc.exists) {
          throw new Error('Código de ficha no encontrado');
        }
        var v = vDoc.data();
        if (v.status !== 'available' && v.status !== 'sold') {
          throw new Error('Esta ficha ya ha sido utilizada o está ' + v.status);
        }

        var durMs = parseDurationMs(v.duration);
        var expiresAt = new Date(Date.now() + durMs).toISOString();

        return vRef.update({
          status:       'active',
          activated_at: new Date().toISOString(),
          expires_at:   expiresAt,
        }).then(function() {
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
          var batch = db.batch();
          var codes = [];

          for (var i = 0; i < quantity; i++) {
            var code = generateCode(code_length, charset, prefix);
            codes.push(code);
            var vRef = db.collection('vouchers').doc(code);
            batch.set(vRef, {
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
          }

          return batch.commit().then(function() {
            return {
              message:  'Lote de ' + quantity + ' fichas generado',
              batch_id: batchRef.id,
              codes:    codes,
            };
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
