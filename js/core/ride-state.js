/* ==========================================================================
   Pothik — Ride state machine
   --------------------------------------------------------------------------
   Invalid status transitions are rejected by canTransition()/transition().
   Every ride row's `status` must always be one of STATUS.
   ========================================================================== */
(function (global) {
  'use strict';

  const STATUS = {
    REQUESTED: 'REQUESTED',
    SEARCHING_DRIVER: 'SEARCHING_DRIVER',
    DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
    DRIVER_ARRIVING: 'DRIVER_ARRIVING',
    DRIVER_ARRIVED: 'DRIVER_ARRIVED',
    RIDE_STARTED: 'RIDE_STARTED',
    RIDE_COMPLETED: 'RIDE_COMPLETED',
    CANCELLED_BY_PASSENGER: 'CANCELLED_BY_PASSENGER',
    CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
    PAYMENT_PENDING: 'PAYMENT_PENDING',
    PAYMENT_COMPLETED: 'PAYMENT_COMPLETED'
  };

  /** Allowed transitions. Terminal states have no outgoing edges. */
  const TRANSITIONS = {
    REQUESTED:            ['SEARCHING_DRIVER', 'CANCELLED_BY_PASSENGER'],
    SEARCHING_DRIVER:     ['DRIVER_ASSIGNED', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ASSIGNED:      ['DRIVER_ARRIVING', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVING:      ['DRIVER_ARRIVED', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    DRIVER_ARRIVED:       ['RIDE_STARTED', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'],
    RIDE_STARTED:         ['RIDE_COMPLETED'],
    RIDE_COMPLETED:       ['PAYMENT_PENDING', 'PAYMENT_COMPLETED'],
    PAYMENT_PENDING:      ['PAYMENT_COMPLETED'],
    PAYMENT_COMPLETED:    [],
    CANCELLED_BY_PASSENGER: [],
    CANCELLED_BY_DRIVER:    []
  };

  /** States where the ride is still "live" and must be monitored. */
  const ACTIVE = [
    'REQUESTED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED',
    'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED'
  ];

  const TERMINAL = [
    'PAYMENT_COMPLETED', 'CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'
  ];

  const CANCELLED = ['CANCELLED_BY_PASSENGER', 'CANCELLED_BY_DRIVER'];

  function canTransition(from, to) {
    if (from === to) return false;
    const allowed = TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.indexOf(to) !== -1;
  }

  function isActive(status) { return ACTIVE.indexOf(status) !== -1; }
  function isTerminal(status) { return TERMINAL.indexOf(status) !== -1; }
  function isCancelled(status) { return CANCELLED.indexOf(status) !== -1; }

  /**
   * Apply a status transition to a ride row.
   * Throws a descriptive Error when the transition is not permitted.
   * @returns {object} patch to persist
   */
  function transition(ride, to, meta) {
    const from = ride.status;
    if (!STATUS[to]) throw new Error('Unknown ride status: ' + to);
    if (!canTransition(from, to)) {
      const err = new Error('Invalid ride transition ' + from + ' -> ' + to);
      err.code = 'INVALID_TRANSITION';
      throw err;
    }
    const patch = { status: to };
    const ts = Date.now();
    patch[statusTimestampField(to)] = ts;
    if (meta) {
      if (meta.driver_id) patch.driver_id = meta.driver_id;
      if (meta.cancel_reason) patch.cancel_reason = meta.cancel_reason;
      if (meta.cancelled_by) patch.cancelled_by = meta.cancelled_by;
      if (meta.start_otp) patch.start_otp = meta.start_otp;
      if (meta.actual_km !== undefined) patch.actual_km = meta.actual_km;
      if (meta.actual_minutes !== undefined) patch.actual_minutes = meta.actual_minutes;
    }
    return patch;
  }

  function statusTimestampField(status) {
    switch (status) {
      case 'SEARCHING_DRIVER': return 'search_started_at';
      case 'DRIVER_ASSIGNED': return 'assigned_at';
      case 'DRIVER_ARRIVED': return 'arrived_at';
      case 'RIDE_STARTED': return 'started_at';
      case 'RIDE_COMPLETED': return 'completed_at';
      case 'CANCELLED_BY_PASSENGER':
      case 'CANCELLED_BY_DRIVER': return 'cancelled_at';
      case 'PAYMENT_COMPLETED': return 'paid_at';
      default: return 'status_at';
    }
  }

  /** Human progress index for the passenger trip UI (0..4). */
  function progressIndex(status) {
    const order = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED'];
    const i = order.indexOf(status);
    return i === -1 ? 0 : i;
  }

  /** Which actor is allowed to move the ride to `to`. */
  function actorFor(to) {
    switch (to) {
      case 'SEARCHING_DRIVER': return 'system';
      case 'DRIVER_ASSIGNED': return 'driver';
      case 'DRIVER_ARRIVING': return 'driver';
      case 'DRIVER_ARRIVED': return 'driver';
      case 'RIDE_STARTED': return 'driver';
      case 'RIDE_COMPLETED': return 'driver';
      case 'CANCELLED_BY_PASSENGER': return 'passenger';
      case 'CANCELLED_BY_DRIVER': return 'driver';
      case 'PAYMENT_PENDING': return 'passenger';
      case 'PAYMENT_COMPLETED': return 'passenger';
      default: return 'system';
    }
  }

  function label(status) { return global.t ? global.t('st.' + status) : status; }

  global.RideState = {
    STATUS: STATUS,
    TRANSITIONS: TRANSITIONS,
    ACTIVE: ACTIVE,
    TERMINAL: TERMINAL,
    CANCELLED: CANCELLED,
    canTransition: canTransition,
    transition: transition,
    isActive: isActive,
    isTerminal: isTerminal,
    isCancelled: isCancelled,
    progressIndex: progressIndex,
    actorFor: actorFor,
    label: label
  };
})(window);
