/**
 * Live Ride Requests monitor: honest event labelling, privacy masking,
 * role-based access and the derived operational classifications.
 *
 * These are the pure/derivation layers, which is where a monitoring system
 * actually goes wrong — by quietly upgrading a weak signal into a confident
 * claim. Database-backed queries are covered by the integration suite.
 */
import {
    maskPhone,
    maskName,
    maskEmail,
    areaOf,
    resolveDeliveryState,
    resolveCandidateOutcome,
} from '../../src/services/dispatch_monitor_query_service';
import { DispatchEvent, DispatchEventType, OfferDeliveryState } from '../../src/models/DispatchEvent';
import { DispatchMonitorService } from '../../src/services/dispatch_monitor_service';
import { identifyAdmin, hasPermission } from '../../src/middleware/admin_permissions';
import { newDriver, newRide, setHeartbeatFresh, setHeartbeatExpired, redis } from '../helpers/dispatch';

const ev = (eventType: DispatchEventType, over: Partial<DispatchEvent> = {}): DispatchEvent =>
    ({
        id: 'x',
        rideId: 'RIDE-1',
        sequence: 1,
        eventType,
        dispatchRound: 1,
        driverId: 'd1',
        radiusKm: 2,
        distanceKm: 1,
        heartbeatAgeMs: 1000,
        locationAgeMs: 1000,
        detail: null,
        occurredAt: new Date('2026-07-25T06:43:00Z'),
        createdAt: new Date('2026-07-25T06:43:00Z'),
        ...over,
    }) as DispatchEvent;

describe('delivery state is never stronger than the recorded signal', () => {
    it('reports UNKNOWN when only the offer was queued', () => {
        // The most important case: queued and then silence is not "delivered".
        expect(resolveDeliveryState([ev(DispatchEventType.NOTIFICATION_QUEUED)]))
            .toBe(OfferDeliveryState.UNKNOWN);
    });

    it('reports SOCKET_EMITTED for a socket write alone', () => {
        expect(resolveDeliveryState([
            ev(DispatchEventType.NOTIFICATION_QUEUED),
            ev(DispatchEventType.SOCKET_OFFER_EMITTED),
        ])).toBe(OfferDeliveryState.SOCKET_EMITTED);
    });

    it('reports PROVIDER_ACCEPTED for an FCM accept — not device delivery', () => {
        expect(resolveDeliveryState([
            ev(DispatchEventType.NOTIFICATION_QUEUED),
            ev(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER),
        ])).toBe(OfferDeliveryState.PROVIDER_ACCEPTED);
    });

    it('only a device acknowledgement yields ACKNOWLEDGED', () => {
        expect(resolveDeliveryState([
            ev(DispatchEventType.SOCKET_OFFER_EMITTED),
            ev(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER),
            ev(DispatchEventType.DEVICE_OFFER_ACK),
        ])).toBe(OfferDeliveryState.ACKNOWLEDGED);
    });

    it('an ack outranks every weaker signal regardless of order', () => {
        expect(resolveDeliveryState([
            ev(DispatchEventType.DEVICE_OFFER_ACK),
            ev(DispatchEventType.SOCKET_OFFER_EMITTED),
        ])).toBe(OfferDeliveryState.ACKNOWLEDGED);
    });

    it('reports FAILED when nothing could carry the offer', () => {
        expect(resolveDeliveryState([
            ev(DispatchEventType.NOTIFICATION_QUEUED),
            ev(DispatchEventType.OFFER_DELIVERY_FAILED),
        ])).toBe(OfferDeliveryState.FAILED);
    });

    it('has no state that claims the driver saw the request', () => {
        const states = Object.values(OfferDeliveryState).join(' ');
        expect(states).not.toMatch(/seen|viewed|read|delivered_to_driver/i);
    });

    it('the event vocabulary contains no inferred-delivery member', () => {
        const types = Object.values(DispatchEventType).join(' ');
        expect(types).not.toMatch(/notification_delivered|driver_saw|seen|opened_by_driver/i);
    });
});

describe('candidate outcome separates the operationally different causes', () => {
    const cases: Array<[string, DispatchEventType[], string]> = [
        ['accepted', [DispatchEventType.DRIVER_ACCEPTED], 'accepted'],
        ['explicit rejection', [DispatchEventType.DRIVER_REJECTED], 'rejected'],
        ['ignored until expiry', [DispatchEventType.OFFER_EXPIRED], 'expired'],
        ['device never received', [DispatchEventType.OFFER_DELIVERY_FAILED], 'delivery_failed'],
        ['went stale first', [DispatchEventType.CANDIDATE_STALE], 'stale_before_offer'],
        ['held by another ride', [DispatchEventType.RESERVATION_CONFLICT], 'reservation_conflict'],
        ['failed eligibility', [DispatchEventType.ELIGIBILITY_REJECTED], 'ineligible'],
    ];

    for (const [name, types, expected] of cases) {
        it(`classifies "${name}" as ${expected}`, () => {
            expect(resolveCandidateOutcome(types.map((t) => ev(t)), false)).toBe(expected);
        });
    }

    it('distinguishes a cancellation from a driver ignoring the offer', () => {
        const queued = [ev(DispatchEventType.NOTIFICATION_QUEUED)];
        expect(resolveCandidateOutcome(queued, false)).toBe('awaiting_response');
        expect(resolveCandidateOutcome(queued, true)).toBe('cancelled_before_response');
    });

    it('prefers the definitive answer when several signals exist', () => {
        // A driver who was reserved, offered, and then accepted is "accepted",
        // not "awaiting_response".
        expect(resolveCandidateOutcome([
            ev(DispatchEventType.NOTIFICATION_QUEUED),
            ev(DispatchEventType.SOCKET_OFFER_EMITTED),
            ev(DispatchEventType.DRIVER_ACCEPTED),
        ], false)).toBe('accepted');
    });

    it('never merges rejection and expiry into one bucket', () => {
        const rejected = resolveCandidateOutcome([ev(DispatchEventType.DRIVER_REJECTED)], false);
        const expired = resolveCandidateOutcome([ev(DispatchEventType.OFFER_EXPIRED)], false);
        expect(rejected).not.toBe(expired);
    });
});

describe('privacy masking', () => {
    it('masks a phone to a support-usable shape without exposing it', () => {
        const masked = maskPhone('+2348031234567');
        expect(masked).not.toContain('8031234567');
        expect(masked).toMatch(/••••/);
        // Enough to confirm identity on a call.
        expect(masked).toContain('567');
    });

    it('handles missing and junk phone values', () => {
        expect(maskPhone(null)).toBeNull();
        expect(maskPhone('')).toBeNull();
        expect(maskPhone('12')).toBe('•••');
    });

    it('masks a surname to an initial', () => {
        expect(maskName('Adaeze', 'Okonkwo')).toBe('Adaeze O.');
        expect(maskName('Adaeze', null)).toBe('Adaeze');
        expect(maskName(null, null)).toBe('Unknown');
    });

    it('masks an email local part but keeps the domain for support triage', () => {
        const masked = maskEmail('adaeze.okonkwo@example.com');
        expect(masked).toContain('@example.com');
        expect(masked).not.toContain('okonkwo');
        expect(masked!.startsWith('ad')).toBe(true);
    });

    it('coarsens an address to an area rather than a street', () => {
        expect(areaOf('12 Zik Avenue, Aroma Junction, Awka')).toBe('Aroma Junction, Awka');
        expect(areaOf('Awka')).toBe('Awka');
        expect(areaOf(null)).toBeNull();
    });

    it('the persisted event model holds no personal fields', () => {
        const row = ev(DispatchEventType.CANDIDATE_DISCOVERED);
        const keys = Object.keys(row);
        for (const forbidden of ['phone', 'email', 'firstName', 'lastName', 'plate', 'name']) {
            expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
        }
    });
});

describe('role-based access', () => {
    const KEYS = {
        ADMIN_API_KEY: 'super-key',
        ADMIN_OPERATIONS_API_KEY: 'ops-key',
        ADMIN_SUPPORT_API_KEY: 'support-key',
        ADMIN_READONLY_API_KEY: 'ro-key',
    };
    let saved: NodeJS.ProcessEnv;

    beforeEach(() => {
        saved = { ...process.env };
        Object.assign(process.env, KEYS);
    });
    afterEach(() => {
        process.env = saved;
    });

    it('resolves each configured key to its role', () => {
        expect(identifyAdmin('super-key')?.role).toBe('superadmin');
        expect(identifyAdmin('ops-key')?.role).toBe('operations');
        expect(identifyAdmin('support-key')?.role).toBe('support');
        expect(identifyAdmin('ro-key')?.role).toBe('readonly');
    });

    it('rejects an unknown or missing key', () => {
        expect(identifyAdmin('nope')).toBeNull();
        expect(identifyAdmin(undefined)).toBeNull();
    });

    it('never matches an unset key, so an empty env cannot authenticate', () => {
        delete process.env.ADMIN_SUPPORT_API_KEY;
        expect(identifyAdmin('')).toBeNull();
        expect(identifyAdmin(undefined)).toBeNull();
    });

    it('only superadmin and support may reveal contact details', () => {
        expect(hasPermission('superadmin', 'monitor:reveal_contact')).toBe(true);
        expect(hasPermission('support', 'monitor:reveal_contact')).toBe(true);
        expect(hasPermission('operations', 'monitor:reveal_contact')).toBe(false);
        expect(hasPermission('readonly', 'monitor:reveal_contact')).toBe(false);
    });

    it('every role can read the monitor, but only superadmin can write', () => {
        for (const role of ['superadmin', 'operations', 'support', 'readonly'] as const) {
            expect(hasPermission(role, 'monitor:read')).toBe(true);
        }
        expect(hasPermission('superadmin', 'admin:write')).toBe(true);
        expect(hasPermission('operations', 'admin:write')).toBe(false);
        expect(hasPermission('readonly', 'admin:write')).toBe(false);
    });

    it('readonly cannot read driver metrics', () => {
        expect(hasPermission('readonly', 'metrics:read')).toBe(false);
        expect(hasPermission('operations', 'metrics:read')).toBe(true);
    });
});

describe('freshness derivation', () => {
    beforeEach(() => DispatchMonitorService.resetSequences());

    it('reports a heartbeat age for a fresh driver', async () => {
        const driverId = newDriver();
        await setHeartbeatFresh(driverId);
        const f = await DispatchMonitorService.freshness(driverId);
        expect(f.fresh).toBe(true);
        expect(f.heartbeatAgeMs).not.toBeNull();
        expect(f.heartbeatAgeMs!).toBeGreaterThanOrEqual(0);
    });

    it('reports a stale driver as not fresh, with no invented age', async () => {
        const driverId = newDriver();
        await setHeartbeatExpired(driverId);
        const f = await DispatchMonitorService.freshness(driverId);
        expect(f.fresh).toBe(false);
        expect(f.heartbeatAgeMs).toBeNull();
    });

    it('derives location age from the persistent last-seen key', async () => {
        const driverId = newDriver();
        await setHeartbeatFresh(driverId);
        await redis.set(`driver:lastseen:${driverId}`, String(Date.now() - 30_000));
        const f = await DispatchMonitorService.freshness(driverId);
        expect(f.locationAgeMs).not.toBeNull();
        expect(f.locationAgeMs!).toBeGreaterThanOrEqual(29_000);
    });
});

describe('event sequencing keeps the timeline deterministic', () => {
    beforeEach(() => DispatchMonitorService.resetSequences());

    it('assigns increasing sequence numbers within a ride', async () => {
        const rideId = newRide();
        const seen: number[] = [];
        DispatchMonitorService.setEmitter((_e, payload) => seen.push(payload.sequence as number));
        try {
            // Same-millisecond events must still be orderable.
            await DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.RIDE_CREATED });
            await DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.ROUND_STARTED });
            await DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.CANDIDATE_DISCOVERED });
        } finally {
            DispatchMonitorService.setEmitter(null);
        }
        expect(seen).toEqual([1, 2, 3]);
    });

    it('sequences are per-ride, so concurrent requests do not interleave', async () => {
        const rideA = newRide();
        const rideB = newRide();
        const byRide: Record<string, number[]> = {};
        DispatchMonitorService.setEmitter((_e, p) => {
            const id = p.rideId as string;
            (byRide[id] = byRide[id] || []).push(p.sequence as number);
        });
        try {
            await DispatchMonitorService.recordAsync({ rideId: rideA, eventType: DispatchEventType.RIDE_CREATED });
            await DispatchMonitorService.recordAsync({ rideId: rideB, eventType: DispatchEventType.RIDE_CREATED });
            await DispatchMonitorService.recordAsync({ rideId: rideA, eventType: DispatchEventType.ROUND_STARTED });
        } finally {
            DispatchMonitorService.setEmitter(null);
        }
        expect(byRide[rideA]).toEqual([1, 2]);
        expect(byRide[rideB]).toEqual([1]);
    });

    it('forgetting a ride releases its counter', async () => {
        const rideId = newRide();
        const seen: number[] = [];
        DispatchMonitorService.setEmitter((_e, p) => seen.push(p.sequence as number));
        try {
            await DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.RIDE_CREATED });
            DispatchMonitorService.forget(rideId);
            await DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.RIDE_CREATED });
        } finally {
            DispatchMonitorService.setEmitter(null);
        }
        expect(seen).toEqual([1, 1]);
    });

    it('pushes to admins even when persistence is unavailable', async () => {
        // The database is not initialised in unit tests, so this also proves a
        // monitoring write can never throw into the dispatch path.
        const rideId = newRide();
        let pushed = 0;
        DispatchMonitorService.setEmitter(() => { pushed += 1; });
        try {
            const saved = await DispatchMonitorService.recordAsync({
                rideId,
                eventType: DispatchEventType.DRIVER_ACCEPTED,
                driverId: newDriver(),
            });
            expect(saved).toBeNull();
        } finally {
            DispatchMonitorService.setEmitter(null);
        }
        expect(pushed).toBe(1);
    });

    it('a throwing emitter cannot break the recorder', async () => {
        const rideId = newRide();
        DispatchMonitorService.setEmitter(() => { throw new Error('admin socket exploded'); });
        try {
            await expect(
                DispatchMonitorService.recordAsync({ rideId, eventType: DispatchEventType.RIDE_CREATED }),
            ).resolves.toBeNull();
        } finally {
            DispatchMonitorService.setEmitter(null);
        }
    });
});
