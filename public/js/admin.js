/* ============================================================
   public/js/admin.js — Panel Admin completo sin frameworks
   ============================================================ */
'use strict';

/* ── Auth ─────────────────────────────────────────────────── */
var TOKEN = localStorage.getItem('fichas_token');
var ME    = safeJSON(localStorage.getItem('fichas_admin'));
if (!TOKEN) location.href = './login.html';

document.getElementById('adminName').textContent = ME.username || 'Admin';

/* ── Negocio ─────────────────────────────────────────────── */
apiFetch('GET', '/api/config').then(function(c) {
  if (c.businessName) {
    document.getElementById('topbarTitle').textContent = c.businessName;
    document.title = 'Admin — ' + c.businessName;
  }
}).catch(function(){});

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function safeJSON(s) { try { return JSON.parse(s || '{}'); } catch(_) { return {}; } }

function logout() {
  localStorage.removeItem('fichas_token');
  localStorage.removeItem('fichas_admin');
  location.href = './login.html';
}

/** Petición autenticada (con soporte directo a Firestore y fallback HTTP) */
function apiFetch(method, url, body) {
  if (window.firebaseDb) {
    if (url === '/api/config' || url === '/api/settings') {
      if (method === 'GET') return window.firebaseDb.getSettings();
      if (method === 'PUT') return window.firebaseDb.saveSettings(body);
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
    if (url === '/api/vouchers/generate' && method === 'POST') {
      return window.firebaseDb.generateVouchers(body);
    }
    if (url.startsWith('/api/vouchers/batch/')) {
      var batchId = url.split('/api/vouchers/batch/')[1];
      return window.firebaseDb.getVoucherBatch(batchId);
    }
    if (url === '/api/vouchers/batches') {
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

  return new Promise(function(resolve, reject) {
    var fullUrl = (window.API_BASE || '') + url;
    var xhr = new XMLHttpRequest();
    xhr.open(method, fullUrl, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      var d;
      try { d = JSON.parse(xhr.responseText); } catch(_) { d = {}; }
      if (xhr.status === 401) {
        if (url.indexOf('/api/whatsapp') === -1 && url.indexOf('/api/kiosks') === -1 && url.indexOf('/api/complaints') === -1) {
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
   GENERAR FICHAS
══════════════════════════════════════════════════════════ */
var _lastBatchId   = null;
var _lastBatchData = null;
var _plansCache    = [];

function loadGenSection() {
  loadPlanSelect('gPlanId');
  updateCodePreview();
  loadBatches();
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
    plan_id:    parseInt(planId, 10),
    quantity:   qty,
    code_length: codeLen,
    charset:    charset,
    group_size: group,
    separator:  '-',
    prefix:     prefix,
    note:       note,
  }).then(function(r) {
    btn.disabled    = false;
    btn.textContent = '🎫 Generar Fichas';

    _lastBatchId   = r.batch_id;
    _lastBatchData = r;

    toast(r.message, 'ok');
    showCodesResult(r);
    loadBatches();
  }).catch(function(err) {
    btn.disabled    = false;
    btn.textContent = '🎫 Generar Fichas';
    toast(err.error || 'Error al generar fichas', 'error');
  });
});

function showCodesResult(r) {
  var panel   = document.getElementById('resultPanel');
  var title   = document.getElementById('resultTitle');
  var grid    = document.getElementById('codesGrid');

  title.textContent = r.generated + ' fichas — ' + (r.plan ? r.plan.name : '');
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
    if (!batches.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);text-align:center">Sin lotes generados</td></tr>';
      return;
    }
    batches.forEach(function(b) {
      var tr = tbody.insertRow();
      td(tr, fmtDate(b.created_at));
      td(tr, b.plan_name);
      td(tr, b.vouchers_total);
      td(tr, b.vouchers_available);
      td(tr, b.vouchers_sold);
      td(tr, b.vouchers_active);
      td(tr, b.note || '—');
      var acts = tr.insertCell();
      var btnP = el('button', { className:'btn btn-sm btn-ghost' }, '🖨️');
      btnP.addEventListener('click', function() { window.open('./print.html?batch=' + b.id, '_blank'); });
      acts.appendChild(btnP);
    });
  }).catch(function(){});
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
function loadMikrotikSection() {
  testMikrotik();
  loadActiveUsers();
  loadSyncLog();
}

function testMikrotik() {
  var box = document.getElementById('mkStatus');
  box.innerHTML = '<span style="color:var(--muted)">⏳ Probando conexión…</span>';
  apiFetch('GET', '/api/mikrotik/test').then(function(r) {
    if (r.ok) {
      box.innerHTML = '<span class="mk-status-ok">✅ Conectado correctamente</span>';
      box.innerHTML += '<div class="mk-info-grid">' +
        mkCard('Versión RouterOS', r.version) +
        mkCard('Uptime', r.uptime) +
        mkCard('CPU', (r.cpuLoad || '—') + '%') +
        mkCard('RAM libre', fmtBytes(r.freeMemory)) +
      '</div>';
    } else {
      box.innerHTML = '<span class="mk-status-err">❌ ' + (r.error || 'Sin conexión') + '</span>';
    }
  }).catch(function(e) {
    box.innerHTML = '<span class="mk-status-err">❌ ' + (e.error || 'Error de red') + '</span>';
  });
}

function mkCard(label, val) {
  return '<div class="mk-info-card">' +
    '<div class="mk-info-label">' + label + '</div>' +
    '<div class="mk-info-val">'   + (val || '—') + '</div>' +
  '</div>';
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
function loadPortalSettings() {
  apiFetch('GET', '/api/settings').then(function(s) {
    var nameEl    = document.getElementById('setBusinessName');
    var sloganEl  = document.getElementById('setBusinessSlogan');
    var waEl      = document.getElementById('setWhatsappNumber');
    var waMsgEl   = document.getElementById('setWhatsappMessage');
    var actEl     = document.getElementById('setInfoActive');
    var badgeEl   = document.getElementById('setInfoBadge');
    var titleEl   = document.getElementById('setInfoTitle');
    var contentEl = document.getElementById('setInfoContent');

    if (nameEl)    nameEl.value    = s.business_name || '';
    if (sloganEl)  sloganEl.value  = s.business_slogan || '';
    if (waEl)      waEl.value      = s.whatsapp_number || '';
    if (waMsgEl)   waMsgEl.value   = s.whatsapp_message || '';
    if (actEl)     actEl.checked   = (s.info_active === '1' || s.info_active === 1 || s.info_active === true);
    if (badgeEl)   badgeEl.value   = s.info_badge || '';
    if (titleEl)   titleEl.value   = s.info_title || '';
    if (contentEl) contentEl.value = s.info_content || '';
  }).catch(function(err) {
    toast((err && err.error) || 'Error al cargar ajustes del portal', 'error');
  });
}

function savePortalSettings(e) {
  e.preventDefault();
  var btn = document.getElementById('btnSavePortal');
  if (btn) btn.disabled = true;

  var body = {
    business_name:    document.getElementById('setBusinessName').value,
    business_slogan:  document.getElementById('setBusinessSlogan').value,
    whatsapp_number:  document.getElementById('setWhatsappNumber').value,
    whatsapp_message: document.getElementById('setWhatsappMessage').value,
    info_active:      document.getElementById('setInfoActive').checked ? '1' : '0',
    info_badge:       document.getElementById('setInfoBadge').value,
    info_title:       document.getElementById('setInfoTitle').value,
    info_content:     document.getElementById('setInfoContent').value,
  };

  apiFetch('PUT', '/api/settings', body).then(function(r) {
    if (btn) btn.disabled = false;
    toast(r.message || 'Configuración guardada', 'ok');
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

function loadWhatsAppSection() {
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

function checkWhatsAppStatus() {
  apiFetch('GET', '/api/whatsapp/status').then(function(s) {
    var pill = document.getElementById('waStatusPill');
    var qrBox = document.getElementById('waQrBox');
    var qrImg = document.getElementById('waQrImg');
    var connBox = document.getElementById('waConnectedBox');
    var userEl = document.getElementById('waConnectedUser');

    if (!pill) return;

    if (s.status === 'connected') {
      pill.textContent = '🟢 Conectado';
      pill.style.background = 'rgba(74, 222, 128, 0.2)';
      pill.style.color = '#4ade80';
      qrBox.style.display = 'none';
      connBox.style.display = 'block';
      userEl.textContent = 'Vinculado a: ' + (s.user ? (s.user.name || s.user.id || 'Dispositivo WhatsApp') : 'Dispositivo WhatsApp');
    } else if (s.status === 'qr_ready') {
      pill.textContent = '🟡 Esperando Escaneo de QR';
      pill.style.background = 'rgba(250, 204, 21, 0.2)';
      pill.style.color = '#facc15';
      connBox.style.display = 'none';
      qrBox.style.display = 'block';
      if (s.qrCodeDataUrl) {
        qrImg.src = s.qrCodeDataUrl;
      }
    } else if (s.status === 'connecting') {
      pill.textContent = '🔄 Conectando...';
      pill.style.background = 'rgba(56, 189, 248, 0.2)';
      pill.style.color = '#38bdf8';
    } else if (s.status === 'disabled') {
      pill.textContent = '⚪ Desactivado (WHATSAPP_ENABLED=false)';
      pill.style.background = 'rgba(255, 255, 255, 0.1)';
      pill.style.color = 'var(--muted)';
      qrBox.style.display = 'none';
      connBox.style.display = 'none';
    } else {
      pill.textContent = '🔴 Desconectado';
      pill.style.background = 'rgba(248, 113, 113, 0.2)';
      pill.style.color = '#f87171';
      qrBox.style.display = 'none';
      connBox.style.display = 'none';
    }
  }).catch(function(err) {
    console.error('Error comprobando estado de WhatsApp:', err);
    var pill = document.getElementById('waStatusPill');
    if (pill) {
      pill.textContent = '⚠️ Sin conexión con el servidor local';
      pill.style.background = 'rgba(248, 113, 113, 0.2)';
      pill.style.color = '#f87171';
    }
  });
}

function disconnectWhatsApp() {
  if (!confirm('¿Estás seguro de que deseas desvincular el WhatsApp actual?')) return;
  apiFetch('POST', '/api/whatsapp/logout').then(function(res) {
    toast(res.message || 'Sesión cerrada', 'ok');
    checkWhatsAppStatus();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al cerrar sesión', 'error');
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
      tr.innerHTML =
        '<td>' + fmtDate(p.created_at) + '</td>' +
        '<td><strong>' + (p.sender_phone || '—') + '</strong></td>' +
        '<td><span class="badge">' + (p.platform || 'Daviplata') + '</span></td>' +
        '<td><code>' + (p.reference_number || '—') + '</code></td>' +
        '<td style="color:#4ade80; font-weight:bold;">' + fmtMoney(p.amount) + '</td>' +
        '<td>' + (p.plan_name ? p.plan_name + ' (' + p.plan_duration + ')' : '—') + '</td>' +
        '<td><strong style="color:var(--cyan);">' + (p.voucher_code || '—') + '</strong></td>';
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
      var statusHtml = '';
      if (s.is_blocked || (s.blocked_until && new Date(s.blocked_until) > new Date())) {
        statusHtml = '<span class="badge" style="background:rgba(248,113,113,0.2); color:#f87171; font-weight:bold;">🚫 Bloqueado hasta ' + fmtDate(s.blocked_until) + '</span>';
      } else if (s.strikes > 0) {
        statusHtml = '<span class="badge" style="background:rgba(250,204,21,0.2); color:#facc15;">⚠️ ' + s.strikes + ' Strike(s)</span>';
      } else {
        statusHtml = '<span class="badge" style="background:rgba(74,222,128,0.2); color:#4ade80;">Normal</span>';
      }

      tr.innerHTML =
        '<td><strong>' + s.phone + '</strong></td>' +
        '<td><span class="stat-pill">' + s.strikes + ' / 3</span></td>' +
        '<td>' + statusHtml + '</td>' +
        '<td style="font-size:12px; color:var(--muted);">' + (s.last_reason || '—') + '</td>' +
        '<td>' + fmtDate(s.updated_at) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-ghost" onclick="unblockPhone(\'' + s.phone + '\')" title="Desbloquear y limpiar strikes">🔓 Desbloquear</button>' +
        '</td>';
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
  var tbody = document.getElementById('kiosksBody');
  if (!tbody) return;

  apiFetch('GET', '/api/kiosks?all=true').then(function(kiosks) {
    _currentKiosks = kiosks || [];
    tbody.innerHTML = '';
    if (!_currentKiosks.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">No hay casetas registradas. Haz clic en "Nueva Caseta / Kiosko" para agregar una.</td></tr>';
      return;
    }

    _currentKiosks.forEach(function(k) {
      var tr = document.createElement('tr');
      var statusBadge = k.is_active
        ? '<span class="badge" style="background:rgba(74,222,128,0.2); color:#4ade80;">Activo</span>'
        : '<span class="badge" style="background:rgba(255,255,255,0.1); color:var(--muted);">Inactivo</span>';

      tr.innerHTML =
        '<td>' + (k.sort_order || 0) + '</td>' +
        '<td><strong>' + escapeHtml(k.name) + '</strong></td>' +
        '<td>' + escapeHtml(k.location) + '</td>' +
        '<td>' + (k.contact ? escapeHtml(k.contact) : '—') + '</td>' +
        '<td style="font-size:12px; color:var(--muted);">' + (k.notes ? escapeHtml(k.notes) : '—') + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' +
          '<div style="display:flex; gap:6px;">' +
            '<button class="btn btn-sm btn-ghost" onclick="editKiosk(' + k.id + ')" title="Editar">✏️</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="toggleKiosk(' + k.id + ')" title="Activar/Desactivar">' + (k.is_active ? '⏸️' : '▶️') + '</button>' +
            '<button class="btn btn-sm btn-danger" onclick="deleteKiosk(' + k.id + ')" title="Eliminar">🗑️</button>' +
          '</div>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error cargando casetas y kioskos.</td></tr>';
  });
}

function openKioskModal(kiosk) {
  var bg = document.getElementById('kioskModalBg');
  var form = document.getElementById('kioskForm');
  var title = document.getElementById('kioskModalTitle');

  form.reset();
  if (kiosk) {
    title.textContent = 'Editar Caseta / Kiosko';
    document.getElementById('kioskId').value = kiosk.id;
    document.getElementById('kName').value = kiosk.name || '';
    document.getElementById('kLocation').value = kiosk.location || '';
    document.getElementById('kContact').value = kiosk.contact || '';
    document.getElementById('kSortOrder').value = kiosk.sort_order || 1;
    document.getElementById('kNotes').value = kiosk.notes || '';
  } else {
    title.textContent = 'Nueva Caseta / Kiosko';
    document.getElementById('kioskId').value = '';
    document.getElementById('kSortOrder').value = (_currentKiosks.length + 1);
  }

  bg.removeAttribute('hidden');
}

function closeKioskModal(e) {
  if (e && e.target && e.target.id !== 'kioskModalBg' && !e.target.classList.contains('modal-close')) return;
  var bg = document.getElementById('kioskModalBg');
  if (bg) bg.setAttribute('hidden', '');
}

function editKiosk(id) {
  var k = _currentKiosks.find(function(item) { return item.id === id; });
  if (k) openKioskModal(k);
}

function toggleKiosk(id) {
  apiFetch('PATCH', '/api/kiosks/' + id + '/toggle').then(function(res) {
    toast(res.message || 'Estado actualizado', 'ok');
    loadKiosksSection();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al cambiar estado', 'error');
  });
}

function deleteKiosk(id) {
  if (!confirm('¿Estás seguro de que deseas eliminar este punto de venta?')) return;
  apiFetch('DELETE', '/api/kiosks/' + id).then(function(res) {
    toast(res.message || 'Kiosko eliminado', 'ok');
    loadKiosksSection();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al eliminar kiosko', 'error');
  });
}

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

  apiFetch('GET', '/api/complaints?status=' + statusVal).then(function(data) {
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
      var radicado = 'PQRS-' + String(c.id).padStart(4, '0');

      var statusBadge = '';
      if (c.status === 'resolved') {
        statusBadge = '<span class="badge" style="background:rgba(74,222,128,0.2); color:#4ade80;">✅ Resuelto</span>';
      } else if (c.status === 'in_progress') {
        statusBadge = '<span class="badge" style="background:rgba(56,189,248,0.2); color:#38bdf8;">🔄 En proceso</span>';
      } else {
        statusBadge = '<span class="badge" style="background:rgba(250,204,21,0.2); color:#facc15;">⏳ Pendiente</span>';
      }

      var phoneLink = '<a href="https://wa.me/57' + c.phone + '" target="_blank" rel="noopener" style="color:var(--cyan); text-decoration:none;" title="Chatear en WhatsApp">💬 ' + c.phone + '</a>';

      tr.innerHTML =
        '<td><strong>#' + radicado + '</strong></td>' +
        '<td style="white-space:nowrap;">' + fmtDate(c.created_at) + '</td>' +
        '<td>' + phoneLink + '</td>' +
        '<td style="max-width:280px; word-break:break-word;">' + escapeHtml(c.message) + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td style="font-size:12px; color:var(--muted); max-width:200px;">' + (c.admin_notes ? escapeHtml(c.admin_notes) : '—') + '</td>' +
        '<td>' +
          '<div style="display:flex; gap:6px;">' +
            '<button class="btn btn-sm btn-ghost" onclick="openComplaintModal(' + c.id + ')" title="Atender / Responder">✏️ Atender</button>' +
            (c.status !== 'resolved' ? '<button class="btn btn-sm btn-ghost" onclick="quickResolveComplaint(' + c.id + ')" title="Marcar como Resuelto">✅</button>' : '') +
            '<button class="btn btn-sm btn-danger" onclick="deleteComplaint(' + c.id + ')" title="Eliminar">🗑️</button>' +
          '</div>' +
        '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#f87171">Error al cargar la bandeja de quejas.</td></tr>';
  });
}

function openComplaintModal(id) {
  var c = _currentComplaints.find(function(item) { return item.id === id; });
  if (!c) return;

  var bg = document.getElementById('complaintModalBg');
  document.getElementById('cId').value = c.id;
  document.getElementById('cRadicado').textContent = '#PQRS-' + String(c.id).padStart(4, '0');
  document.getElementById('cPhone').textContent = c.phone;
  document.getElementById('cMessage').textContent = c.message;
  document.getElementById('cStatus').value = c.status || 'pending';
  document.getElementById('cAdminNotes').value = c.admin_notes || '';

  bg.removeAttribute('hidden');
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

  apiFetch('PATCH', '/api/complaints/' + id, { status: status, admin_notes: admin_notes }).then(function(res) {
    toast(res.message || 'Queja actualizada correctamente', 'ok');
    closeComplaintModal();
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al actualizar queja', 'error');
  });
}

function quickResolveComplaint(id) {
  apiFetch('PATCH', '/api/complaints/' + id, { status: 'resolved', admin_notes: 'Resuelto por administrador' }).then(function(res) {
    toast('Queja marcada como resuelta', 'ok');
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al resolver queja', 'error');
  });
}

function deleteComplaint(id) {
  if (!confirm('¿Deseas eliminar este registro de queja/PQRS?')) return;
  apiFetch('DELETE', '/api/complaints/' + id).then(function(res) {
    toast(res.message || 'Registro eliminado', 'ok');
    loadComplaintsSection();
  }).catch(function(err) {
    toast((err && err.error) || 'Error al eliminar', 'error');
  });
}

/* ── Arranque inicial ───────────────────────────────────── */
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
