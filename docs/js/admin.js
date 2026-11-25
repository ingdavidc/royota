/* ============================================================
   public/js/admin.js — Panel Admin completo sin frameworks
   ============================================================ */
'use strict';

/* ── Auth ─────────────────────────────────────────────────── */
var TOKEN = localStorage.getItem('fichas_token') || null;
var ME    = safeJSON(localStorage.getItem('fichas_admin')) || { username: 'Admin' };
if (!TOKEN && !(window.firebaseDb && window.firebaseDb.auth)) {
  location.href = './login.html';
}

document.getElementById('adminName').textContent = ME.username || 'Admin';

function getAuthTokenPromise() {
  if (window.firebaseDb && window.firebaseDb.getFreshToken) {
    return window.firebaseDb.getFreshToken().then(function(t) {
      if (t) {
        TOKEN = t;
        localStorage.setItem('fichas_token', t);
      }
      return TOKEN;
    });
  }
  return Promise.resolve(TOKEN);
}

/** Petición HTTP autenticada directa al backend Express (reemplaza balizas GET inseguras) */
function httpApiFetch(method, url, body) {
  return getAuthTokenPromise().then(function(tok) {
    if (!tok) {
      logout();
      return Promise.reject({ error: 'Sesión requerida' });
    }
    return new Promise(function(resolve, reject) {
      var fullUrl = (window.API_BASE || '') + url;
      var xhr = new XMLHttpRequest();
      xhr.open(method, fullUrl, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        var d;
        try { d = JSON.parse(xhr.responseText); } catch(_) { d = {}; }
        if (xhr.status === 401) {
          if (url.indexOf('/api/whatsapp') === -1 && url.indexOf('/api/mikrotik') === -1 && url.indexOf('/api/kiosks') === -1 && url.indexOf('/api/complaints') === -1) {
            logout();
          }
          reject(d);
          return;
        }
        if (xhr.status >= 400) { reject(d); return; }
        resolve(d);
      };
      xhr.onerror = function() { reject({ error: 'Error de red' }); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  });
}

/* ── Negocio ─────────────────────────────────────────────── */
function loadBrandingHeader() {
  apiFetch('GET', '/api/config').then(function(c) {
    if (c.businessName) {
      document.getElementById('topbarTitle').textContent = c.businessName;
      document.title = 'Admin — ' + c.businessName;
    }
  }).catch(function(){});
}

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function safeJSON(s) { try { return JSON.parse(s || '{}'); } catch(_) { return {}; } }

function logout() {
  localStorage.removeItem('fichas_token');
  localStorage.removeItem('fichas_admin');
  if (window.firebaseDb && window.firebaseDb.logout) {
    window.firebaseDb.logout().finally(function() { location.href = './login.html'; });
  } else {
    location.href = './login.html';
  }
}

/** Petición autenticada (con soporte directo a Firestore y backend HTTP autenticado) */
function apiFetch(method, url, body) {
  if (window.firebaseDb) {
    if (url === '/api/config' || url === '/api/settings') {
      if (method === 'GET') return window.firebaseDb.getSettings();
      if (method === 'PUT' || method === 'POST') return window.firebaseDb.saveSettings(body);
    }
    if (url === '/api/plans' || url === '/api/plans/all') {
      if (method === 'GET') return window.firebaseDb.getAllPlans();
      if (method === 'POST') return window.firebaseDb.savePlan(body);
    }
    if (url.startsWith('/api/plans/')) {
      var planId = url.split('/api/plans/')[1];
      if (method === 'PUT') return window.firebaseDb.savePlan(body, planId);
      if (method === 'DELETE') {
        return (window.firebaseDb.deletePlanPermanent ? window.firebaseDb.deletePlanPermanent(planId) : window.firebaseDb.deletePlan(planId));
      }
    }
    if (url.startsWith('/api/kiosks')) {
      var _pingKioskSync = function() {
        httpApiFetch('POST', '/api/kiosks/sync', {}).catch(function(){});
      };
      if (method === 'GET') {
        var all = url.indexOf('all=true') !== -1;
        return window.firebaseDb.getKiosks(all);
      }
      if (method === 'POST') {
        return window.firebaseDb.saveKiosk(body).then(function() {
          _pingKioskSync();
          return { message: 'Caseta guardada exitosamente' };
        });
      }
      if (url.includes('/toggle') && method === 'PATCH') {
        var tId = decodeURIComponent(url.split('/api/kiosks/')[1].split('/')[0]);
        return window.firebaseDb.toggleKiosk(tId).then(function(res) {
          _pingKioskSync();
          return res;
        });
      }
      if (method === 'PUT') {
        var pId = decodeURIComponent(url.split('/api/kiosks/')[1]);
        return window.firebaseDb.saveKiosk(body, pId).then(function() {
          _pingKioskSync();
          return { message: 'Caseta actualizada exitosamente' };
        });
      }
      if (method === 'DELETE') {
        var dId = decodeURIComponent(url.split('/api/kiosks/')[1]);
        return window.firebaseDb.deleteKioskPermanent(dId).then(function() {
          _pingKioskSync();
          return { message: 'Caseta eliminada exitosamente' };
        });
      }
    }
    if (url.startsWith('/api/ip-bindings')) {
      if (method === 'GET') {
        return window.firebaseDb.getIpBindings();
      }
      if (method === 'POST') {
        return window.firebaseDb.saveIpBinding(body).then(function(res) {
          httpApiFetch('POST', '/api/mikrotik/sync/push-binding', body).catch(function(){});
          return { message: 'Dispositivo registrado en IP Binding exitosamente', id: res && res.id };
        });
      }
      if (method === 'DELETE') {
        var rawPath = url.split('/api/ip-bindings/')[1] || '';
        var parts = rawPath.split('?');
        var bindId = decodeURIComponent(parts[0]);
        var macParam = '';
        if (parts[1]) {
          try {
            var params = new URLSearchParams(parts[1]);
            macParam = params.get('mac') || '';
          } catch (_) {}
        }
        return window.firebaseDb.deleteIpBinding(bindId).then(function() {
          if (macParam) {
            httpApiFetch('DELETE', '/api/mikrotik/bindings/' + encodeURIComponent(macParam)).catch(function(){});
          }
          return { message: 'Dispositivo eliminado de IP Binding exitosamente' };
        });
      }
    }
    if (url === '/api/vouchers/generate' && method === 'POST') {
      return window.firebaseDb.generateVouchers(body).then(function(res) {
        httpApiFetch('POST', '/api/mikrotik/sync/push-batch', { vouchers: res.codes, plan: res.plan }).catch(function(){});
        return res;
      });
    }
    if (url.startsWith('/api/vouchers/batch/')) {
      var batchId = url.split('/api/vouchers/batch/')[1];
      return window.firebaseDb.getVoucherBatch(batchId);
    }
    if (url.startsWith('/api/vouchers/batches')) {
      return window.firebaseDb.getBatches();
    }
    if (url.startsWith('/api/vouchers/stats')) {
      return window.firebaseDb.getStats();
    }
    if (url.startsWith('/api/vouchers') && method === 'GET') {
      var filter = {};
      var qIdx = url.indexOf('?');
      if (qIdx !== -1) {
        var pairs = url.slice(qIdx + 1).split('&');
        pairs.forEach(function(pair) {
          var kv = pair.split('=');
          if (kv[0] && kv[1]) filter[kv[0]] = decodeURIComponent(kv[1]);
        });
      }
      return window.firebaseDb.getVouchers(filter);
    }
    if (url === '/api/vouchers/sell' && method === 'POST') {
      return window.firebaseDb.sellVoucher(body.voucher_id, body.payment_method, body.buyer_note);
    }
    if (url.startsWith('/api/vouchers/revoke/') && method === 'POST') {
      var revCode = url.split('/api/vouchers/revoke/')[1];
      return window.firebaseDb.revokeVoucher(revCode);
    }
  }

  return httpApiFetch(method, url, body);
}

/** Toast notification */
function toast(msg, type) {
  type = type || 'ok';
  var wrap = document.getElementById('toastWrap');
  var el   = document.createElement('div');
  el.className   = 'toast toast-' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function() { el.remove(); }, 3800);
}

/** Crear elemento HTML simple */
function el(tag, props, text) {
  var e = document.createElement(tag);
  if (props) Object.keys(props).forEach(function(k) { e[k] = props[k]; });
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Formatear fecha */
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle:'short', timeStyle:'short' }); }
  catch(_) { return iso; }
}

/** Formatear moneda */
var CUR_SYM = '$';
apiFetch('GET', '/api/config').then(function(c) { if (c.currencySymbol) CUR_SYM = c.currencySymbol; }).catch(function(){});
function fmtMoney(n) { return CUR_SYM + parseFloat(n || 0).toFixed(2); }

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ══════════════════════════════════════════════════════════
   NAVEGACIÓN
══════════════════════════════════════════════════════════ */
var SECTIONS = {
  dashboard: { load: loadDashboard },
  generate:  { load: loadGenSection },
  vouchers:  { load: loadVouchers },
  plans:     { load: loadPlans },
  mikrotik:  { load: loadMikrotikSection },
  portal:    { load: loadPortalSettings },
  whatsapp:  { load: loadWhatsAppSection },
  kiosks:    { load: loadKiosksSection },
  complaints:{ load: loadComplaintsSection },
};

document.querySelectorAll('.nav-link').forEach(function(a) {
  a.addEventListener('click', function(e) {
    e.preventDefault();
    var sec = this.getAttribute('data-sec');
    activateSection(sec);
  });
});

function activateSection(name) {
  document.querySelectorAll('.nav-link').forEach(function(a) {
    a.classList.toggle('active', a.getAttribute('data-sec') === name);
  });
  Object.keys(SECTIONS).forEach(function(k) {
    var el = document.getElementById('sec-' + k);
    if (el) el.hidden = (k !== name);
  });
  if (SECTIONS[name] && SECTIONS[name].load) SECTIONS[name].load();
}

/* ══════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════ */
function loadDashboard() {
  apiFetch('GET', '/api/vouchers/stats').then(function(s) {
    setText('st-available', s.vouchers.available);
    setText('st-sold',      s.vouchers.sold);
    setText('st-active',    s.vouchers.active);
    setText('st-expired',   s.vouchers.expired);
    setText('st-today',     fmtMoney(s.revenue.today));
    setText('st-month',     fmtMoney(s.revenue.month));

    var tb = document.getElementById('topPlansBody');
    tb.innerHTML = '';
    if (!s.top_plans || !s.top_plans.length) {
      tb.innerHTML = '<tr><td colspan="3" style="color:var(--muted);text-align:center">Sin ventas este mes</td></tr>';
      return;
    }
    s.top_plans.forEach(function(p) {
      var tr = tb.insertRow();
      tr.insertCell().textContent = p.name;
      tr.insertCell().textContent = p.sales_count;
      tr.insertCell().textContent = fmtMoney(p.revenue);
    });
  }).catch(function(e) { toast(e.error || 'Error cargando stats', 'error'); });
}

function setText(id, v) { var e = document.getElementById(id); if(e) e.textContent = v !== undefined ? v : '—'; }

/* ══════════════════════════════════════════════════════════
   GENERAR FICHAS (POR CAPACIDAD DE HOJA CARTA: 48 FICHAS/HOJA - 6 COLS × 8 FILAS)
══════════════════════════════════════════════════════════ */
var TICKETS_PER_LETTER_PAGE = 48;
var _lastBatchId   = null;
var _lastBatchData = null;
var _plansCache    = [];

function updateSheetsCalculation() {
  var sheetsInput = document.getElementById('gSheets');
  if (!sheetsInput) return;
  var sheets = parseInt(sheetsInput.value, 10);
  if (isNaN(sheets) || sheets < 1) sheets = 1;
  if (sheets > 20) sheets = 20; // Máx 20 hojas (960 fichas <= límite backend 1000)
  sheetsInput.value = sheets;

  var totalVouchers = sheets * TICKETS_PER_LETTER_PAGE;
  var gQty = document.getElementById('gQty');
  if (gQty) gQty.value = totalVouchers;

  var lblTotal = document.getElementById('lblTotalVouchers');
  if (lblTotal) lblTotal.textContent = totalVouchers;

  var btn = document.getElementById('btnGenerar');
  if (btn && !btn.disabled) {
    btn.innerHTML = '🎫 Generar ' + totalVouchers + ' Fichas (' + sheets + (sheets === 1 ? ' Hoja Carta' : ' Hojas Carta') + ')';
  }

  // Actualizar estilo visual de los botones píldora
  document.querySelectorAll('.sheet-pill').forEach(function(pill) {
    var s = parseInt(pill.getAttribute('data-sheets'), 10);
    if (s === sheets) {
      pill.style.borderColor = 'rgba(0,212,255,0.5)';
      pill.style.background = 'rgba(0,212,255,0.18)';
      pill.style.color = '#00d4ff';
      pill.style.fontWeight = '700';
    } else {
      pill.style.borderColor = 'rgba(255,255,255,0.12)';
      pill.style.background = 'transparent';
      pill.style.color = '#8ba3b8';
      pill.style.fontWeight = 'normal';
    }
  });
}

function initSheetCalculator() {
  var btnDec = document.getElementById('btnDecSheets');
  if (btnDec && !btnDec._wired) {
    btnDec._wired = true;
    btnDec.addEventListener('click', function() {
      var s = parseInt(document.getElementById('gSheets').value, 10) || 1;
      if (s > 1) {
        document.getElementById('gSheets').value = s - 1;
        updateSheetsCalculation();
      }
    });
  }
  var btnInc = document.getElementById('btnIncSheets');
  if (btnInc && !btnInc._wired) {
    btnInc._wired = true;
    btnInc.addEventListener('click', function() {
      var s = parseInt(document.getElementById('gSheets').value, 10) || 1;
      if (s < 20) {
        document.getElementById('gSheets').value = s + 1;
        updateSheetsCalculation();
      }
    });
  }
  var sheetsInp = document.getElementById('gSheets');
  if (sheetsInp && !sheetsInp._wired) {
    sheetsInp._wired = true;
    sheetsInp.addEventListener('input', updateSheetsCalculation);
    sheetsInp.addEventListener('change', updateSheetsCalculation);
  }
  document.querySelectorAll('.sheet-pill').forEach(function(pill) {
    if (!pill._wired) {
      pill._wired = true;
      pill.addEventListener('click', function() {
        var s = parseInt(this.getAttribute('data-sheets'), 10) || 1;
        document.getElementById('gSheets').value = s;
        updateSheetsCalculation();
      });
    }
  });
  updateSheetsCalculation();
}

function loadGenSection() {
  loadPlanSelect('gPlanId');
  updateCodePreview();
  initSheetCalculator();
  loadBatches();
  loadIpBindings();
}

function loadPlanSelect(selectId) {
  apiFetch('GET', '/api/plans').then(function(plans) {
    _plansCache = plans;
    var sel = document.getElementById(selectId);
    // Mantener la opción vacía
    while (sel.options.length > 1) sel.remove(1);
    plans.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name + ' — ' + p.duration + ' — ' + fmtMoney(p.price);
      opt.dataset.duration = p.duration;
      opt.dataset.speed    = p.speed_limit;
      opt.dataset.price    = p.price;
      sel.appendChild(opt);
    });
  }).catch(function(){});
}

/* Plan preview dinámico */
document.getElementById('gPlanId').addEventListener('change', function() {
  var opt = this.options[this.selectedIndex];
  var prev = document.getElementById('planPreview');
  if (this.value && opt.dataset.duration) {
    document.getElementById('pvDuration').textContent = opt.dataset.duration;
    document.getElementById('pvSpeed').textContent    = opt.dataset.speed;
    document.getElementById('pvPrice').textContent    = fmtMoney(opt.dataset.price);
    prev.hidden = false;
  } else { prev.hidden = true; }
});

/* Vista previa del código */
var CHARSETS_MAP = { full:'ABCDEFGHJKMNPQRSTUVWXYZ23456789', numeric:'23456789', alpha:'ABCDEFGHJKMNPQRSTUVWXYZ' };

function updateCodePreview() {
  var len      = parseInt(document.getElementById('gCodeLen').value, 10)    || 8;
  var charset  = document.getElementById('gCharset').value  || 'full';
  var group    = parseInt(document.getElementById('gGroupSize').value, 10)  || 0;
  var prefix   = (document.getElementById('gPrefix').value  || '').toUpperCase();

  var chars    = CHARSETS_MAP[charset] || CHARSETS_MAP.full;
  var rawLen   = Math.max(0, len - prefix.length);
  var raw      = prefix;
  for (var i = 0; i < rawLen; i++) raw += chars[Math.floor(Math.random() * chars.length)];

  var preview  = raw;
  if (group > 0) {
    var parts = [];
    for (var j = 0; j < raw.length; j += group) parts.push(raw.slice(j, j + group));
    preview = parts.join('-');
  }

  document.getElementById('codePreviewVal').textContent = preview || '—';
}

['gCodeLen','gCharset','gGroupSize','gPrefix'].forEach(function(id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener('change', updateCodePreview);
});
document.getElementById('gPrefix').addEventListener('input', function() {
  this.value = this.value.toUpperCase();
  updateCodePreview();
});

/* Envío del formulario de generación */
document.getElementById('genForm').addEventListener('submit', function(e) {
  e.preventDefault();

  var planId   = document.getElementById('gPlanId').value;
  var qty      = parseInt(document.getElementById('gQty').value, 10);
  var codeLen  = parseInt(document.getElementById('gCodeLen').value, 10);
  var charset  = document.getElementById('gCharset').value;
  var group    = parseInt(document.getElementById('gGroupSize').value, 10);
  var prefix   = document.getElementById('gPrefix').value.trim().toUpperCase();
  var note     = document.getElementById('gNote').value.trim();

  if (!planId)         { toast('Selecciona un plan', 'error'); return; }
  if (qty < 1 || qty > 1000) { toast('Cantidad debe ser entre 1 y 1000', 'error'); return; }

  var btn = document.getElementById('btnGenerar');
  btn.disabled    = true;
  btn.textContent = 'Generando…';

  apiFetch('POST', '/api/vouchers/generate', {
    plan_id:    (typeof planId === 'string' && /^\d+$/.test(planId)) ? parseInt(planId, 10) : planId,
    quantity:   qty,
    code_length: codeLen,
    charset:    charset,
    group_size: group,
    separator:  '-',
    prefix:     prefix,
    note:       note,
  }).then(function(r) {
    btn.disabled = false;
    updateSheetsCalculation();

    _lastBatchId   = r.batch_id;
    _lastBatchData = r;

    toast(r.message || 'Fichas generadas con éxito', 'ok');
    showCodesResult(r);
    loadBatches();
  }).catch(function(err) {
    btn.disabled = false;
    updateSheetsCalculation();
    toast((err && (err.error || err.message)) || 'Error al generar fichas', 'error');
  });
});

function showCodesResult(r) {
  var panel   = document.getElementById('resultPanel');
  var title   = document.getElementById('resultTitle');
  var grid    = document.getElementById('codesGrid');

  var total = r.generated || (r.codes && r.codes.length) || 0;
  var sheets = Math.ceil(total / TICKETS_PER_LETTER_PAGE);
  title.textContent = total + ' fichas (' + sheets + (sheets === 1 ? ' hoja carta' : ' hojas carta') + ') — ' + (r.plan ? r.plan.name : '');
  grid.innerHTML    = '';
  r.codes.forEach(function(code) {
    var chip = document.createElement('span');
    chip.className   = 'code-chip';
    chip.textContent = code;
    chip.title       = 'Click para copiar';
    chip.addEventListener('click', function() {
      copyText(code);
      toast('Código copiado: ' + code, 'info');
    });
    grid.appendChild(chip);
  });

  panel.hidden = false;
}

function copyCodes() {
  if (!_lastBatchData) return;
  var text = _lastBatchData.codes.join('\n');
  copyText(text);
  toast('Códigos copiados al portapapeles', 'ok');
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(function(){});
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch(_) {}
    ta.remove();
  }
}

function openPrintPage() {
  if (!_lastBatchId) { toast('No hay lote seleccionado', 'error'); return; }
  window.open('./print.html?batch=' + _lastBatchId, '_blank');
}

/* Historial de lotes */
function loadBatches() {
  apiFetch('GET', '/api/vouchers/batches?limit=20').then(function(batches) {
    var tbody = document.getElementById('batchesBody');
    tbody.innerHTML = '';
    if (!batches || !batches.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);text-align:center">Sin lotes generados</td></tr>';
      return;
    }
    batches.forEach(function(b) {
      var tr = tbody.insertRow();
      td(tr, fmtDate(b.created_at));
      td(tr, b.plan_name);
      var totalNum = b.vouchers_total !== undefined ? b.vouchers_total : (b.quantity || 0);
      var totalText = String(totalNum);
      if (totalNum >= 48 && totalNum % 48 === 0) {
        var sh = totalNum / 48;
        totalText += ' (' + sh + (sh === 1 ? ' hoja)' : ' hojas)');
      } else if (totalNum >= 36 && totalNum % 36 === 0) {
        var sh = totalNum / 36;
        totalText += ' (' + sh + (sh === 1 ? ' hoja)' : ' hojas)');
      }
      td(tr, totalText);
      td(tr, b.vouchers_available !== undefined ? b.vouchers_available : totalNum);
      td(tr, b.vouchers_sold || 0);
      td(tr, b.vouchers_active || 0);
      td(tr, b.note || '—');
      var acts = tr.insertCell();
      var btnP = el('button', { className:'btn btn-sm btn-ghost' }, '🖨️');
      btnP.addEventListener('click', function() { window.open('./print.html?batch=' + b.id, '_blank'); });
      acts.appendChild(btnP);
    });
  }).catch(function(err){
    console.warn('Error loadBatches:', err);
  });
}

/* ══════════════════════════════════════════════════════════
   FICHAS
══════════════════════════════════════════════════════════ */
var _vPage = 1;
var _searchTimer;

function loadVouchers(page) {
  _vPage = page || 1;
  var status  = document.getElementById('fStatus').value;
  var planId  = document.getElementById('fPlan').value;
  var q       = document.getElementById('fSearch').value.trim().toUpperCase();
  var url     = '/api/vouchers?page=' + _vPage + '&limit=30';
  if (status) url += '&status=' + status;
  if (planId) url += '&plan_id=' + planId;
  if (q)      url += '&q=' + encodeURIComponent(q);

  apiFetch('GET', url).then(function(r) {
    var tbody = document.getElementById('vouchersBody');
    tbody.innerHTML = '';

    if (!r.vouchers.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center">Sin resultados</td></tr>';
    } else {
      r.vouchers.forEach(function(v) {
        var tr = tbody.insertRow();
        var cTd = tr.insertCell();
        cTd.className   = 'code-mono';
        cTd.textContent = v.code;
        td(tr, v.plan_name);
        var sTd = tr.insertCell();
        var badge = el('span', { className: 'badge badge-' + v.status }, v.status);
        sTd.appendChild(badge);
        td(tr, fmtDate(v.created_at));
        td(tr, v.expires_at ? fmtDate(v.expires_at) : '—');
        var acts = tr.insertCell();
        if (v.status === 'available') {
          var bSell = el('button', { className:'btn btn-sm btn-success' }, 'Vender');
          bSell.addEventListener('click', function() { sellVoucher(v.id, v.code); });
          acts.appendChild(bSell);
        }
        if (v.status === 'active' || v.status === 'sold') {
          var bRev = el('button', { className:'btn btn-sm btn-danger', style:'margin-left:6px' }, 'Revocar');
          bRev.addEventListener('click', function() { revokeVoucher(v.id, v.code); });
          acts.appendChild(bRev);
        }
      });
    }

    /* Paginador */
    var pager = document.getElementById('voucherPager');
    pager.innerHTML = '';
    for (var i = 1; i <= Math.min(r.pages, 10); i++) {
      var pb = el('button', { className:'pager-btn' + (i===_vPage?' current':'') }, i);
      (function(pg) {
        pb.addEventListener('click', function() { loadVouchers(pg); });
      }(i));
      pager.appendChild(pb);
    }
  }).catch(function(e) { toast(e.error || 'Error', 'error'); });
}

function debounceSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(function() { loadVouchers(1); }, 400);
}

function sellVoucher(id, code) {
  if (!confirm('¿Registrar venta de ficha ' + code + '?')) return;
  apiFetch('POST', '/api/vouchers/sell', { voucher_id: id }).then(function(r) {
    toast('Vendida: ' + r.code, 'ok');
    loadVouchers(_vPage);
    loadDashboard();
  }).catch(function(e) { toast(e.error || 'Error', 'error'); });
}

function revokeVoucher(id, code) {
  if (!confirm('¿Revocar la ficha ' + code + '? Se eliminará del router.')) return;
  apiFetch('POST', '/api/vouchers/revoke/' + id).then(function() {
    toast('Ficha ' + code + ' revocada', 'ok');
    loadVouchers(_vPage);
  }).catch(function(e) { toast(e.error || 'Error', 'error'); });
}

function borrarTodasLasFichas() {
  if (!confirm('⚠️ ¿Estás seguro de que deseas eliminar TODAS las fichas de la base de datos?\n\nEsta acción borrará todas las fichas de prueba en Firestore y en el servidor para que puedas comenzar desde cero.')) {
    return;
  }
  var btn = document.getElementById('btnBorrarFichas');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Borrando…';
  }

  var pFirestore = (window.firebaseDb && window.firebaseDb.clearAllVouchers)
    ? window.firebaseDb.clearAllVouchers()
    : Promise.resolve();

  var pBackend = httpApiFetch('POST', '/api/vouchers/clear-all', {}).catch(function(){});

  Promise.all([pFirestore, pBackend]).then(function() {
    toast('¡Base de datos limpiada con éxito! Ya no hay fichas de prueba.', 'ok');
    loadVouchers(1);
    if (typeof loadDashboard === 'function') loadDashboard();
  }).catch(function(err) {
    toast('Error al borrar fichas: ' + (err.message || err), 'error');
  }).finally(function() {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🗑️ Vaciar Fichas de Prueba';
    }
  });
}

/* ══════════════════════════════════════════════════════════
   PLANES
══════════════════════════════════════════════════════════ */
var _editingPlanId = null;

function loadPlans() {
  apiFetch('GET', '/api/plans/all').then(function(plans) {
    var tbody = document.getElementById('plansBody');
    tbody.innerHTML = '';
    plans.forEach(function(p) {
      var tr = tbody.insertRow();
      td(tr, p.name);
      td(tr, p.duration);
      td(tr, p.speed_limit);
      td(tr, fmtMoney(p.price));
      td(tr, p.data_limit || '∞');
      td(tr, p.shared_users);
      var sTd = tr.insertCell();
      sTd.appendChild(el('span', { className:'badge badge-' + (p.is_active ? 'active' : 'expired') },
        p.is_active ? 'Activo' : 'Inactivo'));
      var acts = tr.insertCell();
      var bEdit = el('button', { className:'btn btn-sm btn-ghost' }, '✏️');
      bEdit.addEventListener('click', function() { openPlanModal(p); });
      acts.appendChild(bEdit);
      if (p.is_active) {
        var bDel = el('button', { className:'btn btn-sm btn-danger', style:'margin-left:6px' }, 'Desactivar');
        bDel.addEventListener('click', function() { disablePlan(p.id); });
        acts.appendChild(bDel);
      }
      var bTrash = el('button', { className:'btn btn-sm btn-ghost', style:'margin-left:6px; color:#ff8a80;', title:'Eliminar definitivamente' }, '🗑️');
      bTrash.addEventListener('click', function() { deletePlanPermanent(p.id, p.name); });
      acts.appendChild(bTrash);
    });
  });
}

function deletePlanPermanent(id, name) {
  if (!confirm('¿Eliminar definitivamente el plan "' + (name || id) + '"?')) return;
  var action = (window.firebaseDb && window.firebaseDb.deletePlanPermanent)
    ? window.firebaseDb.deletePlanPermanent(id)
    : apiFetch('DELETE', '/api/plans/' + id);

  action.then(function() {
    toast('Plan eliminado permanentemente', 'ok');
    loadPlans();
  }).catch(function(e) {
    console.error('Error al eliminar plan:', e);
    toast((e && e.message) || (e && e.error) || 'Error al eliminar', 'error');
  });
}

function openPlanModal(plan) {
  _editingPlanId = plan ? plan.id : null;
  document.getElementById('planModalTitle').textContent = plan ? 'Editar Plan' : 'Nuevo Plan';
  if (plan) {
    document.getElementById('pName').value      = plan.name;
    document.getElementById('pDuration').value  = plan.duration;
    document.getElementById('pSpeed').value     = plan.speed_limit;
    document.getElementById('pPrice').value     = plan.price;
    document.getElementById('pDataLimit').value = plan.data_limit || '';
    document.getElementById('pShared').value    = plan.shared_users;
    document.getElementById('pProfile').value   = plan.profile_name || 'default';
    document.getElementById('pDesc').value      = plan.description || '';
  } else {
    document.getElementById('planForm').reset();
    document.getElementById('pProfile').value = 'default';
    document.getElementById('pShared').value  = '1';
  }
  document.getElementById('planModalBg').hidden = false;
}

function closePlanModal(e) {
  if (e && e.target !== document.getElementById('planModalBg')) return;
  document.getElementById('planModalBg').hidden = true;
  _editingPlanId = null;
}

document.getElementById('planForm').addEventListener('submit', savePlan);

function savePlan(e) {
  e.preventDefault();
  var submitBtn = document.querySelector('#planForm button[type="submit"]');
  if (submitBtn) {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';
  }

  var body = {
    name:        document.getElementById('pName').value.trim(),
    duration:    document.getElementById('pDuration').value.trim().toLowerCase(),
    speed_limit: document.getElementById('pSpeed').value.trim(),
    price:       parseFloat(document.getElementById('pPrice').value),
    data_limit:  document.getElementById('pDataLimit').value.trim() || null,
    shared_users: parseInt(document.getElementById('pShared').value, 10) || 1,
    profile_name: document.getElementById('pProfile').value.trim() || 'default',
    description: document.getElementById('pDesc').value.trim(),
    is_active:   1,
  };

  var url    = _editingPlanId ? '/api/plans/' + _editingPlanId : '/api/plans';
  var method = _editingPlanId ? 'PUT' : 'POST';

  apiFetch(method, url, body).then(function() {
    httpApiFetch('POST', '/api/mikrotik/sync/plan-sync', body).catch(function(){});

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Guardar Plan'; }
    toast(_editingPlanId ? 'Plan actualizado' : 'Plan creado', 'ok');
    document.getElementById('planModalBg').hidden = true;
    _editingPlanId = null;
    loadPlans();
  }).catch(function(err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Guardar Plan'; }
    toast((err && err.error) || 'Error al guardar el plan', 'error');
  });
}

function disablePlan(id) {
  if (!confirm('¿Desactivar este plan?')) return;
  apiFetch('DELETE', '/api/plans/' + id).then(function() {
    toast('Plan desactivado', 'ok');
    loadPlans();
  }).catch(function(e) { toast(e.error || 'Error', 'error'); });
}

/* ══════════════════════════════════════════════════════════
   MIKROTIK
══════════════════════════════════════════════════════════ */
var _mkRealtimeUnsub = null;

function renderMikrotikCard(r) {
  var box = document.getElementById('mkStatus');
  if (!box) return;
  box.textContent = '';

  var okSpan = el('span', { className: 'mk-status-ok' }, r.syncMode ? ('✅ ' + r.syncMode) : '✅ Conectado correctamente');
  box.appendChild(okSpan);

  var grid = el('div', { className: 'mk-info-grid' });
  grid.appendChild(mkCardEl('Versión RouterOS', r.version));
  grid.appendChild(mkCardEl('Uptime', r.uptime));
  grid.appendChild(mkCardEl('CPU', (r.cpuLoad !== undefined && r.cpuLoad !== null ? r.cpuLoad : '—') + '%'));
  grid.appendChild(mkCardEl('RAM libre', fmtBytes(r.freeMemory)));
  box.appendChild(grid);
}

function loadCloudSyncScriptCard() {
  var cmdBox = document.getElementById('cloudSyncCmdBox');
  if (!cmdBox) return;
  httpApiFetch('GET', '/api/mikrotik/sync/setup-script').then(function(res) {
    cmdBox.textContent = (res && res.script) ? res.script : 'No disponible.';
  }).catch(function() {
    cmdBox.textContent = 'No se pudo cargar el script autenticado desde el backend.';
  });
}

function loadMikrotikSection() {
  testMikrotik();
  loadCloudSyncScriptCard();
  loadActiveUsers();
  loadSyncLog();
}

function testMikrotik() {
  var box = document.getElementById('mkStatus');
  if (!box) return;
  box.textContent = '';
  box.appendChild(el('span', { style: 'color:var(--muted)' }, '⏳ Verificando enlace con router y nube…'));

  var handled = false;

  if (window.firebaseDb && window.firebaseDb.onMikrotikStatusChange) {
    if (_mkRealtimeUnsub) _mkRealtimeUnsub();
    _mkRealtimeUnsub = window.firebaseDb.onMikrotikStatusChange(function(r) {
      if (!r) return;
      var lastSeenMs = r.lastSeen ? new Date(r.lastSeen).getTime() : 0;
      var isAlive = (Date.now() - lastSeenMs) < 120000;
      if (isAlive && r.status === 'online') {
        handled = true;
        renderMikrotikCard(r);
      }
    });
  }

  apiFetch('GET', '/api/mikrotik/test').then(function(r) {
    if (r.ok) {
      handled = true;
      renderMikrotikCard(r);
    } else if (!handled) {
      box.textContent = '';
      box.appendChild(el('span', { className: 'mk-status-err' }, '❌ ' + (r.error || 'Sin conexión')));
    }
  }).catch(function(e) {
    setTimeout(function() {
      if (!handled) {
        box.textContent = '';
        box.appendChild(el('span', { className: 'mk-status-err' }, '❌ ' + ((e && e.error) || 'Sin conexión')));
      }
    }, 2500);
  });
}

function mkCardEl(label, val) {
  var card = el('div', { className: 'mk-info-card' });
  card.appendChild(el('div', { className: 'mk-info-label' }, label));
  card.appendChild(el('div', { className: 'mk-info-val' }, val || '—'));
  return card;
}

function fmtBytes(b) {
  if (!b) return '—';
  b = parseInt(b);
  if (b > 1073741824) return (b/1073741824).toFixed(1) + ' GB';
  if (b > 1048576)    return (b/1048576).toFixed(1)    + ' MB';
  return (b/1024).toFixed(0) + ' KB';
}

function loadActiveUsers() {
  apiFetch('GET', '/api/mikrotik/active').then(function(users) {
    var tbody = document.getElementById('activeBody');
    tbody.innerHTML = '';
    if (!Array.isArray(users) || !users.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">Sin usuarios activos</td></tr>';
      return;
    }
    users.forEach(function(u) {
      var tr = tbody.insertRow();
      td(tr, u.user || u.name || '—');
      td(tr, u.address || '—');
      td(tr, u.uptime  || '—');
      td(tr, fmtBytes(u['bytes-in']) + ' / ' + fmtBytes(u['bytes-out']));
    });
  }).catch(function(){});
}

function loadSyncLog() {
  apiFetch('GET', '/api/mikrotik/sync-log?limit=50').then(function(logs) {
    var tbody = document.getElementById('syncBody');
    tbody.innerHTML = '';
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center">Sin registros</td></tr>';
      return;
    }
    logs.forEach(function(l) {
      var tr = tbody.insertRow();
      td(tr, fmtDate(l.created_at));
      td(tr, l.action);
      td(tr, l.voucher_code || '—');
      var sTd = tr.insertCell();
      sTd.appendChild(el('span', { className:'badge badge-' + (l.status==='success'?'success':'error') }, l.status));
      td(tr, l.duration_ms != null ? l.duration_ms + 'ms' : '—');
      var resp = tr.insertCell();
      resp.textContent = (l.response || '').slice(0, 60);
      resp.style.maxWidth = '200px';
      resp.style.overflow = 'hidden';
      resp.style.textOverflow = 'ellipsis';
      resp.style.whiteSpace = 'nowrap';
    });
  }).catch(function(){});
}

/* ══════════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════════ */
function td(tr, text) {
  var c = tr.insertCell();
  c.textContent = text !== undefined && text !== null ? text : '—';
  return c;
}

/* ── Cargar filtro de planes en sección Fichas ──────────── */
function loadPlanFilterDropdown() {
  apiFetch('GET', '/api/plans').then(function(plans) {
    var sel = document.getElementById('fPlan');
    while (sel.options.length > 1) sel.remove(1);
    plans.forEach(function(p) {
      var opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      sel.appendChild(opt);
    });
  }).catch(function(){});
}

/* ══════════════════════════════════════════════════════════
   PORTAL & INFO BALNEARIO
══════════════════════════════════════════════════════════ */
window.handleOnlinePurchaseSwitchChange = function(isActive, isUserAction) {
  var badge = document.getElementById('onlinePurchaseBadge');
  var notice = document.getElementById('onlinePurchaseDisabledNotice');
  var fields = document.getElementById('onlinePurchaseFieldsWrap');
  if (badge) {
    if (isActive) {
      badge.textContent = '● ACTIVO EN EL PORTAL';
      badge.className = 'badge badge-success';
    } else {
      badge.textContent = '○ DESACTIVADO (Solo Casetas Físicas)';
      badge.className = 'badge badge-warning';
    }
  }
  if (notice) notice.style.display = isActive ? 'none' : 'block';
  if (fields) {
    fields.style.opacity = isActive ? '1' : '0.45';
    fields.style.pointerEvents = isActive ? 'auto' : 'none';
  }

  // Si fue accionado por el usuario (click en el switch), auto-guardar DE INMEDIATO
  if (isUserAction) {
    window.saveOnlinePurchaseCardNow();
  }
};

window.saveOnlinePurchaseCardNow = function() {
  var chk = document.getElementById('setOnlinePurchaseActive');
  var isActive = chk ? chk.checked : true;
  var payPhone = document.getElementById('setPaymentPhone') ? document.getElementById('setPaymentPhone').value.trim() : '3174251419';
  var waNum = document.getElementById('setWhatsappNumber') ? document.getElementById('setWhatsappNumber').value.trim() : '';
  var waMsg = document.getElementById('setWhatsappMessage') ? document.getElementById('setWhatsappMessage').value : '';

  var data = {
    online_purchase_active: isActive ? '1' : '0',
    payment_phone: payPhone,
    whatsapp_number: waNum,
    whatsapp_message: waMsg
  };

  var badge = document.getElementById('onlinePurchaseBadge');
  if (badge) badge.textContent = '⏳ Guardando...';

  var pFirestore = (window.firebaseDb && window.firebaseDb.saveSettings)
    ? window.firebaseDb.saveSettings(data).catch(function(e) { console.warn('[Admin] Firestore auto-save:', e); return null; })
    : Promise.resolve(null);

  var pBackend = apiFetch('PUT', '/api/settings', data).catch(function(e) {
    console.warn('[Admin] Backend auto-save:', e);
    return null;
  });

  Promise.all([pFirestore, pBackend]).then(function() {
    if (badge) {
      if (isActive) {
        badge.textContent = '● ACTIVO EN EL PORTAL';
        badge.className = 'badge badge-success';
      } else {
        badge.textContent = '○ DESACTIVADO (Solo Casetas Físicas)';
        badge.className = 'badge badge-warning';
      }
    }
    toast(isActive ? '✅ Acordeón de compra en línea ACTIVADO en el portal' : '⚠️ Acordeón de compra en línea DESACTIVADO en el portal', 'ok');
  }).catch(function(err) {
    toast('Error al guardar cambio: ' + ((err && err.message) || 'Error de conexión'), 'error');
  });
};

function loadPortalSettings() {
  apiFetch('GET', '/api/settings').then(function(s) {
    var nameEl      = document.getElementById('setBusinessName');
    var sloganEl    = document.getElementById('setBusinessSlogan');
    var waEl        = document.getElementById('setWhatsappNumber');
    var payPhoneEl  = document.getElementById('setPaymentPhone');
    var onlinePayEl = document.getElementById('setOnlinePurchaseActive');
    var waMsgEl     = document.getElementById('setWhatsappMessage');
    var actEl       = document.getElementById('setInfoActive');
    var badgeEl     = document.getElementById('setInfoBadge');
    var titleEl     = document.getElementById('setInfoTitle');
    var contentEl   = document.getElementById('setInfoContent');

    if (nameEl)      nameEl.value      = s.business_name || '';
    if (sloganEl)    sloganEl.value    = s.business_slogan || '';
    if (waEl)        waEl.value        = s.whatsapp_number || '';
    if (payPhoneEl)  payPhoneEl.value  = s.payment_phone || '3174251419';
    if (onlinePayEl) {
      var isOnline = (s.online_purchase_active !== '0' && s.online_purchase_active !== 0 && s.online_purchase_active !== false && s.online_purchase_active !== 'false');
      onlinePayEl.checked = isOnline;
      if (window.handleOnlinePurchaseSwitchChange) window.handleOnlinePurchaseSwitchChange(isOnline, false);
    }
    if (waMsgEl)     waMsgEl.value     = s.whatsapp_message || '';
    if (actEl)       actEl.checked     = (s.info_active === '1' || s.info_active === 1 || s.info_active === true);
    if (badgeEl)     badgeEl.value     = s.info_badge || '';
    if (titleEl)     titleEl.value     = s.info_title || '';
    if (contentEl)   contentEl.value   = s.info_content || '';
  }).catch(function(err) {
    toast((err && err.error) || 'Error al cargar ajustes del portal', 'error');
  });
}

function savePortalSettings(e) {
  e.preventDefault();
  var btn = document.getElementById('btnSavePortal');
  if (btn) btn.disabled = true;

  var onlinePayChecked = document.getElementById('setOnlinePurchaseActive') ? document.getElementById('setOnlinePurchaseActive').checked : true;
  var paymentPhoneVal  = document.getElementById('setPaymentPhone') ? document.getElementById('setPaymentPhone').value.trim() : '3174251419';

  var body = {
    business_name:          document.getElementById('setBusinessName').value,
    business_slogan:        document.getElementById('setBusinessSlogan').value,
    whatsapp_number:        document.getElementById('setWhatsappNumber').value,
    payment_phone:          paymentPhoneVal || '3174251419',
    online_purchase_active: onlinePayChecked ? '1' : '0',
    whatsapp_message:       document.getElementById('setWhatsappMessage').value,
    info_active:            document.getElementById('setInfoActive').checked ? '1' : '0',
    info_badge:             document.getElementById('setInfoBadge').value,
    info_title:             document.getElementById('setInfoTitle').value,
    info_content:           document.getElementById('setInfoContent').value,
  };

  // Dual-write: Guardar en Firestore (para actualizar portal cautivo en tiempo real) y en Render backend
  var pFirestore = (window.firebaseDb && window.firebaseDb.saveSettings)
    ? window.firebaseDb.saveSettings(body).catch(function(e) { console.warn('[Admin] Firestore save:', e); return null; })
    : Promise.resolve(null);

  var pBackend = apiFetch('PUT', '/api/settings', body).catch(function(e) {
    console.warn('[Admin] Backend save:', e);
    return null;
  });

  Promise.all([pFirestore, pBackend]).then(function() {
    if (btn) btn.disabled = false;
    toast('Configuración guardada en la nube y portal cautivo', 'ok');
    if (body.business_name) {
      document.getElementById('topbarTitle').textContent = body.business_name;
      document.title = 'Admin — ' + body.business_name;
    }
  }).catch(function(err) {
    if (btn) btn.disabled = false;
    toast((err && err.error) || 'Error al guardar configuración', 'error');
  });
}

/* ══════════════════════════════════════════════════════════
   WHATSAPP BOT & IA
══════════════════════════════════════════════════════════ */
var _waPollInterval = null;
var _lastWhatsAppStatus = null;
try {
  _lastWhatsAppStatus = JSON.parse(localStorage.getItem('wa_last_status') || 'null');
} catch (_) {}

function loadWhatsAppSection() {
  if (_lastWhatsAppStatus) {
    renderWhatsAppCard(_lastWhatsAppStatus);
  }
  checkWhatsAppStatus();
  loadWhatsAppPayments();
  loadWhatsAppStrikes();

  if (_waPollInterval) clearInterval(_waPollInterval);
  _waPollInterval = setInterval(function() {
    var sec = document.getElementById('sec-whatsapp');
    if (sec && !sec.hidden) {
      checkWhatsAppStatus();
    } else {
      clearInterval(_waPollInterval);
      _waPollInterval = null;
    }
  }, 4000);
}

var _waRealtimeUnsub = null;

function renderWhatsAppCard(s) {
  var pill = document.getElementById('waStatusPill');
  var qrBox = document.getElementById('waQrBox');
  var qrImg = document.getElementById('waQrImg');
  var connBox = document.getElementById('waConnectedBox');
  var discBox = document.getElementById('waDisconnectedBox');
  var userEl = document.getElementById('waConnectedUser');
  var botNumDisp = document.getElementById('waBotNumberDisplay');

  if (!pill || !s) return;

  var u = s.user;
  if (typeof u === 'string' && u.startsWith('{')) {
    try { u = JSON.parse(u); } catch(_) { u = null; }
  }

  var botPhoneStr = s.botPhone;
  if (!botPhoneStr && u && u.id) {
    botPhoneStr = u.id.split(':')[0].replace(/\D/g, '');
  }

  if (botNumDisp) {
    if (botPhoneStr) {
      botNumDisp.textContent = '+' + botPhoneStr;
    } else {
      botNumDisp.textContent = 'Auto-detectado al escanear';
    }
  }

  if (s.status === 'connected') {
    pill.textContent = '🟢 Conectado';
    pill.style.background = 'rgba(74, 222, 128, 0.2)';
    pill.style.color = '#4ade80';
    if (qrBox) qrBox.style.display = 'none';
    if (discBox) discBox.style.display = 'none';
    if (connBox) connBox.style.display = 'block';

    var userDisplayName = (u && u.name) ? u.name : (botPhoneStr ? ('+' + botPhoneStr) : 'Dispositivo WhatsApp');
    if (userEl) {
      userEl.textContent = 'Vinculado a: ' + userDisplayName + (botPhoneStr && (!u || !u.name || !u.name.includes(botPhoneStr)) ? (' (+' + botPhoneStr + ')') : '');
    }

    if (botPhoneStr) {
      var cleanBot = String(botPhoneStr).replace(/\D/g, '');
      var setWaInput = document.getElementById('setWhatsappNumber');
      if (setWaInput && (!setWaInput.value || setWaInput.value === '573123456789' || setWaInput.value === '3174251419')) {
        setWaInput.value = cleanBot;
      }
      if (window.firebaseDb && window.firebaseDb.saveSettings && cleanBot !== window._lastSyncedBotNumber) {
        window._lastSyncedBotNumber = cleanBot;
        window.firebaseDb.saveSettings({ whatsapp_number: cleanBot });
      }
    }
  } else if (s.status === 'qr_ready') {
    pill.textContent = '🟡 Esperando Escaneo de QR';
    pill.style.background = 'rgba(250, 204, 21, 0.2)';
    pill.style.color = '#facc15';
    if (connBox) connBox.style.display = 'none';
    if (discBox) discBox.style.display = 'none';
    if (qrBox) {
      qrBox.style.display = 'block';
      if (s.qrCodeDataUrl) {
        qrImg.src = s.qrCodeDataUrl;
      }
    }
  } else if (s.status === 'connecting') {
    pill.textContent = '🔄 Conectando / Generando QR...';
    pill.style.background = 'rgba(56, 189, 248, 0.2)';
    pill.style.color = '#38bdf8';
    if (qrBox) qrBox.style.display = 'none';
    if (connBox) connBox.style.display = 'none';
    if (discBox) discBox.style.display = 'none';
  } else if (s.status === 'disabled') {
    pill.textContent = '⚪ Desactivado (WHATSAPP_ENABLED=false)';
    pill.style.background = 'rgba(255, 255, 255, 0.1)';
    pill.style.color = 'var(--muted)';
    if (qrBox) qrBox.style.display = 'none';
    if (connBox) connBox.style.display = 'none';
    if (discBox) discBox.style.display = 'none';
  } else {
    pill.textContent = '🔴 Desconectado';
    pill.style.background = 'rgba(248, 113, 113, 0.2)';
    pill.style.color = '#f87171';
    if (qrBox) qrBox.style.display = 'none';
    if (connBox) connBox.style.display = 'none';
    if (discBox) discBox.style.display = 'block';
  }
}

function checkWhatsAppStatus() {
  if (window.firebaseDb && window.firebaseDb.onWhatsAppStatusChange) {
    if (!_waRealtimeUnsub) {
      _waRealtimeUnsub = window.firebaseDb.onWhatsAppStatusChange(function(data) {
        _lastWhatsAppStatus = data;
        try { localStorage.setItem('wa_last_status', JSON.stringify(data)); } catch(_) {}
        renderWhatsAppCard(data);
      });
    } else if (_lastWhatsAppStatus) {
      renderWhatsAppCard(_lastWhatsAppStatus);
    }
  } else {
    apiFetch('GET', '/api/whatsapp/status').then(function(data) {
      _lastWhatsAppStatus = data;
      try { localStorage.setItem('wa_last_status', JSON.stringify(data)); } catch(_) {}
      renderWhatsAppCard(data);
    }).catch(function(){});
  }
}

function requestNewQr() {
  var btn = document.getElementById('btnRequestQr');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Generando QR...';
  }
  httpApiFetch('POST', '/api/whatsapp/restart', {}).catch(function(){});

  toast('Solicitando código QR en tiempo real...', 'ok');
  setTimeout(function() {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Generar Código QR';
    }
  }, 4000);
}

function disconnectWhatsApp() {
  if (!confirm('¿Estás seguro de que deseas desvincular el WhatsApp actual? El bot dejará de atender hasta que vincules un nuevo número.')) return;
  apiFetch('POST', '/api/whatsapp/logout').then(function(res) {
    toast(res.message || 'Sesión de WhatsApp cerrada', 'ok');
    localStorage.removeItem('wa_last_status');
    _lastWhatsAppStatus = { status: 'connecting' };
    renderWhatsAppCard(_lastWhatsAppStatus);
  }).catch(function(err) {
    toast('Desvinculando WhatsApp en la nube...', 'ok');
    localStorage.removeItem('wa_last_status');
    _lastWhatsAppStatus = { status: 'connecting' };
    renderWhatsAppCard(_lastWhatsAppStatus);
  });
}

function loadWhatsAppPayments() {
  var tbody = document.getElementById('waPaymentsBody');
  if (!tbody) return;

  apiFetch('GET', '/api/whatsapp/payments?limit=30').then(function(data) {
    tbody.innerHTML = '';
    if (!data.payments || !data.payments.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">No hay pagos procesados por WhatsApp todavía.</td></tr>';
      return;
    }

    data.payments.forEach(function(p) {
      var tr = document.createElement('tr');
      td(tr, fmtDate(p.created_at));
      var phTd = tr.insertCell();
      phTd.appendChild(el('strong', null, p.sender_phone || '—'));
      var plTd = tr.insertCell();
      plTd.appendChild(el('span', { className: 'badge' }, p.platform || 'Daviplata'));
      var rfTd = tr.insertCell();
      rfTd.appendChild(el('code', null, p.reference_number || '—'));
      var amTd = tr.insertCell();
      amTd.style.color = '#4ade80';
      amTd.style.fontWeight = 'bold';
      amTd.textContent = fmtMoney(p.amount);
      td(tr, p.plan_name ? (p.plan_name + ' (' + p.plan_duration + ')') : '—');
      var vcTd = tr.insertCell();
      var vcStrong = el('strong', null, p.voucher_code || '—');
      vcStrong.style.color = 'var(--cyan)';
      vcTd.appendChild(vcStrong);
      tbody.appendChild(tr);
    });
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error cargando historial de pagos.</td></tr>';
  });
}

function loadWhatsAppStrikes() {
  var tbody = document.getElementById('waStrikesBody');
  if (!tbody) return;

  apiFetch('GET', '/api/whatsapp/strikes').then(function(data) {
    tbody.innerHTML = '';
    var list = Array.isArray(data) ? data : (data.strikes || []);
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted)">Sin números sospechosos ni bloqueados registrados.</td></tr>';
      return;
    }

    list.forEach(function(s) {
      var tr = document.createElement('tr');
      var pTd = tr.insertCell();
      pTd.appendChild(el('strong', null, s.phone || '—'));

      var stTd = tr.insertCell();
      stTd.appendChild(el('span', { className: 'stat-pill' }, (s.strikes || 0) + ' / 2'));

      var statTd = tr.insertCell();
      var badgeSpan = document.createElement('span');
      badgeSpan.className = 'badge';
      if (s.is_blocked || (s.blocked_until && new Date(s.blocked_until) > new Date())) {
        badgeSpan.style.cssText = 'background:rgba(248,113,113,0.2); color:#f87171; font-weight:bold;';
        badgeSpan.textContent = '🚫 Bloqueado hasta ' + fmtDate(s.blocked_until);
      } else if (s.strikes > 0) {
        badgeSpan.style.cssText = 'background:rgba(250,204,21,0.2); color:#facc15;';
        badgeSpan.textContent = '⚠️ ' + s.strikes + ' Strike(s)';
      } else {
        badgeSpan.style.cssText = 'background:rgba(74,222,128,0.2); color:#4ade80;';
        badgeSpan.textContent = 'Normal';
      }
      statTd.appendChild(badgeSpan);

      var rsnTd = td(tr, s.last_reason || '—');
      rsnTd.style.fontSize = '12px';
      rsnTd.style.color = 'var(--muted)';

      td(tr, fmtDate(s.updated_at));

      var actTd = tr.insertCell();
      var bUnblock = el('button', { type: 'button', className: 'btn btn-sm btn-ghost', title: 'Desbloquear y limpiar strikes' }, '🔓 Desbloquear');
      bUnblock.addEventListener('click', function() { unblockPhone(s.phone); });
      actTd.appendChild(bUnblock);

      tbody.appendChild(tr);
    });
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#f87171">Error al consultar registros de seguridad.</td></tr>';
  });
}

function unblockPhone(phone) {
  if (!confirm('¿Deseas desbloquear y reiniciar los strikes para el número ' + phone + '?')) return;
  apiFetch('POST', '/api/whatsapp/unblock', { phone: phone }).then(function(res) {
    toast(res.message || 'Número desbloqueado', 'ok');
    loadWhatsAppStrikes();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al desbloquear', 'error');
  });
}

/* ══════════════════════════════════════════════════════════
   GESTIÓN DE KIOSKOS Y CASETAS FÍSICAS
══════════════════════════════════════════════════════════ */
var _currentKiosks = [];

function loadKiosksSection() {
  httpApiFetch('POST', '/api/kiosks/sync', {}).catch(function(){});
  var tbody = document.getElementById('kiosksBody');
  if (!tbody) return;

  apiFetch('GET', '/api/kiosks?all=true').then(function(kiosks) {
    _currentKiosks = kiosks || [];
    tbody.textContent = '';
    if (!_currentKiosks.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">No hay casetas registradas. Haz clic en "Nueva Caseta / Kiosko" para agregar una.</td></tr>';
      return;
    }

    _currentKiosks.forEach(function(k) {
      var tr = document.createElement('tr');
      td(tr, k.sort_order || 0);

      var nameTd = tr.insertCell();
      nameTd.appendChild(el('strong', null, k.name || ''));

      td(tr, k.location || '');
      td(tr, k.contact || '—');

      var notesTd = td(tr, k.notes || '—');
      notesTd.style.fontSize = '12px';
      notesTd.style.color = 'var(--muted)';

      var statTd = tr.insertCell();
      var badge = el('span', { className: 'badge' }, k.is_active ? 'Activo' : 'Inactivo');
      badge.style.cssText = k.is_active
        ? 'background:rgba(74,222,128,0.2); color:#4ade80;'
        : 'background:rgba(255,255,255,0.1); color:var(--muted);';
      statTd.appendChild(badge);

      var actTd = tr.insertCell();
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex; gap:6px;';

      var bEdit = el('button', { type: 'button', className: 'btn btn-sm btn-ghost btn-edit-kiosk', title: 'Editar' }, '✏️');
      bEdit.addEventListener('click', function() { editKiosk(k.id); });

      var bToggle = el('button', { type: 'button', className: 'btn btn-sm btn-ghost btn-toggle-kiosk', title: 'Activar/Desactivar' }, k.is_active ? '⏸️' : '▶️');
      bToggle.addEventListener('click', function() { toggleKiosk(k.id); });

      var bDel = el('button', { type: 'button', className: 'btn btn-sm btn-danger btn-delete-kiosk', title: 'Eliminar' }, '🗑️');
      bDel.addEventListener('click', function() { deleteKiosk(k.id); });

      wrap.appendChild(bEdit);
      wrap.appendChild(bToggle);
      wrap.appendChild(bDel);
      actTd.appendChild(wrap);
      tbody.appendChild(tr);
    });
  }).catch(function() {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error cargando casetas y kioskos.</td></tr>';
  });
}

function openKioskModal(kiosk) {
  var bg = document.getElementById('kioskModalBg');
  var form = document.getElementById('kioskForm');
  var title = document.getElementById('kioskModalTitle');

  if (form) form.reset();
  if (kiosk) {
    if (title) title.textContent = 'Editar Caseta / Kiosko';
    var idEl = document.getElementById('kioskId');
    if (idEl) idEl.value = kiosk.id;
    var nameEl = document.getElementById('kName');
    if (nameEl) nameEl.value = kiosk.name || '';
    var locEl = document.getElementById('kLocation');
    if (locEl) locEl.value = kiosk.location || '';
    var contactEl = document.getElementById('kContact');
    if (contactEl) contactEl.value = kiosk.contact || '';
    var sortEl = document.getElementById('kSortOrder');
    if (sortEl) sortEl.value = kiosk.sort_order || 1;
    var notesEl = document.getElementById('kNotes');
    if (notesEl) notesEl.value = kiosk.notes || '';
  } else {
    if (title) title.textContent = 'Nueva Caseta / Kiosko';
    var idEl2 = document.getElementById('kioskId');
    if (idEl2) idEl2.value = '';
    var sortEl2 = document.getElementById('kSortOrder');
    if (sortEl2) sortEl2.value = (_currentKiosks.length + 1);
  }

  if (bg) bg.removeAttribute('hidden');
}

function closeKioskModal(e) {
  if (e && e.target && e.target.id !== 'kioskModalBg' && !e.target.classList.contains('modal-close')) return;
  var bg = document.getElementById('kioskModalBg');
  if (bg) bg.setAttribute('hidden', '');
}

function editKiosk(id) {
  var k = _currentKiosks.find(function(item) { return String(item.id) === String(id); });
  if (k) {
    openKioskModal(k);
  } else {
    console.warn('[Admin] Kiosk not found in cache, loading from server for ID:', id);
    apiFetch('GET', '/api/kiosks?all=true').then(function(kiosks) {
      _currentKiosks = kiosks || [];
      var found = _currentKiosks.find(function(item) { return String(item.id) === String(id); });
      if (found) openKioskModal(found);
    });
  }
}

function toggleKiosk(id) {
  var k = _currentKiosks.find(function(item) { return String(item.id) === String(id); });
  var kName = k ? k.name : id;
  apiFetch('PATCH', '/api/kiosks/' + encodeURIComponent(id) + '/toggle').then(function(res) {
    toast(res.message || ('Estado de ' + kName + ' actualizado'), 'ok');
    loadKiosksSection();
  }).catch(function(err) {
    console.error('Error toggleKiosk:', err);
    toast((err && (err.message || err.error)) || 'Error al cambiar estado', 'error');
  });
}

function deleteKiosk(id) {
  var k = _currentKiosks.find(function(item) { return String(item.id) === String(id); });
  var kName = k ? k.name : id;
  if (!confirm('¿Estás seguro de que deseas eliminar el punto de venta "' + kName + '"?')) return;
  apiFetch('DELETE', '/api/kiosks/' + encodeURIComponent(id)).then(function(res) {
    toast(res.message || 'Punto de venta eliminado', 'ok');
    loadKiosksSection();
  }).catch(function(err) {
    console.error('Error deleteKiosk:', err);
    toast((err && (err.message || err.error)) || 'Error al eliminar kiosko', 'error');
  });
}

// Exportar explícitamente a window para invocaciones globales desde onclick en HTML móvil y desktop
window.loadKiosksSection = loadKiosksSection;
window.openKioskModal    = openKioskModal;
window.closeKioskModal   = closeKioskModal;
window.editKiosk         = editKiosk;
window.toggleKiosk       = toggleKiosk;
window.deleteKiosk       = deleteKiosk;

// Guardar formulario de Kiosko
var kioskForm = document.getElementById('kioskForm');
if (kioskForm) {
  kioskForm.addEventListener('submit', function(e) {
    e.preventDefault();
    var id = document.getElementById('kioskId').value;
    var body = {
      name: document.getElementById('kName').value.trim(),
      location: document.getElementById('kLocation').value.trim(),
      contact: document.getElementById('kContact').value.trim(),
      sort_order: parseInt(document.getElementById('kSortOrder').value, 10) || 1,
      notes: document.getElementById('kNotes').value.trim(),
    };

    var method = id ? 'PUT' : 'POST';
    var url = id ? ('/api/kiosks/' + id) : '/api/kiosks';

    apiFetch(method, url, body).then(function(res) {
      toast(res.message || 'Caseta guardada exitosamente', 'ok');
      closeKioskModal();
      loadKiosksSection();
    }).catch(function(err) {
      toast((err && err.error) || 'Error al guardar caseta', 'error');
    });
  });
}

/* ══════════════════════════════════════════════════════════
   GESTIÓN DE QUEJAS, RECLAMOS Y SOPORTE (PQRS)
══════════════════════════════════════════════════════════ */
var _currentComplaints = [];

function loadComplaintsSection() {
  var tbody = document.getElementById('complaintsBody');
  var badge = document.getElementById('complaintPendingBadge');
  var statusFilter = document.getElementById('filterComplaintStatus');
  var statusVal = statusFilter ? statusFilter.value : 'pending';

  if (!tbody) return;

  function renderList(data) {
    _currentComplaints = data.complaints || [];
    if (badge) {
      badge.textContent = (data.pending || 0) + ' pendientes';
    }

    tbody.innerHTML = '';
    if (!_currentComplaints.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">No hay registros en esta categoría de PQRS.</td></tr>';
      return;
    }

    _currentComplaints.forEach(function(c) {
      var tr = document.createElement('tr');
      var radicado = c.radicado || ('PQRS-' + String(c.id).padStart(4, '0'));

      var radTd = tr.insertCell();
      radTd.appendChild(el('strong', null, '#' + radicado));

      var dtTd = td(tr, fmtDate(c.created_at));
      dtTd.style.whiteSpace = 'nowrap';

      var phTd = tr.insertCell();
      var cleanPhone = String(c.phone || '').replace(/\D/g, '');
      var phoneDisplay = cleanPhone || c.phone || '—';
      if (cleanPhone) {
        var waHref = 'https://wa.me/' + (cleanPhone.startsWith('57') ? cleanPhone : ('57' + cleanPhone));
        var linkEl = el('a', { href: waHref, target: '_blank', rel: 'noopener noreferrer', title: 'Chatear en WhatsApp' });
        linkEl.style.cssText = 'color:var(--cyan); text-decoration:none;';
        linkEl.appendChild(document.createTextNode('💬 '));
        if (c.client_name) {
          linkEl.appendChild(el('strong', null, c.client_name));
          linkEl.appendChild(document.createTextNode(' (' + phoneDisplay + ')'));
        } else {
          linkEl.appendChild(document.createTextNode(phoneDisplay));
        }
        phTd.appendChild(linkEl);
      } else {
        phTd.textContent = c.client_name || c.phone || '—';
      }

      var msgTd = td(tr, c.message || '');
      msgTd.style.maxWidth = '280px';
      msgTd.style.wordBreak = 'break-word';

      var stTd = tr.insertCell();
      var stBadge = document.createElement('span');
      stBadge.className = 'badge';
      if (c.status === 'resolved') {
        stBadge.style.cssText = 'background:rgba(74,222,128,0.2); color:#4ade80;';
        stBadge.textContent = '✅ Resuelto';
      } else if (c.status === 'in_progress') {
        stBadge.style.cssText = 'background:rgba(56,189,248,0.2); color:#38bdf8;';
        stBadge.textContent = '🔄 En proceso';
      } else {
        stBadge.style.cssText = 'background:rgba(250,204,21,0.2); color:#facc15;';
        stBadge.textContent = '⏳ Pendiente';
      }
      stTd.appendChild(stBadge);

      var notesTd = td(tr, c.admin_notes || '—');
      notesTd.style.cssText = 'font-size:12px; color:var(--muted); max-width:200px;';

      var actTd = tr.insertCell();
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex; gap:6px;';
      var bAtt = el('button', { type: 'button', className: 'btn btn-sm btn-ghost', title: 'Atender / Responder' }, '✏️ Atender');
      bAtt.addEventListener('click', function() { openComplaintModal(c.id); });
      wrap.appendChild(bAtt);
      if (c.status !== 'resolved') {
        var bRes = el('button', { type: 'button', className: 'btn btn-sm btn-ghost', title: 'Marcar como Resuelto' }, '✅');
        bRes.addEventListener('click', function() { quickResolveComplaint(c.id); });
        wrap.appendChild(bRes);
      }
      var bDel = el('button', { type: 'button', className: 'btn btn-sm btn-danger', title: 'Eliminar' }, '🗑️');
      bDel.addEventListener('click', function() { deleteComplaint(c.id); });
      wrap.appendChild(bDel);
      actTd.appendChild(wrap);

      tbody.appendChild(tr);
    });
  }

  if (window.firebaseDb && window.firebaseDb.getComplaints) {
    window.firebaseDb.getComplaints(statusVal).then(renderList).catch(function() {
      apiFetch('GET', '/api/complaints?status=' + statusVal).then(renderList).catch(function() {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error al cargar la bandeja de quejas.</td></tr>';
      });
    });
  } else {
    apiFetch('GET', '/api/complaints?status=' + statusVal).then(renderList).catch(function() {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error al cargar la bandeja de quejas.</td></tr>';
    });
  }
}

var _activeComplaint = null;

function openComplaintModal(id) {
  var c = _currentComplaints.find(function(item) { return String(item.id) === String(id); });
  if (!c) return;
  _activeComplaint = c;

  var bg = document.getElementById('complaintModalBg');
  document.getElementById('cId').value = c.id;
  document.getElementById('cRadicado').textContent = '#' + (c.radicado || ('PQRS-' + String(c.id).padStart(4, '0')));
  document.getElementById('cPhone').textContent = (c.client_name ? (c.client_name + ' — ') : '') + c.phone;
  document.getElementById('cMessage').textContent = c.message;
  document.getElementById('cStatus').value = c.status || 'pending';
  document.getElementById('cAdminNotes').value = c.admin_notes || '';

  var replyInput = document.getElementById('cReplyMsg');
  if (replyInput) replyInput.value = '';

  bg.removeAttribute('hidden');
}

function formatPqrsReply(rawMsg, complaint) {
  if (!complaint) return rawMsg;
  var rad = complaint.radicado || ('PQRS-' + String(complaint.id).padStart(4, '0'));
  var name = complaint.client_name || 'Cliente';
  var reportedIssue = (complaint.message || '').trim();

  // Si ya tiene el encabezado de radicado o cita previa, no duplicar
  if (rawMsg.includes('#' + rad) || rawMsg.includes('RESPUESTA A TU REPORTE')) {
    return rawMsg;
  }

  var formatted =
    '📋 *RESPUESTA A TU REPORTE / PQRS*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    'Radicado: *#' + rad + '*\n' +
    'Hola *' + name + '*, en respuesta a tu caso por:\n' +
    (reportedIssue ? ('_«' + reportedIssue + '»_\n\n') : '\n') +
    '*Respuesta de Administración:*\n' +
    rawMsg + '\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '_Balneario Río Royota — Soporte WiFi_ 🏖️';

  return formatted;
}

function setReplyTemplate(type) {
  var replyInput = document.getElementById('cReplyMsg');
  if (!replyInput || !_activeComplaint) return;

  var name = _activeComplaint.client_name || 'Cliente';
  var rad = _activeComplaint.radicado || 'PQRS-0001';

  if (type === 'ok') {
    replyInput.value = 'Hemos verificado las antenas y la velocidad del servicio de internet ha sido restablecida y normalizada. ¿Nos confirmas por favor si ya puedes navegar sin problemas? Muchas gracias por tu paciencia.';
    document.getElementById('cStatus').value = 'resolved';
  } else if (type === 'review') {
    replyInput.value = 'Hemos recibido tu reporte. Nuestro equipo técnico se encuentra verificando las antenas en el balneario en este momento para solucionar tu conexión a la brevedad.';
    document.getElementById('cStatus').value = 'in_progress';
  } else if (type === 'voucher') {
    replyInput.value = 'Lamentamos los inconvenientes con tu conexión. Te hemos generado una nueva ficha de cortesía para reponer tu tiempo sin costo: CÓDIGO: [Escribe aquí el código]. Puedes activarla en el portal de inicio.';
    document.getElementById('cStatus').value = 'resolved';
  }
}

function openCustomerInWaWeb() {
  if (!_activeComplaint || !_activeComplaint.phone) {
    toast('No hay número de teléfono disponible', 'error');
    return;
  }
  var clean = String(_activeComplaint.phone).replace(/\D/g, '');
  if (clean.length === 10 && clean.startsWith('3')) clean = '57' + clean;
  var rawMsg = (document.getElementById('cReplyMsg').value || '').trim();
  var finalMsg = rawMsg ? formatPqrsReply(rawMsg, _activeComplaint) : '';
  var url = 'https://wa.me/' + clean + (finalMsg ? ('?text=' + encodeURIComponent(finalMsg)) : '');
  window.open(url, '_blank');
}

function sendReplyViaBot() {
  if (!_activeComplaint || (!_activeComplaint.phone && !_activeComplaint.jid)) {
    toast('No hay destinatario asociado a esta queja', 'error');
    return;
  }

  var rawMsg = (document.getElementById('cReplyMsg').value || '').trim();
  if (!rawMsg) {
    toast('Por favor escribe el mensaje que deseas enviar al cliente', 'error');
    document.getElementById('cReplyMsg').focus();
    return;
  }

  var formattedMsg = formatPqrsReply(rawMsg, _activeComplaint);

  var btn = document.getElementById('btnSendWaReply');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Enviando...';
  }

  var statusVal = document.getElementById('cStatus').value || 'resolved';
  var target = _activeComplaint.jid || _activeComplaint.phone;
  var displayContact = _activeComplaint.client_name ? (_activeComplaint.client_name + ' (' + _activeComplaint.phone + ')') : _activeComplaint.phone;

  function onSuccess() {
    toast('✅ Mensaje programado exitosamente. El servidor del bot lo está entregando al cliente.', 'ok');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📤 Enviar Respuesta por WhatsApp';
    }
    closeComplaintModal();
    loadComplaintsSection();
  }

  // Enviar mediante Firestore Outbox y respaldo POST autenticado
  if (window.firebaseDb && window.firebaseDb.sendWhatsAppReply) {
    window.firebaseDb.sendWhatsAppReply(target, formattedMsg, _activeComplaint.id, statusVal, rawMsg)
      .then(function() {
        onSuccess();
      })
      .catch(function() {
        httpApiFetch('POST', '/api/whatsapp/send-message', {
          phone: target,
          message: formattedMsg,
          complaint_id: _activeComplaint.id || null,
          status: statusVal,
        }).then(onSuccess).catch(function(err2) {
          if (btn) { btn.disabled = false; btn.textContent = '📤 Enviar Respuesta por WhatsApp'; }
          toast((err2 && err2.error) || 'Error al enviar mensaje por WhatsApp', 'error');
        });
      });
  } else {
    httpApiFetch('POST', '/api/whatsapp/send-message', {
      phone: target,
      message: formattedMsg,
      complaint_id: _activeComplaint.id || null,
      status: statusVal,
    }).then(onSuccess).catch(function(err2) {
      if (btn) { btn.disabled = false; btn.textContent = '📤 Enviar Respuesta por WhatsApp'; }
      toast((err2 && err2.error) || 'Error al enviar mensaje por WhatsApp', 'error');
    });
  }
}

function closeComplaintModal(e) {
  if (e && e.target && e.target.id !== 'complaintModalBg' && !e.target.classList.contains('modal-close')) return;
  var bg = document.getElementById('complaintModalBg');
  if (bg) bg.setAttribute('hidden', '');
}

function saveComplaintResolution(e) {
  if (e) e.preventDefault();
  var id = document.getElementById('cId').value;
  var status = document.getElementById('cStatus').value;
  var admin_notes = document.getElementById('cAdminNotes').value.trim();

  var promise = (window.firebaseDb && window.firebaseDb.updateComplaint)
    ? window.firebaseDb.updateComplaint(id, { status: status, admin_notes: admin_notes })
    : apiFetch('PATCH', '/api/complaints/' + id, { status: status, admin_notes: admin_notes });

  promise.then(function() {
    toast('Queja actualizada correctamente', 'ok');
    closeComplaintModal();
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.message) || (err && err.error) || 'Error al actualizar queja', 'error');
  });
}

function quickResolveComplaint(id) {
  var promise = (window.firebaseDb && window.firebaseDb.updateComplaint)
    ? window.firebaseDb.updateComplaint(id, { status: 'resolved', admin_notes: 'Resuelto por administrador' })
    : apiFetch('PATCH', '/api/complaints/' + id, { status: 'resolved', admin_notes: 'Resuelto por administrador' });

  promise.then(function() {
    toast('Queja marcada como resuelta', 'ok');
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.message) || (err && err.error) || 'Error al resolver queja', 'error');
  });
}

function deleteComplaint(id) {
  if (!confirm('¿Deseas eliminar este registro de queja/PQRS?')) return;
  var promise = (window.firebaseDb && window.firebaseDb.deleteComplaint)
    ? window.firebaseDb.deleteComplaint(id)
    : apiFetch('DELETE', '/api/complaints/' + id);

  promise.then(function() {
    toast('Registro eliminado', 'ok');
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.message) || (err && err.error) || 'Error al eliminar', 'error');
  });
}

/* ══════════════════════════════════════════════════════════
   DISPOSITIVOS EXENTOS / IP BINDING (TVs, CÁMARAS, DVRs)
══════════════════════════════════════════════════════════ */

var _cachedIpBindings = [];

function formatMacInput(el) {
  if (!el) return;
  var val = el.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 12);
  var formatted = '';
  for (var i = 0; i < val.length; i++) {
    if (i > 0 && i % 2 === 0) formatted += ':';
    formatted += val[i];
  }
  el.value = formatted;
  updateRouterosBindingPreview();
}

function setPresetComment(txt) {
  var el = document.getElementById('bindComment');
  if (!el) return;
  el.value = txt;
  el.focus();
  updateRouterosBindingPreview();
}

function updateRouterosBindingPreview() {
  var macEl = document.getElementById('bindMac');
  var commEl = document.getElementById('bindComment');
  var typeEl = document.getElementById('bindType');
  var ipEl = document.getElementById('bindIp');
  var box = document.getElementById('routerosCmdBox');
  var txt = document.getElementById('routerosCmdText');
  if (!box || !txt) return;

  var mac = (macEl ? macEl.value : '').trim().toUpperCase();
  var comment = (commEl ? commEl.value : '').trim();
  var type = (typeEl ? typeEl.value : 'bypassed') || 'bypassed';
  var ip = (ipEl ? ipEl.value : '').trim();

  if (mac.length >= 8) {
    var cmd = buildRouterosBindingCmd(mac, comment, type, ip);
    txt.textContent = cmd;
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
}

function buildRouterosBindingCmd(mac, comment, type, ip) {
  var cleanMac = (mac || 'AA:BB:CC:DD:EE:FF').toUpperCase();
  var cleanType = type || 'bypassed';
  var cmd = '/ip hotspot ip-binding add mac-address=' + cleanMac + ' type=' + cleanType;
  if (ip) cmd += ' address=' + ip;
  if (comment) cmd += ' comment="' + comment.replace(/"/g, '') + '"';
  cmd += ' server=all';
  return cmd;
}

function copyRouterosBindingCmd() {
  var txt = document.getElementById('routerosCmdText');
  if (!txt || !txt.textContent) return;
  navigator.clipboard.writeText(txt.textContent).then(function() {
    toast('Comando RouterOS copiado al portapapeles', 'ok');
  }).catch(function() {
    toast('No se pudo copiar automáticamente', 'warn');
  });
}

function copyBindingCommandFor(mac, comment, type, ip) {
  var cmd = buildRouterosBindingCmd(mac, comment, type, ip);
  navigator.clipboard.writeText(cmd).then(function() {
    toast('Comando para ' + (comment || mac) + ' copiado al portapapeles', 'ok');
  }).catch(function() {
    prompt('Copia el comando RouterOS:', cmd);
  });
}

function focusIpBindingMac(e) {
  if (e) e.preventDefault();
  var p = document.getElementById('panelIpBinding');
  if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  var inp = document.getElementById('bindMac');
  if (inp) setTimeout(function() { inp.focus(); }, 300);
}

function handleSaveIpBinding(e) {
  if (e) e.preventDefault();
  var macEl = document.getElementById('bindMac');
  var commentEl = document.getElementById('bindComment');
  var typeEl = document.getElementById('bindType');
  var ipEl = document.getElementById('bindIp');
  var btn = document.getElementById('btnSaveBinding');

  if (!macEl || !commentEl) return;
  var mac = macEl.value.trim().toUpperCase();
  var comment = commentEl.value.trim();
  var type = (typeEl ? typeEl.value : 'bypassed') || 'bypassed';
  var address = (ipEl ? ipEl.value.trim() : '');

  // Validar formato MAC
  var macRegex = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/;
  if (!macRegex.test(mac)) {
    toast('Dirección MAC inválida. Debe tener formato AA:BB:CC:DD:EE:FF', 'error');
    macEl.focus();
    return;
  }
  if (!comment) {
    toast('Por favor ingresa un nombre o ubicación para el dispositivo', 'warn');
    commentEl.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Guardando...';
  }

  apiFetch('POST', '/api/ip-bindings', {
    mac_address: mac,
    comment: comment,
    type: type,
    address: address
  }).then(function(res) {
    toast('⚡ Dispositivo "' + comment + '" guardado. Inyectado a MikroTik en vivo (3 seg).', 'ok');
    updateRouterosBindingPreview();
    macEl.value = '';
    commentEl.value = '';
    if (ipEl) ipEl.value = '';
    loadIpBindings();
  }).catch(function(err) {
    toast((err && err.message) || 'Error al guardar IP Binding', 'error');
  }).finally(function() {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>➕ Guardar & Bypasear Dispositivo</span>';
    }
  });
}

function loadIpBindings() {
  var tbody = document.getElementById('ipBindingsTableBody');
  var badge = document.getElementById('badgeIpBindingCount');
  if (!tbody) return;

  apiFetch('GET', '/api/ip-bindings').then(function(list) {
    _cachedIpBindings = list || [];
    if (badge) {
      badge.textContent = _cachedIpBindings.length + (_cachedIpBindings.length === 1 ? ' Dispositivo' : ' Dispositivos');
    }

    if (!_cachedIpBindings.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px; color:#8ba3b8;">' +
        '📺 No hay dispositivos registrados aún. Ingresa la MAC de un Smart TV o cámara arriba para permitirle navegar libremente sin ficha.' +
        '</td></tr>';
      return;
    }

    tbody.textContent = '';
    _cachedIpBindings.forEach(function(item) {
      var icon = '📱';
      var commLow = (item.comment || '').toLowerCase();
      if (commLow.includes('tv') || commLow.includes('televisor')) icon = '📺';
      else if (commLow.includes('cam') || commLow.includes('cámara') || commLow.includes('dvr')) icon = '📹';
      else if (commLow.includes('impresora') || commLow.includes('pos')) icon = '🖨️';
      else if (commLow.includes('admin') || commLow.includes('pc') || commLow.includes('laptop')) icon = '💻';

      var tr = document.createElement('tr');

      var nameTd = tr.insertCell();
      nameTd.style.cssText = 'font-weight:600; color:#e0e9f0; display:flex; align-items:center; gap:8px;';
      var iconSpan = el('span', null, icon);
      iconSpan.style.fontSize = '16px';
      nameTd.appendChild(iconSpan);
      nameTd.appendChild(el('span', null, item.comment || 'Sin nombre'));

      var macTd = tr.insertCell();
      var macCode = el('code', null, item.mac_address || '');
      macCode.style.cssText = 'background:rgba(0,0,0,0.4); padding:3px 8px; border-radius:6px; color:#00d4ff; font-weight:700; letter-spacing:0.5px;';
      macTd.appendChild(macCode);

      var ipTd = td(tr, item.address || 'Dinámica (DHCP)');
      ipTd.style.color = item.address ? '#e0e9f0' : '#8ba3b8';
      ipTd.style.fontFamily = 'monospace';

      var tpTd = tr.insertCell();
      var tpBadge = document.createElement('span');
      tpBadge.style.cssText = 'font-weight:700; font-size:11px;';
      if (item.type === 'blocked') {
        tpBadge.className = 'badge badge-danger';
        tpBadge.textContent = '🔴 BLOCKED';
      } else if (item.type === 'regular') {
        tpBadge.className = 'badge badge-warning';
        tpBadge.textContent = '🔵 REGULAR';
      } else {
        tpBadge.className = 'badge badge-success';
        tpBadge.textContent = '🟢 BYPASSED';
      }
      tpTd.appendChild(tpBadge);

      var dateStr = '—';
      if (item.created_at) {
        try {
          dateStr = new Date(item.created_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
        } catch (_) {}
      }
      var dtTd = td(tr, dateStr);
      dtTd.style.cssText = 'font-size:12px; color:#8ba3b8;';

      var actTd = tr.insertCell();
      actTd.style.textAlign = 'right';
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:inline-flex; gap:6px; justify-content:flex-end;';

      var bCopy = el('button', { type: 'button', className: 'btn btn-xs btn-ghost', title: 'Copiar comando MikroTik RouterOS' }, '📋 Copiar Script');
      bCopy.addEventListener('click', function() {
        copyBindingCommandFor(item.mac_address, item.comment || 'Sin nombre', item.type || 'bypassed', item.address || '');
      });

      var bDel = el('button', { type: 'button', className: 'btn btn-xs btn-danger', title: 'Eliminar dispositivo de IP Binding' }, '🗑️');
      bDel.addEventListener('click', function() {
        deleteIpBindingItem(item.id || item.mac_address, item.mac_address, item.comment || '');
      });

      wrap.appendChild(bCopy);
      wrap.appendChild(bDel);
      actTd.appendChild(wrap);
      tbody.appendChild(tr);
    });
  }).catch(function(err) {
    console.warn('Error loadIpBindings:', err);
    tbody.textContent = '';
    var errTr = tbody.insertRow();
    var errTd = errTr.insertCell();
    errTd.colSpan = 6;
    errTd.style.cssText = 'text-align:center; padding:20px; color:#ff4444;';
    errTd.textContent = 'Error al cargar dispositivos: ' + ((err && err.message) || 'Error de conexión');
  });
}

function deleteIpBindingItem(id, mac, comment) {
  var name = comment || mac;
  if (!confirm('¿Deseas eliminar el IP Binding para "' + name + '"?\n\nEl dispositivo dejará de tener bypass de internet libre y volverá a solicitar ficha de acceso.')) {
    return;
  }

  apiFetch('DELETE', '/api/ip-bindings/' + encodeURIComponent(id) + '?mac=' + encodeURIComponent(mac)).then(function() {
    toast('🗑️ Dispositivo eliminado. Remoción enviada a MikroTik en vivo (3 seg).', 'ok');
    loadIpBindings();
    var removeCmd = '/ip hotspot ip-binding remove [find mac-address="' + mac + '"]';
    console.log('[MikroTik Remove CMD]:', removeCmd);
  }).catch(function(err) {
    toast((err && err.message) || 'Error al eliminar dispositivo', 'error');
  });
}

// Escuchar cambios en vivo si Firestore está disponible
if (window.firebaseDb && window.firebaseDb.onIpBindingsChange) {
  window.firebaseDb.onIpBindingsChange(function() {
    var p = document.getElementById('panelIpBinding');
    if (p && !p.closest('.sec').hidden) {
      loadIpBindings();
    }
  });
}

// Exportar al ámbito global
window.formatMacInput = formatMacInput;
window.setPresetComment = setPresetComment;
window.updateRouterosBindingPreview = updateRouterosBindingPreview;
window.copyRouterosBindingCmd = copyRouterosBindingCmd;
window.copyBindingCommandFor = copyBindingCommandFor;
window.focusIpBindingMac = focusIpBindingMac;
window.handleSaveIpBinding = handleSaveIpBinding;
window.loadIpBindings = loadIpBindings;
window.deleteIpBindingItem = deleteIpBindingItem;

/* ── Arranque inicial verificado con Firebase Auth o JWT local ─ */
function startAdminUi() {
  loadBrandingHeader();
  if (window.firebaseDb && window.firebaseDb.seedInitialDataIfEmpty) {
    window.firebaseDb.seedInitialDataIfEmpty().then(function() {
      loadDashboard();
      loadPlanFilterDropdown();
    }).catch(function() {
      loadDashboard();
      loadPlanFilterDropdown();
    });
  } else {
    loadDashboard();
    loadPlanFilterDropdown();
  }
}

if (typeof firebase !== 'undefined' && firebase.auth) {
  var _booted = false;
  firebase.auth().onAuthStateChanged(function(user) {
    if (!user) {
      logout();
      return;
    }
    user.getIdToken().then(function(idToken) {
      TOKEN = idToken;
      localStorage.setItem('fichas_token', idToken);
      ME = { username: user.email, uid: user.uid };
      localStorage.setItem('fichas_admin', JSON.stringify(ME));
      document.getElementById('adminName').textContent = user.email || 'Admin';
      if (!_booted) {
        _booted = true;
        startAdminUi();
      }
    }).catch(function() {
      logout();
    });
  });
} else {
  if (!TOKEN) {
    location.href = './login.html';
  } else {
    httpApiFetch('GET', '/api/auth/me').then(function() {
      startAdminUi();
    }).catch(function() {
      logout();
    });
  }
}
