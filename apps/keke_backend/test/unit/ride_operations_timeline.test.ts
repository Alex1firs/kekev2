/**
 * The investigation timeline: two authoritative sources, merged, never padded.
 *
 * The dispatch trail knows request → assignment. The ride row knows arrival,
 * trip start and completion. A timeline built from either alone tells half the
 * story, and the half it omits is exactly the half a support agent is being
 * asked about.
 *
 * What is being defended: the merge must not invent entries, must not reorder
 * real ones, and must not present a cancelled ride's `completedAt` as a
 * completion.
 */
import { DispatchMonitorQueryService } from '../../src/services/dispatch_monitor_query_service';
import { DispatchEvent, DispatchEventType } from '../../src/models/DispatchEvent';
import { Ride, RideStatus } from '../../src/models/Ride';
import { DriverProfile } from '../../src/models/DriverProfile';

/** The private merge, reached directly — it is the unit under test. */
const build = (
    ride: Partial<Ride>,
    events: Partial<DispatchEvent>[],
    profiles = new Map<string, DriverProfile>(),
) =>
    (DispatchMonitorQueryService as any).buildTimeline(
        ride as Ride,
        events as DispatchEvent[],
        profiles,
    ) as Array<{ eventType: string; source: string; occurredAt: string; detail: any }>;

const at = (iso: string) => new Date(iso);

const ev = (
    eventType: DispatchEventType,
    occurredAt: string,
    sequence: number,
): Partial<DispatchEvent> => ({
    sequence,
    eventType,
    occurredAt: at(occurredAt),
    driverId: null,
    dispatchRound: 1,
    radiusKm: null,
    distanceKm: null,
    heartbeatAgeMs: null,
    locationAgeMs: null,
    detail: null,
});

describe('the timeline merges dispatch events with ride lifecycle stamps', () => {
    it('tells the whole story of a completed ride in order', () => {
        const timeline = build(
            {
                rideId: 'RIDE-1',
                status: RideStatus.COMPLETED,
                driverId: 'd1',
                acceptedAt: at('2026-08-18T10:42:18Z'),
                arrivedAt: at('2026-08-18T10:49:03Z'),
                startedAt: at('2026-08-18T10:51:10Z'),
                completedAt: at('2026-08-18T11:06:42Z'),
                tripDurationSec: 932,
            },
            [
                ev(DispatchEventType.RIDE_CREATED, '2026-08-18T10:41:52Z', 1),
                ev(DispatchEventType.ROUND_STARTED, '2026-08-18T10:41:54Z', 2),
                ev(DispatchEventType.DRIVER_ACCEPTED, '2026-08-18T10:42:18Z', 3),
            ],
        );

        expect(timeline.map((e) => e.eventType)).toEqual([
            'ride_created',
            'round_started',
            'driver_accepted',
            'driver_arrived',
            'trip_started',
            'trip_completed',
        ]);
    });

    it('marks which source each entry came from', () => {
        // An operator questioning an entry needs to know whether it came from
        // the dispatch trail or the ride record — they have different
        // reliability characteristics and different gaps.
        const timeline = build(
            { status: RideStatus.COMPLETED, startedAt: at('2026-08-18T10:51:10Z') },
            [ev(DispatchEventType.RIDE_CREATED, '2026-08-18T10:41:52Z', 1)],
        );
        expect(timeline[0].source).toBe('dispatch_event');
        expect(timeline[1].source).toBe('ride_record');
    });

    it('omits lifecycle steps that never happened rather than padding them', () => {
        // A ride that failed during dispatch has no arrival and no trip. The
        // timeline must be SHORT, not filled with plausible-looking steps.
        const timeline = build(
            { status: RideStatus.FAILED },
            [
                ev(DispatchEventType.RIDE_CREATED, '2026-08-18T10:41:52Z', 1),
                ev(DispatchEventType.DISPATCH_FAILED, '2026-08-18T10:43:44Z', 2),
            ],
        );
        expect(timeline.map((e) => e.eventType)).toEqual(['ride_created', 'dispatch_failed']);
    });

    it('does not read a cancelled ride\'s completedAt as a completion', () => {
        // `completedAt` is stamped on cancellations too — it means "terminal
        // at", not "finished successfully". Rendering it as "Trip completed"
        // would tell a support agent the passenger got their ride when they
        // did not.
        const timeline = build(
            {
                status: RideStatus.CANCELED,
                completedAt: at('2026-08-18T10:45:00Z'),
                acceptedAt: at('2026-08-18T10:42:18Z'),
            },
            [ev(DispatchEventType.RIDE_CANCELLED, '2026-08-18T10:45:00Z', 1)],
        );
        expect(timeline.map((e) => e.eventType)).not.toContain('trip_completed');
        expect(timeline.map((e) => e.eventType)).toContain('ride_cancelled');
    });

    it('orders strictly by time, not by which source produced the entry', () => {
        const timeline = build(
            {
                status: RideStatus.COMPLETED,
                arrivedAt: at('2026-08-18T10:49:03Z'),
                completedAt: at('2026-08-18T11:06:42Z'),
            },
            [
                // A late dispatch row (a park event, say) landing after arrival.
                ev(DispatchEventType.PARK_CLAIMED, '2026-08-18T10:50:00Z', 9),
                ev(DispatchEventType.RIDE_CREATED, '2026-08-18T10:41:52Z', 1),
            ],
        );
        const times = timeline.map((e) => Date.parse(e.occurredAt));
        expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('keeps same-millisecond dispatch rows in their recorded sequence', () => {
        // Several offers can go out in one tick; wall-clock alone would make
        // the order non-deterministic between page loads.
        const timeline = build({ status: RideStatus.SEARCHING }, [
            ev(DispatchEventType.NOTIFICATION_QUEUED, '2026-08-18T10:41:56Z', 5),
            ev(DispatchEventType.SOCKET_OFFER_EMITTED, '2026-08-18T10:41:56Z', 6),
            ev(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER, '2026-08-18T10:41:56Z', 7),
        ]);
        expect(timeline.map((e) => e.eventType)).toEqual([
            'notification_queued',
            'socket_offer_emitted',
            'fcm_accepted_by_provider',
        ]);
    });

    it('carries the arrival distance so a disputed pickup can be checked', () => {
        const timeline = build(
            {
                status: RideStatus.COMPLETED,
                arrivedAt: at('2026-08-18T10:49:03Z'),
                arrivedPickupDistanceM: 42.7,
            },
            [],
        );
        expect(timeline[0].detail).toEqual({ distanceFromPickupM: 43 });
    });

    it('handles a ride with no events and no lifecycle at all', () => {
        // A legacy ride from before the trail existed. Empty is the honest
        // answer; the console says so rather than erroring.
        expect(build({ status: RideStatus.FAILED }, [])).toEqual([]);
    });
});
