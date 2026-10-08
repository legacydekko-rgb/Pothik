/* ==========================================================================
   Pothik — Settings: DB-backed platform configuration with safe defaults
   --------------------------------------------------------------------------
   Nothing here is hard-coded permanently: values are read from the
   `fare_settings` / `platform_settings` tables and cached locally so the app
   still works offline. Admin edits write back to the database.
   ========================================================================== */
(function (global) {
  'use strict';

  const CACHE_KEY = 'settings.cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /** Default platform settings — used until the DB answers. */
  const DEFAULTS = {
    /* fare engine */
    baseFare: 50,
    perKm: 20,
    perMinute: 2,
    minimumFare: 60,
    cancellationFee: 30,
    commissionPct: 15,
    surgeMultiplier: 1.0,
    /* matching engine */
    searchRadiusKm: 7,
    requestTimeoutSec: 20,
    maxDriversToTry: 8,
    driverAcceptRadiusKm: 9,
    /* policy */
    cancellationWindowSec: 120,   // free cancellation before driver arrival
    maxCancellationsPerDay: 5,
    maxDriverRejectionsPerDay: 15,
    /* payments */
    cashEnabled: true,
    bkashEnabled: false,
    nagadEnabled: false,
    cardEnabled: false,
    walletEnabled: false,
    /* safety */
    emergencyNumber: '999',
    supportHotline: '16247',
    supportEmail: 'support@pothik.com.bd',
    shareTripEnabled: true,
    /* notifications */
    pushEnabled: true,
    soundEnabled: true,
    keepAwake: true,
    /* demo: simulate a driver accepting so the flow can be shown end-to-end
       without a second device. Turn OFF in production. */
    demoAutoAccept: true,
    /* locale */
    defaultLang: 'bn',
    currency: 'BDT',
    country: 'BD'
  };

  /** Per-vehicle fare defaults (bike is cheapest, car highest). */
  const VEHICLE_DEFAULTS = {
    bike: { baseFare: 30, perKm: 12, perMinute: 1.2, minimumFare: 40, commissionPct: 15, capacity: 1, icon: 'fa-motorcycle', color: '#0A7C5A' },
    cng:  { baseFare: 45, perKm: 16, perMinute: 1.6, minimumFare: 55, commissionPct: 15, capacity: 3, icon: 'fa-taxi',       color: '#F5A524' },
    car:  { baseFare: 60, perKm: 24, perMinute: 2.4, minimumFare: 80, commissionPct: 15, capacity: 4, icon: 'fa-car-side',   color: '#1E63C8' }
  };

  let settings = Object.assign({}, DEFAULTS);
  let vehicleTypes = Object.assign({}, VEHICLE_DEFAULTS);
  let loaded = false;

  /* ------------------------------------------------------------- accessors */
  function get(key, fallback) {
    if (key === undefined) return settings;
    const v = settings[key];
    return v === undefined ? (fallback === undefined ? DEFAULTS[key] : fallback) : v;
  }

  function all() { return Object.assign({}, settings); }

  function vehicles() { return JSON.parse(JSON.stringify(vehicleTypes)); }

  function vehicle(type) {
    return vehicleTypes[type] || Object.assign({}, VEHICLE_DEFAULTS.car, { type: type });
  }

  function vehicleList() {
    return Object.keys(vehicleTypes).map(function (k) {
      return Object.assign({ type: k, nameKey: 'veh.' + k, descKey: 'veh.' + k + '.desc' }, vehicleTypes[k]);
    });
  }

  function set(key, value) {
    settings[key] = value;
    persist();
    global.dispatchEvent(new CustomEvent('pothik:settingschange', { detail: { key: key, value: value } }));
  }

  function setAll(obj) {
    settings = Object.assign({}, settings, obj || {});
    persist();
    global.dispatchEvent(new CustomEvent('pothik:settingschange', { detail: { bulk: true } }));
  }

  function setVehicle(type, patch) {
    vehicleTypes[type] = Object.assign({}, vehicleTypes[type] || {}, patch || {});
    persist();
    global.dispatchEvent(new CustomEvent('pothik:settingschange', { detail: { vehicle: type } }));
  }

  function persist() {
    global.Store.set(CACHE_KEY, { settings: settings, vehicleTypes: vehicleTypes, ts: Date.now() });
  }

  function hydrateFromCache() {
    const cached = global.Store.get(CACHE_KEY, null);
    if (cached && cached.settings) {
      settings = Object.assign({}, DEFAULTS, cached.settings);
      if (cached.vehicleTypes) vehicleTypes = Object.assign({}, VEHICLE_DEFAULTS, cached.vehicleTypes);
    }
  }

  /**
   * Load platform settings + per-vehicle fare rows from the database.
   * Falls back silently to defaults/cache so the app never blocks on this.
   */
  async function load(force) {
    if (loaded && !force) return settings;
    hydrateFromCache();
    try {
      const rows = await global.DB.list('platform_settings', { limit: 200 });
      rows.forEach(function (r) {
        const k = r.key || r.setting_key;
        if (!k) return;
        let v = r.value !== undefined ? r.value : r.setting_value;
        // Coerce numeric strings so the fare engine stays type-safe
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) && DEFAULTS[k] !== undefined && typeof DEFAULTS[k] === 'number') {
          v = Number(v);
        }
        settings[k] = v;
      });
      const vehRows = await global.DB.list('vehicle_types', { limit: 50 });
      vehRows.forEach(function (r) {
        const code = r.code || r.type;
        if (!code) return;
        vehicleTypes[code] = Object.assign({}, vehicleTypes[code] || {}, {
          baseFare: num(r.base_fare, (vehicleTypes[code] || {}).baseFare),
          perKm: num(r.per_km, (vehicleTypes[code] || {}).per_km),
          perMinute: num(r.per_minute, (vehicleTypes[code] || {}).per_minute),
          minimumFare: num(r.minimum_fare, (vehicleTypes[code] || {}).minimum_fare),
          commissionPct: num(r.commission_pct, (vehicleTypes[code] || {}).commissionPct),
          capacity: num(r.capacity, (vehicleTypes[code] || {}).capacity),
          icon: r.icon || (vehicleTypes[code] || {}).icon,
          color: r.color || (vehicleTypes[code] || {}).color,
          name: r.name, name_bn: r.name_bn
        });
      });
      loaded = true;
      persist();
    } catch (e) {
      // Offline or API unavailable — defaults/cache already in place.
      loaded = true;
    }
    return settings;
  }

  function num(v, fallback) {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /** Persist a settings change to the DB (used by the admin panel). */
  async function saveToDb(key, value, adminId) {
    const existing = await global.DB.findWhere('platform_settings', function (r) { return (r.key || r.setting_key) === key; });
    if (existing) {
      await global.DB.update('platform_settings', existing.id, { value: value, updated_by: adminId || 'admin' });
    } else {
      await global.DB.create('platform_settings', {
        id: global.DB.uid('set'), key: key, value: value, group: 'fare', updated_by: adminId || 'admin'
      });
    }
    set(key, value);
  }

  async function saveVehicleToDb(type, patch, adminId) {
    const existing = await global.DB.findWhere('vehicle_types', function (r) { return (r.code || r.type) === type; });
    const payload = {
      base_fare: patch.baseFare, per_km: patch.perKm, per_minute: patch.perMinute,
      minimum_fare: patch.minimumFare, commission_pct: patch.commissionPct,
      updated_by: adminId || 'admin'
    };
    if (existing) await global.DB.update('vehicle_types', existing.id, payload);
    else await global.DB.create('vehicle_types', Object.assign({ id: global.DB.uid('vt'), code: type, name: type }, payload));
    setVehicle(type, patch);
  }

  hydrateFromCache();

  global.Settings = {
    DEFAULTS: DEFAULTS,
    VEHICLE_DEFAULTS: VEHICLE_DEFAULTS,
    get: get, all: all, set: set, setAll: setAll,
    vehicle: vehicle, vehicles: vehicles, vehicleList: vehicleList, setVehicle: setVehicle,
    load: load, saveToDb: saveToDb, saveVehicleToDb: saveVehicleToDb,
    get isLoaded() { return loaded; }
  };
})(window);
