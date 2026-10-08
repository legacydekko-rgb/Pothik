/* ==========================================================================
   Pothik — Auth
   --------------------------------------------------------------------------
   Passwords are hashed with PBKDF2-SHA256 (150k iterations, random 16-byte
   salt) via the Web Crypto API. Sessions are token-based with an expiry.

   ⚠️  SECURITY NOTICE — READ THIS
   This is a *client-side* implementation. It is functionally complete and
   demonstrates correct hashing and role separation, but because all code runs
   in the visitor's browser, a determined user can bypass it (read the stored
   token, edit localStorage, etc.). It is NOT a substitute for server-side
   authentication.
   For production you MUST authenticate against the NestJS backend in
   /backend (bcrypt + JWT + refresh tokens) — the API contract is identical.
   ========================================================================== */
(function (global) {
  'use strict';

  const SESSION_KEY = 'auth.session';
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const OTP_TTL_MS = 5 * 60 * 1000;                // 5 minutes
  const PBKDF2_ITERATIONS = 150000;

  /* ------------------------------------------------------------ hashing */
  function bytesToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function randomHex(bytes) {
    const a = new Uint8Array(bytes || 16);
    crypto.getRandomValues(a);
    return bytesToHex(a);
  }

  async function pbkdf2(password, saltHex, iterations) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial, 256
    );
    return bytesToHex(bits);
  }

  /** Returns "pbkdf2$<iterations>$<salt>$<hash>" */
  async function hashPassword(password) {
    const salt = randomHex(16);
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + salt + '$' + hash;
  }

  async function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const expected = parts[3];
    const actual = await pbkdf2(password, salt, iterations);
    // Constant-time-ish comparison
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }

  /* ---------------------------------------------------------------- OTP */
  function generateOtp() {
    // 6 digits, crypto-strong
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return String(a[0] % 1000000).padStart(6, '0');
  }

  function storeOtp(phone, code, purpose) {
    global.Store.set('otp.' + phone, {
      code: code, purpose: purpose || 'login', expires: Date.now() + OTP_TTL_MS, attempts: 0
    });
  }

  function checkOtp(phone, code) {
    const rec = global.Store.get('otp.' + phone, null);
    if (!rec) return { ok: false, reason: 'expired' };
    if (Date.now() > rec.expires) { global.Store.remove('otp.' + phone); return { ok: false, reason: 'expired' }; }
    if (rec.attempts >= 5) { global.Store.remove('otp.' + phone); return { ok: false, reason: 'locked' }; }
    if (String(rec.code) !== String(code)) {
      rec.attempts++;
      global.Store.set('otp.' + phone, rec);
      return { ok: false, reason: 'mismatch', attemptsLeft: 5 - rec.attempts };
    }
    global.Store.remove('otp.' + phone);
    return { ok: true };
  }

  /* ------------------------------------------------------------- session */
  function saveSession(session) {
    global.Store.set(SESSION_KEY, session);
    global.dispatchEvent(new CustomEvent('pothik:authchange', { detail: session }));
  }

  function getSession() {
    const s = global.Store.get(SESSION_KEY, null);
    if (!s) return null;
    if (s.expires && Date.now() > s.expires) {
      global.Store.remove(SESSION_KEY);
      return null;
    }
    return s;
  }

  function logout() {
    global.Store.remove(SESSION_KEY);
    global.dispatchEvent(new CustomEvent('pothik:authchange', { detail: null }));
  }

  function makeSession(user, role, extra) {
    return Object.assign({
      token: 'sess_' + randomHex(24),
      userId: user.id,
      role: role,
      name: user.full_name || user.name || '',
      phone: user.phone || '',
      issued: Date.now(),
      expires: Date.now() + SESSION_TTL_MS
    }, extra || {});
  }

  /* ------------------------------------------------------------- signup */
  /**
   * Register a new account.
   * @param role 'passenger' | 'driver' | 'admin'
   */
  async function register(params) {
    const phone = global.PothikGeo.normalizePhone(params.phone);
    if (!global.PothikGeo.isValidBdPhone(phone)) throw new Error('auth.invalidPhone');
    if (!params.fullName || params.fullName.trim().length < 2) throw new Error('auth.nameRequired');
    if (!params.password || params.password.length < 6) throw new Error('auth.passwordShort');

    const existing = await global.DB.findWhere('users', function (u) {
      return global.PothikGeo.normalizePhone(u.phone) === phone;
    });
    if (existing) throw new Error('auth.phoneTaken');

    const passwordHash = await hashPassword(params.password);
    const nowTs = Date.now();

    const user = await global.DB.create('users', {
      phone: phone,
      phone_e164: global.PothikGeo.toE164(phone),
      phone_verified: true,
      full_name: params.fullName.trim(),
      email: params.email || '',
      password_hash: passwordHash,
      role: params.role || 'passenger',
      language: params.language || (global.I18n ? global.I18n.getLang() : 'bn'),
      status: 'active',
      photo_url: '',
      emergency_contact: params.emergencyContact || '',
      created_at: nowTs,
      last_login_at: nowTs
    });

    // Role-specific satellite rows
    if (user.role === 'passenger') {
      await global.DB.create('passengers', {
        id: global.DB.uid('pax'), user_id: user.id,
        rating: 5.0, total_ratings: 0, total_rides: 0, total_spent: 0,
        wallet_balance: 0, cancellations: 0, status: 'active', created_at: nowTs
      });
    } else if (user.role === 'driver') {
      const driver = await global.DB.create('drivers', {
        id: global.DB.uid('drv'), user_id: user.id,
        full_name: user.full_name, phone: phone,
        nid_number: params.nidNumber || '',
        nid_front_url: '', nid_back_url: '',
        licence_number: params.licenceNumber || '',
        licence_url: '',
        photo_url: '',
        rating: 5.0, total_ratings: 0, completed_rides: 0, cancelled_rides: 0,
        acceptance_rate: 1.0, rejection_count: 0,
        status: 'pending',            // ← admin must approve
        submitted_at: nowTs,
        created_at: nowTs
      });
      await global.DB.create('driver_status', {
        id: global.DB.uid('ds'), driver_id: driver.id, user_id: user.id,
        is_online: false, availability: 'offline',
        lat: null, lng: null, heading: null, accuracy: null,
        last_ping_at: 0, active_ride_id: null,
        rating: 5.0, acceptance_rate: 1.0, completed_rides: 0,
        vehicle_type: params.vehicleType || '',
        vehicle_id: null, updated_at: nowTs
      });
      await global.DB.create('audit_logs', {
        id: global.DB.uid('log'), actor_id: user.id, actor_role: 'driver',
        action: 'DRIVER_REGISTERED', entity: 'drivers', entity_id: driver.id,
        meta: JSON.stringify({ phone: phone }), created_at: nowTs
      });
      return { user: user, driver: driver, session: makeSession(user, 'driver', { driverId: driver.id, driverStatus: 'pending' }) };
    } else if (user.role === 'admin') {
      await global.DB.create('admin_users', {
        id: global.DB.uid('adm'), user_id: user.id, full_name: user.full_name,
        email: params.email || '', role: 'admin', permissions: 'all',
        status: 'active', created_at: nowTs
      });
    }

    return { user: user, session: makeSession(user, user.role) };
  }

  /* --------------------------------------------------------------- login */
  async function login(phoneRaw, password, role) {
    const phone = global.PothikGeo.normalizePhone(phoneRaw);
    const user = await global.DB.findWhere('users', function (u) {
      return global.PothikGeo.normalizePhone(u.phone) === phone;
    });
    if (!user) throw new Error('auth.notFound');
    if (role && user.role !== role && user.role !== 'admin') throw new Error('err.notAllowed');
    if (user.status === 'blocked' || user.status === 'suspended') throw new Error('err.notAllowed');

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw new Error('auth.wrongPassword');

    await global.DB.update('users', user.id, { last_login_at: Date.now() });
    let extra = {};
    if (user.role === 'driver') {
      const driver = await global.DB.findWhere('drivers', function (d) { return d.user_id === user.id; });
      extra = { driverId: driver ? driver.id : null, driverStatus: driver ? driver.status : 'pending' };
    }
    return { user: user, session: makeSession(user, user.role, extra) };
  }

  /** OTP-only login (used when an account already exists). */
  async function loginWithOtp(phoneRaw, role) {
    const phone = global.PothikGeo.normalizePhone(phoneRaw);
    const user = await global.DB.findWhere('users', function (u) {
      return global.PothikGeo.normalizePhone(u.phone) === phone;
    });
    if (!user) throw new Error('auth.notFound');
    if (role && user.role !== role && user.role !== 'admin') throw new Error('err.notAllowed');
    await global.DB.update('users', user.id, { last_login_at: Date.now(), phone_verified: true });
    let extra = {};
    if (user.role === 'driver') {
      const driver = await global.DB.findWhere('drivers', function (d) { return d.user_id === user.id; });
      extra = { driverId: driver ? driver.id : null, driverStatus: driver ? driver.status : 'pending' };
    }
    return { user: user, session: makeSession(user, user.role, extra) };
  }

  /** Ask whether a phone number is already registered. */
  async function exists(phoneRaw) {
    const phone = global.PothikGeo.normalizePhone(phoneRaw);
    const user = await global.DB.findWhere('users', function (u) {
      return global.PothikGeo.normalizePhone(u.phone) === phone;
    });
    return user || null;
  }

  /* -------------------------------------------------------- current user */
  async function currentUser() {
    const s = getSession();
    if (!s) return null;
    try {
      return await global.DB.get('users', s.userId);
    } catch (e) {
      return null;
    }
  }

  async function currentPassenger() {
    const s = getSession();
    if (!s || s.role !== 'passenger') return null;
    return global.DB.findWhere('passengers', function (p) { return p.user_id === s.userId; });
  }

  async function currentDriver() {
    const s = getSession();
    if (!s || s.role !== 'driver') return null;
    if (s.driverId) {
      try { return await global.DB.get('drivers', s.driverId); } catch (e) { /* fall through */ }
    }
    return global.DB.findWhere('drivers', function (d) { return d.user_id === s.userId; });
  }

  function requireRole(role) {
    const s = getSession();
    if (!s) return false;
    if (s.role === role) return true;
    if (role === 'admin' && s.role === 'admin') return true;
    return false;
  }

  /** Guard for pages: redirects to the right login when not authorised. */
  function guard(role, loginUrl) {
    const s = getSession();
    if (!s) { location.replace(loginUrl || 'login.html?role=' + role); return null; }
    if (s.role !== role && !(role === 'passenger' && s.role === 'admin')) {
      location.replace(loginUrl || 'login.html?role=' + role);
      return null;
    }
    return s;
  }

  /* ------------------------------------------------------------ audit log */
  async function audit(actorId, actorRole, action, entity, entityId, meta) {
    try {
      await global.DB.create('audit_logs', {
        id: global.DB.uid('log'), actor_id: actorId || 'system', actor_role: actorRole || 'system',
        action: action, entity: entity || '', entity_id: entityId || '',
        meta: meta ? JSON.stringify(meta) : '', created_at: Date.now()
      });
    } catch (e) { /* audit must never break the flow */ }
  }

  global.Auth = {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    generateOtp: generateOtp,
    storeOtp: storeOtp,
    checkOtp: checkOtp,
    register: register,
    login: login,
    loginWithOtp: loginWithOtp,
    exists: exists,
    logout: logout,
    getSession: getSession,
    saveSession: saveSession,
    currentUser: currentUser,
    currentPassenger: currentPassenger,
    currentDriver: currentDriver,
    requireRole: requireRole,
    guard: guard,
    audit: audit,
    SESSION_TTL_MS: SESSION_TTL_MS
  };
})(window);
