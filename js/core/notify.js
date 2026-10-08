/* ==========================================================================
   Pothik — Notifications
   --------------------------------------------------------------------------
   Two real channels:
     1. In-app notification centre  -> rows in the `notifications` table,
        delivered live to open tabs via BroadcastChannel + storage events.
     2. Web Push (VAPID)            -> service-worker push, real browser push
        notifications. Requires a VAPID public key in Settings (see
        docs/API-KEYS.md). Gracefully degrades to in-app only.

   To wire Firebase Cloud Messaging instead, see docs/API-KEYS.md —
   `Notify.pushProvider` is the single integration seam.
   ========================================================================== */
(function (global) {
  'use strict';

  const CHANNEL = 'pothik-notify';
  const SEEN_KEY = 'notify.seen';

  let channel = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch (e) { channel = null; }

  const listeners = new Set();

  /* ------------------------------------------------------- in-app delivery */
  function emit(payload) {
    listeners.forEach(function (fn) { try { fn(payload); } catch (e) {} });
    if (channel) { try { channel.postMessage(payload); } catch (e) {} }
    global.dispatchEvent(new CustomEvent('pothik:notify', { detail: payload }));
  }

  function onMessage(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  if (channel) {
    channel.onmessage = function (ev) {
      listeners.forEach(function (fn) { try { fn(ev.data); } catch (e) {} });
    };
  }

  /* --------------------------------------------------------- persistence */
  /**
   * Create + deliver a notification.
   * @param p { userId, title, body, type, rideId, audience, channel }
   */
  async function send(p) {
    const nowTs = Date.now();
    const row = {
      id: global.DB.uid('ntf'),
      user_id: p.userId || '',
      audience: p.audience || 'user',      // user | role | all
      role: p.role || '',
      title: p.title || '',
      body: p.body || '',
      type: p.type || 'info',              // info | ride | payment | promo | alert
      ride_id: p.rideId || '',
      channel: p.channel || 'inapp',       // inapp | push
      is_read: false,
      created_at: nowTs
    };

    // Persist first (fire-and-forget tolerant)
    try { await global.DB.create('notifications', row); } catch (e) {}

    emit(row);

    // Browser-level push if permitted
    if (p.push !== false && global.Settings.get('pushEnabled')) {
      showWebNotification(row);
    }
    return row;
  }

  /** Notify every user holding a given role (admin broadcast). */
  async function broadcastToRole(role, title, body, type) {
    let users = [];
    try { users = await global.DB.list('users', { limit: 500 }); } catch (e) { users = []; }
    const targets = users.filter(function (u) { return u.role === role; });
    const results = [];
    for (const u of targets) {
      results.push(await send({ userId: u.id, title: title, body: body, type: type || 'info', role: role }));
    }
    return results.length;
  }

  /* ------------------------------------------------------------ web push */
  async function requestPermission() {
    if (!('Notification' in global)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
  }

  function showWebNotification(row) {
    if (!('Notification' in global)) return;
    if (Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && row.type !== 'ride') return; // don't nag in-app
    try {
      const n = new Notification(row.title, {
        body: row.body,
        tag: row.ride_id || row.id,
        icon: 'images/icon-192.png',
        badge: 'images/icon-192.png',
        vibrate: row.type === 'ride' ? [200, 100, 200] : undefined,
        data: { rideId: row.ride_id, type: row.type }
      });
      n.onclick = function () {
        global.focus();
        if (row.ride_id) global.location.href = 'ride.html?id=' + row.ride_id;
        n.close();
      };
    } catch (e) { /* some browsers block constructor in background */ }
  }

  /**
   * Subscribe to real Web Push. Requires VAPID keys configured in
   * Settings.vapidPublicKey. Returns the subscription or null.
   */
  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in global)) return null;
    const perm = await requestPermission();
    if (perm !== 'granted') return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return existing;
      const vapid = global.Settings.get('vapidPublicKey');
      if (!vapid) return null; // not configured yet — in-app only
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid)
      });
      return sub;
    } catch (e) {
      return null;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------- read tracking */
  async function markRead(notificationId) {
    try { await global.DB.update('notifications', notificationId, { is_read: true, read_at: Date.now() }); } catch (e) {}
  }

  async function markAllRead(userId) {
    let rows = [];
    try { rows = await global.DB.list('notifications', { limit: 300 }); } catch (e) { return 0; }
    const mine = rows.filter(function (r) { return r.user_id === userId && !r.is_read; });
    for (const r of mine) await markRead(r.id);
    return mine.length;
  }

  async function unreadCount(userId) {
    try {
      const rows = await global.DB.list('notifications', { limit: 300 });
      return rows.filter(function (r) { return r.user_id === userId && !r.is_read; }).length;
    } catch (e) { return 0; }
  }

  /* -------------------------------------------------- ride event presets */
  const Ride = {
    searching: function (userId) { return { userId: userId, title: global.t('ride.searching'), body: global.t('ride.searchingSub'), type: 'ride' }; },
    found: function (userId, driverName, rideId) { return { userId: userId, title: global.t('ride.found'), body: driverName, type: 'ride', rideId: rideId }; },
    arriving: function (userId, minutes, rideId) { return { userId: userId, title: global.t('ride.driverArriving'), body: global.t('ride.eta') + ' ' + minutes + ' ' + global.t('common.min'), type: 'ride', rideId: rideId }; },
    arrived: function (userId, rideId) { return { userId: userId, title: global.t('ride.driverArrived'), body: global.t('ride.arrivedNotif'), type: 'ride', rideId: rideId }; },
    started: function (userId, rideId) { return { userId: userId, title: global.t('ride.started'), body: global.t('ride.trackLive'), type: 'ride', rideId: rideId }; },
    completed: function (userId, fare, rideId) { return { userId: userId, title: global.t('ride.completed'), body: global.t('ride.fare') + ' ' + global.PothikGeo.money(fare), type: 'payment', rideId: rideId }; },
    cancelledByPassenger: function (driverUserId, rideId) { return { userId: driverUserId, title: global.t('drvHome.passengerCancelled'), body: '', type: 'alert', rideId: rideId }; },
    cancelledByDriver: function (userId, rideId) { return { userId: userId, title: global.t('ride.driverCancelled'), body: '', type: 'alert', rideId: rideId }; },
    newRequest: function (driverUserId, pickup, fare, rideId) {
      return { userId: driverUserId, title: global.t('drvHome.newRequestToast'), body: pickup + ' · ' + global.PothikGeo.money(fare), type: 'ride', rideId: rideId };
    }
  };

  global.Notify = {
    send: send,
    broadcastToRole: broadcastToRole,
    onMessage: onMessage,
    requestPermission: requestPermission,
    subscribePush: subscribePush,
    markRead: markRead,
    markAllRead: markAllRead,
    unreadCount: unreadCount,
    Ride: Ride
  };
})(window);
