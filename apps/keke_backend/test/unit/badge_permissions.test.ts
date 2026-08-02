/**
 * Who may issue and revoke a driver badge.
 *
 * A badge is what makes a driver assignable, so the right to create one is the
 * right to put somebody on the road. It moved out to the park — a card is
 * handed over by the person standing there — and these tests are the record of
 * exactly how far it moved, so a later change to the role table cannot widen it
 * by accident.
 */

import {
    permissionsForRole,
    StaffPermission,
    StaffRole,
    LEGACY_FORBIDDEN_PERMISSIONS,
} from '../../src/config/staff_permissions';

const WRITE_PERMISSIONS = [
    StaffPermission.BADGE_ISSUE,
    StaffPermission.BADGE_REVOKE,
    StaffPermission.BADGE_REPLACE,
];

const MAY_WRITE = [
    StaffRole.SUPER_ADMIN,
    StaffRole.OPERATIONS_ADMIN,
    StaffRole.PARK_SUPERVISOR,
];

// Through the public accessor, so this tests what callers actually resolve
// rather than the shape of the table behind it.
const holds = (role: StaffRole, permission: string) =>
    permissionsForRole(role).includes(permission as any);

describe('badge permissions', () => {
    it.each(MAY_WRITE)('%s can issue, revoke and replace badges', (role) => {
        for (const permission of WRITE_PERMISSIONS) {
            expect(holds(role, permission)).toBe(true);
        }
    });

    /*
     * The one that matters most. A dispatcher assigns work; they do not decide
     * who is allowed to receive it. Letting the person under time pressure at
     * the counter also mint the credential removes the only separation between
     * those two decisions.
     */
    it('a dispatcher can never issue, revoke or replace a badge', () => {
        for (const permission of WRITE_PERMISSIONS) {
            expect(holds(StaffRole.PARK_DISPATCHER, permission)).toBe(false);
        }
    });

    it('a dispatcher can still read badges, to check one at the counter', () => {
        expect(holds(StaffRole.PARK_DISPATCHER, StaffPermission.BADGE_READ)).toBe(true);
    });

    it('no role outside the three may write badges', () => {
        for (const role of Object.values(StaffRole)) {
            if (MAY_WRITE.includes(role)) continue;
            for (const permission of WRITE_PERMISSIONS) {
                expect({ role, permission, holds: holds(role, permission) })
                    .toEqual({ role, permission, holds: false });
            }
        }
    });

    /*
     * The shared admin key has no person behind it. Issuing a badge is an
     * accountable act, so it stays barred regardless of which roles gain it.
     */
    it('the legacy shared key remains barred from writing badges', () => {
        for (const permission of WRITE_PERMISSIONS) {
            expect(LEGACY_FORBIDDEN_PERMISSIONS.has(permission)).toBe(true);
        }
    });
});
