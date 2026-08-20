/**
 * Who may void a ride.
 *
 * Voiding dismisses a ride as non-collectible and reverses anything already
 * posted for it. Before this it sat behind nothing but "are you logged in",
 * which meant a park dispatcher could erase the commission on a commercial
 * trip. These tests pin the capability to the roles that should hold it.
 */
import { StaffRole, StaffPermission, permissionsForRole, LEGACY_FORBIDDEN_PERMISSIONS }
    from '../../src/config/staff_permissions';

const can = (role: StaffRole) =>
    (permissionsForRole(role) as string[]).includes(StaffPermission.RIDE_VOID);

describe('ride:void — capability assignment', () => {
    it('SUPER_ADMIN may void', () => {
        expect(can(StaffRole.SUPER_ADMIN)).toBe(true);
    });

    it('OPERATIONS_ADMIN may void', () => {
        expect(can(StaffRole.OPERATIONS_ADMIN)).toBe(true);
    });

    it.each([
        StaffRole.PARK_DISPATCHER,
        StaffRole.OPERATIONS_DISPATCHER,
        StaffRole.PARK_SUPERVISOR,
        StaffRole.CASHIER,
        StaffRole.SUPPORT_OFFICER,
        StaffRole.READ_ONLY_ANALYST,
    ])('%s may NOT void', (role) => {
        expect(can(role)).toBe(false);
    });

    it('the legacy shared admin key can never hold it — a void must name a person', () => {
        expect(LEGACY_FORBIDDEN_PERMISSIONS.has(StaffPermission.RIDE_VOID)).toBe(true);
    });

    it('is a separate capability from intervening in a ride', () => {
        // A dispatcher reassigning a stuck ride is a different power from
        // cancelling the money owed on it. If these ever collapse into one
        // permission, the dispatcher silently gains the financial one.
        expect(StaffPermission.RIDE_VOID).not.toBe(StaffPermission.RIDE_INTERVENE);
        const dispatcher = permissionsForRole(StaffRole.OPERATIONS_DISPATCHER) as string[];
        expect(dispatcher).toContain(StaffPermission.OPS_ASSIGN);
        expect(dispatcher).not.toContain(StaffPermission.RIDE_VOID);
    });
});
