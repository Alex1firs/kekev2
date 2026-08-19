/**
 * Ride Operations: outcome attribution, the telemetry kill switch, and the
 * guarantee that observability can never cost a passenger a ride.
 *
 * Two things are being defended here, and they pull in opposite directions:
 *
 *   1. Every terminal ride must be explainable. `failed` with no reason is the
 *      defect this work exists to remove.
 *   2. Nothing added in pursuit of (1) may touch the live ride path. Telemetry
 *      is allowed to lose data; dispatch is not allowed to lose a ride.
 *
 * The failure-injection group is the important one. It is easy to write
 * telemetry that works and hard to write telemetry that fails safely, and the
 * failure mode only appears in production, at night, when the database is
 * already having a bad time.
 */
import {
    RideOutcomeCode,
    CancelActorRole,
    OutcomeClass,
    classifyOutcome,
    outcomeFromDispatchCode,
    outcomeFromCancellationReason,
    outcomeLabel,
    OUTCOME_LABELS,
    LEGACY_UNAVAILABLE,
} from '../../src/services/ride_outcome';
import { RideOperationsSwitch } from '../../src/services/ride_operations_switch';
import { projectDispatchEvent } from '../../src/services/dispatch_event_projection';
import { DispatchEventType } from '../../src/models/DispatchEvent';
import { DispatchMonitorService } from '../../src/services/dispatch_monitor_service';

// ══════════════════════════════════════════════════════════════════════
//  Outcome codes: stable, machine-readable, never inferred
// ══════════════════════════════════════════════════════════════════════

describe('dispatch outcomes map onto ride outcomes', () => {
    it('translates every code DispatchEvidence can produce', () => {
        // If DispatchEvidence gains a code and this mapping is not updated, the
        // ride silently records TECHNICAL_FAILURE instead — a supply problem
        // misfiled as an outage. This test is the tripwire for that.
        expect(outcomeFromDispatchCode('NO_ELIGIBLE_DRIVER')).toBe(RideOutcomeCode.NO_ELIGIBLE_DRIVER);
        expect(outcomeFromDispatchCode('NO_DRIVER_ACCEPTED')).toBe(RideOutcomeCode.NO_DRIVER_ACCEPTED);
        expect(outcomeFromDispatchCode('REQUEST_EXPIRED')).toBe(RideOutcomeCode.REQUEST_EXPIRED);
    });

    it('returns null for anything it does not recognise, rather than guessing', () => {
        expect(outcomeFromDispatchCode('SOMETHING_NEW')).toBeNull();
        expect(outcomeFromDispatchCode(null)).toBeNull();
        expect(outcomeFromDispatchCode(undefined)).toBeNull();
    });
});

describe('cancellation attribution names the actual actor', () => {
    it('attributes a passenger cancellation to the passenger', () => {
        expect(outcomeFromCancellationReason('passenger_cancelled')).toEqual({
            code: RideOutcomeCode.PASSENGER_CANCELLED,
            actor: CancelActorRole.PASSENGER,
        });
    });

    it('attributes a driver-initiated mutual cancellation to the DRIVER', () => {
        // This flow exists in the product (the driver asks, the passenger
        // agrees) and used to be indistinguishable from a system cancellation.
        // Getting it wrong blames the platform for a driver's decision.
        expect(outcomeFromCancellationReason('CANCELLED_MUTUAL_DRIVER_INITIATED')).toEqual({
            code: RideOutcomeCode.DRIVER_CANCELLED,
            actor: CancelActorRole.DRIVER,
        });
    });

    it('attributes a passenger-initiated mutual cancellation to the passenger', () => {
        expect(outcomeFromCancellationReason('CANCELLED_MUTUAL_PASSENGER_INITIATED')).toEqual({
            code: RideOutcomeCode.PASSENGER_CANCELLED,
            actor: CancelActorRole.PASSENGER,
        });
    });

    it('attributes a support resolution to an admin', () => {
        expect(outcomeFromCancellationReason('SUPPORT_RESOLVED')).toEqual({
            code: RideOutcomeCode.ADMIN_CANCELLED,
            actor: CancelActorRole.ADMIN,
        });
    });

    it('credits an unanswered request to whoever actually asked', () => {
        // One party asks to cancel, the other never answers, the request
        // stands. The ride ended because of the asker — not because of "the
        // system", which is what the reason string alone would suggest.
        expect(outcomeFromCancellationReason('CANCELLED_REQUEST_UNANSWERED', 'driver')).toEqual({
            code: RideOutcomeCode.DRIVER_CANCELLED,
            actor: CancelActorRole.DRIVER,
        });
        expect(outcomeFromCancellationReason('CANCELLED_REQUEST_UNANSWERED', 'passenger')).toEqual({
            code: RideOutcomeCode.PASSENGER_CANCELLED,
            actor: CancelActorRole.PASSENGER,
        });
    });

    it('falls back to system when nobody recorded who asked', () => {
        expect(outcomeFromCancellationReason('CANCELLED_REQUEST_UNANSWERED')).toEqual({
            code: RideOutcomeCode.SYSTEM_CANCELLED,
            actor: CancelActorRole.SYSTEM,
        });
    });

    it('treats any SYSTEM_ prefixed resolution as a system cancellation', () => {
        expect(outcomeFromCancellationReason('SYSTEM_ABANDONED_BY_BOTH')?.actor)
            .toBe(CancelActorRole.SYSTEM);
        // The prefix is an invariant of StaleResolution, so a future member is
        // classified correctly without this file changing.
        expect(outcomeFromCancellationReason('SYSTEM_SOMETHING_NEW')?.code)
            .toBe(RideOutcomeCode.SYSTEM_CANCELLED);
    });

    it('returns null for an unrecognised reason instead of bucketing it', () => {
        expect(outcomeFromCancellationReason('who_knows')).toBeNull();
        expect(outcomeFromCancellationReason(null)).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Legacy rides stay honest
// ══════════════════════════════════════════════════════════════════════

describe('rides whose reason was never recorded say so', () => {
    it('labels a null outcome as an unavailable legacy reason', () => {
        expect(outcomeLabel(null)).toBe('Reason unavailable — legacy ride');
        expect(outcomeLabel(undefined)).toBe(LEGACY_UNAVAILABLE.label);
    });

    it('never classifies an unrecorded outcome as a supply failure', () => {
        // The whole point. ~256 production rides failed before the trail
        // existed; counting them as "no drivers available" would invent demand
        // evidence we never had and skew where drivers get recruited.
        expect(classifyOutcome(null)).toBe<OutcomeClass>('unknown');
        expect(classifyOutcome(RideOutcomeCode.LEGACY_UNAVAILABLE)).toBe<OutcomeClass>('unknown');
    });

    it('passes an unknown code through rather than blanking it', () => {
        expect(outcomeLabel('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
    });
});

describe('outcome classification separates the three business problems', () => {
    it('calls "nobody was there" a supply problem', () => {
        expect(classifyOutcome(RideOutcomeCode.NO_ELIGIBLE_DRIVER)).toBe<OutcomeClass>('supply');
    });

    it('calls "they were there and did not answer" a behaviour problem', () => {
        expect(classifyOutcome(RideOutcomeCode.NO_DRIVER_ACCEPTED)).toBe<OutcomeClass>('behaviour');
    });

    it('keeps our own faults out of the supply statistics', () => {
        // A restart that killed 40 searching rides is not evidence that Onitsha
        // needs 40 more Kekes.
        expect(classifyOutcome(RideOutcomeCode.TECHNICAL_FAILURE)).toBe<OutcomeClass>('technical');
    });

    it('does not treat a deliberate cancellation as a failure at all', () => {
        for (const c of [
            RideOutcomeCode.PASSENGER_CANCELLED,
            RideOutcomeCode.DRIVER_CANCELLED,
            RideOutcomeCode.ADMIN_CANCELLED,
            RideOutcomeCode.SYSTEM_CANCELLED,
        ]) {
            expect(classifyOutcome(c)).toBe<OutcomeClass>('intentional');
        }
    });

    it('has a human label for every code', () => {
        for (const code of Object.values(RideOutcomeCode)) {
            expect(OUTCOME_LABELS[code]).toBeTruthy();
        }
    });
});

// ══════════════════════════════════════════════════════════════════════
//  The kill switch
// ══════════════════════════════════════════════════════════════════════

describe('the telemetry kill switch', () => {
    const original = process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED;

    afterEach(() => {
        process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED = original;
        RideOperationsSwitch.resetCache();
    });

    it('is on by default, so a fresh deployment records', () => {
        delete process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED;
        RideOperationsSwitch.resetCache();
        expect(RideOperationsSwitch.isEnabled()).toBe(true);
    });

    it('is off when the environment says false', () => {
        process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED = 'false';
        RideOperationsSwitch.resetCache();
        expect(RideOperationsSwitch.isEnabled()).toBe(false);
    });

    it('treats any other value as on rather than failing closed', () => {
        // Observability is not safety-critical; a typo in an env var should not
        // silently blind operations.
        process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED = 'yes';
        RideOperationsSwitch.resetCache();
        expect(RideOperationsSwitch.isEnabled()).toBe(true);
    });

    it('is synchronous, so it can be called from the dispatch path', () => {
        // If this ever returns a promise, someone has put an awaited round-trip
        // between a passenger and a driver.
        RideOperationsSwitch.resetCache();
        const r = RideOperationsSwitch.isEnabled();
        expect(typeof r).toBe('boolean');
    });

    it('never lets a Redis override switch telemetry ON against the environment', async () => {
        process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED = 'false';
        RideOperationsSwitch.resetCache();
        await RideOperationsSwitch.enable();
        expect(RideOperationsSwitch.isEnabled()).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Failure injection — the guarantee that matters
// ══════════════════════════════════════════════════════════════════════

describe('telemetry failure never becomes ride failure', () => {
    afterEach(() => jest.restoreAllMocks());

    it('a throwing persistence layer does not propagate to the caller', async () => {
        // recordAsync is what the dispatch path ultimately reaches. If this
        // ever rejects, an unhandled rejection lands inside the offer loop.
        jest.spyOn(DispatchMonitorService as any, 'freshness').mockImplementation(() => {
            throw new Error('redis exploded');
        });

        await expect(
            DispatchMonitorService.recordAsync({
                rideId: 'RIDE-FAIL',
                eventType: DispatchEventType.CANDIDATE_DISCOVERED,
                driverId: 'd1',
                withFreshness: true,
            }),
        ).resolves.not.toThrow();
    });

    it('record() is fire-and-forget and returns nothing to await', () => {
        const r = DispatchMonitorService.record({
            rideId: 'RIDE-FF',
            eventType: DispatchEventType.ROUND_STARTED,
        });
        // A caller cannot accidentally await it and inherit its latency.
        expect(r).toBeUndefined();
    });

    it('a failing emitter cannot break the write path', async () => {
        DispatchMonitorService.setEmitter(() => {
            throw new Error('admin socket died');
        });
        await expect(
            DispatchMonitorService.recordAsync({
                rideId: 'RIDE-EMIT',
                eventType: DispatchEventType.ROUND_STARTED,
            }),
        ).resolves.not.toThrow();
        DispatchMonitorService.setEmitter(null);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Projection parity — telemetry must not change dispatch decisions
// ══════════════════════════════════════════════════════════════════════

describe('the projection is a pure read of what dispatch already decided', () => {
    it('produces rows without mutating the fields it is given', () => {
        // The projection runs inside the orchestrator's log port. If it mutated
        // the log fields, it would be editing dispatch's own state from inside
        // an observer — the classic way telemetry changes behaviour.
        const fields = {
            round: 1,
            radiusKm: 2,
            candidates: [{ driverId: 'd1', distanceKm: 0.4 }],
        };
        const snapshot = JSON.parse(JSON.stringify(fields));
        projectDispatchEvent('RIDE-1', 'candidates_discovered', fields);
        expect(fields).toEqual(snapshot);
    });

    it('drops events that carry no operator meaning instead of inventing rows', () => {
        expect(projectDispatchEvent('RIDE-1', 'release', {})).toEqual([]);
        expect(projectDispatchEvent('RIDE-1', 'no_target', {})).toEqual([]);
        expect(projectDispatchEvent('RIDE-1', 'something_unknown', {})).toEqual([]);
    });

    it('never records a delivery stronger than the transport fact', () => {
        // socket write and provider acceptance are separate facts, and neither
        // is "the driver saw it".
        const rows = projectDispatchEvent('RIDE-1', 'offer_sent', {
            driverId: 'd1',
            socketDelivered: true,
            pushSuccessCount: 2,
        });
        const types = rows.map((r) => r.eventType);
        expect(types).toContain(DispatchEventType.SOCKET_OFFER_EMITTED);
        expect(types).toContain(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER);
        expect(types).not.toContain(DispatchEventType.DEVICE_OFFER_ACK);
    });

    it('records nothing for an offer that reached neither transport', () => {
        const rows = projectDispatchEvent('RIDE-1', 'offer_sent', {
            driverId: 'd1',
            socketDelivered: false,
            pushSuccessCount: 0,
        });
        expect(rows).toEqual([]);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  The thirteen lifecycle scenarios
// ══════════════════════════════════════════════════════════════════════

describe('every dispatch scenario yields a distinguishable outcome', () => {
    /** The projection row a scenario produces for its terminal event. */
    const finish = (over: Record<string, unknown>) =>
        projectDispatchEvent('RIDE-1', 'dispatch_finished', {
            finalOutcomeCode: 'NO_ELIGIBLE_DRIVER',
            ...over,
        })[0];

    it('1. zero candidates — a supply problem', () => {
        const row = finish({ dispatchResult: 'no_eligible_drivers' });
        expect(row.eventType).toBe(DispatchEventType.DISPATCH_FAILED);
        expect(outcomeFromDispatchCode(row.detail!.outcomeCode as string))
            .toBe(RideOutcomeCode.NO_ELIGIBLE_DRIVER);
        expect(classifyOutcome(RideOutcomeCode.NO_ELIGIBLE_DRIVER)).toBe<OutcomeClass>('supply');
    });

    it('2. candidates but none eligible — still supply, with the detail kept', () => {
        const row = finish({ dispatchResult: 'eligible_but_none_reservable' });
        expect(row.detail!.dispatchResult).toBe('eligible_but_none_reservable');
    });

    it('3. eligible drivers but nobody accepted — a BEHAVIOUR problem', () => {
        const row = finish({
            finalOutcomeCode: 'NO_DRIVER_ACCEPTED',
            dispatchResult: 'offers_delivered_none_accepted',
        });
        expect(classifyOutcome(outcomeFromDispatchCode(row.detail!.outcomeCode as string)))
            .toBe<OutcomeClass>('behaviour');
    });

    it('4. every offer failed delivery — recorded as its own detail', () => {
        const row = finish({ dispatchResult: 'offers_all_failed_delivery' });
        expect(row.detail!.dispatchResult).toBe('offers_all_failed_delivery');
    });

    it('5. a driver rejection is projected from the reject handler, not inferred', () => {
        // Explicit rejection is authoritative and is written by the handler that
        // received it; the projection deliberately ignores the log echo so the
        // event is not double-counted.
        expect(projectDispatchEvent('RIDE-1', 'driver_rejected', { driverId: 'd1' })).toEqual([]);
    });

    it('6. an offer expiry is recorded as expiry, never as rejection', () => {
        const rows = projectDispatchEvent('RIDE-1', 'offer_expiry', { driverId: 'd1', round: 1 });
        expect(rows[0].eventType).toBe(DispatchEventType.OFFER_EXPIRED);
        expect(rows[0].eventType).not.toBe(DispatchEventType.DRIVER_REJECTED);
    });

    it('7. a reservation conflict names the ride that won', () => {
        const rows = projectDispatchEvent('RIDE-1', 'reserve', {
            driverId: 'd1',
            result: 'skipped_reserved',
            reservedBy: 'RIDE-2',
        });
        expect(rows[0].eventType).toBe(DispatchEventType.RESERVATION_CONFLICT);
        expect(rows[0].detail!.reservedBy).toBe('RIDE-2');
    });

    it('8. a successful reservation is distinct from a conflict', () => {
        const rows = projectDispatchEvent('RIDE-1', 'reserve', {
            driverId: 'd1',
            result: 'acquired',
            ttlSec: 20,
        });
        expect(rows[0].eventType).toBe(DispatchEventType.RESERVATION_ACQUIRED);
    });

    it('9. a cancelled ride is NOT recorded as a dispatch failure', () => {
        // Otherwise every passenger who changed their mind appears in the
        // "we had no Kekes" report, and the supply numbers become fiction.
        expect(finish({ stopReason: 'cancelled' })).toBeUndefined();
        expect(finish({ stopReason: 'ride_gone' })).toBeUndefined();
    });

    it('10. an eligibility rejection keeps the reason it was rejected for', () => {
        const rows = projectDispatchEvent('RIDE-1', 'eligibility_reject', {
            driverId: 'd1',
            reason: 'commission_debt',
            round: 1,
        });
        expect(rows[0].eventType).toBe(DispatchEventType.ELIGIBILITY_REJECTED);
        expect(rows[0].detail!.reason).toBe('commission_debt');
    });

    it('11. candidate discovery fans out one row per driver, with distance', () => {
        const rows = projectDispatchEvent('RIDE-1', 'candidates_discovered', {
            round: 1,
            radiusKm: 3.5,
            candidates: [
                { driverId: 'd1', distanceKm: 0.4 },
                { driverId: 'd2', distanceKm: 1.2 },
            ],
        });
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.driverId)).toEqual(['d1', 'd2']);
        expect(rows[1].distanceKm).toBe(1.2);
    });

    it('12. a round start records the radius tiers it will try', () => {
        const rows = projectDispatchEvent('RIDE-1', 'round_start', {
            round: 1,
            radiusTiersKm: [2, 3.5, 5],
        });
        expect(rows[0].eventType).toBe(DispatchEventType.ROUND_STARTED);
        expect(rows[0].detail!.radiusTiersKm).toEqual([2, 3.5, 5]);
    });

    it('13. telemetry disabled changes the trail and nothing else', () => {
        // The projection is a pure function of the log event, so the SAME
        // dispatch produces the same decisions either way — the only difference
        // is whether the rows are written. The switch is checked by the caller;
        // proving purity here is what makes that safe.
        const a = projectDispatchEvent('RIDE-1', 'round_start', { round: 1, radiusTiersKm: [2] });
        const b = projectDispatchEvent('RIDE-1', 'round_start', { round: 1, radiusTiersKm: [2] });
        expect(a).toEqual(b);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Area extraction against REAL captured addresses
// ══════════════════════════════════════════════════════════════════════

describe('area extraction survives what the passenger app actually stores', () => {
    // Every string below is a real production pickupAddress, or the shape of
    // one. 211 of 824 production pickups begin with a plus code and some are
    // nothing but a placeholder — an area column built for tidy addresses
    // renders those as if they were places.
    const { areaOf } = require('../../src/services/dispatch_monitor_query_service');

    it('keeps the locality from a well-formed address', () => {
        expect(areaOf('12 Zik Avenue, Aroma Junction, Awka')).toBe('Aroma Junction, Awka');
        expect(areaOf('Awka')).toBe('Awka');
        expect(areaOf(null)).toBeNull();
    });

    it('drops the country, which never distinguishes two Onitsha rides', () => {
        expect(areaOf('Okpoko Police Station, Onitsha, Nigeria'))
            .toBe('Okpoko Police Station, Onitsha');
    });

    it('strips a leading plus code but keeps the street behind it', () => {
        expect(areaOf('4QGP+JPF, Nweweka Street')).toBe('Nweweka Street');
    });

    it('reports a bare plus code as no area at all', () => {
        // "4QHQ+3WF" is a precise square on the earth and tells an operator
        // nothing. Rendering it in the AREA column is worse than blank,
        // because it looks like data.
        expect(areaOf('4QHQ+3WF')).toBeNull();
    });

    it('treats the app\'s placeholder text as missing, not as a place', () => {
        expect(areaOf('Location selected')).toBeNull();
        expect(areaOf('Current Location')).toBeNull();
        expect(areaOf('Unnamed Road')).toBeNull();
    });

    it('drops bare house numbers, which locate a doorstep not an area', () => {
        expect(areaOf('109, Upper New Market Road')).toBe('Upper New Market Road');
        expect(areaOf('SOPROM HOTEL & SUITES LTD, Ogbatuluenyi Drive, 3 1, Onitsha, Nigeria'))
            .toBe('Ogbatuluenyi Drive, Onitsha');
    });

    it('never invents a locality when nothing meaningful survives', () => {
        expect(areaOf('Nigeria')).toBeNull();
        expect(areaOf('4QHQ+3WF, Nigeria')).toBeNull();
        expect(areaOf('   ')).toBeNull();
    });
});

describe('repeated address segments are collapsed', () => {
    const { areaOf } = require('../../src/services/dispatch_monitor_query_service');

    it('collapses a segment Google repeated', () => {
        // All real production pickups. Google duplicates segments freely.
        expect(areaOf('Onitsha North, Onitsha North')).toBe('Onitsha North');
        expect(areaOf('Oguta Road, Oguta Road, Onitsha North')).toBe('Oguta Road, Onitsha North');
        expect(areaOf('A232, A232, Onitsha North')).toBe('A232, Onitsha North');
    });

    it('keeps genuinely different adjacent segments', () => {
        expect(areaOf('Venn Road South, Onitsha North')).toBe('Venn Road South, Onitsha North');
    });
});

describe('a search records how far it reached', () => {
    it('records the widest tier of a round in the scalar radius column', () => {
        // Without this, a round that discovered nobody carries no radius at
        // all — and "how far did we look?" is the first question asked about
        // exactly that ride.
        const rows = projectDispatchEvent('RIDE-1', 'round_start', {
            round: 1,
            radiusTiersKm: [2, 3.5, 5],
        });
        expect(rows[0].radiusKm).toBe(5);
        expect(rows[0].detail!.radiusTiersKm).toEqual([2, 3.5, 5]);
    });

    it('leaves the radius null when no tiers were logged', () => {
        const rows = projectDispatchEvent('RIDE-1', 'round_start', { round: 1 });
        expect(rows[0].radiusKm).toBeNull();
    });
});
