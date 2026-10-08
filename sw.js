/* Pothik service worker — app shell cache + push notifications */
const CACHE = 'pothik-v1';
const SHELL = [
  './', './index.html', './login.html',
  './css/tokens.css', './css/base.css', './css/components.css', './css/app.css',
  './js/core/i18n.js', './js/core/store.js', './js/core/db.js', './js/core/geo.js',
  './js/core/settings.js', './js/core/fare.js', './js/core/ride-state.js',
  './js/core/matching.js', './js/core/auth.js', './js/core/notify.js',
  './js/core/ui.js', './js/core/map.js', './js/core/seed.js', './js/app/shell.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API calls or map tiles — always go to the network.
  if (url.pathname.startsWith('/tables/') || url.hostname.includes('tile.openstreetmap.org') ||
      url.hostname.includes('nominatim') || url.hostname.includes('router.project-osrm')) {
    return;
  }

  // Network-first for same-origin documents, cache fallback when offline.
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for CDN assets.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});

/* ---- Web Push -------------------------------------------------------- */
self.addEventListener('push', (event) => {
  let data = { title: 'Pothik', body: 'You have a new update.' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'images/icon.svg',
      badge: 'images/icon.svg',
      tag: data.tag || data.ride_id || 'pothik',
      vibrate: data.vibrate || [200, 100, 200],
      data: { url: data.url || 'app/index.html', rideId: data.ride_id || null }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || 'app/index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.includes(target) && 'focus' in c) return c.focus(); }
      return self.clients.openWindow(target);
    })
  );
});
