# API Keys — exactly where to paste each one

Every key below goes in **`.env`** (server-side only) unless stated otherwise.
Never put a secret in HTML/JS. Copy `.env.example` → `.env` first.

---

## 1. Google Maps (optional — the demo works without it)

The app ships with **Leaflet + OpenStreetMap + OSRM**, which needs **no key**.
Switch to Google only if you want Google tiles, Places Autocomplete, or Google routing.

1. Go to <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → enable:
   - Maps SDK for Android
   - Places API
   - Directions API
   - Geocoding API
   - Distance Matrix API
3. **Credentials → Create credentials → API key** → create **four** keys so you can
   restrict each one separately.
4. Restrict each key:
   - Android keys → *Application restriction: Android apps* → add package name
     `com.pothik.rider` and the SHA-1 fingerprint of your release keystore.
   - Web keys → *Application restriction: HTTP referrers* → your admin/passenger domain.

**Paste here:**

| Key | `.env` variable | Also needed in |
|---|---|---|
| Android Maps SDK | — (not in .env) | `android/app/src/main/AndroidManifest.xml` |
| JS Maps API | `GOOGLE_MAPS_API_KEY` | — |
| Places API | `GOOGLE_PLACES_API_KEY` | — |
| Directions API | `GOOGLE_DIRECTIONS_API_KEY` | — |
| Geocoding API | `GOOGLE_GEOCODING_API_KEY` | — |

Then set `MAP_PROVIDER=google`.

**Android manifest** — open `android/app/src/main/AndroidManifest.xml` and put your
Android key here, replacing the placeholder:

```xml
<meta-data
    android:name="com.google.android.geo.API_KEY"
    android:value="YOUR_ANDROID_MAPS_API_KEY" />
```

> Billing must be enabled on the Google Cloud project. New accounts get free credit.

---

## 2. Firebase Cloud Messaging (push notifications)

1. <https://console.firebase.google.com> → **Add project**.
2. **Add app → Android**. Package names:
   - Passenger: `com.pothik.rider`
   - Driver: `com.pothik.driver`
3. Download **`google-services.json`** for each app.
4. **Project settings → Service accounts → Generate new private key** → downloads a JSON.

**Paste here:**

- Passenger app: save as `android/app/google-services.json`
- Driver app: save as `android/app/google-services.json` in the driver project
- Server key: open the downloaded service-account JSON and copy fields into `.env`:

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```
> Keep the `\n` escapes and the surrounding quotes exactly as they are.

Or paste the whole file as one line into `FIREBASE_SERVICE_ACCOUNT_JSON`.

### Web Push (the PWA's own push — separate from FCM)
```bash
npx web-push generate-vapid-keys
```
```env
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:support@pothik.com.bd
```
The **public** key is the only one that may reach the browser. Put it into the
`vapidPublicKey` row of the `platform_settings` table (admin → Settings) so
`js/core/notify.js` can subscribe.

---

## 3. SMS / OTP gateway (Bangladesh)

Without this, OTPs are generated in-browser and shown on screen — demo only.

Pick an aggregator and fill in its block in `.env`:

| Provider | `.env` prefix | Where to get keys |
|---|---|---|
| SSLWireless | `SMS_*` with `SMS_PROVIDER=sslwireless` | sslwireless.com → Bulk SMS API |
| Robi | `SMS_PROVIDER=robi` | Robi enterprise portal |
| Banglalink | `SMS_PROVIDER=banglalink` | Banglalink enterprise |
| Twilio | `SMS_PROVIDER=twilio` | twilio.com console |

```env
SMS_PROVIDER=sslwireless
SMS_API_KEY=...
SMS_API_SECRET=...
SMS_SENDER_ID=POTHIK
```

---

## 4. Payment gateways

⚠️ **Server-side only.** Never call these from the browser. Never store card
numbers, CVVs, or PINs — tokenised references only.

### bKash (Merchant / Checkout)
1. Apply at <https://developer.bka.sh> (sandbox first).
2. Credentials → *API Credentials*.

```env
BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v1.2.0-beta
BKASH_APP_KEY=...
BKASH_APP_SECRET=...
BKASH_USERNAME=...
BKASH_PASSWORD=...
BKASH_CALLBACK_URL=https://api.pothik.com.bd/payments/bkash/callback
```

### Nagad
```env
NAGAD_BASE_URL=https://sandbox.mynagad.com
NAGAD_MERCHANT_ID=...
NAGAD_MERCHANT_PRIVATE_KEY=...
NAGAD_PG_PUBLIC_KEY=...
```

### SSLCommerz (cards + mobile banking)
```env
SSLCZ_STORE_ID=...
SSLCZ_STORE_PASSWORD=...
SSLCZ_SANDBOX=true
```

After the integration is live, turn the method **on** in
Admin → System settings (the `bkashEnabled` / `nagadEnabled` / `cardEnabled` rows).

---

## 5. Database & Redis (production backend)

```bash
openssl rand -hex 32   # use for JWT secrets
```

```env
DATABASE_URL=postgresql://user:pass@host:5432/pothik
REDIS_URL=redis://localhost:6379
JWT_SECRET=<paste the generated hex>
JWT_REFRESH_SECRET=<paste a second generated hex>
```

Create the schema with `db/schema.postgres.sql`.

---

## 6. Document storage (R2 / S3)

Driver NID, licence and vehicle photos.

```env
STORAGE_DRIVER=s3
S3_BUCKET=pothik-documents
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://cdn.pothik.com.bd
```

---

## 7. Where the frontend reads configuration

| What | Where | Notes |
|---|---|---|
| API base URL | `js/core/db.js` → `API_BASE_OVERRIDE` | Set to your NestJS URL to leave the demo store |
| Web Push public key | `platform_settings.vapidPublicKey` | Public key only |
| All fare / matching / policy values | `platform_settings` + `vehicle_types` tables | Edited live in Admin → Fare settings |
| Payment method switches | `platform_settings` (`*Enabled`) | Keep OFF until the gateway is live |
| Android Maps key | `AndroidManifest.xml` | Build-time |

**Rule of thumb:** if a value is a secret, it lives in `.env` and is only ever read
by server code. If it is a tunable business value, it lives in the database so the
admin can change it without a redeploy.
