/* ==========================================================================
   Pothik — Driver app controller
   Onboarding -> verification -> approval gate -> online toggle -> ride
   lifecycle -> earnings -> ratings
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = function (s) { return document.getElementById(s); };
  const t = function (k, v) { return global.t(k, v); };
  const esc = function (s) { return UI.esc(s); };
  const money = function (n) { return PothikGeo.money(n); };

  let router = null;
  let maps = {};
  let user = null, driver = null, driverStatus = null;
  let unsubNotify = null;
  let pingTimer = null;
  let offerTimer = null;
  let watchTimer = null;
  let searchTicker = null;
  let currentOffer = null;
  let activeRide = null;
  let pinCtl = null;

  const PING_MS = 9000;         // GPS heartbeat while online
  const OFFER_POLL_MS = 2500;   // how often we look for new requests

  /* ============================== BOOT =================================== */
  document.addEventListener('DOMContentLoaded', async function () {
    Shell.wireLangToggle(document);
    UI.setTheme('dark');           // night-driving ergonomics by default
    await Shell.boot();

    const sess = Shell.requireAuth('driver', '../login.html?role=driver');
    if (!sess) return;

    try {
      user = await Auth.currentUser();
      driver = await Auth.currentDriver();
    } catch (e) { /* offline */ }
    if (!user) { Auth.logout(); location.replace('../login.html?role=driver'); return; }

    buildRouter();
    bindGlobal();

    await refreshDriver();
    await router.go('home');

    refreshConnPill();
    setInterval(refreshConnPill, 5000);

    unsubNotify = Notify.onMessage(function (msg) {
      if (!msg || msg.user_id !== user.id) return;
      UI.toast(msg.title + (msg.body ? ' — ' + msg.body : ''), msg.type === 'alert' ? 'warn' : 'info');
      if (msg.ride_id) pollOffer();
    });

    document.addEventListener('pothik:langtoggle', function () { renderCurrent(); });

    // Lightweight hash routing so inline links (e.g. onclick="location.hash='#status'")
    // can navigate without a full page load.
    window.addEventListener('hashchange', function () {
      const id = (location.hash || '').replace('#', '');
      if (id && router.screens.has(id)) router.go(id);
    });
    const initialHash = (location.hash || '').replace('#', '');
    if (initialHash && router.screens.has(initialHash)) router.go(initialHash);
  });

  async function refreshDriver() {
    try { driver = await Auth.currentDriver(); } catch (e) { /* keep */ }
    if (driver) {
      driverStatus = await DB.findWhere('driver_status', function (r) { return r.driver_id === driver.id; });
    }
    // Keep the session's approval status fresh
    const sess = Auth.getSession();
    if (sess && driver && sess.driverStatus !== driver.status) {
      sess.driverStatus = driver.status;
      Auth.saveSession(sess);
    }
    return driver;
  }

  function isApproved() { return driver && driver.status === 'approved'; }

  /* ============================= ROUTER ================================== */
  function buildRouter() {
    router = new Shell.Router('#app-main');
    ['home', 'onboarding', 'status', 'incoming', 'navigate', 'earnings', 'history',
      'ratings', 'notifications', 'support', 'profile', 'settings'].forEach(function (id) {
      const el = $('scr-' + id);
      if (!el) return;
      router.add(id, el, { onEnter: function () { return onEnter(id); }, onLeave: function () { return onLeave(id); } });
    });
  }

  const NAV_ITEMS = [
    { id: 'home', icon: 'fa-house', labelKey: 'drvHome.title' },
    { id: 'earnings', icon: 'fa-sack-dollar', labelKey: 'earn.title' },
    { id: 'history', icon: 'fa-clock-rotate-left', labelKey: 'hist.title' },
    { id: 'ratings', icon: 'fa-star', labelKey: 'drvRate.title' },
    { id: 'profile', icon: 'fa-user', labelKey: 'prof.title' }
  ];

  const NO_NAV = ['onboarding', 'status', 'incoming', 'navigate', 'notifications', 'support', 'settings'];
  const TITLES = {
    home: 'drvHome.title', onboarding: 'drv.register', status: 'drv.statusTitle',
    incoming: 'drvHome.incoming', navigate: 'ride.trip', earnings: 'earn.title',
    history: 'hist.title', ratings: 'drvRate.title', notifications: 'notif.title',
    support: 'sup.title', profile: 'prof.title', settings: 'set.title'
  };

  async function onEnter(id) {
    const showBack = NO_NAV.indexOf(id) !== -1;
    Shell.renderHeader({
      title: t(TITLES[id] || 'drv.title'),
      brand: !showBack, back: showBack,
      onBack: function () { router.back(); }
    });
    if (showBack) Shell.hideNav();
    else Shell.renderNav(NAV_ITEMS, id, function (nid) { router.go(nid); });

    switch (id) {
      case 'home': await renderHome(); break;
      case 'onboarding': renderOnboarding(); break;
      case 'status': renderStatus(); break;
      case 'incoming': renderIncoming(); break;
      case 'navigate': await renderNavigate(); break;
      case 'earnings': renderEarnings('daily'); break;
      case 'history': renderHistory(); break;
      case 'ratings': renderRatings(); break;
      case 'notifications': renderNotifications(); break;
      case 'support': renderSupport(); break;
      case 'profile': renderProfile(); break;
      case 'settings': renderSettings(); break;
    }
  }

  function onLeave(id) {
    if (id === 'incoming' && offerTimer) { clearInterval(offerTimer); offerTimer = null; }
    if (id === 'navigate' && maps.nav) { maps.nav.destroy(); maps.nav = null; }
  }

  function renderCurrent() {
    if (router && router.currentScreen) onEnter(router.currentScreen);
  }

  /* =========================== GLOBAL BINDING ============================= */
  function bindGlobal() {
    // Onboarding
    $('ob-next').addEventListener('click', onboardingNext);
    $('ob-back').addEventListener('click', onboardingBack);
    $('ob-submit').addEventListener('click', submitApplication);

    // Status
    $('status-refresh').addEventListener('click', async function () {
      await refreshDriver();
      renderStatus();
      UI.toast(t('common.updated'), 'success');
    });
    $('status-resubmit').addEventListener('click', function () { router.go('onboarding'); });

    // Home: online toggle
    $('home-online').addEventListener('change', function () { toggleOnline(this.checked); });

    // Incoming offer
    $('offer-accept').addEventListener('click', acceptOffer);
    $('offer-reject').addEventListener('click', rejectOffer);

    // Navigate / trip
    $('nav-arrived').addEventListener('click', markArrived);
    $('nav-start').addEventListener('click', openPinModal);
    $('nav-end').addEventListener('click', endRide);
    $('nav-cancel').addEventListener('click', cancelByDriver);
    $('nav-call').addEventListener('click', callPassenger);

    // Earnings tabs
    $('earn-tabs').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-period]');
      if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.setAttribute('aria-selected', 'false'); });
      b.setAttribute('aria-selected', 'true');
      renderEarnings(b.dataset.period);
    });

    // Notifications
    $('drv-notif-mark-all').addEventListener('click', async function () {
      await Notify.markAllRead(user.id);
      renderNotifications();
    });

    // Support
    $('drv-ticket-form').addEventListener('submit', submitTicket);

    // Profile
    $('drv-profile-form').addEventListener('submit', saveProfile);

    // Settings
    $('drv-set-lang').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-lang]');
      if (!b) return;
      I18n.setLang(b.dataset.lang);
      renderSettings();
    });
    $('drv-set-sound').addEventListener('change', function () {
      Settings.set('soundEnabled', this.checked);
    });
    $('drv-set-keepawake').addEventListener('change', function () {
      Settings.set('keepAwake', this.checked);
      if (this.checked) requestWakeLock(); else releaseWakeLock();
    });
    $('drv-set-logout').addEventListener('click', async function () {
      const ok = await UI.confirm({ title: t('auth.logout'), message: t('auth.logout') + '?', danger: true });
      if (!ok) return;
      await goOffline();
      Auth.logout();
      location.replace('../index.html');
    });

    window.addEventListener('online', refreshConnPill);
    window.addEventListener('offline', function () { refreshConnPill(); UI.toast(t('err.offline'), 'warn'); });
    window.addEventListener('beforeunload', function () { stopPing(); });
  }

  function refreshConnPill() {
    const host = $('conn-pill');
    if (host) host.innerHTML = Shell.connectionPill();
  }

  /* ======================== DRIVER HOME ================================== */
  async function renderHome() {
    await refreshDriver();
    if (!driver) {
      // Should not happen, but recover gracefully
      UI.toast(t('err.generic'), 'error');
      return;
    }

    // Approval gate
    if (!isApproved()) {
      if (driver.status === 'pending' && (!driver.nid_number || !driver.licence_number)) {
        router.go('onboarding');
        return;
      }
      router.go('status');
      return;
    }

    const online = driverStatus && driverStatus.is_online;
    const panel = $('online-panel');
    panel.className = 'online-panel ' + (online ? 'on' : 'off');
    $('home-online').checked = !!online;
    $('online-title').textContent = online ? t('drvHome.online') : t('drvHome.offline');
    $('online-sub').textContent = online ? t('drvHome.onlineSub') : t('drvHome.offlineSub');
    $('online-icon').className = 'fa-solid ' + (online ? 'fa-wifi' : 'fa-power-off');

    $('drv-name').textContent = driver.full_name || user.full_name;
    $('drv-avatar').innerHTML = UI.avatarHtml(driver.full_name, driver.photo_url);
    $('drv-rating').innerHTML = '<i class="fa-solid fa-star"></i> ' + (Number(driver.rating) || 5).toFixed(2);

    // Today's stats
    const stats = await computeDriverStats();
    $('home-earnings').textContent = money(stats.todayNet);
    $('home-rides').textContent = stats.todayRides;
    $('home-hours').textContent = PothikGeo.toBanglaDigits(stats.onlineHours.toFixed(1)) + (I18n.getLang() === 'bn' ? ' ঘ' : 'h');
    $('home-acceptance').textContent = Math.round((Number(driver.acceptance_rate) || 1) * 100) + '%';
    $('home-total-rides').textContent = driver.completed_rides || 0;
    const statusNote = $('home-status-note');
    if (statusNote) statusNote.textContent = t('drv.status.' + (driver.status || 'pending') + '.desc');

    if (online) {
      startPing();
      startOfferPolling();
    } else {
      stopPing();
      stopOfferPolling();
    }

    // Resume an in-progress ride
    await resumeActiveRide();
  }

  async function computeDriverStats() {
    let rides = [], coms = [];
    try {
      rides = await DB.list('rides', { limit: 400 });
      coms = await DB.list('commissions', { limit: 400 });
    } catch (e) { /* offline */ }

    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();

    const mineRides = rides.filter(function (r) { return r.driver_id === driver.id; });
    const todayRides = mineRides.filter(function (r) {
      return (r.completed_at || r.created_at) >= todayMs &&
        (r.status === 'RIDE_COMPLETED' || r.status === 'PAYMENT_COMPLETED');
    });
    const myComs = coms.filter(function (c) { return c.driver_id === driver.id; });
    const todayComs = myComs.filter(function (c) { return Number(c.created_at) >= todayMs; });

    const todayNet = todayComs.reduce(function (a, c) { return a + Number(c.net_earning || 0); }, 0);

    let onlineHours = 0;
    if (driverStatus && driverStatus.online_since) {
      onlineHours = Math.max(0, (Date.now() - Number(driverStatus.online_since)) / 3600000);
    }

    return {
      todayNet: todayNet,
      todayRides: todayRides.length,
      onlineHours: onlineHours,
      allRides: mineRides,
      allComs: myComs
    };
  }

  /* ========================= ONLINE / OFFLINE ============================ */
  async function toggleOnline(wantOnline) {
    if (!wantOnline) { await goOffline(); return; }

    Shell.showLoading(true, t('common.loading'));
    try {
      const fix = await PothikGeo.getCurrent(12000);
      if (!driverStatus) {
        driverStatus = await DB.create('driver_status', {
          id: DB.uid('ds'), driver_id: driver.id, user_id: user.id,
          is_online: true, availability: 'available',
          lat: fix.lat, lng: fix.lng, heading: fix.heading || 0, accuracy: fix.accuracy,
          last_ping_at: Date.now(), active_ride_id: null,
          rating: driver.rating, acceptance_rate: driver.acceptance_rate,
          completed_rides: driver.completed_rides,
          vehicle_type: (await primaryVehicleType()), vehicle_id: null,
          online_since: Date.now(), updated_at: Date.now()
        });
      } else {
        await DB.update('driver_status', driverStatus.id, {
          is_online: true, availability: driverStatus.active_ride_id ? 'busy' : 'available',
          lat: fix.lat, lng: fix.lng, heading: fix.heading || 0, accuracy: fix.accuracy,
          last_ping_at: Date.now(), online_since: driverStatus.online_since || Date.now(),
          vehicle_type: driverStatus.vehicle_type || (await primaryVehicleType()),
          updated_at: Date.now()
        });
      }
      await refreshDriver();
      startPing();
      startOfferPolling();
      renderHome();
      requestWakeLock();
      UI.toast(t('drvHome.online') + ' ✓', 'success');
    } catch (e) {
      $('home-online').checked = false;
      UI.toast(e && e.code === 1 ? t('home.gpsDenied') : t('home.gpsUnavailable'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  async function goOffline() {
    stopPing();
    stopOfferPolling();
    releaseWakeLock();
    if (!driverStatus) return;
    try {
      await DB.update('driver_status', driverStatus.id, {
        is_online: false,
        availability: driverStatus.active_ride_id ? 'busy' : 'offline',
        speed_kmh: 0, updated_at: Date.now()
      });
    } catch (e) { /* ignore */ }
    await refreshDriver();
    if (router.currentScreen === 'home') renderHome();
  }

  async function primaryVehicleType() {
    try {
      const v = await DB.findWhere('vehicles', function (x) { return x.driver_id === driver.id; });
      return v ? v.vehicle_type : 'car';
    } catch (e) { return 'car'; }
  }

  /* ---------------------------------------------------- GPS heartbeat */
  function startPing() {
    if (pingTimer) return;
    const send = async function (fix) {
      if (!driverStatus || !driverStatus.is_online) return;
      try {
        await DB.update('driver_status', driverStatus.id, {
          lat: fix.lat, lng: fix.lng,
          heading: fix.heading || 0,
          speed_kmh: fix.speed ? Math.round(fix.speed * 3.6) : 0,
          accuracy: fix.accuracy,
          last_ping_at: Date.now(),
          updated_at: Date.now()
        });
        driverStatus.lat = fix.lat; driverStatus.lng = fix.lng;
      } catch (e) { /* offline — queue handles it */ }
    };
    PothikGeo.startWatch(send, function (err) {
      if (err && err.code === 1) UI.toast(t('home.gpsDenied'), 'error');
    });
    pingTimer = setInterval(function () {
      const f = PothikGeo.lastFix;
      if (f) send(f);
    }, PING_MS);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    PothikGeo.stopWatch();
  }

  /* -------------------------------------------------- offer polling */
  function startOfferPolling() {
    if (offerTimer) return;
    pollOffer();
    offerTimer = setInterval(pollOffer, OFFER_POLL_MS);
  }

  function stopOfferPolling() {
    if (offerTimer) { clearInterval(offerTimer); offerTimer = null; }
  }

  /**
   * Look for a ride that is SEARCHING_DRIVER, close to us, and matches our
   * vehicle type. Mirrors the passenger-side matching engine.
   */
  async function pollOffer() {
    if (!driverStatus || !driverStatus.is_online || driverStatus.active_ride_id) return;
    if (router.currentScreen === 'incoming' || router.currentScreen === 'navigate') return;

    let rides = [];
    try { rides = await DB.list('rides', { limit: 200 }); } catch (e) { return; }

    const me = { lat: Number(driverStatus.lat), lng: Number(driverStatus.lng) };
    if (!isFinite(me.lat) || !isFinite(me.lng)) return;

    const myType = driverStatus.vehicle_type || 'car';
    const radius = Number(Settings.get('driverAcceptRadiusKm')) || 9;

    const candidates = rides.filter(function (r) {
      if (r.status !== 'SEARCHING_DRIVER') return false;
      if (r.driver_id) return false;
      if (r.vehicle_type && r.vehicle_type !== myType) return false;
      const p = { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) };
      if (!isFinite(p.lat) || !isFinite(p.lng)) return false;
      return PothikGeo.haversineKm(me, p) <= radius;
    }).sort(function (a, b) {
      return PothikGeo.haversineKm(me, { lat: Number(a.pickup_lat), lng: Number(a.pickup_lng) }) -
             PothikGeo.haversineKm(me, { lat: Number(b.pickup_lat), lng: Number(b.pickup_lng) });
    });

    if (!candidates.length) return;
    const ride = candidates[0];
    const distKm = PothikGeo.haversineKm(me, { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) });

    currentOffer = { ride: ride, distKm: distKm, etaMin: Math.max(2, Math.round((distKm / 20) * 60)) };

    // In-app + push alert
    await Notify.send(Notify.Ride.newRequest(user.id, ride.pickup_label, ride.fare_total, ride.id));
    if (Settings.get('soundEnabled')) beep();

    router.go('incoming');
  }

  /** Short alert tone using the Web Audio API (no asset needed). */
  function beep() {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [0, 0.22].forEach(function (delay) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 880;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.18);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.2);
      });
      setTimeout(function () { ctx.close(); }, 900);
    } catch (e) { /* audio blocked until interaction */ }
  }

  /* ========================== INCOMING OFFER ============================= */
  function renderIncoming() {
    if (!currentOffer) { router.go('home'); return; }
    const r = currentOffer.ride;
    const o = currentOffer;

    $('offer-vehicle').innerHTML = '<i class="fa-solid ' + vehicleIcon(r.vehicle_type) + '"></i>';
    $('offer-fare').textContent = money(r.fare_total);
    $('offer-distance').textContent = PothikGeo.distance(r.distance_km);
    $('offer-duration').textContent = PothikGeo.duration(r.duration_min);
    $('offer-pickup').textContent = r.pickup_label;
    $('offer-dropoff').textContent = r.dropoff_label;
    $('offer-my-distance').textContent = PothikGeo.distance(o.distKm);
    $('offer-my-eta').textContent = PothikGeo.duration(o.etaMin);
    $('offer-earning').textContent = money(r.driver_earning);

    // Countdown
    if (offerTimer) clearInterval(offerTimer);
    let left = Number(Settings.get('requestTimeoutSec')) || 20;
    const bar = $('offer-bar');
    const label = $('offer-countdown');
    const start = left;
    if (bar) bar.style.width = '100%';
    if (label) label.textContent = left + 's';
    offerTimer = setInterval(function () {
      left--;
      if (label) label.textContent = Math.max(0, left) + 's';
      if (bar) bar.style.width = Math.max(0, (left / start) * 100) + '%';
      if (left <= 0) {
        clearInterval(offerTimer); offerTimer = null;
        UI.toast(t('drvHome.expires'), 'warn');
        currentOffer = null;
        router.go('home');
      }
    }, 1000);
  }

  async function acceptOffer() {
    if (!currentOffer) return;
    const rideId = currentOffer.ride.id;
    if (offerTimer) { clearInterval(offerTimer); offerTimer = null; }
    Shell.showLoading(true, t('common.loading'));

    try {
      // Optimistic lock: only wins if the ride is still SEARCHING_DRIVER
      const res = await Matching.claimRide(rideId, driver.id, 'SEARCHING_DRIVER');
      if (!res.ok) {
        Shell.showLoading(false);
        UI.toast(t('err.rideTaken'), 'error');
        currentOffer = null;
        router.go('home');
        return;
      }

      await DB.update('drivers', driver.id, {
        acceptance_rate: Math.min(1, (Number(driver.acceptance_rate) || 0.8) * 1.01)
      });

      activeRide = await DB.get('rides', rideId);
      await Notify.send({
        userId: activeRide.passenger_user_id,
        title: t('ride.found'),
        body: driver.full_name + ' · ' + PothikGeo.distance(currentOffer.distKm),
        type: 'ride', rideId: rideId, push: true
      });
      await Auth.audit(user.id, 'driver', 'RIDE_ACCEPTED', 'rides', rideId, {});

      currentOffer = null;
      startRideWatcher(rideId);
      router.go('navigate');
    } catch (e) {
      Shell.showLoading(false);
      UI.toast(t('err.generic'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  async function rejectOffer() {
    if (!currentOffer) return;
    const rideId = currentOffer.ride.id;
    if (offerTimer) { clearInterval(offerTimer); offerTimer = null; }
    try {
      await DB.update('drivers', driver.id, {
        rejection_count: Number(driver.rejection_count || 0) + 1,
        acceptance_rate: Math.max(0, (Number(driver.acceptance_rate) || 0.8) * 0.99)
      });
      // Push the ride back so the passenger's loop moves to the next driver
      await DB.update('rides', rideId, { matched_driver_attempts: Number(currentOffer.ride.matched_driver_attempts || 0) + 1 });
      await Auth.audit(user.id, 'driver', 'RIDE_REJECTED', 'rides', rideId, {});
    } catch (e) { /* ignore */ }
    currentOffer = null;
    UI.toast(t('drvHome.reject'), 'info');
    router.go('home');
  }

  function vehicleIcon(type) {
    return type === 'bike' ? 'fa-motorcycle' : (type === 'cng' ? 'fa-taxi' : 'fa-car-side');
  }

  /* ========================== NAVIGATE / TRIP ============================ */
  async function resumeActiveRide() {
    try {
      if (!driverStatus || !driverStatus.active_ride_id) {
        const rides = await DB.list('rides', { limit: 200 });
        const mine = rides.filter(function (r) {
          return r.driver_id === driver.id && RideState.isActive(r.status);
        }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
        if (!mine.length) return;
        activeRide = mine[0];
      } else {
        activeRide = await DB.get('rides', driverStatus.active_ride_id);
      }
      if (activeRide && RideState.isActive(activeRide.status)) {
        startRideWatcher(activeRide.id);
        router.go('navigate');
      }
    } catch (e) { /* ignore */ }
  }

  function startRideWatcher(rideId) {
    if (watchTimer) clearInterval(watchTimer);
    const tick = async function () {
      try { activeRide = await DB.get('rides', rideId); } catch (e) { return; }
      if (!activeRide) return;
      if (router.currentScreen === 'navigate') renderNavigate();
      if (RideState.isTerminal(activeRide.status) || activeRide.status === 'PAYMENT_COMPLETED') {
        if (activeRide.status === 'CANCELLED_BY_PASSENGER') {
          UI.toast(t('drvHome.passengerCancelled'), 'warn');
        }
        clearInterval(watchTimer); watchTimer = null;
        activeRide = null;
        if (router.currentScreen === 'navigate') router.go('home');
      }
    };
    tick();
    watchTimer = setInterval(tick, 2500);
  }

  async function renderNavigate() {
    if (!activeRide) { router.go('home'); return; }
    const r = activeRide;

    $('nav-status').innerHTML = UI.statusBadge(r.status);
    $('nav-fare').textContent = money(r.fare_total);
    $('nav-earning').textContent = money(r.driver_earning);

    // Passenger info
    let pax = null;
    try { pax = await DB.get('users', r.passenger_user_id); } catch (e) {}
    $('nav-pax-avatar').innerHTML = UI.avatarHtml(pax ? pax.full_name : '?', pax ? pax.photo_url : '');
    $('nav-pax-name').textContent = pax ? pax.full_name : '—';
    $('nav-pax-phone').textContent = pax ? '+880 ' + PothikGeo.formatBdPhone(pax.phone) : '';

    // Route rows
    const target = r.status === 'RIDE_STARTED'
      ? { lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng), label: r.dropoff_label, kind: 'dropoff' }
      : { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng), label: r.pickup_label, kind: 'pickup' };
    $('nav-target-label').textContent = target.label;
    $('nav-target-kind').textContent = target.kind === 'pickup' ? t('ride.pickupPoint') : t('ride.dropoffPoint');

    const me = PothikGeo.lastFix || (driverStatus && driverStatus.lat ? { lat: Number(driverStatus.lat), lng: Number(driverStatus.lng) } : null);
    if (me) {
      const km = PothikGeo.haversineKm(me, target);
      $('nav-distance').textContent = PothikGeo.distance(km);
      $('nav-eta').textContent = PothikGeo.duration((km / 22) * 60);
    }

    // Button states per status
    const arrived = $('nav-arrived'), start = $('nav-start'), end = $('nav-end'), cancel = $('nav-cancel');
    arrived.classList.toggle('hidden', !(r.status === 'DRIVER_ASSIGNED' || r.status === 'DRIVER_ARRIVING'));
    start.classList.toggle('hidden', r.status !== 'DRIVER_ARRIVED');
    end.classList.toggle('hidden', r.status !== 'RIDE_STARTED');
    cancel.classList.toggle('hidden', r.status === 'RIDE_STARTED');

    // Cash collection reminder
    const cashBox = $('nav-cash');
    if (cashBox) {
      cashBox.classList.toggle('hidden', !(r.status === 'RIDE_STARTED' && r.payment_method === 'cash'));
      if (r.status === 'RIDE_STARTED' && r.payment_method === 'cash') {
        $('nav-cash-amount').textContent = money(r.fare_total);
      }
    }

    drawNavMap(r, target, me);
  }

  function drawNavMap(r, target, me) {
    if (!maps.nav) maps.nav = PothikMap.create('map-nav', { center: target, zoom: 15 });
    maps.nav.invalidate();
    maps.nav.setDropoff({ lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng) }, r.dropoff_label);
    if (r.status !== 'RIDE_STARTED') {
      maps.nav.setPickup({ lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) }, r.pickup_label);
    }
    if (me) {
      maps.nav.setSelf(me);
      PothikGeo.route(me, target).then(function (route) {
        if (route && route.polyline) maps.nav.drawRoute(route.polyline, '#12A87A');
        maps.nav.fitPoints([me, target], [70, 150]);
      });
    }
  }

  async function markArrived() {
    if (!activeRide) return;
    try {
      const to = activeRide.status === 'DRIVER_ASSIGNED' ? 'DRIVER_ARRIVING' : 'DRIVER_ARRIVED';
      let ride = activeRide;
      if (to === 'DRIVER_ARRIVED' && ride.status === 'DRIVER_ASSIGNED') {
        ride = await applyTransition(ride, 'DRIVER_ARRIVING');
      }
      await applyTransition(ride, 'DRIVER_ARRIVED');
      UI.toast(t('ride.driverArrived'), 'success');
    } catch (e) {
      UI.toast(t('err.invalidTransition'), 'error');
    }
  }

  async function applyTransition(ride, to, meta) {
    const patch = RideState.transition(ride, to, meta);
    await DB.update('rides', ride.id, patch);
    activeRide = Object.assign({}, ride, patch);
    if (router.currentScreen === 'navigate') renderNavigate();
    return activeRide;
  }

  function openPinModal() {
    const body = document.createElement('div');
    body.innerHTML = '<p style="margin:0 0 12px;color:var(--muted);font-size:13px">' + esc(t('drvHome.enterPin')) + '</p>' +
      '<div class="otp-row" id="pin-row">' +
      [1, 2, 3, 4].map(function (i) { return '<input type="text" inputmode="numeric" maxlength="1" aria-label="digit ' + i + '">'; }).join('') +
      '</div><p class="center mt-3" id="pin-err" style="color:var(--danger-500);font-size:13px;font-weight:600"></p>';

    const m = UI.modal({
      title: t('ride.otp'),
      content: body,
      actions: [
        { label: t('common.cancel'), class: 'btn-ghost' },
        { label: t('drvHome.startRide'), class: 'btn-primary', onClick: function () { tryStart(); } }
      ]
    });

    const inputs = body.querySelectorAll('#pin-row input');
    inputs.forEach(function (inp, i) {
      inp.addEventListener('input', function () {
        inp.value = inp.value.replace(/\D/g, '');
        if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
        if (Array.prototype.map.call(inputs, function (x) { return x.value; }).join('').length === 4) tryStart();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
      });
    });
    setTimeout(function () { if (inputs[0]) inputs[0].focus(); }, 220);

    function tryStart() {
      const entered = Array.prototype.map.call(inputs, function (x) { return x.value; }).join('');
      if (entered.length !== 4) return;
      if (String(activeRide.start_otp) !== String(entered)) {
        const err = body.querySelector('#pin-err');
        if (err) err.textContent = t('drvHome.pinWrong');
        inputs.forEach(function (x) { x.value = ''; });
        if (inputs[0]) inputs[0].focus();
        return;
      }
      m.close();
      startRide();
    }
  }

  async function startRide() {
    if (!activeRide) return;
    try {
      await applyTransition(activeRide, 'RIDE_STARTED');
      await Notify.send({
        userId: activeRide.passenger_user_id,
        title: t('ride.started'),
        body: t('ride.trackLive'),
        type: 'ride', rideId: activeRide.id, push: true
      });
      UI.toast(t('ride.started') + ' ✓', 'success');
      renderNavigate();
    } catch (e) {
      UI.toast(t('err.invalidTransition'), 'error');
    }
  }

  async function endRide() {
    if (!activeRide) return;
    const ok = await UI.confirm({
      title: t('drvHome.endRide'),
      message: t('drvHome.endRide') + '?',
      confirmLabel: t('drvHome.endRide')
    });
    if (!ok) return;

    Shell.showLoading(true, t('common.loading'));
    try {
      // Recompute the fare from the actual trip, keeping the platform's rates
      const actualKm = Number(activeRide.distance_km) || 0;
      const actualMin = Number(activeRide.actual_minutes) || Number(activeRide.duration_min) || 0;
      const q = Fare.quote({
        km: actualKm, minutes: actualMin,
        vehicleType: activeRide.vehicle_type,
        surge: Number(activeRide.surge) || 1,
        discount: Number(activeRide.discount) || 0
      });

      const patch = RideState.transition(activeRide, 'RIDE_COMPLETED', {
        actual_km: Fare.roundTo(actualKm, 2),
        actual_minutes: Math.round(actualMin)
      });
      patch.fare_total = q.total;
      patch.base_fare = q.baseFare;
      patch.distance_charge = q.distanceCharge;
      patch.time_charge = q.timeCharge;
      patch.commission_pct = q.commissionPct;
      patch.commission_amount = q.commission;
      patch.driver_earning = q.driverEarning;
      await DB.update('rides', activeRide.id, patch);
      activeRide = Object.assign({}, activeRide, patch);

      await Notify.send({
        userId: activeRide.passenger_user_id,
        title: t('ride.completed'),
        body: t('ride.fare') + ' ' + money(q.total),
        type: 'payment', rideId: activeRide.id, push: true
      });

      await Auth.audit(user.id, 'driver', 'RIDE_COMPLETED', 'rides', activeRide.id, { fare: q.total });

      UI.modal({
        title: t('ride.completed'),
        bodyHtml: '<div class="center mb-4"><span class="kpi-icon" style="width:70px;height:70px;font-size:30px;margin:0 auto 12px;background:rgba(18,161,80,.14);color:var(--success-500)"><i class="fa-solid fa-circle-check"></i></span>' +
          '<div style="font-size:30px;font-weight:800">' + money(q.driverEarning) + '</div>' +
          '<p style="color:var(--muted);font-size:13px;margin:0">' + esc(t('earn.net')) + '</p></div>' +
          '<ul class="list">' +
          '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(t('earn.gross')) + '</span></span><strong>' + money(q.total) + '</strong></li>' +
          '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(t('earn.commission')) + ' (' + q.commissionPct + '%)</span></span><strong style="color:var(--danger-500)">-' + money(q.commission) + '</strong></li>' +
          '</ul>',
        actions: [{ label: t('common.ok'), class: 'btn-primary', onClick: function (c) { c(); activeRide = null; router.go('home'); } }]
      });
    } catch (e) {
      UI.toast(t('err.saveFailed'), 'error');
    } finally {
      Shell.showLoading(false);
    }
  }

  async function cancelByDriver() {
    if (!activeRide) return;
    const ok = await UI.confirm({
      title: t('ride.cancel'),
      message: t('ride.cancelConfirm'),
      detail: I18n.getLang() === 'bn' ? 'বারবার বাতিল করলে আপনার অ্যাকাউন্ট পর্যালোচনা করা হতে পারে।' : 'Repeated cancellations may put your account under review.',
      confirmLabel: t('ride.cancel'),
      danger: true
    });
    if (!ok) return;

    try {
      const patch = RideState.transition(activeRide, 'CANCELLED_BY_DRIVER', {
        cancel_reason: 'driver_cancelled', cancelled_by: 'driver'
      });
      await DB.update('rides', activeRide.id, patch);
      await DB.create('cancellations', {
        id: DB.uid('can'), ride_id: activeRide.id, ride_code: activeRide.ride_code,
        cancelled_by: 'driver', actor_user_id: user.id,
        reason_code: 'driver_cancelled', reason_text: 'Cancelled by driver',
        fee_charged: 0, fee_waived: true,
        status_at_cancel: activeRide.status, counts_toward_limit: true,
        created_at: Date.now()
      });
      await DB.update('drivers', driver.id, {
        cancelled_rides: Number(driver.cancelled_rides || 0) + 1
      });
      await Matching.releaseDriver(driver.id);
      await Notify.send({
        userId: activeRide.passenger_user_id,
        title: t('ride.driverCancelled'),
        body: '',
        type: 'alert', rideId: activeRide.id, push: true
      });
      await Auth.audit(user.id, 'driver', 'RIDE_CANCELLED', 'rides', activeRide.id, { by: 'driver' });

      activeRide = null;
      UI.toast(t('ride.cancelled'), 'info');
      router.go('home');
    } catch (e) {
      UI.toast(t('err.invalidTransition'), 'error');
    }
  }

  async function callPassenger() {
    if (!activeRide) return;
    try {
      const pax = await DB.get('users', activeRide.passenger_user_id);
      location.href = 'tel:' + PothikGeo.toE164(pax.phone);
    } catch (e) { /* ignore */ }
  }

  /* ============================ ONBOARDING =============================== */
  const OB_STEPS = ['personal', 'nid', 'licence', 'vehicle', 'review'];
  let obStep = 0;
  const obData = { nidFront: '', nidBack: '', licenceUrl: '', vehiclePhoto: '', profilePhoto: '' };

  function renderOnboarding() {
    obStep = Math.max(0, Math.min(OB_STEPS.length - 1, obStep));
    const step = OB_STEPS[obStep];
    OB_STEPS.forEach(function (s) {
      const el = $('ob-step-' + s);
      if (el) el.classList.toggle('hidden', s !== step);
    });

    $('ob-progress').style.width = Math.round(((obStep + 1) / OB_STEPS.length) * 100) + '%';
    $('ob-step-label').textContent = t('drv.step') + ' ' + (obStep + 1) + '/' + OB_STEPS.length;
    $('ob-back').classList.toggle('hidden', obStep === 0);
    $('ob-next').classList.toggle('hidden', obStep === OB_STEPS.length - 1);
    $('ob-submit').classList.toggle('hidden', obStep !== OB_STEPS.length - 1);

    // Prefill from existing driver data
    if (driver) {
      $('ob-name').value = $('ob-name').value || driver.full_name || '';
      $('ob-phone').value = $('ob-phone').value || driver.phone || '';
      $('ob-nid').value = $('ob-nid').value || driver.nid_number || '';
      $('ob-licence').value = $('ob-licence').value || driver.licence_number || '';
    }
    if (obStep === 4) renderObReview();

    // Wire uploads once per render
    wireDoc('nidFront', 'ob-nid-front');
    wireDoc('nidBack', 'ob-nid-back');
    wireDoc('licenceUrl', 'ob-licence-img');
    wireDoc('vehiclePhoto', 'ob-vehicle-img');
    wireDoc('profilePhoto', 'ob-photo');
    prefillVehicleType();
  }

  function wireDoc(key, zoneId) {
    const zone = $(zoneId);
    if (!zone || zone.dataset.wired) {
      if (zone && obData[key]) markUploaded(zone, obData[key]);
      return;
    }
    const input = zone.querySelector('input[type=file]');
    if (!input) return;
    zone.dataset.wired = '1';
    UI.wireUpload(zone, input, function (res) {
      obData[key] = res.dataUrl;
      markUploaded(zone, res.dataUrl);
    });
    if (obData[key]) markUploaded(zone, obData[key]);
  }

  function markUploaded(zone, dataUrl) {
    zone.style.borderStyle = 'solid';
    zone.style.borderColor = 'var(--success-500)';
    let img = zone.querySelector('img.doc-preview');
    if (!img) {
      img = document.createElement('img');
      img.className = 'doc-preview';
      img.alt = 'uploaded';
      zone.insertBefore(img, zone.firstChild);
    }
    img.src = dataUrl;
    let note = zone.querySelector('.doc-ok');
    if (!note) {
      note = document.createElement('p');
      note.className = 'doc-ok';
      note.style.cssText = 'margin:8px 0 0;font-size:12px;font-weight:700;color:var(--success-500)';
      note.innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + esc(t('drv.uploaded'));
      zone.appendChild(note);
    }
    const hint = zone.querySelector('.doc-hint');
    if (hint) hint.style.display = 'none';
  }

  async function prefillVehicleType() {
    try {
      const v = await DB.findWhere('vehicles', function (x) { return x.driver_id === driver.id; });
      if (v) {
        $('ob-vehicle-type').value = v.vehicle_type || 'bike';
        $('ob-vehicle-reg').value = $('ob-vehicle-reg').value || v.registration_number || '';
        $('ob-vehicle-model').value = $('ob-vehicle-model').value || v.model || '';
        $('ob-vehicle-year').value = $('ob-vehicle-year').value || v.year || '';
      }
    } catch (e) { /* ignore */ }
  }

  function onboardingNext() {
    if (!validateObStep(OB_STEPS[obStep])) return;
    if (obStep < OB_STEPS.length - 1) { obStep++; renderOnboarding(); }
  }

  function onboardingBack() {
    if (obStep > 0) { obStep--; renderOnboarding(); }
    else router.go('status');
  }

  function validateObStep(step) {
    if (step === 'personal') {
      const name = $('ob-name').value.trim();
      const phone = $('ob-phone').value.trim();
      if (!name) { UI.toast(t('auth.nameRequired'), 'warn'); return false; }
      if (!PothikGeo.isValidBdPhone(phone)) { UI.toast(t('auth.invalidPhone'), 'warn'); return false; }
      return true;
    }
    if (step === 'nid') {
      const nid = $('ob-nid').value.trim();
      if (!/^\d{10}$|^\d{13}$|^\d{17}$/.test(nid)) {
        UI.toast(I18n.getLang() === 'bn' ? 'সঠিক ১০/১৩/১৭ ডিজিটের এনআইডি নম্বর দিন' : 'Enter a valid 10/13/17-digit NID number', 'warn');
        return false;
      }
      if (!obData.nidFront || !obData.nidBack) { UI.toast(t('drv.needDocs'), 'warn'); return false; }
      return true;
    }
    if (step === 'licence') {
      const lic = $('ob-licence').value.trim();
      if (!lic) { UI.toast(I18n.getLang() === 'bn' ? 'লাইসেন্স নম্বর দিন' : 'Enter your licence number', 'warn'); return false; }
      if (!obData.licenceUrl) { UI.toast(t('drv.needDocs'), 'warn'); return false; }
      return true;
    }
    if (step === 'vehicle') {
      const reg = $('ob-vehicle-reg').value.trim();
      const model = $('ob-vehicle-model').value.trim();
      if (!reg) { UI.toast(I18n.getLang() === 'bn' ? 'নিবন্ধন নম্বর দিন' : 'Enter the registration number', 'warn'); return false; }
      if (!model) { UI.toast(I18n.getLang() === 'bn' ? 'গাড়ির মডেল দিন' : 'Enter the vehicle model', 'warn'); return false; }
      return true;
    }
    return true;
  }

  function renderObReview() {
    const rows = [
      [t('drv.personal'), $('ob-name').value],
      [t('common.phone'), '+880 ' + PothikGeo.formatBdPhone($('ob-phone').value)],
      [t('drv.nidNumber'), $('ob-nid').value],
      [t('drv.licenceNumber'), $('ob-licence').value],
      [t('drv.vehicleType'), t('veh.' + $('ob-vehicle-type').value)],
      [t('drv.vehicleReg'), $('ob-vehicle-reg').value],
      [t('drv.vehicleModel'), $('ob-vehicle-model').value + ' ' + $('ob-vehicle-year').value]
    ];
    $('ob-review').innerHTML = rows.map(function (r) {
      return '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(r[0]) + '</span></span><strong>' + esc(r[1] || '—') + '</strong></li>';
    }).join('');

    $('ob-doc-previews').innerHTML = [
      { k: 'nidFront', l: t('drv.nidFront') },
      { k: 'nidBack', l: t('drv.nidBack') },
      { k: 'licenceUrl', l: t('drv.licenceImage') },
      { k: 'vehiclePhoto', l: t('drv.vehicleImage') },
      { k: 'profilePhoto', l: t('drv.profilePhoto') }
    ].map(function (d) {
      const url = obData[d.k] || '';
      return '<div style="text-align:center"><div style="font-size:11px;color:var(--muted);margin-bottom:4px">' + esc(d.l) + '</div>' +
        (url ? '<img class="doc-preview" src="' + url + '" alt="' + esc(d.l) + '">' : '<div class="doc-preview" style="display:grid;place-items:center;color:var(--muted-2)"><i class="fa-solid fa-image"></i></div>') +
        '</div>';
    }).join('');
  }

  async function submitApplication() {
    Shell.showLoading(true, t('common.loading'));
    try {
      const name = $('ob-name').value.trim();
      const phone = PothikGeo.normalizePhone($('ob-phone').value);
      const nid = $('ob-nid').value.trim();
      const licence = $('ob-licence').value.trim();
      const vType = $('ob-vehicle-type').value;
      const vReg = $('ob-vehicle-reg').value.trim();
      const vModel = $('ob-vehicle-model').value.trim();
      const vYear = Number($('ob-vehicle-year').value) || new Date().getFullYear() - 3;

      // 1. Update the driver record + reset to pending
      await DB.update('drivers', driver.id, {
        full_name: name, phone: phone,
        nid_number: nid,
        nid_front_url: obData.nidFront || '',
        nid_back_url: obData.nidBack || '',
        licence_number: licence,
        licence_url: obData.licenceUrl || '',
        photo_url: obData.profilePhoto || driver.photo_url || '',
        status: 'pending',
        rejection_reason: '',
        submitted_at: Date.now()
      });

      // 2. Update the user record
      await DB.update('users', user.id, {
        full_name: name, phone: phone, phone_e164: PothikGeo.toE164(phone),
        photo_url: obData.profilePhoto || user.photo_url || ''
      });

      // 3. Vehicle upsert
      let vehicle = await DB.findWhere('vehicles', function (v) { return v.driver_id === driver.id; });
      const vPayload = {
        driver_id: driver.id, vehicle_type: vType,
        registration_number: vReg,
        make: vModel.split(' ')[0] || '', model: vModel, year: vYear,
        seats: vType === 'bike' ? 1 : (vType === 'cng' ? 3 : 4),
        photo_url: obData.vehiclePhoto || (vehicle ? vehicle.photo_url : ''),
        status: 'pending', verified_by: '', verified_at: 0
      };
      if (vehicle) await DB.update('vehicles', vehicle.id, vPayload);
      else vehicle = await DB.create('vehicles', Object.assign({ id: DB.uid('veh') }, vPayload));

      // 4. Documents
      const docSpecs = [
        { type: 'nid_front', url: obData.nidFront },
        { type: 'nid_back', url: obData.nidBack },
        { type: 'licence', url: obData.licenceUrl },
        { type: 'vehicle_photo', url: obData.vehiclePhoto },
        { type: 'profile_photo', url: obData.profilePhoto }
      ];
      for (const spec of docSpecs) {
        if (!spec.url) continue;
        const existing = await DB.findWhere('driver_documents', function (d) {
          return d.driver_id === driver.id && d.doc_type === spec.type;
        });
        const payload = {
          driver_id: driver.id, doc_type: spec.type,
          file_url: spec.url, file_name: spec.type + '.jpg',
          status: 'pending', review_note: '', reviewed_by: '', reviewed_at: 0,
          uploaded_at: Date.now()
        };
        if (existing) await DB.update('driver_documents', existing.id, payload);
        else await DB.create('driver_documents', Object.assign({ id: DB.uid('doc') }, payload));
      }

      // 5. Driver status row vehicle type
      await refreshDriver();
      if (driverStatus) {
        await DB.update('driver_status', driverStatus.id, { vehicle_type: vType, vehicle_id: vehicle.id });
      }

      await Auth.audit(user.id, 'driver', 'DRIVER_APPLICATION_SUBMITTED', 'drivers', driver.id, { vehicleType: vType });

      // 6. Tell the admins
      await Notify.broadcastToRole('admin',
        I18n.getLang() === 'bn' ? 'নতুন চালক আবেদন' : 'New driver application',
        name + ' · ' + t('veh.' + vType), 'system');

      await refreshDriver();
      Shell.showLoading(false);
      UI.modal({
        title: t('drv.appSubmitted'),
        bodyHtml: '<div class="center"><span class="kpi-icon" style="width:70px;height:70px;font-size:30px;margin:0 auto 14px;background:var(--brand-50);color:var(--brand-600)"><i class="fa-solid fa-file-shield"></i></span>' +
          '<p style="color:var(--muted)">' + esc(t('drv.appSubmittedSub')) + '</p></div>',
        actions: [{ label: t('common.ok'), class: 'btn-primary', onClick: function (c) { c(); router.go('status'); } }]
      });
    } catch (e) {
      Shell.showLoading(false);
      UI.toast(t('err.saveFailed'), 'error');
    }
  }

  /* ========================== STATUS SCREEN ============================== */
  function renderStatus() {
    if (!driver) return;
    const st = driver.status || 'pending';
    const meta = {
      pending: { icon: 'fa-hourglass-half', color: 'var(--warn-500)', bg: 'rgba(245,165,36,.14)' },
      approved: { icon: 'fa-circle-check', color: 'var(--success-500)', bg: 'rgba(18,161,80,.14)' },
      rejected: { icon: 'fa-circle-xmark', color: 'var(--danger-500)', bg: 'rgba(229,72,77,.14)' },
      suspended: { icon: 'fa-circle-pause', color: 'var(--warn-500)', bg: 'rgba(245,165,36,.14)' },
      blocked: { icon: 'fa-ban', color: 'var(--danger-500)', bg: 'rgba(229,72,77,.14)' }
    }[st] || { icon: 'fa-circle-info', color: 'var(--muted)', bg: 'var(--surface-2)' };

    $('status-icon').className = 'fa-solid ' + meta.icon;
    $('status-icon').style.color = meta.color;
    $('status-icon-wrap').style.background = meta.bg;
    $('status-title').textContent = t('drv.status.' + st);
    $('status-desc').textContent = t('drv.status.' + st + '.desc');
    $('status-badge').innerHTML = UI.statusBadge(st);

    const reasonBox = $('status-reason');
    if (driver.rejection_reason) {
      reasonBox.classList.remove('hidden');
      $('status-reason-text').textContent = driver.rejection_reason;
    } else {
      reasonBox.classList.add('hidden');
    }

    $('status-resubmit').classList.toggle('hidden', !(st === 'rejected' || st === 'pending'));
    $('status-go-home').classList.toggle('hidden', st !== 'approved');

    // Timeline
    const items = [
      { label: t('drv.appSubmitted'), ts: driver.submitted_at, done: !!driver.submitted_at },
      { label: t('drv.status.pending'), ts: driver.submitted_at, done: true },
      { label: t('drv.status.approved'), ts: driver.verified_at, done: st === 'approved' }
    ];
    $('status-timeline').innerHTML = items.map(function (i) {
      return '<li class="list-item"><span class="dot ' + (i.done ? 'dot-live' : '') + '" style="' + (i.done ? '' : 'background:var(--line)') + '"></span>' +
        '<span class="li-main"><span class="li-title" style="font-weight:500;color:' + (i.done ? 'var(--ink)' : 'var(--muted)') + '">' + esc(i.label) + '</span>' +
        (i.ts ? '<span class="li-sub">' + esc(PothikGeo.dateTime(i.ts)) + '</span>' : '') + '</span>' +
        (i.done ? '<i class="fa-solid fa-check" style="color:var(--success-500)"></i>' : '') + '</li>';
    }).join('');

    // Document list
    DB.list('driver_documents', { limit: 100 }).then(function (docs) {
      const mine = docs.filter(function (d) { return d.driver_id === driver.id; });
      $('status-docs').innerHTML = mine.length ? mine.map(function (d) {
        return '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-file-image"></i></span>' +
          '<span class="li-main"><span class="li-title" style="font-weight:500">' + esc(t('drv.' + docLabelKey(d.doc_type))) + '</span>' +
          '<span class="li-sub">' + esc(d.file_name || '') + '</span></span>' + UI.statusBadge(d.status) + '</li>';
      }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>';
    }).catch(function () {});
  }

  function docLabelKey(type) {
    const map = {
      nid_front: 'nidFront', nid_back: 'nidBack', licence: 'licenceImage',
      vehicle_photo: 'vehicleImage', vehicle_registration: 'vehicleReg',
      profile_photo: 'profilePhoto', fitness: 'vehicleImage', insurance: 'vehicleImage', tax_token: 'vehicleReg'
    };
    return map[type] || 'vehicleImage';
  }

  /* ============================= EARNINGS ================================ */
  async function renderEarnings(period) {
    const stats = await computeDriverStats();
    const nowTs = Date.now();
    const spans = { daily: 1, weekly: 7, monthly: 30 };
    const days = spans[period] || 1;
    const since = nowTs - days * 86400000;

    const coms = stats.allComs.filter(function (c) { return Number(c.created_at) >= since; });
    const gross = coms.reduce(function (a, c) { return a + Number(c.gross_fare || 0); }, 0);
    const commission = coms.reduce(function (a, c) { return a + Number(c.commission_amount || 0); }, 0);
    const net = coms.reduce(function (a, c) { return a + Number(c.net_earning || 0); }, 0);

    $('earn-gross').textContent = money(gross);
    $('earn-commission').textContent = money(commission);
    $('earn-net').textContent = money(net);
    $('earn-trips').textContent = coms.length;
    $('earn-avg').textContent = money(coms.length ? gross / coms.length : 0);
    $('earn-cash').textContent = money(coms.filter(function (c) { return c.payment_method === 'cash'; })
      .reduce(function (a, c) { return a + Number(c.gross_fare || 0); }, 0));

    // Ring chart
    const pct = gross > 0 ? net / gross : 0;
    const circumference = 2 * Math.PI * 62;
    $('earn-ring').setAttribute('stroke-dasharray', (circumference * pct) + ' ' + circumference);
    $('earn-ring-pct').textContent = Math.round(pct * 100) + '%';

    // Bar chart by day
    const buckets = {};
    const nBuckets = period === 'monthly' ? 30 : (period === 'weekly' ? 7 : 6);
    for (let i = nBuckets - 1; i >= 0; i--) {
      const d = new Date(nowTs - i * 86400000);
      buckets[d.toISOString().slice(0, 10)] = 0;
    }
    coms.forEach(function (c) {
      const k = c.period_date || new Date(Number(c.created_at)).toISOString().slice(0, 10);
      if (k in buckets) buckets[k] += Number(c.net_earning || 0);
    });
    const keys = Object.keys(buckets);
    const max = Math.max.apply(null, keys.map(function (k) { return buckets[k]; }).concat([1]));
    $('earn-bars').innerHTML = keys.map(function (k) {
      const v = buckets[k];
      const h = Math.max(3, (v / max) * 100);
      const isPeak = v === max && v > 0;
      const label = period === 'monthly'
        ? new Date(k).getDate()
        : ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(k).getDay()];
      return '<div class="bar-col" title="' + esc(money(v)) + '">' +
        '<div class="bar-fill ' + (isPeak ? 'peak' : '') + '" style="height:' + h + '%"></div>' +
        '<span class="bar-lbl">' + esc(String(label)) + '</span></div>';
    }).join('');

    // Recent payouts list
    const recent = coms.slice().sort(function (a, b) { return Number(b.created_at) - Number(a.created_at); }).slice(0, 12);
    $('earn-recent').innerHTML = recent.length ? recent.map(function (c) {
      return '<li class="list-item"><span class="kpi-icon" style="background:rgba(18,161,80,.12);color:var(--success-500)"><i class="fa-solid fa-arrow-down"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(c.ride_code || '') + '</span>' +
        '<span class="li-sub">' + esc(PothikGeo.dateTime(c.created_at)) + ' · ' + esc(t('pay.' + (c.payment_method || 'cash'))) + '</span></span>' +
        '<strong style="color:var(--success-500)">+' + money(c.net_earning) + '</strong></li>';
    }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>';
  }

  /* ============================== HISTORY ================================ */
  async function renderHistory() {
    const host = $('drv-history');
    let rides = [];
    try { rides = await DB.list('rides', { limit: 300 }); } catch (e) { /* offline */ }
    const mine = rides.filter(function (r) { return r.driver_id === driver.id; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    if (!mine.length) { host.innerHTML = UI.emptyState('fa-clock-rotate-left', t('hist.empty')); return; }

    host.innerHTML = mine.slice(0, 60).map(function (r) {
      const done = r.status === 'PAYMENT_COMPLETED' || r.status === 'RIDE_COMPLETED';
      return '<div class="card mb-3">' +
        '<div class="row-between mb-2"><strong>' + esc(r.ride_code || '') + '</strong>' + UI.statusBadge(r.status) + '</div>' +
        '<div style="font-size:13px;color:var(--muted)">' + esc(PothikGeo.dateTime(r.created_at)) + '</div>' +
        '<div class="route-summary mt-3">' +
        '<div class="rs-rail"><span class="rs-dot" style="border-color:var(--brand-500);background:var(--brand-500)"></span>' +
        '<span class="rs-line"></span><span class="rs-dot" style="border-color:var(--accent-500);background:var(--accent-500)"></span></div>' +
        '<div class="grow col gap-2">' +
        '<div style="font-size:13px">' + esc(r.pickup_label) + '</div>' +
        '<div style="font-size:13px">' + esc(r.dropoff_label) + '</div>' +
        '</div></div>' +
        '<div class="row-between mt-3" style="border-top:1px solid var(--border);padding-top:10px">' +
        '<span style="font-size:12px;color:var(--muted)">' + esc(PothikGeo.distance(Number(r.actual_km) || Number(r.distance_km) || 0)) + '</span>' +
        '<strong>' + (done ? money(r.driver_earning) : '—') + '</strong></div>' +
        '</div>';
    }).join('');
  }

  /* ============================== RATINGS ================================ */
  async function renderRatings() {
    let ratings = [];
    try { ratings = await DB.list('ratings', { limit: 400 }); } catch (e) { /* offline */ }
    const mine = ratings.filter(function (r) {
      return r.ratee_role === 'driver' && r.ratee_id === user.id;
    }).sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });

    const avg = mine.length ? mine.reduce(function (a, r) { return a + Number(r.stars); }, 0) / mine.length : (Number(driver.rating) || 5);
    $('drv-avg-rating').textContent = avg.toFixed(2);
    $('drv-total-ratings').textContent = mine.length;
    $('drv-stars-display').innerHTML = UI.starsHtml(avg);

    // Distribution
    const dist = [5, 4, 3, 2, 1].map(function (s) {
      const n = mine.filter(function (r) { return Number(r.stars) === s; }).length;
      const pct = mine.length ? (n / mine.length) * 100 : 0;
      return { stars: s, n: n, pct: pct };
    });
    $('drv-rating-dist').innerHTML = dist.map(function (d) {
      return '<div class="row gap-3 mb-2" style="align-items:center">' +
        '<span style="width:34px;font-size:12px;font-weight:700">' + d.stars + ' <i class="fa-solid fa-star" style="color:var(--gold-500);font-size:10px"></i></span>' +
        '<div class="progress grow"><span style="width:' + d.pct + '%"></span></div>' +
        '<span style="width:30px;text-align:right;font-size:12px;color:var(--muted)">' + d.n + '</span></div>';
    }).join('');

    const withComments = mine.filter(function (r) { return r.comment; }).slice(0, 12);
    $('drv-rating-list').innerHTML = withComments.length ? withComments.map(function (r) {
      return '<div class="card mb-3">' +
        '<div class="row-between"><span>' + UI.starsHtml(r.stars, 'sm') + '</span>' +
        '<span style="font-size:11px;color:var(--muted)">' + esc(PothikGeo.relativeTime(r.created_at)) + '</span></div>' +
        '<p style="margin:8px 0 0;font-size:13px">' + esc(r.comment) + '</p></div>';
    }).join('') : UI.emptyState('fa-comment-slash', t('common.noData'));
  }

  /* =========================== NOTIFICATIONS ============================= */
  async function renderNotifications() {
    const host = $('drv-notif-list');
    let rows = [];
    try { rows = await DB.list('notifications', { limit: 200 }); } catch (e) { /* offline */ }
    const mine = rows.filter(function (r) { return r.user_id === user.id; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    if (!mine.length) { host.innerHTML = UI.emptyState('fa-bell-slash', t('notif.empty')); return; }

    const icons = { ride: 'fa-car-side', payment: 'fa-receipt', promo: 'fa-gift', alert: 'fa-triangle-exclamation', info: 'fa-circle-info', system: 'fa-gear' };
    host.innerHTML = mine.slice(0, 50).map(function (n) {
      return '<div class="card mb-3" style="' + (n.is_read ? '' : 'border-left:3px solid var(--brand-500)') + '">' +
        '<div class="row gap-3"><span class="kpi-icon"><i class="fa-solid ' + (icons[n.type] || 'fa-circle-info') + '"></i></span>' +
        '<div class="grow"><strong style="display:block;font-size:14px">' + esc(n.title) + '</strong>' +
        '<p style="margin:2px 0 0;font-size:13px;color:var(--muted)">' + esc(n.body) + '</p>' +
        '<span style="font-size:11px;color:var(--muted-2)">' + esc(PothikGeo.relativeTime(n.created_at)) + '</span></div></div></div>';
    }).join('');
  }

  /* ============================== SUPPORT ================================ */
  async function renderSupport() {
    $('drv-support-hotline').textContent = Settings.get('supportHotline');
    $('drv-support-email').textContent = Settings.get('supportEmail');
    let rows = [];
    try { rows = await DB.list('support_tickets', { limit: 200 }); } catch (e) { /* offline */ }
    const mine = rows.filter(function (r) { return r.user_id === user.id; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
    $('drv-ticket-list').innerHTML = mine.length ? '<div class="card card-flush"><ul class="list">' + mine.map(function (tk) {
      return '<li class="list-item"><span class="kpi-icon"><i class="fa-solid fa-ticket"></i></span>' +
        '<span class="li-main"><span class="li-title">' + esc(tk.subject) + '</span>' +
        '<span class="li-sub">' + esc(tk.ticket_code || '') + '</span></span>' +
        '<span class="badge ' + (tk.status === 'open' ? 'badge-warn' : 'badge-success') + '">' + esc(tk.status) + '</span></li>';
    }).join('') + '</ul></div>' : UI.emptyState('fa-headset', t('common.noData'));
  }

  async function submitTicket(e) {
    e.preventDefault();
    try {
      await DB.create('support_tickets', {
        id: DB.uid('tkt'), ticket_code: 'SUP-' + Math.floor(10000 + Math.random() * 89999),
        user_id: user.id, user_role: 'driver',
        ride_id: activeRide ? activeRide.id : '',
        category: $('drv-ticket-category').value,
        subject: $('drv-ticket-subject').value.trim(),
        message: $('drv-ticket-message').value.trim(),
        attachment_url: '', priority: 'normal', status: 'open',
        assigned_to: '', resolution: '', reported_user_id: '', created_at: Date.now()
      });
      $('drv-ticket-form').reset();
      UI.toast(t('sup.submitted'), 'success');
      renderSupport();
    } catch (err) { UI.toast(t('err.saveFailed'), 'error'); }
  }

  /* ============================== PROFILE ================================ */
  async function renderProfile() {
    await refreshDriver();
    $('drv-profile-avatar').innerHTML = UI.avatarHtml(driver.full_name, driver.photo_url, 'xl');
    $('drv-profile-name').textContent = driver.full_name;
    $('drv-profile-phone').textContent = '+880 ' + PothikGeo.formatBdPhone(driver.phone);
    $('drv-profile-rating').innerHTML = '<i class="fa-solid fa-star"></i> ' + (Number(driver.rating) || 5).toFixed(2);
    $('drv-profile-status').innerHTML = UI.statusBadge(driver.status);
    $('drv-stat-rides').textContent = driver.completed_rides || 0;
    $('drv-stat-cancels').textContent = driver.cancelled_rides || 0;
    $('drv-stat-acceptance').textContent = Math.round((Number(driver.acceptance_rate) || 1) * 100) + '%';

    $('drv-prof-name').value = driver.full_name || '';
    $('drv-prof-nid').value = driver.nid_number || '';
    $('drv-prof-licence').value = driver.licence_number || '';

    const v = await DB.findWhere('vehicles', function (x) { return x.driver_id === driver.id; }).catch(function () { return null; });
    $('drv-vehicle-info').innerHTML = v ? [
      [t('drv.vehicleType'), t('veh.' + v.vehicle_type)],
      [t('drv.vehicleReg'), v.registration_number],
      [t('drv.vehicleModel'), v.model],
      [t('drv.vehicleYear'), v.year],
      [t('common.status'), t('drv.status.' + v.status)]
    ].map(function (r) {
      return '<li class="list-item"><span class="li-main"><span class="li-title" style="font-weight:500">' + esc(r[0]) + '</span></span><strong>' + esc(r[1] || '—') + '</strong></li>';
    }).join('') : '<li class="list-item"><span class="li-sub">' + esc(t('common.noData')) + '</span></li>';
  }

  async function saveProfile(e) {
    e.preventDefault();
    try {
      await DB.update('drivers', driver.id, {
        full_name: $('drv-prof-name').value.trim(),
        nid_number: $('drv-prof-nid').value.trim(),
        licence_number: $('drv-prof-licence').value.trim()
      });
      await DB.update('users', user.id, { full_name: $('drv-prof-name').value.trim() });
      await refreshDriver();
      UI.toast(t('common.saved'), 'success');
      renderProfile();
    } catch (err) { UI.toast(t('err.saveFailed'), 'error'); }
  }

  /* ============================= SETTINGS ================================ */
  function renderSettings() {
    const lang = I18n.getLang();
    $('drv-set-lang').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.lang === lang ? 'true' : 'false');
    });
    $('drv-set-sound').checked = !!Settings.get('soundEnabled');
    $('drv-set-keepawake').checked = !!Settings.get('keepAwake');
    $('drv-set-queue').textContent = DB.queueLength + (I18n.getLang() === 'bn' ? ' বাকি' : ' pending');
    $('drv-set-version').textContent = '1.0.0';
  }

  /* ------------------------------------------------------- wake lock */
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) { /* denied */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
})(window);
