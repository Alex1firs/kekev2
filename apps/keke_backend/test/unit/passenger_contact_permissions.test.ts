/**
 * Who may see a passenger's real phone number from Operations Dispatch.
 *
 * Adding "Call passenger" to the Operations surface put a customer's personal
 * data one tap from a screen that a dispatcher carries around a park. The
 * button is not the boundary — the SERVER is — so these tests assert the
 * permission set itself, in the file where it is decided.
 *
 * The failure worth guarding against is not somebody maliciously widening
 * this. It is somebody adding a role next year, copying the nearest existing
 * list, and quietly giving a cashier a directory of passenger numbers.
 */
import {
    StaffRole,
    StaffPermission,
    permissionsForRole,
    LEGACY_FORBIDDEN_PERMISSIONS,
} from '../../src/config/staff_permissions';
import { PASSENGER_CONTACT_REASONS } from '../../src/routes/operations_routes';

/** The two permissions the Operations passenger-contact route accepts. */
const REVEAL = [
    StaffPermission.RIDE_REVEAL_CONTACT,
    StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT,
] as const;

const mayReveal = (role: StaffRole) => {
    const held = permissionsForRole(role);
    return REVEAL.some((p) => held.includes(p));
};

describe('passenger contact reveal — who holds it', () => {
    it('the Operations dispatcher can, because ringing a waiting passenger is the job', () => {
        expect(mayReveal(StaffRole.OPERATIONS_DISPATCHER)).toBe(true);
    });

    it('so can support and a park supervisor, who already could', () => {
        // Unchanged by this work — asserted so a future tightening is a
        // deliberate decision rather than a side effect.
        expect(mayReveal(StaffRole.SUPPORT_OFFICER)).toBe(true);
        expect(mayReveal(StaffRole.PARK_SUPERVISOR)).toBe(true);
    });

    it.each([
        StaffRole.PARK_DISPATCHER,
        StaffRole.CASHIER,
        StaffRole.READ_ONLY_ANALYST,
        StaffRole.OPERATIONS_ADMIN,
    ])('%s cannot — masked contact is the whole of their access', (role) => {
        expect(mayReveal(role)).toBe(false);
    });

    it('the shared admin key can never reveal contact, whatever it is granted', () => {
        /*
         * The legacy key is not a person. A reveal has to be attributable to a
         * named human or the audit trail says nothing worth reading.
         */
        expect(LEGACY_FORBIDDEN_PERMISSIONS.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(true);
    });

    it('ops:queue_read alone is not enough to see a number', () => {
        // The most likely mistake: gating the new button on the permission that
        // renders the queue, because that is what every other ops route uses.
        const analyst = permissionsForRole(StaffRole.READ_ONLY_ANALYST);
        const opsAdmin = permissionsForRole(StaffRole.OPERATIONS_ADMIN);
        expect(opsAdmin).toContain(StaffPermission.OPS_QUEUE_READ);
        expect(mayReveal(StaffRole.OPERATIONS_ADMIN)).toBe(false);
        expect(analyst).not.toContain(StaffPermission.RIDE_REVEAL_CONTACT);
    });
});

describe('the reason a dispatcher gives', () => {
    it('is a fixed vocabulary, so "why were numbers revealed last month" is a GROUP BY', () => {
        const codes = Object.keys(PASSENGER_CONTACT_REASONS);
        expect(codes.length).toBeGreaterThan(0);
        for (const code of codes) {
            expect(code).toMatch(/^[A-Z_]+$/);
            expect(PASSENGER_CONTACT_REASONS[code].length).toBeGreaterThan(0);
        }
    });

    it('has a code for the case that produced this feature', () => {
        // A passenger waiting on a ride nobody has taken is the reason
        // Operations Dispatch exists, and the reason it needs a phone.
        expect(PASSENGER_CONTACT_REASONS).toHaveProperty('NO_DRIVER_FOUND');
        expect(PASSENGER_CONTACT_REASONS).toHaveProperty('LONG_WAIT');
    });

    it('fits the column that stores it', () => {
        // OperationsIntervention.reason is varchar(48). A longer code would be
        // truncated or rejected at insert — after the number was revealed.
        for (const code of Object.keys(PASSENGER_CONTACT_REASONS)) {
            expect(code.length).toBeLessThanOrEqual(48);
        }
    });
});
