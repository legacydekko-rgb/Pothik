/* ==========================================================================
   Pothik — Geo utilities
   Real geodesy (haversine), formatting, reverse geocoding via OpenStreetMap
   Nominatim, and road routing / ETA via the public OSRM demo server.
   No API key required for the default stack (Leaflet + OSM + OSRM).
   Swap in Google Maps by setting PothikGeo.setProvider('google') and adding
   a key in Settings (see js/core/settings.js and docs/API-KEYS.md).
   ========================================================================== */
(function (global) {
  'use strict';

  const R_EARTH_KM = 6371.0088;

  /* ------------------------------------------------------------- geodesy */
  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }

  /** Great-circle distance in km between two {lat,lng}. */
  function haversineKm(a, b) {
    if (!a || !b) return 0;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** Rough city-traffic correction: straight line -> road distance. */
  function roadKmEstimate(a, b, factor) {
    return haversineKm(a, b) * (factor || 1.35);
  }

  /** Initial bearing a -> b in degrees (0 = north). */
  function bearing(a, b) {
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Interpolate a point between a and b (t in 0..1). */
  function lerp(a, b, t) {
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  /** Bounding box for a set of points. */
  function bounds(points) {
    const pts = points.filter(Boolean);
    if (!pts.length) return null;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    pts.forEach(function (p) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    });
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  /* ---------------------------------------------------------- formatting */
  /** ৳1,250 (Bangla numerals when lang=bn). */
  function money(amount, lang) {
    const n = Math.round((Number(amount) || 0));
    const s = n.toLocaleString('en-US');
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    return '৳' + (useBn ? toBanglaDigits(s) : s);
  }

  function toBanglaDigits(str) {
    const map = { '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪', '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯' };
    return String(str).replace(/[0-9]/g, function (d) { return map[d]; });
  }

  function distance(km, lang) {
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    const val = km < 1 ? (km * 1000).toFixed(0) + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
    return useBn ? toBanglaDigits(val) : val;
  }

  function duration(min, lang) {
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    const m = Math.max(1, Math.round(min));
    let out;
    if (m < 60) out = m + ' min';
    else out = Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return useBn ? toBanglaDigits(out) : out;
  }

  function clockTime(ts, lang) {
    const d = new Date(ts);
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    let h = d.getHours(), mi = String(d.getMinutes()).padStart(2, '0');
    const ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    const out = h + ':' + mi + ' ' + ampm;
    return useBn ? toBanglaDigits(out) : out;
  }

  function dateTime(ts, lang) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const out = d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clockTime(ts, lang);
    return useBn ? toBanglaDigits(out) : out;
  }

  function relativeTime(ts, lang) {
    const diff = Date.now() - Number(ts);
    const mins = Math.floor(diff / 60000);
    const useBn = (lang || (global.I18n && global.I18n.getLang())) === 'bn';
    let out;
    if (mins < 1) out = 'just now';
    else if (mins < 60) out = mins + 'm ago';
    else if (mins < 1440) out = Math.floor(mins / 60) + 'h ago';
    else if (mins < 43200) out = Math.floor(mins / 1440) + 'd ago';
    else out = new Date(Number(ts)).toLocaleDateString();
    if (!useBn) return out;
    return toBanglaDigits(out).replace('just now', 'এইমাত্র').replace('m ago', ' মিনিট আগে')
      .replace('h ago', ' ঘণ্টা আগে').replace('d ago', ' দিন আগে');
  }

  /* ------------------------------------------------------------- BD phone */
  function normalizePhone(input) {
    let s = String(input || '').replace(/[\s\-()]/g, '');
    if (s.startsWith('+880')) s = s.slice(4);
    else if (s.startsWith('880')) s = s.slice(3);
    if (s.startsWith('0')) s = s.slice(1);
    return s;
  }

  function isValidBdPhone(input) {
    const s = normalizePhone(input);
    return /^1[3-9]\d{8}$/.test(s);
  }

  function formatBdPhone(input) {
    const s = normalizePhone(input);
    if (s.length !== 10) return s;
    return s.slice(0, 4) + '-' + s.slice(4, 7) + '-' + s.slice(7);
  }

  function toE164(input) { return '+880' + normalizePhone(input); }

  /* -------------------------------------------------- geocoding (Nominatim) */
  const geoCache = new Map();
  const NOMINATIM = 'https://nominatim.openstreetmap.org';

  async function reverseGeocode(lat, lng) {
    const k = lat.toFixed(5) + ',' + lng.toFixed(5);
    if (geoCache.has(k)) return geoCache.get(k);
    try {
      const res = await fetch(
        NOMINATIM + '/reverse?format=jsonv2&lat=' + lat + '&lon=' + lng + '&zoom=18&addressdetails=1',
        { headers: { 'Accept': 'application/json' } }
      );
      if (!res.ok) throw new Error('geocode ' + res.status);
      const d = await res.json();
      const a = d.address || {};
      const area = a.suburb || a.neighbourhood || a.city_district || a.village || a.town || a.city || '';
      const road = a.road || a.pedestrian || a.footway || '';
      const label = [road, area].filter(Boolean).join(', ') || d.display_name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
      const out = { label: label, full: d.display_name || label, area: area, city: a.city || a.town || a.state_district || '', lat: lat, lng: lng };
      geoCache.set(k, out);
      return out;
    } catch (e) {
      const fallback = { label: lat.toFixed(4) + ', ' + lng.toFixed(4), full: '', area: '', city: '', lat: lat, lng: lng };
      geoCache.set(k, fallback);
      return fallback;
    }
  }

  async function searchPlaces(query, near, limit) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const params = new URLSearchParams({
      format: 'jsonv2', q: q, limit: String(limit || 8),
      countrycodes: 'bd', addressdetails: '1', 'accept-language': global.I18n && global.I18n.getLang() === 'bn' ? 'bn,en' : 'en'
    });
    if (near && near.lat) {
      // Bias results to a ~40km box around the user
      const d = 0.35;
      params.set('viewbox', (near.lng - d) + ',' + (near.lat + d) + ',' + (near.lng + d) + ',' + (near.lat - d));
      params.set('bounded', '0');
    }
    try {
      const res = await fetch(NOMINATIM + '/search?' + params.toString(), { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('search ' + res.status);
      const arr = await res.json();
      return arr.map(function (d) {
        const a = d.address || {};
        const area = a.suburb || a.neighbourhood || a.city_district || a.village || a.town || a.city || '';
        const road = a.road || d.name || '';
        return {
          label: [road, area].filter(Boolean).join(', ') || d.display_name,
          full: d.display_name,
          area: area,
          lat: parseFloat(d.lat),
          lng: parseFloat(d.lon),
          type: d.type
        };
      });
    } catch (e) {
      return [];
    }
  }

  /* ------------------------------------------------- routing (OSRM public) */
  const OSRM = 'https://router.project-osrm.org';

  async function route(from, to) {
    if (!from || !to) return null;
    try {
      const url = OSRM + '/route/v1/driving/' + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat +
        '?overview=full&geometries=geojson&steps=false';
      const res = await fetch(url);
      if (!res.ok) throw new Error('route ' + res.status);
      const d = await res.json();
      if (!d.routes || !d.routes.length) throw new Error('no route');
      const r = d.routes[0];
      const coords = (r.geometry && r.geometry.coordinates) || [];
      return {
        km: r.distance / 1000,
        minutes: r.duration / 60,
        polyline: coords.map(function (c) { return [c[1], c[0]]; }), // -> [lat, lng]
        source: 'osrm'
      };
    } catch (e) {
      // Fallback: straight-line estimate so the app never dead-ends
      const km = roadKmEstimate(from, to, 1.35);
      const minutes = (km / 22) * 60; // ~22 km/h urban average in Dhaka
      return {
        km: km, minutes: minutes,
        polyline: [[from.lat, from.lng], [to.lat, to.lng]],
        source: 'estimate'
      };
    }
  }

  /* ---------------------------------------------- location watch (real GPS) */
  let watchId = null;
  let lastFix = null;
  const fixListeners = new Set();

  function startWatch(onFix, onError) {
    if (!('geolocation' in navigator)) {
      if (onError) onError({ code: 0, message: 'Geolocation unsupported' });
      return null;
    }
    if (watchId !== null) return watchId;
    watchId = navigator.geolocation.watchPosition(
      function (pos) {
        const fix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          ts: pos.timestamp
        };
        lastFix = fix;
        fixListeners.forEach(function (fn) { try { fn(fix); } catch (e) {} });
        if (onFix) onFix(fix);
      },
      function (err) { if (onError) onError(err); },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 }
    );
    return watchId;
  }

  function stopWatch() {
    if (watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function getCurrent(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!('geolocation' in navigator)) { reject(new Error('unsupported')); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          const fix = {
            lat: pos.coords.latitude, lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy, heading: pos.coords.heading, ts: pos.timestamp
          };
          lastFix = fix;
          resolve(fix);
        },
        reject,
        { enableHighAccuracy: true, timeout: timeoutMs || 15000, maximumAge: 20000 }
      );
    });
  }

  function onFix(fn) { fixListeners.add(fn); return function () { fixListeners.delete(fn); }; }

  /* ------------------------------------------------- Bangladesh reference */
  const BD = {
    center: { lat: 23.8103, lng: 90.4125 },           // Dhaka
    defaultView: { lat: 23.8103, lng: 90.4125, zoom: 13 },
    cities: [
      { name: 'Dhaka', nameBn: 'ঢাকা', lat: 23.8103, lng: 90.4125 },
      { name: 'Chattogram', nameBn: 'চট্টগ্রাম', lat: 22.3569, lng: 91.7832 },
      { name: 'Sylhet', nameBn: 'সিলেট', lat: 24.8949, lng: 91.8687 },
      { name: 'Khulna', nameBn: 'খুলনা', lat: 22.8456, lng: 89.5403 },
      { name: 'Rajshahi', nameBn: 'রাজশাহী', lat: 24.3745, lng: 88.6042 },
      { name: 'Rangpur', nameBn: 'রংপুর', lat: 25.7439, lng: 89.2752 },
      { name: 'Barishal', nameBn: 'বরিশাল', lat: 22.7010, lng: 90.3535 },
      { name: 'Mymensingh', nameBn: 'ময়মনসিংহ', lat: 24.7471, lng: 90.4203 },
      { name: 'Cumilla', nameBn: 'কুমিল্লা', lat: 23.4607, lng: 91.1809 },
      { name: 'Narayanganj', nameBn: 'নারায়ণগঞ্জ', lat: 23.6238, lng: 90.5000 }
    ],
    /** Real, well-known reference points used for demo seeding + saved places. */
    landmarks: {
      dhaka: [
        { label: 'Gulshan 2 Circle', labelBn: 'গুলশান ২', lat: 23.7925, lng: 90.4150 },
        { label: 'Banani, Road 11', labelBn: 'বনানী, রোড ১১', lat: 23.7936, lng: 90.4043 },
        { label: 'Dhanmondi 27', labelBn: 'ধানমন্ডি ২৭', lat: 23.7509, lng: 90.3742 },
        { label: 'Mirpur 10 Circle', labelBn: 'মিরপুর ১০', lat: 23.8069, lng: 90.3687 },
        { label: 'Motijheel Shapla Chattar', labelBn: 'মতিঝিল শাপলা চত্বর', lat: 23.7290, lng: 90.4175 },
        { label: 'Uttara Sector 7', labelBn: 'উত্তরা সেক্টর ৭', lat: 23.8687, lng: 90.3950 },
        { label: 'Bashundhara City Mall', labelBn: 'বসুন্ধরা সিটি', lat: 23.7509, lng: 90.3900 },
        { label: 'Shahbagh Intersection', labelBn: 'শাহবাগ', lat: 23.7381, lng: 90.3955 },
        { label: 'Hazrat Shahjalal Intl Airport', labelBn: 'শাহজালাল আন্তর্জাতিক বিমানবন্দর', lat: 23.8433, lng: 90.3978 },
        { label: 'Jatiya Sangsad Bhaban', labelBn: 'জাতীয় সংসদ ভবন', lat: 23.7622, lng: 90.3792 },
        { label: 'Bashundhara R/A Gate', labelBn: 'বসুন্ধরা আ/এ গেট', lat: 23.8223, lng: 90.4260 },
        { label: 'Mohakhali Bus Terminal', labelBn: 'মহাখালী বাস টার্মিনাল', lat: 23.7800, lng: 90.4050 },
        { label: 'Farmgate', labelBn: 'ফার্মগেট', lat: 23.7570, lng: 90.3890 },
        { label: 'Sadarghat Launch Terminal', labelBn: 'সদরঘাট', lat: 23.7100, lng: 90.4100 },
        { label: 'Gulshan Lake Park', labelBn: 'গুলশান লেক পার্ক', lat: 23.7950, lng: 90.4130 },
        { label: 'Badda Link Road', labelBn: 'বাড্ডা লিংক রোড', lat: 23.7810, lng: 90.4270 },
        { label: 'Azimpur', labelBn: 'আজিমপুর', lat: 23.7290, lng: 90.3850 },
        { label: 'Khilgaon Taltala', labelBn: 'খিলগাঁও তালতলা', lat: 23.7450, lng: 90.4280 },
        { label: 'Tejgaon Industrial Area', labelBn: 'তেজগাঁও শিল্প এলাকা', lat: 23.7650, lng: 90.3990 },
        { label: 'Bashundhara City Food Court', labelBn: 'বসুন্ধরা ফুড কোর্ট', lat: 23.7515, lng: 90.3895 }
      ]
    }
  };

  global.PothikGeo = {
    haversineKm: haversineKm,
    roadKmEstimate: roadKmEstimate,
    bearing: bearing,
    lerp: lerp,
    bounds: bounds,
    money: money,
    distance: distance,
    duration: duration,
    clockTime: clockTime,
    dateTime: dateTime,
    relativeTime: relativeTime,
    toBanglaDigits: toBanglaDigits,
    normalizePhone: normalizePhone,
    isValidBdPhone: isValidBdPhone,
    formatBdPhone: formatBdPhone,
    toE164: toE164,
    reverseGeocode: reverseGeocode,
    searchPlaces: searchPlaces,
    route: route,
    startWatch: startWatch,
    stopWatch: stopWatch,
    getCurrent: getCurrent,
    onFix: onFix,
    get lastFix() { return lastFix; },
    BD: BD
  };
})(window);
