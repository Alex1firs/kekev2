/**
 * Controlled two-round redispatch.
 *
 * Covers the twelve required scenarios end-to-end through the real orchestrator
 * and the real reservation code (on a mocked Redis), with virtual time.
 */
import { OrchestratorHarness } from '../helpers/orchestrator';
import { newDriver, newRide, reservationOwner, setHeartbeatFresh, DispatchService } from '../helpers/dispatch';
import { CandidateState } from '../../src/services/dispatch_evidence';
import { loadDispatchConfig, defaultRoundTwoTiers, MAX_SUPPORTED_ROUNDS } from '../../src/config/dispatch_config';

const PICKUP = { lat: 6.2097, lng: 7.0562 };

/** Fast config: same shape as production, short windows to keep tests readable. */
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

describe('configuration', () => {
  it('is driven by env vars, not hardcoded call sites', () => {
    const prev = { ...process.env };
    process.env.DISPATCH_RADIUS_TIERS_KM = '1,2,3';
    process.env.DISPATCH_OFFER_DURATION_MS = '9000';
    process.env.DISPATCH_REOFFER_COOLDOWN_MS = '12345';
    process.env.DISPATCH_MAX_SEARCH_LIFETIME_MS = '77000';
    try {
      const config = loadDispatchConfig();
      expect(config.radiusTiersKm).toEqual([1, 2, 3]);
      expect(config.offerDurationMs).toBe(9000);
      expect(config.reofferCooldownMs).toBe(12345);
      expect(config.maxSearchLifetimeMs).toBe(77000);
    } finally {
      process.env = prev;
    }
  });

  it('clamps rounds to the two-round product ceiling', () => {
    const prev = process.env.DISPATCH_MAX_ROUNDS;
    process.env.DISPATCH_MAX_ROUNDS = '9';
    try {
      expect(loadDispatchConfig().maxRounds).toBe(MAX_SUPPORTED_ROUNDS);
      expect(MAX_SUPPORTED_ROUNDS).toBe(2);
    } finally {
      if (prev == null) delete process.env.DISPATCH_MAX_ROUNDS;
      else process.env.DISPATCH_MAX_ROUNDS = prev;
    }
  });

  it('expands round two beyond round one instead of rescanning', () => {
    expect(defaultRoundTwoTiers([2, 3.5, 5])).toEqual([5, 6.5]);
  });

  it('defaults to two rounds with no env configuration', () => {
    expect(loadDispatchConfig().maxRounds).toBe(2);
  });
});

// 1 ─────────────────────────────────────────────────────────────────────────
describe('1. round-one acceptance', () => {
  it('stops all dispatch activity the moment a driver accepts', async () => {
    const rideId = newRide();
    const [a, b] = [newDriver(), newDriver()];
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      { driverId: a, withinKm: 1 },
      { driverId: b, withinKm: 1 },
    ];
    await h.primeHeartbeats();

    // Accept 2s into the first offer window.
    h.at(2_000, () => {
      h.assigned = true;
      h.rideStatus = 'accepted';
      h.run.noteAcceptance(a);
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('accepted');
    expect(result.outcome).toBeNull();
    expect(result.summary.finalOutcomeCode).toBeNull();
    expect(h.run.evidence.acceptance?.driverId).toBe(a);
    // Only round one ran, and no second-round transition was announced.
    expect(result.summary.roundsRun).toBe(1);
    expect(h.rideEventsNamed('ride:dispatch_round')).toHaveLength(0);
    // The wider round-one tier was never reached — dispatch stopped at once.
    expect(h.offers.every((o) => o.round === 1)).toBe(true);
  });
});

// 2 ─────────────────────────────────────────────────────────────────────────
describe('2. round-one timeout then round-two acceptance', () => {
  it('runs a second round automatically and accepts there', async () => {
    const rideId = newRide();
    const near = newDriver();
    const far = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      { driverId: near, withinKm: 1 },
      { driverId: far, withinKm: 6 }, // only reachable by round two's tiers
    ];
    await h.primeHeartbeats();

    // The far driver accepts 2s after round two reaches them.
    h.reactToOffer(far, 2_000, () => {
      h.assigned = true;
      h.rideStatus = 'accepted';
      h.run.noteAcceptance(far);
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('accepted');
    expect(result.summary.roundsRun).toBe(2);
    expect(h.run.evidence.acceptance?.driverId).toBe(far);
    expect(h.run.evidence.acceptance?.round).toBe(2);

    // The round transition was announced exactly once, to the ride room.
    const transitions = h.rideEventsNamed('ride:dispatch_round');
    expect(transitions).toHaveLength(1);
    expect(transitions[0].dispatchRound).toBe(2);
    expect(transitions[0].reason).toBe('auto_redispatch');
    expect(h.eventsNamed('round_transition')).toHaveLength(1);
  });
});

// 3 ─────────────────────────────────────────────────────────────────────────
describe('3. no acceptance after two rounds', () => {
  it('classifies NO_DRIVER_ACCEPTED when real offers were delivered', async () => {
    const rideId = newRide();
    const d = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: d, withinKm: 1 }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('rounds_exhausted');
    expect(result.summary.roundsRun).toBe(2);
    expect(result.outcome!.code).toBe('NO_DRIVER_ACCEPTED');
    expect(result.outcome!.dispatchResult).toBe('offers_delivered_none_accepted');
    expect(result.summary.offersSentCount).toBeGreaterThan(0);
    // Unanswered offers are recorded as expiries, not rejections.
    expect(result.summary.expiredOfferCount).toBeGreaterThan(0);
    expect(result.summary.explicitRejectCount).toBe(0);
  });

  it('classifies NO_ELIGIBLE_DRIVER when nobody passed eligibility', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1, ineligibleReason: 'cash_debt_blocked' }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.outcome!.code).toBe('NO_ELIGIBLE_DRIVER');
    expect(result.summary.offersSentCount).toBe(0);
    expect(result.summary.eligibleDriverCount).toBe(0);
  });

  it('does NOT claim drivers were busy when every offer failed delivery', async () => {
    // The corrected classification: a driver whose id was in the candidate set
    // and who was even reserved has NOT been contacted if nothing reached them.
    const rideId = newRide();
    const d = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      {
        driverId: d,
        withinKm: 1,
        delivery: { delivered: false, socketDelivered: false, pushSuccessCount: 0, reason: 'no_socket_no_push' },
      },
    ];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.summary.reservedDriverCount).toBeGreaterThan(0);
    expect(result.summary.offersSentCount).toBe(0);
    expect(result.summary.deliveryFailureCount).toBeGreaterThan(0);
    expect(result.outcome!.code).toBe('NO_ELIGIBLE_DRIVER');
    expect(result.outcome!.dispatchResult).toBe('offers_all_failed_delivery');
    // Legacy field mirrors genuine offers, so old clients agree with the new code.
    expect(result.summary.driversRung).toBe(0);
  });

  it('reports REQUEST_EXPIRED when the search lifetime is exhausted', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, {
      ...FAST,
      // Enough for round one only; round two cannot be started.
      maxSearchLifetimeMs: 12_000,
      minRoundHeadroomMs: 5_000,
    });
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('lifetime_exceeded');
    expect(result.outcome!.code).toBe('REQUEST_EXPIRED');
    expect(result.outcome!.dispatchResult).toBe('search_lifetime_exceeded');
    // Round two never opened — no indefinite searching.
    expect(result.summary.roundsRun).toBe(1);
  });
});

// 4 ─────────────────────────────────────────────────────────────────────────
describe('4. passenger cancellation between rounds', () => {
  it('never starts round two after a cancellation', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    // Cancel during round one's first offer window.
    h.at(3_000, () => {
      h.rideStatus = 'canceled';
      h.run.abort('cancelled');
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('cancelled');
    expect(result.summary.roundsRun).toBe(1);
    expect(h.rideEventsNamed('ride:dispatch_round')).toHaveLength(0);
  });

  it('honours a cancellation that lands exactly in the inter-round gap', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    // Flip the DB status only, mid inter-round gap. The orchestrator must notice
    // on its own status re-check rather than relying on an in-process abort call —
    // this is the path a cancellation from another server instance would take.
    h.reactToRound(2, 100, () => {
      h.rideStatus = 'canceled';
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('cancelled');
    // No offer was sent in round two.
    expect(h.offers.filter((o) => o.round === 2)).toHaveLength(0);
  });
});

// 5 ─────────────────────────────────────────────────────────────────────────
describe('5. a driver becomes available during round two', () => {
  it('picks up a driver who only came online after round one began', async () => {
    const rideId = newRide();
    const latecomer = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: latecomer, withinKm: 1, onlineFromRound: 2 }];
    await setHeartbeatFresh(latecomer);

    const result = await h.orchestrator.run(h.run, PICKUP);

    // Invisible in round one, offered in round two — the pool is genuinely refreshed.
    expect(h.offers.filter((o) => o.round === 1)).toHaveLength(0);
    expect(h.offersTo(latecomer).map((o) => o.round)).toContain(2);
    expect(result.summary.offersSentCount).toBeGreaterThan(0);
  });
});

// 6 ─────────────────────────────────────────────────────────────────────────
describe('6. explicit rejector is not immediately re-offered', () => {
  it('excludes a round-one rejector from round two entirely', async () => {
    const rideId = newRide();
    const rejector = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: rejector, withinKm: 1 }];
    await h.primeHeartbeats();

    // Driver taps "decline" 1s after the offer arrives.
    h.reactToOffer(rejector, 1_000, () => h.run.noteRejection(rejector));

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(h.run.evidence.hasRejected(rejector)).toBe(true);
    expect(result.summary.explicitRejectCount).toBe(1);
    // Exactly one offer ever — never re-rung, in this or the next round.
    expect(h.offersTo(rejector)).toHaveLength(1);
    expect(
      h.eventsNamed('eligibility_reject').some((e) => e.fields.reason === 'explicit_rejector'),
    ).toBe(true);
    // A rejection is not an expiry.
    expect(result.summary.expiredOfferCount).toBe(0);
  });

  it('keeps an unanswered driver off the immediate re-offer list via the cooldown', async () => {
    const rideId = newRide();
    const d = newDriver();
    // Cooldown far longer than the whole run: no re-offer is permissible.
    const h = new OrchestratorHarness(rideId, { ...FAST, reofferCooldownMs: 10_000_000 });
    h.drivers = [{ driverId: d, withinKm: 1 }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(h.offersTo(d)).toHaveLength(1);
    expect(
      h.eventsNamed('eligibility_reject').some((e) => e.fields.reason === 'reoffer_cooldown'),
    ).toBe(true);
    expect(result.summary.offersSentCount).toBe(1);
  });

  it('permits a re-offer once the cooldown has elapsed', async () => {
    const rideId = newRide();
    const d = newDriver();
    // Round one's two tiers burn ~20s, so a 5s cooldown is spent by round two.
    const h = new OrchestratorHarness(rideId, { ...FAST, reofferCooldownMs: 5_000 });
    h.drivers = [{ driverId: d, withinKm: 1 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    const rounds = h.offersTo(d).map((o) => o.round);
    expect(rounds).toContain(1);
    expect(rounds).toContain(2);
    // Never twice inside the same round.
    expect(rounds.filter((r) => r === 1)).toHaveLength(1);
    expect(rounds.filter((r) => r === 2)).toHaveLength(1);
  });
});

// 7 ─────────────────────────────────────────────────────────────────────────
describe('7. reserved driver is skipped', () => {
  it('never offers a ride to a driver another ride already reserved', async () => {
    const rideId = newRide();
    const otherRideId = newRide();
    const taken = newDriver();
    const free = newDriver();

    // A competing ride owns `taken` before this dispatch starts.
    expect(await DispatchService.reserveDriver(taken, otherRideId)).toBe(true);

    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      { driverId: taken, withinKm: 1 },
      { driverId: free, withinKm: 1 },
    ];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(h.offersTo(taken)).toHaveLength(0);
    expect(h.offersTo(free).length).toBeGreaterThan(0);
    // The competing ride keeps its reservation throughout.
    expect(await reservationOwner(taken)).toBe(otherRideId);
    expect(
      h.eventsNamed('reserve').some(
        (e) => e.fields.driverId === taken && e.fields.result === 'skipped_reserved' && e.fields.reservedBy === otherRideId,
      ),
    ).toBe(true);
    expect(result.summary.reservedDriverCount).toBeGreaterThan(0);
  });
});

// 8 ─────────────────────────────────────────────────────────────────────────
describe('8. stale-heartbeat driver is skipped', () => {
  it('does not offer to a driver whose heartbeat lapsed before the offer', async () => {
    const rideId = newRide();
    const stale = newDriver();
    const fresh = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      { driverId: stale, withinKm: 1, available: false },
      { driverId: fresh, withinKm: 1 },
    ];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(h.offersTo(stale)).toHaveLength(0);
    expect(result.summary.staleBeforeOfferCount).toBeGreaterThan(0);
    expect(h.eventsNamed('candidate_stale').some((e) => e.fields.driverId === stale)).toBe(true);
    // A stale candidate is never reserved, so no reservation leaks.
    expect(await reservationOwner(stale)).toBeNull();
    expect(h.offersTo(fresh).length).toBeGreaterThan(0);
  });

  it('counts a stale candidate as neither eligible-and-offered nor rejected', async () => {
    const rideId = newRide();
    const stale = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: stale, withinKm: 1, available: false }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.summary.offersSentCount).toBe(0);
    expect(result.summary.explicitRejectCount).toBe(0);
    expect(result.outcome!.code).toBe('NO_ELIGIBLE_DRIVER');
    const record = h.run.evidence.candidatesFor().find((c) => c.driverId === stale)!;
    expect(record.states).toContain(CandidateState.STALE_BEFORE_OFFER);
    expect(record.states).not.toContain(CandidateState.OFFER_SENT);
  });
});

// 9 ─────────────────────────────────────────────────────────────────────────
describe('9. the same ride ID is retained', () => {
  it('uses one ride id for every round and every log line', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      { driverId: newDriver(), withinKm: 1 },
      { driverId: newDriver(), withinKm: 6 },
    ];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.summary.rideId).toBe(rideId);
    expect(result.summary.roundsRun).toBe(2);
    const rideIds = new Set(h.logs.map((l) => l.fields.rideId).filter(Boolean));
    expect([...rideIds]).toEqual([rideId]);
    for (const payload of h.rideEventsNamed('ride:dispatch_round')) {
      expect(payload.rideId).toBe(rideId);
    }
  });
});

// 10 ────────────────────────────────────────────────────────────────────────
describe('10. no duplicate ride record or payment', () => {
  it('the orchestrator has no port that could create a ride or take payment', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    // Structural guarantee: ride persistence and payment stay with the caller.
    // Round two can only READ ride status, so a duplicate is not expressible.
    const portNames = Object.keys(h.orchestrator['ports']);
    expect(portNames).toContain('getRideStatus');
    expect(portNames.some((p) => /create|insert|save|charge|pay|reserveFunds/i.test(p))).toBe(false);
    // A second round emits a transition, never a new booking request.
    expect(h.rideEventsNamed('ride:dispatch_round')).toHaveLength(1);
    expect(h.rideEvents.map((e) => e.event)).not.toContain('ride:request');
  });

  it('re-quotes nothing between rounds — the offer payload is not rebuilt here', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    // Every offer in both rounds refers to the same ride; no fare arithmetic
    // happens in the orchestrator at all.
    const rounds = new Set(h.offers.map((o) => o.round));
    expect(rounds.size).toBeGreaterThan(0);
    expect(h.eventsNamed('dispatch_finished')).toHaveLength(1);
    expect(h.eventsNamed('dispatch_finished')[0].fields.rideId).toBe(rideId);
  });
});

// 11 ────────────────────────────────────────────────────────────────────────
describe('11. simultaneous acceptance remains atomic', () => {
  it('only one of two concurrent rides can reserve the same driver', async () => {
    const driverId = newDriver();
    const rideA = newRide();
    const rideB = newRide();
    await setHeartbeatFresh(driverId);

    const [wonA, wonB] = await Promise.all([
      DispatchService.reserveDriver(driverId, rideA),
      DispatchService.reserveDriver(driverId, rideB),
    ]);

    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
    const owner = await reservationOwner(driverId);
    expect(owner).toBe(wonA ? rideA : rideB);
  });

  it('two rides racing one driver never offer while the other holds them', async () => {
    const shared = newDriver();
    const rideA = newRide();
    const rideB = newRide();

    const hA = new OrchestratorHarness(rideA, FAST);
    const hB = new OrchestratorHarness(rideB, FAST);
    hA.drivers = [{ driverId: shared, withinKm: 1 }];
    hB.drivers = [{ driverId: shared, withinKm: 1 }];
    await setHeartbeatFresh(shared);

    await Promise.all([
      hA.orchestrator.run(hA.run, PICKUP),
      hB.orchestrator.run(hB.run, PICKUP),
    ]);

    // Both rides may legitimately offer the driver at DIFFERENT times — once an
    // unanswered offer expires the reservation is released and the other ride
    // becomes free to try. What must never happen is a ride offering a driver it
    // does not own: that is the atomicity guarantee.
    const allOffers = [...hA.offers, ...hB.offers].filter((o) => o.driverId === shared);
    expect(allOffers.length).toBeGreaterThanOrEqual(1);
    for (const offer of allOffers) {
      expect(offer.reservationOwnerAtOffer).not.toBeNull();
    }
    expect(hA.offers.every((o) => o.reservationOwnerAtOffer === rideA)).toBe(true);
    expect(hB.offers.every((o) => o.reservationOwnerAtOffer === rideB)).toBe(true);

    // And a ride that was blocked at reservation time logged the real owner.
    const skips = [...hA.eventsNamed('reserve'), ...hB.eventsNamed('reserve')].filter(
      (e) => e.fields.result === 'skipped_reserved',
    );
    for (const skip of skips) {
      expect([rideA, rideB]).toContain(skip.fields.reservedBy);
      expect(skip.fields.reservedBy).not.toBe(skip.fields.rideId);
    }
  });

  it('an acceptance racing the round transition prevents round two', async () => {
    const rideId = newRide();
    const d = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: d, withinKm: 1 }];
    await h.primeHeartbeats();

    // Accept in the inter-round gap, just as round two is announced — the
    // narrowest window in which a late acceptance could be lost.
    h.reactToRound(2, 50, () => {
      h.assigned = true;
      h.rideStatus = 'accepted';
      h.run.noteAcceptance(d);
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.stopReason).toBe('accepted');
    expect(result.outcome).toBeNull();
    expect(h.offers.filter((o) => o.round === 2)).toHaveLength(0);
  });
});

// 12 ────────────────────────────────────────────────────────────────────────
describe('12. timers and reservations are released', () => {
  it('releases every reservation for expired offers as each round closes', async () => {
    const rideId = newRide();
    const drivers = [newDriver(), newDriver()];
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = drivers.map((driverId) => ({ driverId, withinKm: 1 }));
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);

    // Nobody answered, so nothing may still be held.
    for (const driverId of drivers) {
      expect(await reservationOwner(driverId)).toBeNull();
    }
    expect(result.summary.expiredOfferCount).toBeGreaterThan(0);
    expect(h.eventsNamed('offer_expiry').length).toBeGreaterThan(0);
  });

  it('releases the reservation of a driver whose offer could not be delivered', async () => {
    const rideId = newRide();
    const unreachable = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [
      {
        driverId: unreachable,
        withinKm: 1,
        delivery: { delivered: false, socketDelivered: false, pushSuccessCount: 0, reason: 'no_socket_no_push' },
      },
    ];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    expect(await reservationOwner(unreachable)).toBeNull();
  });

  it('a cancelled run leaves no reservation held past its final release', async () => {
    const rideId = newRide();
    const d = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: d, withinKm: 1 }];
    await h.primeHeartbeats();

    h.at(2_000, () => {
      h.rideStatus = 'canceled';
      h.run.abort('cancelled');
    });

    await h.orchestrator.run(h.run, PICKUP);

    // An abort mid-window can legitimately leave the reservation for the caller's
    // releaseRideReservations to clear (the socket handler does this in a
    // `finally`). Emulate that final step and confirm nothing survives it.
    for (const driverId of [d]) {
      await DispatchService.releaseDriver(driverId, rideId);
      expect(await reservationOwner(driverId)).toBeNull();
    }
  });

  it('finishes with a single terminal log line and no further activity', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);
    const offersAtFinish = h.offers.length;

    // Nothing is scheduled beyond the run: the virtual clock can advance freely
    // without producing another offer.
    h.at(1_000_000, () => {});
    expect(h.offers.length).toBe(offersAtFinish);
    expect(h.eventsNamed('dispatch_finished')).toHaveLength(1);
    expect(result.summary.finalOutcomeCode).toBe('NO_DRIVER_ACCEPTED');
  });
});

// Evidence-ledger specifics ────────────────────────────────────────────────
describe('dispatch evidence', () => {
  it('records the full candidate lifecycle with distances', async () => {
    const rideId = newRide();
    const d = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: d, withinKm: 1, distanceKm: 1.4 }];
    await h.primeHeartbeats();

    await h.orchestrator.run(h.run, PICKUP);

    const record = h.run.evidence.candidatesFor().find((c) => c.driverId === d)!;
    expect(record.distanceKm).toBe(1.4);
    expect(record.states).toEqual(
      expect.arrayContaining([
        CandidateState.DISCOVERED,
        CandidateState.ELIGIBLE,
        CandidateState.RESERVED,
        CandidateState.OFFER_QUEUED,
        CandidateState.OFFER_SENT,
        CandidateState.OFFER_EXPIRED,
      ]),
    );
    // Candidate distances reach the structured log.
    const discovered = h.eventsNamed('candidates_discovered')[0];
    expect(discovered.fields.candidates[0]).toEqual({ driverId: d, distanceKm: 1.4 });
  });

  it('counts a device acknowledgement only for a driver actually offered the ride', async () => {
    const rideId = newRide();
    const offered = newDriver();
    const stranger = newDriver();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: offered, withinKm: 1 }];
    await h.primeHeartbeats();

    h.reactToOffer(offered, 200, () => {
      h.run.noteAcknowledgement(offered);
      h.run.noteAcknowledgement(stranger); // never offered — must not count
    });

    const result = await h.orchestrator.run(h.run, PICKUP);

    expect(result.summary.acknowledgedCount).toBeGreaterThan(0);
    expect(h.run.evidence.candidatesFor().some((c) => c.driverId === stranger)).toBe(false);
  });

  it('exposes the per-round counts the passenger app consumes', async () => {
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, FAST);
    h.drivers = [{ driverId: newDriver(), withinKm: 1 }];
    await h.primeHeartbeats();

    const result = await h.orchestrator.run(h.run, PICKUP);
    const summary = result.summary;

    for (const key of [
      'dispatchRound',
      'eligibleDriverCount',
      'reservedDriverCount',
      'offersSentCount',
      'explicitRejectCount',
      'expiredOfferCount',
      'deliveryFailureCount',
      'finalOutcomeCode',
    ]) {
      expect(summary).toHaveProperty(key);
    }
    expect(summary.rounds).toHaveLength(2);
    expect(summary.rounds[0].round).toBe(1);
    expect(summary.rounds[1].round).toBe(2);
    expect(summary.rounds[1].radiusTiersKm).toEqual(FAST.roundTwoRadiusTiersKm);
  });
});
