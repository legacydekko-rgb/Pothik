/* ==========================================================================
   Pothik — DB: persistence layer over the platform REST Table API
   --------------------------------------------------------------------------
   In production (Hosted Deploy) these calls hit the platform's RESTful table
   API backed by Cloudflare D1. The exact same interface is exposed by the
   reference NestJS backend in /backend, so the frontend can be pointed at a
   self-hosted API by changing API_BASE.

   Writes are queued when offline and flushed on reconnect.
   ========================================================================== */
(function (global) {
  'use strict';

  // Resolve the site root so `tables/...` works from /app/, /driver/ and /admin/
  // pages as well as from the root. Set API_BASE_OVERRIDE to point at a
  // self-hosted NestJS backend instead (e.g. 'https://api.pothik.com.bd/').
  const API_BASE_OVERRIDE = ''; // '' => same-origin platform table API

  function computeBase() {
    if (API_BASE_OVERRIDE) return API_BASE_OVERRIDE.replace(/\/?$/, '/');
    try {
      const path = location.pathname;
      const dir = path.substring(0, path.lastIndexOf('/') + 1); // trailing slash
      // Strip a role sub-folder so the base is always the project root.
      const stripped = dir.replace(/(app|driver|admin)\/$/, '');
      return stripped || '/';
    } catch (e) {
      return '/';
    }
  }

  const API_BASE = computeBase();

  const QUEUE_KEY = 'db.queue';
  let online = navigator.onLine !== false;

  /* ------------------------------------------------------------- utilities */
  function uid(prefix) {
    const rnd = (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : ((r & 0x3) | 0x8);
          return v.toString(16);
        });
    return prefix ? prefix + '_' + rnd : rnd;
  }

  function now() { return Date.now(); }

  function qs(params) {
    const parts = [];
    Object.keys(params || {}).forEach(function (k) {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  class HttpError extends Error {
    constructor(message, status, body) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
      this.body = body;
    }
  }

  /* --------------------------------------------------------------- transport */
  const RETRYABLE = [408, 425, 429, 500, 502, 503, 504];
  const MAX_RETRIES = 4;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function request(method, path, body, attempt) {
    const url = API_BASE + path;
    const init = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store'
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(url, init);
    } catch (netErr) {
      // Transport failure — retry a couple of times before surfacing it
      if ((attempt || 0) < 2) {
        await sleep(400 * Math.pow(2, attempt || 0));
        return request(method, path, body, (attempt || 0) + 1);
      }
      throw netErr;
    }

    if (res.status === 204) return null;

    let payload = null;
    const text = await res.text();
    if (text) { try { payload = JSON.parse(text); } catch (e) { payload = text; } }

    if (!res.ok) {
      // Rate limiting / transient server errors: back off and retry
      const n = attempt || 0;
      if (RETRYABLE.indexOf(res.status) !== -1 && n < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 300 * Math.pow(2, n) + Math.random() * 250;
        await sleep(wait);
        return request(method, path, body, n + 1);
      }
      const msg = (payload && (payload.error || payload.detail || payload.message)) || ('HTTP ' + res.status);
      throw new HttpError(msg, res.status, payload);
    }
    return payload;
  }

  /* ---------------------------------------------------------- offline queue */
  function queuePush(op) {
    const q = global.Store.get(QUEUE_KEY, []) || [];
    q.push(op);
    global.Store.set(QUEUE_KEY, q.slice(-200));
  }

  async function flushQueue() {
    const q = global.Store.get(QUEUE_KEY, []) || [];
    if (!q.length) return { flushed: 0, failed: 0 };
    const remaining = [];
    let flushed = 0, failed = 0;
    for (const op of q) {
      try {
        await request(op.method, op.path, op.body);
        flushed++;
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          failed++; // permanently rejected — drop it
        } else {
          remaining.push(op); // retry later
        }
      }
    }
    global.Store.set(QUEUE_KEY, remaining);
    if (flushed) global.dispatchEvent(new CustomEvent('pothik:queueflushed', { detail: { flushed: flushed } }));
    return { flushed: flushed, failed: failed };
  }

  global.addEventListener('online', function () {
    online = true;
    flushQueue();
  });
  global.addEventListener('offline', function () { online = false; });

  /* ------------------------------------------------------------------- CRUD */
  async function list(table, params) {
    const p = Object.assign({ page: 1, limit: 200 }, params || {});
    const data = await request('GET', 'tables/' + table + qs(p));
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
  }

  async function listPaged(table, params) {
    const p = Object.assign({ page: 1, limit: 100 }, params || {});
    const data = await request('GET', 'tables/' + table + qs(p));
    if (data && Array.isArray(data.data)) {
      return { rows: data.data, total: data.total || data.data.length, page: data.page || 1, limit: data.limit || 100 };
    }
    const rows = Array.isArray(data) ? data : [];
    return { rows: rows, total: rows.length, page: 1, limit: rows.length };
  }

  async function get(table, id) {
    return request('GET', 'tables/' + table + '/' + encodeURIComponent(id));
  }

  /** Find first row matching a predicate. predicate: (row) => bool */
  async function findWhere(table, predicate, params) {
    const rows = await list(table, params);
    for (const r of rows) { if (predicate(r)) return r; }
    return null;
  }

  async function create(table, data) {
    const row = Object.assign({ id: uid() }, data);
    row.created_at = row.created_at || now();
    row.updated_at = now();
    if (!online) { queuePush({ method: 'POST', path: 'tables/' + table, body: row }); return row; }
    try {
      const saved = await request('POST', 'tables/' + table, row);
      return saved || row;
    } catch (e) {
      if (!e.status) { queuePush({ method: 'POST', path: 'tables/' + table, body: row }); return row; }
      throw e;
    }
  }

  async function update(table, id, patch) {
    const body = Object.assign({}, patch, { updated_at: now() });
    if (!online) { queuePush({ method: 'PATCH', path: 'tables/' + table + '/' + id, body: body }); return body; }
    try {
      return (await request('PATCH', 'tables/' + table + '/' + id, body)) || body;
    } catch (e) {
      if (!e.status) { queuePush({ method: 'PATCH', path: 'tables/' + table + '/' + id, body: body }); return body; }
      throw e;
    }
  }

  /** Full replace (PUT). */
  async function replace(table, id, row) {
    const body = Object.assign({}, row, { updated_at: now() });
    return request('PUT', 'tables/' + table + '/' + id, body);
  }

  async function remove(table, id) {
    if (!online) { queuePush({ method: 'DELETE', path: 'tables/' + table + '/' + id }); return true; }
    try {
      await request('DELETE', 'tables/' + table + '/' + id);
      return true;
    } catch (e) {
      if (!e.status) { queuePush({ method: 'DELETE', path: 'tables/' + table + '/' + id }); return true; }
      throw e;
    }
  }

  /**
   * Optimistic concurrency helper used by ride acceptance.
   * Returns true only if `current` still equals `expected`, then applies patch.
   * This is what prevents two drivers locking the same ride.
   */
  async function updateIf(table, id, field, expected, patch) {
    let fresh;
    try { fresh = await get(table, id); } catch (e) { fresh = null; }
    if (!fresh) return { ok: false, reason: 'not_found' };
    if (fresh[field] !== expected) return { ok: false, reason: 'stale', current: fresh[field] };
    await update(table, id, patch);
    return { ok: true };
  }

  /**
   * Insert many rows with a bounded number of in-flight requests.
   * Never throws: returns { inserted, failed } so bulk seeding is resilient.
   */
  async function createMany(table, rows, opts) {
    const o = opts || {};
    const concurrency = Math.max(1, Math.min(o.concurrency || 4, 12));
    const list = rows || [];
    let inserted = 0, failed = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < list.length) {
        const row = list[cursor++];
        const prepared = Object.assign({ id: row.id || uid() }, row);
        prepared.created_at = prepared.created_at || now();
        prepared.updated_at = now();
        try {
          await request('POST', 'tables/' + table, prepared);
          inserted++;
        } catch (e) {
          // A row that already exists is not a failure for seeding purposes.
          if (e && e.status === 409) { inserted++; continue; }
          failed++;
          if (o.onError) { try { o.onError(e, row); } catch (x) {} }
        }
        if (o.onProgress && ((inserted + failed) % 10 === 0)) {
          try { o.onProgress(inserted + failed, list.length); } catch (x) {}
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, list.length); i++) workers.push(worker());
    await Promise.all(workers);
    return { inserted: inserted, failed: failed };
  }

  global.DB = {
    uid: uid,
    now: now,
    API_BASE: API_BASE,
    list: list,
    listPaged: listPaged,
    get: get,
    findWhere: findWhere,
    create: create,
    createMany: createMany,
    update: update,
    replace: replace,
    remove: remove,
    updateIf: updateIf,
    flushQueue: flushQueue,
    get queueLength() { return (global.Store.get(QUEUE_KEY, []) || []).length; },
    get isOnline() { return online; },
    HttpError: HttpError
  };
})(window);
