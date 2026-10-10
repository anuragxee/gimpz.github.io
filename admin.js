/* ============================================================
   GIMPZ — ADMIN PANEL LOGIC (ALL TABS + REALTIME + AUTO-REFRESH)
   ============================================================ */
(function () {
  'use strict';

  /* ============ CONFIG ============ */
  var SUPABASE_URL = 'https://qyzevydprpkjslnesrxq.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5emV2eWRwcnBranNsbmVzcnhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MTk2NDksImV4cCI6MjEwNzA5NTY0OX0.BE-ijSGGNmkQjaeSZ8RX6mQGMW5dY2Y2Gzj9vitRK0g';
  var AUTH_KEY = 'gimpz_admin_session';
  var LOW_STOCK_THRESHOLD = 5;

  /* ============ STATE ============ */
  var session = null;
  var currentProducts = [];
  var currentOrders = [];
  var currentCustomers = [];
  var currentCategories = [];
  var currentCoupons = [];
  var currentMarketingLists = [];
  var currentStaff = [];
  var currentActivity = [];
  var currentMessages = [];
  var pendingImages = [];
  var realtimeChannel = null;
  var supaClient = null;
  var refreshInFlight = null;

  /* ============ HELPERS ============ */
  function $(id) { return document.getElementById(id); }

  function apiHeaders(auth) {
    var token = (auth && session && session.access_token) ? session.access_token : SUPABASE_ANON_KEY;
    return {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtPrice(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function fmtDateOnly(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function statusPill(status) {
    var s = (status || 'Pending').toLowerCase();
    var cls = 'status-pending';
    if (s === 'shipped') cls = 'status-shipped';
    else if (s === 'delivered') cls = 'status-delivered';
    else if (s === 'cancelled') cls = 'status-cancelled';
    return '<span class="status-pill ' + cls + '">' + esc(status || 'Pending') + '</span>';
  }

  function showStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = el.className.replace(/\b(ok|err)\b/g, '').trim();
    if (type) el.classList.add(type);
  }

  /* ============ REFRESH TOKEN ============ */
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('No refresh token'));
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error_description || data.msg || 'Refresh failed');
          return data;
        });
      })
      .then(function (data) {
        session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          user: {
            id: (data.user && data.user.id) || (session.user && session.user.id),
            email: (data.user && data.user.email) || (session.user && session.user.email)
          }
        };
        saveSession();
        console.log('[GIMPZ] Session refreshed');
        refreshInFlight = null;
        return session;
      })
      .catch(function (err) {
        refreshInFlight = null;
        throw err;
      });

    return refreshInFlight;
  }

  /* ============ AUTHENTICATED FETCH (auto-refresh on 401) ============ */
  function authFetch(url, options) {
    options = options || {};
    return fetch(url, options).then(function (res) {
      if (res.status !== 401 || !session || !session.refresh_token) {
        return res;
      }
      console.warn('[GIMPZ] 401 detected — refreshing session');
      return refreshSession().then(function () {
        var newOptions = Object.assign({}, options);
        newOptions.headers = Object.assign({}, options.headers || {});
        newOptions.headers['Authorization'] = 'Bearer ' + session.access_token;
        newOptions.headers['apikey'] = SUPABASE_ANON_KEY;
        return fetch(url, newOptions);
      }).catch(function (err) {
        console.error('[GIMPZ] Refresh failed:', err);
        stopRealtime();
        session = null;
        saveSession();
        showLoginScreen();
        var status = $('loginStatus');
        if (status) showStatus(status, 'Session expired. Please sign in again.', 'err');
        return res;
      });
    });
  }

  /* ============ REALTIME ============ */
  function initRealtime() {
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[GIMPZ] Supabase SDK not loaded — realtime disabled');
      return;
    }
    if (!session || !session.access_token) return;

    // Create the client only once per page load
    if (!supaClient) {
      supaClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    }

    // Update session on every init (so realtime picks up the fresh token)
    supaClient.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    }).catch(function () {});

    stopRealtime();

    realtimeChannel = supaClient
      .channel('gimpz-admin-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        function (payload) {
          console.log('[GIMPZ] Realtime orders event:', payload.eventType);
          refreshCurrentTab();
          updateMessagesBadge();
          loadOverview();
        }
      )
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'contact_messages' },
        function () {
          updateMessagesBadge();
          var activeBtn = document.querySelector('.admin-nav-btn.active');
          if (activeBtn && activeBtn.getAttribute('data-tab') === 'messages') {
            loadMessages();
          }
        }
      )
      .subscribe(function (status) {
        console.log('[GIMPZ] Realtime channel status:', status);
      });
  }

  function stopRealtime() {
    if (realtimeChannel && supaClient) {
      try { supaClient.removeChannel(realtimeChannel); } catch (e) {}
      realtimeChannel = null;
    }
  }

  function refreshCurrentTab() {
    var activeBtn = document.querySelector('.admin-nav-btn.active');
    var tab = activeBtn ? activeBtn.getAttribute('data-tab') : 'overview';
    if (tab === 'overview') { loadOverview(); checkStockAlerts(); }
    else if (tab === 'orders') loadOrders();
    else if (tab === 'customers') loadCustomers();
  }

  /* ============ ACTIVITY LOG ============ */
  function logActivity(action, targetType, targetId, details) {
    if (!session || !session.access_token) return;
    var adminEmail = (session.user && session.user.email) || 'unknown';
    authFetch(SUPABASE_URL + '/rest/v1/activity_log', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        admin_email: adminEmail,
        action: action,
        target_type: targetType || null,
        target_id: targetId ? String(targetId) : null,
        details: details || null
      })
    }).catch(function () {});
  }

  /* ============ SESSION ============ */
  function saveSession() {
    try {
      if (session) localStorage.setItem(AUTH_KEY, JSON.stringify(session));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
  }
  function loadSession() {
    try {
      var raw = localStorage.getItem(AUTH_KEY);
      if (raw) session = JSON.parse(raw);
    } catch (e) { session = null; }
  }

  /* ============ LOGIN ============ */
  function login(email, password) {
    return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error_description || data.msg || 'Login failed');
        return data;
      });
    }).then(function (data) {
      session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: { id: data.user && data.user.id, email: data.user && data.user.email }
      };
      saveSession();
      return session;
    });
  }

  function logout() {
    stopRealtime();
    session = null;
    saveSession();
    showLoginScreen();
  }

  /* ============ SCREENS ============ */
  function showLoginScreen() {
    var ls = $('loginScreen');
    var db = $('dashboard');
    if (ls) ls.style.display = 'grid';
    if (db) db.style.display = 'none';
  }

  function showDashboard() {
    var ls = $('loginScreen');
    var db = $('dashboard');
    if (ls) ls.style.display = 'none';
    if (db) db.style.display = 'grid';
    var email = (session && session.user && session.user.email) || 'admin';
    var ed = $('adminEmailDisplay'); if (ed) ed.textContent = email;
    var av = $('adminAvatar'); if (av) av.textContent = email.charAt(0).toUpperCase();
    switchTab('overview');
    loadCategoriesIntoSelect();
    checkStockAlerts();
    updateMessagesBadge();
    initRealtime();
  }

  /* ============ TABS ============ */
  function switchTab(tab) {
    document.querySelectorAll('.admin-nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.admin-tab').forEach(function (t) { t.style.display = 'none'; });
    var el = $('tab-' + tab);
    if (el) el.style.display = 'block';

    var titles = {
      overview: 'Overview', products: 'Products', orders: 'Orders',
      customers: 'Customers', categories: 'Categories', coupons: 'Coupons',
      analytics: 'Analytics', marketing: 'Marketing', messages: 'Messages',
      staff: 'Staff', activity: 'Activity Log'
    };
    var titleEl = $('pageTitle');
    if (titleEl) titleEl.textContent = titles[tab] || 'Admin';

    var sb = $('adminSidebar');
    if (sb) sb.classList.remove('open');

    if (tab === 'overview') loadOverview();
    if (tab === 'products') loadProducts();
    if (tab === 'orders') loadOrders();
    if (tab === 'customers') loadCustomers();
    if (tab === 'categories') loadCategories();
    if (tab === 'coupons') loadCoupons();
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'marketing') loadMarketing();
    if (tab === 'messages') loadMessages();
    if (tab === 'staff') loadStaff();
    if (tab === 'activity') loadActivity();
  }

  /* ============ OVERVIEW ============ */
  function loadOverview() {
    authFetch(SUPABASE_URL + '/rest/v1/products?select=id&active=eq.true', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        var el = $('statProducts');
        if (el) el.textContent = Array.isArray(rows) ? rows.length : '0';
      })
      .catch(function () { var el = $('statProducts'); if (el) el.textContent = '—'; });

    authFetch(SUPABASE_URL + '/rest/v1/orders?select=*&order=created_at.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentOrders = rows;
        var totalRev = 0, pending = 0;
        rows.forEach(function (o) {
          if ((o.status || 'Pending').toLowerCase() !== 'cancelled') totalRev += Number(o.total || 0);
          if ((o.status || 'Pending').toLowerCase() === 'pending') pending++;
        });
        var so = $('statOrders'); if (so) so.textContent = rows.length;
        var sr = $('statRevenue'); if (sr) sr.textContent = fmtPrice(totalRev);
        var sp = $('statPending'); if (sp) sp.textContent = pending;
        var b = $('ordersCount');
        if (b) { b.textContent = rows.length; b.setAttribute('data-count', rows.length); }
        renderRecentOrders(rows.slice(0, 5));
      })
      .catch(function () { var so = $('statOrders'); if (so) so.textContent = '—'; });
  }

  function renderRecentOrders(rows) {
    var el = $('recentOrders');
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<p class="admin-empty">No orders yet</p>'; return; }
    var html = '';
    rows.forEach(function (o) {
      html += '<div class="recent-order-row" style="cursor:pointer;" data-view="' + o.id + '">' +
        '<div><strong>' + esc(o.order_number || '—') + '</strong></div>' +
        '<div>' + esc(o.customer_name || '—') + '</div>' +
        '<div>' + esc(o.phone || '—') + '</div>' +
        '<div>' + fmtPrice(o.total) + '</div>' +
        '<div>' + statusPill(o.status) + '</div>' +
      '</div>';
    });
    el.innerHTML = html;
    el.querySelectorAll('[data-view]').forEach(function (row) {
      row.addEventListener('click', function () { openOrderDetails(parseInt(row.getAttribute('data-view'), 10)); });
    });
  }

  /* ============ STOCK ALERTS ============ */
  function checkStockAlerts() {
    authFetch(SUPABASE_URL + '/rest/v1/products?select=id,name,brand,stock,category&stock=lte.' + LOW_STOCK_THRESHOLD + '&active=eq.true&order=stock.asc', {
      headers: apiHeaders(true)
    }).then(function (r) { return r.json(); }).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) {
        var card = $('stockAlertsCard');
        if (card) card.style.display = 'none';
        var badge = $('stockAlertBadge');
        if (badge) { badge.textContent = '0'; badge.setAttribute('data-count', '0'); }
        return;
      }
      var badge = $('stockAlertBadge');
      if (badge) { badge.textContent = rows.length; badge.setAttribute('data-count', rows.length); }
      var card = $('stockAlertsCard');
      var list = $('stockAlertsList');
      if (!card || !list) return;
      card.style.display = 'block';
      var html = '';
      rows.forEach(function (p) {
        html += '<div class="recent-order-row">' +
          '<div><strong>' + esc(p.name) + '</strong><br><small style="color:#64748b;">' + esc(p.brand || '') + '</small></div>' +
          '<div>' + esc(p.category || '') + '</div>' +
          '<div></div><div></div>' +
          '<div><span class="status-pill ' + (p.stock === 0 ? 'status-cancelled' : 'status-pending') + '">Stock: ' + (p.stock || 0) + '</span></div>' +
        '</div>';
      });
      list.innerHTML = html;
    }).catch(function () {});
  }

  /* ============ PRODUCTS ============ */
  function loadProducts() {
    var tbody = $('productsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Loading products...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/products?select=*&order=id.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentProducts = rows;
        renderProductsTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function renderProductsTable(rows) {
    var tbody = $('productsBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">No products yet. Click "Add Product".</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (p) {
      var img = p.image_folder ? ('assets/products/' + p.image_folder + '/1.jpg') : 'assets/products/placeholder.svg';
      var stockCls = p.stock === 0 ? 'status-cancelled' : (p.stock <= LOW_STOCK_THRESHOLD ? 'status-pending' : 'status-delivered');
      html += '<tr data-id="' + p.id + '">' +
        '<td><img class="admin-product-thumb" src="' + img + '" onerror="this.src=\'assets/products/placeholder.svg\'"></td>' +
        '<td><strong>' + esc(p.name) + '</strong><br><small style="color:#64748b;">' + esc(p.brand) + '</small></td>' +
        '<td>' + esc(p.category) + '</td>' +
        '<td><strong>' + fmtPrice(p.price) + '</strong></td>' +
        '<td><span class="status-pill ' + stockCls + '">' + (p.stock || 0) + '</span></td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-action="edit" data-id="' + p.id + '">Edit</button>' +
          '<button class="admin-action-btn danger" data-action="delete" data-id="' + p.id + '">Delete</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = parseInt(btn.getAttribute('data-id'), 10);
        var a = btn.getAttribute('data-action');
        if (a === 'edit') openProductModal(id);
        if (a === 'delete') deleteProduct(id);
      });
    });
  }

  function openProductModal(id) {
    pendingImages = [];
    var up = $('uploadPreview'); if (up) up.innerHTML = '';
    var fs = $('formStatus'); if (fs) fs.textContent = '';
    var pf = $('productForm'); if (pf) pf.reset();
    var rt = $('pf-rating'); if (rt) rt.value = '4.5';
    if (id) {
      var p = currentProducts.find(function (x) { return x.id === id; });
      if (!p) return;
      var mt = $('modalTitle'); if (mt) mt.textContent = 'Edit Product';
      var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
      setV('pf-id', p.id);
      setV('pf-name', p.name);
      setV('pf-brand', p.brand);
      setV('pf-category', p.category);
      setV('pf-stock', p.stock || 0);
      setV('pf-price', p.price);
      setV('pf-mrp', p.mrp);
      setV('pf-rating', p.rating || 4.5);
      setV('pf-folder', p.image_folder || '');
      setV('pf-description', p.description || '');
    } else {
      var mt2 = $('modalTitle'); if (mt2) mt2.textContent = 'Add Product';
      var idf = $('pf-id'); if (idf) idf.value = '';
    }
    var pm = $('productModal'); if (pm) pm.classList.add('open');
  }

  function closeProductModal() {
    var pm = $('productModal'); if (pm) pm.classList.remove('open');
    pendingImages = [];
    var up = $('uploadPreview'); if (up) up.innerHTML = '';
  }

  function handleImageSelect(files) {
    var preview = $('uploadPreview');
    if (!preview) return;
    Array.prototype.forEach.call(files, function (file) {
      if (!file.type.startsWith('image/')) return;
      pendingImages.push(file);
    });
    renderUploadPreview();
  }

  function renderUploadPreview() {
    var preview = $('uploadPreview');
    if (!preview) return;
    preview.innerHTML = '';

    if (!pendingImages.length) return;

    // Drag hint
    var hint = document.createElement('div');
    hint.className = 'upload-reorder-hint';
    hint.textContent = '🖐️ Drag to reorder · First image is the cover';
    preview.appendChild(hint);

    pendingImages.forEach(function (file, idx) {
      var reader = new FileReader();
      reader.onload = (function (i, f) {
        return function (e) {
          var div = document.createElement('div');
          div.className = 'upload-prev-item';
          div.draggable = true;
          div.dataset.idx = i;
          div.innerHTML =
            '<span class="prev-index">' + (i + 1) + '</span>' +
            '<img src="' + e.target.result + '" draggable="false">' +
            '<button type="button" class="upload-prev-remove" data-idx="' + i + '" aria-label="Remove">×</button>';
          preview.appendChild(div);

          // Bind remove
          var rm = div.querySelector('.upload-prev-remove');
          if (rm) rm.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var idx = parseInt(rm.getAttribute('data-idx'), 10);
            pendingImages.splice(idx, 1);
            renderUploadPreview();
          });

          // Bind drag
          div.addEventListener('dragstart', function (ev) {
            ev.dataTransfer.setData('text/plain', i);
            div.classList.add('dragging');
          });
          div.addEventListener('dragend', function () {
            div.classList.remove('dragging');
          });
          div.addEventListener('dragover', function (ev) {
            ev.preventDefault();
            div.classList.add('drag-over');
          });
          div.addEventListener('dragleave', function () {
            div.classList.remove('drag-over');
          });
          div.addEventListener('drop', function (ev) {
            ev.preventDefault();
            div.classList.remove('drag-over');
            var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
            var to = i;
            if (isNaN(from) || from === to) return;
            var moved = pendingImages.splice(from, 1)[0];
            pendingImages.splice(to, 0, moved);
            renderUploadPreview();
          });
        };
      })(idx, file);
      reader.readAsDataURL(file);
    });
  }

  function saveProduct(e) {
    e.preventDefault();
    var btn = $('saveProductBtn');
    var status = $('formStatus');
    var id = ($('pf-id') && $('pf-id').value) || '';
    var data = {
      name: ($('pf-name') || {}).value ? $('pf-name').value.trim() : '',
      brand: ($('pf-brand') || {}).value ? $('pf-brand').value.trim() : '',
      category: ($('pf-category') || {}).value || '',
      stock: parseInt(($('pf-stock') || {}).value, 10) || 0,
      price: parseInt(($('pf-price') || {}).value, 10) || 0,
      mrp: parseInt(($('pf-mrp') || {}).value, 10) || 0,
      rating: parseFloat(($('pf-rating') || {}).value) || 4.5,
      image_folder: ($('pf-folder') || {}).value ? $('pf-folder').value.trim().toLowerCase() : '',
      description: ($('pf-description') || {}).value ? $('pf-description').value.trim() : '',
      active: true
    };
    if (!data.name || !data.brand || !data.category || !data.price || !data.mrp) {
      showStatus(status, 'Please fill all required fields', 'err'); return;
    }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="admin-spinner"></span> Saving...'; }
    showStatus(status, '', '');
    var url = SUPABASE_URL + '/rest/v1/products';
    var method = 'POST';
    var headers = apiHeaders(true);
    headers['Prefer'] = 'return=representation';
    if (id) { url += '?id=eq.' + encodeURIComponent(id); method = 'PATCH'; }
    authFetch(url, { method: method, headers: headers, body: JSON.stringify(data) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function () { throw new Error('Save failed'); });
        return r.json();
      })
      .then(function () {
        if (pendingImages.length > 0 && data.image_folder) {
          return uploadImages(data.image_folder, pendingImages);
        }
      })
      .then(function () {
        showStatus(status, '✓ Saved', 'ok');
        logActivity(id ? 'product_edit' : 'product_add', 'product', id || data.name, data.name);
        loadProducts();
        loadOverview();
        checkStockAlerts();
        setTimeout(closeProductModal, 900);
      })
      .catch(function (err) { showStatus(status, err.message || 'Save failed', 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save Product'; } });
  }

  function uploadImages(folder, files) {
    if (!session || !session.access_token) return Promise.resolve();
    var uploads = files.map(function (file, i) {
      var ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      var path = 'products/' + folder + '/' + (i + 1) + '.' + ext;
      var url = SUPABASE_URL + '/storage/v1/object/product-images/' + path;
      return authFetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + session.access_token,
          'Content-Type': file.type,
          'x-upsert': 'true'
        },
        body: file
      }).then(function (r) {
        if (!r.ok) console.warn('Upload failed:', path, r.status);
      });
    });
    return Promise.all(uploads);
  }

  function deleteProduct(id) {
    var p = currentProducts.find(function (x) { return x.id === id; });
    if (!p) return;
    if (!confirm('Delete "' + p.name + '"?\n\nThis cannot be undone.')) return;
    authFetch(SUPABASE_URL + '/rest/v1/products?id=eq.' + id, { method: 'DELETE', headers: apiHeaders(true) })
      .then(function (r) {
        if (!r.ok) throw new Error('Delete failed');
        logActivity('product_delete', 'product', id, p.name);
        loadProducts();
        loadOverview();
        checkStockAlerts();
      })
      .catch(function (err) { alert(err.message); });
  }

  /* ============ ORDERS ============ */
  function loadOrders() {
    var tbody = $('ordersBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Loading orders...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/orders?select=*&order=created_at.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentOrders = rows;
        applyOrderFilters();
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function applyOrderFilters() {
    var search = (($('orderSearch') || {}).value || '').trim().toLowerCase();
    var status = (($('orderStatusFilter') || {}).value) || '';
    var reg = (($('orderRegFilter') || {}).value) || '';
    var filtered = currentOrders.filter(function (o) {
      if (status && (o.status || 'Pending') !== status) return false;
      if (reg === 'registered' && !o.user_id) return false;
      if (reg === 'guest' && o.user_id) return false;
      if (search) {
        var hay = ((o.order_number || '') + ' ' + (o.customer_name || '') + ' ' +
          (o.phone || '') + ' ' + (o.email || '')).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    });
    renderOrdersTable(filtered);
  }

  function renderOrdersTable(rows) {
    var tbody = $('ordersBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">No orders found.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (o) {
      var registered = o.user_id ? '<br><small style="color:#16a34a;font-size:.68rem;">✓ Registered</small>' : '<br><small style="color:#94a3b8;font-size:.68rem;">Guest</small>';
      html += '<tr data-id="' + o.id + '">' +
        '<td><strong>' + esc(o.order_number || '—') + '</strong><br><small style="color:#94a3b8;">' + fmtDate(o.created_at) + '</small></td>' +
        '<td>' + esc(o.customer_name || '—') +
          (o.email ? '<br><small style="color:#2563eb;">' + esc(o.email) + '</small>' : '') +
          registered + '</td>' +
        '<td>' + esc(o.phone || '—') + '</td>' +
        '<td><strong>' + fmtPrice(o.total) + '</strong></td>' +
        '<td>' + statusPill(o.status) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-action="view" data-id="' + o.id + '" style="background:#2563eb;color:#fff;border-color:#2563eb;">View</button>' +
          '<button class="admin-action-btn" data-action="invoice" data-id="' + o.id + '">Invoice</button>' +
          '<select class="admin-action-btn" data-action="status" data-id="' + o.id + '" style="padding:6px 8px;">' +
            '<option value="Pending"' + ((o.status || 'Pending') === 'Pending' ? ' selected' : '') + '>Pending</option>' +
            '<option value="Shipped"' + (o.status === 'Shipped' ? ' selected' : '') + '>Shipped</option>' +
            '<option value="Delivered"' + (o.status === 'Delivered' ? ' selected' : '') + '>Delivered</option>' +
            '<option value="Cancelled"' + (o.status === 'Cancelled' ? ' selected' : '') + '>Cancelled</option>' +
          '</select>' +
          '<button class="admin-action-btn" data-action="wa" data-id="' + o.id + '">WA</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-action="view"]').forEach(function (b) {
      b.addEventListener('click', function () { openOrderDetails(parseInt(b.getAttribute('data-id'), 10)); });
    });
    tbody.querySelectorAll('[data-action="invoice"]').forEach(function (b) {
      b.addEventListener('click', function () { openInvoice(parseInt(b.getAttribute('data-id'), 10)); });
    });
    tbody.querySelectorAll('[data-action="status"]').forEach(function (s) {
      s.addEventListener('change', function () { updateOrderStatus(parseInt(s.getAttribute('data-id'), 10), s.value); });
    });
    tbody.querySelectorAll('[data-action="wa"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var o = currentOrders.find(function (x) { return x.id === parseInt(b.getAttribute('data-id'), 10); });
        if (!o) return;
        var msg = 'Hi ' + (o.customer_name || 'there') + ', this is GIMPZ. Update on your order ' + (o.order_number || '') + ': ' + (o.status || 'Pending') + '.';
        window.open('https://wa.me/91' + (o.phone || '').replace(/\D/g, '').slice(-10) + '?text=' + encodeURIComponent(msg), '_blank');
      });
    });
  }

  function openOrderDetails(orderId) {
    var order = currentOrders.find(function (x) { return x.id === orderId; });
    if (!order) return;
    var modal = $('orderModal');
    var title = $('orderModalTitle');
    var body = $('orderModalBody');
    if (!modal || !title || !body) return;
    title.textContent = 'Order ' + (order.order_number || '');
    body.innerHTML = '<p style="color:#64748b;text-align:center;padding:30px;">Loading...</p>';
    modal.classList.add('open');
    authFetch(SUPABASE_URL + '/rest/v1/order_items?select=*&order_id=eq.' + orderId + '&order=id.asc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (items) {
        if (!Array.isArray(items)) items = [];
        var html = '';
        html += '<div style="background:#f8fbff;border:1px solid #dbeafe;border-radius:10px;padding:14px 16px;margin-bottom:16px;">' +
          '<div style="font-size:.72rem;font-weight:700;color:#2563eb;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Customer</div>' +
          '<div style="font-size:.9rem;line-height:1.75;color:#334155;">' +
            '<strong style="color:#0a2540;">' + esc(order.customer_name || '—') + '</strong><br>' +
            '📞 <a href="tel:' + esc(order.phone || '') + '" style="color:#2563eb;">' + esc(order.phone || '—') + '</a><br>' +
            (order.email ? '✉️ ' + esc(order.email) + '<br>' : '') +
            '📍 ' + esc(order.address || '') + ', ' + esc(order.city || '') + ', ' + esc(order.state || '') + ' — ' + esc(order.pincode || '') +
          '</div>' +
        '</div>';
        html += '<div style="font-size:.72rem;font-weight:700;color:#2563eb;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">Items (' + items.length + ')</div>';
        if (!items.length) {
          html += '<p style="color:#94a3b8;text-align:center;">No items.</p>';
        } else {
          html += '<div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">';
          items.forEach(function (it, i) {
            html += '<div style="display:grid;grid-template-columns:1fr auto auto;gap:14px;padding:12px 14px;border-bottom:' + (i === items.length - 1 ? '0' : '1px solid #f1f5f9') + ';font-size:.88rem;align-items:center;">' +
              '<div><strong style="color:#0a2540;">' + esc(it.product_name) + '</strong>' +
                (it.product_brand ? '<br><small style="color:#64748b;">' + esc(it.product_brand) + '</small>' : '') + '</div>' +
              '<div style="font-weight:600;">× ' + it.quantity + '</div>' +
              '<div style="font-weight:700;color:#0a2540;">' + fmtPrice(it.line_total) + '</div>' +
            '</div>';
          });
          html += '</div>';
        }
        html += '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0;">' +
          '<div style="display:flex;justify-content:space-between;font-size:.86rem;margin-bottom:6px;"><span>Subtotal</span><span>' + fmtPrice(order.subtotal) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:.86rem;margin-bottom:6px;"><span>Shipping</span><span>' + (order.shipping > 0 ? fmtPrice(order.shipping) : 'FREE') + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:1.05rem;font-weight:800;color:#0a2540;padding-top:10px;border-top:1px solid #f1f5f9;margin-top:8px;"><span>Total</span><span>' + fmtPrice(order.total) + '</span></div>' +
        '</div>';
        html += '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">' +
          '<div style="background:#f1f5f9;border-radius:8px;padding:8px 12px;font-size:.8rem;"><strong>Payment:</strong> ' + esc(order.payment_method || '—') + '</div>' +
          '<div>' + statusPill(order.status) + '</div>' +
        '</div>';
        html += '<p style="margin-top:12px;font-size:.76rem;color:#94a3b8;">Placed on ' + fmtDate(order.created_at) + '</p>';
        html += '<div style="display:flex;gap:10px;margin-top:16px;">' +
          '<button class="btn btn-primary" style="flex:1;padding:11px;font-size:.85rem;" id="odInvoice">Print Invoice</button>' +
          '<button class="btn btn-outline" style="flex:1;padding:11px;font-size:.85rem;" id="odClose">Close</button>' +
        '</div>';
        body.innerHTML = html;
        var inv = $('odInvoice');
        if (inv) inv.addEventListener('click', function () { openInvoice(orderId); });
        var cl = $('odClose');
        if (cl) cl.addEventListener('click', function () { modal.classList.remove('open'); });
      })
      .catch(function (err) {
        body.innerHTML = '<p style="color:#dc2626;text-align:center;">Failed: ' + esc(err.message) + '</p>';
      });
  }

  function updateOrderStatus(id, status) {
    authFetch(SUPABASE_URL + '/rest/v1/orders?id=eq.' + id, {
      method: 'PATCH',
      headers: apiHeaders(true),
      body: JSON.stringify({ status: status })
    }).then(function (r) {
      if (!r.ok) throw new Error('Update failed');
      var o = currentOrders.find(function (x) { return x.id === id; });
      if (o) o.status = status;
      logActivity('order_status', 'order', id, 'Changed to ' + status);
      loadOverview();
    }).catch(function (err) { alert(err.message); });
  }

  /* ============ CUSTOMERS ============ */
  function loadCustomers() {
    var tbody = $('customersBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">Loading customers...</td></tr>';
    Promise.all([
      authFetch(SUPABASE_URL + '/rest/v1/profiles?select=*&order=created_at.desc', { headers: apiHeaders(true) }).then(function (r) { return r.json(); }),
      authFetch(SUPABASE_URL + '/rest/v1/orders?select=user_id,total,status', { headers: apiHeaders(true) }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var profiles = Array.isArray(results[0]) ? results[0] : [];
      var orders = Array.isArray(results[1]) ? results[1] : [];
      var stats = {};
      orders.forEach(function (o) {
        if (!o.user_id) return;
        if (!stats[o.user_id]) stats[o.user_id] = { count: 0, total: 0 };
        stats[o.user_id].count++;
        if ((o.status || 'Pending').toLowerCase() !== 'cancelled') {
          stats[o.user_id].total += Number(o.total || 0);
        }
      });
      currentCustomers = profiles.map(function (p) {
        var s = stats[p.id] || { count: 0, total: 0 };
        return { id: p.id, email: p.email, full_name: p.full_name, phone: p.phone, order_count: s.count, total_spent: s.total };
      });
      applyCustomerFilter();
    }).catch(function (err) {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
    });
  }

  function applyCustomerFilter() {
    var search = (($('customerSearch') || {}).value || '').trim().toLowerCase();
    var filtered = currentCustomers.filter(function (c) {
      if (!search) return true;
      var hay = ((c.full_name || '') + ' ' + (c.email || '') + ' ' + (c.phone || '')).toLowerCase();
      return hay.indexOf(search) !== -1;
    });
    renderCustomersTable(filtered);
  }

  function renderCustomersTable(rows) {
    var tbody = $('customersBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">No customers yet.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (c) {
      var initial = (c.full_name || c.email || '?').charAt(0).toUpperCase();
      html += '<tr>' +
        '<td><div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="admin-avatar" style="width:36px;height:36px;font-size:.9rem;">' + initial + '</div>' +
          '<div><strong>' + esc(c.full_name || '—') + '</strong><br><small style="color:#2563eb;">' + esc(c.email || '') + '</small></div>' +
        '</div></td>' +
        '<td>' + esc(c.phone || '—') + '</td>' +
        '<td><strong>' + c.order_count + '</strong></td>' +
        '<td><strong>' + fmtPrice(c.total_spent) + '</strong></td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          (c.phone ? '<a href="https://wa.me/91' + c.phone.replace(/\D/g, '').slice(-10) + '" target="_blank" class="admin-action-btn" style="text-decoration:none;">WA</a>' : '') +
          '<a href="mailto:' + esc(c.email || '') + '" class="admin-action-btn" style="text-decoration:none;">Email</a>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
  }

  /* ============ CATEGORIES ============ */
  function loadCategories() {
    var tbody = $('categoriesBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Loading...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/categories?select=*&order=display_order.asc,id.asc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentCategories = rows;
        renderCategoriesTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function renderCategoriesTable(rows) {
    var tbody = $('categoriesBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">No categories yet.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (c) {
      html += '<tr>' +
        '<td style="font-size:1.6rem;">' + esc(c.icon || '📦') + '</td>' +
        '<td><strong>' + esc(c.name) + '</strong></td>' +
        '<td><code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:.8rem;">' + esc(c.slug) + '</code></td>' +
        '<td>' + (c.display_order || 0) + '</td>' +
        '<td>' + (c.active ? '<span class="status-pill status-delivered">Active</span>' : '<span class="status-pill status-cancelled">Hidden</span>') + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-cat-edit="' + c.id + '">Edit</button>' +
          '<button class="admin-action-btn danger" data-cat-delete="' + c.id + '">Delete</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-cat-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openCategoryModal(parseInt(b.getAttribute('data-cat-edit'), 10)); });
    });
    tbody.querySelectorAll('[data-cat-delete]').forEach(function (b) {
      b.addEventListener('click', function () { deleteCategory(parseInt(b.getAttribute('data-cat-delete'), 10)); });
    });
  }

  function openCategoryModal(id) {
    var cf = $('categoryForm'); if (cf) cf.reset();
    var cs = $('categoryStatus'); if (cs) cs.textContent = '';
    var ca = $('cat-active'); if (ca) ca.checked = true;
    if (id) {
      var c = currentCategories.find(function (x) { return x.id === id; });
      if (!c) return;
      var ct = $('categoryModalTitle'); if (ct) ct.textContent = 'Edit Category';
      var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
      setV('cat-id', c.id);
      setV('cat-name', c.name);
      setV('cat-slug', c.slug);
      setV('cat-icon', c.icon || '');
      setV('cat-order', c.display_order || 0);
      var ca2 = $('cat-active'); if (ca2) ca2.checked = c.active !== false;
    } else {
      var ct2 = $('categoryModalTitle'); if (ct2) ct2.textContent = 'Add Category';
      var ci = $('cat-id'); if (ci) ci.value = '';
    }
    var cm = $('categoryModal'); if (cm) cm.classList.add('open');
  }

  function closeCategoryModal() { var m = $('categoryModal'); if (m) m.classList.remove('open'); }

  function saveCategory(e) {
    e.preventDefault();
    var btn = $('saveCategoryBtn');
    var status = $('categoryStatus');
    var id = ($('cat-id') || {}).value || '';
    var data = {
      name: ($('cat-name') || {}).value ? $('cat-name').value.trim() : '',
      slug: ($('cat-slug') || {}).value ? $('cat-slug').value.trim().toLowerCase() : '',
      icon: ($('cat-icon') || {}).value ? $('cat-icon').value.trim() || '📦' : '📦',
      display_order: parseInt(($('cat-order') || {}).value, 10) || 0,
      active: $('cat-active') ? $('cat-active').checked : true
    };
    if (!data.name || !data.slug) { showStatus(status, 'Name and slug required', 'err'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var url = SUPABASE_URL + '/rest/v1/categories';
    var method = 'POST';
    if (id) { url += '?id=eq.' + id; method = 'PATCH'; }
    authFetch(url, { method: method, headers: apiHeaders(true), body: JSON.stringify(data) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function () { throw new Error('Failed'); });
        showStatus(status, '✓ Saved', 'ok');
        logActivity(id ? 'category_edit' : 'category_add', 'category', id || data.slug, data.name);
        loadCategories();
        loadCategoriesIntoSelect();
        setTimeout(closeCategoryModal, 700);
      })
      .catch(function () { showStatus(status, 'Save failed', 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } });
  }

  function deleteCategory(id) {
    var c = currentCategories.find(function (x) { return x.id === id; });
    if (!c) return;
    if (!confirm('Delete "' + c.name + '"?')) return;
    authFetch(SUPABASE_URL + '/rest/v1/categories?id=eq.' + id, { method: 'DELETE', headers: apiHeaders(true) })
      .then(function () {
        logActivity('category_delete', 'category', id, c.name);
        loadCategories();
        loadCategoriesIntoSelect();
      })
      .catch(function (err) { alert(err.message); });
  }

  function loadCategoriesIntoSelect() {
    authFetch(SUPABASE_URL + '/rest/v1/categories?select=name,active&active=eq.true&order=display_order.asc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        var sel = $('pf-category');
        if (!sel) return;
        var current = sel.value;
        sel.innerHTML = '<option value="">Choose category</option>';
        (Array.isArray(rows) ? rows : []).forEach(function (c) {
          var opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name;
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      })
      .catch(function () {});
  }

  /* ============ COUPONS ============ */
  function loadCoupons() {
    var tbody = $('couponsBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">Loading...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/coupons?select=*&order=id.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentCoupons = rows;
        renderCouponsTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function renderCouponsTable(rows) {
    var tbody = $('couponsBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No coupons yet.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (c) {
      var discount = c.discount_type === 'percent' ? c.discount_value + '%' : fmtPrice(c.discount_value);
      var expired = c.expires_at && new Date(c.expires_at) < new Date();
      var status = !c.active ? '<span class="status-pill status-cancelled">Inactive</span>'
        : expired ? '<span class="status-pill status-cancelled">Expired</span>'
        : '<span class="status-pill status-delivered">Active</span>';
      var uses = (c.times_used || 0) + (c.max_uses ? ' / ' + c.max_uses : '');
      html += '<tr>' +
        '<td><code style="background:#f1f5f9;padding:4px 10px;border-radius:6px;font-weight:700;font-size:.9rem;">' + esc(c.code) + '</code></td>' +
        '<td><strong>' + discount + '</strong></td>' +
        '<td>' + (c.min_order ? fmtPrice(c.min_order) : '—') + '</td>' +
        '<td>' + uses + '</td>' +
        '<td>' + (c.expires_at ? fmtDateOnly(c.expires_at) : 'Never') + '</td>' +
        '<td>' + status + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-cpn-edit="' + c.id + '">Edit</button>' +
          '<button class="admin-action-btn danger" data-cpn-delete="' + c.id + '">Delete</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('[data-cpn-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openCouponModal(parseInt(b.getAttribute('data-cpn-edit'), 10)); });
    });
    tbody.querySelectorAll('[data-cpn-delete]').forEach(function (b) {
      b.addEventListener('click', function () { deleteCoupon(parseInt(b.getAttribute('data-cpn-delete'), 10)); });
    });
  }

  function openCouponModal(id) {
    var cf = $('couponForm'); if (cf) cf.reset();
    var cs = $('couponStatus'); if (cs) cs.textContent = '';
    var ca = $('cpn-active'); if (ca) ca.checked = true;
    if (id) {
      var c = currentCoupons.find(function (x) { return x.id === id; });
      if (!c) return;
      var ct = $('couponModalTitle'); if (ct) ct.textContent = 'Edit Coupon';
      var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
      setV('cpn-id', c.id);
      setV('cpn-code', c.code || '');
      setV('cpn-type', c.discount_type || 'percent');
      setV('cpn-value', c.discount_value || '');
      setV('cpn-min', c.min_order || 0);
      setV('cpn-max', c.max_uses || '');
      setV('cpn-expires', c.expires_at ? c.expires_at.split('T')[0] : '');
      var ca2 = $('cpn-active'); if (ca2) ca2.checked = c.active !== false;
    } else {
      var ct2 = $('couponModalTitle'); if (ct2) ct2.textContent = 'Create Coupon';
      var ci = $('cpn-id'); if (ci) ci.value = '';
    }
    var cm = $('couponModal'); if (cm) cm.classList.add('open');
  }

  function closeCouponModal() { var m = $('couponModal'); if (m) m.classList.remove('open'); }

  function saveCoupon(e) {
    e.preventDefault();
    var btn = $('saveCouponBtn');
    var status = $('couponStatus');
    var id = ($('cpn-id') || {}).value || '';
    var code = ($('cpn-code') || {}).value ? $('cpn-code').value.trim().toUpperCase() : '';
    var type = ($('cpn-type') || {}).value || 'percent';
    var val = parseInt(($('cpn-value') || {}).value, 10);
    var min = parseInt(($('cpn-min') || {}).value, 10) || 0;
    var max = ($('cpn-max') || {}).value ? parseInt($('cpn-max').value, 10) : null;
    var exp = ($('cpn-expires') || {}).value || null;
    if (!code || !val) { showStatus(status, 'Code and value required', 'err'); return; }
    if (type === 'percent' && (val < 1 || val > 100)) { showStatus(status, 'Percent must be 1-100', 'err'); return; }
    var data = {
      code: code,
      discount_type: type,
      discount_value: val,
      min_order: min,
      max_uses: max,
      expires_at: exp ? new Date(exp).toISOString() : null,
      active: $('cpn-active') ? $('cpn-active').checked : true
    };
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var url = SUPABASE_URL + '/rest/v1/coupons';
    var method = 'POST';
    if (id) { url += '?id=eq.' + id; method = 'PATCH'; }
    authFetch(url, { method: method, headers: apiHeaders(true), body: JSON.stringify(data) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function () { throw new Error('Failed'); });
        showStatus(status, '✓ Saved', 'ok');
        logActivity(id ? 'coupon_edit' : 'coupon_add', 'coupon', id || code, code);
        loadCoupons();
        setTimeout(closeCouponModal, 700);
      })
      .catch(function () { showStatus(status, 'Save failed. Code may already exist.', 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } });
  }

  function deleteCoupon(id) {
    if (!confirm('Delete this coupon?')) return;
    authFetch(SUPABASE_URL + '/rest/v1/coupons?id=eq.' + id, { method: 'DELETE', headers: apiHeaders(true) })
      .then(function () { loadCoupons(); })
      .catch(function (err) { alert(err.message); });
  }

  /* ============ ANALYTICS ============ */
  function loadAnalytics() {
    authFetch(SUPABASE_URL + '/rest/v1/orders?select=*&order=created_at.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (orders) {
        if (!Array.isArray(orders)) orders = [];
        var valid = orders.filter(function (o) { return (o.status || 'Pending').toLowerCase() !== 'cancelled'; });
        var now = new Date();
        var todayKey = now.toISOString().split('T')[0];
        var monthKey = todayKey.slice(0, 7);
        var todayRev = 0, monthRev = 0, totalRev = 0;
        valid.forEach(function (o) {
          var d = (o.created_at || '').split('T')[0];
          if (d === todayKey) todayRev += Number(o.total || 0);
          if (d.indexOf(monthKey) === 0) monthRev += Number(o.total || 0);
          totalRev += Number(o.total || 0);
        });
        var e1 = $('anaTodayRevenue'); if (e1) e1.textContent = fmtPrice(todayRev);
        var e2 = $('anaMonthRevenue'); if (e2) e2.textContent = fmtPrice(monthRev);
        var e3 = $('anaAvgOrder'); if (e3) e3.textContent = valid.length ? fmtPrice(Math.round(totalRev / valid.length)) : '₹0';
        var uCount = {};
        valid.forEach(function (o) {
          if (!o.user_id) return;
          uCount[o.user_id] = (uCount[o.user_id] || 0) + 1;
        });
        var repeat = Object.keys(uCount).filter(function (k) { return uCount[k] > 1; }).length;
        var e4 = $('anaRepeat'); if (e4) e4.textContent = repeat;

        var days = [];
        for (var i = 13; i >= 0; i--) {
          var d = new Date();
          d.setDate(d.getDate() - i);
          days.push({ key: d.toISOString().split('T')[0], label: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), count: 0, total: 0 });
        }
        valid.forEach(function (o) {
          var k = (o.created_at || '').split('T')[0];
          var day = days.find(function (x) { return x.key === k; });
          if (day) { day.count++; day.total += Number(o.total || 0); }
        });
        renderBarChart('chartDaily', days, 'total');

        authFetch(SUPABASE_URL + '/rest/v1/order_items?select=line_total,product_id', { headers: apiHeaders(true) })
          .then(function (r) { return r.json(); })
          .then(function (items) {
            if (!Array.isArray(items)) items = [];
            var catTotals = {};
            items.forEach(function (it) {
              var p = currentProducts.find(function (x) { return x.id === it.product_id; });
              var cat = p ? p.category : 'Other';
              catTotals[cat] = (catTotals[cat] || 0) + Number(it.line_total || 0);
            });
            var rows = Object.keys(catTotals).map(function (k) { return { label: k, total: catTotals[k] }; })
              .sort(function (a, b) { return b.total - a.total; });
            renderBarChart('chartCategories', rows, 'total');

            var prodTotals = {};
            items.forEach(function (it) {
              var p = currentProducts.find(function (x) { return x.id === it.product_id; });
              var name = p ? p.name : ('Product #' + it.product_id);
              prodTotals[name] = (prodTotals[name] || 0) + Number(it.line_total || 0);
            });
            var top = Object.keys(prodTotals).map(function (k) { return { name: k, total: prodTotals[k] }; })
              .sort(function (a, b) { return b.total - a.total; })
              .slice(0, 10);
            var el = $('topProductsList');
            if (!el) return;
            if (!top.length) { el.innerHTML = '<p class="admin-empty">No sales yet</p>'; return; }
            var html = '';
            top.forEach(function (t, i) {
              html += '<div class="recent-order-row" style="grid-template-columns:30px 1fr auto;gap:14px;">' +
                '<div><strong>#' + (i + 1) + '</strong></div>' +
                '<div>' + esc(t.name) + '</div>' +
                '<div><strong>' + fmtPrice(t.total) + '</strong></div>' +
              '</div>';
            });
            el.innerHTML = html;
          }).catch(function () {});
      }).catch(function () {});
  }

  function renderBarChart(elId, data, valueKey) {
    var el = $(elId);
    if (!el) return;
    if (!data || !data.length) { el.innerHTML = '<p class="admin-empty">No data yet</p>'; return; }
    var max = Math.max.apply(null, data.map(function (d) { return Number(d[valueKey] || 0); }));
    if (max === 0) max = 1;
    var html = '<div style="display:flex;align-items:flex-end;gap:8px;height:200px;padding:20px 0;">';
    data.forEach(function (d) {
      var h = Math.max(4, (Number(d[valueKey] || 0) / max) * 160);
      var label = d.label || d.name || '';
      var value = Number(d[valueKey] || 0);
      html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;">' +
        '<div title="' + fmtPrice(value) + '" style="width:100%;background:linear-gradient(180deg,#3b82f6,#2563eb);border-radius:6px 6px 0 0;height:' + h + 'px;transition:.3s;"></div>' +
        '<div style="font-size:.68rem;color:#64748b;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;">' + esc(label) + '</div>' +
      '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  /* ============ MARKETING ============ */
  function loadMarketing() {
    var tbody = $('marketingBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">Loading...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/marketing_lists?select=*&order=created_at.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentMarketingLists = rows;
        renderMarketingTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
    loadAllCustomerEmails();
   loadNewsletterSubscribers();
  }

  function renderMarketingTable(rows) {
    var tbody = $('marketingBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">No lists yet. Click "New List".</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (l) {
      var count = (l.emails && l.emails.length) || 0;
      html += '<tr>' +
        '<td><strong>' + esc(l.name) + '</strong></td>' +
        '<td><span class="status-pill status-shipped">' + count + ' emails</span></td>' +
        '<td>' + fmtDateOnly(l.created_at) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-list-copy="' + l.id + '">Copy</button>' +
          '<button class="admin-action-btn" data-list-mail="' + l.id + '">Mail All</button>' +
          '<button class="admin-action-btn" data-list-edit="' + l.id + '">Edit</button>' +
          '<button class="admin-action-btn danger" data-list-delete="' + l.id + '">Delete</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('[data-list-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = currentMarketingLists.find(function (x) { return x.id === parseInt(b.getAttribute('data-list-copy'), 10); });
        if (!l || !l.emails) return;
        navigator.clipboard.writeText(l.emails.join(', ')).then(function () {
          b.textContent = '✓ Copied';
          setTimeout(function () { b.textContent = 'Copy'; }, 1500);
        });
      });
    });
    tbody.querySelectorAll('[data-list-mail]').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = currentMarketingLists.find(function (x) { return x.id === parseInt(b.getAttribute('data-list-mail'), 10); });
        if (!l || !l.emails || !l.emails.length) return;
        var subject = encodeURIComponent('Special offer from GIMPZ');
        var bcc = encodeURIComponent(l.emails.join(','));
        window.location.href = 'mailto:?bcc=' + bcc + '&subject=' + subject;
      });
    });
    tbody.querySelectorAll('[data-list-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openListModal(parseInt(b.getAttribute('data-list-edit'), 10)); });
    });
    tbody.querySelectorAll('[data-list-delete]').forEach(function (b) {
      b.addEventListener('click', function () { deleteMarketingList(parseInt(b.getAttribute('data-list-delete'), 10)); });
    });
  }

     function loadNewsletterSubscribers() {
    var el = $('newsletterList');
    var count = $('newsletterCount');
    if (!el) return;

    authFetch(SUPABASE_URL + '/rest/v1/newsletter_subscribers?select=email,subscribed_at&unsubscribed=eq.false&order=subscribed_at.desc&limit=500', {
      headers: apiHeaders(true)
    })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        if (count) count.textContent = rows.length + ' subscriber' + (rows.length === 1 ? '' : 's');

        if (!rows.length) {
          el.innerHTML = '<p class="admin-empty">No newsletter subscribers yet</p>';
          return;
        }

        el.innerHTML = rows.map(function (r) {
          return '<div style="padding:6px 0;font-family:monospace;font-size:.82rem;border-bottom:1px solid #f1f5f9;">' +
            esc(r.email) +
            ' <span style="color:#94a3b8;font-size:.72rem;margin-left:6px;">' + fmtDateOnly(r.subscribed_at) + '</span>' +
          '</div>';
        }).join('');
      })
      .catch(function () { el.innerHTML = '<p class="admin-empty">Failed to load subscribers</p>'; });
  }
  function loadAllCustomerEmails() {
    var el = $('allEmailsList');
    if (!el) return;
    authFetch(SUPABASE_URL + '/rest/v1/profiles?select=email&email=not.is.null', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) {
          el.innerHTML = '<p class="admin-empty">No customer emails yet</p>';
          return;
        }
        var emails = rows.map(function (r) { return r.email; }).filter(Boolean);
        el.innerHTML = emails.map(function (e) {
          return '<div style="padding:4px 0;font-family:monospace;font-size:.82rem;">' + esc(e) + '</div>';
        }).join('');
      })
      .catch(function () { el.innerHTML = '<p class="admin-empty">Failed to load emails</p>'; });
  }

  function openListModal(id) {
    var lf = $('listForm'); if (lf) lf.reset();
    var ls = $('listStatus'); if (ls) ls.textContent = '';
    var lc = $('list-email-count'); if (lc) lc.textContent = '0 emails';
    if (id) {
      var l = currentMarketingLists.find(function (x) { return x.id === id; });
      if (!l) return;
      var lt = $('listModalTitle'); if (lt) lt.textContent = 'Edit List';
      var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
      setV('list-id', l.id);
      setV('list-name', l.name || '');
      setV('list-emails', (l.emails || []).join('\n'));
      updateListEmailCount();
    } else {
      var lt2 = $('listModalTitle'); if (lt2) lt2.textContent = 'New Marketing List';
      var li = $('list-id'); if (li) li.value = '';
    }
    var lm = $('listModal'); if (lm) lm.classList.add('open');
  }

  function closeListModal() { var m = $('listModal'); if (m) m.classList.remove('open'); }

  function updateListEmailCount() {
    var raw = ($('list-emails') || {}).value || '';
    var emails = raw.split(/[\s,;]+/).filter(function (e) { return /@/.test(e); });
    var el = $('list-email-count');
    if (el) el.textContent = emails.length + ' emails';
  }

  function saveList(e) {
    e.preventDefault();
    var btn = $('saveListBtn');
    var status = $('listStatus');
    var id = ($('list-id') || {}).value || '';
    var name = ($('list-name') || {}).value ? $('list-name').value.trim() : '';
    var raw = ($('list-emails') || {}).value || '';
    var emails = raw.split(/[\s,;]+/).filter(function (e) { return /@/.test(e); }).map(function (e) { return e.trim(); });

    if (!name) { showStatus(status, 'Name required', 'err'); return; }
    if (!emails.length) { showStatus(status, 'At least one email required', 'err'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    var url = SUPABASE_URL + '/rest/v1/marketing_lists';
    var method = 'POST';
    if (id) { url += '?id=eq.' + id; method = 'PATCH'; }

    authFetch(url, {
      method: method,
      headers: apiHeaders(true),
      body: JSON.stringify({ name: name, emails: emails, updated_at: new Date().toISOString() })
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed');
      showStatus(status, '✓ Saved', 'ok');
      logActivity(id ? 'list_edit' : 'list_add', 'marketing_list', id || name, name);
      loadMarketing();
      setTimeout(closeListModal, 700);
    }).catch(function () { showStatus(status, 'Save failed', 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } });
  }

  function deleteMarketingList(id) {
    var l = currentMarketingLists.find(function (x) { return x.id === id; });
    if (!l) return;
    if (!confirm('Delete list "' + l.name + '"?')) return;
    authFetch(SUPABASE_URL + '/rest/v1/marketing_lists?id=eq.' + id, { method: 'DELETE', headers: apiHeaders(true) })
      .then(function () { logActivity('list_delete', 'marketing_list', id, l.name); loadMarketing(); })
      .catch(function (err) { alert(err.message); });
  }

  /* ============ MESSAGES ============ */
  function loadMessages() {
    var list = $('messagesList');
    if (!list) return;
    list.innerHTML = '<p class="admin-empty">Loading messages...</p>';

    var filter = ($('messageFilter') && $('messageFilter').value) || '';
    var url = SUPABASE_URL + '/rest/v1/contact_messages?select=*&order=created_at.desc&limit=500';
    if (filter) url += '&status=eq.' + encodeURIComponent(filter);

    authFetch(url, { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentMessages = rows;
        renderMessages(rows);
        updateMessagesBadge();
      })
      .catch(function (err) {
        list.innerHTML = '<p class="admin-empty">Failed: ' + esc(err.message) + '</p>';
      });
  }

  function updateMessagesBadge() {
    var badge = $('messagesBadge');
    if (!badge) return;
    authFetch(SUPABASE_URL + '/rest/v1/contact_messages?select=id&status=eq.New', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        var n = Array.isArray(rows) ? rows.length : 0;
        badge.textContent = n;
        badge.setAttribute('data-count', n);
      })
      .catch(function () {});
  }

  function renderMessages(rows) {
    var list = $('messagesList');
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<p class="admin-empty">No messages yet.</p>';
      return;
    }
    var html = '';
    rows.forEach(function (m) {
      var statusPill = m.status === 'New'
        ? '<span class="status-pill status-pending">New</span>'
        : m.status === 'Resolved'
          ? '<span class="status-pill status-delivered">Resolved</span>'
          : '<span class="status-pill status-shipped">' + esc(m.status || 'Read') + '</span>';

      var initial = (m.name || '?').charAt(0).toUpperCase();

      html += '<div class="msg-card" data-id="' + m.id + '">' +
        '<div class="msg-head">' +
          '<div class="msg-who">' +
            '<div class="admin-avatar" style="width:40px;height:40px;font-size:.95rem;">' + initial + '</div>' +
            '<div>' +
              '<strong>' + esc(m.name) + '</strong>' +
              '<div class="msg-contact">' +
                '<a href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>' +
                ' · <a href="tel:' + esc(m.phone) + '">' + esc(m.phone) + '</a>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="msg-meta">' +
            statusPill +
            '<small>' + fmtDate(m.created_at) + '</small>' +
          '</div>' +
        '</div>' +
        '<div class="msg-subject"><strong>Subject:</strong> ' + esc(m.subject) + '</div>' +
        '<div class="msg-body">' + esc(m.message).replace(/\n/g, '<br>') + '</div>' +
        '<div class="msg-actions">' +
          '<a class="admin-action-btn" href="mailto:' + esc(m.email) + '?subject=' + encodeURIComponent('Re: ' + m.subject) + '" style="text-decoration:none;">Reply</a>' +
          (m.status !== 'Read' ? '<button class="admin-action-btn" data-msg-status="Read" data-id="' + m.id + '">Mark Read</button>' : '') +
          (m.status !== 'Resolved' ? '<button class="admin-action-btn" data-msg-status="Resolved" data-id="' + m.id + '">Mark Resolved</button>' : '') +
          '<button class="admin-action-btn danger" data-msg-delete="' + m.id + '">Delete</button>' +
        '</div>' +
      '</div>';
    });
    list.innerHTML = html;

    list.querySelectorAll('[data-msg-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        updateMessageStatus(parseInt(b.getAttribute('data-id'), 10), b.getAttribute('data-msg-status'));
      });
    });
    list.querySelectorAll('[data-msg-delete]').forEach(function (b) {
      b.addEventListener('click', function () {
        deleteMessage(parseInt(b.getAttribute('data-msg-delete'), 10));
      });
    });
  }

  function updateMessageStatus(id, status) {
    authFetch(SUPABASE_URL + '/rest/v1/contact_messages?id=eq.' + id, {
      method: 'PATCH',
      headers: apiHeaders(true),
      body: JSON.stringify({ status: status })
    }).then(function (r) {
      if (!r.ok) throw new Error('Update failed');
      logActivity('message_status', 'contact_message', id, 'Marked ' + status);
      loadMessages();
    }).catch(function (err) { alert(err.message); });
  }

  function deleteMessage(id) {
    if (!confirm('Delete this message?')) return;
    authFetch(SUPABASE_URL + '/rest/v1/contact_messages?id=eq.' + id, {
      method: 'DELETE',
      headers: apiHeaders(true)
    }).then(function () {
      logActivity('message_delete', 'contact_message', id, '');
      loadMessages();
    }).catch(function (err) { alert(err.message); });
  }

  /* ============ STAFF ============ */
  function loadStaff() {
    var tbody = $('staffBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">Loading...</td></tr>';
    authFetch(SUPABASE_URL + '/rest/v1/admin_users?select=*&order=added_at.desc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentStaff = rows;
        renderStaffTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function renderStaffTable(rows) {
    var tbody = $('staffBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">No staff yet.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (s) {
      var roleLabel = { owner: '👑 Owner', admin: 'Admin', manager: 'Manager', viewer: 'Viewer' }[s.role] || s.role;
      html += '<tr>' +
        '<td><strong>' + esc(s.name || '—') + '</strong></td>' +
        '<td style="color:#2563eb;">' + esc(s.email) + '</td>' +
        '<td>' + roleLabel + '</td>' +
        '<td>' + (s.active ? '<span class="status-pill status-delivered">Active</span>' : '<span class="status-pill status-cancelled">Disabled</span>') + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="admin-action-btn" data-staff-edit="' + s.id + '">Edit</button>' +
          '<button class="admin-action-btn danger" data-staff-delete="' + s.id + '">Remove</button>' +
        '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('[data-staff-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openStaffModal(parseInt(b.getAttribute('data-staff-edit'), 10)); });
    });
    tbody.querySelectorAll('[data-staff-delete]').forEach(function (b) {
      b.addEventListener('click', function () { deleteStaff(parseInt(b.getAttribute('data-staff-delete'), 10)); });
    });
  }

  function openStaffModal(id) {
    var sf = $('staffForm'); if (sf) sf.reset();
    var ss = $('staffStatus'); if (ss) ss.textContent = '';
    var sa = $('staff-active'); if (sa) sa.checked = true;
    if (id) {
      var s = currentStaff.find(function (x) { return x.id === id; });
      if (!s) return;
      var st = $('staffModalTitle'); if (st) st.textContent = 'Edit Staff';
      var setV = function (fid, v) { var el = $(fid); if (el) el.value = v == null ? '' : v; };
      setV('staff-id', s.id);
      setV('staff-name', s.name || '');
      setV('staff-email', s.email || '');
      setV('staff-role', s.role || 'admin');
      var sa2 = $('staff-active'); if (sa2) sa2.checked = s.active !== false;
    } else {
      var st2 = $('staffModalTitle'); if (st2) st2.textContent = 'Add Staff';
      var si = $('staff-id'); if (si) si.value = '';
    }
    var sm = $('staffModal'); if (sm) sm.classList.add('open');
  }

  function closeStaffModal() { var m = $('staffModal'); if (m) m.classList.remove('open'); }

  function saveStaff(e) {
    e.preventDefault();
    var btn = $('saveStaffBtn');
    var status = $('staffStatus');
    var id = ($('staff-id') || {}).value || '';
    var data = {
      name: ($('staff-name') || {}).value ? $('staff-name').value.trim() : '',
      email: ($('staff-email') || {}).value ? $('staff-email').value.trim().toLowerCase() : '',
      role: ($('staff-role') || {}).value || 'admin',
      active: $('staff-active') ? $('staff-active').checked : true
    };
    if (!data.name || !data.email) { showStatus(status, 'Name and email required', 'err'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var url = SUPABASE_URL + '/rest/v1/admin_users';
    var method = 'POST';
    if (id) { url += '?id=eq.' + id; method = 'PATCH'; }
    authFetch(url, { method: method, headers: apiHeaders(true), body: JSON.stringify(data) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function () { throw new Error('Failed'); });
        showStatus(status, '✓ Saved', 'ok');
        logActivity(id ? 'staff_edit' : 'staff_add', 'admin_user', id || data.email, data.email);
        loadStaff();
        setTimeout(closeStaffModal, 700);
      })
      .catch(function () { showStatus(status, 'Save failed. Email may already exist.', 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } });
  }

  function deleteStaff(id) {
    var s = currentStaff.find(function (x) { return x.id === id; });
    if (!s) return;
    if (s.role === 'owner') { alert('Cannot remove the owner account.'); return; }
    if (!confirm('Remove "' + s.email + '" from admin panel?')) return;
    authFetch(SUPABASE_URL + '/rest/v1/admin_users?id=eq.' + id, { method: 'DELETE', headers: apiHeaders(true) })
      .then(function () { logActivity('staff_delete', 'admin_user', id, s.email); loadStaff(); })
      .catch(function (err) { alert(err.message); });
  }

  /* ============ ACTIVITY LOG ============ */
  function loadActivity() {
    var tbody = $('activityBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">Loading...</td></tr>';
    var filter = ($('activityFilter') && $('activityFilter').value) || '';
    var url = SUPABASE_URL + '/rest/v1/activity_log?select=*&order=created_at.desc&limit=200';
    if (filter) url += '&action=eq.' + encodeURIComponent(filter);
    authFetch(url, { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) rows = [];
        currentActivity = rows;
        renderActivityTable(rows);
      })
      .catch(function (err) {
        tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">Failed: ' + esc(err.message) + '</td></tr>';
      });
  }

  function renderActivityTable(rows) {
    var tbody = $('activityBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="admin-empty">No activity yet.</td></tr>';
      return;
    }
    var actionLabels = {
      product_add: '➕ Product Added', product_edit: '✏️ Product Edited', product_delete: '🗑️ Product Deleted',
      order_status: '📦 Order Status Changed',
      coupon_add: '🎟️ Coupon Added', coupon_edit: '✏️ Coupon Edited',
      category_add: '📁 Category Added', category_edit: '✏️ Category Edited', category_delete: '🗑️ Category Deleted',
      list_add: '📧 Marketing List Added', list_edit: '✏️ Marketing List Edited', list_delete: '🗑️ Marketing List Deleted',
      message_status: '💬 Message Status Changed', message_delete: '🗑️ Message Deleted',
      staff_add: '👤 Staff Added', staff_edit: '✏️ Staff Edited', staff_delete: '🗑️ Staff Removed'
    };
    var html = '';
    rows.forEach(function (a) {
      var label = actionLabels[a.action] || a.action;
      html += '<tr>' +
        '<td><small style="color:#64748b;">' + fmtDate(a.created_at) + '</small></td>' +
        '<td><small style="color:#2563eb;">' + esc(a.admin_email) + '</small></td>' +
        '<td><strong>' + label + '</strong></td>' +
        '<td><small>' + esc(a.details || '') + '</small></td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
  }

  /* ============ INVOICE ============ */
  function openInvoice(orderId) {
    var order = currentOrders.find(function (x) { return x.id === orderId; });
    if (!order) return;
    var modal = $('invoiceModal');
    var body = $('invoiceBody');
    if (!modal || !body) return;
    body.innerHTML = '<p style="text-align:center;color:#64748b;">Loading...</p>';
    modal.classList.add('open');
    authFetch(SUPABASE_URL + '/rest/v1/order_items?select=*&order_id=eq.' + orderId + '&order=id.asc', { headers: apiHeaders(true) })
      .then(function (r) { return r.json(); })
      .then(function (items) {
        if (!Array.isArray(items)) items = [];
        var rowsHtml = '';
        items.forEach(function (it, i) {
          rowsHtml += '<tr>' +
            '<td style="padding:8px;border-bottom:1px solid #e2e8f0;">' + (i + 1) + '</td>' +
            '<td style="padding:8px;border-bottom:1px solid #e2e8f0;">' + esc(it.product_name) + (it.product_brand ? '<br><small style="color:#64748b;">' + esc(it.product_brand) + '</small>' : '') + '</td>' +
            '<td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center;">' + it.quantity + '</td>' +
            '<td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">' + fmtPrice(it.price_at_time) + '</td>' +
            '<td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">' + fmtPrice(it.line_total) + '</td>' +
          '</tr>';
        });
        var html = '' +
          '<div style="text-align:center;margin-bottom:20px;">' +
            '<div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:6px;">' +
              '<div style="width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#2563eb,#22d3ee);color:#fff;display:grid;place-items:center;font-weight:800;font-size:1.2rem;">G</div>' +
              '<div style="text-align:left;"><div style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:800;font-size:1.2rem;color:#0a2540;">GIMPZ</div><div style="font-size:.7rem;color:#64748b;">Everything You Need, One Store</div></div>' +
            '</div>' +
            '<div style="font-size:.78rem;color:#64748b;">Patna, Bihar, India · +91 7061086068 · thegimpzzstore@gmail.com</div>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:20px;margin-bottom:20px;font-size:.88rem;">' +
            '<div><strong style="display:block;color:#0a2540;margin-bottom:6px;">BILL TO</strong>' +
              esc(order.customer_name || '') + '<br>' +
              esc(order.phone || '') + '<br>' +
              (order.email ? esc(order.email) + '<br>' : '') +
              esc(order.address || '') + '<br>' +
              esc(order.city || '') + ', ' + esc(order.state || '') + ' — ' + esc(order.pincode || '') +
            '</div>' +
            '<div style="text-align:right;"><strong style="display:block;color:#0a2540;margin-bottom:6px;">INVOICE</strong>' +
              '<div>Order: <b>' + esc(order.order_number || '') + '</b></div>' +
              '<div>Date: ' + fmtDateOnly(order.created_at) + '</div>' +
              '<div>Payment: ' + esc(order.payment_method || '—') + '</div>' +
              '<div>Status: ' + esc(order.status || 'Pending') + '</div>' +
            '</div>' +
          '</div>' +
          '<table style="width:100%;border-collapse:collapse;font-size:.88rem;">' +
            '<thead><tr style="background:#f8fbff;">' +
              '<th style="padding:10px 8px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#0a2540;">#</th>' +
              '<th style="padding:10px 8px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#0a2540;">Item</th>' +
              '<th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e2e8f0;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#0a2540;">Qty</th>' +
              '<th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#0a2540;">Price</th>' +
              '<th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#0a2540;">Total</th>' +
            '</tr></thead><tbody>' + rowsHtml + '</tbody>' +
          '</table>' +
          '<div style="margin-top:20px;text-align:right;">' +
            '<div style="display:flex;justify-content:flex-end;gap:20px;font-size:.88rem;margin-bottom:6px;"><span style="color:#64748b;">Subtotal</span><span style="min-width:80px;text-align:right;">' + fmtPrice(order.subtotal) + '</span></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:20px;font-size:.88rem;margin-bottom:6px;"><span style="color:#64748b;">Shipping</span><span style="min-width:80px;text-align:right;">' + (order.shipping > 0 ? fmtPrice(order.shipping) : 'FREE') + '</span></div>' +
            '<div style="display:flex;justify-content:flex-end;gap:20px;font-size:1.15rem;font-weight:800;color:#0a2540;padding-top:10px;border-top:2px solid #0a2540;margin-top:6px;"><span>Total</span><span style="min-width:80px;text-align:right;">' + fmtPrice(order.total) + '</span></div>' +
          '</div>' +
          '<p style="margin-top:30px;text-align:center;font-size:.78rem;color:#94a3b8;">Thank you for shopping with GIMPZ!</p>';
        body.innerHTML = html;
      })
      .catch(function (err) {
        body.innerHTML = '<p style="color:#dc2626;text-align:center;">Failed: ' + esc(err.message) + '</p>';
      });
  }

  function printInvoice() {
    var body = $('invoiceBody');
    if (!body) return;
    var win = window.open('', '_blank', 'width=800,height=900');
    win.document.write('<!DOCTYPE html><html><head><title>Invoice — GIMPZ</title><style>body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#334155;max-width:760px;margin:0 auto;}table{border-collapse:collapse;width:100%;}@media print{body{padding:0;}}</style></head><body>' + body.innerHTML + '</body></html>');
    win.document.close();
    win.focus();
    setTimeout(function () { win.print(); }, 300);
  }

  /* ============ INIT ============ */
  function init() {
    loadSession();

    var lf = $('loginForm');
    if (lf) {
      lf.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = $('adminEmail').value.trim();
        var password = $('adminPassword').value;
        var btn = $('loginBtn');
        var status = $('loginStatus');
        if (!email || !password) return;
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="admin-spinner"></span> Signing in...'; }
        login(email, password)
          .then(function () { showDashboard(); })
          .catch(function (err) { showStatus(status, err.message || 'Login failed', 'err'); })
          .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; } });
      });
    }

    var lb = $('logoutBtn');
    if (lb) lb.addEventListener('click', function () {
      if (confirm('Log out?')) logout();
    });

    document.querySelectorAll('.admin-nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    document.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-goto')); });
    });

    var mt = $('menuToggle');
    if (mt) mt.addEventListener('click', function () {
      var sb = $('adminSidebar');
      if (sb) sb.classList.toggle('open');
    });

    var apb = $('addProductBtn'); if (apb) apb.addEventListener('click', function () { openProductModal(null); });
    var mc = $('modalClose'); if (mc) mc.addEventListener('click', closeProductModal);
    var cfb = $('cancelFormBtn'); if (cfb) cfb.addEventListener('click', closeProductModal);
    var pm = $('productModal');
    if (pm) pm.addEventListener('click', function (e) { if (e.target === pm) closeProductModal(); });
    var pf = $('productForm'); if (pf) pf.addEventListener('submit', saveProduct);

    var upload = $('adminUpload'), input = $('pf-images');
    if (upload && input) {
      upload.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () { handleImageSelect(input.files); input.value = ''; });
      ['dragover', 'dragenter'].forEach(function (ev) {
        upload.addEventListener(ev, function (e) { e.preventDefault(); upload.classList.add('drag'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        upload.addEventListener(ev, function (e) { e.preventDefault(); upload.classList.remove('drag'); });
      });
      upload.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) handleImageSelect(e.dataTransfer.files);
      });
    }

    var omc = $('orderModalClose');
    if (omc) omc.addEventListener('click', function () { var m = $('orderModal'); if (m) m.classList.remove('open'); });
    var om = $('orderModal');
    if (om) om.addEventListener('click', function (e) { if (e.target === om) om.classList.remove('open'); });

    var rob = $('refreshOrdersBtn'); if (rob) rob.addEventListener('click', loadOrders);
    var os = $('orderSearch'); if (os) os.addEventListener('input', applyOrderFilters);
    var osf = $('orderStatusFilter'); if (osf) osf.addEventListener('change', applyOrderFilters);
    var orf = $('orderRegFilter'); if (orf) orf.addEventListener('change', applyOrderFilters);

    var rcb = $('refreshCustomersBtn'); if (rcb) rcb.addEventListener('click', loadCustomers);
    var cs = $('customerSearch'); if (cs) cs.addEventListener('input', applyCustomerFilter);

    var acb = $('addCategoryBtn'); if (acb) acb.addEventListener('click', function () { openCategoryModal(null); });
    var cmc = $('categoryModalClose'); if (cmc) cmc.addEventListener('click', closeCategoryModal);
    var ccb = $('cancelCategoryBtn'); if (ccb) ccb.addEventListener('click', closeCategoryModal);
    var cform = $('categoryForm'); if (cform) cform.addEventListener('submit', saveCategory);
    var cm = $('categoryModal');
    if (cm) cm.addEventListener('click', function (e) { if (e.target === cm) closeCategoryModal(); });
    var cn = $('cat-name');
    if (cn) cn.addEventListener('input', function () {
      var slug = $('cat-slug');
      var catId = $('cat-id');
      if (slug && (!catId || !catId.value)) {
        slug.value = this.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
    });

    var acpb = $('addCouponBtn'); if (acpb) acpb.addEventListener('click', function () { openCouponModal(null); });
    var cpcmc = $('couponModalClose'); if (cpcmc) cpcmc.addEventListener('click', closeCouponModal);
    var cpcb = $('cancelCouponBtn'); if (cpcb) cpcb.addEventListener('click', closeCouponModal);
    var cpf = $('couponForm'); if (cpf) cpf.addEventListener('submit', saveCoupon);
    var cpm = $('couponModal');
    if (cpm) cpm.addEventListener('click', function (e) { if (e.target === cpm) closeCouponModal(); });

    var imc = $('invoiceModalClose');
    if (imc) imc.addEventListener('click', function () { var m = $('invoiceModal'); if (m) m.classList.remove('open'); });
    var icb = $('invoiceCancelBtn');
    if (icb) icb.addEventListener('click', function () { var m = $('invoiceModal'); if (m) m.classList.remove('open'); });
    var ipb = $('invoicePrintBtn'); if (ipb) ipb.addEventListener('click', printInvoice);
    var im = $('invoiceModal');
    if (im) im.addEventListener('click', function (e) { if (e.target === im) im.classList.remove('open'); });

    var alb = $('addListBtn'); if (alb) alb.addEventListener('click', function () { openListModal(null); });
    var lmc = $('listModalClose'); if (lmc) lmc.addEventListener('click', closeListModal);
    var lcb = $('cancelListBtn'); if (lcb) lcb.addEventListener('click', closeListModal);
    var lf2 = $('listForm'); if (lf2) lf2.addEventListener('submit', saveList);
    var lm = $('listModal');
    if (lm) lm.addEventListener('click', function (e) { if (e.target === lm) closeListModal(); });
    var le = $('list-emails'); if (le) le.addEventListener('input', updateListEmailCount);

    var la = $('list-autofill');
    if (la) la.addEventListener('change', function () {
      if (!this.checked) return;
      authFetch(SUPABASE_URL + '/rest/v1/profiles?select=email&email=not.is.null', { headers: apiHeaders(true) })
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          if (!Array.isArray(rows)) return;
          var emails = rows.map(function (r) { return r.email; }).filter(Boolean).join('\n');
          var el = $('list-emails'); if (el) el.value = emails;
          updateListEmailCount();
        });
    });

    var caeb = $('copyAllEmailsBtn');
    if (caeb) caeb.addEventListener('click', function () {
      var el = $('allEmailsList');
      if (!el) return;
      var emails = Array.prototype.slice.call(el.querySelectorAll('div')).map(function (d) { return d.textContent.trim(); }).filter(function (e) { return /@/.test(e); });
      if (!emails.length) return;
      var btn = this;
      navigator.clipboard.writeText(emails.join(', ')).then(function () {
        btn.textContent = '✓ Copied';
        setTimeout(function () { btn.textContent = 'Copy All'; }, 1500);
      });
    });
    var cnlb = $('copyNewsletterBtn');
    if (cnlb) cnlb.addEventListener('click', function () {
      var el = $('newsletterList');
      if (!el) return;
      var emails = Array.prototype.slice.call(el.querySelectorAll('div')).map(function (d) {
        return d.textContent.trim().split(' ')[0];
      }).filter(function (e) { return /@/.test(e); });
      if (!emails.length) return;
      var btn = this;
      navigator.clipboard.writeText(emails.join(', ')).then(function () {
        btn.textContent = '✓ Copied';
        setTimeout(function () { btn.textContent = 'Copy All'; }, 1500);
      });
    });
    var rmb = $('refreshMessagesBtn'); if (rmb) rmb.addEventListener('click', loadMessages);
    var mf = $('messageFilter'); if (mf) mf.addEventListener('change', loadMessages);

    var asb = $('addStaffBtn'); if (asb) asb.addEventListener('click', function () { openStaffModal(null); });
    var smc = $('staffModalClose'); if (smc) smc.addEventListener('click', closeStaffModal);
    var scb = $('cancelStaffBtn'); if (scb) scb.addEventListener('click', closeStaffModal);
    var sf = $('staffForm'); if (sf) sf.addEventListener('submit', saveStaff);
    var sm = $('staffModal');
    if (sm) sm.addEventListener('click', function (e) { if (e.target === sm) closeStaffModal(); });

    var rab = $('refreshActivityBtn'); if (rab) rab.addEventListener('click', loadActivity);
    var af = $('activityFilter'); if (af) af.addEventListener('change', loadActivity);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        ['productModal', 'orderModal', 'categoryModal', 'couponModal', 'invoiceModal', 'listModal', 'staffModal'].forEach(function (id) {
          var m = $(id);
          if (m) m.classList.remove('open');
        });
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (session && session.access_token) {
        refreshCurrentTab();
        updateMessagesBadge();
      }
    });

    if (session && session.access_token) showDashboard();
    else showLoginScreen();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
