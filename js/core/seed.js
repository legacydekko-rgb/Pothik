/* ==========================================================================
   Pothik — Demo data bootstrap (idempotent)
   --------------------------------------------------------------------------
   Runs once per empty database. Creates:
     • platform settings + vehicle types (if missing)
     • demo accounts with REAL PBKDF2 password hashes
     • 8 drivers (+vehicles, +documents, +live status), 5 passengers
     • ~14 days of ride history, payments, ratings, commissions, tickets

   Safe by design: it only writes when the `users` table is empty, so it never
   touches real production data.
   ========================================================================== */
(function (global) {
  'use strict';

  const FLAG = 'seed.v1.done';
  let running = null;

  /* ------------------------------------------------------ seeded randomness */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20261005);
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function between(a, b) { return a + rnd() * (b - a); }
  function intBetween(a, b) { return Math.floor(between(a, b + 1)); }
  function chance(p) { return rnd() < p; }
  function jitter(v, amt) { return v + (rnd() - 0.5) * amt; }

  const DAY = 86400000;
  const NOW = Date.now();

  /* ------------------------------------------------------------ reference */
  const LM = global.PothikGeo.BD.landmarks.dhaka;
  const CITIES = global.PothikGeo.BD.cities;

  const ADMIN = { id: 'usr_admin_1', phone: '1700000001', name: 'Pothik Admin', email: 'admin@pothik.com.bd', pw: 'admin1234' };

  const PASSENGERS = [
    { id: 'usr_pax_1', phone: '1711100001', name: 'Rahim Uddin', email: 'rahim@example.com', lang: 'bn' },
    { id: 'usr_pax_2', phone: '1811100002', name: 'Nusrat Jahan', email: 'nusrat@example.com', lang: 'bn' },
    { id: 'usr_pax_3', phone: '1911100003', name: 'Tanvir Ahmed', email: 'tanvir@example.com', lang: 'en' },
    { id: 'usr_pax_4', phone: '1611100004', name: 'Sadia Islam', email: 'sadia@example.com', lang: 'bn' },
    { id: 'usr_pax_5', phone: '1511100005', name: 'Mahmudul Hasan', email: 'mahmud@example.com', lang: 'en' }
  ];

  const DRIVERS = [
    { id: 'drv_1', userId: 'usr_drv_1', phone: '1712000001', name: 'Karim Sheikh', type: 'bike', status: 'approved',
      model: 'Bajaj Pulsar 150', reg: 'DHAKA METRO-HA-11-2233', year: 2021, rating: 4.87, rides: 1284 },
    { id: 'drv_2', userId: 'usr_drv_2', phone: '1712000002', name: 'Abdul Malek', type: 'cng', status: 'approved',
      model: 'Bajaj RE 4S', reg: 'DHAKA METRO-THA-11-4477', year: 2019, rating: 4.72, rides: 963 },
    { id: 'drv_3', userId: 'usr_drv_3', phone: '1712000003', name: 'Jamal Hossain', type: 'car', status: 'approved',
      model: 'Toyota Premio F EX', reg: 'DHAKA METRO-GA-12-3456', year: 2017, rating: 4.91, rides: 2140 },
    { id: 'drv_4', userId: 'usr_drv_4', phone: '1712000004', name: 'Rafiqul Islam', type: 'bike', status: 'approved',
      model: 'Honda CB Shine', reg: 'DHAKA METRO-LA-12-8891', year: 2020, rating: 4.65, rides: 742 },
    { id: 'drv_5', userId: 'usr_drv_5', phone: '1712000005', name: 'Shahin Alam', type: 'cng', status: 'approved',
      model: 'Bajaj RE 2S', reg: 'DHAKA METRO-THA-13-2201', year: 2018, rating: 4.58, rides: 611 },
    { id: 'drv_6', userId: 'usr_drv_6', phone: '1712000006', name: 'Nazmul Hoque', type: 'car', status: 'pending',
      model: 'Mitsubishi Lancer', reg: 'DHAKA METRO-GA-13-7712', year: 2015, rating: 0, rides: 0 },
    { id: 'drv_7', userId: 'usr_drv_7', phone: '1712000007', name: 'Imran Khan', type: 'bike', status: 'pending',
      model: 'Yamaha FZS', reg: 'DHAKA METRO-LA-13-3344', year: 2022, rating: 0, rides: 0 },
    { id: 'drv_8', userId: 'usr_drv_8', phone: '1712000008', name: 'Sohel Rana', type: 'car', status: 'suspended',
      model: 'Toyota Axio', reg: 'DHAKA METRO-GA-14-9900', year: 2016, rating: 3.42, rides: 388 }
  ];

  const DRIVER_PW = 'driver123';
  const PAX_PW = 'passenger123';

  /* --------------------------------------------------------- placeholder img */
  /**
   * UTF-8 safe SVG -> data URI. btoa() alone throws on any character outside
   * Latin-1 (em dashes, Bangla text, etc.), so we percent-encode instead —
   * the result is pure ASCII and survives JSON round-trips unchanged.
   */
  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /** Tiny inline SVG avatar so demo rows never depend on external images. */
  function avatarDataUri(name, bg) {
    const initials = String(name).split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" rx="80" fill="' + bg + '"/>' +
      '<text x="80" y="80" font-family="Inter,system-ui,sans-serif" font-size="60" font-weight="700" ' +
      'fill="#ffffff" text-anchor="middle" dominant-baseline="central">' + initials + '</text></svg>';
    return svgDataUri(svg);
  }

  /** Placeholder "document" image so admin review screens have something to show. */
  function docDataUri(title, subtitle, bg) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">' +
      '<rect width="480" height="300" fill="' + bg + '"/>' +
      '<rect x="16" y="16" width="448" height="268" rx="10" fill="rgba(255,255,255,.92)"/>' +
      '<text x="36" y="70" font-family="Inter,system-ui,sans-serif" font-size="22" font-weight="700" fill="#0B1512">' + title + '</text>' +
      '<text x="36" y="102" font-family="Inter,system-ui,sans-serif" font-size="14" fill="#5B6B66">' + subtitle + '</text>' +
      '<rect x="36" y="130" width="180" height="12" rx="6" fill="#E2E9E6"/>' +
      '<rect x="36" y="156" width="240" height="12" rx="6" fill="#E2E9E6"/>' +
      '<rect x="36" y="182" width="150" height="12" rx="6" fill="#E2E9E6"/>' +
      '<circle cx="390" cy="215" r="42" fill="none" stroke="#C2E8D9" stroke-width="4"/>' +
      '<text x="36" y="248" font-family="Inter,system-ui,sans-serif" font-size="12" font-weight="600" fill="#0A7C5A">POTHIK VERIFICATION COPY</text>' +
      '</svg>';
    return svgDataUri(svg);
  }

  /* -------------------------------------------------------------- seeding */
  async function ensure() {
    if (running) return running;
    running = run().catch(function (e) {
      running = null;
      return { seeded: false, error: e && e.message };
    });
    return running;
  }

  async function run() {
    // Probe which parts of the dataset are already present. This makes the
    // bootstrap idempotent AND self-healing: if an earlier run was interrupted
    // (for example by an API rate limit), the missing sections are filled in.
    let counts;
    try {
      counts = await countTables();
    } catch (e) {
      return { seeded: false, reason: 'offline' };
    }
    if (counts === null) return { seeded: false, reason: 'offline' };

    const needConfig = counts.platform_settings < 10 || counts.vehicle_types < 3;
    const needPeople = counts.drivers === 0 || counts.users < 3 || counts.driver_status === 0;
    const needHistory = counts.rides === 0;

    if (!needConfig && !needPeople && !needHistory) {
      global.Store.set(FLAG, true);
      return { seeded: false, reason: 'already-complete' };
    }

    global.dispatchEvent(new CustomEvent('pothik:seeding', { detail: { active: true } }));

    const report = { seeded: true, config: false, people: false, history: false };
    try {
      if (needConfig) { await ensureConfig(); report.config = true; }
      if (needPeople) { await ensurePeople(); report.people = true; }
      if (needHistory) { await ensureHistory(); report.history = true; }
      // Always finish with a live, demo-ready state: fresh GPS pings for the
      // available drivers plus a few in-progress rides for the live monitor.
      await placeOnlineDrivers();
      await ensureLiveRides();
      global.Store.set(FLAG, true);
      global.dispatchEvent(new CustomEvent('pothik:seeded', { detail: report }));
      return report;
    } catch (e) {
      // Leave the flag unset so the next boot retries the missing sections.
      global.Store.remove(FLAG);
      global.dispatchEvent(new CustomEvent('pothik:seeded', { detail: { ok: false, error: e && e.message } }));
      return { seeded: false, error: e && e.message };
    } finally {
      global.dispatchEvent(new CustomEvent('pothik:seeding', { detail: { active: false } }));
    }
  }

  /** Row totals for the tables the bootstrap cares about. null when offline. */
  async function countTables() {
    const tables = ['users', 'drivers', 'driver_status', 'rides', 'platform_settings', 'vehicle_types'];
    const out = {};
    try {
      const results = await Promise.all(tables.map(function (tb) {
        return global.DB.listPaged(tb, { page: 1, limit: 1 });
      }));
      tables.forEach(function (tb, i) { out[tb] = results[i].total || 0; });
      return out;
    } catch (e) {
      return null;
    }
  }

  /* ----------------------------------------------------------- config rows */
  async function ensureConfig() {
    const S = global.Settings;
    const defaults = S.DEFAULTS;
    const groups = {
      baseFare: 'fare', perKm: 'fare', perMinute: 'fare', minimumFare: 'fare',
      cancellationFee: 'fare', commissionPct: 'fare', surgeMultiplier: 'fare',
      searchRadiusKm: 'matching', requestTimeoutSec: 'matching', maxDriversToTry: 'matching',
      driverAcceptRadiusKm: 'matching',
      cancellationWindowSec: 'policy', maxCancellationsPerDay: 'policy', maxDriverRejectionsPerDay: 'policy',
      cashEnabled: 'payment', bkashEnabled: 'payment', nagadEnabled: 'payment',
      cardEnabled: 'payment', walletEnabled: 'payment',
      emergencyNumber: 'safety', supportHotline: 'safety', supportEmail: 'safety', shareTripEnabled: 'safety',
      pushEnabled: 'locale', soundEnabled: 'locale', defaultLang: 'locale', currency: 'locale', country: 'locale',
      demoAutoAccept: 'demo'
    };

    const existingSettings = await safeList('platform_settings');
    const haveKeys = {};
    existingSettings.forEach(function (r) { haveKeys[r.key || r.setting_key] = true; });

    const settingRows = [];
    Object.keys(defaults).forEach(function (k) {
      if (haveKeys[k]) return;
      settingRows.push({
        id: global.DB.uid('set'), key: k, value: String(defaults[k]),
        group: groups[k] || 'fare', label: k, updated_by: 'seed'
      });
    });

    const existingVeh = await safeList('vehicle_types');
    const haveVeh = {};
    existingVeh.forEach(function (r) { haveVeh[r.code || r.type] = true; });
    const vehRows = [];
    Object.keys(S.VEHICLE_DEFAULTS).forEach(function (code) {
      if (haveVeh[code]) return;
      const v = S.VEHICLE_DEFAULTS[code];
      vehRows.push({
        id: global.DB.uid('vt'), code: code,
        name: code.charAt(0).toUpperCase() + code.slice(1),
        name_bn: code === 'bike' ? 'বাইক' : (code === 'cng' ? 'সিএনজি' : 'কার'),
        base_fare: v.baseFare, per_km: v.perKm, per_minute: v.perMinute,
        minimum_fare: v.minimumFare, commission_pct: v.commissionPct,
        capacity: v.capacity, icon: v.icon, color: v.color,
        is_active: true, sort_order: code === 'bike' ? 1 : (code === 'cng' ? 2 : 3),
        updated_by: 'seed'
      });
    });

    await batchInsert('platform_settings', settingRows);
    await batchInsert('vehicle_types', vehRows);
  }

  async function safeList(table) {
    try { return await global.DB.list(table, { limit: 200 }); } catch (e) { return []; }
  }

  /* ----------------------------------------------------------- people rows */
  async function ensurePeople() {
    const nowTs = NOW;

    /* --- admin --- */
    const adminHash = await global.Auth.hashPassword(ADMIN.pw);
    await batchInsert('users', [{
      id: ADMIN.id, phone: ADMIN.phone, phone_e164: '+880' + ADMIN.phone, phone_verified: true,
      full_name: ADMIN.name, email: ADMIN.email, password_hash: adminHash, role: 'admin',
      language: 'bn', status: 'active', photo_url: avatarDataUri(ADMIN.name, '#0A7C5A'),
      emergency_contact: '', last_login_at: nowTs - DAY, created_at: nowTs - 120 * DAY
    }]);
    await batchInsert('admin_users', [{
      id: 'adm_1', user_id: ADMIN.id, full_name: ADMIN.name, email: ADMIN.email,
      role: 'super_admin', permissions: 'all', status: 'active',
      last_login_at: nowTs - DAY, created_at: nowTs - 120 * DAY
    }]);

    /* --- passengers --- */
    const paxHash = await global.Auth.hashPassword(PAX_PW);
    const paxUsers = [], paxRows = [];
    PASSENGERS.forEach(function (p, i) {
      const created = nowTs - (30 + i * 14) * DAY;
      paxUsers.push({
        id: p.id, phone: p.phone, phone_e164: '+880' + p.phone, phone_verified: true,
        full_name: p.name, email: p.email, password_hash: paxHash, role: 'passenger',
        language: p.lang, status: 'active', photo_url: avatarDataUri(p.name, ['#0A7C5A', '#1E63C8', '#F5A524', '#FF5A36', '#2B7FFF'][i % 5]),
        emergency_contact: '1' + intBetween(5, 9) + intBetween(10000000, 99999999),
        last_login_at: nowTs - intBetween(0, 3) * DAY, created_at: created
      });
      paxRows.push({
        id: 'pax_' + (i + 1), user_id: p.id,
        rating: 4.7 + rnd() * 0.3, total_ratings: intBetween(3, 40),
        total_rides: intBetween(8, 120), total_spent: intBetween(2000, 45000),
        wallet_balance: chance(0.4) ? intBetween(0, 1500) : 0,
        cancellations: intBetween(0, 3), status: 'active', created_at: created
      });
    });
    await batchInsert('users', paxUsers);
    await batchInsert('passengers', paxRows);

    /* --- drivers --- */
    const drvHash = await global.Auth.hashPassword(DRIVER_PW);
    const drvUsers = [], drvRows = [], drvStatusRows = [], vehRows = [], docRows = [];
    DRIVERS.forEach(function (d, i) {
      const created = nowTs - (20 + i * 9) * DAY;
      const approved = d.status === 'approved';
      const docsOk = approved || d.status === 'suspended';

      drvUsers.push({
        id: d.userId, phone: d.phone, phone_e164: '+880' + d.phone, phone_verified: true,
        full_name: d.name, email: d.name.split(' ')[0].toLowerCase() + '@example.com',
        password_hash: drvHash, role: 'driver', language: i % 3 === 0 ? 'en' : 'bn',
        status: d.status === 'suspended' ? 'suspended' : 'active',
        photo_url: avatarDataUri(d.name, ['#076148', '#1E63C8', '#F5A524', '#0A7C5A', '#E63E19', '#2B7FFF', '#12A150', '#8A5600'][i % 8]),
        emergency_contact: '1' + intBetween(5, 9) + intBetween(10000000, 99999999),
        last_login_at: nowTs - intBetween(0, 2) * DAY, created_at: created
      });

      drvRows.push({
        id: d.id, user_id: d.userId, full_name: d.name, phone: d.phone,
        nid_number: String(intBetween(1000000000, 9999999999)),
        nid_front_url: docsOk ? docDataUri('NATIONAL ID — FRONT', d.name + ' · NID', '#0A7C5A') : '',
        nid_back_url: docsOk ? docDataUri('NATIONAL ID — BACK', d.name + ' · NID', '#076148') : '',
        licence_number: 'DK' + intBetween(100000, 999999) + '/' + intBetween(2015, 2023),
        licence_url: docsOk ? docDataUri('DRIVING LICENCE', d.name + ' · Bangladesh Road Transport Authority', '#1E63C8') : '',
        photo_url: avatarDataUri(d.name, '#0A7C5A'),
        rating: d.rating || 5, total_ratings: d.rides ? Math.round(d.rides * 0.72) : 0,
        completed_rides: d.rides, cancelled_rides: Math.round(d.rides * 0.04),
        acceptance_rate: d.rides ? 0.78 + rnd() * 0.2 : 1,
        rejection_count: d.rides ? intBetween(2, 40) : 0,
        status: d.status,
        rejection_reason: d.status === 'suspended' ? 'Multiple passenger safety complaints under investigation' : '',
        verified_by: approved || d.status === 'suspended' ? ADMIN.id : '',
        verified_at: approved || d.status === 'suspended' ? created + DAY : 0,
        submitted_at: created,
        created_at: created
      });

      drvStatusRows.push({
        id: 'ds_' + d.id, driver_id: d.id, user_id: d.userId,
        is_online: approved && i < 5, availability: approved && i < 5 ? 'available' : 'offline',
        lat: null, lng: null, heading: null, accuracy: null,
        last_ping_at: 0, active_ride_id: null,
        rating: d.rating || 5, acceptance_rate: d.rides ? 0.8 : 1, completed_rides: d.rides,
        vehicle_type: d.type, vehicle_id: 'veh_' + d.id,
        online_since: 0, updated_at: nowTs
      });

      vehRows.push({
        id: 'veh_' + d.id, driver_id: d.id, vehicle_type: d.type,
        registration_number: d.reg, make: d.model.split(' ')[0], model: d.model,
        year: d.year, color: pick(['White', 'Silver', 'Black', 'Blue', 'Green']),
        seats: d.type === 'bike' ? 1 : (d.type === 'cng' ? 3 : 4),
        photo_url: docDataUri('VEHICLE PHOTO', d.model + ' · ' + d.reg, '#F5A524'),
        registration_doc_url: docsOk ? docDataUri('VEHICLE REGISTRATION', d.reg, '#076148') : '',
        fitness_doc_url: docsOk ? docDataUri('FITNESS CERTIFICATE', d.reg, '#12A150') : '',
        insurance_doc_url: docsOk ? docDataUri('INSURANCE CERTIFICATE', d.reg, '#2B7FFF') : '',
        tax_token_url: docsOk ? docDataUri('TAX TOKEN', d.reg, '#E63E19') : '',
        status: approved ? 'approved' : (d.status === 'suspended' ? 'approved' : 'pending'),
        verified_by: approved || d.status === 'suspended' ? ADMIN.id : '',
        verified_at: approved || d.status === 'suspended' ? created + DAY : 0,
        created_at: created
      });

      const docSpecs = [
        { type: 'nid_front', url: docsOk ? docDataUri('NATIONAL ID — FRONT', d.name, '#0A7C5A') : '' },
        { type: 'nid_back', url: docsOk ? docDataUri('NATIONAL ID — BACK', d.name, '#076148') : '' },
        { type: 'licence', url: docsOk ? docDataUri('DRIVING LICENCE', d.name, '#1E63C8') : '' },
        { type: 'vehicle_registration', url: docsOk ? docDataUri('VEHICLE REGISTRATION', d.reg, '#076148') : '' },
        { type: 'profile_photo', url: avatarDataUri(d.name, '#0A7C5A') }
      ];
      docSpecs.forEach(function (spec, di) {
        docRows.push({
          id: 'doc_' + d.id + '_' + di, driver_id: d.id, doc_type: spec.type,
          file_url: spec.url, file_name: spec.type + '.jpg',
          status: spec.url ? (approved ? 'approved' : 'pending') : 'pending',
          review_note: '', reviewed_by: approved ? ADMIN.id : '',
          reviewed_at: approved ? created + DAY : 0,
          expires_at: spec.type === 'licence' ? nowTs + 400 * DAY : 0,
          uploaded_at: created, created_at: created
        });
      });
    });

    await batchInsert('users', drvUsers);
    await batchInsert('drivers', drvRows);
    await batchInsert('driver_status', drvStatusRows);
    await batchInsert('vehicles', vehRows);
    await batchInsert('driver_documents', docRows);
  }

  /**
   * Put the approved drivers on the map with FRESH pings so the matching
   * engine can find them immediately. Called last, after any long seeding work,
   * because a driver whose last ping is older than Matching.STALE_AFTER_MS is
   * correctly treated as offline.
   */
  async function placeOnlineDrivers() {
    const spots = [
      { lat: 23.7925, lng: 90.4150 }, // Gulshan 2
      { lat: 23.7509, lng: 90.3742 }, // Dhanmondi 27
      { lat: 23.8069, lng: 90.3687 }, // Mirpur 10
      { lat: 23.7381, lng: 90.3955 }, // Shahbagh
      { lat: 23.8687, lng: 90.3950 }  // Uttara 7
    ];
    const online = DRIVERS.filter(function (d) { return d.status === 'approved'; });
    const ops = [];
    for (let i = 0; i < online.length; i++) {
      const d = online[i];
      const st = await global.DB.findWhere('driver_status', function (r) { return r.driver_id === d.id; });
      if (!st) continue;
      if (st.active_ride_id) continue;      // busy on a live ride — leave alone
      const spot = spots[i % spots.length];
      ops.push(global.DB.update('driver_status', st.id, {
        lat: jitter(spot.lat, 0.006), lng: jitter(spot.lng, 0.006),
        heading: intBetween(0, 359), accuracy: intBetween(6, 18),
        speed_kmh: 0,
        last_ping_at: Date.now(),          // fresh: within the liveness window
        is_online: true, availability: 'available',
        online_since: Date.now() - intBetween(30, 240) * 60000,
        updated_at: Date.now()
      }));
    }
    await Promise.all(ops);
  }

  /**
   * Guarantee a handful of in-progress rides so the admin live monitor, the
   * passenger "resume trip" path and the driver "active ride" path all have
   * real data to render on a fresh install.
   */
  async function ensureLiveRides() {
    let existing = [];
    try { existing = await global.DB.list('rides', { limit: 300 }); } catch (e) { return; }
    const alreadyActive = existing.filter(function (r) { return global.RideState.isActive(r.status); });
    if (alreadyActive.length >= 3) return;

    const approved = DRIVERS.filter(function (d) { return d.status === 'approved'; });
    const plan = [
      { status: 'SEARCHING_DRIVER', drv: null,        paxIdx: 0, ageMin: 1 },
      { status: 'DRIVER_ARRIVING',  drv: approved[0], paxIdx: 1, ageMin: 4, progress: 0.35 },
      { status: 'RIDE_STARTED',     drv: approved[2], paxIdx: 2, ageMin: 11, progress: 0.55 }
    ];

    const rideRows = [], locRows = [], statusOps = [];
    let seq = 9000;

    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const from = pick(LM);
      let to = pick(LM);
      let guard = 0;
      while (to === from && guard++ < 10) to = pick(LM);

      const km = Math.max(1.6, global.PothikGeo.roadKmEstimate(from, to, 1.35));
      const vehType = p.drv ? p.drv.type : 'bike';
      const minutes = global.Fare.estimateMinutes(km, vehType);
      const q = global.Fare.quote({ km: km, minutes: minutes, vehicleType: vehType });
      const created = Date.now() - p.ageMin * 60000;
      const pax = PASSENGERS[p.paxIdx];
      const rideId = 'ride_live_' + (++seq);
      const assigned = !!p.drv;

      const ride = {
        id: rideId, ride_code: 'PTK-' + String(seq).slice(-5) + 'L',
        passenger_id: 'pax_' + (p.paxIdx + 1), passenger_user_id: pax.id,
        driver_id: assigned ? p.drv.id : '', driver_user_id: assigned ? p.drv.userId : '',
        vehicle_id: assigned ? 'veh_' + p.drv.id : '',
        vehicle_type: vehType, status: p.status,
        pickup_label: from.label, pickup_lat: from.lat, pickup_lng: from.lng,
        dropoff_label: to.label, dropoff_lat: to.lat, dropoff_lng: to.lng,
        distance_km: global.Fare.roundTo(km, 2), duration_min: Math.round(minutes),
        actual_km: 0, actual_minutes: 0,
        base_fare: q.baseFare, distance_charge: q.distanceCharge, time_charge: q.timeCharge,
        surge: 1, discount: 0, fare_total: q.total,
        commission_pct: q.commissionPct, commission_amount: q.commission, driver_earning: q.driverEarning,
        payment_method: 'cash', payment_status: 'Pending',
        start_otp: String(intBetween(1000, 9999)),
        cancel_reason: '', cancelled_by: '', cancellation_fee: 0,
        city: 'Dhaka', area: from.label.split(',').pop().trim(),
        matched_driver_attempts: assigned ? intBetween(1, 3) : 0,
        created_at: created,
        search_started_at: created + 1500,
        assigned_at: assigned ? created + 30000 : 0,
        arrived_at: p.status === 'RIDE_STARTED' ? created + 300000 : 0,
        started_at: p.status === 'RIDE_STARTED' ? created + 330000 : 0
      };
      rideRows.push(ride);

      if (assigned) {
        // Park the driver along the route and mark them busy
        const t = p.progress || 0.3;
        const pos = global.PothikGeo.lerp(from, to, t);
        const st = await global.DB.findWhere('driver_status', function (r) { return r.driver_id === p.drv.id; });
        if (st) {
          statusOps.push(global.DB.update('driver_status', st.id, {
            is_online: true, availability: 'busy', active_ride_id: rideId,
            lat: pos.lat, lng: pos.lng,
            heading: Math.round(global.PothikGeo.bearing(from, to)),
            speed_kmh: p.status === 'RIDE_STARTED' ? intBetween(18, 34) : 0,
            accuracy: 9, last_ping_at: Date.now(),
            online_since: Date.now() - 120 * 60000,
            vehicle_type: vehType, vehicle_id: 'veh_' + p.drv.id,
            updated_at: Date.now()
          }));
        }
        // GPS trail behind the driver
        for (let s = 0; s <= 6; s++) {
          const tt = Math.max(0, t - (6 - s) * 0.07);
          const pt = global.PothikGeo.lerp(from, to, tt);
          locRows.push({
            id: global.DB.uid('loc'), ride_id: rideId, actor: 'driver', driver_id: p.drv.id,
            lat: pt.lat, lng: pt.lng,
            heading: Math.round(global.PothikGeo.bearing(from, to)),
            speed_kmh: intBetween(10, 38), accuracy: intBetween(5, 14),
            recorded_at: created + s * 45000, created_at: Date.now()
          });
        }
      }
    }

    await batchInsert('rides', rideRows);
    await batchInsert('ride_locations', locRows);
    await Promise.all(statusOps);
  }

  /* ---------------------------------------------------------- ride history */
  async function ensureHistory() {
    const settings = global.Settings;
    const DRIVER_BY_ID = {};
    DRIVERS.forEach(function (d) { DRIVER_BY_ID[d.id] = d; });
    const approvedDrivers = DRIVERS.filter(function (d) { return d.status === 'approved'; });

    const rides = [];
    const payments = [];
    const ratings = [];
    const commissions = [];
    const cancellations = [];

    const HISTORY_DAYS = 14;
    let seq = 1000;

    for (let dayAgo = HISTORY_DAYS; dayAgo >= 0; dayAgo--) {
      // Weekends / recent days are busier
      const base = dayAgo < 4 ? intBetween(5, 8) : intBetween(2, 6);
      const count = base;

      for (let r = 0; r < count; r++) {
        const hour = intBetween(6, 22);
        const minute = intBetween(0, 59);
        const created = NOW - dayAgo * DAY - (24 - hour) * 3600000 + minute * 60000 - intBetween(0, 3000000);
        if (created > NOW) continue;

        const from = pick(LM);
        let to = pick(LM);
        let guard = 0;
        while (to === from && guard++ < 10) to = pick(LM);

        const km = Math.max(1.4, global.PothikGeo.roadKmEstimate(from, to, 1.35));
        const drv = pick(approvedDrivers);
        const vehType = drv.type;
        const minutes = global.Fare.estimateMinutes(km, vehType);
        const q = global.Fare.quote({ km: km, minutes: minutes, vehicleType: vehType, surge: chance(0.12) ? 1.2 : 1 });

        // Status mix
        let status, paymentStatus;
        const roll = rnd();
        const isToday = dayAgo === 0;
        if (isToday && roll > 0.93) {
          status = pick(['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'RIDE_STARTED']);
          paymentStatus = 'Pending';
        } else if (roll < 0.085) {
          status = chance(0.6) ? 'CANCELLED_BY_PASSENGER' : 'CANCELLED_BY_DRIVER';
          paymentStatus = 'Pending';
        } else if (roll < 0.14) {
          status = 'RIDE_COMPLETED';
          paymentStatus = 'Pending';
        } else {
          status = 'PAYMENT_COMPLETED';
          paymentStatus = 'Paid';
        }

        const rideId = 'ride_' + (seq++);
        const rideCode = 'PTK-' + String(seq).slice(-5) + (chance(0.5) ? 'A' : 'B');
        const isDone = status === 'RIDE_COMPLETED' || status === 'PAYMENT_COMPLETED';
        const isCancelled = status.indexOf('CANCELLED') === 0;
        const pax = pick(PASSENGERS);
        const paxId = 'pax_' + (PASSENGERS.indexOf(pax) + 1);

        const actualKm = isDone ? global.Fare.roundTo(km * between(0.95, 1.12), 2) : 0;
        const actualMinutes = isDone ? Math.round(minutes * between(0.9, 1.25)) : 0;

        const ride = {
          id: rideId, ride_code: rideCode,
          passenger_id: paxId, passenger_user_id: pax.id,
          driver_id: (status === 'SEARCHING_DRIVER' ? '' : drv.id),
          driver_user_id: (status === 'SEARCHING_DRIVER' ? '' : drv.userId),
          vehicle_id: (status === 'SEARCHING_DRIVER' ? '' : 'veh_' + drv.id),
          vehicle_type: vehType, status: status,
          pickup_label: from.label, pickup_lat: from.lat, pickup_lng: from.lng,
          dropoff_label: to.label, dropoff_lat: to.lat, dropoff_lng: to.lng,
          distance_km: global.Fare.roundTo(km, 2),
          duration_min: Math.round(minutes),
          actual_km: actualKm, actual_minutes: actualMinutes,
          base_fare: q.baseFare, distance_charge: q.distanceCharge, time_charge: q.timeCharge,
          surge: q.surge, discount: 0,
          fare_total: isCancelled ? 0 : q.total,
          commission_pct: q.commissionPct,
          commission_amount: isCancelled ? 0 : q.commission,
          driver_earning: isCancelled ? 0 : q.driverEarning,
          payment_method: pick(['cash', 'cash', 'cash', 'bkash', 'wallet']),
          payment_status: paymentStatus,
          start_otp: String(intBetween(1000, 9999)),
          cancel_reason: isCancelled ? pick(['changed_plan', 'driver_too_far', 'found_other_ride', 'waited_too_long']) : '',
          cancelled_by: isCancelled ? (status === 'CANCELLED_BY_PASSENGER' ? 'passenger' : 'driver') : '',
          cancellation_fee: isCancelled && status === 'CANCELLED_BY_DRIVER' ? 0 : (isCancelled ? (chance(0.35) ? settings.get('cancellationFee') : 0) : 0),
          city: 'Dhaka', area: from.label.split(',').pop().trim(),
          matched_driver_attempts: intBetween(1, 4),
          created_at: created,
          search_started_at: created + 2000,
          assigned_at: status === 'SEARCHING_DRIVER' ? 0 : created + intBetween(8, 45) * 1000,
          arrived_at: ['DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'PAYMENT_COMPLETED'].indexOf(status) !== -1 ? created + intBetween(3, 11) * 60000 : 0,
          started_at: ['RIDE_STARTED', 'RIDE_COMPLETED', 'PAYMENT_COMPLETED'].indexOf(status) !== -1 ? created + intBetween(6, 14) * 60000 : 0,
          completed_at: isDone ? created + intBetween(20, 60) * 60000 : 0,
          cancelled_at: isCancelled ? created + intBetween(1, 9) * 60000 : 0,
          paid_at: paymentStatus === 'Paid' ? created + intBetween(25, 65) * 60000 : 0
        };
        rides.push(ride);

        if (isDone) {
          payments.push({
            id: 'pay_' + rideId, ride_id: rideId, ride_code: rideCode,
            passenger_id: paxId, driver_id: drv.id,
            amount: q.total, currency: 'BDT', method: ride.payment_method,
            status: paymentStatus,
            gateway: ride.payment_method === 'cash' ? 'manual' : ride.payment_method,
            gateway_txn_id: ride.payment_method === 'cash' ? '' : ('TXN' + intBetween(100000, 999999)),
            commission_amount: q.commission, driver_earning: q.driverEarning,
            refund_amount: 0, failure_reason: '',
            paid_at: ride.paid_at, created_at: created
          });

          commissions.push({
            id: 'com_' + rideId, driver_id: drv.id, driver_user_id: drv.userId,
            ride_id: rideId, ride_code: rideCode,
            gross_fare: q.total, commission_amount: q.commission, net_earning: q.driverEarning,
            payment_method: ride.payment_method,
            period_date: new Date(created).toISOString().slice(0, 10),
            status: paymentStatus === 'Paid' ? 'accrued' : 'accrued',
            payout_id: '', created_at: created
          });
        }

        if (isCancelled) {
          cancellations.push({
            id: 'can_' + rideId, ride_id: rideId, ride_code: rideCode,
            cancelled_by: ride.cancelled_by, actor_user_id: ride.cancelled_by === 'passenger' ? pax.id : drv.userId,
            reason_code: ride.cancel_reason,
            reason_text: { changed_plan: 'Changed plan', driver_too_far: 'Driver too far', found_other_ride: 'Found another ride', waited_too_long: 'Waited too long' }[ride.cancel_reason] || ride.cancel_reason,
            fee_charged: ride.cancellation_fee, fee_waived: ride.cancellation_fee === 0,
            status_at_cancel: ride.cancelled_by === 'passenger' ? 'DRIVER_ARRIVING' : 'DRIVER_ASSIGNED',
            counts_toward_limit: ride.cancellation_fee > 0, created_at: created
          });
        }

        // Ratings for ~72% of finished rides, from both sides
        if (isDone && chance(0.72)) {
          const stars = chance(0.86) ? intBetween(4, 5) : intBetween(2, 4);
          ratings.push({
            id: 'rat_' + rideId + '_p', ride_id: rideId, rater_id: pax.id, rater_role: 'passenger',
            ratee_id: drv.userId, ratee_role: 'driver', stars: stars,
            comment: stars === 5 ? pick(['Great driver, very polite.', 'Smooth ride, highly recommended.', 'অনেক ভালো ড্রাইভার।', 'পথ চিনে নিয়ে গেছেন দ্রুত।'])
              : stars === 4 ? pick(['Good ride overall.', 'Nice and clean vehicle.', 'ঠিকঠাক ছিল।'])
              : pick(['Drove a bit fast.', 'Vehicle was not very clean.', 'একটু দেরি করেছেন।']),
            tags: stars >= 4 ? ['safe_driving'] : ['rough_driving'],
            flagged: false, flag_reason: '', created_at: ride.completed_at + 120000
          });
          if (chance(0.5)) {
            ratings.push({
              id: 'rat_' + rideId + '_d', ride_id: rideId, rater_id: drv.userId, rater_role: 'driver',
              ratee_id: pax.id, ratee_role: 'passenger', stars: intBetween(4, 5),
              comment: pick(['Polite passenger.', 'On time at pickup.', 'ভদ্র যাত্রী।', '']),
              tags: [], flagged: false, flag_reason: '', created_at: ride.completed_at + 180000
            });
          }
        }
      }
    }

    // Bulk insert in batches to keep the API comfortable
    await batchInsert('rides', rides);
    await batchInsert('payments', payments);
    await batchInsert('ratings', ratings);
    await batchInsert('commissions', commissions);
    await batchInsert('cancellations', cancellations);

    // Live GPS trail for the rides still in progress
    const active = rides.filter(function (r) { return global.RideState.isActive(r.status); });
    const locs = [];
    active.forEach(function (r) {
      const drv = DRIVER_BY_ID[r.driver_id];
      if (!drv) return;
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const p = global.PothikGeo.lerp({ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng }, t);
        locs.push({
          id: global.DB.uid('loc'), ride_id: r.id, actor: 'driver', driver_id: r.driver_id,
          lat: jitter(p.lat, 0.002), lng: jitter(p.lng, 0.002),
          heading: Math.round(global.PothikGeo.bearing({ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng })),
          speed_kmh: intBetween(12, 42), accuracy: intBetween(5, 15),
          recorded_at: r.created_at + i * 60000, created_at: NOW
        });
      }
    });
    await batchInsert('ride_locations', locs);

    await seedSupportAndOps(rides);
  }

  /**
   * Insert rows with bounded concurrency + automatic rate-limit backoff.
   * Uses DB.createMany so a burst of writes can never trip the API's rate
   * limiter and silently drop rows.
   */
  async function batchInsert(table, rows, concurrency) {
    if (!rows || !rows.length) return { inserted: 0, failed: 0 };
    return global.DB.createMany(table, rows, {
      concurrency: concurrency || 4,
      onError: function (err) {
        // Keep a record of the first failure for diagnostics, don't abort.
        if (!batchInsert.lastError) batchInsert.lastError = { table: table, message: err && err.message, status: err && err.status };
      }
    });
  }

  async function seedSupportAndOps(rides) {
    const recent = rides.slice(-8).reverse();

    const tickets = [
      { cat: 'payment', subject: 'Cash change not available', msg: 'The driver did not have change for a ৳1000 note.', status: 'open', priority: 'normal', pax: 0 },
      { cat: 'ride', subject: 'Driver took a longer route', msg: 'The route taken was much longer than the app suggested.', status: 'in_progress', priority: 'normal', pax: 1 },
      { cat: 'lost', subject: 'Left my bag in the car', msg: 'I left a black backpack on the rear seat. Please help.', status: 'open', priority: 'high', pax: 2 },
      { cat: 'safety', subject: 'Driver was speeding', msg: 'The driver was driving very fast on Mirpur Road.', status: 'resolved', priority: 'urgent', pax: 3 },
      { cat: 'other', subject: 'App language question', msg: 'How do I switch the app back to Bangla?', status: 'closed', priority: 'low', pax: 4 }
    ];
    const ticketRows = tickets.map(function (t, i) {
      const created = NOW - intBetween(1, 9) * DAY;
      return {
        id: 'tkt_' + (i + 1), ticket_code: 'SUP-' + (10240 + i),
        user_id: PASSENGERS[t.pax].id, user_role: 'passenger',
        ride_id: recent[i] ? recent[i].id : '', category: t.cat,
        subject: t.subject, message: t.msg, attachment_url: '',
        priority: t.priority, status: t.status,
        assigned_to: t.status === 'open' ? '' : ADMIN.id,
        resolution: t.status === 'resolved' || t.status === 'closed' ? 'Resolved by support team.' : '',
        reported_user_id: t.cat === 'safety' ? DRIVERS[3].userId : '',
        created_at: created,
        resolved_at: t.status === 'resolved' || t.status === 'closed' ? created + DAY : 0
      };
    });
    await batchInsert('support_tickets', ticketRows);

    // Notifications for passenger 1
    const notifRows = [
      { title: 'Welcome to Pothik', body: 'Thanks for riding with us. Use code POTHIK50 for ৳50 off your next ride.', type: 'promo' },
      { title: 'Your ride is complete', body: 'Thanks for riding. Please rate your driver.', type: 'payment' },
      { title: 'New safety features', body: 'You can now share your live trip with family.', type: 'info' },
      { title: 'Driver is on the way', body: 'Karim Sheikh is 3 minutes away.', type: 'ride' }
    ].map(function (n, i) {
      return {
        id: 'ntf_seed_' + i, user_id: PASSENGERS[0].id, audience: 'user', role: 'passenger',
        title: n.title, body: n.body, type: n.type, ride_id: '',
        channel: 'inapp', is_read: i > 1, read_at: i > 1 ? NOW - DAY : 0,
        created_at: NOW - (i + 1) * DAY
      };
    });
    await batchInsert('notifications', notifRows);

    // Audit log entries
    const auditRows = [
      { action: 'SEED_DEMO_DATA', entity: 'system', actor_role: 'system' },
      { action: 'DRIVER_APPROVED', entity: 'drivers', entity_id: 'drv_1', actor_role: 'admin' },
      { action: 'DRIVER_APPROVED', entity: 'drivers', entity_id: 'drv_2', actor_role: 'admin' },
      { action: 'DRIVER_APPROVED', entity: 'drivers', entity_id: 'drv_3', actor_role: 'admin' },
      { action: 'DRIVER_SUSPENDED', entity: 'drivers', entity_id: 'drv_8', actor_role: 'admin' },
      { action: 'FARE_UPDATED', entity: 'vehicle_types', entity_id: 'car', actor_role: 'admin' }
    ].map(function (a, i) {
      return {
        id: 'log_seed_' + i, actor_id: a.actor_role === 'admin' ? ADMIN.id : 'system',
        actor_role: a.actor_role, action: a.action, entity: a.entity,
        entity_id: a.entity_id || '', meta: '{}', ip_hash: '',
        created_at: NOW - (i + 1) * 3600000
      };
    });
    await batchInsert('audit_logs', auditRows);

    // Saved places for passenger 1
    const placeRows = [
      { kind: 'home', label: 'Home · Dhanmondi 27', lat: 23.7509, lng: 90.3742 },
      { kind: 'work', label: 'Work · Gulshan 2 Circle', lat: 23.7925, lng: 90.4150 },
      { kind: 'saved', label: 'Bashundhara City Mall', lat: 23.7509, lng: 90.3900 },
      { kind: 'saved', label: 'Shahjalal International Airport', lat: 23.8433, lng: 90.3978 },
      { kind: 'recent', label: 'Uttara Sector 7', lat: 23.8687, lng: 90.3950 },
      { kind: 'recent', label: 'Farmgate', lat: 23.7570, lng: 90.3890 }
    ].map(function (p, i) {
      return {
        id: 'sp_seed_' + i, user_id: PASSENGERS[0].id, role: 'passenger',
        ride_id: '', pickup_label: '', dropoff_label: '',
        lat: p.lat, lng: p.lng, label: p.label, kind: p.kind,
        created_at: NOW - (i + 1) * DAY
      };
    });
    await batchInsert('saved_places', placeRows);
  }

  global.Seed = {
    ensure: ensure,
    reset: function () { global.Store.remove(FLAG); },
    /** Force a full re-seed from the console: await Pothik.Seed.reseed() */
    reseed: async function () {
      global.Store.remove(FLAG);
      try {
        const rows = await global.DB.list('rides', { limit: 300 });
        await global.DB.createMany('rides', []); // no-op keeps API shape obvious
        return await run();
      } catch (e) {
        return await run();
      }
    }
  };
})(window);
