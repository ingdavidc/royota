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
      if (method === 'DELETE') return window.firebaseDb.deletePlan(planId);
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
      if (xhr.status === 401) { logout(); return; }
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
    });
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
    toast(_editingPlanId ? 'Plan actualizado' : 'Plan creado', 'ok');
    document.getElementById('planModalBg').hidden = true;
    _editingPlanId = null;
    loadPlans();
  }).catch(function(err) { toast(err.error || 'Error', 'error'); });
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
