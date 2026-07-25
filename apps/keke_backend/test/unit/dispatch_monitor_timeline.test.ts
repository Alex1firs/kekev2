/**
 * End-to-end admin timeline, driven by the REAL dispatch orchestrator.
 *
 * The orchestrator harness runs an actual two-round dispatch against the real
 * reservation code, and every log event it emits is projected exactly as
 * production projects it. So these assertions describe what an operator would
 * genuinely see in Live Ride Requests for each scenario.
 */
import { OrchestratorHarness } from '../helpers/orchestrator';
import { newDriver, newRide, setHeartbeatFresh, DispatchService } from '../helpers/dispatch';
import { projectDispatchEvent } from '../../src/services/dispatch_event_projection';
import { DispatchEventType } from '../../src/models/DispatchEvent';
import type { RecordArgs } from '../../src/services/dispatch_monitor_service';

const PICKUP = { lat: 6.2097, lng: 7.0562 };

const FAST = {
    radiusTiersKm: [2],
    roundTwoRadiusTiersKm: [6],
    offerDurationMs: 4_000,
    emptyTierPauseMs: 300,
    roundGapMs: 200,
    reofferCooldownMs: 1_000_000,
    maxSearchLifetimeMs: 300_000,
    minRoundHeadroomMs: 200,
};

/** Run a harness and return the admin trail its events would produce. */
async function runAndProject(h: OrchestratorHarness): Promise<RecordArgs[]> {
    await h.orchestrator.run(h.run, PICKUP);
    const rows: RecordArgs[] = [];
    for (const entry of h.logs) {
        rows.push(...projectDispatchEvent(h.rideId, entry.event, entry.fields));
    }
    return rows;
}

const typesOf = (rows: RecordArgs[]) => rows.map((r) => r.eventType);
const forDriver = (rows: RecordArgs[], driverId: string) =>
    rows.filter((r) => r.driverId === driverId);

describe('1. a ride appears in the monitor immediately', () => {
    it('the very first projected row for a round is the round start', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await setHeartbeatFresh(d);

        const rows = await runAndProject(h);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].eventType).toBe(DispatchEventType.ROUND_STARTED);
        // RIDE_CREATED is written by the ride:request handler before dispatch
        // begins, so the request is visible before any candidate exists.
        expect(typesOf(rows)).not.toContain(DispatchEventType.RIDE_CREATED);
    });
});

describe('2. eligible drivers are listed correctly', () => {
    it('records one candidate row per discovered driver, with distance', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const near = newDriver();
        const far = newDriver();
        h.drivers = [
            { driverId: near, withinKm: 1, distanceKm: 0.8 },
            { driverId: far, withinKm: 2, distanceKm: 1.9 },
        ];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        // Both drivers sit inside round two's wider tier as well, so each is
        // rediscovered there — a distinct, real event, not a duplicate.
        const round1 = rows.filter(
            (r) => r.eventType === DispatchEventType.CANDIDATE_DISCOVERED && r.dispatchRound === 1,
        );
        expect(round1.map((r) => r.driverId).sort()).toEqual([near, far].sort());
        expect(round1.find((r) => r.driverId === near)!.distanceKm).toBe(0.8);
        const discovered = round1;
        // Freshness is looked up at write time for candidate rows.
        expect(discovered.every((r) => r.withFreshness === true)).toBe(true);
    });

    it('records an ineligible driver with its reason, not as a candidate offer', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const blocked = newDriver();
        h.drivers = [{ driverId: blocked, withinKm: 1, ineligibleReason: 'cash_debt_blocked' }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const rejected = rows.filter(
            (r) => r.eventType === DispatchEventType.ELIGIBILITY_REJECTED && r.dispatchRound === 1,
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0].detail).toMatchObject({ reason: 'cash_debt_blocked' });
        expect(typesOf(rows)).not.toContain(DispatchEventType.NOTIFICATION_QUEUED);
    });
});

describe('3. notification events are recorded at their true strength', () => {
    it('a socket-delivered offer records queued + socket emitted, never "delivered"', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1, delivery: { delivered: true, socketDelivered: true, pushSuccessCount: 0 } }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const mine = typesOf(forDriver(rows, d));
        expect(mine).toContain(DispatchEventType.NOTIFICATION_QUEUED);
        expect(mine).toContain(DispatchEventType.SOCKET_OFFER_EMITTED);
        expect(mine).not.toContain(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER);
        expect(mine).not.toContain(DispatchEventType.DEVICE_OFFER_ACK);
    });

    it('a push-only offer records FCM acceptance, not socket emission', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1, delivery: { delivered: true, socketDelivered: false, pushSuccessCount: 2 } }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const mine = forDriver(rows, d);
        const fcm = mine.find((r) => r.eventType === DispatchEventType.FCM_ACCEPTED_BY_PROVIDER);
        expect(fcm).toBeDefined();
        expect(fcm!.detail).toMatchObject({ acceptedTokenCount: 2 });
        expect(typesOf(mine)).not.toContain(DispatchEventType.SOCKET_OFFER_EMITTED);
    });

    it('an undeliverable offer records a delivery failure with its reason', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{
            driverId: d,
            withinKm: 1,
            delivery: { delivered: false, socketDelivered: false, pushSuccessCount: 0, reason: 'no_socket_no_push' },
        }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const failed = forDriver(rows, d).find((r) => r.eventType === DispatchEventType.OFFER_DELIVERY_FAILED);
        expect(failed).toBeDefined();
        expect(failed!.detail).toMatchObject({ reason: 'no_socket_no_push' });
        // An offer that reached nothing is never counted as expired.
        expect(typesOf(forDriver(rows, d))).not.toContain(DispatchEventType.OFFER_EXPIRED);
    });
});

describe('4. rejection and expiry appear as distinct timeline entries', () => {
    it('an unanswered offer records an expiry', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        expect(typesOf(forDriver(rows, d))).toContain(DispatchEventType.OFFER_EXPIRED);
    });

    it('an explicitly rejected offer records NO expiry for that driver', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await h.primeHeartbeats();
        h.reactToOffer(d, 500, () => h.run.noteRejection(d));

        const rows = await runAndProject(h);
        // The rejection row itself comes from the ride:reject handler; what
        // matters here is that dispatch does not ALSO claim it expired.
        expect(typesOf(forDriver(rows, d))).not.toContain(DispatchEventType.OFFER_EXPIRED);
    });
});

describe('5. the automatic second round is visible as a transition', () => {
    it('records a round transition and a second round start', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const near = newDriver();
        const far = newDriver();
        h.drivers = [
            { driverId: near, withinKm: 1 },
            { driverId: far, withinKm: 6 },
        ];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const transitions = rows.filter((r) => r.eventType === DispatchEventType.ROUND_TRANSITION);
        expect(transitions).toHaveLength(1);
        expect(transitions[0].detail).toMatchObject({ fromRound: 1, toRound: 2 });
        expect(transitions[0].dispatchRound).toBe(2);

        const starts = rows.filter((r) => r.eventType === DispatchEventType.ROUND_STARTED);
        expect(starts.map((r) => r.dispatchRound)).toEqual([1, 2]);
        // The wider tier is recorded, so an operator can see the search grew.
        const round2Discovery = rows.filter(
            (r) => r.eventType === DispatchEventType.CANDIDATE_DISCOVERED && r.dispatchRound === 2,
        );
        expect(round2Discovery.some((r) => r.driverId === far)).toBe(true);
        expect(round2Discovery[0].radiusKm).toBe(6);
    });
});

describe('6. acceptance ends the trail', () => {
    it('stops producing offer rows once a driver accepts', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const a = newDriver();
        const b = newDriver();
        h.drivers = [
            { driverId: a, withinKm: 1 },
            { driverId: b, withinKm: 6 },
        ];
        await h.primeHeartbeats();
        h.reactToOffer(a, 500, () => {
            h.assigned = true;
            h.rideStatus = 'accepted';
            h.run.noteAcceptance(a);
        });

        const rows = await runAndProject(h);
        // No second round, so the far driver never enters the trail.
        expect(rows.filter((r) => r.driverId === b)).toHaveLength(0);
        expect(typesOf(rows)).not.toContain(DispatchEventType.ROUND_TRANSITION);
        // Dispatch ended successfully, so no failure row is written.
        expect(typesOf(rows)).not.toContain(DispatchEventType.DISPATCH_FAILED);
    });
});

describe('7. cancellation', () => {
    it('produces no dispatch-failure row when the passenger cancels', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await h.primeHeartbeats();
        h.at(1_000, () => {
            h.rideStatus = 'canceled';
            h.run.abort('cancelled');
        });

        const rows = await runAndProject(h);
        // The cancel handler writes the authoritative RIDE_CANCELLED row; the
        // dispatcher must not additionally report a driver-availability failure.
        expect(typesOf(rows)).not.toContain(DispatchEventType.DISPATCH_FAILED);
        expect(typesOf(rows)).not.toContain(DispatchEventType.ROUND_TRANSITION);
    });
});

describe('8. the no-driver final result carries its outcome code', () => {
    it('records NO_DRIVER_ACCEPTED when offers were genuinely delivered', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const failure = rows.find((r) => r.eventType === DispatchEventType.DISPATCH_FAILED);
        expect(failure).toBeDefined();
        expect(failure!.detail).toMatchObject({
            outcomeCode: 'NO_DRIVER_ACCEPTED',
            dispatchResult: 'offers_delivered_none_accepted',
        });
    });

    it('records NO_ELIGIBLE_DRIVER when nothing reached a device', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{
            driverId: d,
            withinKm: 1,
            delivery: { delivered: false, socketDelivered: false, pushSuccessCount: 0, reason: 'no_socket_no_push' },
        }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const failure = rows.find((r) => r.eventType === DispatchEventType.DISPATCH_FAILED);
        expect(failure!.detail).toMatchObject({
            outcomeCode: 'NO_ELIGIBLE_DRIVER',
            dispatchResult: 'offers_all_failed_delivery',
        });
    });
});

describe('9. a stale heartbeat is recorded as such, not as an ignored offer', () => {
    it('records a stale candidate and never an offer for that driver', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const stale = newDriver();
        h.drivers = [{ driverId: stale, withinKm: 1, available: false }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const mine = typesOf(forDriver(rows, stale));
        expect(mine).toContain(DispatchEventType.CANDIDATE_STALE);
        expect(mine).not.toContain(DispatchEventType.NOTIFICATION_QUEUED);
        expect(mine).not.toContain(DispatchEventType.OFFER_EXPIRED);
        expect(mine).not.toContain(DispatchEventType.DRIVER_REJECTED);
    });
});

describe('10. a reservation conflict is attributed to the owning ride', () => {
    it('records the conflict with the ride that holds the driver', async () => {
        const rideId = newRide();
        const otherRideId = newRide();
        const taken = newDriver();
        expect(await DispatchService.reserveDriver(taken, otherRideId)).toBe(true);

        const h = new OrchestratorHarness(rideId, FAST);
        h.drivers = [{ driverId: taken, withinKm: 1 }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        const conflict = forDriver(rows, taken).find(
            (r) => r.eventType === DispatchEventType.RESERVATION_CONFLICT,
        );
        expect(conflict).toBeDefined();
        expect(conflict!.detail).toMatchObject({ reservedBy: otherRideId });
        // A conflicted driver is never shown as having been offered anything.
        expect(typesOf(forDriver(rows, taken))).not.toContain(DispatchEventType.NOTIFICATION_QUEUED);
    });
});

describe('11. concurrent active requests stay separated', () => {
    it('projects each ride onto its own trail with its own rounds', async () => {
        const rideA = newRide();
        const rideB = newRide();
        const dA = newDriver();
        const dB = newDriver();

        const hA = new OrchestratorHarness(rideA, FAST);
        const hB = new OrchestratorHarness(rideB, FAST);
        hA.drivers = [{ driverId: dA, withinKm: 1 }];
        hB.drivers = [{ driverId: dB, withinKm: 1 }];
        await Promise.all([setHeartbeatFresh(dA), setHeartbeatFresh(dB)]);

        const [rowsA, rowsB] = await Promise.all([runAndProject(hA), runAndProject(hB)]);

        expect(rowsA.every((r) => r.rideId === rideA)).toBe(true);
        expect(rowsB.every((r) => r.rideId === rideB)).toBe(true);
        expect(rowsA.some((r) => r.driverId === dB)).toBe(false);
        expect(rowsB.some((r) => r.driverId === dA)).toBe(false);
    });
});

describe('12. projection safety', () => {
    it('drops orchestrator events with no honest counterpart', () => {
        for (const event of ['no_target', 'release', 'assign', 'dispatch_outcome', 'search_lifetime_exceeded']) {
            expect(projectDispatchEvent('RIDE-1', event, { rideId: 'RIDE-1' })).toEqual([]);
        }
    });

    it('drops an unknown future event rather than guessing', () => {
        expect(projectDispatchEvent('RIDE-1', 'some_new_event_we_added_later', { x: 1 })).toEqual([]);
    });

    it('never emits a row for an event that only proves queueing', () => {
        const rows = projectDispatchEvent('RIDE-1', 'offer_sent', {
            driverId: 'd1',
            socketDelivered: false,
            pushSuccessCount: 0,
        });
        // Neither transport confirmed anything: no delivery row at all.
        expect(rows).toEqual([]);
    });

    it('a malformed candidate list cannot crash the projection', () => {
        expect(projectDispatchEvent('RIDE-1', 'candidates_discovered', { candidates: null })).toEqual([]);
        expect(projectDispatchEvent('RIDE-1', 'candidates_discovered', {
            candidates: [{ noDriverId: true }, null, { driverId: 'ok' }],
        })).toHaveLength(1);
    });

    it('handles a large volume of candidates without degrading', () => {
        const candidates = Array.from({ length: 2000 }, (_, i) => ({ driverId: `d${i}`, distanceKm: i / 100 }));
        const started = Date.now();
        const rows = projectDispatchEvent('RIDE-1', 'candidates_discovered', { candidates, round: 1, radiusKm: 5 });
        const elapsed = Date.now() - started;
        expect(rows).toHaveLength(2000);
        // Pure mapping — must stay far below any realistic dispatch budget.
        expect(elapsed).toBeLessThan(500);
    });

    it('every projected row carries the ride id it belongs to', async () => {
        const h = new OrchestratorHarness(newRide(), FAST);
        const d = newDriver();
        h.drivers = [{ driverId: d, withinKm: 1 }];
        await h.primeHeartbeats();

        const rows = await runAndProject(h);
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.rideId)).size).toBe(1);
    });
});
