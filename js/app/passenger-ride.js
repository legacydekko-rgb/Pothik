/* ==========================================================================
   Pothik — Passenger ride flow
   Booking -> estimate -> matching -> live trip -> payment -> rating
   ========================================================================== */
(function (global) {
  'use strict';

  const S = {};            // shared state, injected by passenger.js
  let maps = {};           // {home, veh, trip, pin}
  let router = null;
  let onRideChange = function () {};
  let watchTimer = null;
  let searchAbort = null;
  let simTimer = null;

  /* ------------------------------------------------------------ lifecycle */
  function attach(deps) {
    Object.assign(S, deps.state);
    maps = deps.maps || {};
    router = deps.router;
    onRideChange = deps.onRideChange || function () {};
  }

  /** Read-only access to the shared ride state (plain function — a getter
   *  accessor is not valid syntax inside a strict-mode function body). */
  function getState() { return S; }

  /* =============================== BOOKING =============================== */
  async function setPickupFromGps() {
    try {
      const fix = await PothikGeo.getCurrent(12000);
      const label = await PothikGeo.reverseGeocode(fix.lat, fix.lng);
      S.pickup = { lat: fix.lat, lng: fix.lng, label: label.label };
    } catch (e) {
      // GPS refused — fall back to the city centre so the flow still works
      const c = PothikGeo.BD.center;
      S.pickup = { lat: c.lat, lng: c.lng, label: I18n.getLang() === 'bn' ? 'ঢাকা (আনুমানিক)' : 'Dhaka (approximate)' };
      if (e && e.code === 1) UI.toast(t('home.gpsDenied'), 'warn');
    }
    return S.pickup;
  }

  function setPickup(place) {
    S.pickup = { lat: place.lat, lng: place.lng, label: place.label };
    return S.pickup;
  }

  function setDropoff(place) {
    S.dropoff = { lat: place.lat, lng: place.lng, label: place.label };
    return S.dropoff;
  }

  /** Compute the route + fare for every vehicle type. */
  async function computeRoute() {
    if (!S.pickup || !S.dropoff) return null;
    const r = await PothikGeo.route(S.pickup, S.dropoff);
    S.route = r;
    S.quotes = {};
    Settings.vehicleList().forEach(function (v) {
      S.quotes[v.type] = Fare.quote({
        km: r.km,
        minutes: r.minutes,
        vehicleType: v.type
      });
    });
    return r;
  }

  async function refreshAvailability() {
    if (!S.pickup) return { total: 0, byType: {} };
    S.availability = await Matching.availabilitySummary(S.pickup, Settings.get('searchRadiusKm'));
    return S.availability;
  }

  /* ============================== MATCHING =============================== */
  /**
   * Request a ride. Creates the ride row, then offers it to nearby drivers
   * one at a time with a per-driver timeout, honouring the state machine.
   */
  async function requestRide() {
    if (!S.pickup || !S.dropoff || !S.selectedVehicle) throw new Error('incomplete');
    const q = S.quotes[S.selectedVehicle];

    const ride = await DB.create('rides', {
      ride_code: 'PTK-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
      passenger_id: S.passenger.id,
      passenger_user_id: S.user.id,
      driver_id: '', driver_user_id: '', vehicle_id: '',
      vehicle_type: S.selectedVehicle,
      status: 'REQUESTED',
      pickup_label: S.pickup.label, pickup_lat: S.pickup.lat, pickup_lng: S.pickup.lng,
      dropoff_label: S.dropoff.label, dropoff_lat: S.dropoff.lat, dropoff_lng: S.dropoff.lng,
      distance_km: q.km, duration_min: q.minutes,
      actual_km: 0, actual_minutes: 0,
      base_fare: q.baseFare, distance_charge: q.distanceCharge, time_charge: q.timeCharge,
      surge: q.surge, discount: q.discount,
      fare_total: q.total, commission_pct: q.commissionPct,
      commission_amount: q.commission, driver_earning: q.driverEarning,
      payment_method: 'cash', payment_status: 'Pending',
      start_otp: String(Math.floor(1000 + Math.random() * 9000)),
      cancel_reason: '', cancelled_by: '', cancellation_fee: 0,
      city: 'Dhaka', area: (S.pickup.label || '').split(',').pop().trim(),
      matched_driver_attempts: 0,
      created_at: Date.now()
    });

    S.activeRide = ride;
    onRideChange(ride);

    // Move to SEARCHING_DRIVER through the state machine (validates the edge)
    const patch = RideState.transition(ride, 'SEARCHING_DRIVER');
    await DB.update('rides', ride.id, patch);
    S.activeRide = Object.assign({}, ride, patch);
    onRideChange(S.activeRide);

    // Remember as a recent place
    rememberPlace(S.dropoff).catch(function () {});

    // Kick off the offer loop (not awaited — the UI shows the searching screen)
    runMatchingLoop(S.activeRide.id);
    return S.activeRide;
  }

  /**
   * The offer loop. Emits progress through S.onSearchProgress so the UI can
   * display which driver is being offered and the countdown.
   */
  async function runMatchingLoop(rideId) {
    const timeoutSec = Number(Settings.get('requestTimeoutSec')) || 20;
    let candidates = [];

    try {
      candidates = await Matching.findCandidates(S.pickup, S.selectedVehicle, {
        excludeDriverIds: []
      });
    } catch (e) {
      candidates = [];
    }

    S.searchAttempts = candidates.length;
    S.searchIndex = 0;

    // ---- No real driver available -------------------------------------
    if (!candidates.length) {
      if (Settings.get('demoAutoAccept')) {
        const sim = await createSimulatedDriver();
        if (sim) {
          candidates = [sim];
        }
      }
    }

    if (!candidates.length) {
      emitSearch({ state: 'no_drivers' });
      return { matched: false, reason: 'no_drivers' };
    }

    // Offer sequentially
    for (let i = 0; i < candidates.length; i++) {
      if (S.cancelledByUser) return { matched: false, reason: 'cancelled' };

      // Re-read the ride: the passenger may have cancelled
      let fresh = null;
      try { fresh = await DB.get('rides', rideId); } catch (e) { fresh = S.activeRide; }
      if (!fresh || fresh.status !== 'SEARCHING_DRIVER') {
        return { matched: false, reason: 'no_longer_searching' };
      }

      const cand = candidates[i];
      S.searchIndex = i + 1;
      emitSearch({ state: 'offering', candidate: cand, index: i + 1, total: candidates.length, timeoutSec: timeoutSec });

      const verdict = await waitForDriverResponse(rideId, cand, timeoutSec);
      if (verdict === 'accepted') {
        emitSearch({ state: 'matched' });
        return { matched: true, candidate: cand };
      }
      if (verdict === 'cancelled') return { matched: false, reason: 'cancelled' };

      // declined / timed out -> next candidate
      await DB.update('rides', rideId, { matched_driver_attempts: i + 1 });
    }

    emitSearch({ state: 'timeout' });
    return { matched: false, reason: 'exhausted' };
  }

  /**
   * Wait for a driver to accept. In production this is driven by the driver
   * app writing status DRIVER_ASSIGNED (we poll the ride row). In demo mode we
   * simulate the driver tapping Accept after a short delay.
   */
  function waitForDriverResponse(rideId, candidate, timeoutSec) {
    return new Promise(function (resolve) {
      const startedAt = Date.now();
      let settled = false;
      let simHandle = null;

      const finish = function (verdict) {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        if (simHandle) clearTimeout(simHandle);
        resolve(verdict);
      };

      // Poll the ride row for a real acceptance / cancellation
      const poll = setInterval(async function () {
        if (settled) return;
        const elapsed = (Date.now() - startedAt) / 1000;

        if (S.cancelledByUser) { finish('cancelled'); return; }

        let fresh = null;
        try { fresh = await DB.get('rides', rideId); } catch (e) { fresh = null; }
        if (fresh) {
          if (fresh.driver_id && fresh.status === 'DRIVER_ASSIGNED') {
            S.activeRide = fresh;
            onRideChange(fresh);
            finish('accepted');
            return;
          }
          if (fresh.status === 'CANCELLED_BY_PASSENGER') { finish('cancelled'); return; }
          if (fresh.status !== 'SEARCHING_DRIVER') { finish('declined'); return; }
        }
        if (elapsed >= timeoutSec) finish('timeout');
      }, 1400);

      // Demo simulation: pretend the driver accepted after 3–6 seconds
      if (candidate.simulated && Settings.get('demoAutoAccept')) {
        const delay = 3000 + Math.random() * 3000;
        simHandle = setTimeout(async function () {
          if (settled) return;
          const res = await Matching.claimRide(rideId, candidate.driverId, 'SEARCHING_DRIVER');
          if (res.ok) {
            try { S.activeRide = await DB.get('rides', rideId); } catch (e) {}
            onRideChange(S.activeRide);
            finish('accepted');
          } else {
            finish('declined');
          }
        }, delay);
      }
    });
  }

  function emitSearch(payload) {
    if (S.onSearchProgress) S.onSearchProgress(payload);
  }

  /* ---------------------------------------------- simulated driver (demo) */
  /**
   * Creates a temporary "driver" so the full flow can be demonstrated without
   * a second physical device. Clearly marked as simulated in the UI.
   */
  async function createSimulatedDriver() {
    if (!S.pickup) return null;
    try {
      // Reuse a real approved driver record if one exists, else mint one.
      let driver = await DB.findWhere('drivers', function (d) { return d.status === 'approved'; });
      let statusRow = null;

      if (driver) {
        statusRow = await DB.findWhere('driver_status', function (r) { return r.driver_id === driver.id; });
      } else {
        const uid = DB.uid('usr_sim');
        const hash = await Auth.hashPassword('demo' + Math.floor(Math.random() * 100000));
        const user = await DB.create('users', {
          id: uid, phone: '1799' + String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
          phone_e164: '+8801799000000', phone_verified: true,
          full_name: 'Demo Driver', password_hash: hash, role: 'driver', language: 'bn',
          status: 'active', photo_url: '', created_at: Date.now()
        });
        driver = await DB.create('drivers', {
          id: DB.uid('drv_sim'), user_id: user.id, full_name: 'Demo Driver',
          phone: user.phone, nid_number: '0000000000', licence_number: 'DEMO',
          rating: 4.8, total_ratings: 120, completed_rides: 540,
          acceptance_rate: 0.92, status: 'approved', verified_by: 'system',
          verified_at: Date.now(), created_at: Date.now()
        });
        statusRow = await DB.create('driver_status', {
          id: DB.uid('ds_sim'), driver_id: driver.id, user_id: user.id,
          is_online: true, availability: 'available',
          lat: S.pickup.lat, lng: S.pickup.lng, heading: 0,
          last_ping_at: Date.now(), active_ride_id: null,
          rating: 4.8, acceptance_rate: 0.92, completed_rides: 540,
          vehicle_type: S.selectedVehicle, vehicle_id: null, updated_at: Date.now()
        });
      }

      if (!statusRow) return null;

      // Park them 0.6–1.6 km from the pickup, on a random bearing
      const bearing = Math.random() * 360;
      const distKm = 0.6 + Math.random() * 1.0;
      const lat = S.pickup.lat + (distKm / 111) * Math.cos(bearing * Math.PI / 180);
      const lng = S.pickup.lng + (distKm / (111 * Math.cos(S.pickup.lat * Math.PI / 180))) * Math.sin(bearing * Math.PI / 180);

      await DB.update('driver_status', statusRow.id, {
        is_online: true, availability: 'available',
        lat: lat, lng: lng, heading: Math.round((bearing + 180) % 360),
        accuracy: 8, speed_kmh: 0, last_ping_at: Date.now(),
        vehicle_type: S.selectedVehicle, active_ride_id: null, updated_at: Date.now()
      });

      return {
        driverId: driver.id, statusRowId: statusRow.id,
        vehicleType: S.selectedVehicle, lat: lat, lng: lng, heading: 0,
        distKm: distKm, rating: 4.8, acceptanceRate: 0.92,
        etaMinutes: Math.max(2, Math.round((distKm / 20) * 60)),
        simulated: true
      };
    } catch (e) {
      return null;
    }
  }

  /* ============================ LIVE TRIP ================================ */
  /** Poll + subscribe to the ride row and render the live trip screen. */
  function startWatching(rideId) {
    stopWatching();
    const tick = async function () {
      let ride = null;
      try { ride = await DB.get('rides', rideId); } catch (e) { return; }
      if (!ride) return;
      const prevStatus = S.activeRide ? S.activeRide.status : null;
      S.activeRide = ride;
      onRideChange(ride);
      if (ride.status !== prevStatus) {
        S.onRideStatusChange && S.onRideStatusChange(ride, prevStatus);
      }
    };
    tick();
    watchTimer = setInterval(tick, 2500);

    // Also react instantly to BroadcastChannel notifications (same-device demos)
    Notify.onMessage(function (msg) {
      if (msg && msg.ride_id === rideId) tick();
    });
  }

  function stopWatching() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  /** Fetch the driver + vehicle for display. */
  async function loadDriverInfo(ride) {
    if (!ride || !ride.driver_id) return null;
    try {
      const driver = await DB.get('drivers', ride.driver_id);
      let vehicle = null;
      if (ride.vehicle_id) { try { vehicle = await DB.get('vehicles', ride.vehicle_id); } catch (e) {} }
      if (!vehicle) vehicle = await DB.findWhere('vehicles', function (v) { return v.driver_id === ride.driver_id; });
      let statusRow = await DB.findWhere('driver_status', function (r) { return r.driver_id === ride.driver_id; });
      return { driver: driver, vehicle: vehicle, status: statusRow };
    } catch (e) {
      return null;
    }
  }

  /** Simulated driver movement so the live map is meaningful in a demo. */
  function startSimulatedMovement(rideId) {
    stopSimulatedMovement();
    simTimer = setInterval(async function () {
      const ride = S.activeRide;
      if (!ride || !ride.driver_id) return;
      if (RideState.isTerminal(ride.status)) { stopSimulatedMovement(); return; }

      const statusRow = await DB.findWhere('driver_status', function (r) { return r.driver_id === ride.driver_id; });
      if (!statusRow) return;
      const cur = { lat: Number(statusRow.lat), lng: Number(statusRow.lng) };
      if (!isFinite(cur.lat) || !isFinite(cur.lng)) return;

      // Target: pickup before the ride starts, dropoff afterwards
      const target = (ride.status === 'RIDE_STARTED')
        ? { lat: Number(ride.dropoff_lat), lng: Number(ride.dropoff_lng) }
        : { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) };

      const remaining = PothikGeo.haversineKm(cur, target);
      if (remaining < 0.035) {
        // Arrived at the current target — advance the state machine
        await advanceSimulatedDriver(ride, target);
        return;
      }
      // Move ~0.18 km per tick along the bearing
      const step = Math.min(0.18, remaining * 0.35);
      const next = PothikGeo.lerp(cur, target, step / remaining);
      const heading = Math.round(PothikGeo.bearing(cur, target));
      await DB.update('driver_status', statusRow.id, {
        lat: next.lat, lng: next.lng, heading: heading,
        speed_kmh: 22, accuracy: 8, last_ping_at: Date.now(), updated_at: Date.now()
      });
    }, 3000);
  }

  function stopSimulatedMovement() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
  }

  async function advanceSimulatedDriver(ride, target) {
    const statusRow = await DB.findWhere('driver_status', function (r) { return r.driver_id === ride.driver_id; });
    if (!statusRow) return;
    const atPickup = Math.abs(Number(statusRow.lat) - Number(ride.pickup_lat)) < 0.001 &&
                     Math.abs(Number(statusRow.lng) - Number(ride.pickup_lng)) < 0.001;
    try {
      if (ride.status === 'DRIVER_ASSIGNED' && atPickup) {
        await transitionRide(ride, 'DRIVER_ARRIVING');
      } else if (ride.status === 'DRIVER_ARRIVING' && atPickup) {
        await transitionRide(ride, 'DRIVER_ARRIVED');
      }
    } catch (e) { /* invalid transitions are ignored */ }
  }

  /** Apply a state transition through the state machine and persist it. */
  async function transitionRide(ride, to, meta) {
    const patch = RideState.transition(ride, to, meta);
    await DB.update('rides', ride.id, patch);
    S.activeRide = Object.assign({}, ride, patch);
    onRideChange(S.activeRide);
    S.onRideStatusChange && S.onRideStatusChange(S.activeRide, ride.status);
    return S.activeRide;
  }

  /* ============================== CANCEL ================================= */
  async function cancelRide(reasonCode, reasonText) {
    const ride = S.activeRide;
    if (!ride) return null;
    S.cancelledByUser = true;
    stopSimulatedMovement();

    const cf = Fare.cancellationFee(ride, reasonCode);
    const to = 'CANCELLED_BY_PASSENGER';
    const patch = RideState.transition(ride, to, {
      cancel_reason: reasonCode || 'changed_plan',
      cancelled_by: 'passenger'
    });
    patch.cancellation_fee = cf.fee;
    await DB.update('rides', ride.id, patch);

    await DB.create('cancellations', {
      id: DB.uid('can'), ride_id: ride.id, ride_code: ride.ride_code,
      cancelled_by: 'passenger', actor_user_id: S.user.id,
      reason_code: reasonCode || 'changed_plan', reason_text: reasonText || '',
      fee_charged: cf.fee, fee_waived: cf.waived,
      status_at_cancel: ride.status, counts_toward_limit: cf.fee > 0,
      created_at: Date.now()
    });

    if (ride.driver_id) {
      await Matching.releaseDriver(ride.driver_id);
      const drv = await DB.get('drivers', ride.driver_id).catch(function () { return null; });
      if (drv && drv.user_id) {
        await Notify.send(Notify.Ride.cancelledByPassenger(drv.user_id, ride.id));
      }
    }

    S.activeRide = Object.assign({}, ride, patch);
    onRideChange(S.activeRide);
    await Auth.audit(S.user.id, 'passenger', 'RIDE_CANCELLED', 'rides', ride.id, { reason: reasonCode });
    return { fee: cf.fee, waived: cf.waived };
  }

  /* ============================== PAYMENT ================================ */
  async function payRide(method) {
    const ride = S.activeRide;
    if (!ride) return null;

    // RIDE_COMPLETED -> PAYMENT_PENDING -> PAYMENT_COMPLETED
    let cur = ride;
    if (cur.status === 'RIDE_COMPLETED') {
      cur = await transitionRide(cur, 'PAYMENT_PENDING');
    }

    const nowTs = Date.now();
    const payment = await DB.create('payments', {
      ride_id: ride.id, ride_code: ride.ride_code,
      passenger_id: ride.passenger_id, driver_id: ride.driver_id,
      amount: ride.fare_total, currency: 'BDT', method: method || 'cash',
      status: 'Paid',
      gateway: method === 'cash' ? 'manual' : method,
      gateway_txn_id: method === 'cash' ? '' : ('TXN' + Math.floor(100000 + Math.random() * 899999)),
      commission_amount: ride.commission_amount,
      driver_earning: ride.driver_earning,
      refund_amount: 0, failure_reason: '',
      paid_at: nowTs, created_at: nowTs
    });

    await DB.create('commissions', {
      id: DB.uid('com'), driver_id: ride.driver_id, driver_user_id: ride.driver_user_id,
      ride_id: ride.id, ride_code: ride.ride_code,
      gross_fare: ride.fare_total, commission_amount: ride.commission_amount,
      net_earning: ride.driver_earning, payment_method: method || 'cash',
      period_date: new Date(nowTs).toISOString().slice(0, 10),
      status: 'accrued', payout_id: '', created_at: nowTs
    });

    const finalPatch = RideState.transition(cur, 'PAYMENT_COMPLETED', {});
    finalPatch.payment_method = method || 'cash';
    finalPatch.payment_status = 'Paid';
    finalPatch.paid_at = nowTs;
    await DB.update('rides', ride.id, finalPatch);
    S.activeRide = Object.assign({}, cur, finalPatch);

    // Update driver aggregates
    if (ride.driver_id) {
      const drv = await DB.get('drivers', ride.driver_id).catch(function () { return null; });
      if (drv) {
        await DB.update('drivers', drv.id, {
          completed_rides: Number(drv.completed_rides || 0) + 1
        });
      }
      await Matching.releaseDriver(ride.driver_id);
      const st = await DB.findWhere('driver_status', function (r) { return r.driver_id === ride.driver_id; });
      if (st) {
        await DB.update('driver_status', st.id, {
          completed_rides: Number(st.completed_rides || 0) + 1,
          last_ping_at: Date.now()
        });
      }
    }

    // Update passenger aggregates
    const pax = await DB.get('passengers', S.passenger.id).catch(function () { return null; });
    if (pax) {
      await DB.update('passengers', pax.id, {
        total_rides: Number(pax.total_rides || 0) + 1,
        total_spent: Number(pax.total_spent || 0) + Number(ride.fare_total || 0)
      });
    }

    // Notify the driver
    if (ride.driver_user_id) {
      await Notify.send(Notify.Ride.completed(ride.driver_user_id, ride.fare_total, ride.id));
    }

    stopWatching();
    stopSimulatedMovement();
    onRideChange(S.activeRide);
    return { payment: payment, ride: S.activeRide };
  }

  /* ============================== RATING ================================= */
  async function submitRating(stars, comment, rateeRole) {
    const ride = S.activeRide;
    if (!ride) return null;

    const isPassengerRating = rateeRole !== 'passenger';
    const rating = await DB.create('ratings', {
      ride_id: ride.id,
      rater_id: S.user.id,
      rater_role: 'passenger',
      ratee_id: isPassengerRating ? ride.driver_user_id : ride.passenger_user_id,
      ratee_role: isPassengerRating ? 'driver' : 'passenger',
      stars: stars,
      comment: comment || '',
      tags: [],
      flagged: false, flag_reason: '',
      created_at: Date.now()
    });

    // Recompute the driver's average rating
    if (isPassengerRating && ride.driver_id) {
      const all = await DB.list('ratings', { limit: 500 });
      const mine = all.filter(function (r) {
        return r.ratee_role === 'driver' && r.ratee_id === ride.driver_user_id && Number(r.stars) > 0;
      });
      const avg = mine.reduce(function (a, r) { return a + Number(r.stars); }, 0) / (mine.length || 1);
      const drv = await DB.get('drivers', ride.driver_id).catch(function () { return null; });
      if (drv) {
        await DB.update('drivers', drv.id, {
          rating: Math.round(avg * 100) / 100,
          total_ratings: mine.length
        });
      }
      const st = await DB.findWhere('driver_status', function (r) { return r.driver_id === ride.driver_id; });
      if (st) await DB.update('driver_status', st.id, { rating: Math.round(avg * 100) / 100 });
    }

    await Auth.audit(S.user.id, 'passenger', 'RATING_SUBMITTED', 'ratings', rating.id, { stars: stars });
    return rating;
  }

  /* ------------------------------------------------------------- helpers */
  async function rememberPlace(place) {
    if (!place || !S.user) return;
    const existing = await DB.findWhere('saved_places', function (p) {
      return p.user_id === S.user.id && p.kind === 'recent' && Math.abs(Number(p.lat) - place.lat) < 0.0005;
    });
    if (existing) {
      await DB.update('saved_places', existing.id, { created_at: Date.now(), label: place.label });
      return;
    }
    await DB.create('saved_places', {
      id: DB.uid('sp'), user_id: S.user.id, role: 'passenger',
      ride_id: '', pickup_label: '', dropoff_label: '',
      lat: place.lat, lng: place.lng, label: place.label, kind: 'recent',
      created_at: Date.now()
    });
  }

  /** Trigger SOS: records the event and notifies support. */
  async function triggerSos() {
    const ride = S.activeRide;
    const fix = PothikGeo.lastFix || S.pickup || PothikGeo.BD.center;
    await DB.create('emergency_events', {
      id: DB.uid('sos'), user_id: S.user.id,
      ride_id: ride ? ride.id : '', driver_id: ride ? ride.driver_id : '',
      type: 'sos', status: 'triggered',
      lat: fix.lat, lng: fix.lng, note: 'SOS triggered from passenger app',
      handled_by: '', created_at: Date.now()
    });
    await Notify.send({
      userId: S.user.id,
      title: '🚨 ' + t('ride.emergency'),
      body: t('ride.sosSent'),
      type: 'alert',
      rideId: ride ? ride.id : ''
    });
    await Auth.audit(S.user.id, 'passenger', 'SOS_TRIGGERED', 'emergency_events', '', { rideId: ride ? ride.id : '' });
  }

  /** Build the shareable trip text for the Share Trip feature. */
  function shareTripText() {
    const ride = S.activeRide;
    if (!ride) return '';
    const base = location.href.replace(/app\/[^/]*$/, '');
    const link = base + 'app/track.html?ride=' + ride.id;
    return 'Pothik trip\n' + t('ride.rideId') + ': ' + ride.ride_code + '\n' +
      t('ride.pickupPoint') + ': ' + ride.pickup_label + '\n' +
      t('ride.dropoffPoint') + ': ' + ride.dropoff_label + '\n' +
      t('ride.status') + ': ' + RideState.label(ride.status) + '\n' + link;
  }

  global.RideFlow = {
    attach: attach,
    getState: getState,
    setPickupFromGps: setPickupFromGps,
    setPickup: setPickup,
    setDropoff: setDropoff,
    computeRoute: computeRoute,
    refreshAvailability: refreshAvailability,
    requestRide: requestRide,
    startWatching: startWatching,
    stopWatching: stopWatching,
    startSimulatedMovement: startSimulatedMovement,
    stopSimulatedMovement: stopSimulatedMovement,
    loadDriverInfo: loadDriverInfo,
    transitionRide: transitionRide,
    cancelRide: cancelRide,
    payRide: payRide,
    submitRating: submitRating,
    rememberPlace: rememberPlace,
    triggerSos: triggerSos,
    shareTripText: shareTripText,
    createSimulatedDriver: createSimulatedDriver
  };
})(window);
