/**
 * Who may draft, who may approve, who may send — and who may not come near it.
 *
 * A mass email to every passenger is irreversible in a way almost nothing else
 * in this platform is: it cannot be recalled, and a bad one costs the sending
 * domain that also carries verification codes and password resets. These tests
 * are the record of exactly how narrow that authority is.
 */

import {
    permissionsForRole, StaffPermission, StaffRole, LEGACY_FORBIDDEN_PERMISSIONS,
} from '../../src/config/staff_permissions';

const COMMS = [
    StaffPermission.COMMUNICATIONS_VIEW,
    StaffPermission.COMMUNICATIONS_CREATE,
    StaffPermission.COMMUNICATIONS_APPROVE,
    StaffPermission.COMMUNICATIONS_SEND,
    StaffPermission.COMMUNICATIONS_SCHEDULE,
    StaffPermission.COMMUNICATIONS_VIEW_REPORTS,
    StaffPermission.COMMUNICATIONS_MANAGE_TEMPLATES,
    StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES,
];

const holds = (role: StaffRole, permission: string) =>
    permissionsForRole(role).includes(permission as any);

describe('who can reach passenger communications', () => {
    it('SUPER_ADMIN holds all of it', () => {
        for (const p of COMMS) expect(holds(StaffRole.SUPER_ADMIN, p)).toBe(true);
    });

    /*
     * The separation that makes approval mean something. An operations admin
     * who could both write a message to every passenger and release it would
     * make the approval step decorative.
     */
    it('OPERATIONS_ADMIN can draft and schedule but NOT approve or send', () => {
        expect(holds(StaffRole.OPERATIONS_ADMIN, StaffPermission.COMMUNICATIONS_CREATE)).toBe(true);
        expect(holds(StaffRole.OPERATIONS_ADMIN, StaffPermission.COMMUNICATIONS_SCHEDULE)).toBe(true);
        expect(holds(StaffRole.OPERATIONS_ADMIN, StaffPermission.COMMUNICATIONS_VIEW_REPORTS)).toBe(true);

        expect(holds(StaffRole.OPERATIONS_ADMIN, StaffPermission.COMMUNICATIONS_APPROVE)).toBe(false);
        expect(holds(StaffRole.OPERATIONS_ADMIN, StaffPermission.COMMUNICATIONS_SEND)).toBe(false);
    });

    it.each([
        StaffRole.PARK_SUPERVISOR,
        StaffRole.PARK_DISPATCHER,
        StaffRole.CASHIER,
        StaffRole.SUPPORT_OFFICER,
        StaffRole.READ_ONLY_ANALYST,
    ])('%s holds no communications permission at all', (role) => {
        for (const p of COMMS) expect(holds(role, p)).toBe(false);
    });

    it('only two roles can send', () => {
        const senders = Object.values(StaffRole)
            .filter((r) => holds(r, StaffPermission.COMMUNICATIONS_SEND));
        expect(senders).toEqual([StaffRole.SUPER_ADMIN]);
    });

    /*
     * A shared secret has no person behind it. Emailing every passenger is the
     * least attributable action in this system, so the legacy key is barred
     * from the whole namespace rather than from the dangerous half of it.
     */
    it('the legacy shared key is barred from every communications permission', () => {
        for (const p of COMMS) expect(LEGACY_FORBIDDEN_PERMISSIONS.has(p)).toBe(true);
    });
});
