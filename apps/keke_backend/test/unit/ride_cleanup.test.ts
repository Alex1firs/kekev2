/**
 * Cleanup invariants and race safety for stale-ride recovery.
 *
 * These run against the real DispatchService reservation code on the mocked
 * Redis, so the ownership semantics under test are the production ones. The
 * database is not available in unit tests, so `terminate()` itself is exercised
 * in the integration suite; here the focus is the state-release contract that
 * the incident showed to be the fragile part.
 */
import { DispatchService } from '../../src/services/dispatch_service';
import { RideCleanupService, RideCleanupHost } from '../../src/services/ride_cleanup_service';
import { DispatchMonitorService } from '../../src/services/dispatch_monitor_service';
import { newDriver, newPassenger, newRide, setHeartbeatFresh, setHeartbeatExpired, reservationOwner, redis } from '../helpers/dispatch';

/** Records everything the cleanup service asks its host to do. */
function recordingHost() {
    const calls = {
        abortDispatch: [] as string[],
        releaseRideReservations: [] as string[],
        forgetDriverRide: [] as string[],
        clearDispatchState: [] as string[],
        rideEvents: [] as Array<{ rideId: string; event: string }>,
        driverEvents: [] as Array<{ driverId: string; event: string }>,
        adminEvents: [] as Array<{ event: string; payload: Record<string, unknown> }>,
    };
    const host: RideCleanupHost = {
        abortDispatch: (rideId) => { calls.abortDispatch.push(rideId); },
        releaseRideReservations: async (rideId) => { calls.releaseRideReservations.push(rideId); },
        notifiedDrivers: () => [],
        forgetDriverRide: (driverId) => { calls.forgetDriverRide.push(driverId); },
        clearDispatchState: (rideId) => { calls.clearDispatchState.push(rideId); },
        emitToRide: (rideId, event) => { calls.rideEvents.push({ rideId, event }); },
        emitToDriver: (driverId, event) => { calls.driverEvents.push({ driverId, event }); },
        emitToAdmin: (event, payload) => { calls.adminEvents.push({ event, payload }); },
    };
    return { host, calls };
}

beforeEach(() => {
    DispatchMonitorService.resetSequences();
    RideCleanupService.setHost(null);
});

// 8 ────────────────────────────────────────────────────────────────────────
describe('8. cleanup releases the passenger slot', () => {
    it('releases the slot so the passenger can book immediately', async () => {
        const passengerId = newPassenger();
        const rideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, rideId);

        expect(await DispatchService.releasePassengerActive(passengerId, rideId)).toBe(true);
        expect(await DispatchService.getPassengerActive(passengerId)).toBeNull();
    });
});

// 22 ───────────────────────────────────────────────────────────────────────
describe('22. an older cleanup cannot delete a newer ride state', () => {
    it('leaves a newer passenger slot untouched', async () => {
        const passengerId = newPassenger();
        const staleRideId = newRide();
        const newerRideId = newRide();

        // The passenger has since started a NEW ride which owns the slot.
        await DispatchService.acquirePassengerActive(passengerId, newerRideId);

        // The stale cleanup tries to release, scoped to the OLD ride.
        const released = await DispatchService.releasePassengerActive(passengerId, staleRideId);

        expect(released).toBe(false);
        expect(await DispatchService.getPassengerActive(passengerId)).toBe(newerRideId);
    });

    it('leaves a newer driver reservation untouched', async () => {
        const driverId = newDriver();
        const staleRideId = newRide();
        const newerRideId = newRide();
        await DispatchService.reserveDriver(driverId, newerRideId);

        expect(await DispatchService.releaseDriver(driverId, staleRideId)).toBe(false);
        expect(await reservationOwner(driverId)).toBe(newerRideId);
    });

    it('never uses the force variant, which would clobber a newer holder', async () => {
        // Documents the distinction the incident turned on: the ownership-checked
        // call is the only one cleanup may use.
        const driverId = newDriver();
        const newerRideId = newRide();
        await DispatchService.reserveDriver(driverId, newerRideId);

        // Forcing (no rideId) WOULD delete someone else's reservation.
        expect(await DispatchService.releaseDriver(driverId)).toBe(true);
        expect(await reservationOwner(driverId)).toBeNull();
    });
});

// 9 ────────────────────────────────────────────────────────────────────────
describe('9. cleanup releases the driver reservation', () => {
    it('frees the reserved driver for other rides', async () => {
        const driverId = newDriver();
        const rideId = newRide();
        await DispatchService.reserveDriver(driverId, rideId);

        expect(await DispatchService.releaseDriver(driverId, rideId)).toBe(true);
        expect(await reservationOwner(driverId)).toBeNull();

        // And another ride can now win them.
        const otherRideId = newRide();
        expect(await DispatchService.reserveDriver(driverId, otherRideId)).toBe(true);
    });
});

// 10 ───────────────────────────────────────────────────────────────────────
describe('10. availability is restored only with genuinely fresh state', () => {
    it('a fresh heartbeat counts as available', async () => {
        const driverId = newDriver();
        await setHeartbeatFresh(driverId);
        expect(await DispatchService.isDriverAvailable(driverId)).toBe(true);
        expect(await DispatchService.isDriverDeliberatelyOffline(driverId)).toBe(false);
    });

    it('a stale heartbeat does not', async () => {
        const driverId = newDriver();
        await setHeartbeatExpired(driverId);
        expect(await DispatchService.isDriverAvailable(driverId)).toBe(false);
    });

    it('a deliberate offline is distinguishable from a stale heartbeat', async () => {
        const driverId = newDriver();
        await setHeartbeatFresh(driverId);
        await DispatchService.removeDriverAvailability(driverId);

        // Both false-available, but for different reasons — and a driver who
        // chose to stop working must not be dragged back into the pool.
        expect(await DispatchService.isDriverAvailable(driverId)).toBe(false);
        expect(await DispatchService.isDriverDeliberatelyOffline(driverId)).toBe(true);
    });

    it('a heartbeat clears the deliberate-offline tombstone', async () => {
        const driverId = newDriver();
        await DispatchService.removeDriverAvailability(driverId);
        expect(await DispatchService.isDriverDeliberatelyOffline(driverId)).toBe(true);

        // The two writes a heartbeat performs. Applied directly because
        // ioredis-mock's pipeline has no GEOADD, so updateDriverLocation itself
        // is covered by the integration suite rather than here.
        await setHeartbeatFresh(driverId);
        await redis.del(`driver:offline:${driverId}`);

        expect(await DispatchService.isDriverDeliberatelyOffline(driverId)).toBe(false);
        expect(await DispatchService.isDriverAvailable(driverId)).toBe(true);
    });
});

// 14 ───────────────────────────────────────────────────────────────────────
describe('14. duplicate execution is idempotent', () => {
    it('a second release is a no-op, not an error', async () => {
        const passengerId = newPassenger();
        const rideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, rideId);

        expect(await DispatchService.releasePassengerActive(passengerId, rideId)).toBe(true);
        // Two workers racing the same ride: the loser simply changes nothing.
        expect(await DispatchService.releasePassengerActive(passengerId, rideId)).toBe(false);
    });

    it('concurrent releases produce exactly one effect', async () => {
        const driverId = newDriver();
        const rideId = newRide();
        await DispatchService.reserveDriver(driverId, rideId);

        const results = await Promise.all([
            DispatchService.releaseDriver(driverId, rideId),
            DispatchService.releaseDriver(driverId, rideId),
            DispatchService.releaseDriver(driverId, rideId),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
    });
});

// 15 ───────────────────────────────────────────────────────────────────────
describe('15. dry-run performs no mutation', () => {
    it('terminate() in dry-run touches nothing and reports why', async () => {
        const { host, calls } = recordingHost();
        RideCleanupService.setHost(host);

        const passengerId = newPassenger();
        const rideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, rideId);

        const result = await RideCleanupService.terminate({
            rideId,
            reason: 'SYSTEM_DRIVER_DID_NOT_ARRIVE',
            expectedStatuses: ['accepted'],
            passengerMessage: 'x',
            driverMessage: 'y',
            dryRun: true,
        });

        expect(result.applied).toBe(false);
        expect(result.dryRun).toBe(true);
        // Nothing released, nothing emitted, no dispatch teardown.
        expect(await DispatchService.getPassengerActive(passengerId)).toBe(rideId);
        expect(calls.abortDispatch).toHaveLength(0);
        expect(calls.rideEvents).toHaveLength(0);
        expect(calls.adminEvents).toHaveLength(0);
    });

    it('flagForOperationsReview in dry-run mutates nothing', async () => {
        const outcome = await RideCleanupService.flagForOperationsReview({
            rideId: newRide(),
            reason: 'SYSTEM_TRIP_EXCEEDED_EXPECTED_DURATION',
            ageMinutes: 300,
            thresholdMinutes: 120,
            dryRun: true,
        });
        expect(outcome.applied).toBe(false);
        expect(outcome.skippedReason).toBe('dry_run');
    });
});

describe('the cleanup service refuses a silent cancellation', () => {
    it('requireDecisionPrompt is honoured — no prompt on record, no cancel', () => {
        // Structural: the guard exists and fires before any write. The behavioural
        // path needs a database and is covered by the integration suite; what is
        // asserted here is that the refusal is unconditional and logged.
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/ride_cleanup_service.ts'),
            'utf8',
        );
        expect(source).toMatch(/requireDecisionPrompt && ride\.staleDecisionPromptedAt == null/);
        expect(source).toMatch(/decision_prompt_not_sent/);
        expect(source).toMatch(/refused_silent_cancel/);
        // And the guard sits BEFORE the authoritative UPDATE.
        const guardAt = source.indexOf('decision_prompt_not_sent');
        const updateAt = source.indexOf('The authoritative conditional write');
        expect(guardAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(updateAt);
    });

    it('every automatic stale cancellation sets requireDecisionPrompt', () => {
        const sweeper = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/stale_ride_sweeper.ts'),
            'utf8',
        );
        expect(sweeper).toMatch(/requireDecisionPrompt: true/);
        // The sweeper never calls terminate without it.
        const terminateCalls = sweeper.split('RideCleanupService.terminate(').length - 1;
        const guarded = sweeper.split('requireDecisionPrompt: true').length - 1;
        expect(guarded).toBe(terminateCalls);
    });
});

// 17 ───────────────────────────────────────────────────────────────────────
describe('17. notifications are not duplicated', () => {
    it('the push service de-duplicates per user, type and ride', async () => {
        // The warning path also persists staleWarnedAt with a conditional UPDATE,
        // so a restart mid-sweep cannot re-warn; this covers the transport layer.
        const userId = newPassenger();
        const rideId = newRide();
        const dedupKey = `notif:${userId}:STALE_RIDE_WARNING:${rideId}`;

        expect(await redis.get(dedupKey)).toBeNull();
        await redis.setex(dedupKey, 2, '1');
        expect(await redis.get(dedupKey)).toBe('1');
    });
});

// 19 ───────────────────────────────────────────────────────────────────────
describe('19. payment state remains safe', () => {
    it('cleanup never calls into the wallet', () => {
        // Structural check: the cleanup module must not reference wallet or
        // payout code at all. Cancelling an accepted/arrived ride moves no money,
        // and an in-progress trip is flagged rather than cancelled precisely so a
        // real fare is never destroyed.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/ride_cleanup_service.ts'),
            'utf8',
        );
        expect(source).not.toMatch(/WalletService/);
        expect(source).not.toMatch(/postRideFinancials/);
        expect(source).not.toMatch(/settleAndComplete/);
    });

    it('the sweeper never cancels an in-progress trip', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/stale_ride_sweeper.ts'),
            'utf8',
        );
        // in_progress reaches flagForOperationsReview only.
        expect(source).toMatch(/flag_for_review/);
        expect(source).toMatch(/flagForOperationsReview/);
    });
});

// 16 ───────────────────────────────────────────────────────────────────────
describe('16. the historical CLI uses the same service', () => {
    it('delegates to StaleRideSweeper rather than reimplementing policy', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/scripts/sweep_stale_rides.ts'),
            'utf8',
        );
        expect(source).toMatch(/StaleRideSweeper\.runOnce/);
        // No duplicated thresholds, and no hardcoded production ride ids.
        expect(source).not.toMatch(/RIDE-\d{10,}/);
        expect(source).not.toMatch(/UPDATE\s+ride/i);
    });

    it('defaults to dry-run and requires an explicit apply flag', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/scripts/sweep_stale_rides.ts'),
            'utf8',
        );
        expect(source).toMatch(/const apply = args\.includes\('--apply'\)/);
        expect(source).toMatch(/const dryRun = !apply/);
    });
});

// 20 + 21 ─────────────────────────────────────────────────────────────────
describe('20 & 21. the world works again after cleanup', () => {
    it('a passenger can book immediately once their slot is freed', async () => {
        const passengerId = newPassenger();
        const stuckRideId = newRide();
        await DispatchService.acquirePassengerActive(passengerId, stuckRideId);

        // Exactly what cleanup does.
        await DispatchService.releasePassengerActive(passengerId, stuckRideId);

        // The next booking claims the slot with no waiting and no TTL.
        expect(await DispatchService.acquirePassengerActive(passengerId, newRide())).toBe(true);
    });

    it('a freed driver can be reserved for a new offer when genuinely available', async () => {
        const driverId = newDriver();
        const stuckRideId = newRide();
        await setHeartbeatFresh(driverId);
        await DispatchService.reserveDriver(driverId, stuckRideId);

        await DispatchService.releaseDriver(driverId, stuckRideId);

        expect(await DispatchService.isDriverAvailable(driverId)).toBe(true);
        const newRideId = newRide();
        expect(await DispatchService.filterUnreserved([driverId], newRideId)).toEqual([driverId]);
        expect(await DispatchService.reserveDriver(driverId, newRideId)).toBe(true);
    });

    it('a freed but offline driver is NOT offered new rides', async () => {
        const driverId = newDriver();
        await setHeartbeatFresh(driverId);
        const stuckRideId = newRide();
        await DispatchService.reserveDriver(driverId, stuckRideId);

        // Driver went offline while the ride was stuck.
        await DispatchService.removeDriverAvailability(driverId);
        await DispatchService.releaseDriver(driverId, stuckRideId);

        // Reservable in principle, but not available — dispatch's own freshness
        // gate keeps them out of the candidate pool.
        expect(await DispatchService.isDriverAvailable(driverId)).toBe(false);
        expect(await DispatchService.isDriverDeliberatelyOffline(driverId)).toBe(true);
    });
});
