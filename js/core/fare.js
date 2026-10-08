/* ==========================================================================
   Pothik — Fare engine
   --------------------------------------------------------------------------
   Fare = max(minimumFare,
              (baseFare + distanceKm * perKm + minutes * perMinute) * surge)
              - discount
   Commission is split off the final fare:
       platformCommission = fare * commissionPct / 100
       driverEarning      = fare - platformCommission

   Every parameter is read from Settings (DB-backed, admin editable) and every
   vehicle type carries its own rates. Nothing is hard-coded.
   ========================================================================== */
(function (global) {
  'use strict';

  /**
   * @param {object} p
   *   p.km            road distance (number)
   *   p.minutes       duration (number)
   *   p.vehicleType   'bike' | 'cng' | 'car' | custom
   *   p.surge         optional multiplier override
   *   p.discount      optional flat discount in BDT
   *   p.waitingMin    optional waiting minutes (charged at perMinute)
   * @returns {object} full, itemised quote
   */
  function quote(p) {
    const S = global.Settings;
    const type = p.vehicleType || 'car';
    const v = S.vehicle(type);

    const km = Math.max(0, Number(p.km) || 0);
    const minutes = Math.max(0, Number(p.minutes) || 0);
    const waitingMin = Math.max(0, Number(p.waitingMin) || 0);

    // Per-vehicle rates, falling back to global platform rates
    const baseFare = num(v.baseFare, S.get('baseFare'));
    const perKm = num(v.perKm, S.get('perKm'));
    const perMinute = num(v.perMinute, S.get('perMinute'));
    const minimumFare = num(v.minimumFare, S.get('minimumFare'));
    const commissionPct = num(v.commissionPct, S.get('commissionPct'));
    const surge = p.surge !== undefined ? Number(p.surge) : num(S.get('surgeMultiplier'), 1);

    const distanceCharge = km * perKm;
    const timeCharge = (minutes + waitingMin) * perMinute;
    const subtotal = baseFare + distanceCharge + timeCharge;
    const withSurge = subtotal * surge;

    let total = Math.max(minimumFare, withSurge);
    const minimumApplied = withSurge < minimumFare;

    const discount = Math.max(0, Number(p.discount) || 0);
    total = Math.max(0, total - discount);
    total = roundTo(total, 1); // BDT has no practical sub-taka in cash flow

    const commission = roundTo(total * commissionPct / 100, 1);
    const driverEarning = roundTo(total - commission, 1);

    return {
      vehicleType: type,
      km: roundTo(km, 2),
      minutes: Math.round(minutes),
      waitingMin: Math.round(waitingMin),
      baseFare: roundTo(baseFare, 1),
      distanceCharge: roundTo(distanceCharge, 1),
      timeCharge: roundTo(timeCharge, 1),
      subtotal: roundTo(subtotal, 1),
      surge: surge,
      surgeAmount: roundTo(withSurge - subtotal, 1),
      minimumApplied: minimumApplied,
      minimumFare: roundTo(minimumFare, 1),
      discount: roundTo(discount, 1),
      total: total,
      commissionPct: commissionPct,
      commission: commission,
      driverEarning: driverEarning,
      currency: 'BDT',
      breakdown: [
        { key: 'pay.baseFare', amount: roundTo(baseFare, 1) },
        { key: 'pay.distanceCharge', amount: roundTo(distanceCharge, 1), meta: roundTo(km, 1) + ' km × ৳' + perKm },
        { key: 'pay.timeCharge', amount: roundTo(timeCharge, 1), meta: Math.round(minutes) + ' min × ৳' + perMinute }
      ]
    };
  }

  /** Estimated duration from distance using a vehicle-aware urban speed. */
  function estimateMinutes(km, vehicleType) {
    const speeds = { bike: 26, cng: 20, car: 22 }; // km/h, Dhaka urban averages
    const speed = speeds[vehicleType] || 22;
    return Math.max(3, (km / speed) * 60);
  }

  /** Convenience: full quote straight from two coordinates. */
  function quoteFromRoute(from, to, km, minutes, vehicleType, opts) {
    const dist = km !== undefined && km !== null ? km : global.PothikGeo.roadKmEstimate(from, to, 1.35);
    const dur = minutes !== undefined && minutes !== null ? minutes : estimateMinutes(dist, vehicleType);
    return quote(Object.assign({ km: dist, minutes: dur, vehicleType: vehicleType }, opts || {}));
  }

  /** Cancellation fee, waived inside the configured free-cancel window. */
  function cancellationFee(ride, reason) {
    const S = global.Settings;
    const fee = num(S.get('cancellationFee'), 30);
    const windowSec = num(S.get('cancellationWindowSec'), 120);
    const ageSec = ride && ride.created_at ? (Date.now() - Number(ride.created_at)) / 1000 : 99999;

    // Passenger cancelling very early, or before any driver was assigned: free
    const noDriverYet = !ride || !ride.driver_id;
    const arrived = ride && (ride.status === 'DRIVER_ARRIVED');
    if (noDriverYet || (ageSec < windowSec && !arrived)) return { fee: 0, waived: true };
    if (reason === 'driver_too_far') return { fee: 0, waived: true };
    return { fee: fee, waived: false };
  }

  /** Surge suggestion based on demand/supply ratio (used by admin + auto mode). */
  function suggestSurge(activeRequests, availableDrivers) {
    if (!availableDrivers) return 1.5;
    const ratio = activeRequests / availableDrivers;
    if (ratio < 0.5) return 1.0;
    if (ratio < 1) return 1.15;
    if (ratio < 2) return 1.3;
    if (ratio < 3) return 1.5;
    return 1.8;
  }

  function roundTo(n, decimals) {
    const f = Math.pow(10, decimals || 0);
    return Math.round((Number(n) || 0) * f) / f;
  }

  function num(v, fallback) {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  global.Fare = {
    quote: quote,
    quoteFromRoute: quoteFromRoute,
    estimateMinutes: estimateMinutes,
    cancellationFee: cancellationFee,
    suggestSurge: suggestSurge,
    roundTo: roundTo
  };
})(window);
