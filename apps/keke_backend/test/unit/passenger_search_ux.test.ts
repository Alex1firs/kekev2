/**
 * What the passenger is told while a ride is being dispatched, and how they
 * cancel one.
 *
 * Two rules run through all of it: the passenger is told the truth about
 * dispatch, and they are never told anything about WHICH driver is deciding.
 */
import { OrchestratorHarness } from '../helpers/orchestrator';
import { PASSENGER_CANCEL_REASONS } from '../../src/sockets/socket_handler';

const PICKUP = { lat: 6.2097, lng: 7.0562 };

const FAST = {
  radiusTiersKm: [2, 4],
  roundTwoRadiusTiersKm: [6, 8],
  offerDurationMs: 10_000,
  emptyTierPauseMs: 1_000,
  roundGapMs: 500,
  reofferCooldownMs: 20_000,
  maxSearchLifetimeMs: 300_000,
  minRoundHeadroomMs: 1_000,
};

describe('ride:offer_sent — telling the passenger a driver is deciding', () => {
  it('is emitted when an offer actually reaches a driver', async () => {
    const h = new OrchestratorHarness('RIDE-OFFER-1', FAST);
    h.drivers = [{ driverId: 'drv-a', withinKm: 1 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    const offers = h.rideEventsNamed('ride:offer_sent');
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(offers[0].round).toBe(1);
    expect(typeof offers[0].at).toBe('string');
  });

  it('carries no driver identity', async () => {
    const h = new OrchestratorHarness('RIDE-OFFER-2', FAST);
    h.drivers = [{ driverId: 'drv-secret', withinKm: 1 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    /*
     * The passenger has no business knowing who is considering their trip,
     * and may never learn who declined it. The event says "somebody is
     * deciding", nothing more.
     */
    const payload = h.rideEventsNamed('ride:offer_sent')[0];
    expect(JSON.stringify(payload)).not.toContain('drv-secret');
    expect(payload.driverId).toBeUndefined();
  });

  it('is not emitted when there is nobody to offer to', async () => {
    const h = new OrchestratorHarness('RIDE-OFFER-3', FAST);
    // No drivers at all — the passenger must keep seeing "finding a Keke",
    // never "driver found".
    h.drivers = [];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    expect(h.rideEventsNamed('ride:offer_sent')).toHaveLength(0);
  });

  it('is not emitted when delivery to the driver failed', async () => {
    const h = new OrchestratorHarness('RIDE-OFFER-4', FAST);
    h.drivers = [{
      driverId: 'drv-unreachable',
      withinKm: 1,
      // Neither socket nor push reached the handset.
      delivery: { delivered: false, socketDelivered: false, pushSuccessCount: 0 },
    }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    // "Driver found" would be a lie: nothing reached anyone.
    expect(h.rideEventsNamed('ride:offer_sent')).toHaveLength(0);
  });

  it('does not disturb the existing searching / round events', async () => {
    const h = new OrchestratorHarness('RIDE-OFFER-5', FAST);
    h.drivers = [{ driverId: 'drv-late', withinKm: 6 }];  // round two only
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    // The event the shipped passenger build already depends on still fires.
    expect(h.rideEventsNamed('ride:dispatch_round').length).toBeGreaterThanOrEqual(1);
  });
});

describe('passenger cancellation reasons', () => {
  it('is a closed set, so Operations can count causes', () => {
    expect([...PASSENGER_CANCEL_REASONS]).toEqual([
      'driver_taking_too_long',
      'driver_too_far',
      'cannot_reach_driver',
      'driver_asked_to_cancel',
      'plans_changed',
      'wrong_pickup_or_destination',
      'booked_by_mistake',
      'other',
    ]);
  });

  it('every code is machine-readable, not prose', () => {
    for (const code of PASSENGER_CANCEL_REASONS) {
      // Free text cannot be aggregated, and a label that changes wording in
      // the app must not change what history says happened.
      expect(code).toMatch(/^[a-z][a-z_]*[a-z]$/);
      expect(code).not.toContain(' ');
      // Must fit Ride.cancellationReason (varchar 120).
      expect(code.length).toBeLessThanOrEqual(120);
    }
  });
});
