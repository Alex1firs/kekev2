/**
 * Park Dispatch fallback: configuration, park ranking, priority and the
 * guarantees that keep direct dispatch untouched.
 *
 * The most important test in this file is the first one. Park Dispatch is
 * DEFAULT OFF, and a deploy that silently turned it on would change how every
 * unfilled ride behaves. Everything else here protects the ranking and the
 * boundary between the two channels.
 */
import { loadParkDispatchConfig, computeJobPriority, PRIORITY_LABEL } from '../../src/config/park_dispatch_config';
import { ASSIGNABLE_PRESENCE_STATES } from '../../src/services/park_selection_service';
import { DriverPresenceState } from '../../src/models/DriverPresence';
import { ParkJobStatus, ParkAssignmentMode } from '../../src/models/ParkDispatchJob';
import { LIVE_JOB_STATUSES } from '../../src/repositories/park_dispatch_job_repository';
import { DispatchEventType } from '../../src/models/DispatchEvent';
import { loadDispatchConfig, MAX_SUPPORTED_ROUNDS } from '../../src/config/dispatch_config';

describe('the fallback is off by default', () => {
    const original = process.env.PARK_DISPATCH_ENABLED;
    afterEach(() => {
        if (original == null) delete process.env.PARK_DISPATCH_ENABLED;
        else process.env.PARK_DISPATCH_ENABLED = original;
    });

    it('is disabled unless explicitly enabled', () => {
        delete process.env.PARK_DISPATCH_ENABLED;
        expect(loadParkDispatchConfig().enabled).toBe(false);
    });

    it('is not enabled by a truthy-looking value that is not "true"', () => {
        for (const value of ['1', 'yes', 'on', 'TRUE ', '']) {
            process.env.PARK_DISPATCH_ENABLED = value;
            const enabled = loadParkDispatchConfig().enabled;
            // Only an exact case-insensitive "true" counts.
            expect(enabled).toBe(value.trim().toLowerCase() === 'true');
        }
    });

    it('turns on with exactly "true"', () => {
        process.env.PARK_DISPATCH_ENABLED = 'true';
        expect(loadParkDispatchConfig().enabled).toBe(true);
    });
});

describe('direct dispatch is untouched', () => {
    it('still runs at most two rounds with the same tiers and lifetime', () => {
        // Park Dispatch is downstream. If any of this changed, the fallback
        // would have leaked into the dispatch engine.
        const config = loadDispatchConfig();
        expect(MAX_SUPPORTED_ROUNDS).toBe(2);
        expect(config.maxRounds).toBeLessThanOrEqual(2);
        expect(config.radiusTiersKm).toEqual([2, 3.5, 5]);
        expect(config.offerDurationMs).toBe(15_000);
        expect(config.maxSearchLifetimeMs).toBe(110_000);
    });

    it('park config cannot influence a dispatch round', () => {
        // No key in the park config shares a name with a dispatch knob, so no
        // environment variable can change both.
        const parkKeys = Object.keys(loadParkDispatchConfig());
        const dispatchKeys = Object.keys(loadDispatchConfig());
        expect(parkKeys.filter((k) => dispatchKeys.includes(k))).toEqual([]);
    });
});

describe('job priority', () => {
    it('rises with how long the PASSENGER has waited', () => {
        expect(computeJobPriority(0)).toBe(1);
        expect(computeJobPriority(60_000)).toBe(1);
        expect(computeJobPriority(3 * 60_000)).toBe(2);
        expect(computeJobPriority(5 * 60_000)).toBe(3);
        expect(computeJobPriority(20 * 60_000)).toBe(3);
    });

    it('is monotonic — waiting longer never lowers priority', () => {
        let previous = 0;
        for (let minutes = 0; minutes <= 15; minutes += 1) {
            const p = computeJobPriority(minutes * 60_000);
            expect(p).toBeGreaterThanOrEqual(previous);
            previous = p;
        }
    });

    it('has a label for every level it can produce', () => {
        for (const ms of [0, 3 * 60_000, 10 * 60_000]) {
            expect(PRIORITY_LABEL[computeJobPriority(ms)]).toBeTruthy();
        }
    });
});

describe('assignable presence', () => {
    it('is exactly AT_PARK and WAITING', () => {
        expect(ASSIGNABLE_PRESENCE_STATES).toEqual([
            DriverPresenceState.AT_PARK,
            DriverPresenceState.WAITING,
        ]);
    });

    it('excludes ONLINE — direct dispatch already tried those drivers', () => {
        // A driver working but not at the park is exactly who the rounds just
        // failed to reach, and a dispatcher cannot hand them a trip slip.
        expect(ASSIGNABLE_PRESENCE_STATES).not.toContain(DriverPresenceState.ONLINE);
    });

    it('excludes every busy and unavailable state', () => {
        for (const state of [
            DriverPresenceState.OFFLINE,
            DriverPresenceState.UNAVAILABLE,
            DriverPresenceState.ASSIGNED,
            DriverPresenceState.EN_ROUTE,
            DriverPresenceState.PASSENGER_BOARDING,
            DriverPresenceState.TRIP_STARTED,
        ]) {
            expect(ASSIGNABLE_PRESENCE_STATES).not.toContain(state);
        }
    });
});

describe('job status model', () => {
    it('treats offered, claimed and pending-acceptance as live', () => {
        // PENDING_ACCEPTANCE joined the live set when assignment timeouts
        // landed: a driver holding an unanswered offer means the ride is still
        // in this park's hands and must not be offered elsewhere.
        expect(LIVE_JOB_STATUSES).toEqual([
            ParkJobStatus.OFFERED,
            ParkJobStatus.CLAIMED,
            ParkJobStatus.PENDING_ACCEPTANCE,
        ]);
    });

    it('a pending offer still blocks a second job for the same ride', () => {
        // The partial unique index is scoped to LIVE_JOB_STATUSES, so this list
        // growing is what keeps the one-live-job guarantee true.
        expect(LIVE_JOB_STATUSES).toContain(ParkJobStatus.PENDING_ACCEPTANCE);
    });

    it('every terminal status is outside the live set', () => {
        const terminal = [
            ParkJobStatus.ASSIGNED, ParkJobStatus.SKIPPED, ParkJobStatus.ESCALATED,
            ParkJobStatus.REJECTED, ParkJobStatus.EXPIRED, ParkJobStatus.CANCELLED,
        ];
        // PENDING_ACCEPTANCE is deliberately NOT terminal — it returns to
        // CLAIMED on a decline or a timeout.
        for (const status of terminal) expect(LIVE_JOB_STATUSES).not.toContain(status);
    });

    it('supports the two assignment modes the brief requires', () => {
        expect(Object.values(ParkAssignmentMode)).toEqual(['electronic', 'verbal']);
    });
});

describe('dispatch event vocabulary', () => {
    it('has a park event for every stage worth reconstructing', () => {
        for (const type of [
            DispatchEventType.PARK_OFFERED,
            DispatchEventType.PARK_CLAIMED,
            DispatchEventType.PARK_DRIVER_ASSIGNED,
            DispatchEventType.PARK_SKIPPED,
            DispatchEventType.PARK_REJECTED,
            DispatchEventType.PARK_ESCALATED,
            DispatchEventType.PARK_JOB_EXPIRED,
            DispatchEventType.PARK_DISPATCH_EXHAUSTED,
        ]) {
            expect(typeof type).toBe('string');
        }
    });

    it('keeps every pre-existing direct-dispatch event value unchanged', () => {
        // These are persisted in `dispatch_event.eventType` on production rows.
        // Renaming one would orphan history.
        expect(DispatchEventType.DRIVER_ACCEPTED).toBe('driver_accepted');
        expect(DispatchEventType.RIDE_CREATED).toBe('ride_created');
        expect(DispatchEventType.ROUND_STARTED).toBe('round_started');
        expect(DispatchEventType.OFFER_EXPIRED).toBe('offer_expired');
        expect(DispatchEventType.DISPATCH_FAILED).toBe('dispatch_failed');
    });
});

describe('timing budget', () => {
    const original = { ...process.env };
    afterEach(() => { process.env = { ...original }; });

    it('keeps the total within the passenger app watchdog once a round event is emitted', () => {
        // Direct 110s + claim 25s + assign 45s = 180s. The passenger app's
        // client-side watchdog is 150s but RE-ARMS on a round transition, which
        // is why the fallback emits one. See docs §5.4.
        const dispatch = loadDispatchConfig();
        const park = loadParkDispatchConfig();
        const total = dispatch.maxSearchLifetimeMs + park.claimWindowMs + park.assignWindowMs;
        expect(total).toBe(180_000);
        expect(park.emitRoundEvent).toBe(true);
    });

    it('offers one park by default — a second would push the wait too far', () => {
        expect(loadParkDispatchConfig().maxParksPerRide).toBe(1);
    });

    it('refuses absurdly distant parks', () => {
        expect(loadParkDispatchConfig().maxTravelMinutes).toBeLessThanOrEqual(15);
    });
});
