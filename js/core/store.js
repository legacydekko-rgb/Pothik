/* ==========================================================================
   Pothik — Store: namespaced localStorage with JSON safety + TTL
   ========================================================================== */
(function (global) {
  'use strict';

  const NS = 'pothik.';
  let memory = {};              // fallback when localStorage is unavailable
  let available = true;

  try {
    const probe = '__pothik_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
  } catch (e) {
    available = false;
  }

  function key(k) { return NS + k; }

  function get(k, fallback) {
    try {
      const raw = available ? localStorage.getItem(key(k)) : memory[k];
      if (raw === null || raw === undefined) return fallback === undefined ? null : fallback;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.__ttl && Date.now() > parsed.__ttl) {
        remove(k);
        return fallback === undefined ? null : fallback;
      }
      return parsed && typeof parsed === 'object' && '__v' in parsed ? parsed.__v : parsed;
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
  }

  function set(k, value, ttlMs) {
    const payload = ttlMs ? { __v: value, __ttl: Date.now() + ttlMs } : value;
    const raw = JSON.stringify(payload);
    try {
      if (available) localStorage.setItem(key(k), raw);
      else memory[k] = raw;
      return true;
    } catch (e) {
      // Quota exceeded (often from base64 images) — degrade to memory only
      available = false;
      memory[k] = raw;
      return false;
    }
  }

  function remove(k) {
    try {
      if (available) localStorage.removeItem(key(k));
      memory[k] = undefined;
    } catch (e) {}
  }

  function clearNamespace() {
    try {
      if (available) {
        Object.keys(localStorage)
          .filter(function (k) { return k.indexOf(NS) === 0; })
          .forEach(function (k) { localStorage.removeItem(k); });
      }
    } catch (e) {}
    memory = {};
  }

  global.Store = {
    get: get, set: set, remove: remove, clearNamespace: clearNamespace,
    get isPersistent() { return available; }
  };
})(window);
