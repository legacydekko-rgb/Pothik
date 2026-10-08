/* ==========================================================================
   Pothik — Passenger app controller
   Router, screens, maps, booking, history, wallet, support, settings
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = function (s) { return document.getElementById(s); };
  const t = function (k, v) { return global.t(k, v); };
  const esc = function (s) { return UI.esc(s); };
  const money = function (n) { return PothikGeo.money(n); };

  let router = null;
  let maps = { home: null, veh: null, trip: null, pin: null };
  let user = null, passenger = null;
  let unsubNotify = null;
  let searchTicker = null;
  let nearbyRefreshTimer = null;
  let pinPickTarget = 'dropoff';   // which field the pin-pick screen fills
  let searchTarget = 'dropoff';    // which field the place-search screen fills

  const state = {
    pickup: null,
    dropoff: null,
    route: null,
    quotes: {},
    availability: { total: 0, byType: {} },
    selectedVehicle: 'bike',
    activeRide: null,
    searchAttempts: 0,
    searchIndex: 0,
    cancelledByUser: false,
    onSearchProgress: null,
    onRideStatusChange: null
  };

  /* ============================== BOOT =================================== */
  document.addEventListener('DOMContentLoaded', async function () {
    Shell.wireLangToggle(document);
    await Shell.boot();

    const sess = Shell.requireAuth('passenger', '../login.html?role=passenger');
    if (!sess) return;

    try {
      user = await Auth.currentUser();
      passenger = await Auth.currentPassenger();
    } catch (e) {
      UI.toast(t('err.network'), 'error');
    }
    if (!user) { Auth.logout(); location.replace('../login.html?role=passenger'); return; }
    if (!passenger) {
      passenger = await DB.create('passengers', {
        id: DB.uid('pax'), user_id: user.id,
        rating: 5, total_ratings: 0, total_rides: 0, total_spent: 0,
        wallet_balance: 0, cancellations: 0, status: 'active', created_at: Date.now()
      });
    }

    state.user = user;
    state.passenger = passenger;

    buildRouter();
    buildNav();
    bindGlobal();

    // Start with the home map (go() renders the header + nav for the screen)
    initHomeMap();
    await router.go('home');

    // Resume an in-flight ride, if any
    await resumeActiveRide();

    refreshConnPill();
    setInterval(refreshConnPill, 5000);

    // Keep the header's language button in sync
    document.addEventListener('pothik:langtoggle', function () {
      refreshConnPill();
      renderAll();
    });

    // Live notifications -> badge + toast
    unsubNotify = Notify.onMessage(function (msg) {
      if (!msg || msg.user_id !== user.id) return;
      UI.toast(msg.title + (msg.body ? ' — ' + msg.body : ''), msg.type === 'alert' ? 'warn' : 'info');
      refreshNavBadges();
      if (router.currentScreen === 'notifications') renderNotifications();
    });
    refreshNavBadges();
  });

  /* ============================= ROUTER ================================== */
  function buildRouter() {
    router = new Shell.Router('#app-main');
    const screens = ['home', 'whereto', 'placesearch', 'pinpick', 'vehicles', 'searching',
      'trip', 'payment', 'rate', 'history', 'ridedetail', 'profile', 'wallet',
      'notifications', 'support', 'settings'];

    screens.forEach(function (id) {
      const el = $('scr-' + id);
      if (!el) return;
      router.add(id, el, {
        onEnter: function () { return onEnterScreen(id); },
        onLeave: function () { return onLeaveScreen(id); }
      });
    });

    RideFlow.attach({
      state: state,
      maps: maps,
      router: router,
      onRideChange: function (ride) { if (ride) renderTrip(ride); }
    });

    state.onSearchProgress = function (p) { renderSearching(p); };
    state.onRideStatusChange = function (ride, prev) { onStatusChange(ride, prev); };
  }

  const NAV_ITEMS = [
    { id: 'home', icon: 'fa-house', labelKey: 'home.whereTo' },
    { id: 'history', icon: 'fa-clock-rotate-left', labelKey: 'hist.title' },
    { id: 'notifications', icon: 'fa-bell', labelKey: 'notif.title' },
    { id: 'profile', icon: 'fa-user', labelKey: 'prof.title' }
  ];

  function buildNav() {
    Shell.renderNav(NAV_ITEMS, 'home', function (id) {
      if (id === 'home') { router.go('home'); return; }
      router.go(id);
    });
  }

  const NO_NAV = ['searching', 'trip', 'payment', 'rate', 'pinpick', 'placesearch', 'vehicles', 'whereto', 'ridedetail'];
  const TITLES = {
    home: 'app.name', whereto: 'home.whereTo', placesearch: 'home.searchPlace',
    pinpick: 'home.setPickup', vehicles: 'home.selectVehicle', searching: 'ride.searching',
    trip: 'ride.trip', payment: 'pay.title', rate: 'rate.title', history: 'hist.title',
    ridedetail: 'hist.details', profile: 'prof.title', wallet: 'wallet.title',
    notifications: 'notif.title', support: 'sup.title', settings: 'set.title'
  };

  async function onEnterScreen(id) {
    // Header + nav chrome
    const showBack = NO_NAV.indexOf(id) !== -1 || ['wallet', 'support', 'settings'].indexOf(id) !== -1;
    Shell.renderHeader({
      title: t(TITLES[id] || 'app.name'),
      brand: !showBack,
      back: showBack,
      onBack: function () { router.back(); }
    });
    if (NO_NAV.indexOf(id) !== -1) Shell.hideNav();
    else Shell.renderNav(NAV_ITEMS, id, function (nid) { router.go(nid); });

    if (unsubNotify) refreshNavBadges();

    switch (id) {
      case 'home': initHomeMap(); refreshHomeMap(); refreshNearbyText(); break;
      case 'whereto': renderWhereTo(); break;
      case 'placesearch': renderPlaceSearch(''); setTimeout(function () { const q = $('place-query'); if (q) q.focus(); }, 200); break;
      case 'pinpick': initPinMap(); break;
      case 'vehicles': initVehicleMap(); break;
      case 'trip': if (state.activeRide) renderTrip(state.activeRide); break;
      case 'payment': renderPayment(); break;
      case 'rate': renderRate(); break;
      case 'history': renderHistory(); break;
      case 'profile': renderProfile(); break;
      case 'wallet': renderWallet(); break;
      case 'notifications': renderNotifications(); break;
      case 'support': renderSupport(); break;
      case 'settings': renderSettings(); break;
    }
  }

  function onLeaveScreen(id) {
    if (id === 'home' && nearbyRefreshTimer) { clearInterval(nearbyRefreshTimer); nearbyRefreshTimer = null; }
    if (id === 'searching' && searchTicker) { clearInterval(searchTicker); searchTicker = null; }
  }

  function renderAll() {
    const id = router ? router.currentScreen : 'home';
    if (id) onEnterScreen(id);
  }

  /* =========================== GLOBAL BINDINGS ============================ */
  function bindGlobal() {
    // Home
    $('home-search').addEventListener('click', function () { searchTarget = 'dropoff'; router.go('whereto'); });
    $('home-search').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.go('whereto'); } });
    $('home-book').addEventListener('click', function () { searchTarget = 'dropoff'; router.go('whereto'); });
    $('home-locate').addEventListener('click', async function () {
      await RideFlow.setPickupFromGps();
      state.dropoff = state.dropoff; // keep
      if (maps.home) maps.home.centerOn(state.pickup, 15);
      refreshHomeMap();
    });

    // Where-to
    $('input-pickup').addEventListener('click', function () { searchTarget = 'pickup'; router.go('placesearch'); });
    $('input-dropoff').addEventListener('click', function () { searchTarget = 'dropoff'; router.go('placesearch'); });

    // Place search
    $('place-query').addEventListener('input', UI.debounce(function (e) {
      renderPlaceSearch(e.target.value);
    }, 420));

    // Pin pick
    $('pin-confirm').addEventListener('click', async function () {
      const c = maps.pin ? maps.pin.getCenter() : PothikGeo.BD.center;
      const label = await PothikGeo.reverseGeocode(c.lat, c.lng);
      const place = { lat: c.lat, lng: c.lng, label: label.label };
      if (pinPickTarget === 'pickup') state.pickup = place;
      else state.dropoff = place;
      renderWhereTo();
      router.back();
    });

    // Vehicles
    $('veh-request').addEventListener('click', function () { startSearch(); });

    // Searching
    $('search-cancel').addEventListener('click', function () { cancelFromSearching(); });

    // Trip
    $('trip-cancel').addEventListener('click', function () { cancelFromTrip(); });
    $('trip-sos').addEventListener('click', function () { sosFlow(); });
    $('trip-share').addEventListener('click', function () { shareTrip(); });
    $('trip-call').addEventListener('click', function () { callDriver(); });
    $('trip-msg').addEventListener('click', function () { messageDriver(); });
    $('trip-details-toggle').addEventListener('click', function () {
      const box = $('trip-pin-box');
      if (box) box.classList.toggle('hidden');
      const ico = this.querySelector('i');
      if (ico) ico.className = box && box.classList.contains('hidden') ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    });

    // Payment
    $('pay-confirm').addEventListener('click', function () { confirmPayment(); });

    // Rate
    $('rate-submit').addEventListener('click', function () { submitRating(); });
    $('rate-skip').addEventListener('click', function () {
      state.activeRide = null;
      router.go('home');
      setTimeout(function () { promptNewBooking(); }, 400);
    });

    // History filters
    $('history-filter').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-filter]');
      if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.setAttribute('aria-selected', 'false'); });
      b.setAttribute('aria-selected', 'true');
      renderHistory(b.dataset.filter);
    });

    // Profile
    document.querySelectorAll('#scr-profile [data-go]').forEach(function (li) {
      li.addEventListener('click', function () { router.go(li.dataset.go); });
    });
    $('profile-form').addEventListener('submit', saveProfile);

    // Wallet
    $('wallet-topup').addEventListener('click', function () {
      UI.modal({
        title: t('wallet.addMoney'),
        bodyHtml: '<div class="alert alert-info"><i class="fa-solid fa-circle-info"></i><div style="font-size:13px">' +
          t('wallet.topupSoon') + '<br><br>Integration points: bKash Merchant API, Nagad, SSLCommerz. ' +
          'Add credentials to <code>.env</code> and implement <code>/api/wallet/topup</code> in the backend.</div></div>',
        actions: [{ label: t('common.ok'), class: 'btn-primary' }]
      });
    });

    // Notifications
    $('notif-mark-all').addEventListener('click', async function () {
      await Notify.markAllRead(user.id);
      renderNotifications();
      refreshNavBadges();
    });

    // Support
    $('ticket-form').addEventListener('submit', submitTicket);

    // Settings
    $('set-lang').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-lang]');
      if (!b) return;
      I18n.setLang(b.dataset.lang);
      renderSettings();
    });
    $('set-dark').addEventListener('change', function () {
      UI.setTheme(this.checked ? 'dark' : 'light');
    });
    $('set-push').addEventListener('change', async function () {
      if (this.checked) {
        const r = await Notify.requestPermission();
        if (r !== 'granted') { this.checked = false; UI.toast(t('err.notAllowed'), 'warn'); return; }
        Notify.subscribePush().catch(function () {});
      }
      Settings.set('pushEnabled', this.checked);
      Settings.saveToDb('pushEnabled', this.checked, user.id).catch(function () {});
    });
    $('set-sound').addEventListener('change', function () {
      Settings.set('soundEnabled', this.checked);
      Settings.saveToDb('soundEnabled', this.checked, user.id).catch(function () {});
    });
    $('set-autodemo').addEventListener('change', function () {
      Settings.set('demoAutoAccept', this.checked);
      Settings.saveToDb('demoAutoAccept', this.checked, user.id).catch(function () {});
      UI.toast(this.checked ? 'Demo auto-accept ON' : 'Demo auto-accept OFF', 'info');
    });
    $('set-flush').addEventListener('click', async function () {
      const res = await DB.flushQueue();
      UI.toast('Synced ' + res.flushed + ', failed ' + res.failed, 'info');
      renderSettings();
    });
    $('set-about').addEventListener('click', showAbout);
    $('set-logout').addEventListener('click', async function () {
      const ok = await UI.confirm({ title: t('auth.logout'), message: t('auth.logout') + '?', danger: true });
      if (!ok) return;
      RideFlow.stopWatching();
      RideFlow.stopSimulatedMovement();
      Auth.logout();
      location.replace('../index.html');
    });

    // Connection pill refresh on network change
    window.addEventListener('online', function () { refreshConnPill(); UI.toast(t('common.saved'), 'success'); });
    window.addEventListener('offline', function () { refreshConnPill(); UI.toast(t('err.offline'), 'warn'); });
  }

  function refreshConnPill() {
    const host = $('conn-pill');
    if (host) host.innerHTML = Shell.connectionPill();
  }

  /* =============================== MAPS ================================== */
  function initHomeMap() {
    if (maps.home) { maps.home.invalidate(); return; }
    maps.home = PothikMap.create('map-home', { center: PothikGeo.BD.center, zoom: 13 });
    if (state.pickup) maps.home.setSelf(state.pickup);
    maps.home.onClick(function (ll) {
      UI.confirm({ title: t('home.setPickup'), message: t('home.confirmPickup') + '?' }).then(async function (ok) {
        if (!ok) return;
        const label = await PothikGeo.reverseGeocode(ll.lat, ll.lng);
        state.pickup = { lat: ll.lat, lng: ll.lng, label: label.label };
        maps.home.setPickup(state.pickup, state.pickup.label);
        refreshHomeMap();
      });
    });
  }

  async function refreshHomeMap() {
    if (!maps.home) return;
    if (!state.pickup) {
      try {
        await RideFlow.setPickupFromGps();
      } catch (e) { /* handled inside */ }
    }
    if (state.pickup) {
      maps.home.setSelf(state.pickup);
      if (!maps.home._centred) { maps.home.centerOn(state.pickup, 15); maps.home._centred = true; }
      const gps = $('gps-text');
      if (gps) gps.textContent = state.pickup.label;
      const dot = $('gps-dot');
      if (dot) dot.classList.add('dot-live');
    }

    // Nearby driver pins
    if (state.pickup) {
      const drivers = await Matching.nearbyDriverPositions(state.pickup, 6, 24);
      const keep = ['self', 'pickup'];
      Object.keys(maps.home.markers).forEach(function (k) {
        if (k.indexOf('drv-') === 0 && !drivers.some(function (d) { return 'drv-' + d.driverId === k; })) {
          maps.home.removeMarker(k);
        }
      });
      drivers.forEach(function (d) {
        maps.home.setMarker('drv-' + d.driverId, { lat: d.lat, lng: d.lng }, d.vehicleType, d.heading);
      });
      renderNearbyText(drivers.length);
    }

    refreshConnPill();

    // Auto-refresh pins every 12s while on the home screen
    if (nearbyRefreshTimer) clearInterval(nearbyRefreshTimer);
    nearbyRefreshTimer = setInterval(function () {
      if (router.currentScreen !== 'home') { clearInterval(nearbyRefreshTimer); nearbyRefreshTimer = null; return; }
      refreshHomeMap();
    }, 12000);
  }

  function renderNearbyText(count) {
    const host = $('nearby-drivers');
    if (!host) return;
    const avail = state.availability || { byType: {} };
    const types = Settings.vehicleList();
    host.innerHTML = types.map(function (v) {
      const n = (avail.byType && avail.byType[v.type]) || 0;
      return '<span class="badge ' + (n ? 'badge-success' : 'badge-neutral') + '">' +
        '<i class="fa-solid ' + (v.icon || 'fa-car') + '"></i>' + esc(t('veh.' + v.type)) + ' ' + n + '</span>';
    }).join('');
  }

  async function refreshNearbyText() {
    if (!state.pickup) return;
    await RideFlow.refreshAvailability();
    renderNearbyText();
  }

  function initVehicleMap() {
    if (!maps.veh) maps.veh = PothikMap.create('map-veh', { center: state.pickup || PothikGeo.BD.center, zoom: 13 });
    maps.veh.invalidate();
    drawBookingRoute(maps.veh);
    renderVehicleList();
  }

  function initPinMap() {
    if (!maps.pin) {
      maps.pin = PothikMap.create('map-pin', { center: state.dropoff || state.pickup || PothikGeo.BD.center, zoom: 16 });
      maps.pin.onMoveEnd(UI.debounce(async function (center) {
        const label = await PothikGeo.reverseGeocode(center.lat, center.lng);
        const el = $('pin-label');
        if (el) el.textContent = label.label;
      }, 600));
    }
    maps.pin.invalidate();
    const start = pinPickTarget === 'pickup' ? state.pickup : state.dropoff;
    if (start) maps.pin.centerOn(start, 16);
    const label = $('pin-label');
    if (label) label.textContent = (start && start.label) || t('home.dragPin');
  }

  function drawBookingRoute(map) {
    if (!map || !state.pickup || !state.dropoff) return;
    map.setPickup(state.pickup, state.pickup.label);
    map.setDropoff(state.dropoff, state.dropoff.label);
    if (state.route && state.route.polyline) map.drawRoute(state.route.polyline);
    map.fitPoints([state.pickup, state.dropoff], [70, 70]);
  }

  /* ============================ WHERE TO ================================= */
  function renderWhereTo() {
    $('pickup-text').textContent = (state.pickup && state.pickup.label) || t('home.currentLocation');
    const drop = $('input-dropoff').querySelector('.sr-text');
    if (drop) drop.textContent = (state.dropoff && state.dropoff.label) || t('home.setDropoff');
    renderSavedPlaces();
  }

  async function renderSavedPlaces() {
    let places = [];
    try {
      places = await DB.list('saved_places', { limit: 100 });
    } catch (e) { places = []; }
    const mine = places.filter(function (p) { return p.user_id === user.id; });
    const saved = mine.filter(function (p) { return p.kind !== 'recent'; });
    const recent = mine.filter(function (p) { return p.kind === 'recent'; }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); }).slice(0, 6);

    $('saved-places').innerHTML = saved.length ? saved.map(function (p) {
      const icon = p.kind === 'home' ? 'fa-house' : (p.kind === 'work' ? 'fa-briefcase' : 'fa-star');
      return '<li class="list-item interactive" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-label="' + esc(p.label) + '">' +
        '<span class="kpi-icon"><i class="fa-solid ' + icon + '"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(p.label) + '</span></span>' +
        '<i class="fa-solid fa-chevron-right" style="color:var(--muted-2)"></i></li>';
    }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>';

    $('recent-places').innerHTML = recent.length ? recent.map(function (p) {
      return '<li class="list-item interactive" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-label="' + esc(p.label) + '">' +
        '<span class="kpi-icon"><i class="fa-solid fa-clock-rotate-left"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(p.label) + '</span></span>' +
        '<i class="fa-solid fa-chevron-right" style="color:var(--muted-2)"></i></li>';
    }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>';

    document.querySelectorAll('#scr-whereto li[data-lat]').forEach(function (li) {
      li.addEventListener('click', function () {
        const place = { lat: Number(li.dataset.lat), lng: Number(li.dataset.lng), label: li.dataset.label };
        if (searchTarget === 'pickup') state.pickup = place; else state.dropoff = place;
        renderWhereTo();
        if (searchTarget === 'dropoff') setTimeout(function () { proceedToVehicles(); }, 260);
      });
    });
  }

  /* =========================== PLACE SEARCH ============================== */
  async function renderPlaceSearch(query) {
    const host = $('place-results');
    if (!host) return;
    if (!query || query.trim().length < 2) {
      host.innerHTML = '<li class="list-item"><span class="li-sub">' +
        esc(t('home.searchPlace')) + ' — ' + esc(t('home.dragPin')) + '</span></li>';
      return;
    }
    host.innerHTML = '<li class="list-item"><span class="spinner" style="color:var(--brand-500)"></span><span class="li-sub">' +
      esc(t('common.loading')) + '</span></li>';

    const results = await PothikGeo.searchPlaces(query, state.pickup, 10);
    if (!results.length) {
      host.innerHTML = UI.emptyState('fa-magnifying-glass', t('common.noData'), t('home.searchPlace'));
      return;
    }
    host.innerHTML = results.map(function (r, i) {
      return '<li class="list-item interactive" data-i="' + i + '">' +
        '<span class="kpi-icon"><i class="fa-solid fa-location-dot"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(r.label) + '</span>' +
        '<span class="li-sub">' + esc((r.full || '').slice(0, 70)) + '</span></span></li>';
    }).join('');

    host.querySelectorAll('li[data-i]').forEach(function (li) {
      li.addEventListener('click', function () {
        const r = results[Number(li.dataset.i)];
        const place = { lat: r.lat, lng: r.lng, label: r.label };
        if (searchTarget === 'pickup') state.pickup = place; else state.dropoff = place;
        router.back();
        renderWhereTo();
        if (searchTarget === 'dropoff') setTimeout(function () { proceedToVehicles(); }, 300);
      });
    });
  }

  /* ============================ VEHICLES ================================= */
  function renderVehicleList() {
    const host = $('veh-list');
    if (!host) return;
    const types = Settings.vehicleList();
    host.innerHTML = types.map(function (v) {
      const q = state.quotes[v.type];
      if (!q) return '';
      const avail = (state.availability.byType && state.availability.byType[v.type]) || 0;
      return '<button class="veh-option" role="radio" aria-checked="' + (state.selectedVehicle === v.type) + '" data-type="' + v.type + '">' +
        '<span class="vo-icon" style="color:' + (v.color || 'var(--brand-500)') + '"><i class="fa-solid ' + (v.icon || 'fa-car') + '"></i></span>' +
        '<span class="grow"><strong style="display:block">' + esc(t('veh.' + v.type)) + '</strong>' +
        '<span class="vo-meta">' + esc(t('veh.' + v.type + '.desc')) + ' · ' + avail + ' ' + esc(t('veh.available')) + '</span></span>' +
        '<span class="right"><span class="vo-price">' + money(q.total) + '</span>' +
        '<span class="vo-meta" style="display:block">' + esc(t('veh.eta')) + ' ' + PothikGeo.duration(q.minutes) + '</span></span>' +
        '</button>';
    }).join('');

    host.querySelectorAll('.veh-option').forEach(function (b) {
      b.addEventListener('click', function () {
        state.selectedVehicle = b.dataset.type;
        host.querySelectorAll('.veh-option').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        updateVehicleFare();
      });
    });
    updateVehicleFare();
  }

  function updateVehicleFare() {
    const q = state.quotes[state.selectedVehicle];
    const el = $('veh-fare');
    if (el && q) el.textContent = money(q.total);
  }

  /** Route + quotes + availability, then show the vehicle picker. */
  async function proceedToVehicles() {
    if (!state.pickup || !state.dropoff) {
      UI.toast(t('home.setDropoff'), 'warn');
      return;
    }
    Shell.showLoading(true, t('common.loading'));
    try {
      await RideFlow.computeRoute();
      await RideFlow.refreshAvailability();
      const r = state.route;
      $('veh-km').textContent = PothikGeo.distance(r.km);
      $('veh-min').textContent = PothikGeo.duration(r.minutes);
      $('veh-source').textContent = r.source === 'osrm' ? 'OSRM road route' : 'estimated';
      // Pick the cheapest available type by default
      const avail = state.availability.byType || {};
      const preferred = Object.keys(avail).filter(function (k) { return avail[k] > 0; })
        .sort(function (a, b) { return (state.quotes[a].total - state.quotes[b].total); })[0];
      state.selectedVehicle = preferred || 'bike';
      router.go('vehicles');
    } catch (e) {
      UI.toast(t('err.generic'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  /* ============================ SEARCHING ================================ */
  async function startSearch() {
    state.cancelledByUser = false;
    Shell.showLoading(true, t('ride.searching'));
    try {
      await RideFlow.requestRide();
    } catch (e) {
      Shell.showLoading(false);
      UI.toast(t('err.generic'), 'error');
      return;
    }
    Shell.showLoading(false);
    router.go('searching');
    renderSearching({ state: 'offering', index: 0, total: 0, timeoutSec: Settings.get('requestTimeoutSec') });

    // Countdown + progress bar
    if (searchTicker) clearInterval(searchTicker);
    let elapsed = 0;
    const total = Math.max(15, (state.searchAttempts || 1) * Settings.get('requestTimeoutSec'));
    searchTicker = setInterval(function () {
      elapsed++;
      const bar = $('search-bar');
      if (bar) bar.style.width = Math.min(100, (elapsed / total) * 100) + '%';
      const timer = $('search-timer');
      if (timer) timer.textContent = elapsed + 's';
      if (elapsed > total + 12) { clearInterval(searchTicker); searchTicker = null; }
    }, 1000);
  }

  function renderSearching(p) {
    const candEl = $('search-candidate');
    const noteEl = $('search-demo-note');
    if (!p) return;
    if (p.state === 'offering' && p.candidate) {
      if (candEl) {
        candEl.innerHTML = '#' + p.index + '/' + p.total + ' · ' +
          '<i class="fa-solid fa-car-side"></i> ' + PothikGeo.distance(p.candidate.distKm) + ' · ' +
          t('veh.eta') + ' ' + p.candidate.etaMinutes + ' ' + t('common.min') +
          (p.candidate.simulated ? ' <span class="badge badge-warn">demo</span>' : '');
      }
      if (noteEl) noteEl.style.display = p.candidate.simulated ? '' : 'none';
    } else if (p.state === 'offering') {
      if (candEl) candEl.innerHTML = '<span class="spinner" style="color:var(--brand-500)"></span> ' + t('common.loading');
    } else if (p.state === 'no_drivers' || p.state === 'timeout') {
      if (searchTicker) { clearInterval(searchTicker); searchTicker = null; }
      showNoDrivers(p.state);
    } else if (p.state === 'matched') {
      if (searchTicker) { clearInterval(searchTicker); searchTicker = null; }
      // Handled by the ride watcher
    }
  }

  function showNoDrivers(kind) {
    const title = kind === 'no_drivers' ? t('ride.noDrivers') : t('ride.searchTimeout');
    const sub = kind === 'no_drivers' ? t('ride.noDriversSub') : t('ride.searchTimeoutSub');
    UI.modal({
      title: title,
      bodyHtml: '<p style="margin:0;color:var(--muted)">' + esc(sub) + '</p>',
      dismissible: false,
      actions: [
        { label: t('ride.cancel'), class: 'btn-ghost', onClick: function (c) { c(); router.go('home'); } },
        { label: t('ride.retrySearch'), class: 'btn-primary', onClick: function (c) { c(); retrySearch(); } }
      ]
    });
  }

  async function retrySearch() {
    if (!state.activeRide) { router.go('home'); return; }
    // Roll the ride back to SEARCHING_DRIVER and try again
    try {
      await DB.update('rides', state.activeRide.id, {
        status: 'SEARCHING_DRIVER', driver_id: '', driver_user_id: '', vehicle_id: '',
        search_started_at: Date.now(), matched_driver_attempts: 0
      });
      state.activeRide = await DB.get('rides', state.activeRide.id);
    } catch (e) { /* ignore */ }
    state.cancelledByUser = false;
    router.go('searching');
    renderSearching({ state: 'offering', index: 0, total: 0, timeoutSec: Settings.get('requestTimeoutSec') });
    RideFlow.startWatching(state.activeRide.id);
  }

  async function cancelFromSearching() {
    const ok = await UI.confirm({
      title: t('ride.cancel'),
      message: t('ride.cancelConfirm'),
      confirmLabel: t('ride.cancel'),
      danger: true
    });
    if (!ok) return;
    await RideFlow.cancelRide('changed_plan', 'Cancelled while searching');
    state.activeRide = null;
    router.go('home');
    UI.toast(t('ride.cancelled'), 'info');
  }

  /* =============================== TRIP ================================== */
  async function onStatusChange(ride, prev) {
    if (!ride) return;
    if (ride.status === 'DRIVER_ASSIGNED' && prev === 'SEARCHING_DRIVER') {
      // Move to the trip screen and announce
      await RideFlow.loadDriverInfo(ride).then(function (info) {
        Notify.send(Notify.Ride.found(user.id, info && info.driver ? info.driver.full_name : '', ride.id)).catch(function () {});
      });
      router.go('trip');
      renderTrip(ride);
      RideFlow.startSimulatedMovement(ride.id);
      if (state.selectedVehicle) { /* keep */ }
    }
    if (ride.status === 'DRIVER_ARRIVING') {
      Notify.send(Notify.Ride.arriving(user.id, 3, ride.id)).catch(function () {});
    }
    if (ride.status === 'DRIVER_ARRIVED') {
      Notify.send(Notify.Ride.arrived(user.id, ride.id)).catch(function () {});
      UI.toast(t('ride.arrivedNotif'), 'success');
    }
    if (ride.status === 'RIDE_STARTED') {
      Notify.send(Notify.Ride.started(user.id, ride.id)).catch(function () {});
    }
    if (ride.status === 'RIDE_COMPLETED') {
      RideFlow.stopSimulatedMovement();
      router.go('payment');
    }
    if (ride.status === 'CANCELLED_BY_DRIVER') {
      RideFlow.stopSimulatedMovement();
      RideFlow.stopWatching();
      UI.modal({
        title: t('ride.driverCancelled'),
        bodyHtml: '<p style="margin:0;color:var(--muted)">' + esc(t('ride.retrySearch')) + '</p>',
        actions: [
          { label: t('common.close'), class: 'btn-ghost', onClick: function (c) { c(); state.activeRide = null; router.go('home'); } },
          { label: t('ride.retrySearch'), class: 'btn-primary', onClick: function (c) { c(); retrySearch(); } }
        ]
      });
    }
  }

  async function renderTrip(ride) {
    if (!ride) return;
    const host = $('scr-trip');
    if (!host || host.classList.contains('hidden')) {
      // still keep the DOM fresh for when it becomes visible
    }
    $('trip-status-badge').innerHTML = UI.statusBadge(ride.status);

    // Progress rail
    const steps = [
      { key: 'DRIVER_ASSIGNED', icon: 'fa-user-check', label: t('ride.driverAssigned') },
      { key: 'DRIVER_ARRIVING', icon: 'fa-car-side', label: t('ride.driverArriving') },
      { key: 'DRIVER_ARRIVED', icon: 'fa-location-dot', label: t('ride.driverArrived') },
      { key: 'RIDE_STARTED', icon: 'fa-flag-checkered', label: t('ride.started') },
      { key: 'RIDE_COMPLETED', icon: 'fa-circle-check', label: t('ride.completed') }
    ];
    const idx = RideState.progressIndex(ride.status);
    $('trip-rail').innerHTML = steps.map(function (s, i) {
      const cls = i < idx ? 'done' : (i === idx ? 'active' : '');
      return '<div class="tr-step ' + cls + '"><span class="tr-dot"><i class="fa-solid ' + s.icon + '"></i></span><span>' + esc(s.label) + '</span></div>';
    }).join('');

    // Driver card
    const info = await RideFlow.loadDriverInfo(ride);
    if (info && info.driver) {
      $('trip-driver-avatar').innerHTML = UI.avatarHtml(info.driver.full_name, info.driver.photo_url);
      $('trip-driver-name').textContent = info.driver.full_name;
      const plate = info.vehicle ? info.vehicle.registration_number : '';
      $('trip-driver-meta').innerHTML = UI.starsHtml(info.driver.rating, 'sm') + ' ' +
        esc(String(info.driver.rating || '—')) + ' · ' + esc(plate) +
        (info.vehicle ? ' · ' + esc(info.vehicle.model) : '');
    } else {
      $('trip-driver-avatar').innerHTML = UI.avatarHtml('?', '');
      $('trip-driver-name').textContent = t('ride.searching');
      $('trip-driver-meta').textContent = '—';
    }

    // PIN visible until the ride starts
    const pinBox = $('trip-pin-box');
    if (pinBox) {
      if (ride.status === 'DRIVER_ASSIGNED' || ride.status === 'DRIVER_ARRIVING' || ride.status === 'DRIVER_ARRIVED') {
        pinBox.classList.remove('hidden');
        $('trip-pin').innerHTML = String(ride.start_otp || '----').split('').map(function (d) { return '<span>' + esc(d) + '</span>'; }).join('');
      } else {
        pinBox.classList.add('hidden');
      }
    }

    // ETA + distance
    if (info && info.status && info.status.lat) {
      const target = ride.status === 'RIDE_STARTED'
        ? { lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng) }
        : { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) };
      const km = PothikGeo.haversineKm({ lat: Number(info.status.lat), lng: Number(info.status.lng) }, target);
      $('trip-eta').textContent = PothikGeo.duration((km / 20) * 60);
      $('trip-km').textContent = PothikGeo.distance(km);
    } else {
      $('trip-eta').textContent = PothikGeo.duration(ride.duration_min || 0);
      $('trip-km').textContent = PothikGeo.distance(Number(ride.distance_km) || 0);
    }

    // Cancel button only before the ride starts
    $('trip-cancel').disabled = !(ride.status === 'DRIVER_ASSIGNED' || ride.status === 'DRIVER_ARRIVING' || ride.status === 'DRIVER_ARRIVED');

    drawTripMap(ride, info);
  }

  function drawTripMap(ride, info) {
    if (!maps.trip) maps.trip = PothikMap.create('map-trip', { center: { lat: ride.pickup_lat, lng: ride.pickup_lng }, zoom: 14 });
    maps.trip.invalidate();
    maps.trip.setPickup({ lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) }, ride.pickup_label);
    maps.trip.setDropoff({ lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng) }, ride.dropoff_label);

    if (info && info.status && info.status.lat) {
      const dpos = { lat: Number(info.status.lat), lng: Number(info.status.lng) };
      maps.trip.setDriver(dpos, ride.vehicle_type, Number(info.status.heading) || 0);
      // Draw the remaining leg from the driver to the current target
      const target = ride.status === 'RIDE_STARTED'
        ? { lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng) }
        : { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) };
      PothikGeo.route(dpos, target).then(function (r) {
        if (r && r.polyline) maps.trip.drawRoute(r.polyline, '#0A7C5A');
        maps.trip.fitPoints([dpos, target], [80, 110]);
      });
    } else if (state.route && state.route.polyline) {
      maps.trip.drawRoute(state.route.polyline);
      maps.trip.fitPoints([{ lat: ride.pickup_lat, lng: ride.pickup_lng }, { lat: ride.dropoff_lat, lng: ride.dropoff_lng }], [80, 110]);
    }
  }

  async function cancelFromTrip() {
    const reasons = [
      { code: 'changed_plan', label: t('ride.cancelReason') + ': ' + (I18n.getLang() === 'bn' ? 'পরিকল্পনা বদলেছে' : 'Changed plan') },
      { code: 'waited_too_long', label: I18n.getLang() === 'bn' ? 'অনেকক্ষণ অপেক্ষা করেছি' : 'Waited too long' },
      { code: 'driver_too_far', label: I18n.getLang() === 'bn' ? 'চালক অনেক দূরে' : 'Driver too far' },
      { code: 'found_other_ride', label: I18n.getLang() === 'bn' ? 'অন্য রাইড পেয়েছি' : 'Found another ride' }
    ];
    const cf = state.activeRide ? Fare.cancellationFee(state.activeRide, '') : { fee: 0, waived: true };

    const body = document.createElement('div');
    body.innerHTML = '<p style="margin:0 0 12px;color:var(--muted)">' + esc(t('ride.cancelConfirm')) + '</p>' +
      (cf.fee > 0 ? '<div class="alert alert-warn mb-4"><i class="fa-solid fa-triangle-exclamation"></i><span>' +
        esc(t('ride.cancelFee')) + ': <strong>' + money(cf.fee) + '</strong></span></div>' : '') +
      '<div class="field"><label>' + esc(t('ride.cancelReason')) + '</label>' +
      '<select class="select" id="cancel-reason">' +
      reasons.map(function (r) { return '<option value="' + r.code + '">' + esc(r.label) + '</option>'; }).join('') +
      '</select></div>';

    UI.modal({
      title: t('ride.cancel'),
      content: body,
      actions: [
        { label: t('common.back'), class: 'btn-ghost' },
        {
          label: t('ride.cancel'), class: 'btn-danger', onClick: async function (close) {
            const code = (document.getElementById('cancel-reason') || {}).value || 'changed_plan';
            close();
            Shell.showLoading(true, t('common.loading'));
            try {
              await RideFlow.cancelRide(code, '');
              state.activeRide = null;
              router.go('home');
              UI.toast(t('ride.cancelled'), 'info');
            } catch (e) {
              UI.toast(t('err.generic'), 'error');
            } finally {
              Shell.showLoading(false);
            }
          }
        }
      ]
    });
  }

  async function sosFlow() {
    const ok = await UI.confirm({ title: t('ride.emergency'), message: t('ride.sosConfirm'), confirmLabel: 'SOS', danger: true });
    if (!ok) return;
    await RideFlow.triggerSos();
    UI.toast(t('ride.sosSent'), 'warn', 6000);
    const emergency = Settings.get('emergencyNumber');
    UI.modal({
      title: t('ride.emergency'),
      bodyHtml: '<div class="alert alert-danger mb-4"><i class="fa-solid fa-truck-medical"></i>' +
        '<span>' + esc(t('ride.sosSent')) + '</span></div>' +
        '<a class="btn btn-danger btn-block btn-lg" href="tel:' + esc(emergency) + '">' +
        '<i class="fa-solid fa-phone"></i> ' + esc(emergency) + '</a>' +
        '<p class="center mt-3" style="font-size:12px;color:var(--muted)">' + esc(t('ride.emergencyContacts')) + '</p>',
      actions: [{ label: t('common.close'), class: 'btn-ghost' }]
    });
  }

  async function shareTrip() {
    const text = RideFlow.shareTripText();
    if (navigator.share) {
      try { await navigator.share({ title: 'Pothik trip', text: text }); return; } catch (e) { /* fall through */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      UI.toast(t('ride.share') + ' ✓', 'success');
    } catch (e) {
      UI.modal({ title: t('ride.share'), bodyHtml: '<textarea class="textarea" rows="7" readonly>' + esc(text) + '</textarea>', actions: [{ label: t('common.close'), class: 'btn-primary' }] });
    }
  }

  async function callDriver() {
    const info = await RideFlow.loadDriverInfo(state.activeRide);
    if (!info || !info.driver) return;
    location.href = 'tel:' + PothikGeo.toE164(info.driver.phone);
  }

  async function messageDriver() {
    const info = await RideFlow.loadDriverInfo(state.activeRide);
    if (!info || !info.driver) return;
    location.href = 'sms:' + PothikGeo.toE164(info.driver.phone);
  }

  /* ============================= PAYMENT ================================= */
  async function renderPayment() {
    const ride = state.activeRide;
    if (!ride) { router.go('home'); return; }
    const rows = [
      { k: t('pay.baseFare'), v: ride.base_fare },
      { k: t('pay.distanceCharge'), v: ride.distance_charge, meta: PothikGeo.distance(Number(ride.distance_km) || 0) },
      { k: t('pay.timeCharge'), v: ride.time_charge, meta: PothikGeo.duration(ride.duration_min || 0) }
    ];
    if (Number(ride.surge) > 1) rows.push({ k: t('pay.surge'), v: Fare.roundTo((Number(ride.fare_total) / Number(ride.surge)) * (Number(ride.surge) - 1), 1), meta: '×' + ride.surge });
    if (Number(ride.discount) > 0) rows.push({ k: t('pay.discount'), v: -Number(ride.discount) });

    $('pay-breakdown').innerHTML = rows.map(function (r) {
      return '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(r.k) + '</span>' +
        (r.meta ? '<span class="li-sub">' + esc(r.meta) + '</span>' : '') + '</span>' +
        '<strong>' + money(r.v) + '</strong></li>';
    }).join('');

    $('pay-total').textContent = money(ride.fare_total);

    const methods = [
      { id: 'cash', key: 'pay.cash', icon: 'fa-money-bill-wave', enabled: Settings.get('cashEnabled') },
      { id: 'bkash', key: 'pay.bkash', icon: 'fa-mobile-screen', enabled: Settings.get('bkashEnabled') },
      { id: 'nagad', key: 'pay.nagad', icon: 'fa-mobile-screen', enabled: Settings.get('nagadEnabled') },
      { id: 'card', key: 'pay.card', icon: 'fa-credit-card', enabled: Settings.get('cardEnabled') },
      { id: 'wallet', key: 'pay.wallet', icon: 'fa-wallet', enabled: Settings.get('walletEnabled') }
    ];
    $('pay-methods').innerHTML = methods.map(function (m, i) {
      return '<button class="veh-option" role="radio" aria-checked="' + (i === 0) + '" data-method="' + m.id + '"' +
        (m.enabled ? '' : ' aria-disabled="true" style="opacity:.55"') + '>' +
        '<span class="vo-icon"><i class="fa-solid ' + m.icon + '"></i></span>' +
        '<span class="grow"><strong style="display:block">' + esc(t(m.key)) + '</strong>' +
        '<span class="vo-meta">' + (m.enabled ? (m.id === 'cash' ? t('pay.cashNote') : t('pay.paid')) : t('pay.onlineSoon')) + '</span></span>' +
        (m.enabled ? '' : '<span class="badge badge-neutral">soon</span>') +
        '</button>';
    }).join('');

    $('pay-methods').querySelectorAll('.veh-option').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('aria-disabled') === 'true') { UI.toast(t('pay.onlineSoon'), 'warn'); return; }
        $('pay-methods').querySelectorAll('.veh-option').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
      });
    });

    // If the ride was already paid, show the receipt view
    if (ride.payment_status === 'Paid') {
      $('pay-confirm').innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + t('pay.paid');
      $('pay-confirm').disabled = true;
    }
  }

  async function confirmPayment() {
    const selected = $('pay-methods').querySelector('.veh-option[aria-checked="true"]');
    const method = selected ? selected.dataset.method : 'cash';
    Shell.showLoading(true, t('common.loading'));
    try {
      await RideFlow.payRide(method);
      UI.toast(t('pay.paid') + ' ✓', 'success');
      router.go('rate');
    } catch (e) {
      UI.toast(t('err.saveFailed'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  /* ============================== RATING ================================= */
  let starCtl = null;
  function renderRate() {
    const ride = state.activeRide;
    const host = $('rate-stars-host');
    if (!ride || !host) return;
    RideFlow.loadDriverInfo(ride).then(function (info) {
      $('rate-avatar').innerHTML = info && info.driver
        ? UI.avatarHtml(info.driver.full_name, info.driver.photo_url, 'xl')
        : UI.avatarHtml('?', '', 'xl');
      $('rate-sub').textContent = (info && info.driver ? info.driver.full_name + ' · ' : '') + t('rate.driverSub');
    });
    host.innerHTML = '';
    starCtl = UI.starInput(5, function () {});
    host.appendChild(starCtl.node);
  }

  async function submitRating() {
    const stars = starCtl ? starCtl.value : 0;
    if (!stars) { UI.toast(t('rate.stars'), 'warn'); return; }
    const comment = $('rate-comment').value;
    Shell.showLoading(true, t('common.loading'));
    try {
      await RideFlow.submitRating(stars, comment, 'driver');
      UI.modal({
        title: t('rate.thanks'),
        bodyHtml: '<div class="center"><span class="kpi-icon" style="width:70px;height:70px;font-size:30px;margin:0 auto 14px;background:rgba(18,161,80,.12);color:var(--success-500)"><i class="fa-solid fa-heart"></i></span>' +
          '<p style="color:var(--muted)">' + esc(t('rate.thanksSub')) + '</p></div>',
        actions: [{ label: t('common.ok'), class: 'btn-primary', onClick: function (c) { c(); state.activeRide = null; router.go('home'); setTimeout(promptNewBooking, 400); } }],
        onClose: function () { state.activeRide = null; router.go('home'); }
      });
    } catch (e) {
      UI.toast(t('err.saveFailed'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  function promptNewBooking() {
    searchTarget = 'dropoff';
    router.go('whereto');
  }

  /* ============================== HISTORY ================================ */
  async function renderHistory(filter) {
    const host = $('history-list');
    if (!host) return;
    host.innerHTML = '<div class="card"><span class="spinner" style="color:var(--brand-500)"></span></div>';
    let rides = [];
    try {
      rides = await DB.list('rides', { limit: 300 });
    } catch (e) { rides = []; }

    let mine = rides.filter(function (r) { return r.passenger_user_id === user.id; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    const f = filter || (document.querySelector('#history-filter button[aria-selected="true"]') || {}).dataset?.filter || 'all';
    if (f === 'completed') mine = mine.filter(function (r) { return r.status === 'PAYMENT_COMPLETED' || r.status === 'RIDE_COMPLETED'; });
    if (f === 'cancelled') mine = mine.filter(function (r) { return RideState.isCancelled(r.status); });

    if (!mine.length) {
      host.innerHTML = UI.emptyState('fa-clock-rotate-left', t('hist.empty'), t('hist.emptySub'));
      return;
    }

    // Group by day
    const groups = {};
    mine.slice(0, 60).forEach(function (r) {
      const d = new Date(Number(r.created_at));
      const key = d.toDateString();
      (groups[key] = groups[key] || []).push(r);
    });

    host.innerHTML = Object.keys(groups).map(function (day) {
      const items = groups[day].map(function (r) {
        const icon = r.vehicle_type === 'bike' ? 'fa-motorcycle' : (r.vehicle_type === 'cng' ? 'fa-taxi' : 'fa-car-side');
        return '<li class="list-item interactive" data-ride="' + esc(r.id) + '">' +
          '<span class="kpi-icon"><i class="fa-solid ' + icon + '"></i></span>' +
          '<span class="li-main"><span class="li-title">' + esc((r.dropoff_label || '').slice(0, 34)) + '</span>' +
          '<span class="li-sub">' + esc(PothikGeo.clockTime(r.created_at)) + ' · ' + esc(PothikGeo.distance(Number(r.distance_km) || 0)) + '</span></span>' +
          '<span class="right"><strong style="display:block">' + (RideState.isCancelled(r.status) ? '—' : money(r.fare_total)) + '</strong>' +
          UI.statusBadge(r.status) + '</span></li>';
      }).join('');
      return '<h3 class="mt-4" style="font-size:13px;color:var(--muted)">' + esc(day) + '</h3>' +
        '<div class="card card-flush"><ul class="list">' + items + '</ul></div>';
    }).join('');

    host.querySelectorAll('li[data-ride]').forEach(function (li) {
      li.addEventListener('click', function () { renderRideDetail(li.dataset.ride); router.go('ridedetail'); });
    });
  }

  async function renderRideDetail(rideId) {
    const host = $('rd-body');
    host.innerHTML = '<div class="card"><span class="spinner" style="color:var(--brand-500)"></span></div>';
    let ride = null;
    try { ride = await DB.get('rides', rideId); } catch (e) { ride = null; }
    if (!ride) { host.innerHTML = UI.emptyState('fa-circle-exclamation', t('common.noData')); return; }

    const info = await RideFlow.loadDriverInfo(ride);
    const canRebook = ride.status === 'PAYMENT_COMPLETED' || RideState.isCancelled(ride.status);

    host.innerHTML =
      '<div class="card mb-4">' +
        '<div class="row-between mb-3"><strong>' + esc(ride.ride_code || '') + '</strong>' + UI.statusBadge(ride.status) + '</div>' +
        '<div class="route-summary">' +
          '<div class="rs-rail"><span class="rs-dot" style="border-color:var(--brand-500);background:var(--brand-500)"></span>' +
          '<span class="rs-line"></span><span class="rs-dot" style="border-color:var(--accent-500);background:var(--accent-500)"></span></div>' +
          '<div class="grow col gap-3">' +
            '<div><div class="li-sub">' + esc(t('ride.pickupPoint')) + '</div><strong>' + esc(ride.pickup_label) + '</strong></div>' +
            '<div><div class="li-sub">' + esc(t('ride.dropoffPoint')) + '</div><strong>' + esc(ride.dropoff_label) + '</strong></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      (info && info.driver ? '<div class="driver-card mb-4">' + UI.avatarHtml(info.driver.full_name, info.driver.photo_url) +
        '<div class="grow"><strong style="display:block">' + esc(info.driver.full_name) + '</strong>' +
        '<span style="font-size:12px;color:var(--muted)">' + esc(info.vehicle ? info.vehicle.registration_number + ' · ' + info.vehicle.model : '') + '</span></div>' +
        UI.starsHtml(info.driver.rating, 'sm') + '</div>' : '') +

      '<div class="card mb-4"><h3 style="font-size:15px">' + esc(t('hist.details')) + '</h3>' +
        '<ul class="list">' +
        row(t('hist.rideId'), ride.ride_code) +
        row(t('hist.bookingTime'), PothikGeo.dateTime(ride.created_at)) +
        row(t('ride.distance'), PothikGeo.distance(Number(ride.actual_km) || Number(ride.distance_km) || 0)) +
        row(t('ride.duration'), PothikGeo.duration(Number(ride.actual_minutes) || Number(ride.duration_min) || 0)) +
        row(t('pay.method'), t('pay.' + (ride.payment_method || 'cash'))) +
        row(t('common.status'), t('pay.' + String(ride.payment_status || 'Pending').toLowerCase())) +
        '</ul></div>' +

      '<div class="card mb-4"><h3 style="font-size:15px">' + esc(t('pay.breakdown')) + '</h3>' +
        '<ul class="list">' +
        row(t('pay.baseFare'), money(ride.base_fare)) +
        row(t('pay.distanceCharge'), money(ride.distance_charge)) +
        row(t('pay.timeCharge'), money(ride.time_charge)) +
        (Number(ride.discount) > 0 ? row(t('pay.discount'), '-' + money(ride.discount)) : '') +
        '</ul>' +
        '<div class="row-between" style="border-top:1px solid var(--border);padding-top:12px;margin-top:8px">' +
        '<strong>' + esc(t('pay.total')) + '</strong><strong style="font-size:20px">' + money(ride.fare_total) + '</strong></div>' +
      '</div>' +

      (RideState.isCancelled(ride.status) ?
        '<div class="alert alert-warn mb-4"><i class="fa-solid fa-triangle-exclamation"></i><span>' +
        esc(t('ride.cancelled')) + (Number(ride.cancellation_fee) > 0 ? ' · ' + esc(t('ride.cancelFee')) + ' ' + money(ride.cancellation_fee) : '') +
        '</span></div>' : '') +

      '<div class="row gap-3">' +
        '<button class="btn btn-ghost grow" id="rd-receipt"><i class="fa-solid fa-print"></i> ' + esc(t('pay.receipt')) + '</button>' +
        (canRebook ? '<button class="btn btn-primary grow" id="rd-rebook"><i class="fa-solid fa-rotate-right"></i> ' + esc(t('hist.rebook')) + '</button>' : '') +
      '</div>';

    const rb = $('rd-rebook');
    if (rb) rb.addEventListener('click', function () {
      state.pickup = { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng), label: ride.pickup_label };
      state.dropoff = { lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng), label: ride.dropoff_label };
      proceedToVehicles();
    });
    $('rd-receipt').addEventListener('click', function () { printReceipt(ride, info); });

    function row(k, v) {
      return '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(k) + '</span></span>' +
        '<strong>' + esc(v === null || v === undefined ? '—' : v) + '</strong></li>';
    }
  }

  function printReceipt(ride, info) {
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) { UI.toast(t('common.noData'), 'warn'); return; }
    const html = '<!DOCTYPE html><html lang="' + I18n.getLang() + '"><head><meta charset="utf-8">' +
      '<title>Pothik Receipt ' + esc(ride.ride_code) + '</title>' +
      '<style>body{font-family:Inter,system-ui,sans-serif;padding:24px;color:#0B1512;max-width:380px;margin:auto}' +
      'h1{font-size:20px;margin:0 0 4px}.muted{color:#5B6B66;font-size:12px}' +
      'table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}' +
      'td{padding:7px 0;border-bottom:1px solid #E2E9E6}td:last-child{text-align:right;font-weight:600}' +
      '.total{border-top:2px solid #0B1512;font-size:17px}.brand{color:#0A7C5A;font-weight:800;font-size:15px;letter-spacing:.04em}' +
      '</style></head><body>' +
      '<div class="brand">পথিক · POTHIK</div>' +
      '<h1>' + esc(t('pay.receipt')) + '</h1>' +
      '<div class="muted">' + esc(ride.ride_code) + ' · ' + esc(PothikGeo.dateTime(ride.created_at)) + '</div>' +
      '<table>' +
      '<tr><td>' + esc(t('ride.pickupPoint')) + '</td><td>' + esc(ride.pickup_label) + '</td></tr>' +
      '<tr><td>' + esc(t('ride.dropoffPoint')) + '</td><td>' + esc(ride.dropoff_label) + '</td></tr>' +
      (info && info.driver ? '<tr><td>' + esc(t('app.role.driver')) + '</td><td>' + esc(info.driver.full_name) + '</td></tr>' : '') +
      (info && info.vehicle ? '<tr><td>' + esc(t('ride.vehicle')) + '</td><td>' + esc(info.vehicle.registration_number) + '</td></tr>' : '') +
      '<tr><td>' + esc(t('ride.distance')) + '</td><td>' + esc(PothikGeo.distance(Number(ride.actual_km) || Number(ride.distance_km) || 0)) + '</td></tr>' +
      '<tr><td>' + esc(t('ride.duration')) + '</td><td>' + esc(PothikGeo.duration(Number(ride.actual_minutes) || Number(ride.duration_min) || 0)) + '</td></tr>' +
      '<tr><td>' + esc(t('pay.baseFare')) + '</td><td>' + money(ride.base_fare) + '</td></tr>' +
      '<tr><td>' + esc(t('pay.distanceCharge')) + '</td><td>' + money(ride.distance_charge) + '</td></tr>' +
      '<tr><td>' + esc(t('pay.timeCharge')) + '</td><td>' + money(ride.time_charge) + '</td></tr>' +
      '<tr class="total"><td>' + esc(t('pay.total')) + '</td><td>' + money(ride.fare_total) + '</td></tr>' +
      '<tr><td>' + esc(t('pay.method')) + '</td><td>' + esc(t('pay.' + (ride.payment_method || 'cash'))) + '</td></tr>' +
      '</table>' +
      '<p class="muted" style="margin-top:20px">Pothik · support@pothik.com.bd · 16247<br>Thank you for riding with us. ধন্যবাদ।</p>' +
      '</body></html>';
    w.document.write(html);
    w.document.close();
    setTimeout(function () { w.print(); }, 350);
  }

  /* ============================== PROFILE ================================ */
  async function renderProfile() {
    $('profile-avatar').innerHTML = UI.avatarHtml(user.full_name, user.photo_url, 'xl');
    $('profile-name').textContent = user.full_name;
    $('profile-phone').textContent = '+880 ' + PothikGeo.formatBdPhone(user.phone);
    $('profile-rating').innerHTML = '<i class="fa-solid fa-star"></i> ' + (Number(passenger.rating) || 5).toFixed(2);
    $('profile-rides').textContent = (passenger.total_rides || 0) + ' ' + t('prof.totalRides');
    $('stat-rides').textContent = passenger.total_rides || 0;
    $('stat-balance').textContent = money(passenger.wallet_balance || 0);
    $('prof-name').value = user.full_name || '';
    $('prof-email').value = user.email || '';
    $('prof-emergency').value = user.emergency_contact || '';
    $('support-hotline').textContent = Settings.get('supportHotline');
    $('support-email').textContent = Settings.get('supportEmail');
  }

  async function saveProfile(e) {
    e.preventDefault();
    const name = $('prof-name').value.trim();
    if (!name) { UI.toast(t('auth.nameRequired'), 'warn'); return; }
    try {
      await DB.update('users', user.id, {
        full_name: name,
        email: $('prof-email').value.trim(),
        emergency_contact: $('prof-emergency').value.trim()
      });
      user = await Auth.currentUser();
      const sess = Auth.getSession();
      if (sess) { sess.name = user.full_name; Auth.saveSession(sess); }
      UI.toast(t('common.saved'), 'success');
      renderProfile();
    } catch (err) {
      UI.toast(t('err.saveFailed'), 'error');
    }
  }

  /* ============================== WALLET ================================= */
  async function renderWallet() {
    $('wallet-balance').textContent = money(passenger.wallet_balance || 0);
    let rides = [];
    try { rides = await DB.list('rides', { limit: 200 }); } catch (e) { rides = []; }
    const paid = rides.filter(function (r) {
      return r.passenger_user_id === user.id && r.payment_status === 'Paid';
    }).sort(function (a, b) { return (b.paid_at || b.created_at) - (a.paid_at || a.created_at); }).slice(0, 25);

    const host = $('wallet-tx');
    if (!paid.length) { host.innerHTML = '<li class="list-item"><span class="li-sub">' + esc(t('wallet.noTx')) + '</span></li>'; return; }
    host.innerHTML = paid.map(function (r) {
      return '<li class="list-item"><span class="kpi-icon" style="background:rgba(229,72,77,.1);color:var(--danger-500)"><i class="fa-solid fa-arrow-up"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(r.ride_code || '') + '</span>' +
        '<span class="li-sub">' + esc(PothikGeo.dateTime(r.paid_at || r.created_at)) + ' · ' + esc(t('pay.' + (r.payment_method || 'cash'))) + '</span></span>' +
        '<strong style="color:var(--danger-500)">-' + money(r.fare_total) + '</strong></li>';
    }).join('');
  }

  /* =========================== NOTIFICATIONS ============================= */
  async function renderNotifications() {
    const host = $('notif-list');
    if (!host) return;
    let rows = [];
    try { rows = await DB.list('notifications', { limit: 200 }); } catch (e) { rows = []; }
    const mine = rows.filter(function (r) {
      return r.user_id === user.id || (r.audience === 'role' && r.role === 'passenger');
    }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    if (!mine.length) { host.innerHTML = UI.emptyState('fa-bell-slash', t('notif.empty')); return; }

    const icons = { ride: 'fa-car-side', payment: 'fa-receipt', promo: 'fa-gift', alert: 'fa-triangle-exclamation', info: 'fa-circle-info', system: 'fa-gear' };
    host.innerHTML = mine.slice(0, 60).map(function (n) {
      return '<div class="card mb-3 interactive" data-notif="' + esc(n.id) + '" style="' + (n.is_read ? '' : 'border-left:3px solid var(--brand-500)') + ';cursor:pointer">' +
        '<div class="row gap-3">' +
        '<span class="kpi-icon"><i class="fa-solid ' + (icons[n.type] || 'fa-circle-info') + '"></i></span>' +
        '<div class="grow"><strong style="display:block;font-size:14px">' + esc(n.title) + '</strong>' +
        '<p style="margin:2px 0 0;font-size:13px;color:var(--muted)">' + esc(n.body) + '</p>' +
        '<span style="font-size:11px;color:var(--muted-2)">' + esc(PothikGeo.relativeTime(n.created_at)) + '</span></div>' +
        (n.is_read ? '' : '<span class="badge badge-brand">' + esc(t('notif.new')) + '</span>') +
        '</div></div>';
    }).join('');

    host.querySelectorAll('[data-notif]').forEach(function (card) {
      card.addEventListener('click', async function () {
        const id = card.dataset.notif;
        await Notify.markRead(id);
        const n = mine.find(function (x) { return x.id === id; });
        if (n && n.ride_id) {
          try {
            const ride = await DB.get('rides', n.ride_id);
            state.activeRide = ride;
            if (ride && RideState.isActive(ride.status)) {
              RideFlow.startWatching(ride.id);
              router.go('trip');
              return;
            }
            renderRideDetail(n.ride_id);
            router.go('ridedetail');
            return;
          } catch (e) { /* fall through */ }
        }
        renderNotifications();
        refreshNavBadges();
      });
    });
  }

  async function refreshNavBadges() {
    if (!user) return;
    const n = await Notify.unreadCount(user.id);
    Shell.updateNavBadge('notifications', n);
  }

  /* ============================= SUPPORT ================================= */
  async function renderSupport() {
    $('support-hotline').textContent = Settings.get('supportHotline');
    $('support-email').textContent = Settings.get('supportEmail');
    const mail = $('support-mailto');
    if (mail) mail.href = 'mailto:' + Settings.get('supportEmail');

    const host = $('ticket-list');
    let rows = [];
    try { rows = await DB.list('support_tickets', { limit: 200 }); } catch (e) { rows = []; }
    const mine = rows.filter(function (r) { return r.user_id === user.id; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    if (!mine.length) { host.innerHTML = UI.emptyState('fa-headset', t('common.noData')); return; }
    host.innerHTML = '<div class="card card-flush"><ul class="list">' + mine.map(function (tk) {
      return '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-ticket"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(tk.subject) + '</span>' +
        '<span class="li-sub">' + esc(tk.ticket_code || '') + ' · ' + esc(PothikGeo.relativeTime(tk.created_at)) + '</span></span>' +
        '<span class="badge ' + (tk.status === 'open' ? 'badge-warn' : (tk.status === 'resolved' ? 'badge-success' : 'badge-neutral')) + '">' +
        esc(tk.status === 'open' ? t('sup.open') : (tk.status === 'resolved' ? t('sup.closed') : tk.status)) + '</span></li>';
    }).join('') + '</ul></div>';
  }

  async function submitTicket(e) {
    e.preventDefault();
    const subject = $('ticket-subject').value.trim();
    const message = $('ticket-message').value.trim();
    if (!subject || !message) return;
    try {
      await DB.create('support_tickets', {
        id: DB.uid('tkt'),
        ticket_code: 'SUP-' + Math.floor(10000 + Math.random() * 89999),
        user_id: user.id, user_role: 'passenger',
        ride_id: state.activeRide ? state.activeRide.id : '',
        category: $('ticket-category').value,
        subject: subject, message: message, attachment_url: '',
        priority: 'normal', status: 'open', assigned_to: '', resolution: '',
        reported_user_id: '', created_at: Date.now()
      });
      $('ticket-form').reset();
      UI.toast(t('sup.submitted'), 'success');
      renderSupport();
    } catch (err) {
      UI.toast(t('err.saveFailed'), 'error');
    }
  }

  /* ============================= SETTINGS ================================ */
  function renderSettings() {
    const lang = I18n.getLang();
    $('set-lang').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.lang === lang ? 'true' : 'false');
    });
    $('set-dark').checked = document.documentElement.getAttribute('data-theme') === 'dark';
    $('set-push').checked = !!Settings.get('pushEnabled');
    $('set-sound').checked = !!Settings.get('soundEnabled');
    $('set-autodemo').checked = !!Settings.get('demoAutoAccept');
    const q = DB.queueLength;
    $('set-queue').textContent = q + (I18n.getLang() === 'bn' ? ' বাকি' : ' pending');
  }

  function showAbout() {
    UI.modal({
      title: t('set.about'),
      bodyHtml:
        '<div class="center mb-4"><span class="brand-mark" style="width:58px;height:58px;font-size:26px;border-radius:18px;margin:0 auto">প</span>' +
        '<h3 class="mt-3" style="margin-bottom:2px">' + esc(t('app.name')) + '</h3>' +
        '<p style="color:var(--muted);font-size:13px">' + esc(t('app.tagline')) + '</p></div>' +
        '<ul class="list">' +
        '<li class="list-item"><span class="li-main"><span class="li-title">' + esc(t('set.version')) + '</span></span><strong>1.0.0</strong></li>' +
        '<li class="list-item"><span class="li-main"><span class="li-title">Market</span></span><strong>Bangladesh 🇧🇩</strong></li>' +
        '<li class="list-item"><span class="li-main"><span class="li-title">Currency</span></span><strong>BDT ৳</strong></li>' +
        '<li class="list-item"><span class="li-main"><span class="li-title">Languages</span></span><strong>বাংলা / English</strong></li>' +
        '<li class="list-item"><span class="li-main"><span class="li-title">Vehicles</span></span><strong>Bike · CNG · Car</strong></li>' +
        '</ul>',
      actions: [{ label: t('common.close'), class: 'btn-primary' }]
    });
  }

  /* ========================= RESUME ACTIVE RIDE ========================== */
  async function resumeActiveRide() {
    let rides = [];
    try { rides = await DB.list('rides', { limit: 200 }); } catch (e) { return; }
    const active = rides.filter(function (r) {
      return r.passenger_user_id === user.id && RideState.isActive(r.status);
    }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); })[0];

    if (!active) {
      const unpaid = rides.filter(function (r) {
        return r.passenger_user_id === user.id && r.status === 'RIDE_COMPLETED';
      }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); })[0];
      if (unpaid) { state.activeRide = unpaid; router.go('payment'); }
      return;
    }

    state.activeRide = active;
    if (active.status === 'SEARCHING_DRIVER') {
      state.selectedVehicle = active.vehicle_type;
      router.go('searching');
      RideFlow.startWatching(active.id);
      return;
    }
    router.go('trip');
    RideFlow.startWatching(active.id);
    RideFlow.startSimulatedMovement(active.id);
  }
})(window);
