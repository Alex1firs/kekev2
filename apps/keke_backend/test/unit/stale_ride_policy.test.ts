/**
 * Stale-ride policy.
 *
 * Written against the production incident: rides sat in `accepted` for 17 hours
 * to nearly four days, each blocking one passenger from booking and one driver
 * from accepting, with hand-written SQL the only remedy.
 *
 * The policy is pure, so these tests pin the actual decision rules — including
 * the ones that must NOT fire.
 */
import { StaleRideService, RideSnapshot } from '../../src/services/stale_ride_service';
import { loadStaleRideConfig, StaleRideConfig, StaleActionReason } from '../../src/config/stale_ride_config';

const CONFIG: StaleRideConfig = {
    ...loadStaleRideConfig(),
    acceptedMinMinutes: 20,
    acceptedEtaMultiplier: 3,
    acceptedMaxMinutes: 45,
    arrivedWarnMinutes: 10,
    arrivedCancelMinutes: 20,
    inProgressDurationMultiplier: 4,
    inProgressMinMinutes: 120,
    inProgressAbsoluteMinutes: 360,
    extensionMinutes: 10,
    maxExtensions: 1,
    warnAtDeadlineFraction: 0.6,
    kekeMetresPerMinute: 230,
};

const T0 = new Date('2026-07-26T06:00:00Z');
const at = (minutesLater: number) => new Date(T0.getTime() + minutesLater * 60_000);

/** Awka pickup, and an accept point ~2.3 km away => ~10 min ETA at 230 m/min. */
const PICKUP = { lat: 6.2097, lng: 7.0562 };
const ACCEPT_FAR = { lat: 6.2300, lng: 7.0562 };   // ~2.26 km north
const ACCEPT_NEAR = { lat: 6.2100, lng: 7.0565 };  // ~50 m away

const ride = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
    rideId: 'RIDE-TEST',
    status: 'accepted',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    acceptedAt: T0,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    estimatedDurationSec: null,
    acceptLat: null,
    acceptLng: null,
    pickupLat: PICKUP.lat,
    pickupLng: PICKUP.lng,
    staleWarnedAt: null,
    staleExtensionCount: 0,
    staleDeadlineOverrideAt: null,
    requiresOperationsReview: false,
    ...over,
});

// 1 ────────────────────────────────────────────────────────────────────────
describe('1. an accepted ride below its deadline is untouched', () => {
    it('takes no action at 5 minutes', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(5));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('within arrival allowance');
    });

    it('takes no action at 19 minutes with no ETA (min is 20)', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(19));
        expect(e.action).not.toBe('cancel');
    });
});

// 2 ────────────────────────────────────────────────────────────────────────
describe('2. an accepted ride past its ETA-aware deadline is cancelled', () => {
    it('cancels a far-accept ride once ETA x multiplier has elapsed', () => {
        // ~2.26 km => ~9.8 min ETA => deadline ~29.5 min.
        const r = ride({ acceptLat: ACCEPT_FAR.lat, acceptLng: ACCEPT_FAR.lng });
        const eta = StaleRideService.estimatedPickupEtaMinutes(r, CONFIG)!;
        expect(eta).toBeGreaterThan(8);
        expect(eta).toBeLessThan(12);

        const before = StaleRideService.evaluate(r, CONFIG, at(eta * 3 - 2));
        expect(before.action).not.toBe('cancel');

        const after = StaleRideService.evaluate(r, CONFIG, at(eta * 3 + 1));
        expect(after.action).toBe('cancel');
        expect(after.reason).toBe(StaleActionReason.DRIVER_DID_NOT_ARRIVE);
        expect(after.explanation).toContain('never arrived');
    });

    it('cancels the four-day case from the incident outright', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(4 * 24 * 60));
        expect(e.action).toBe('cancel');
        expect(e.reason).toBe(StaleActionReason.DRIVER_DID_NOT_ARRIVE);
    });
});

// 3 ────────────────────────────────────────────────────────────────────────
describe('3. an accepted ride with no ETA uses the configured minimum', () => {
    it('falls back to 20 minutes when accept coordinates are missing', () => {
        const r = ride({ acceptLat: null, acceptLng: null });
        expect(StaleRideService.estimatedPickupEtaMinutes(r, CONFIG)).toBeNull();

        const { deadlineMinutes, etaMinutes } = StaleRideService.acceptedDeadlineMinutes(r, CONFIG);
        expect(etaMinutes).toBeNull();
        expect(deadlineMinutes).toBe(CONFIG.acceptedMinMinutes);

        expect(StaleRideService.evaluate(r, CONFIG, at(19)).action).not.toBe('cancel');
        expect(StaleRideService.evaluate(r, CONFIG, at(21)).action).toBe('cancel');
    });

    it('treats the 0,0 no-fix sentinel as no ETA', () => {
        const r = ride({ acceptLat: 0, acceptLng: 0 });
        expect(StaleRideService.estimatedPickupEtaMinutes(r, CONFIG)).toBeNull();
    });

    it('a very near accept still gets the minimum, not a 1-minute deadline', () => {
        // ~50 m => ~0.2 min ETA => x3 is far below the floor.
        const r = ride({ acceptLat: ACCEPT_NEAR.lat, acceptLng: ACCEPT_NEAR.lng });
        const { deadlineMinutes } = StaleRideService.acceptedDeadlineMinutes(r, CONFIG);
        expect(deadlineMinutes).toBe(CONFIG.acceptedMinMinutes);
    });
});

// 4 ────────────────────────────────────────────────────────────────────────
describe('4. the deadline respects the maximum cap', () => {
    it('caps a very distant accept at acceptedMaxMinutes', () => {
        // ~55 km away => ETA ~240 min => x3 = 720 min, must clamp to 45.
        const r = ride({ acceptLat: 6.7000, acceptLng: 7.0562 });
        const { deadlineMinutes, etaMinutes } = StaleRideService.acceptedDeadlineMinutes(r, CONFIG);
        expect(etaMinutes!).toBeGreaterThan(100);
        expect(deadlineMinutes).toBe(CONFIG.acceptedMaxMinutes);

        expect(StaleRideService.evaluate(r, CONFIG, at(46)).action).toBe('cancel');
    });
});

// 5 ────────────────────────────────────────────────────────────────────────
describe('5. a driver who arrives just before the sweep survives', () => {
    it('never cancels an accepted ride that already has arrivedAt', () => {
        // Age far beyond any deadline, but the later event wins outright.
        const r = ride({ arrivedAt: at(4 * 24 * 60 - 1) });
        const e = StaleRideService.evaluate(r, CONFIG, at(4 * 24 * 60));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('already marked arrived');
    });

    it('never cancels an accepted ride that already has startedAt', () => {
        const r = ride({ startedAt: at(100) });
        expect(StaleRideService.evaluate(r, CONFIG, at(4000)).action).toBe('none');
    });

    it('never touches a ride with completedAt set', () => {
        const r = ride({ completedAt: at(30) });
        const e = StaleRideService.evaluate(r, CONFIG, at(9999));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('completedAt');
    });
});

// 11 + 12 ─────────────────────────────────────────────────────────────────
describe('11 & 12. arrived-but-not-started: warn, then cancel', () => {
    const arrived = (over: Partial<RideSnapshot> = {}) =>
        ride({ status: 'arrived', arrivedAt: T0, ...over });

    it('does nothing in the first few minutes', () => {
        expect(StaleRideService.evaluate(arrived(), CONFIG, at(3)).action).toBe('none');
    });

    it('warns both parties at the warning threshold', () => {
        const e = StaleRideService.evaluate(arrived(), CONFIG, at(11));
        expect(e.action).toBe('warn');
        expect(e.reason).toBe(StaleActionReason.TRIP_NOT_STARTED_AFTER_ARRIVAL);
    });

    it('does not warn twice', () => {
        const e = StaleRideService.evaluate(arrived({ staleWarnedAt: at(11) }), CONFIG, at(15));
        expect(e.action).toBe('none');
    });

    it('cancels after the grace period', () => {
        const e = StaleRideService.evaluate(arrived(), CONFIG, at(21));
        expect(e.action).toBe('cancel');
        expect(e.reason).toBe(StaleActionReason.TRIP_NOT_STARTED_AFTER_ARRIVAL);
    });

    it('never blames the passenger for a timer expiring', () => {
        const e = StaleRideService.evaluate(arrived(), CONFIG, at(60));
        // A no-show is a claim about the world that no driver flow establishes.
        expect(e.reason).not.toMatch(/NO_SHOW/);
        expect(e.explanation).not.toMatch(/no.?show/i);
    });

    it('a started trip is immune however long it sat at arrived', () => {
        const e = StaleRideService.evaluate(arrived({ startedAt: at(19) }), CONFIG, at(600));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('already started');
    });
});

// 13 ───────────────────────────────────────────────────────────────────────
describe('13. an in-progress trip is flagged, never cancelled', () => {
    const running = (over: Partial<RideSnapshot> = {}) =>
        ride({ status: 'in_progress', startedAt: T0, arrivedAt: T0, ...over });

    it('does nothing inside the expected duration', () => {
        const e = StaleRideService.evaluate(running({ estimatedDurationSec: 1800 }), CONFIG, at(30));
        expect(e.action).toBe('none');
    });

    it('flags rather than cancels once past the threshold', () => {
        const e = StaleRideService.evaluate(running(), CONFIG, at(200));
        expect(e.action).toBe('flag_for_review');
        expect(e.reason).toBe(StaleActionReason.TRIP_EXCEEDED_EXPECTED_DURATION);
        expect(e.explanation).toContain('never auto-cancelled');
    });

    it('NEVER returns cancel for in_progress at any age', () => {
        for (const minutes of [130, 400, 1440, 10_000, 60 * 24 * 30]) {
            const e = StaleRideService.evaluate(running(), CONFIG, at(minutes));
            expect(e.action).not.toBe('cancel');
        }
    });

    it('also covers the legacy `started` status string', () => {
        const e = StaleRideService.evaluate(running({ status: 'started' }), CONFIG, at(300));
        expect(e.action).toBe('flag_for_review');
    });

    it('scales the threshold with the estimated trip duration', () => {
        // 90 min estimate x4 = 360 min, above the 120 min floor.
        const long = running({ estimatedDurationSec: 90 * 60 });
        expect(StaleRideService.inProgressReviewMinutes(long, CONFIG)).toBe(360);
        expect(StaleRideService.evaluate(long, CONFIG, at(200)).action).toBe('none');
    });

    it('applies the absolute cap to an absurd estimate', () => {
        const absurd = running({ estimatedDurationSec: 40 * 3600 });
        expect(StaleRideService.inProgressReviewMinutes(absurd, CONFIG))
            .toBe(CONFIG.inProgressAbsoluteMinutes);
    });

    it('does not re-flag a ride already under review', () => {
        const e = StaleRideService.evaluate(running({ requiresOperationsReview: true }), CONFIG, at(500));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('already flagged');
    });
});

describe('staged warning for accepted rides', () => {
    it('warns before the deadline, once', () => {
        // No ETA => 20 min deadline, warn at 60% = 12 min.
        const warn = StaleRideService.evaluate(ride(), CONFIG, at(13));
        expect(warn.action).toBe('warn');

        const already = StaleRideService.evaluate(ride({ staleWarnedAt: at(13) }), CONFIG, at(15));
        expect(already.action).toBe('none');
    });

    it('a warned ride is still cancelled when the deadline passes', () => {
        const e = StaleRideService.evaluate(ride({ staleWarnedAt: at(13) }), CONFIG, at(25));
        expect(e.action).toBe('cancel');
    });
});

describe('bounded extensions', () => {
    it('an extension defers the cancel', () => {
        const extended = ride({
            staleExtensionCount: 1,
            staleDeadlineOverrideAt: at(35),
        });
        // Past the 20 min base deadline, but inside the extension.
        expect(StaleRideService.evaluate(extended, CONFIG, at(30)).action).not.toBe('cancel');
        // Past the extension too.
        expect(StaleRideService.evaluate(extended, CONFIG, at(36)).action).toBe('cancel');
    });

    it('an extension can never shorten a deadline', () => {
        const e = StaleRideService.evaluate(
            ride({ staleDeadlineOverrideAt: at(5) }), CONFIG, at(10),
        );
        expect(e.action).not.toBe('cancel');
    });

    it('refuses a second extension past the configured maximum', () => {
        expect(StaleRideService.canExtend(ride({ staleExtensionCount: 0 }), CONFIG)).toBe(true);
        expect(StaleRideService.canExtend(ride({ staleExtensionCount: 1 }), CONFIG)).toBe(false);
    });

    it('refuses to extend a started or completed ride', () => {
        expect(StaleRideService.canExtend(ride({ startedAt: T0 }), CONFIG)).toBe(false);
        expect(StaleRideService.canExtend(ride({ completedAt: T0 }), CONFIG)).toBe(false);
        expect(StaleRideService.canExtend(ride({ status: 'in_progress' }), CONFIG)).toBe(false);
    });
});

describe('states outside the policy', () => {
    it('never sweeps searching, completed, canceled or failed', () => {
        for (const status of ['searching', 'completed', 'canceled', 'failed']) {
            const e = StaleRideService.evaluate(ride({ status }), CONFIG, at(10_000));
            expect(e.action).toBe('none');
        }
    });

    it('will not act on a ride with no reference timestamp', () => {
        const e = StaleRideService.evaluate(ride({ acceptedAt: null }), CONFIG, at(10_000));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('not evaluable');
    });
});

describe('configuration is honoured, not hardcoded', () => {
    it('a shorter configured minimum changes the outcome', () => {
        const tight = { ...CONFIG, acceptedMinMinutes: 5, acceptedMaxMinutes: 5 };
        expect(StaleRideService.evaluate(ride(), tight, at(6)).action).toBe('cancel');
    });

    it('the in-progress floor is configurable', () => {
        const loose = { ...CONFIG, inProgressMinMinutes: 600, inProgressAbsoluteMinutes: 600 };
        const running = ride({ status: 'in_progress', startedAt: T0 });
        expect(StaleRideService.evaluate(running, loose, at(300)).action).toBe('none');
    });
});
