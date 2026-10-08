# পথিক · Pothik — Ride-Sharing Platform for Bangladesh 🇧🇩

**পথিক** (Pothik, "wayfarer") is a complete ride-sharing platform built for Bangladesh:
Bike · CNG · Car, BDT ৳ pricing, Bangla-first UI, real GPS, real maps, real matching.

> ⚠️ **Read `docs/SECURITY.md` before going live.** The admin gate in this build is
> client-side and is **not secure**. Production requires the NestJS backend.

---

## 1. What is actually working (verified)

| Area | Status | Notes |
|---|---|---|
| Passenger app | ✅ | Booking → estimate → matching → live trip → payment → rating |
| Driver app | ✅ | Registration + document upload, approval gate, online toggle, accept ride, trip lifecycle, earnings, ratings |
| Admin dashboard | ✅ | 10 KPIs, 5 live charts, driver approval with document review, fare/commission editor, live ride monitor, CSV exports |
| Database | ✅ | 19 tables, live read/write over the platform REST table API |
| Real GPS | ✅ | `navigator.geolocation.watchPosition` — real satellite fixes, no simulation |
| Real maps + routing | ✅ | Leaflet + OpenStreetMap + OSRM road routing (**no API key needed**) |
| Driver matching | ✅ | Proximity filter → scoring (distance/freshness/rating/acceptance) → sequential offers with timeout → optimistic lock so two passengers can't take one driver |
| Fare engine | ✅ | DB-driven, per-vehicle-type, admin-editable; base + per-km + per-minute, min fare, surge, discount, commission split |
| Ride state machine | ✅ | 11 statuses, invalid transitions rejected |
| Notifications | ✅ | In-app centre + BroadcastChannel live delivery + Web Push (VAPID) + service worker |
| Auth | ⚠️ | PBKDF2-SHA256 (150k iters, random salt), roles, sessions — **functionally complete but client-side, therefore bypassable** |
| Offline queue | ✅ | Writes queue and flush on reconnect, with 429/5xx backoff |
| Native APK/AAB | ✅ | Built **in the cloud by GitHub Actions** — no Android Studio needed. See `BUILD-APK-BANGLA.md` |
| NestJS + PostgreSQL | 🟡 | Schema + API contract + build plan provided; not running here |

> ✅ **Fixed this round:** `Unexpected identifier 'state'` (which killed the whole
> passenger app) was caused by `function get state() { return S; }` in
> `js/app/passenger-ride.js` — an accessor declaration in a plain function
> position, invalid in strict mode. It is now a normal `getState()` function, and
> `scripts/check-syntax.mjs` compiles every script in CI so this class of bug can
> never ship again. All three apps now load with a clean console.

---

## 2. Quick start

Open the site. Demo data seeds itself on first load (~80 s, writes ~470 rows).

### Demo accounts

| Role | Phone | Password |
|---|---|---|
| Passenger | `1711100001` | `passenger123` |
| Passenger | `1811100002` | `passenger123` |
| Driver (approved) | `1712000001` | `driver123` |
| Driver (pending approval — use to test the approval flow) | `1712000006` | `driver123` |
| Admin | `1700000001` | `admin1234` |

### Entry points

| Path | Role |
|---|---|
| `index.html` | Landing / role picker |
| `login.html?role=passenger` · `login.html?role=driver` | Auth (phone → OTP → session) |
| `app/index.html` | Passenger app |
| `driver/index.html` | Driver app |
| `admin/index.html` | Admin dashboard |
| `terms.html` · `privacy.html` | Legal |

### Testing the matching engine with one device

Set **Demo auto-accept ON** (passenger Settings). If no real driver is online, the
platform creates a marked-simulated driver near your pickup and completes the full
flow so you can walk the entire journey. **Turn it OFF in production.**

To test *real* two-sided matching, open the driver app on a second device, log in as
`1712000001`, go online, then request a ride from the passenger app — the driver
receives a live offer with a countdown and can Accept/Decline.

---

## 3. Architecture

```
Browser (this repo)
├── Passenger PWA ─┐
├── Driver PWA    ─┼─→ js/core/*  ─→ REST table API (tables/{name})
└── Admin SPA     ─┘                  ↕
                            Preview store (CosmosDB) / LIVE store (Cloudflare D1)

Production target (reference impl in docs/, not running here)
├── Flutter apps ─→ NestJS API ─→ PostgreSQL + PostGIS
│                   ├─ Socket.IO for realtime GPS + ride events
│                   ├─ Firebase Cloud Messaging for push
│                   └─ Google Maps / OSRM for routing
└── React/Next admin ─→ same API
```

### Core modules (`js/core/`)

| File | Responsibility |
|---|---|
| `i18n.js` | Bangla + English dictionary, `t()`, live language switching |
| `db.js` | Persistence over the REST table API, offline queue, retry/backoff, `createMany`, `updateIf` (compare-and-set) |
| `geo.js` | Haversine, bearings, BD phone validation, Nominatim geocoding, OSRM routing, GPS watch, Bangla numerals, ৳ formatting |
| `settings.js` | DB-backed platform config + per-vehicle rates, cached offline |
| `fare.js` | Fare engine, cancellation policy, surge suggestion |
| `ride-state.js` | State machine + allowed transitions |
| `matching.js` | Candidate discovery, scoring, claim (optimistic lock), release, availability |
| `auth.js` | PBKDF2 hashing, OTP, sessions, roles, audit log |
| `notify.js` | In-app + Web Push + ride event presets |
| `ui.js` | Toasts, modals, sheets, stars, image compression, CSV export |
| `map.js` | Leaflet wrapper (pins, routes, radius, viewport) |
| `seed.js` | Idempotent, self-healing demo bootstrap |

---

## 4. Data model (19 tables)

`users` · `passengers` · `drivers` · `driver_status` · `vehicles` ·
`driver_documents` · `rides` · `ride_locations` · `payments` · `ratings` ·
`notifications` · `support_tickets` · `platform_settings` · `vehicle_types` ·
`cancellations` · `commissions` · `admin_users` · `audit_logs` · `saved_places` ·
`emergency_events`

Live definitions: `.tables/schema.json`.
PostgreSQL + PostGIS DDL for the production backend: `db/schema.postgres.sql`.

Key design notes:
- `driver_status.last_ping_at` drives liveness — a driver with no ping in 90 s is
  correctly treated as offline, so stale rows can never be matched.
- `driver_status.active_ride_id` + the compare-and-set in `Matching.claimRide()`
  are what prevent double-assignment.
- `rides` carries the full fare breakdown, so historical receipts stay accurate even
  after the admin changes rates.

---

## 5. Fare engine

```
fare   = max(minimumFare, (baseFare + km × perKm + minutes × perMinute) × surge) − discount
commission = fare × commissionPct / 100
driverEarning = fare − commission
```

Defaults (admin-editable, per vehicle type):

| | Base | Per km | Per min | Min fare | Commission |
|---|---|---|---|---|---|
| Bike | ৳30 | ৳12 | ৳1.20 | ৳40 | 15% |
| CNG | ৳45 | ৳16 | ৳1.60 | ৳55 | 15% |
| Car | ৳60 | ৳24 | ৳2.40 | ৳80 | 15% |

Worked example — 8.2 km, 24 min, Car:
`60 + (8.2 × 24) + (24 × 2.4) = 60 + 196.8 + 57.6 = ৳314.4`
→ platform ৳47.2, driver ৳267.2.

---

## 6. Ride state machine

```
REQUESTED → SEARCHING_DRIVER → DRIVER_ASSIGNED → DRIVER_ARRIVING
→ DRIVER_ARRIVED → RIDE_STARTED → RIDE_COMPLETED
→ PAYMENT_PENDING → PAYMENT_COMPLETED

Any non-terminal state → CANCELLED_BY_PASSENGER | CANCELLED_BY_DRIVER
```
`RideState.transition()` throws on any illegal edge, so a bad UI path can never
corrupt a ride.

---

## 7. Remaining work (honest list)

**✅ Done this round**
1. ~~`js/app/passenger.js` syntax error~~ — root cause found in
   `js/app/passenger-ride.js` (`function get state()`), fixed, and guarded by the new
   CI compile gate in `scripts/check-syntax.mjs`.
2. ~~Build the APK/AAB~~ — cloud build wired up: `.github/workflows/android.yml`
   (APK + signed APK + AAB + GitHub Release) and
   `.github/workflows/make-keystore.yml` (one-click signing certificate).
3. ~~Dead legal links~~ — `terms.html` and `privacy.html` created.

**Should do before launch**
4. Deploy the NestJS backend and point `DB.API_BASE_OVERRIDE` at it
   (`js/core/db.js`) — this is what makes auth actually secure.
5. Move `driver_documents.file_url` to R2/S3 object storage; the current compressed
   data-URL approach is fine for a demo but wasteful at scale.
6. Replace the browser OTP generator with a real SMS gateway (SSLWireless / Robi /
   Banglalink aggregator).
7. Wire bKash / Nagad / SSLCommerz server-side; only then flip the payment switches.
8. Add `googleMapsApiKey` if you prefer Google tiles/routing over OSM/OSRM.
9. Set `APP_URL` so both phone apps share one live database (see
   `BUILD-APK-BANGLA.md` step 5) — without it, real passenger↔driver matching
   across two devices cannot work.
10. For a warning-free install, publish to Google Play with the generated `.aab`.

**Nice to have**
8. Scheduled ride booking, promo codes, driver payout batching, in-app chat,
   PostGIS-backed spatial index for candidate lookup at scale.

---

## 8. Security — read this

- Secrets belong in `.env` only. Never in frontend code. See `.env.example`.
- Passwords are PBKDF2-hashed with per-user random salts, but the hash comparison
  happens in the browser — **a determined user can bypass the login entirely.**
- Admin route access rules are enforced by the platform dispatcher
  (`.meta/access-control.json`), which is real gatekeeping, but it is not a
  substitute for server-side authorisation of *data*.
- Full threat model and hardening checklist: `docs/SECURITY.md`.

---

## 9. Deployment

**Preview / quick share:** the Publish tab (`*.gensparkspace.com`) — serves the
preview data store.

**Live with its own database:** Hosted Deploy (`*.vip.gensparksite.com` or a custom
domain) — provisions a Cloudflare D1 database from `.tables/schema.json` and an R2
bucket for binary assets. The live database starts **empty**; seed it by loading the
site once, or copy preview rows across with the sync tool.

> Pick **one** public URL. The preview store and the live D1 store are never
> synced, so visitor data lands in whichever one your users actually open.

---

## 10. Documentation index

| Document | Contents |
|---|---|
| **`BUILD-APK-BANGLA.md`** | **📱 সম্পূর্ণ বাংলা গাইড — GitHub থেকে APK বানানো, সার্টিফিকেট, ইনস্টল। শুরু এখান থেকে।** |
| `docs/README-BUILD.md` | Same cloud-build walkthrough in English |
| `docs/ANDROID-BUILD.md` | Capacitor → APK / AAB recipe for a local machine (if you ever install Android Studio) |
| `docs/API-KEYS.md` | Every API key and exactly where to paste it |
| `.env.example` | Every environment variable, documented |
| `terms.html` · `privacy.html` | Service terms and privacy policy (Bangla + English) |
| `capacitor.config.json` | Native shell config: app id `com.pothik.ride`, webDir `www` |
| `.github/workflows/android.yml` | **The cloud build.** APK + signed APK + AAB + GitHub Release |
| `.github/workflows/make-keystore.yml` | One-click signing certificate generator |

### Build scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `check-syntax.mjs` | Compiles every `.js` the browser loads. Fails the build on any syntax error. |
| `copy-www.mjs` | Bundles the site into `www/` for the APK (explicit allow-list, so nothing private ships). |
| `gen-icon.mjs` | Generates all Android icons + splash screens from `assets/icon.svg`. |
| `patch-android.mjs` | Applies version, minSdk 24, permissions and app name to the generated project. |
| `set-app-url.mjs` | Points the APK at your live URL when the `APP_URL` secret is set. |
