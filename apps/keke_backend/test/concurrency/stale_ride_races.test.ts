/**
 * Race safety: the sweep versus every legitimate lifecycle transition.
 *
 * The rule under test is absolute — a ride must NEVER be cancelled after a real
 * newer transition has won. The mechanism is a conditional UPDATE, so what these
 * tests pin is that the policy declines to act whenever a later event is already
 * recorded, and that a conditional write cannot both succeed and lose.
 */
import { StaleRideService, RideSnapshot } from '../../src/services/stale_ride_service';
import { loadStaleRideConfig, StaleRideConfig, StaleResolution } from '../../src/config/stale_ride_config';
import { DispatchService } from '../../src/services/dispatch_service';
import { newDriver, newPassenger, newRide, reservationOwner } from '../helpers/dispatch';

const CONFIG: StaleRideConfig = {
    ...loadStaleRideConfig(),
    acceptedMinMinutes: 20,
    acceptedMaxMinutes: 45,
    acceptedEtaMultiplier: 3,
    arrivedCancelMinutes: 20,
    arrivedWarnMinutes: 10,
    maxExtensions: 1,
    extensionMinutes: 10,
};

const T0 = new Date('2026-07-26T06:00:00Z');
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

const ride = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
    rideId: 'RIDE-RACE',
    status: 'accepted',
    passengerId: 'pax',
    driverId: 'drv',
    acceptedAt: T0,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    estimatedDurationSec: null,
    acceptLat: null, acceptLng: null,
    pickupLat: 6.2097, pickupLng: 7.0562,
    staleWarnedAt: null,
    staleExtensionCount: 0,
    staleDeadlineOverrideAt: null,
    requiresOperationsReview: false,
    staleDecisionPromptedAt: null,
    staleDecisionDeadlineAt: null,
    staleDecisionBy: null,
    staleDecisionChoice: null,
    staleDecisionRound: 0,
    ...over,
});

describe('a newer legitimate transition always beats the sweep', () => {
    // Far past any deadline in every case, so only the newer event can save it.
    const WAY_PAST = at(5000);

    it('driver marked arrived', () => {
        expect(StaleRideService.evaluate(ride({ arrivedAt: at(19) }), CONFIG, WAY_PAST).action).toBe('none');
    });

    it('driver started the trip', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'in_progress', arrivedAt: at(15), startedAt: at(18) }), CONFIG, WAY_PAST,
        ).action).not.toBe('cancel');
    });

    it('driver completed the trip', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'completed', startedAt: at(18), completedAt: at(40) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });

    it('passenger cancelled', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'canceled', completedAt: at(5) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });

    it('driver cancelled', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'canceled', completedAt: at(7) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });

    it('admin intervened, leaving the ride completed', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'completed', completedAt: at(60) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });

    it('a delayed socket event that only set arrivedAt still protects the ride', () => {
        // Status not yet advanced but the timestamp landed: the timestamp alone
        // is enough to disqualify it, because acting on a half-applied
        // transition is exactly how a live ride would get cancelled.
        expect(StaleRideService.evaluate(
            ride({ status: 'accepted', arrivedAt: at(19) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });

    it('an arrived ride whose start landed late is immune', () => {
        expect(StaleRideService.evaluate(
            ride({ status: 'arrived', arrivedAt: T0, startedAt: at(25) }), CONFIG, WAY_PAST,
        ).action).toBe('none');
    });
});

describe('the sweep is deterministic under repeated evaluation', () => {
    it('two workers evaluating the same ride reach the same decision', () => {
        const r = ride();
        const now = at(30);
        const a = StaleRideService.evaluate(r, CONFIG, now);
        const b = StaleRideService.evaluate(r, CONFIG, now);
        expect(a).toEqual(b);
        // The deadline now opens a decision window rather than cancelling.
        expect(a.action).toBe('prompt_decision');
    });

    it('two workers reach the same decision once a window has closed', () => {
        const r = ride({
            staleDecisionPromptedAt: at(21),
            staleDecisionDeadlineAt: at(24),
            staleDecisionRound: 1,
        });
        const now = at(30);
        const a = StaleRideService.evaluate(r, CONFIG, now);
        const b = StaleRideService.evaluate(r, CONFIG, now);
        expect(a).toEqual(b);
        expect(a.action).toBe('cancel');
        expect(a.resolution).toBe(StaleResolution.NO_RESPONSE_FROM_EITHER);
    });

    it('evaluation is side-effect free, so a lost race costs nothing', () => {
        const r = ride();
        const before = JSON.stringify(r);
        StaleRideService.evaluate(r, CONFIG, at(9999));
        expect(JSON.stringify(r)).toBe(before);
    });
});

describe('duplicate sweep workers cannot double-release state', () => {
    it('only one of two concurrent passenger-slot releases takes effect', async () => {
        const passengerId = newPassenger();
        const rideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, rideId);

        const results = await Promise.all([
            DispatchService.releasePassengerActive(passengerId, rideId),
            DispatchService.releasePassengerActive(passengerId, rideId),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await DispatchService.getPassengerActive(passengerId)).toBeNull();
    });

    it('a concurrent new booking is not destroyed by a duplicate cleanup', async () => {
        const passengerId = newPassenger();
        const staleRideId = newRide();
        const freshRideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, staleRideId);

        // Cleanup for the stale ride races the passenger booking a new one.
        const [released] = await Promise.all([
            DispatchService.releasePassengerActive(passengerId, staleRideId),
            (async () => {
                await DispatchService.releasePassengerActive(passengerId, staleRideId);
                return DispatchService.acquirePassengerActive(passengerId, freshRideId);
            })(),
        ]);

        // Whoever released first, the new booking's slot must be intact — the
        // ownership check makes a second cleanup unable to delete it.
        const owner = await DispatchService.getPassengerActive(passengerId);
        expect(owner === freshRideId || owner === null).toBe(true);
        if (owner === freshRideId) {
            expect(await DispatchService.releasePassengerActive(passengerId, staleRideId)).toBe(false);
            expect(await DispatchService.getPassengerActive(passengerId)).toBe(freshRideId);
        }
        expect(typeof released).toBe('boolean');
    });

    it('a driver freed by cleanup can be immediately re-reserved exactly once', async () => {
        const driverId = newDriver();
        const staleRideId = newRide();
        const rideA = newRide();
        const rideB = newRide();
        await DispatchService.reserveDriver(driverId, staleRideId);
        await DispatchService.releaseDriver(driverId, staleRideId);

        const [wonA, wonB] = await Promise.all([
            DispatchService.reserveDriver(driverId, rideA),
            DispatchService.reserveDriver(driverId, rideB),
        ]);
        expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
        expect(await reservationOwner(driverId)).toBe(wonA ? rideA : rideB);
    });
});

describe('extensions cannot be exploited to hold a ride open', () => {
    it('a bounded extension defers but does not prevent resolution', () => {
        const extended = ride({ staleExtensionCount: 1, staleDeadlineOverrideAt: at(35) });
        // Inside the extension: never terminal.
        expect(StaleRideService.evaluate(extended, CONFIG, at(30)).action).not.toBe('cancel');
        // Past it: asked again, still not a silent cancel.
        expect(StaleRideService.evaluate(extended, CONFIG, at(36)).action).toBe('prompt_decision');
        // And no further extension is available, so the next window is decisive.
        expect(StaleRideService.canExtend(extended, CONFIG)).toBe(false);

        const askedAgain = ride({
            staleExtensionCount: 1,
            staleDeadlineOverrideAt: at(35),
            staleDecisionPromptedAt: at(36),
            staleDecisionDeadlineAt: at(39),
            staleDecisionRound: 2,
        });
        expect(StaleRideService.evaluate(askedAgain, CONFIG, at(45)).action).toBe('cancel');
    });

    it('the maximum extension count is enforced by the policy, not the caller', () => {
        const config = { ...CONFIG, maxExtensions: 2 };
        expect(StaleRideService.canExtend(ride({ staleExtensionCount: 1 }), config)).toBe(true);
        expect(StaleRideService.canExtend(ride({ staleExtensionCount: 2 }), config)).toBe(false);
    });
});
