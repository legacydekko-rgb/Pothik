/* ==========================================================================
   Pothik — Admin dashboard
   KPIs · charts · driver approval · live monitoring · fare/commission config
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = function (s) { return document.getElementById(s); };
  const t = function (k, v) { return global.t(k, v); };
  const esc = function (s) { return UI.esc(s); };
  const money = function (n) { return PothikGeo.money(n); };

  let adminUser = null, adminRecord = null;
  let current = 'dashboard';
  let charts = {};
  let liveTimer = null;
  let cache = {};              // last loaded datasets

  const NAV = [
    { group: 'admin.overview', items: [
      { id: 'dashboard', icon: 'fa-chart-pie', label: 'admin.dashboard' },
      { id: 'analytics', icon: 'fa-chart-line', label: 'admin.analytics' },
      { id: 'live', icon: 'fa-satellite-dish', label: 'admin.liveRides' }
    ]},
    { group: 'admin.drivers', items: [
      { id: 'approvals', icon: 'fa-user-check', label: 'admin.driverApproval' },
      { id: 'drivers', icon: 'fa-id-card', label: 'admin.drivers' },
      { id: 'vehicles', icon: 'fa-car-side', label: 'admin.vehicles' },
      { id: 'documents', icon: 'fa-file-shield', label: 'admin.documents' }
    ]},
    { group: 'admin.passengers', items: [
      { id: 'passengers', icon: 'fa-users', label: 'admin.passengers' },
      { id: 'rides', icon: 'fa-route', label: 'admin.rides' }
    ]},
    { group: 'admin.revenue', items: [
      { id: 'fare', icon: 'fa-tags', label: 'admin.fareSettings' },
      { id: 'payments', icon: 'fa-credit-card', label: 'admin.payments' },
      { id: 'cancellations', icon: 'fa-ban', label: 'admin.cancellations' }
    ]},
    { group: 'admin.complaints', items: [
      { id: 'tickets', icon: 'fa-headset', label: 'admin.complaints' },
      { id: 'ratings', icon: 'fa-star', label: 'admin.ratings' }
    ]},
    { group: 'admin.settings', items: [
      { id: 'notifications', icon: 'fa-bell', label: 'admin.notifications' },
      { id: 'settings', icon: 'fa-gear', label: 'admin.settings' },
      { id: 'audit', icon: 'fa-clipboard-list', label: 'admin.audit' }
    ]}
  ];

  /* ================================ BOOT ================================= */
  document.addEventListener('DOMContentLoaded', async function () {
    await Shell.boot();

    const sess = Auth.getSession();
    if (sess && sess.role === 'admin') {
      showApp();
    } else {
      $('admin-gate').classList.remove('hidden');
      $('admin-app').classList.add('hidden');
      $('gate-form').addEventListener('submit', handleGateLogin);
    }
  });

  async function handleGateLogin(e) {
    e.preventDefault();
    const err = $('gate-err');
    err.textContent = '';
    try {
      const res = await Auth.login($('gate-phone').value, $('gate-password').value, 'admin');
      if (res.user.role !== 'admin') { err.textContent = t('err.notAllowed'); return; }
      Auth.saveSession(res.session);
      await Auth.audit(res.user.id, 'admin', 'ADMIN_LOGIN', 'admin_users', res.user.id, {});
      showApp();
    } catch (ex) {
      err.textContent = ex.message && ex.message.indexOf('auth.') === 0 ? t(ex.message) : t('err.generic');
    }
  }

  async function showApp() {
    $('admin-gate').classList.add('hidden');
    $('admin-app').classList.remove('hidden');

    adminUser = await Auth.currentUser();
    if (!adminUser || adminUser.role !== 'admin') { location.reload(); return; }
    adminRecord = await DB.findWhere('admin_users', function (a) { return a.user_id === adminUser.id; });

    $('admin-avatar').innerHTML = UI.avatarHtml(adminUser.full_name, adminUser.photo_url);
    $('admin-name').textContent = adminUser.full_name;
    $('admin-role').textContent = t('app.role.admin') + (adminRecord ? ' · ' + adminRecord.role : '');

    renderNav();
    bindChrome();
    await go('dashboard');
  }

  function renderNav() {
    const host = $('admin-nav');
    host.innerHTML = NAV.map(function (sec) {
      return '<div class="nav-group">' + esc(t(sec.group)) + '</div>' +
        sec.items.map(function (it) {
          return '<button data-nav="' + it.id + '"' + (it.id === current ? ' aria-current="page"' : '') + '>' +
            '<i class="fa-solid ' + it.icon + '"></i><span>' + esc(t(it.label)) + '</span>' +
            '<span class="nav-count hidden" data-count="' + it.id + '"></span></button>';
        }).join('');
    }).join('');

    host.querySelectorAll('button[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        closeDrawer();
        go(b.dataset.nav);
      });
    });
  }

  function bindChrome() {
    $('admin-burger').addEventListener('click', openDrawer);
    $('admin-scrim').addEventListener('click', closeDrawer);
    $('admin-refresh').addEventListener('click', function () {
      cache = {};
      go(current);
      UI.toast(t('common.updated'), 'success');
    });
    $('admin-lang').addEventListener('click', function () {
      I18n.setLang(I18n.getLang() === 'bn' ? 'en' : 'bn');
      this.querySelector('span').textContent = I18n.getLang() === 'bn' ? 'EN' : 'বাং';
      renderNav();
      go(current);
    });
    $('admin-logout').addEventListener('click', async function () {
      const ok = await UI.confirm({ title: t('auth.logout'), message: t('auth.logout') + '?', danger: true });
      if (!ok) return;
      await Auth.audit(adminUser.id, 'admin', 'ADMIN_LOGOUT', 'admin_users', adminUser.id, {});
      Auth.logout();
      location.reload();
    });
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function openDrawer() {
    $('admin-side').classList.add('open');
    $('admin-scrim').classList.add('open');
  }
  function closeDrawer() {
    $('admin-side').classList.remove('open');
    $('admin-scrim').classList.remove('open');
  }

  /* ============================== DATA LOAD ============================== */
  async function load(key, table, opts) {
    if (cache[key]) return cache[key];
    try {
      const rows = await DB.list(table, opts || { limit: 500 });
      cache[key] = rows || [];
    } catch (e) {
      cache[key] = [];
    }
    return cache[key];
  }

  async function loadAll() {
    const [users, passengers, drivers, statuses, vehicles, docs, rides, payments, ratings, tickets, cancellations, commissions, logs, notifs, settings] =
      await Promise.all([
        load('users', 'users'), load('passengers', 'passengers'), load('drivers', 'drivers'),
        load('statuses', 'driver_status'), load('vehicles', 'vehicles'), load('docs', 'driver_documents'),
        load('rides', 'rides'), load('payments', 'payments'), load('ratings', 'ratings'),
        load('tickets', 'support_tickets'), load('cancellations', 'cancellations'),
        load('commissions', 'commissions'), load('logs', 'audit_logs'),
        load('notifs', 'notifications'), load('settings', 'platform_settings')
      ]);
    return { users, passengers, drivers, statuses, vehicles, docs, rides, payments, ratings, tickets, cancellations, commissions, logs, notifs, settings };
  }

  /* ============================== ROUTER ================================= */
  async function go(section) {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    current = section;
    const meta = findNavMeta(section);
    $('admin-title').textContent = meta ? t(meta.label) : section;
    $('admin-crumb').textContent = t('admin.title') + ' / ' + (meta ? t(meta.label) : section);
    $('admin-conn').innerHTML = Shell.connectionPill();
    $('admin-updated').textContent = t('admin.lastUpdate') + ' ' + PothikGeo.clockTime(Date.now());
    renderNav();

    const body = $('admin-body');
    body.innerHTML = '<div class="card center"><span class="spinner" style="color:var(--brand-500);width:26px;height:26px"></span><p class="mt-3" style="margin:0;color:var(--muted)">' + esc(t('common.loading')) + '</p></div>';

    destroyCharts();

    try {
      const data = await loadAll();
      const renderers = {
        dashboard: renderDashboard, analytics: renderAnalytics, live: renderLive,
        approvals: renderApprovals, drivers: renderDrivers, vehicles: renderVehicles,
        documents: renderDocuments, passengers: renderPassengers, rides: renderRides,
        fare: renderFare, payments: renderPayments, cancellations: renderCancellations,
        tickets: renderTickets, ratings: renderRatings, notifications: renderNotifications,
        settings: renderSettings, audit: renderAudit
      };
      const fn = renderers[section] || renderDashboard;
      await fn(data);
      updateNavCounts(data);
    } catch (e) {
      body.innerHTML = '<div class="alert alert-danger"><i class="fa-solid fa-circle-exclamation"></i><span>' +
        esc(t('err.generic')) + ' — ' + esc(e.message) + '</span></div>';
    }
  }

  function findNavMeta(id) {
    for (const sec of NAV) {
      const hit = sec.items.find(function (i) { return i.id === id; });
      if (hit) return hit;
    }
    return null;
  }

  function updateNavCounts(data) {
    const pending = data.drivers.filter(function (d) { return d.status === 'pending'; }).length;
    const openTickets = data.tickets.filter(function (x) { return x.status === 'open'; }).length;
    setCount('approvals', pending);
    setCount('tickets', openTickets);
    setCount('live', data.rides.filter(function (r) { return RideState.isActive(r.status); }).length);
  }

  function setCount(id, n) {
    const el = document.querySelector('[data-count="' + id + '"]');
    if (!el) return;
    el.textContent = n || '';
    el.classList.toggle('hidden', !n);
  }

  function destroyCharts() {
    Object.keys(charts).forEach(function (k) {
      try { charts[k].destroy(); } catch (e) {}
      delete charts[k];
    });
  }

  /* ============================== METRICS ================================ */
  function metrics(data) {
    const nowTs = Date.now();
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const dayMs = startOfDay.getTime();

    const rides = data.rides;
    const active = rides.filter(function (r) { return RideState.isActive(r.status); });
    const completed = rides.filter(function (r) { return r.status === 'RIDE_COMPLETED' || r.status === 'PAYMENT_COMPLETED'; });
    const cancelled = rides.filter(function (r) { return RideState.isCancelled(r.status); });
    const paid = rides.filter(function (r) { return r.payment_status === 'Paid'; });

    const todayRides = rides.filter(function (r) { return (r.created_at || 0) >= dayMs; });
    const todayPaid = todayRides.filter(function (r) { return r.payment_status === 'Paid'; });

    const grossAll = paid.reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0);
    const commAll = paid.reduce(function (a, r) { return a + Number(r.commission_amount || 0); }, 0);
    const driverAll = paid.reduce(function (a, r) { return a + Number(r.driver_earning || 0); }, 0);
    const grossToday = todayPaid.reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0);
    const commToday = todayPaid.reduce(function (a, r) { return a + Number(r.commission_amount || 0); }, 0);
    const driverToday = todayPaid.reduce(function (a, r) { return a + Number(r.driver_earning || 0); }, 0);

    const STALE = Matching.STALE_AFTER_MS;
    const onlineNow = data.statuses.filter(function (s) {
      return s.is_online === true && (nowTs - Number(s.last_ping_at || 0)) < STALE;
    });
    const availableNow = onlineNow.filter(function (s) { return !s.active_ride_id; });

    return {
      totalPassengers: data.passengers.length,
      totalDrivers: data.drivers.length,
      approvedDrivers: data.drivers.filter(function (d) { return d.status === 'approved'; }).length,
      pendingDrivers: data.drivers.filter(function (d) { return d.status === 'pending'; }).length,
      activeDrivers: onlineNow.length,
      availableDrivers: availableNow.length,
      busyDrivers: onlineNow.length - availableNow.length,
      totalRides: rides.length,
      activeRides: active.length,
      completedRides: completed.length,
      cancelledRides: cancelled.length,
      todayRides: todayRides.length,
      todayCompleted: todayRides.filter(function (r) { return r.status === 'RIDE_COMPLETED' || r.status === 'PAYMENT_COMPLETED'; }).length,
      grossAll: grossAll, commAll: commAll, driverAll: driverAll,
      grossToday: grossToday, commToday: commToday, driverToday: driverToday,
      openTickets: data.tickets.filter(function (x) { return x.status === 'open'; }).length,
      avgRating: data.ratings.length
        ? data.ratings.filter(function (r) { return r.ratee_role === 'driver'; })
            .reduce(function (a, r, _, arr) { return a + Number(r.stars) / (arr.length || 1); }, 0)
        : 0,
      onlineNow: onlineNow,
      availableNow: availableNow
    };
  }

  /* ============================ DASHBOARD ================================ */
  async function renderDashboard(data) {
    const m = metrics(data);
    const rides = data.rides;

    const body = $('admin-body');
    body.innerHTML = '';

    // KPI grid
    const kpis = [
      { label: t('admin.totalPassengers'), value: m.totalPassengers, icon: 'fa-users', delta: 'up', sub: '+' + countSince(data.passengers, 7) + ' / 7d' },
      { label: t('admin.totalDrivers'), value: m.totalDrivers, icon: 'fa-id-card', delta: 'flat', sub: m.approvedDrivers + ' ' + t('drv.status.approved') },
      { label: t('admin.activeDrivers'), value: m.activeDrivers, icon: 'fa-satellite-dish', delta: m.activeDrivers > 0 ? 'up' : 'flat', sub: m.availableDrivers + ' ' + t('veh.available') },
      { label: t('admin.activeRides'), value: m.activeRides, icon: 'fa-route', delta: m.activeRides > 0 ? 'up' : 'flat', sub: t('admin.liveRides') },
      { label: t('admin.completedRides'), value: m.completedRides, icon: 'fa-circle-check', delta: 'up', sub: m.todayCompleted + ' ' + t('common.today') },
      { label: t('admin.cancelledRides'), value: m.cancelledRides, icon: 'fa-ban', delta: 'down', sub: m.totalRides ? Math.round(m.cancelledRides / m.totalRides * 100) + '%' : '0%' },
      { label: t('admin.todayRevenue'), value: money(m.grossToday), icon: 'fa-bangladeshi-taka-sign', delta: 'up', sub: m.todayRides + ' ' + t('admin.rides') },
      { label: t('admin.driverEarnings'), value: money(m.driverToday), icon: 'fa-sack-dollar', delta: 'flat', sub: t('common.today') },
      { label: t('admin.platformCommission'), value: money(m.commToday), icon: 'fa-percent', delta: 'up', sub: Settings.get('commissionPct') + '%' },
      { label: t('admin.pendingApprovals'), value: m.pendingDrivers, icon: 'fa-user-clock', delta: m.pendingDrivers ? 'down' : 'flat', sub: t('admin.driverApproval') }
    ];

    const kpiGrid = document.createElement('div');
    kpiGrid.className = 'kpi-grid';
    kpiGrid.innerHTML = kpis.map(function (k) {
      return '<article class="kpi">' +
        '<div class="kpi-top"><span class="kpi-icon"><i class="fa-solid ' + k.icon + '"></i></span>' +
        '<span class="kpi-delta ' + k.delta + '">' + (k.delta === 'up' ? '<i class="fa-solid fa-arrow-trend-up"></i>' : (k.delta === 'down' ? '<i class="fa-solid fa-arrow-trend-down"></i>' : '<i class="fa-solid fa-minus"></i>')) + '</span></div>' +
        '<span class="kpi-label">' + esc(k.label) + '</span>' +
        '<span class="kpi-value">' + esc(String(k.value)) + '</span>' +
        '<span class="kpi-delta flat">' + esc(k.sub) + '</span>' +
        '</article>';
    }).join('');
    body.appendChild(kpiGrid);

    // Charts row 1
    const row1 = document.createElement('div');
    row1.className = 'grid-2 mt-4';
    row1.innerHTML =
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.dailyRides')) + '</h3>' +
      '<span class="badge badge-brand">14 ' + esc(I18n.getLang() === 'bn' ? 'দিন' : 'days') + '</span></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:260px"><canvas id="ch-rides"></canvas></div></div></section>' +
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.revenue')) + ' (৳)</h3>' +
      '<span class="badge badge-success">' + esc(money(m.grossAll)) + '</span></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:260px"><canvas id="ch-revenue"></canvas></div></div></section>';
    body.appendChild(row1);

    // Charts row 2
    const row2 = document.createElement('div');
    row2.className = 'grid-3 mt-4';
    row2.innerHTML =
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.rideStatus')) + '</h3></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:230px"><canvas id="ch-status"></canvas></div></div></section>' +
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.vehicleMix')) + '</h3></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:230px"><canvas id="ch-vehicles"></canvas></div></div></section>' +
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.newPassengers')) + '</h3></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:230px"><canvas id="ch-pax"></canvas></div></div></section>';
    body.appendChild(row2);

    // Live drivers + top drivers + recent rides
    const topDrivers = data.drivers.slice().sort(function (a, b) {
      return Number(b.completed_rides || 0) - Number(a.completed_rides || 0);
    }).slice(0, 5);

    const recent = rides.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }).slice(0, 8);

    const row3 = document.createElement('div');
    row3.className = 'grid-2 mt-4';
    row3.innerHTML =
      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(t('admin.activeDrivers')) + '</h3>' +
      '<span class="badge badge-success"><span class="dot dot-live"></span>' + m.activeDrivers + ' ' + esc(I18n.getLang() === 'bn' ? 'অনলাইন' : 'online') + '</span></div>' +
      '<div class="card-bd" style="max-height:340px;overflow:auto"><ul class="list">' +
      (m.onlineNow.length ? m.onlineNow.map(function (s) {
        const d = data.drivers.find(function (x) { return x.id === s.driver_id; }) || {};
        return '<li class="list-item">' + UI.avatarHtml(d.full_name || '?', d.photo_url) +
          '<span class="li-main"><span class="li-title">' + esc(d.full_name || s.driver_id) + '</span>' +
          '<span class="li-sub">' + esc(t('veh.' + (s.vehicle_type || 'car'))) + ' · ' + esc(PothikGeo.distance(0)) + '</span></span>' +
          '<span class="badge ' + (s.active_ride_id ? 'badge-warn' : 'badge-success') + '">' +
          esc(s.active_ride_id ? (I18n.getLang() === 'bn' ? 'ব্যস্ত' : 'busy') : (I18n.getLang() === 'bn' ? 'খালি' : 'free')) + '</span></li>';
      }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>') +
      '</ul></div></section>' +

      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(t('admin.topDrivers')) + '</h3></div>' +
      '<div class="card-bd"><ul class="list">' + topDrivers.map(function (d) {
        return '<li class="list-item">' + UI.avatarHtml(d.full_name, d.photo_url) +
          '<span class="li-main"><span class="li-title">' + esc(d.full_name) + '</span>' +
          '<span class="li-sub">' + esc(t('veh.' + (d.vehicle_type || 'car'))) + ' · ' + d.completed_rides + ' ' + esc(t('admin.rides')) + '</span></span>' +
          '<span class="right">' + UI.starsHtml(d.rating, 'sm') + '<span style="display:block;font-size:12px">' + esc(money(d.driver_earning)) + '</span></span></li>';
      }).join('') + '</ul></div></section>';
    body.appendChild(row3);

    // Recent rides table
    const tableCard = document.createElement('section');
    tableCard.className = 'card card-flush mt-4';
    tableCard.innerHTML =
      '<div class="card-hd"><h3>' + esc(t('admin.recentRides')) + '</h3>' +
      '<button class="btn btn-ghost btn-sm" id="go-rides">' + esc(t('admin.allRides')) + ' <i class="fa-solid fa-arrow-right"></i></button></div>' +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
      '<th>' + esc(t('hist.rideId')) + '</th><th>' + esc(t('app.role.passenger')) + '</th><th>' + esc(t('app.role.driver')) + '</th>' +
      '<th>' + esc(t('veh.bike')) + '</th><th>' + esc(t('ride.trip')) + '</th><th class="num">' + esc(t('ride.fare')) + '</th>' +
      '<th>' + esc(t('common.status')) + '</th><th>' + esc(t('pay.title')) + '</th></tr></thead><tbody>' +
      recent.map(function (r) {
        const pax = data.users.find(function (u) { return u.id === r.passenger_user_id; }) || {};
        const drv = data.drivers.find(function (d) { return d.id === r.driver_id; }) || {};
        return '<tr><td><strong>' + esc(r.ride_code || r.id.slice(-6)) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + esc(PothikGeo.clockTime(r.created_at)) + '</span></td>' +
          '<td>' + esc(pax.full_name || '—') + '</td><td>' + esc(drv.full_name || '—') + '</td>' +
          '<td>' + esc(t('veh.' + (r.vehicle_type || 'car'))) + '</td>' +
          '<td>' + esc(PothikGeo.distance(Number(r.distance_km) || 0)) + '</td>' +
          '<td class="num">' + (RideState.isCancelled(r.status) ? '—' : money(r.fare_total)) + '</td>' +
          '<td>' + UI.statusBadge(r.status) + '</td>' +
          '<td>' + UI.statusBadge(r.payment_status || 'Pending') + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
    body.appendChild(tableCard);

    // ---- Charts ----
    drawRideChart(rides);
    drawRevenueChart(rides);
    drawStatusChart(m, rides);
    drawVehicleChart(rides, data.drivers);
    drawPassengerChart(data.passengers);

    const goRides = $('go-rides');
    if (goRides) goRides.addEventListener('click', function () { go('rides'); });
  }

  function countSince(rows, days) {
    const since = Date.now() - days * 86400000;
    return rows.filter(function (r) { return Number(r.created_at || 0) >= since; }).length;
  }

  function lastNDays(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    return d.getDate() + '/' + (d.getMonth() + 1);
  }

  function chartDefaults() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      grid: dark ? 'rgba(255,255,255,.08)' : 'rgba(11,21,18,.07)',
      text: dark ? '#93A5A0' : '#5B6B66',
      font: { family: 'Inter, Noto Sans Bengali, sans-serif', size: 11 }
    };
  }

  function drawRideChart(rides) {
    const days = lastNDays(14);
    const completed = days.map(function (d) {
      return rides.filter(function (r) {
        return new Date(Number(r.created_at || 0)).toISOString().slice(0, 10) === d &&
          (r.status === 'RIDE_COMPLETED' || r.status === 'PAYMENT_COMPLETED');
      }).length;
    });
    const cancelled = days.map(function (d) {
      return rides.filter(function (r) {
        return new Date(Number(r.created_at || 0)).toISOString().slice(0, 10) === d && RideState.isCancelled(r.status);
      }).length;
    });
    const cd = chartDefaults();
    const ctx = $('ch-rides');
    if (!ctx) return;
    charts.rides = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: days.map(dayLabel),
        datasets: [
          { label: t('st.RIDE_COMPLETED'), data: completed, backgroundColor: '#0A7C5A', borderRadius: 4, stack: 'a' },
          { label: t('ride.cancelled'), data: cancelled, backgroundColor: '#FF5A36', borderRadius: 4, stack: 'a' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: cd.text, font: cd.font, boxWidth: 10, usePointStyle: true } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: cd.text, font: cd.font } },
          y: { stacked: true, beginAtZero: true, grid: { color: cd.grid }, ticks: { color: cd.text, font: cd.font, precision: 0 } }
        }
      }
    });
  }

  function drawRevenueChart(rides) {
    const days = lastNDays(14);
    const gross = days.map(function (d) {
      return rides.filter(function (r) {
        return r.payment_status === 'Paid' && new Date(Number(r.paid_at || r.created_at || 0)).toISOString().slice(0, 10) === d;
      }).reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0);
    });
    const comm = days.map(function (d) {
      return rides.filter(function (r) {
        return r.payment_status === 'Paid' && new Date(Number(r.paid_at || r.created_at || 0)).toISOString().slice(0, 10) === d;
      }).reduce(function (a, r) { return a + Number(r.commission_amount || 0); }, 0);
    });
    const cd = chartDefaults();
    const ctx = $('ch-revenue');
    if (!ctx) return;
    charts.revenue = new Chart(ctx, {
      type: 'line',
      data: {
        labels: days.map(dayLabel),
        datasets: [
          { label: t('earn.gross'), data: gross, borderColor: '#0A7C5A', backgroundColor: 'rgba(10,124,90,.14)', fill: true, tension: .36, pointRadius: 2, borderWidth: 2.5 },
          { label: t('earn.commission'), data: comm, borderColor: '#F5A524', backgroundColor: 'rgba(245,165,36,.12)', fill: true, tension: .36, pointRadius: 2, borderWidth: 2.5 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: cd.text, font: cd.font, boxWidth: 10, usePointStyle: true } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: cd.text, font: cd.font } },
          y: { beginAtZero: true, grid: { color: cd.grid }, ticks: { color: cd.text, font: cd.font, callback: function (v) { return '৳' + v; } } }
        }
      }
    });
  }

  function drawStatusChart(m, rides) {
    const cd = chartDefaults();
    const ctx = $('ch-status');
    if (!ctx) return;
    const groups = {
      [t('st.RIDE_COMPLETED')]: m.completedRides,
      [t('admin.activeRides')]: m.activeRides,
      [t('st.CANCELLED_BY_PASSENGER')]: rides.filter(function (r) { return r.status === 'CANCELLED_BY_PASSENGER'; }).length,
      [t('st.CANCELLED_BY_DRIVER')]: rides.filter(function (r) { return r.status === 'CANCELLED_BY_DRIVER'; }).length,
      [t('st.PAYMENT_PENDING')]: rides.filter(function (r) { return r.status === 'PAYMENT_PENDING'; }).length
    };
    charts.status = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: Object.keys(groups),
        datasets: [{ data: Object.values(groups), backgroundColor: ['#0A7C5A', '#2B7FFF', '#FF5A36', '#E63E19', '#F5A524'], borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { color: cd.text, font: cd.font, boxWidth: 9, usePointStyle: true, padding: 10 } } }
      }
    });
  }

  function drawVehicleChart(rides, drivers) {
    const cd = chartDefaults();
    const ctx = $('ch-vehicles');
    if (!ctx) return;
    const types = Settings.vehicleList().map(function (v) { return v.type; });
    const counts = types.map(function (ty) {
      return rides.filter(function (r) { return r.vehicle_type === ty; }).length;
    });
    charts.vehicles = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: types.map(function (ty) { return t('veh.' + ty); }),
        datasets: [{ data: counts, backgroundColor: types.map(function (ty) { return Settings.vehicle(ty).color || '#0A7C5A'; }), borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { color: cd.text, font: cd.font, boxWidth: 9, usePointStyle: true, padding: 10 } } }
      }
    });
  }

  function drawPassengerChart(passengers) {
    const days = lastNDays(14);
    const counts = days.map(function (d) {
      return passengers.filter(function (p) {
        return new Date(Number(p.created_at || 0)).toISOString().slice(0, 10) === d;
      }).length;
    });
    const cd = chartDefaults();
    const ctx = $('ch-pax');
    if (!ctx) return;
    charts.pax = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: days.map(dayLabel),
        datasets: [{ label: t('admin.newPassengers'), data: counts, backgroundColor: '#2B7FFF', borderRadius: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: cd.text, font: cd.font } },
          y: { beginAtZero: true, grid: { color: cd.grid }, ticks: { color: cd.text, font: cd.font, precision: 0 } }
        }
      }
    });
  }

  /* ============================== ANALYTICS ============================== */
  async function renderAnalytics(data) {
    const m = metrics(data);
    const rides = data.rides;
    const days = lastNDays(30);

    // Aggregations by area
    const byArea = {};
    rides.forEach(function (r) {
      const a = r.area || 'Unknown';
      byArea[a] = byArea[a] || { rides: 0, revenue: 0 };
      byArea[a].rides++;
      if (r.payment_status === 'Paid') byArea[a].revenue += Number(r.fare_total || 0);
    });
    const areaRows = Object.keys(byArea).map(function (k) {
      return { area: k, rides: byArea[k].rides, revenue: byArea[k].revenue };
    }).sort(function (a, b) { return b.rides - a.rides; }).slice(0, 10);

    // Peak hours
    const hours = new Array(24).fill(0);
    rides.forEach(function (r) {
      const h = new Date(Number(r.created_at || 0)).getHours();
      hours[h]++;
    });

    // Vehicle performance
    const vehPerf = Settings.vehicleList().map(function (v) {
      const mine = rides.filter(function (r) { return r.vehicle_type === v.type; });
      const done = mine.filter(function (r) { return r.payment_status === 'Paid'; });
      return {
        type: v.type,
        rides: mine.length,
        revenue: done.reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0),
        commission: done.reduce(function (a, r) { return a + Number(r.commission_amount || 0); }, 0),
        avg: done.length ? done.reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0) / done.length : 0
      };
    });

    $('admin-body').innerHTML =
      '<div class="kpi-grid mb-4">' +
      kpi(t('admin.completedRides'), m.completedRides, 'fa-circle-check') +
      kpi(t('admin.todayRevenue'), money(m.grossToday), 'fa-bangladeshi-taka-sign') +
      kpi(t('admin.platformCommission'), money(m.commAll), 'fa-percent') +
      kpi(I18n.getLang() === 'bn' ? 'সম্পন্নতার হার' : 'Completion rate', (m.totalRides ? Math.round(m.completedRides / m.totalRides * 100) : 0) + '%', 'fa-gauge-high') +
      '</div>' +

      '<div class="grid-2 mb-4">' +
      '<section class="card"><div class="card-hd"><h3>' + esc(t('admin.revenue')) + ' — 30 ' + esc(I18n.getLang() === 'bn' ? 'দিন' : 'days') + '</h3></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:280px"><canvas id="an-rev"></canvas></div></div></section>' +
      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'পিক আওয়ার' : 'Peak hours') + '</h3></div>' +
      '<div class="card-bd"><div class="chart-box" style="height:280px"><canvas id="an-hours"></canvas></div></div></section>' +
      '</div>' +

      '<section class="card card-flush mb-4"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'এলাকা অনুযায়ী' : 'By area') + '</h3></div>' +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
      '<th>' + esc(t('admin.area')) + '</th><th class="num">' + esc(t('admin.rides')) + '</th><th class="num">' + esc(t('admin.revenue')) + '</th></tr></thead><tbody>' +
      areaRows.map(function (a) {
        return '<tr><td>' + esc(a.area) + '</td><td class="num">' + a.rides + '</td><td class="num">' + money(a.revenue) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>' +

      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(t('admin.vehicleMix')) + '</h3></div>' +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
      '<th>' + esc(t('drv.vehicleType')) + '</th><th class="num">' + esc(t('admin.rides')) + '</th>' +
      '<th class="num">' + esc(t('earn.gross')) + '</th><th class="num">' + esc(t('earn.commission')) + '</th>' +
      '<th class="num">' + esc(t('earn.avgFare')) + '</th></tr></thead><tbody>' +
      vehPerf.map(function (v) {
        return '<tr><td><i class="fa-solid ' + Settings.vehicle(v.type).icon + '" style="color:' + Settings.vehicle(v.type).color + '"></i> ' + esc(t('veh.' + v.type)) + '</td>' +
          '<td class="num">' + v.rides + '</td><td class="num">' + money(v.revenue) + '</td>' +
          '<td class="num">' + money(v.commission) + '</td><td class="num">' + money(v.avg) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    const cd = chartDefaults();
    const revCtx = $('an-rev');
    if (revCtx) {
      const rev = days.map(function (d) {
        return rides.filter(function (r) {
          return r.payment_status === 'Paid' && new Date(Number(r.paid_at || r.created_at || 0)).toISOString().slice(0, 10) === d;
        }).reduce(function (a, r) { return a + Number(r.fare_total || 0); }, 0);
      });
      charts.anRev = new Chart(revCtx, {
        type: 'bar',
        data: { labels: days.map(dayLabel), datasets: [{ label: t('admin.revenue'), data: rev, backgroundColor: '#0A7C5A', borderRadius: 3 }] },
        options: {
          responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: cd.text, font: cd.font, maxRotation: 0, autoSkip: true } },
            y: { beginAtZero: true, grid: { color: cd.grid }, ticks: { color: cd.text, font: cd.font, callback: function (v) { return '৳' + v; } } }
          }
        }
      });
    }
    const hourCtx = $('an-hours');
    if (hourCtx) {
      charts.anHours = new Chart(hourCtx, {
        type: 'line',
        data: {
          labels: hours.map(function (_, i) { return i + ':00'; }),
          datasets: [{ label: t('admin.rides'), data: hours, borderColor: '#FF5A36', backgroundColor: 'rgba(255,90,54,.14)', fill: true, tension: .35, pointRadius: 2, borderWidth: 2.5 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: cd.text, font: cd.font, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
            y: { beginAtZero: true, grid: { color: cd.grid }, ticks: { color: cd.text, font: cd.font, precision: 0 } }
          }
        }
      });
    }
  }

  function kpi(label, value, icon) {
    return '<article class="kpi"><div class="kpi-top"><span class="kpi-icon"><i class="fa-solid ' + icon + '"></i></span></div>' +
      '<span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + esc(String(value)) + '</span></article>';
  }

  /* ============================ LIVE MONITOR ============================= */
  async function renderLive(data) {
    const body = $('admin-body');
    body.innerHTML =
      '<div class="row-between mb-4">' +
      '<div><h2 style="margin:0;font-size:18px">' + esc(t('admin.liveRides')) + '</h2>' +
      '<p style="margin:2px 0 0;color:var(--muted);font-size:13px">' + esc(I18n.getLang() === 'bn' ? 'স্বয়ংক্রিয়ভাবে ৫ সেকেন্ডে হালনাগাদ হয়' : 'Auto-refreshes every 5 seconds') + '</p></div>' +
      '<span class="badge badge-success"><span class="dot dot-live"></span>' + esc(I18n.getLang() === 'bn' ? 'লাইভ' : 'LIVE') + '</span>' +
      '</div>' +
      '<div id="live-grid" class="grid-2"></div>';

    renderLiveGrid(data);

    liveTimer = setInterval(async function () {
      if (current !== 'live') { clearInterval(liveTimer); liveTimer = null; return; }
      cache.rides = null; cache.statuses = null;
      const rides = await load('rides', 'rides', { limit: 500 });
      const statuses = await load('statuses', 'driver_status', { limit: 500 });
      const drivers = await load('drivers', 'drivers', { limit: 500 });
      const users = await load('users', 'users', { limit: 500 });
      renderLiveGrid({ rides: rides, statuses: statuses, drivers: drivers, users: users });
      $('admin-updated').textContent = t('admin.lastUpdate') + ' ' + PothikGeo.clockTime(Date.now());
    }, 5000);
  }

  function renderLiveGrid(data) {
    const host = $('live-grid');
    if (!host) return;
    const active = data.rides.filter(function (r) { return RideState.isActive(r.status); })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    if (!active.length) {
      host.innerHTML = '<div class="card" style="grid-column:1/-1">' + UI.emptyState('fa-satellite-dish', t('common.noData'), t('admin.liveRides')) + '</div>';
      return;
    }

    host.innerHTML = active.map(function (r) {
      const pax = data.users.find(function (u) { return u.id === r.passenger_user_id; }) || {};
      const drv = data.drivers.find(function (d) { return d.id === r.driver_id; }) || {};
      const st = data.statuses.find(function (s) { return s.driver_id === r.driver_id; });
      const pos = st && st.lat ? { lat: Number(st.lat), lng: Number(st.lng) } : null;
      const target = r.status === 'RIDE_STARTED'
        ? { lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng) }
        : { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) };
      const km = pos ? PothikGeo.haversineKm(pos, target) : null;
      const pct = Math.min(100, RideState.progressIndex(r.status) / 4 * 100);

      return '<section class="card">' +
        '<div class="row-between mb-3">' +
        '<div class="row gap-2"><span class="badge badge-brand"><i class="fa-solid ' + (r.vehicle_type === 'bike' ? 'fa-motorcycle' : (r.vehicle_type === 'cng' ? 'fa-taxi' : 'fa-car-side')) + '"></i>' + esc(t('veh.' + (r.vehicle_type || 'car'))) + '</span>' +
        '<strong style="font-size:13px">' + esc(r.ride_code || '') + '</strong></div>' +
        UI.statusBadge(r.status) + '</div>' +

        '<div class="route-summary mb-3">' +
        '<div class="rs-rail"><span class="rs-dot" style="border-color:var(--brand-500);background:var(--brand-500)"></span>' +
        '<span class="rs-line"></span><span class="rs-dot" style="border-color:var(--accent-500);background:var(--accent-500)"></span></div>' +
        '<div class="grow col gap-2">' +
        '<div style="font-size:13px">' + esc(r.pickup_label) + '</div>' +
        '<div style="font-size:13px">' + esc(r.dropoff_label) + '</div>' +
        '</div></div>' +

        '<div class="progress mb-3"><span style="width:' + pct + '%"></span></div>' +

        '<div class="row-between" style="font-size:12px;color:var(--muted)">' +
        '<span><i class="fa-solid fa-user"></i> ' + esc(pax.full_name || '—') + '</span>' +
        '<span><i class="fa-solid fa-id-card"></i> ' + esc(drv.full_name || (I18n.getLang() === 'bn' ? 'খোঁজা হচ্ছে' : 'searching')) + '</span>' +
        '</div>' +

        '<div class="row-between mt-3" style="border-top:1px solid var(--border);padding-top:10px">' +
        '<span style="font-size:12px;color:var(--muted)">' +
        (km !== null ? ('<i class="fa-solid fa-location-crosshairs"></i> ' + esc(PothikGeo.distance(km)) + ' · ' + esc(PothikGeo.duration((km / 22) * 60))) : esc(I18n.getLang() === 'bn' ? 'GPS নেই' : 'no GPS')) +
        '</span>' +
        '<strong>' + money(r.fare_total) + '</strong></div>' +
        '</section>';
    }).join('');
  }

  /* ============================ APPROVALS ================================ */
  async function renderApprovals(data) {
    const pending = data.drivers.filter(function (d) { return d.status === 'pending'; });
    const recent = data.drivers.filter(function (d) { return d.status !== 'pending'; })
      .sort(function (a, b) { return (b.verified_at || 0) - (a.verified_at || 0); }).slice(0, 6);

    const body = $('admin-body');
    body.innerHTML =
      '<div class="row-between mb-4">' +
      '<div><h2 style="margin:0;font-size:18px">' + esc(t('admin.driverApproval')) + '</h2>' +
      '<p style="margin:2px 0 0;color:var(--muted);font-size:13px">' + esc(I18n.getLang() === 'bn' ? 'নথি যাচাই করে চালক অনুমোদন করুন' : 'Verify documents and approve drivers') + '</p></div>' +
      '<span class="badge ' + (pending.length ? 'badge-warn' : 'badge-success') + '">' + pending.length + ' ' + esc(t('admin.pendingApprovals')) + '</span>' +
      '</div>' +
      '<div id="approval-list"></div>' +
      (recent.length ? '<h3 class="mt-6" style="font-size:15px">' + esc(I18n.getLang() === 'bn' ? 'সাম্প্রতিক সিদ্ধান্ত' : 'Recent decisions') + '</h3>' +
        '<div class="card card-flush"><ul class="list">' + recent.map(function (d) {
          return '<li class="list-item">' + UI.avatarHtml(d.full_name, d.photo_url) +
            '<span class="li-main"><span class="li-title">' + esc(d.full_name) + '</span>' +
            '<span class="li-sub">' + esc(PothikGeo.dateTime(d.verified_at || d.submitted_at)) + '</span></span>' +
            UI.statusBadge(d.status) + '</li>';
        }).join('') + '</ul></div>' : '');

    const host = $('approval-list');
    if (!pending.length) {
      host.innerHTML = '<div class="card">' + UI.emptyState('fa-circle-check', t('admin.noPending'), t('admin.driverApproval')) + '</div>';
      return;
    }

    host.innerHTML = pending.map(function (d) {
      const veh = data.vehicles.find(function (v) { return v.driver_id === d.id; }) || {};
      const docs = data.docs.filter(function (x) { return x.driver_id === d.id; });
      return '<section class="card mb-4" data-driver="' + esc(d.id) + '">' +
        '<div class="row-between mb-3">' +
        '<div class="row gap-3">' + UI.avatarHtml(d.full_name, d.photo_url, 'lg') +
        '<div><strong style="font-size:16px;display:block">' + esc(d.full_name) + '</strong>' +
        '<span style="font-size:12px;color:var(--muted)">+880 ' + esc(PothikGeo.formatBdPhone(d.phone)) + '</span><br>' +
        '<span class="badge badge-brand mt-2" style="margin-top:4px"><i class="fa-solid ' + (veh.vehicle_type === 'bike' ? 'fa-motorcycle' : (veh.vehicle_type === 'cng' ? 'fa-taxi' : 'fa-car-side')) + '"></i>' + esc(t('veh.' + (veh.vehicle_type || 'car'))) + '</span>' +
        '</div></div>' +
        '<span class="badge badge-warn">' + esc(I18n.getLang() === 'bn' ? 'অপেক্ষমাণ' : 'PENDING') + '</span></div>' +

        '<div class="table-wrap mb-3"><table class="data" style="min-width:auto"><tbody>' +
        rowTd(t('drv.nidNumber'), d.nid_number || '—') +
        rowTd(t('drv.licenceNumber'), d.licence_number || '—') +
        rowTd(t('drv.vehicleReg'), veh.registration_number || '—') +
        rowTd(t('drv.vehicleModel'), (veh.model || '—') + ' ' + (veh.year || '')) +
        rowTd(t('hist.bookingTime'), PothikGeo.dateTime(d.submitted_at)) +
        '</tbody></table></div>' +

        '<h4 style="font-size:13px;margin:0 0 8px">' + esc(t('admin.docReview')) + ' (' + docs.length + ')</h4>' +
        '<div class="grid-3 mb-4" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">' +
        docs.map(function (doc) {
          return '<figure style="margin:0"><figcaption style="font-size:11px;color:var(--muted);margin-bottom:4px">' + esc(docLabel(doc.doc_type)) + '</figcaption>' +
            (doc.file_url
              ? '<img class="doc-preview" src="' + esc(doc.file_url) + '" alt="' + esc(docLabel(doc.doc_type)) + '" style="cursor:zoom-in" data-zoom="' + esc(doc.file_url) + '">'
              : '<div class="doc-preview" style="display:grid;place-items:center;color:var(--muted-2)"><i class="fa-solid fa-image"></i></div>') +
            '</figure>';
        }).join('') + '</div>' +

        '<div class="row gap-3">' +
        '<button class="btn btn-ghost grow" data-reject="' + esc(d.id) + '"><i class="fa-solid fa-xmark"></i>' + esc(t('admin.rejectDriver')) + '</button>' +
        '<button class="btn btn-primary grow" data-approve="' + esc(d.id) + '"><i class="fa-solid fa-check"></i>' + esc(t('admin.approveDriver')) + '</button>' +
        '</div></section>';
    }).join('');

    // Lightbox
    host.querySelectorAll('[data-zoom]').forEach(function (img) {
      img.addEventListener('click', function () {
        UI.modal({ title: t('admin.docReview'), bodyHtml: '<img src="' + esc(img.dataset.zoom) + '" style="width:100%;border-radius:12px" alt="document">', actions: [{ label: t('common.close'), class: 'btn-primary' }] });
      });
    });

    // Actions
    host.querySelectorAll('[data-approve]').forEach(function (b) {
      b.addEventListener('click', function () { approveDriver(b.dataset.approve); });
    });
    host.querySelectorAll('[data-reject]').forEach(function (b) {
      b.addEventListener('click', function () { rejectDriver(b.dataset.reject); });
    });
  }

  function rowTd(k, v) {
    return '<tr><td style="color:var(--muted);width:45%">' + esc(k) + '</td><td style="font-weight:600">' + esc(v) + '</td></tr>';
  }

  function docLabel(type) {
    const map = {
      nid_front: t('drv.nidFront'), nid_back: t('drv.nidBack'), licence: t('drv.licenceImage'),
      vehicle_photo: t('drv.vehicleImage'), vehicle_registration: t('drv.vehicleReg'),
      profile_photo: t('drv.profilePhoto'), fitness: 'Fitness', insurance: 'Insurance', tax_token: 'Tax token'
    };
    return map[type] || type;
  }

  async function approveDriver(driverId) {
    const ok = await UI.confirm({
      title: t('admin.approveDriver'),
      message: I18n.getLang() === 'bn' ? 'এই চালককে অনুমোদন করবেন? তিনি সাথে সাথে রাইড পেতে পারবেন।' : 'Approve this driver? They will be able to accept rides immediately.'
    });
    if (!ok) return;
    try {
      const nowTs = Date.now();
      const driver = await DB.get('drivers', driverId);
      await DB.update('drivers', driverId, {
        status: 'approved', verified_by: adminUser.id, verified_at: nowTs, rejection_reason: ''
      });
      // Approve the vehicle + documents too
      const veh = await DB.findWhere('vehicles', function (v) { return v.driver_id === driverId; });
      if (veh) await DB.update('vehicles', veh.id, { status: 'approved', verified_by: adminUser.id, verified_at: nowTs });
      const docs = await DB.list('driver_documents', { limit: 200 });
      for (const doc of docs.filter(function (x) { return x.driver_id === driverId; })) {
        await DB.update('driver_documents', doc.id, { status: 'approved', reviewed_by: adminUser.id, reviewed_at: nowTs });
      }
      // Ensure a driver_status row exists so they can go online
      const st = await DB.findWhere('driver_status', function (s) { return s.driver_id === driverId; });
      if (!st) {
        const v = veh || {};
        await DB.create('driver_status', {
          id: DB.uid('ds'), driver_id: driverId, user_id: driver.user_id,
          is_online: false, availability: 'offline', lat: null, lng: null,
          last_ping_at: 0, active_ride_id: null,
          rating: driver.rating || 5, acceptance_rate: driver.acceptance_rate || 1,
          completed_rides: driver.completed_rides || 0,
          vehicle_type: v.vehicle_type || 'car', vehicle_id: veh ? veh.id : null,
          updated_at: nowTs
        });
      }
      await Auth.audit(adminUser.id, 'admin', 'DRIVER_APPROVED', 'drivers', driverId, {});
      await Notify.send({
        userId: driver.user_id,
        title: I18n.getLang() === 'bn' ? 'অভিনন্দন! আপনি অনুমোদিত হয়েছেন' : 'Congratulations! You are approved',
        body: I18n.getLang() === 'bn' ? 'এখন অনলাইন হয়ে রাইড গ্রহণ করতে পারেন।' : 'You can now go online and accept rides.',
        type: 'system', push: true
      });
      UI.toast(t('common.approve') + ' ✓', 'success');
      cache.drivers = null; cache.statuses = null; cache.vehicles = null; cache.docs = null;
      go('approvals');
    } catch (e) {
      UI.toast(t('err.saveFailed'), 'error');
    }
  }

  async function rejectDriver(driverId) {
    const reasons = [
      I18n.getLang() === 'bn' ? 'এনআইডি ছবি স্পষ্ট নয়' : 'NID image is not clear',
      I18n.getLang() === 'bn' ? 'লাইসেন্সের মেয়াদ শেষ' : 'Driving licence has expired',
      I18n.getLang() === 'bn' ? 'যানবাহনের নথি অসম্পূর্ণ' : 'Vehicle documents are incomplete',
      I18n.getLang() === 'bn' ? 'তথ্য মিলছে না' : 'Submitted information does not match',
      I18n.getLang() === 'bn' ? 'অন্যান্য' : 'Other'
    ];
    const body = document.createElement('div');
    body.innerHTML = '<div class="field"><label>' + esc(t('admin.rejectReason')) + '</label>' +
      '<select class="select" id="reject-reason">' + reasons.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>' + esc(t('sup.message')) + '</label><textarea class="textarea" id="reject-note"></textarea></div>';

    UI.modal({
      title: t('admin.rejectDriver'),
      content: body,
      actions: [
        { label: t('common.back'), class: 'btn-ghost' },
        {
          label: t('admin.rejectDriver'), class: 'btn-danger', onClick: async function (close) {
            const reason = (document.getElementById('reject-reason') || {}).value || '';
            const note = (document.getElementById('reject-note') || {}).value || '';
            close();
            try {
              const nowTs = Date.now();
              const driver = await DB.get('drivers', driverId);
              await DB.update('drivers', driverId, {
                status: 'rejected',
                rejection_reason: reason + (note ? ' — ' + note : ''),
                verified_by: adminUser.id, verified_at: nowTs
              });
              await Auth.audit(adminUser.id, 'admin', 'DRIVER_REJECTED', 'drivers', driverId, { reason: reason });
              await Notify.send({
                userId: driver.user_id,
                title: I18n.getLang() === 'bn' ? 'আবেদন প্রত্যাখ্যাত' : 'Application rejected',
                body: reason + (note ? ' — ' + note : ''),
                type: 'alert', push: true
              });
              UI.toast(t('common.reject') + ' ✓', 'info');
              cache.drivers = null;
              go('approvals');
            } catch (e) { UI.toast(t('err.saveFailed'), 'error'); }
          }
        }
      ]
    });
  }

  /* ============================== DRIVERS ================================ */
  async function renderDrivers(data) {
    const body = $('admin-body');
    body.innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.drivers')) + ' (' + data.drivers.length + ')</h2>' +
      '<div class="row gap-2">' +
      '<input class="input" id="drv-search" placeholder="' + esc(t('common.search')) + '" style="min-width:200px">' +
      '<select class="select" id="drv-filter" style="min-width:150px">' +
      '<option value="">' + esc(t('common.all')) + '</option>' +
      ['pending', 'approved', 'rejected', 'suspended', 'blocked'].map(function (s) {
        return '<option value="' + s + '">' + esc(t('drv.status.' + s)) + '</option>';
      }).join('') + '</select>' +
      '<button class="btn btn-ghost btn-sm" id="drv-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button>' +
      '</div></div>' +
      '<div id="drv-table"></div>';

    function draw() {
      const q = ($('drv-search').value || '').toLowerCase();
      const f = $('drv-filter').value;
      const rows = data.drivers.filter(function (d) {
        if (f && d.status !== f) return false;
        if (!q) return true;
        return String(d.full_name || '').toLowerCase().includes(q) || String(d.phone || '').includes(q);
      });
      const host = $('drv-table');
      if (!rows.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-user-slash', t('common.noData')) + '</div>'; return; }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>' + esc(t('common.name')) + '</th><th>' + esc(t('common.phone')) + '</th>' +
        '<th>' + esc(t('drv.vehicleType')) + '</th><th>' + esc(t('drv.vehicleReg')) + '</th>' +
        '<th>' + esc(t('ride.rating')) + '</th><th class="num">' + esc(t('admin.rides')) + '</th>' +
        '<th>' + esc(t('common.status')) + '</th><th>' + esc(t('common.actions')) + '</th></tr></thead><tbody>' +
        rows.map(function (d) {
          const veh = data.vehicles.find(function (v) { return v.driver_id === d.id; }) || {};
          return '<tr><td><div class="row gap-2">' + UI.avatarHtml(d.full_name, d.photo_url) + '<strong>' + esc(d.full_name) + '</strong></div></td>' +
            '<td>+880 ' + esc(PothikGeo.formatBdPhone(d.phone)) + '</td>' +
            '<td>' + esc(t('veh.' + (veh.vehicle_type || 'car'))) + '</td>' +
            '<td>' + esc(veh.registration_number || '—') + '</td>' +
            '<td>' + UI.starsHtml(d.rating, 'sm') + '</td>' +
            '<td class="num">' + (d.completed_rides || 0) + '</td>' +
            '<td>' + UI.statusBadge(d.status) + '</td>' +
            '<td><div class="row gap-1">' +
            '<button class="btn btn-ghost btn-icon btn-sm" title="' + esc(t('common.view')) + '" data-view="' + esc(d.id) + '"><i class="fa-solid fa-eye"></i></button>' +
            (d.status === 'approved'
              ? '<button class="btn btn-ghost btn-icon btn-sm" title="' + esc(t('common.suspend')) + '" data-suspend="' + esc(d.id) + '"><i class="fa-solid fa-circle-pause"></i></button>'
              : '<button class="btn btn-ghost btn-icon btn-sm" title="' + esc(t('common.approve')) + '" data-activate="' + esc(d.id) + '"><i class="fa-solid fa-circle-check"></i></button>') +
            '<button class="btn btn-ghost btn-icon btn-sm" title="' + esc(t('common.block')) + '" data-block="' + esc(d.id) + '"><i class="fa-solid fa-ban" style="color:var(--danger-500)"></i></button>' +
            '</div></td></tr>';
        }).join('') + '</tbody></table></div>';

      host.querySelectorAll('[data-view]').forEach(function (b) {
        b.addEventListener('click', function () { viewDriver(b.dataset.view, data); });
      });
      host.querySelectorAll('[data-suspend]').forEach(function (b) {
        b.addEventListener('click', function () { setDriverStatus(b.dataset.suspend, 'suspended'); });
      });
      host.querySelectorAll('[data-activate]').forEach(function (b) {
        b.addEventListener('click', function () { setDriverStatus(b.dataset.activate, 'approved'); });
      });
      host.querySelectorAll('[data-block]').forEach(function (b) {
        b.addEventListener('click', function () { setDriverStatus(b.dataset.block, 'blocked'); });
      });
    }

    $('drv-search').addEventListener('input', UI.debounce(draw, 220));
    $('drv-filter').addEventListener('change', draw);
    $('drv-export').addEventListener('click', function () {
      UI.downloadCsv('pothik-drivers.csv', data.drivers.map(function (d) {
        const veh = data.vehicles.find(function (v) { return v.driver_id === d.id; }) || {};
        return {
          id: d.id, name: d.full_name, phone: d.phone, nid: d.nid_number,
          licence: d.licence_number, vehicle_type: veh.vehicle_type,
          registration: veh.registration_number, rating: d.rating,
          completed_rides: d.completed_rides, status: d.status
        };
      }));
    });
    draw();
  }

  function viewDriver(id, data) {
    const d = data.drivers.find(function (x) { return x.id === id; });
    if (!d) return;
    const veh = data.vehicles.find(function (v) { return v.driver_id === id; }) || {};
    const docs = data.docs.filter(function (x) { return x.driver_id === id; });
    const st = data.statuses.find(function (s) { return s.driver_id === id; });
    const ratings = data.ratings.filter(function (r) { return r.ratee_id === d.user_id; });

    UI.modal({
      title: d.full_name,
      bodyHtml:
        '<div class="row gap-3 mb-4">' + UI.avatarHtml(d.full_name, d.photo_url, 'lg') +
        '<div><strong style="display:block">' + esc(d.full_name) + '</strong>' +
        '<span style="font-size:13px;color:var(--muted)">+880 ' + esc(PothikGeo.formatBdPhone(d.phone)) + '</span><br>' +
        UI.statusBadge(d.status) + '</div></div>' +
        '<div class="table-wrap mb-4"><table class="data" style="min-width:auto"><tbody>' +
        rowTd(t('drv.nidNumber'), d.nid_number || '—') +
        rowTd(t('drv.licenceNumber'), d.licence_number || '—') +
        rowTd(t('drv.vehicleType'), t('veh.' + (veh.vehicle_type || 'car'))) +
        rowTd(t('drv.vehicleReg'), veh.registration_number || '—') +
        rowTd(t('drv.vehicleModel'), (veh.model || '—') + ' ' + (veh.year || '')) +
        rowTd(t('ride.rating'), (Number(d.rating) || 0).toFixed(2) + ' (' + ratings.length + ')') +
        rowTd(t('drvHome.acceptance'), Math.round((Number(d.acceptance_rate) || 1) * 100) + '%') +
        rowTd(t('admin.rides'), d.completed_rides || 0) +
        rowTd(t('ride.cancelled'), d.cancelled_rides || 0) +
        rowTd(I18n.getLang() === 'bn' ? 'অনলাইন' : 'Online', st && st.is_online ? t('common.yes') : t('common.no')) +
        rowTd(t('prof.memberSince'), PothikGeo.dateTime(d.created_at)) +
        '</tbody></table></div>' +
        (d.rejection_reason ? '<div class="alert alert-danger mb-4"><i class="fa-solid fa-circle-xmark"></i><span>' + esc(d.rejection_reason) + '</span></div>' : '') +
        '<h4 style="font-size:13px">' + esc(t('admin.documents')) + '</h4>' +
        '<div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">' +
        docs.map(function (doc) {
          return '<figure style="margin:0"><figcaption style="font-size:11px;color:var(--muted)">' + esc(docLabel(doc.doc_type)) + '</figcaption>' +
            (doc.file_url ? '<img class="doc-preview" src="' + esc(doc.file_url) + '" alt="">' : '<div class="doc-preview" style="display:grid;place-items:center;color:var(--muted-2)"><i class="fa-solid fa-image"></i></div>') +
            '</figure>';
        }).join('') + '</div>',
      actions: [{ label: t('common.close'), class: 'btn-primary' }]
    });
  }

  async function setDriverStatus(driverId, status) {
    const labels = { approved: t('common.approve'), suspended: t('common.suspend'), blocked: t('common.block') };
    const ok = await UI.confirm({
      title: labels[status] || status,
      message: (I18n.getLang() === 'bn' ? 'এই চালকের অবস্থা পরিবর্তন করবেন?' : 'Change this driver\'s status?') + ' → ' + t('drv.status.' + status),
      danger: status === 'blocked'
    });
    if (!ok) return;
    try {
      const nowTs = Date.now();
      const driver = await DB.get('drivers', driverId);
      await DB.update('drivers', driverId, { status: status, verified_by: adminUser.id, verified_at: nowTs });
      if (status !== 'approved') {
        await DB.update('users', driver.user_id, { status: status === 'blocked' ? 'blocked' : 'suspended' });
        const st = await DB.findWhere('driver_status', function (s) { return s.driver_id === driverId; });
        if (st) await DB.update('driver_status', st.id, { is_online: false, availability: 'offline', active_ride_id: null, updated_at: nowTs });
      } else {
        await DB.update('users', driver.user_id, { status: 'active' });
      }
      await Auth.audit(adminUser.id, 'admin', 'DRIVER_' + status.toUpperCase(), 'drivers', driverId, {});
      await Notify.send({
        userId: driver.user_id,
        title: t('drv.statusTitle') + ': ' + t('drv.status.' + status),
        body: t('drv.status.' + status + '.desc'),
        type: 'system', push: true
      });
      UI.toast(t('common.saved'), 'success');
      cache.drivers = null; cache.statuses = null;
      go('drivers');
    } catch (e) { UI.toast(t('err.saveFailed'), 'error'); }
  }

  /* ============================== VEHICLES =============================== */
  async function renderVehicles(data) {
    const rows = data.vehicles;
    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.vehicles')) + ' (' + rows.length + ')</h2>' +
      '<div class="row gap-2">' +
      '<select class="select" id="veh-type-filter" style="min-width:150px"><option value="">' + esc(t('common.all')) + '</option>' +
      Settings.vehicleList().map(function (v) { return '<option value="' + v.type + '">' + esc(t('veh.' + v.type)) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn btn-ghost btn-sm" id="veh-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button>' +
      '</div></div><div id="veh-table"></div>';

    function draw() {
      const f = $('veh-type-filter').value;
      const list = rows.filter(function (v) { return !f || v.vehicle_type === f; });
      const host = $('veh-table');
      if (!list.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-car', t('common.noData')) + '</div>'; return; }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>' + esc(t('drv.vehicleImage')) + '</th><th>' + esc(t('drv.vehicleType')) + '</th>' +
        '<th>' + esc(t('drv.vehicleReg')) + '</th><th>' + esc(t('drv.vehicleModel')) + '</th>' +
        '<th class="num">' + esc(t('drv.vehicleYear')) + '</th><th>' + esc(t('app.role.driver')) + '</th>' +
        '<th>' + esc(t('common.status')) + '</th></tr></thead><tbody>' +
        list.map(function (v) {
          const d = data.drivers.find(function (x) { return x.id === v.driver_id; }) || {};
          return '<tr><td>' + (v.photo_url ? '<img src="' + esc(v.photo_url) + '" alt="" style="width:56px;height:36px;object-fit:cover;border-radius:6px">' : '—') + '</td>' +
            '<td><i class="fa-solid ' + Settings.vehicle(v.vehicle_type).icon + '" style="color:' + Settings.vehicle(v.vehicle_type).color + '"></i> ' + esc(t('veh.' + v.vehicle_type)) + '</td>' +
            '<td><strong>' + esc(v.registration_number) + '</strong></td>' +
            '<td>' + esc(v.model) + '</td><td class="num">' + esc(v.year) + '</td>' +
            '<td>' + esc(d.full_name || '—') + '</td><td>' + UI.statusBadge(v.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    $('veh-type-filter').addEventListener('change', draw);
    $('veh-export').addEventListener('click', function () {
      UI.downloadCsv('pothik-vehicles.csv', rows);
    });
    draw();
  }

  /* ============================= DOCUMENTS =============================== */
  async function renderDocuments(data) {
    const docs = data.docs;
    const pending = docs.filter(function (d) { return d.status === 'pending'; });

    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<div><h2 style="margin:0;font-size:18px">' + esc(t('admin.documents')) + '</h2>' +
      '<p style="margin:2px 0 0;color:var(--muted);font-size:13px">' + esc(pending.length + ' ' + t('admin.pendingApprovals')) + '</p></div>' +
      '</div>' +
      '<div class="grid-3" id="doc-grid"></div>';

    const host = $('doc-grid');
    const list = pending.length ? pending : docs.slice(0, 24);
    if (!list.length) { host.innerHTML = '<div class="card" style="grid-column:1/-1">' + UI.emptyState('fa-file-shield', t('common.noData')) + '</div>'; return; }

    host.innerHTML = list.map(function (doc) {
      const d = data.drivers.find(function (x) { return x.id === doc.driver_id; }) || {};
      return '<section class="card">' +
        (doc.file_url
          ? '<img src="' + esc(doc.file_url) + '" alt="" class="doc-preview" style="height:170px;margin-bottom:10px;cursor:zoom-in" data-zoom="' + esc(doc.file_url) + '">'
          : '<div class="doc-preview" style="height:170px;display:grid;place-items:center;margin-bottom:10px;color:var(--muted-2)"><i class="fa-solid fa-image" style="font-size:26px"></i></div>') +
        '<strong style="font-size:13px;display:block">' + esc(docLabel(doc.doc_type)) + '</strong>' +
        '<span style="font-size:12px;color:var(--muted);display:block;margin-bottom:8px">' + esc(d.full_name || doc.driver_id) + '</span>' +
        '<div class="row-between">' + UI.statusBadge(doc.status) +
        (doc.status === 'pending'
          ? '<div class="row gap-1">' +
            '<button class="btn btn-ghost btn-icon btn-sm" data-doc-ok="' + esc(doc.id) + '" title="' + esc(t('common.approve')) + '"><i class="fa-solid fa-check" style="color:var(--success-500)"></i></button>' +
            '<button class="btn btn-ghost btn-icon btn-sm" data-doc-no="' + esc(doc.id) + '" title="' + esc(t('common.reject')) + '"><i class="fa-solid fa-xmark" style="color:var(--danger-500)"></i></button>' +
            '</div>'
          : '<span style="font-size:11px;color:var(--muted)">' + esc(PothikGeo.relativeTime(doc.reviewed_at || doc.uploaded_at)) + '</span>') +
        '</div></section>';
    }).join('');

    host.querySelectorAll('[data-zoom]').forEach(function (img) {
      img.addEventListener('click', function () {
        UI.modal({ title: t('admin.docReview'), bodyHtml: '<img src="' + esc(img.dataset.zoom) + '" style="width:100%;border-radius:12px" alt="document">', actions: [{ label: t('common.close'), class: 'btn-primary' }] });
      });
    });
    host.querySelectorAll('[data-doc-ok]').forEach(function (b) {
      b.addEventListener('click', function () { setDocStatus(b.dataset.docOk, 'approved'); });
    });
    host.querySelectorAll('[data-doc-no]').forEach(function (b) {
      b.addEventListener('click', function () { setDocStatus(b.dataset.docNo, 'rejected'); });
    });
  }

  async function setDocStatus(docId, status) {
    try {
      await DB.update('driver_documents', docId, {
        status: status, reviewed_by: adminUser.id, reviewed_at: Date.now()
      });
      await Auth.audit(adminUser.id, 'admin', 'DOCUMENT_' + status.toUpperCase(), 'driver_documents', docId, {});
      UI.toast(t('common.saved'), 'success');
      cache.docs = null;
      go('documents');
    } catch (e) { UI.toast(t('err.saveFailed'), 'error'); }
  }

  /* ============================= PASSENGERS ============================== */
  async function renderPassengers(data) {
    const rows = data.passengers;
    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.passengers')) + ' (' + rows.length + ')</h2>' +
      '<div class="row gap-2">' +
      '<input class="input" id="pax-search" placeholder="' + esc(t('common.search')) + '" style="min-width:200px">' +
      '<button class="btn btn-ghost btn-sm" id="pax-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button>' +
      '</div></div><div id="pax-table"></div>';

    function draw() {
      const q = ($('pax-search').value || '').toLowerCase();
      const host = $('pax-table');
      const list = rows.map(function (p) {
        return { p: p, u: data.users.find(function (u) { return u.id === p.user_id; }) || {} };
      }).filter(function (x) {
        if (!q) return true;
        return String(x.u.full_name || '').toLowerCase().includes(q) || String(x.u.phone || '').includes(q);
      });
      if (!list.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-users-slash', t('common.noData')) + '</div>'; return; }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>' + esc(t('common.name')) + '</th><th>' + esc(t('common.phone')) + '</th>' +
        '<th>' + esc(t('ride.rating')) + '</th><th class="num">' + esc(t('prof.totalRides')) + '</th>' +
        '<th class="num">' + esc(I18n.getLang() === 'bn' ? 'মোট খরচ' : 'Total spent') + '</th>' +
        '<th class="num">' + esc(t('wallet.balance')) + '</th>' +
        '<th class="num">' + esc(t('ride.cancelled')) + '</th><th>' + esc(t('common.status')) + '</th></tr></thead><tbody>' +
        list.map(function (x) {
          return '<tr><td><div class="row gap-2">' + UI.avatarHtml(x.u.full_name, x.u.photo_url) + '<strong>' + esc(x.u.full_name || '—') + '</strong></div></td>' +
            '<td>+880 ' + esc(PothikGeo.formatBdPhone(x.u.phone || '')) + '</td>' +
            '<td>' + UI.starsHtml(x.p.rating, 'sm') + '</td>' +
            '<td class="num">' + (x.p.total_rides || 0) + '</td>' +
            '<td class="num">' + money(x.p.total_spent || 0) + '</td>' +
            '<td class="num">' + money(x.p.wallet_balance || 0) + '</td>' +
            '<td class="num">' + (x.p.cancellations || 0) + '</td>' +
            '<td>' + UI.statusBadge(x.p.status || 'active') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    $('pax-search').addEventListener('input', UI.debounce(draw, 220));
    $('pax-export').addEventListener('click', function () {
      UI.downloadCsv('pothik-passengers.csv', rows.map(function (p) {
        const u = data.users.find(function (x) { return x.id === p.user_id; }) || {};
        return { id: p.id, name: u.full_name, phone: u.phone, rating: p.rating, rides: p.total_rides, spent: p.total_spent, wallet: p.wallet_balance, cancellations: p.cancellations, status: p.status };
      }));
    });
    draw();
  }

  /* ================================ RIDES ================================ */
  async function renderRides(data) {
    const rows = data.rides.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.rides')) + ' (' + rows.length + ')</h2>' +
      '<div class="row gap-2 wrap">' +
      '<input class="input" id="ride-search" placeholder="' + esc(t('common.search')) + '" style="min-width:170px">' +
      '<select class="select" id="ride-status" style="min-width:160px"><option value="">' + esc(t('common.all')) + '</option>' +
      Object.keys(RideState.STATUS).map(function (s) { return '<option value="' + s + '">' + esc(t('st.' + s)) + '</option>'; }).join('') +
      '</select>' +
      '<select class="select" id="ride-vehicle" style="min-width:120px"><option value="">' + esc(t('common.all')) + '</option>' +
      Settings.vehicleList().map(function (v) { return '<option value="' + v.type + '">' + esc(t('veh.' + v.type)) + '</option>'; }).join('') + '</select>' +
      '<input class="input" id="ride-from" type="date" style="min-width:140px" title="' + esc(t('admin.dateFrom')) + '">' +
      '<input class="input" id="ride-to" type="date" style="min-width:140px" title="' + esc(t('admin.dateTo')) + '">' +
      '<button class="btn btn-ghost btn-sm" id="ride-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button>' +
      '</div></div><div id="ride-table"></div>';

    function filtered() {
      const q = ($('ride-search').value || '').toLowerCase();
      const st = $('ride-status').value;
      const veh = $('ride-vehicle').value;
      const from = $('ride-from').value ? new Date($('ride-from').value).getTime() : 0;
      const to = $('ride-to').value ? new Date($('ride-to').value).getTime() + 86400000 : Infinity;
      return rows.filter(function (r) {
        if (st && r.status !== st) return false;
        if (veh && r.vehicle_type !== veh) return false;
        if ((r.created_at || 0) < from || (r.created_at || 0) > to) return false;
        if (!q) return true;
        const pax = data.users.find(function (u) { return u.id === r.passenger_user_id; }) || {};
        const drv = data.drivers.find(function (d) { return d.id === r.driver_id; }) || {};
        return String(r.ride_code || '').toLowerCase().includes(q) ||
          String(r.pickup_label || '').toLowerCase().includes(q) ||
          String(r.dropoff_label || '').toLowerCase().includes(q) ||
          String(pax.full_name || '').toLowerCase().includes(q) ||
          String(drv.full_name || '').toLowerCase().includes(q);
      });
    }

    function draw() {
      const list = filtered().slice(0, 150);
      const host = $('ride-table');
      if (!list.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-route', t('common.noData')) + '</div>'; return; }
      const totalFare = list.reduce(function (a, r) { return a + (r.payment_status === 'Paid' ? Number(r.fare_total || 0) : 0); }, 0);
      host.innerHTML =
        '<div class="alert alert-info mb-4"><i class="fa-solid fa-filter"></i><span>' + list.length + ' ' + esc(t('admin.rides')) +
        ' · ' + esc(t('admin.revenue')) + ': <strong>' + money(totalFare) + '</strong></span></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>' + esc(t('hist.rideId')) + '</th><th>' + esc(t('hist.bookingTime')) + '</th>' +
        '<th>' + esc(t('app.role.passenger')) + '</th><th>' + esc(t('app.role.driver')) + '</th>' +
        '<th>' + esc(t('ride.trip')) + '</th><th class="num">' + esc(t('ride.distance')) + '</th>' +
        '<th class="num">' + esc(t('ride.fare')) + '</th><th class="num">' + esc(t('earn.commission')) + '</th>' +
        '<th>' + esc(t('common.status')) + '</th><th>' + esc(t('pay.title')) + '</th></tr></thead><tbody>' +
        list.map(function (r) {
          const pax = data.users.find(function (u) { return u.id === r.passenger_user_id; }) || {};
          const drv = data.drivers.find(function (d) { return d.id === r.driver_id; }) || {};
          return '<tr><td><strong>' + esc(r.ride_code || '') + '</strong></td>' +
            '<td style="white-space:nowrap">' + esc(PothikGeo.dateTime(r.created_at)) + '</td>' +
            '<td>' + esc(pax.full_name || '—') + '</td><td>' + esc(drv.full_name || '—') + '</td>' +
            '<td style="max-width:230px"><span style="font-size:12px">' + esc((r.pickup_label || '').slice(0, 26)) + ' → ' + esc((r.dropoff_label || '').slice(0, 26)) + '</span></td>' +
            '<td class="num">' + esc(PothikGeo.distance(Number(r.distance_km) || 0)) + '</td>' +
            '<td class="num">' + (RideState.isCancelled(r.status) ? '—' : money(r.fare_total)) + '</td>' +
            '<td class="num">' + money(r.commission_amount || 0) + '</td>' +
            '<td>' + UI.statusBadge(r.status) + '</td>' +
            '<td>' + UI.statusBadge(r.payment_status || 'Pending') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    ['ride-search', 'ride-status', 'ride-vehicle', 'ride-from', 'ride-to'].forEach(function (id) {
      const el = $(id);
      el.addEventListener(id === 'ride-search' ? 'input' : 'change', id === 'ride-search' ? UI.debounce(draw, 240) : draw);
    });
    $('ride-export').addEventListener('click', function () {
      UI.downloadCsv('pothik-rides.csv', filtered().map(function (r) {
        const pax = data.users.find(function (u) { return u.id === r.passenger_user_id; }) || {};
        const drv = data.drivers.find(function (d) { return d.id === r.driver_id; }) || {};
        return {
          ride_code: r.ride_code, created_at: new Date(Number(r.created_at)).toISOString(),
          passenger: pax.full_name, driver: drv.full_name, vehicle: r.vehicle_type,
          pickup: r.pickup_label, dropoff: r.dropoff_label, distance_km: r.distance_km,
          fare: r.fare_total, commission: r.commission_amount, driver_earning: r.driver_earning,
          status: r.status, payment_status: r.payment_status, method: r.payment_method
        };
      }));
    });
    draw();
  }

  /* ============================== FARE CONFIG ============================ */
  async function renderFare(data) {
    const S = Settings;
    const fields = [
      { key: 'baseFare', label: t('admin.baseFare'), step: 1 },
      { key: 'perKm', label: t('admin.perKm'), step: 1 },
      { key: 'perMinute', label: t('admin.perMin'), step: 0.1 },
      { key: 'minimumFare', label: t('admin.minFare'), step: 1 },
      { key: 'cancellationFee', label: t('admin.cancelFee'), step: 1 },
      { key: 'commissionPct', label: t('admin.commissionPct'), step: 0.5 },
      { key: 'surgeMultiplier', label: t('admin.surge'), step: 0.05 },
      { key: 'searchRadiusKm', label: t('admin.searchRadius'), step: 0.5 },
      { key: 'requestTimeoutSec', label: t('admin.requestTimeout'), step: 1 },
      { key: 'maxDriversToTry', label: t('admin.maxRetries'), step: 1 },
      { key: 'driverAcceptRadiusKm', label: I18n.getLang() === 'bn' ? 'চালক গ্রহণ ব্যাসার্ধ (কিমি)' : 'Driver accept radius (km)', step: 0.5 },
      { key: 'cancellationWindowSec', label: I18n.getLang() === 'bn' ? 'ফ্রি বাতিল সময় (সে.)' : 'Free cancellation window (sec)', step: 10 }
    ];

    $('admin-body').innerHTML =
      '<div class="grid-2 mb-4">' +
      '<section class="card">' +
      '<div class="card-hd"><h3>' + esc(t('admin.fareSettings')) + '</h3></div>' +
      '<div class="card-bd">' +
      '<div class="alert alert-info mb-4"><i class="fa-solid fa-circle-info"></i><span style="font-size:12px">' + esc(t('admin.fareConfigNote')) + '</span></div>' +
      '<form id="fare-form">' +
      fields.map(function (f) {
        return '<div class="field"><label for="fare-' + f.key + '">' + esc(f.label) + '</label>' +
          '<input class="input" id="fare-' + f.key + '" type="number" step="' + f.step + '" min="0" value="' + esc(S.get(f.key)) + '"></div>';
      }).join('') +
      '<button class="btn btn-primary btn-block" type="submit"><i class="fa-solid fa-floppy-disk"></i>' + esc(t('admin.saveSettings')) + '</button>' +
      '</form></div></section>' +

      '<section class="card">' +
      '<div class="card-hd"><h3>' + esc(t('admin.perVehicle')) + '</h3></div>' +
      '<div class="card-bd" id="veh-fare-list"></div>' +
      '</section></div>' +

      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'ভাড়া প্রিভিউ' : 'Fare preview') + '</h3></div>' +
      '<div class="card-bd"><div id="fare-preview"></div></div></section>';

    // Per-vehicle editors
    const vehHost = $('veh-fare-list');
    vehHost.innerHTML = S.vehicleList().map(function (v) {
      return '<div class="card mb-3" style="box-shadow:none;border-color:var(--border)">' +
        '<div class="row gap-2 mb-3"><span class="kpi-icon" style="color:' + (v.color || '#0A7C5A') + '"><i class="fa-solid ' + (v.icon || 'fa-car') + '"></i></span>' +
        '<strong>' + esc(t('veh.' + v.type)) + '</strong></div>' +
        '<div class="grid-2" style="grid-template-columns:1fr 1fr;gap:10px">' +
        vehField(v.type, 'baseFare', t('admin.baseFare'), v.baseFare) +
        vehField(v.type, 'perKm', t('admin.perKm'), v.perKm) +
        vehField(v.type, 'perMinute', t('admin.perMin'), v.perMinute) +
        vehField(v.type, 'minimumFare', t('admin.minFare'), v.minimumFare) +
        vehField(v.type, 'commissionPct', t('admin.commissionPct'), v.commissionPct) +
        '</div>' +
        '<button class="btn btn-soft btn-block btn-sm mt-3" data-save-veh="' + esc(v.type) + '">' +
        '<i class="fa-solid fa-floppy-disk"></i>' + esc(t('common.save')) + '</button>' +
        '</div>';
    }).join('');

    function vehField(type, key, label, val) {
      return '<div class="field" style="margin-bottom:6px"><label style="font-size:11px">' + esc(label) + '</label>' +
        '<input class="input" data-veh="' + esc(type) + '" data-key="' + key + '" type="number" step="0.5" min="0" value="' + esc(val) + '" style="min-height:38px"></div>';
    }

    vehHost.querySelectorAll('[data-save-veh]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const type = b.dataset.saveVeh;
        const patch = {};
        vehHost.querySelectorAll('[data-veh="' + type + '"]').forEach(function (inp) {
          patch[inp.dataset.key] = Number(inp.value);
        });
        try {
          await Settings.saveVehicleToDb(type, patch, adminUser.id);
          await Auth.audit(adminUser.id, 'admin', 'VEHICLE_FARE_UPDATED', 'vehicle_types', type, patch);
          UI.toast(t('admin.settingsSaved'), 'success');
          cache.settings = null;
          renderFarePreview();
        } catch (e) { UI.toast(t('err.saveFailed'), 'error'); }
      });
    });

    // Global fare form
    $('fare-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const patch = {};
      fields.forEach(function (f) { patch[f.key] = Number($('fare-' + f.key).value); });
      try {
        for (const k of Object.keys(patch)) {
          await Settings.saveToDb(k, patch[k], adminUser.id);
        }
        await Auth.audit(adminUser.id, 'admin', 'FARE_SETTINGS_UPDATED', 'platform_settings', '', patch);
        UI.toast(t('admin.settingsSaved'), 'success');
        cache.settings = null;
        renderFarePreview();
      } catch (err) { UI.toast(t('err.saveFailed'), 'error'); }
    });

    renderFarePreview();
  }

  function renderFarePreview() {
    const host = $('fare-preview');
    if (!host) return;
    const samples = [
      { km: 3, min: 10, label: I18n.getLang() === 'bn' ? 'ছোট যাত্রা' : 'Short trip' },
      { km: 8.2, min: 24, label: I18n.getLang() === 'bn' ? 'মাঝারি যাত্রা' : 'Medium trip' },
      { km: 18, min: 48, label: I18n.getLang() === 'bn' ? 'দীর্ঘ যাত্রা' : 'Long trip' },
      { km: 32, min: 75, label: I18n.getLang() === 'bn' ? 'এয়ারপোর্ট' : 'Airport run' }
    ];
    const types = Settings.vehicleList().map(function (v) { return v.type; });
    host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr><th>' + esc(I18n.getLang() === 'bn' ? 'যাত্রা' : 'Trip') + '</th>' +
      types.map(function (ty) { return '<th class="num">' + esc(t('veh.' + ty)) + '</th>'; }).join('') +
      '<th class="num">' + esc(t('earn.commission')) + '</th></tr></thead><tbody>' +
      samples.map(function (s) {
        const quotes = types.map(function (ty) { return Fare.quote({ km: s.km, minutes: s.min, vehicleType: ty }); });
        return '<tr><td>' + esc(s.label) + '<br><span style="font-size:11px;color:var(--muted)">' + s.km + ' km · ' + s.min + ' min</span></td>' +
          quotes.map(function (q) { return '<td class="num"><strong>' + money(q.total) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + money(q.driverEarning) + '</span></td>'; }).join('') +
          '<td class="num">' + money(quotes[quotes.length - 1].commission) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="mt-3" style="font-size:12px;color:var(--muted)">' + esc(I18n.getLang() === 'bn'
        ? 'প্রতিটি ঘরে বড় সংখ্যা = মোট ভাড়া, ছোট সংখ্যা = চালকের আয়।'
        : 'Large figure = total fare, small figure = driver earning.') + '</p>';
  }

  /* ============================== PAYMENTS =============================== */
  async function renderPayments(data) {
    const rows = data.payments.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    const byMethod = {};
    rows.forEach(function (p) {
      byMethod[p.method] = byMethod[p.method] || { n: 0, amt: 0 };
      byMethod[p.method].n++;
      if (p.status === 'Paid') byMethod[p.method].amt += Number(p.amount || 0);
    });
    const totalPaid = rows.filter(function (p) { return p.status === 'Paid'; }).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
    const totalComm = rows.filter(function (p) { return p.status === 'Paid'; }).reduce(function (a, p) { return a + Number(p.commission_amount || 0); }, 0);
    const totalDriver = rows.filter(function (p) { return p.status === 'Paid'; }).reduce(function (a, p) { return a + Number(p.driver_earning || 0); }, 0);

    $('admin-body').innerHTML =
      '<div class="kpi-grid mb-4">' +
      kpi(t('earn.gross'), money(totalPaid), 'fa-bangladeshi-taka-sign') +
      kpi(t('admin.platformCommission'), money(totalComm), 'fa-percent') +
      kpi(t('admin.driverEarnings'), money(totalDriver), 'fa-sack-dollar') +
      kpi(I18n.getLang() === 'bn' ? 'লেনদেন' : 'Transactions', rows.length, 'fa-receipt') +
      '</div>' +

      '<div class="grid-3 mb-4">' +
      Object.keys(byMethod).map(function (m) {
        return '<article class="kpi"><div class="kpi-top"><span class="kpi-icon"><i class="fa-solid ' + methodIcon(m) + '"></i></span>' +
          '<span class="badge badge-neutral">' + byMethod[m].n + '</span></div>' +
          '<span class="kpi-label">' + esc(t('pay.' + m)) + '</span>' +
          '<span class="kpi-value" style="font-size:20px">' + money(byMethod[m].amt) + '</span></article>';
      }).join('') + '</div>' +

      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.payments')) + '</h2>' +
      '<div class="row gap-2">' +
      '<select class="select" id="pay-status" style="min-width:150px"><option value="">' + esc(t('common.all')) + '</option>' +
      ['Paid', 'Pending', 'Failed', 'Refunded'].map(function (s) { return '<option value="' + s + '">' + esc(t('pay.' + s.toLowerCase())) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn btn-ghost btn-sm" id="pay-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button>' +
      '</div></div><div id="pay-table"></div>';

    function draw() {
      const f = $('pay-status').value;
      const list = rows.filter(function (p) { return !f || p.status === f; }).slice(0, 150);
      const host = $('pay-table');
      if (!list.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-credit-card', t('common.noData')) + '</div>'; return; }
      host.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>' + esc(t('hist.rideId')) + '</th><th>' + esc(t('hist.bookingTime')) + '</th>' +
        '<th>' + esc(t('pay.method')) + '</th><th class="num">' + esc(t('pay.total')) + '</th>' +
        '<th class="num">' + esc(t('earn.commission')) + '</th><th class="num">' + esc(t('earn.net')) + '</th>' +
        '<th>' + esc(t('common.status')) + '</th><th>' + esc(I18n.getLang() === 'bn' ? 'গেটওয়ে' : 'Gateway') + '</th></tr></thead><tbody>' +
        list.map(function (p) {
          return '<tr><td><strong>' + esc(p.ride_code || '') + '</strong></td>' +
            '<td style="white-space:nowrap">' + esc(PothikGeo.dateTime(p.created_at)) + '</td>' +
            '<td><i class="fa-solid ' + methodIcon(p.method) + '"></i> ' + esc(t('pay.' + p.method)) + '</td>' +
            '<td class="num"><strong>' + money(p.amount) + '</strong></td>' +
            '<td class="num">' + money(p.commission_amount) + '</td>' +
            '<td class="num">' + money(p.driver_earning) + '</td>' +
            '<td>' + UI.statusBadge(p.status) + '</td>' +
            '<td style="font-size:12px;color:var(--muted)">' + esc(p.gateway || '—') + (p.gateway_txn_id ? '<br>' + esc(p.gateway_txn_id) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    $('pay-status').addEventListener('change', draw);
    $('pay-export').addEventListener('click', function () { UI.downloadCsv('pothik-payments.csv', rows); });
    draw();
  }

  function methodIcon(m) {
    return m === 'cash' ? 'fa-money-bill-wave' : (m === 'card' ? 'fa-credit-card' : (m === 'wallet' ? 'fa-wallet' : 'fa-mobile-screen'));
  }

  /* =========================== CANCELLATIONS ============================= */
  async function renderCancellations(data) {
    const rows = data.cancellations.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    const byPax = rows.filter(function (c) { return c.cancelled_by === 'passenger'; }).length;
    const byDrv = rows.filter(function (c) { return c.cancelled_by === 'driver'; }).length;
    const fees = rows.reduce(function (a, c) { return a + Number(c.fee_charged || 0); }, 0);

    // Repeat offenders
    const paxCount = {};
    rows.filter(function (c) { return c.cancelled_by === 'passenger'; }).forEach(function (c) {
      paxCount[c.actor_user_id] = (paxCount[c.actor_user_id] || 0) + 1;
    });
    const repeat = Object.keys(paxCount).map(function (uid) {
      const u = data.users.find(function (x) { return x.id === uid; }) || {};
      return { name: u.full_name || uid, phone: u.phone, n: paxCount[uid] };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 5);

    $('admin-body').innerHTML =
      '<div class="kpi-grid mb-4">' +
      kpi(t('ride.cancelled'), rows.length, 'fa-ban') +
      kpi(t('app.role.passenger'), byPax, 'fa-person') +
      kpi(t('app.role.driver'), byDrv, 'fa-id-card') +
      kpi(t('admin.cancelFee'), money(fees), 'fa-bangladeshi-taka-sign') +
      '</div>' +

      '<div class="grid-2 mb-4">' +
      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'কারণ বিশ্লেষণ' : 'Reason breakdown') + '</h3></div>' +
      '<div class="card-bd"><div id="cancel-reasons"></div></div></section>' +
      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'বারবার বাতিলকারী' : 'Repeat cancellers') + '</h3></div>' +
      '<div class="card-bd"><ul class="list">' + (repeat.length ? repeat.map(function (r) {
        return '<li class="list-item"><span class="kpi-icon" style="background:rgba(229,72,77,.12);color:var(--danger-500)"><i class="fa-solid fa-triangle-exclamation"></i></span>' +
          '<span class="li-main"><span class="li-title">' + esc(r.name) + '</span><span class="li-sub">+880 ' + esc(PothikGeo.formatBdPhone(r.phone || '')) + '</span></span>' +
          '<span class="badge badge-danger">' + r.n + '</span></li>';
      }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>') + '</ul></div></section>' +
      '</div>' +

      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(t('admin.cancellations')) + '</h3></div>' +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
      '<th>' + esc(t('hist.rideId')) + '</th><th>' + esc(t('hist.bookingTime')) + '</th>' +
      '<th>' + esc(I18n.getLang() === 'bn' ? 'কে' : 'By') + '</th><th>' + esc(t('ride.cancelReason')) + '</th>' +
      '<th>' + esc(I18n.getLang() === 'bn' ? 'অবস্থা' : 'Status at cancel') + '</th>' +
      '<th class="num">' + esc(t('admin.cancelFee')) + '</th></tr></thead><tbody>' +
      rows.slice(0, 100).map(function (c) {
        return '<tr><td><strong>' + esc(c.ride_code || '') + '</strong></td>' +
          '<td style="white-space:nowrap">' + esc(PothikGeo.dateTime(c.created_at)) + '</td>' +
          '<td>' + esc(c.cancelled_by === 'passenger' ? t('app.role.passenger') : t('app.role.driver')) + '</td>' +
          '<td>' + esc(c.reason_text || c.reason_code || '—') + '</td>' +
          '<td>' + UI.statusBadge(c.status_at_cancel) + '</td>' +
          '<td class="num">' + (c.fee_waived ? '<span style="color:var(--muted)">' + esc(I18n.getLang() === 'bn' ? 'মাফ' : 'waived') + '</span>' : money(c.fee_charged)) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    // Reason chart
    const reasons = {};
    rows.forEach(function (c) { reasons[c.reason_code || 'other'] = (reasons[c.reason_code || 'other'] || 0) + 1; });
    const host = $('cancel-reasons');
    if (host) {
      const max = Math.max.apply(null, Object.values(reasons).concat([1]));
      host.innerHTML = Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; }).map(function (k) {
        return '<div class="row gap-3 mb-3"><span style="width:120px;font-size:12px">' + esc(k) + '</span>' +
          '<div class="progress grow"><span style="width:' + (reasons[k] / max * 100) + '%"></span></div>' +
          '<strong style="width:28px;text-align:right;font-size:12px">' + reasons[k] + '</strong></div>';
      }).join('');
    }
  }

  /* =============================== TICKETS =============================== */
  async function renderTickets(data) {
    const rows = data.tickets.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.complaints')) + ' (' + rows.length + ')</h2>' +
      '<select class="select" id="tk-filter" style="min-width:150px"><option value="">' + esc(t('common.all')) + '</option>' +
      ['open', 'in_progress', 'resolved', 'closed'].map(function (s) { return '<option value="' + s + '">' + esc(s) + '</option>'; }).join('') +
      '</select></div><div id="tk-list"></div>';

    function draw() {
      const f = $('tk-filter').value;
      const list = rows.filter(function (x) { return !f || x.status === f; });
      const host = $('tk-list');
      if (!list.length) { host.innerHTML = '<div class="card">' + UI.emptyState('fa-headset', t('common.noData')) + '</div>'; return; }
      const prio = { urgent: 'badge-danger', high: 'badge-warn', normal: 'badge-info', low: 'badge-neutral' };
      host.innerHTML = list.map(function (x) {
        const u = data.users.find(function (y) { return y.id === x.user_id; }) || {};
        return '<section class="card mb-3">' +
          '<div class="row-between mb-2"><div class="row gap-2">' +
          '<strong>' + esc(x.ticket_code || '') + '</strong>' +
          '<span class="badge ' + (prio[x.priority] || 'badge-neutral') + '">' + esc(x.priority) + '</span>' +
          '<span class="badge badge-neutral">' + esc(t('sup.cat.' + (x.category === 'safety' ? 'other' : x.category)) || x.category) + '</span></div>' +
          UI.statusBadge(x.status) + '</div>' +
          '<h4 style="margin:0 0 4px;font-size:15px">' + esc(x.subject) + '</h4>' +
          '<p style="margin:0 0 10px;font-size:13px;color:var(--muted)">' + esc(x.message) + '</p>' +
          '<div class="row-between" style="border-top:1px solid var(--border);padding-top:10px">' +
          '<span style="font-size:12px;color:var(--muted)"><i class="fa-solid fa-user"></i> ' + esc(u.full_name || '—') +
          ' · ' + esc(PothikGeo.relativeTime(x.created_at)) + '</span>' +
          '<div class="row gap-2">' +
          '<select class="select" data-tk="' + esc(x.id) + '" style="min-height:32px;padding:2px 30px 2px 10px;font-size:12px;width:auto">' +
          ['open', 'in_progress', 'resolved', 'closed'].map(function (s) {
            return '<option value="' + s + '"' + (s === x.status ? ' selected' : '') + '>' + esc(s) + '</option>';
          }).join('') + '</select>' +
          '</div></div></section>';
      }).join('');

      host.querySelectorAll('[data-tk]').forEach(function (sel) {
        sel.addEventListener('change', async function () {
          try {
            await DB.update('support_tickets', sel.dataset.tk, {
              status: sel.value,
              resolved_at: sel.value === 'resolved' || sel.value === 'closed' ? Date.now() : 0,
              assigned_to: adminUser.id
            });
            await Auth.audit(adminUser.id, 'admin', 'TICKET_' + sel.value.toUpperCase(), 'support_tickets', sel.dataset.tk, {});
            UI.toast(t('common.saved'), 'success');
            cache.tickets = null;
            go('tickets');
          } catch (e) { UI.toast(t('err.saveFailed'), 'error'); }
        });
      });
    }
    $('tk-filter').addEventListener('change', draw);
    draw();
  }

  /* =============================== RATINGS =============================== */
  async function renderRatings(data) {
    const rows = data.ratings.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    const driverRatings = rows.filter(function (r) { return r.ratee_role === 'driver'; });
    const paxRatings = rows.filter(function (r) { return r.ratee_role === 'passenger'; });
    const avgD = driverRatings.length ? driverRatings.reduce(function (a, r) { return a + Number(r.stars); }, 0) / driverRatings.length : 0;
    const avgP = paxRatings.length ? paxRatings.reduce(function (a, r) { return a + Number(r.stars); }, 0) / paxRatings.length : 0;
    const low = rows.filter(function (r) { return Number(r.stars) <= 2; });

    $('admin-body').innerHTML =
      '<div class="kpi-grid mb-4">' +
      kpi(t('drvRate.average') + ' (' + t('app.role.driver') + ')', avgD.toFixed(2), 'fa-star') +
      kpi(t('drvRate.average') + ' (' + t('app.role.passenger') + ')', avgP.toFixed(2), 'fa-star-half-stroke') +
      kpi(t('drvRate.total'), rows.length, 'fa-comment') +
      kpi(I18n.getLang() === 'bn' ? 'কম রেটিং (≤2)' : 'Low ratings (≤2)', low.length, 'fa-triangle-exclamation') +
      '</div>' +

      (low.length ? '<section class="card card-flush mb-4"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'পর্যালোচনার প্রয়োজন' : 'Needs review') + '</h3>' +
        '<span class="badge badge-warn">' + low.length + '</span></div>' +
        '<div class="card-bd"><ul class="list">' + low.slice(0, 12).map(function (r) {
          const ratee = data.users.find(function (u) { return u.id === r.ratee_id; }) || {};
          return '<li class="list-item"><span class="kpi-icon" style="background:rgba(229,72,77,.12);color:var(--danger-500)"><i class="fa-solid fa-star"></i></span>' +
            '<span class="li-main"><span class="li-title">' + esc(ratee.full_name || '—') + ' — ' + UI.starsHtml(r.stars, 'sm') + '</span>' +
            '<span class="li-sub">' + esc(r.comment || '—') + '</span></span>' +
            '<span style="font-size:11px;color:var(--muted)">' + esc(PothikGeo.relativeTime(r.created_at)) + '</span></li>';
        }).join('') + '</ul></div></section>' : '') +

      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(t('admin.ratings')) + '</h3>' +
      '<button class="btn btn-ghost btn-sm" id="rt-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button></div>' +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
      '<th>' + esc(I18n.getLang() === 'bn' ? 'রেটিং দিয়েছেন' : 'Rated by') + '</th>' +
      '<th>' + esc(I18n.getLang() === 'bn' ? 'পেয়েছেন' : 'Rated') + '</th>' +
      '<th>' + esc(t('rate.stars')) + '</th><th>' + esc(t('rate.comment')) + '</th>' +
      '<th>' + esc(t('hist.bookingTime')) + '</th></tr></thead><tbody>' +
      rows.slice(0, 120).map(function (r) {
        const from = data.users.find(function (u) { return u.id === r.rater_id; }) || {};
        const to = data.users.find(function (u) { return u.id === r.ratee_id; }) || {};
        return '<tr><td>' + esc(from.full_name || '—') + '<br><span style="font-size:11px;color:var(--muted)">' + esc(t('app.role.' + r.rater_role)) + '</span></td>' +
          '<td>' + esc(to.full_name || '—') + '<br><span style="font-size:11px;color:var(--muted)">' + esc(t('app.role.' + r.ratee_role)) + '</span></td>' +
          '<td>' + UI.starsHtml(r.stars, 'sm') + '</td>' +
          '<td style="max-width:280px">' + esc(r.comment || '—') + '</td>' +
          '<td style="white-space:nowrap;font-size:12px">' + esc(PothikGeo.dateTime(r.created_at)) + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    $('rt-export').addEventListener('click', function () {
      UI.downloadCsv('pothik-ratings.csv', rows.map(function (r) {
        const from = data.users.find(function (u) { return u.id === r.rater_id; }) || {};
        const to = data.users.find(function (u) { return u.id === r.ratee_id; }) || {};
        return { rater: from.full_name, rater_role: r.rater_role, ratee: to.full_name, ratee_role: r.ratee_role, stars: r.stars, comment: r.comment, at: new Date(Number(r.created_at)).toISOString() };
      }));
    });
  }

  /* ============================ NOTIFICATIONS ============================ */
  async function renderNotifications(data) {
    $('admin-body').innerHTML =
      '<div class="grid-2">' +
      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'ব্রডকাস্ট পাঠান' : 'Send a broadcast') + '</h3></div>' +
      '<div class="card-bd"><form id="bc-form">' +
      '<div class="field"><label>' + esc(I18n.getLang() === 'bn' ? 'প্রাপক' : 'Audience') + '</label>' +
      '<select class="select" id="bc-audience">' +
      '<option value="all">' + esc(t('common.all')) + '</option>' +
      '<option value="passenger">' + esc(t('app.role.passenger')) + '</option>' +
      '<option value="driver">' + esc(t('app.role.driver')) + '</option>' +
      '</select></div>' +
      '<div class="field"><label>' + esc(I18n.getLang() === 'bn' ? 'ধরন' : 'Type') + '</label>' +
      '<select class="select" id="bc-type"><option value="promo">' + esc('Promo') + '</option><option value="info">' + esc('Info') + '</option>' +
      '<option value="alert">' + esc('Alert') + '</option><option value="system">' + esc('System') + '</option></select></div>' +
      '<div class="field"><label>' + esc(t('sup.subject')) + '</label><input class="input" id="bc-title" required></div>' +
      '<div class="field"><label>' + esc(t('sup.message')) + '</label><textarea class="textarea" id="bc-body" required></textarea></div>' +
      '<button class="btn btn-primary btn-block" type="submit"><i class="fa-solid fa-paper-plane"></i>' + esc(I18n.getLang() === 'bn' ? 'পাঠান' : 'Send') + '</button>' +
      '</form></div></section>' +

      '<section class="card card-flush"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'সাম্প্রতিক নোটিফিকেশন' : 'Recent notifications') + '</h3></div>' +
      '<div class="card-bd" style="max-height:560px;overflow:auto"><ul class="list">' +
      (data.notifs.length ? data.notifs.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }).slice(0, 30).map(function (n) {
        const u = data.users.find(function (x) { return x.id === n.user_id; }) || {};
        return '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-bell"></i></span>' +
          '<span class="li-main"><span class="li-title">' + esc(n.title) + '</span>' +
          '<span class="li-sub">' + esc(n.body) + '</span>' +
          '<span class="li-sub" style="color:var(--muted-2)">' + esc(u.full_name || 'broadcast') + ' · ' + esc(PothikGeo.relativeTime(n.created_at)) + '</span></span>' +
          (n.is_read ? '' : '<span class="badge badge-brand">' + esc(t('notif.new')) + '</span>') + '</li>';
      }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('notif.empty')) + '</span></li>') +
      '</ul></div></section></div>';

    $('bc-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const audience = $('bc-audience').value;
      const title = $('bc-title').value.trim();
      const body = $('bc-body').value.trim();
      const type = $('bc-type').value;
      if (!title || !body) return;
      try {
        let count = 0;
        if (audience === 'all') {
          count += await Notify.broadcastToRole('passenger', title, body, type);
          count += await Notify.broadcastToRole('driver', title, body, type);
        } else {
          count = await Notify.broadcastToRole(audience, title, body, type);
        }
        await Auth.audit(adminUser.id, 'admin', 'BROADCAST_SENT', 'notifications', '', { audience: audience, title: title });
        $('bc-form').reset();
        UI.toast((I18n.getLang() === 'bn' ? 'পাঠানো হয়েছে ' : 'Sent to ') + count + (I18n.getLang() === 'bn' ? ' জনকে' : ' users'), 'success');
        cache.notifs = null;
        go('notifications');
      } catch (err) { UI.toast(t('err.saveFailed'), 'error'); }
    });
  }

  /* ============================ SYSTEM SETTINGS ========================== */
  async function renderSettings(data) {
    const bools = [
      { key: 'cashEnabled', label: t('pay.cash') },
      { key: 'bkashEnabled', label: t('pay.bkash') },
      { key: 'nagadEnabled', label: t('pay.nagad') },
      { key: 'cardEnabled', label: t('pay.card') },
      { key: 'walletEnabled', label: t('pay.wallet') },
      { key: 'pushEnabled', label: t('set.push') },
      { key: 'soundEnabled', label: t('set.sound') },
      { key: 'shareTripEnabled', label: t('ride.share') },
      { key: 'demoAutoAccept', label: 'Demo auto-accept' }
    ];
    const texts = [
      { key: 'emergencyNumber', label: I18n.getLang() === 'bn' ? 'জরুরি নম্বর' : 'Emergency number' },
      { key: 'supportHotline', label: t('sup.call') },
      { key: 'supportEmail', label: t('sup.email') },
      { key: 'defaultLang', label: I18n.getLang() === 'bn' ? 'ডিফল্ট ভাষা' : 'Default language' },
      { key: 'currency', label: I18n.getLang() === 'bn' ? 'মুদ্রা' : 'Currency' },
      { key: 'country', label: I18n.getLang() === 'bn' ? 'দেশ' : 'Country' }
    ];

    $('admin-body').innerHTML =
      '<div class="grid-2">' +
      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'সুইচ' : 'Feature switches') + '</h3></div>' +
      '<div class="card-bd"><ul class="list">' + bools.map(function (b) {
        return '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(b.label) + '</span>' +
          '<span class="li-sub">' + esc(b.key) + '</span></span>' +
          '<label class="switch"><input type="checkbox" data-bool="' + b.key + '"' + (Settings.get(b.key) ? ' checked' : '') + '><span class="track"></span></label></li>';
      }).join('') + '</ul></div></section>' +

      '<section class="card"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'সাধারণ' : 'General') + '</h3></div>' +
      '<div class="card-bd"><form id="sys-form">' +
      texts.map(function (x) {
        return '<div class="field"><label for="sys-' + x.key + '">' + esc(x.label) + '</label>' +
          '<input class="input" id="sys-' + x.key + '" value="' + esc(Settings.get(x.key)) + '"></div>';
      }).join('') +
      '<button class="btn btn-primary btn-block" type="submit"><i class="fa-solid fa-floppy-disk"></i>' + esc(t('admin.saveSettings')) + '</button>' +
      '</form></div></section></div>' +

      '<section class="card mt-4"><div class="card-hd"><h3>' + esc(I18n.getLang() === 'bn' ? 'বাস্তবায়ন নোট' : 'Implementation notes') + '</h3></div>' +
      '<div class="card-bd"><div class="alert alert-warn"><i class="fa-solid fa-triangle-exclamation"></i>' +
      '<div style="font-size:13px">' +
      '<strong>' + esc(I18n.getLang() === 'bn' ? 'নিরাপত্তা সতর্কতা' : 'Security notice') + '</strong><br>' +
      esc(I18n.getLang() === 'bn'
        ? 'এই প্রশাসক প্যানেল ক্লায়েন্ট-সাইড যাচাই ব্যবহার করে। প্রোডাকশনে অবশ্যই সার্ভার-সাইড প্রমাণীকরণ (NestJS + JWT) ব্যবহার করুন — দেখুন docs/SECURITY.md.'
        : 'This admin panel uses client-side authentication. Production MUST use server-side auth (NestJS + JWT) — see docs/SECURITY.md.') +
      '</div></div>' +
      '<ul class="list">' +
      '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-key"></i></span><span class="li-main"><span class="li-title">API keys</span>' +
      '<span class="li-sub">docs/API-KEYS.md — Google Maps, Firebase, bKash, Nagad, SSLCommerz, VAPID</span></span></li>' +
      '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-mobile-screen"></i></span><span class="li-main"><span class="li-title">Android APK / AAB</span>' +
      '<span class="li-sub">docs/ANDROID-BUILD.md — Capacitor build steps</span></span></li>' +
      '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-database"></i></span><span class="li-main"><span class="li-title">Database schema</span>' +
      '<span class="li-sub">db/schema.postgres.sql — 19 tables, indexes, constraints</span></span></li>' +
      '</ul></div></section>';

    // Wire booleans
    $('admin-body').querySelectorAll('[data-bool]').forEach(function (cb) {
      cb.addEventListener('change', async function () {
        const key = cb.dataset.bool;
        try {
          await Settings.saveToDb(key, cb.checked, adminUser.id);
          await Auth.audit(adminUser.id, 'admin', 'SETTING_UPDATED', 'platform_settings', key, { value: cb.checked });
          UI.toast(t('admin.settingsSaved'), 'success');
          cache.settings = null;
        } catch (e) {
          cb.checked = !cb.checked;
          UI.toast(t('err.saveFailed'), 'error');
        }
      });
    });

    $('sys-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      try {
        for (const x of texts) {
          await Settings.saveToDb(x.key, $('sys-' + x.key).value, adminUser.id);
        }
        await Auth.audit(adminUser.id, 'admin', 'SYSTEM_SETTINGS_UPDATED', 'platform_settings', '', {});
        UI.toast(t('admin.settingsSaved'), 'success');
        cache.settings = null;
      } catch (err) { UI.toast(t('err.saveFailed'), 'error'); }
    });
  }

  /* ============================== AUDIT LOG ============================== */
  async function renderAudit(data) {
    const rows = data.logs.slice().sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    $('admin-body').innerHTML =
      '<div class="row-between mb-4">' +
      '<h2 style="margin:0;font-size:18px">' + esc(t('admin.audit')) + ' (' + rows.length + ')</h2>' +
      '<button class="btn btn-ghost btn-sm" id="log-export"><i class="fa-solid fa-file-csv"></i>' + esc(t('admin.export')) + '</button></div>' +
      (rows.length
        ? '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>' + esc(t('hist.bookingTime')) + '</th><th>' + esc(I18n.getLang() === 'bn' ? 'সম্পাদক' : 'Actor') + '</th>' +
          '<th>' + esc(I18n.getLang() === 'bn' ? 'কাজ' : 'Action') + '</th><th>' + esc(I18n.getLang() === 'bn' ? 'বিষয়' : 'Entity') + '</th>' +
          '<th>' + esc('Meta') + '</th></tr></thead><tbody>' +
          rows.slice(0, 200).map(function (l) {
            const u = data.users.find(function (x) { return x.id === l.actor_id; }) || {};
            return '<tr><td style="white-space:nowrap">' + esc(PothikGeo.dateTime(l.created_at)) + '</td>' +
              '<td>' + esc(u.full_name || l.actor_role || 'system') + '</td>' +
              '<td><span class="badge badge-neutral">' + esc(l.action) + '</span></td>' +
              '<td>' + esc(l.entity || '—') + '<br><span style="font-size:11px;color:var(--muted)">' + esc((l.entity_id || '').slice(0, 20)) + '</span></td>' +
              '<td style="max-width:260px;font-size:11px;font-family:var(--font-mono);color:var(--muted)">' + esc((l.meta || '').slice(0, 80)) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="card">' + UI.emptyState('fa-clipboard-list', t('admin.auditEmpty')) + '</div>');

    const ex = $('log-export');
    if (ex) ex.addEventListener('click', function () { UI.downloadCsv('pothik-audit-log.csv', rows); });
  }
})(window);
