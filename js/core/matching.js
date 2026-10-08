/* ==========================================================================
   Pothik — Driver matching engine
   --------------------------------------------------------------------------
   Real matching over live driver rows in the database:
     1. read passenger pickup coordinates
     2. filter to available + online + approved + matching vehicle type
     3. compute great-circle distance, drop anything outside searchRadiusKm
     4. score = distance + staleness penalty + rating bonus + acceptance bonus
     5. offer the ride to the best driver, one at a time, with a timeout
     6. on decline/timeout, offer to the next candidate
     7. on accept, lock the ride with an optimistic concurrency check so two
        passengers can never be assigned the same driver

   Driver availability is written by the driver app into driver_status rows
   (is_online, lat, lng, last_ping_at, active_ride_id).
   ========================================================================== */
(function (global) {
  'use strict';

  /** A driver is considered live if they pinged within this window. */
  const STALE_AFTER_MS = 90 * 1000;

  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }

  function isFresh(row, nowTs) {
    const t = num(row.last_ping_at, 0);
    return t > 0 && (nowTs - t) < STALE_AFTER_MS;
  }

  /**
   * Fetch candidate drivers near a point.
   * @returns {Array} scored candidates, best first
   */
  async function findCandidates(pickup, vehicleType, opts) {
    const o = opts || {};
    const S = global.Settings;
    const radiusKm = num(o.radiusKm, num(S.get('searchRadiusKm'), 7));
    const nowTs = Date.now();

    let statusRows = [];
    try {
      statusRows = await global.DB.list('driver_status', { limit: 500 });
    } catch (e) {
      statusRows = [];
    }

    const candidates = [];

    for (const row of statusRows) {
      if (row.is_online !== true) continue;
      if (!isFresh(row, nowTs)) continue;                     // stale GPS ping
      if (row.active_ride_id) continue;                        // already on a ride
      if (row.availability === 'busy') continue;
      if (o.excludeDriverIds && o.excludeDriverIds.indexOf(row.driver_id) !== -1) continue;

      const pos = { lat: num(row.lat, NaN), lng: num(row.lng, NaN) };
      if (!isFinite(pos.lat) || !isFinite(pos.lng)) continue;

      const distKm = global.PothikGeo.haversineKm(pickup, pos);
      if (distKm > radiusKm) continue;

      // Vehicle-type filter: a driver serves one vehicle type (their approved vehicle)
      if (vehicleType && row.vehicle_type && row.vehicle_type !== vehicleType) continue;

      candidates.push({
        driverId: row.driver_id,
        statusRowId: row.id,
        vehicleType: row.vehicle_type,
        vehicleId: row.vehicle_id,
        lat: pos.lat,
        lng: pos.lng,
        heading: num(row.heading, 0),
        distKm: distKm,
        rating: num(row.rating, 4.6),
        acceptanceRate: num(row.acceptance_rate, 0.8),
        completedRides: num(row.completed_rides, 0),
        pingAgeMs: nowTs - num(row.last_ping_at, 0)
      });
    }

    // ---- scoring -----------------------------------------------------------
    candidates.forEach(function (c) {
      const distanceScore = c.distKm * 10;                          // closer is better
      const stalenessScore = (c.pingAgeMs / 1000) * 0.05;           // fresher is better
      const ratingScore = (5 - c.rating) * 6;                        // higher rating better
      const acceptanceScore = (1 - c.acceptanceRate) * 4;            // reliable drivers better
      c.score = distanceScore + stalenessScore + ratingScore + acceptanceScore;
      c.etaMinutes = Math.max(2, Math.round((c.distKm / 20) * 60));  // ~20 km/h pickup speed
    });

    candidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.distKm - b.distKm;
    });

    const max = num(o.maxCandidates, num(S.get('maxDriversToTry'), 8));
    return candidates.slice(0, max);
  }

  /**
   * Attempt to lock a ride to a driver. Uses an optimistic compare-and-set on
   * the ride row so concurrent accepts can't both win.
   * @returns {{ok:boolean, reason?:string}}
   */
  async function claimRide(rideId, driverId, expectedStatus) {
    const res = await global.DB.updateIf('rides', rideId, 'status', expectedStatus, {
      driver_id: driverId,
      status: 'DRIVER_ASSIGNED',
      assigned_at: Date.now(),
      status_at: Date.now()
    });
    if (!res.ok) return res;
    // Mark the driver busy so a second passenger cannot match them.
    try {
      const st = await global.DB.findWhere('driver_status', function (r) { return r.driver_id === driverId; });
      if (st) await global.DB.update('driver_status', st.id, { availability: 'busy', active_ride_id: rideId, updated_at: Date.now() });
    } catch (e) { /* non-fatal */ }
    return { ok: true };
  }

  /** Release a driver after a completed/cancelled ride. */
  async function releaseDriver(driverId) {
    if (!driverId) return;
    try {
      const st = await global.DB.findWhere('driver_status', function (r) { return r.driver_id === driverId; });
      if (st) await global.DB.update('driver_status', st.id, {
        availability: 'available', active_ride_id: null, updated_at: Date.now()
      });
    } catch (e) { /* non-fatal */ }
  }

  /**
   * Driver availability summary for a point — powers "N drivers nearby" and
   * the vehicle-type availability list on the passenger home screen.
   */
  async function availabilitySummary(pickup, radiusKm) {
    const S = global.Settings;
    const radius = num(radiusKm, num(S.get('searchRadiusKm'), 7));
    const nowTs = Date.now();
    const out = { total: 0, byType: {} };

    let rows = [];
    try { rows = await global.DB.list('driver_status', { limit: 500 }); } catch (e) { rows = []; }

    rows.forEach(function (r) {
      if (r.is_online !== true || !isFresh(r, nowTs) || r.active_ride_id) return;
      const pos = { lat: num(r.lat, NaN), lng: num(r.lng, NaN) };
      if (!isFinite(pos.lat) || !isFinite(pos.lng)) return;
      if (global.PothikGeo.haversineKm(pickup, pos) > radius) return;
      const type = r.vehicle_type || 'car';
      out.total++;
      out.byType[type] = (out.byType[type] || 0) + 1;
    });
    return out;
  }

  /**
   * Sequential offer loop. `onOffer(candidate, attemptIndex)` is awaited and
   * must resolve to 'accept' | 'decline' | 'timeout' | 'cancelled'.
   */
  async function offerToCandidates(candidates, onOffer, opts) {
    const o = opts || {};
    const timeoutSec = num(o.timeoutSec, num(global.Settings.get('requestTimeoutSec'), 20));
    for (let i = 0; i < candidates.length; i++) {
      const verdict = await onOffer(candidates[i], i, timeoutSec);
      if (verdict === 'accept') return { matched: true, candidate: candidates[i], attempt: i + 1 };
      if (verdict === 'cancelled') return { matched: false, reason: 'cancelled' };
    }
    return { matched: false, reason: 'exhausted' };
  }

  /** Nearby drivers with positions — used to draw pins on the passenger map. */
  async function nearbyDriverPositions(pickup, radiusKm, limit) {
    const nowTs = Date.now();
    const radius = num(radiusKm, 5);
    let rows = [];
    try { rows = await global.DB.list('driver_status', { limit: 500 }); } catch (e) { rows = []; }
    const out = [];
    rows.forEach(function (r) {
      if (r.is_online !== true || !isFresh(r, nowTs)) return;
      const pos = { lat: num(r.lat, NaN), lng: num(r.lng, NaN) };
      if (!isFinite(pos.lat) || !isFinite(pos.lng)) return;
      const d = global.PothikGeo.haversineKm(pickup, pos);
      if (d > radius) return;
      out.push({ driverId: r.driver_id, lat: pos.lat, lng: pos.lng, vehicleType: r.vehicle_type, heading: num(r.heading, 0), distKm: d, busy: !!r.active_ride_id });
    });
    out.sort(function (a, b) { return a.distKm - b.distKm; });
    return out.slice(0, limit || 20);
  }

  global.Matching = {
    STALE_AFTER_MS: STALE_AFTER_MS,
    findCandidates: findCandidates,
    claimRide: claimRide,
    releaseDriver: releaseDriver,
    availabilitySummary: availabilitySummary,
    offerToCandidates: offerToCandidates,
    nearbyDriverPositions: nearbyDriverPositions
  };
})(window);
