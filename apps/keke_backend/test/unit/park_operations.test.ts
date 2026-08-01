/**
 * Park operations: presence state machine, operating hours, badge payloads and
 * the park-scope rules.
 *
 * Everything here runs without a database. The pieces that need one — park
 * creation, activation gating, rosters, queue ordering, shifts — live in
 * test/integration/park_operations_db.test.ts.
 */
import {
    DriverPresenceState,
} from '../../src/models/DriverPresence';
import { DriverPresenceService } from '../../src/services/driver_presence_service';
import { ParkService } from '../../src/services/park_service';
import { BadgeService } from '../../src/services/badge_service';
import { Park, ParkStatus } from '../../src/models/Park';
import { StaffPermission, resolvePermissions, StaffRole } from '../../src/config/staff_permissions';
import { legacyPermissions } from '../../src/middleware/staff_auth';
import { AT_PARK_STATES, ON_RIDE_STATES } from '../../src/repositories/park_repository';

const S = DriverPresenceState;

// ═══════════════════════════════════════════════════════════════════════════
describe('presence state machine', () => {
    it('refuses the jump from OFFLINE straight into a ride', () => {
        // The one rule that earns its place: if we believe somebody is at home
        // and the next thing we hear is "carrying a passenger", one of those
        // two facts is wrong and the system should say so.
        for (const rideState of [S.ASSIGNED, S.EN_ROUTE, S.PASSENGER_BOARDING, S.TRIP_STARTED]) {
            expect(DriverPresenceService.canTransition(S.OFFLINE, rideState)).toBe(false);
        }
    });

    it('allows a driver to start work, reach a park and join the queue', () => {
        expect(DriverPresenceService.canTransition(S.OFFLINE, S.ONLINE)).toBe(true);
        expect(DriverPresenceService.canTransition(S.ONLINE, S.AT_PARK)).toBe(true);
        expect(DriverPresenceService.canTransition(S.AT_PARK, S.WAITING)).toBe(true);
        expect(DriverPresenceService.canTransition(S.WAITING, S.ASSIGNED)).toBe(true);
    });

    it('walks the full ride sequence', () => {
        expect(DriverPresenceService.canTransition(S.ASSIGNED, S.EN_ROUTE)).toBe(true);
        expect(DriverPresenceService.canTransition(S.EN_ROUTE, S.PASSENGER_BOARDING)).toBe(true);
        expect(DriverPresenceService.canTransition(S.PASSENGER_BOARDING, S.TRIP_STARTED)).toBe(true);
        expect(DriverPresenceService.canTransition(S.TRIP_STARTED, S.AT_PARK)).toBe(true);
    });

    it('lets a ride fall through from ANY ride state back to a resting state', () => {
        // Passengers cancel, drivers give up, dispatchers reassign. A state
        // machine that cannot express that traps drivers in a ride that ended.
        for (const rideState of [S.ASSIGNED, S.EN_ROUTE, S.PASSENGER_BOARDING]) {
            expect(DriverPresenceService.canTransition(rideState, S.WAITING)).toBe(true);
            expect(DriverPresenceService.canTransition(rideState, S.ONLINE)).toBe(true);
        }
    });

    it('allows stepping out and coming back', () => {
        expect(DriverPresenceService.canTransition(S.WAITING, S.UNAVAILABLE)).toBe(true);
        expect(DriverPresenceService.canTransition(S.UNAVAILABLE, S.WAITING)).toBe(true);
        expect(DriverPresenceService.canTransition(S.UNAVAILABLE, S.OFFLINE)).toBe(true);
    });

    it('treats re-entering the same state as legal (apps retry, humans double-tap)', () => {
        for (const state of Object.values(DriverPresenceState)) {
            expect(DriverPresenceService.canTransition(state, state)).toBe(true);
        }
    });

    it('every state has at least one way out — nothing is a dead end', () => {
        for (const state of Object.values(DriverPresenceState)) {
            expect(DriverPresenceService.allowedNextStates(state).length).toBeGreaterThan(0);
        }
    });

    it('can always reach OFFLINE, so a driver can always stop working', () => {
        for (const state of Object.values(DriverPresenceState)) {
            if (state === S.OFFLINE) continue;
            expect(DriverPresenceService.allowedNextStates(state)).toContain(S.OFFLINE);
        }
    });

    it('classifies at-park and on-ride states consistently', () => {
        expect(AT_PARK_STATES).toContain(S.WAITING);
        expect(AT_PARK_STATES).not.toContain(S.OFFLINE);
        expect(AT_PARK_STATES).not.toContain(S.ONLINE);
        // Every on-ride state is also an at-park state: a driver on a trip that
        // started at a park is still that park's driver.
        for (const state of ON_RIDE_STATES) expect(AT_PARK_STATES).toContain(state);
        expect(ON_RIDE_STATES).not.toContain(S.WAITING);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('park operating hours', () => {
    const park = (over: Partial<Park> = {}): Park => ({
        opensAt: '06:00',
        closesAt: '19:00',
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        timezone: 'Africa/Lagos',
        ...over,
    } as Park);

    // Africa/Lagos is UTC+1 with no DST, so these UTC instants map predictably.
    const atLagos = (hour: number, minute = 0, day = '2026-08-03') =>
        new Date(`${day}T${String(hour - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);

    it('is open inside the window and closed outside it', () => {
        expect(ParkService.isWithinOperatingHours(park(), atLagos(9))).toBe(true);
        expect(ParkService.isWithinOperatingHours(park(), atLagos(5))).toBe(false);
        expect(ParkService.isWithinOperatingHours(park(), atLagos(20))).toBe(false);
    });

    it('treats a park with no configured hours as always open', () => {
        expect(ParkService.isWithinOperatingHours(park({ opensAt: null, closesAt: null }), atLagos(3))).toBe(true);
    });

    it('handles a window that crosses midnight', () => {
        const night = park({ opensAt: '22:00', closesAt: '04:00' });
        expect(ParkService.isWithinOperatingHours(night, atLagos(23))).toBe(true);
        expect(ParkService.isWithinOperatingHours(night, atLagos(2))).toBe(true);
        expect(ParkService.isWithinOperatingHours(night, atLagos(12))).toBe(false);
    });

    it('respects days of the week', () => {
        // 2026-08-03 is a Monday; 2026-08-02 a Sunday.
        const weekdaysOnly = park({ daysOfWeek: [1, 2, 3, 4, 5] });
        expect(ParkService.isWithinOperatingHours(weekdaysOnly, atLagos(9, 0, '2026-08-03'))).toBe(true);
        expect(ParkService.isWithinOperatingHours(weekdaysOnly, atLagos(9, 0, '2026-08-02'))).toBe(false);
    });

    it('an unknown timezone leaves the park open rather than permanently shut', () => {
        expect(ParkService.isWithinOperatingHours(park({ timezone: 'Mars/Olympus' }), atLagos(9))).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('badge QR payload', () => {
    const badge = {
        badgeSerial: 'KR-000042',
        driverPublicId: 'abc123XYZ_-',
        issuedAt: new Date('2026-08-01T00:00:00Z'),
        keyVersion: 1,
    };

    it('round-trips a payload it built itself', () => {
        const payload = BadgeService.buildPayload(badge);
        const result = BadgeService.verifyPayload(payload);
        expect(result.valid).toBe(true);
        expect(result.badgeSerial).toBe('KR-000042');
        expect(result.driverPublicId).toBe('abc123XYZ_-');
    });

    it('carries no personal data — a photographed badge reveals nothing', () => {
        const payload = BadgeService.buildPayload(badge);
        expect(payload).not.toMatch(/@/);
        expect(payload).not.toMatch(/\d{11}/);          // no phone number
        expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i); // no internal uuid
        expect(payload.startsWith('KR1|')).toBe(true);
    });

    it('rejects a tampered serial', () => {
        const payload = BadgeService.buildPayload(badge);
        const forged = payload.replace('KR-000042', 'KR-000043');
        expect(BadgeService.verifyPayload(forged).valid).toBe(false);
        expect(BadgeService.verifyPayload(forged).reason).toBe('bad_signature');
    });

    it('rejects a tampered driver id', () => {
        const payload = BadgeService.buildPayload(badge);
        const forged = payload.replace('abc123XYZ_-', 'zzz999AAA_-');
        expect(BadgeService.verifyPayload(forged).valid).toBe(false);
    });

    it('rejects a hand-made payload with no valid signature', () => {
        expect(BadgeService.verifyPayload('KR1|1|KR-000001|fake|20000|AAAAAAAAAAAAAA').valid).toBe(false);
    });

    it('rejects malformed, empty and oversized input without throwing', () => {
        for (const bad of ['', 'nonsense', 'KR1|1|2', 'x'.repeat(500), 'KR9|1|a|b|c|d']) {
            expect(() => BadgeService.verifyPayload(bad)).not.toThrow();
            expect(BadgeService.verifyPayload(bad).valid).toBe(false);
        }
    });

    it('rejects an unknown key version rather than throwing', () => {
        const result = BadgeService.verifyPayload('KR1|7|KR-000001|abc|20000|AAAAAAAAAAAAAA');
        expect(result.valid).toBe(false);
    });

    it('two badges never produce the same payload', () => {
        const other = { ...badge, badgeSerial: 'KR-000043', driverPublicId: 'zzz999AAA_-' };
        expect(BadgeService.buildPayload(badge)).not.toBe(BadgeService.buildPayload(other));
    });

    it('signature verification alone says nothing about validity', () => {
        // The deliberately blunt contract: a REVOKED badge still verifies, so a
        // caller that skips the database check would accept it.
        const payload = BadgeService.buildPayload(badge);
        const result = BadgeService.verifyPayload(payload);
        expect(result.valid).toBe(true);
        expect(result).not.toHaveProperty('status');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('park permissions', () => {
    it('a dispatcher can run the floor but not configure the park', () => {
        const p = resolvePermissions([StaffRole.PARK_DISPATCHER]);
        expect(p.has(StaffPermission.SHIFT_OPEN)).toBe(true);
        expect(p.has(StaffPermission.PARK_MANAGE_ROSTER)).toBe(true);
        expect(p.has(StaffPermission.PRESENCE_WRITE)).toBe(true);
        expect(p.has(StaffPermission.PARK_CREATE)).toBe(false);
        expect(p.has(StaffPermission.PARK_UPDATE)).toBe(false);
        expect(p.has(StaffPermission.PARK_MANAGE_ZONES)).toBe(false);
        expect(p.has(StaffPermission.BADGE_ISSUE)).toBe(false);
    });

    it('a dispatcher still holds NO ride-lifecycle permission', () => {
        // The Phase 2 surface added shifts, rosters and presence and must not
        // have quietly added a way to advance a ride.
        const p = [...resolvePermissions([StaffRole.PARK_DISPATCHER])];
        expect(p.some((x) => /ride:(start|complete|arrive|advance)/.test(x))).toBe(false);
        expect(p).not.toContain(StaffPermission.RIDE_INTERVENE);
        expect(p).not.toContain(StaffPermission.RIDE_CANCEL_OVERRIDE);
    });

    it('a supervisor can close somebody else\'s shift; a dispatcher cannot', () => {
        expect(resolvePermissions([StaffRole.PARK_SUPERVISOR]).has(StaffPermission.SHIFT_CLOSE_ANY)).toBe(true);
        expect(resolvePermissions([StaffRole.PARK_DISPATCHER]).has(StaffPermission.SHIFT_CLOSE_ANY)).toBe(false);
    });

    it('a cashier cannot touch the roster, the queue or presence', () => {
        const p = resolvePermissions([StaffRole.CASHIER]);
        expect(p.has(StaffPermission.PARK_MANAGE_ROSTER)).toBe(false);
        expect(p.has(StaffPermission.PRESENCE_WRITE)).toBe(false);
        expect(p.has(StaffPermission.SHIFT_OPEN)).toBe(false);
    });

    it('the analyst can watch presence but never change it', () => {
        const p = resolvePermissions([StaffRole.READ_ONLY_ANALYST]);
        expect(p.has(StaffPermission.PRESENCE_READ)).toBe(true);
        expect(p.has(StaffPermission.PRESENCE_WRITE)).toBe(false);
    });

    it('the legacy shared key holds NONE of the new park permissions', () => {
        for (const role of ['superadmin', 'operations', 'support', 'readonly'] as const) {
            const granted = legacyPermissions(role);
            for (const forbidden of [
                StaffPermission.PARK_MANAGE_ROSTER,
                StaffPermission.PARK_MANAGE_ZONES,
                StaffPermission.SHIFT_OPEN,
                StaffPermission.SHIFT_CLOSE_ANY,
                StaffPermission.PRESENCE_WRITE,
            ]) {
                expect(granted.has(forbidden)).toBe(false);
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('park status', () => {
    it('a park is never born active', () => {
        // Enforced in ParkService.create, which ignores any status the caller
        // sends. Asserted at the DB level in the integration suite.
        expect(ParkStatus.DRAFT).toBe('draft');
        expect(Object.values(ParkStatus)).toEqual(['draft', 'active', 'inactive', 'suspended']);
    });
});
