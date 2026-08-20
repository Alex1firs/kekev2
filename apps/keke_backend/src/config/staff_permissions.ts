/**
 * The single catalogue of staff roles, permissions and their mapping.
 *
 * Permissions are CODE-DEFINED and role assignments are DURABLE (rows in
 * staff_role_assignment). That split is deliberate:
 *
 *  - a permission is a property of the software, so it belongs in source where
 *    it can be reviewed in a diff and typed at every call site;
 *  - a role assignment is a property of a person, so it belongs in the database
 *    where it can be granted, revoked and audited without a deploy.
 *
 * Nothing outside this file may decide what a role can do. Route handlers ask
 * for a PERMISSION, never a role name — a scattered `if (role === 'admin')` is
 * exactly the pattern this replaces.
 */

/** Roles a staff member may hold. A person may hold more than one. */
export enum StaffRole {
    SUPER_ADMIN = 'SUPER_ADMIN',
    OPERATIONS_ADMIN = 'OPERATIONS_ADMIN',
    /**
     * Watches the live ride queue and intervenes when automatic dispatch is
     * struggling. Deliberately NOT a driver: an operations account has no
     * User row and no DriverProfile, so it cannot appear as available supply.
     */
    OPERATIONS_DISPATCHER = 'OPERATIONS_DISPATCHER',
    PARK_SUPERVISOR = 'PARK_SUPERVISOR',
    PARK_DISPATCHER = 'PARK_DISPATCHER',
    CASHIER = 'CASHIER',
    SUPPORT_OFFICER = 'SUPPORT_OFFICER',
    READ_ONLY_ANALYST = 'READ_ONLY_ANALYST',
}

export const ALL_STAFF_ROLES: StaffRole[] = Object.values(StaffRole);

/**
 * Every permission in the platform.
 *
 * Naming is `domain:action`. Read permissions are named `*:read`; anything that
 * changes state, moves money or exposes personal data gets its own permission
 * rather than being folded into a broad write scope.
 */
export const StaffPermission = {
    // ── Staff administration ────────────────────────────────────────────
    STAFF_CREATE: 'staff:create',
    STAFF_READ: 'staff:read',
    STAFF_UPDATE: 'staff:update',
    STAFF_SUSPEND: 'staff:suspend',
    STAFF_RESET_CREDENTIALS: 'staff:reset_credentials',
    STAFF_ASSIGN_ROLES: 'staff:assign_roles',

    // ── Park operations (entities land in Phase 2; the permissions exist now
    //    so nothing has to invent an authorisation model later) ───────────
    PARK_CREATE: 'park:create',
    PARK_READ: 'park:read',
    PARK_UPDATE: 'park:update',
    PARK_ACTIVATE: 'park:activate',
    PARK_SUSPEND: 'park:suspend',
    PARK_ASSIGN_DISPATCHER: 'park:assign_dispatcher',
    PARK_VIEW_METRICS: 'park:view_metrics',
    /** Add or remove drivers on a park's roster, and reorder its queue. */
    PARK_MANAGE_ROSTER: 'park:manage_roster',
    /** Manage a park's zones (staging areas, boarding points, service sub-areas). */
    PARK_MANAGE_ZONES: 'park:manage_zones',

    // ── Dispatcher shifts ───────────────────────────────────────────────
    /** Open and close one's OWN shift at an assigned park. */
    SHIFT_OPEN: 'shift:open',
    /** Read shift history for a park. */
    SHIFT_READ: 'shift:read',
    /** Force-close somebody else's shift (supervisor / operations recovery). */
    SHIFT_CLOSE_ANY: 'shift:close_any',

    // ── Driver operational presence ─────────────────────────────────────
    PRESENCE_READ: 'presence:read',
    /** Record a presence transition on a driver's behalf (dispatcher at a park). */
    PRESENCE_WRITE: 'presence:write',

    // ── Dispatcher operations ───────────────────────────────────────────
    DISPATCH_CLAIM: 'dispatch:claim',
    DISPATCH_ASSIGN_DRIVER: 'dispatch:assign_driver',
    DISPATCH_RELEASE: 'dispatch:release',
    DISPATCH_REPORT_ISSUE: 'dispatch:report_issue',
    DISPATCH_VIEW_PASSENGER_MASKED_CONTACT: 'dispatch:view_passenger_masked_contact',
    DISPATCH_REVEAL_PASSENGER_CONTACT: 'dispatch:reveal_passenger_contact',

    // ── Badge operations ────────────────────────────────────────────────
    BADGE_ISSUE: 'badge:issue',
    BADGE_READ: 'badge:read',
    BADGE_REVOKE: 'badge:revoke',
    BADGE_REPLACE: 'badge:replace',

    // ── Passenger communications ────────────────────────────────────
    // Drafting and sending are deliberately different rights. The person who
    // writes an email to every passenger should not also be the person who
    // decides it goes out, and one permission covering both would make the
    // approval step decorative.
    COMMUNICATIONS_VIEW: 'communications:view',
    COMMUNICATIONS_CREATE: 'communications:create',
    COMMUNICATIONS_APPROVE: 'communications:approve',
    COMMUNICATIONS_SEND: 'communications:send',
    COMMUNICATIONS_SCHEDULE: 'communications:schedule',
    COMMUNICATIONS_VIEW_REPORTS: 'communications:view_reports',
    COMMUNICATIONS_MANAGE_TEMPLATES: 'communications:manage_templates',
    COMMUNICATIONS_MANAGE_PREFERENCES: 'communications:manage_preferences',

    // ── Finance ─────────────────────────────────────────────────────────
    WALLET_READ: 'wallet:read',
    WALLET_TOPUP_CREATE: 'wallet:topup_create',
    WALLET_TOPUP_CONFIRM: 'wallet:topup_confirm',
    WALLET_ADJUST: 'wallet:adjust',
    WALLET_REVERSE: 'wallet:reverse',
    SETTLEMENT_READ: 'settlement:read',
    SETTLEMENT_APPROVE: 'settlement:approve',

    // ── Operations Dispatch ─────────────────────────────────────────────
    // Narrow on purpose. Taking control of a ride, assigning a driver by hand
    // and ringing a driver are three different powers with three different
    // blast radii, so they are three permissions rather than one.
    OPS_QUEUE_READ: 'ops:queue_read',
    OPS_TAKEOVER: 'ops:takeover',
    OPS_RELEASE: 'ops:release',
    OPS_ASSIGN: 'ops:assign',
    OPS_CONTACT_DRIVER: 'ops:contact_driver',

    // ── Support / rides ─────────────────────────────────────────────────
    RIDE_READ: 'ride:read',
    RIDE_INTERVENE: 'ride:intervene',
    RIDE_CANCEL_OVERRIDE: 'ride:cancel_override',
    RIDE_REVEAL_CONTACT: 'ride:reveal_contact',
    /**
     * Dismiss a ride as non-collectible: no earnings, no commission, no debt,
     * and a reversal of anything already posted.
     *
     * Financial, not operational. It lives beside the ride permissions because
     * it acts on a ride, but its blast radius is money — which is why it is
     * its own capability and not folded into RIDE_INTERVENE. A park dispatcher
     * who can hand a ride to another driver must not thereby be able to erase
     * the commission on a commercial trip.
     */
    RIDE_VOID: 'ride:void',

    // ── Audit ───────────────────────────────────────────────────────────
    AUDIT_READ: 'audit:read',
    AUDIT_EXPORT: 'audit:export',

    // ── Legacy monitoring permissions ───────────────────────────────────
    // Retained verbatim from middleware/admin_permissions.ts so the existing
    // admin dashboard keeps working unchanged through the migration. These are
    // the ONLY permissions the legacy shared API key can ever hold.
    MONITOR_READ: 'monitor:read',
    MONITOR_REVEAL_CONTACT: 'monitor:reveal_contact',
    METRICS_READ: 'metrics:read',
    ADMIN_WRITE: 'admin:write',
} as const;

export type StaffPermissionType = typeof StaffPermission[keyof typeof StaffPermission];

export const ALL_PERMISSIONS: StaffPermissionType[] = Object.values(StaffPermission);

/**
 * Permissions the legacy shared `x-admin-key` may NEVER hold, however the key
 * is configured.
 *
 * A shared secret has no human behind it, so it must not be able to take an
 * action whose whole point is being attributable: issuing a badge, assigning a
 * dispatcher, revealing a passenger's number, moving money, or anything in the
 * park domain. See docs/admin_auth_migration.md.
 */
export const LEGACY_FORBIDDEN_PERMISSIONS: ReadonlySet<string> = new Set<string>([
    // A shared key has no person behind it. Emailing every passenger is the
    // single least attributable action in this system.
    StaffPermission.COMMUNICATIONS_VIEW,
    StaffPermission.COMMUNICATIONS_CREATE,
    StaffPermission.COMMUNICATIONS_APPROVE,
    StaffPermission.COMMUNICATIONS_SEND,
    StaffPermission.COMMUNICATIONS_SCHEDULE,
    StaffPermission.COMMUNICATIONS_VIEW_REPORTS,
    StaffPermission.COMMUNICATIONS_MANAGE_TEMPLATES,
    StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES,
    // staff administration — a shared key must never mint or elevate a human
    StaffPermission.STAFF_CREATE,
    StaffPermission.STAFF_UPDATE,
    StaffPermission.STAFF_SUSPEND,
    StaffPermission.STAFF_RESET_CREDENTIALS,
    StaffPermission.STAFF_ASSIGN_ROLES,
    // the entire park domain
    StaffPermission.PARK_CREATE,
    StaffPermission.PARK_UPDATE,
    StaffPermission.PARK_ACTIVATE,
    StaffPermission.PARK_SUSPEND,
    StaffPermission.PARK_ASSIGN_DISPATCHER,
    StaffPermission.PARK_MANAGE_ROSTER,
    StaffPermission.PARK_MANAGE_ZONES,
    StaffPermission.SHIFT_OPEN,
    StaffPermission.SHIFT_CLOSE_ANY,
    StaffPermission.PRESENCE_WRITE,
    StaffPermission.DISPATCH_CLAIM,
    StaffPermission.DISPATCH_ASSIGN_DRIVER,
    StaffPermission.DISPATCH_RELEASE,
    StaffPermission.DISPATCH_REPORT_ISSUE,
    StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT,
    StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT,
    // badges
    StaffPermission.BADGE_ISSUE,
    StaffPermission.BADGE_REVOKE,
    StaffPermission.BADGE_REPLACE,
    // money
    StaffPermission.WALLET_TOPUP_CREATE,
    StaffPermission.WALLET_TOPUP_CONFIRM,
    StaffPermission.WALLET_ADJUST,
    // Voiding reverses money and must name the person who did it.
    StaffPermission.RIDE_VOID,
    StaffPermission.WALLET_REVERSE,
    StaffPermission.SETTLEMENT_APPROVE,
    // Operations Dispatch. Reading the queue is fine from a shared key;
    // seizing a live ride or handing it to a driver is not — those must be
    // attributable to a named human, exactly like contact reveal.
    StaffPermission.OPS_TAKEOVER,
    StaffPermission.OPS_RELEASE,
    StaffPermission.OPS_ASSIGN,
    StaffPermission.OPS_CONTACT_DRIVER,
    // contact exposure
    StaffPermission.RIDE_REVEAL_CONTACT,
    // audit export (a bulk personal-data egress path)
    StaffPermission.AUDIT_EXPORT,
]);

/**
 * The role → permission matrix.
 *
 * Least privilege: a role gets what its job needs and nothing adjacent. Where a
 * capability is genuinely dangerous (wallet adjustment, credential reset,
 * contact reveal) it is granted to as few roles as the operation allows.
 *
 * Kept in sync with docs/staff_role_permission_matrix.md, which is generated
 * from this object — never hand-edited.
 */
const ROLE_MATRIX: Record<StaffRole, StaffPermissionType[]> = {
    /** Everything. Held by very few people; MFA mandatory. */
    [StaffRole.SUPER_ADMIN]: [...ALL_PERMISSIONS],

    /**
     * Runs supply: parks, devices, rosters, badges and driver operations.
     * Deliberately has NO wallet mutation and NO contact reveal — operations
     * staff have no reason to move money or read a passenger's number.
     *
     * Gets READ access to the Operations Dispatch queue so a supervisor can
     * see what is happening, but not takeover or assignment: intervening in a
     * live ride is the dispatcher's job and stays with that role.
     */
    [StaffRole.OPERATIONS_ADMIN]: [
        StaffPermission.OPS_QUEUE_READ,
        /*
         * May void a ride. Operations is who decides a training run or a
         * disputed trip does not count, so withholding this would just push
         * the work back to SUPER_ADMIN. Dispatchers below this level do not
         * get it: assigning a driver and cancelling the money owed on a
         * commercial ride are different powers.
         */
        StaffPermission.RIDE_VOID,
        StaffPermission.STAFF_READ,
        StaffPermission.PARK_CREATE,
        StaffPermission.PARK_READ,
        StaffPermission.PARK_UPDATE,
        StaffPermission.PARK_ACTIVATE,
        StaffPermission.PARK_SUSPEND,
        StaffPermission.PARK_ASSIGN_DISPATCHER,
        StaffPermission.PARK_VIEW_METRICS,
        StaffPermission.PARK_MANAGE_ROSTER,
        StaffPermission.PARK_MANAGE_ZONES,
        StaffPermission.SHIFT_READ,
        StaffPermission.SHIFT_CLOSE_ANY,
        StaffPermission.PRESENCE_READ,
        StaffPermission.PRESENCE_WRITE,
        StaffPermission.BADGE_ISSUE,
        StaffPermission.BADGE_READ,
        StaffPermission.BADGE_REVOKE,
        StaffPermission.BADGE_REPLACE,
        /*
         * Communications: may write, schedule and read the results — but NOT
         * approve or send. An operations admin who could draft a message to
         * every passenger AND release it would make the approval step
         * decorative, which is the failure this whole workflow exists to
         * prevent. Approval and sending stay with SUPER_ADMIN.
         */
        StaffPermission.COMMUNICATIONS_VIEW,
        StaffPermission.COMMUNICATIONS_CREATE,
        StaffPermission.COMMUNICATIONS_SCHEDULE,
        StaffPermission.COMMUNICATIONS_VIEW_REPORTS,
        StaffPermission.COMMUNICATIONS_MANAGE_TEMPLATES,
        StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES,
        StaffPermission.WALLET_READ,
        StaffPermission.SETTLEMENT_READ,
        StaffPermission.RIDE_READ,
        StaffPermission.AUDIT_READ,
        StaffPermission.MONITOR_READ,
        StaffPermission.METRICS_READ,
        StaffPermission.ADMIN_WRITE,
    ],

    /**
     * Runs ONE park. Supervises dispatchers, approves cashier settlements,
     * handles incidents. Cannot create parks.
     *
     * Issues badges. A badge is the physical card a driver carries and it is
     * handed over at the park, by the person standing there — routing that
     * through an operations admin in another city meant a driver who had been
     * rostered, approved and marked present still could not be given work, and
     * nobody on site could fix it. Revocation sits with the same person for the
     * same reason: a lost card is reported at the park.
     */
    [StaffRole.PARK_SUPERVISOR]: [
        StaffPermission.PARK_READ,
        StaffPermission.PARK_VIEW_METRICS,
        StaffPermission.PARK_ASSIGN_DISPATCHER,
        StaffPermission.PARK_MANAGE_ROSTER,
        StaffPermission.PARK_MANAGE_ZONES,
        StaffPermission.SHIFT_OPEN,
        StaffPermission.SHIFT_READ,
        StaffPermission.SHIFT_CLOSE_ANY,
        StaffPermission.PRESENCE_READ,
        StaffPermission.PRESENCE_WRITE,
        StaffPermission.BADGE_ISSUE,
        StaffPermission.BADGE_READ,
        StaffPermission.BADGE_REVOKE,
        StaffPermission.BADGE_REPLACE,
        StaffPermission.DISPATCH_CLAIM,
        StaffPermission.DISPATCH_ASSIGN_DRIVER,
        StaffPermission.DISPATCH_RELEASE,
        StaffPermission.DISPATCH_REPORT_ISSUE,
        StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT,
        StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT,
        StaffPermission.WALLET_READ,
        StaffPermission.SETTLEMENT_READ,
        StaffPermission.SETTLEMENT_APPROVE,
        StaffPermission.RIDE_READ,
        StaffPermission.AUDIT_READ,
        StaffPermission.MONITOR_READ,
        StaffPermission.METRICS_READ,
    ],

    /**
     * The park floor role. Claims requests and assigns drivers — and that is
     * the whole of its authority. It holds NO lifecycle permission because no
     * such permission exists: a dispatcher cannot mark a ride arrived, started
     * or completed anywhere in the system.
     *
     * Masked passenger contact only. Full reveal is a supervisor action.
     */
    [StaffRole.PARK_DISPATCHER]: [
        StaffPermission.PARK_READ,
        StaffPermission.BADGE_READ,
        StaffPermission.DISPATCH_CLAIM,
        StaffPermission.DISPATCH_ASSIGN_DRIVER,
        StaffPermission.DISPATCH_RELEASE,
        StaffPermission.DISPATCH_REPORT_ISSUE,
        StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT,
        StaffPermission.RIDE_READ,
        // Runs the park floor: opens their own shift, keeps the roster and the
        // queue honest, records what drivers are actually doing. None of this
        // touches a ride's lifecycle — no such permission exists.
        StaffPermission.SHIFT_OPEN,
        StaffPermission.SHIFT_READ,
        StaffPermission.PARK_MANAGE_ROSTER,
        StaffPermission.PRESENCE_READ,
        StaffPermission.PRESENCE_WRITE,
    ],

    /**
     * Operations Dispatch. Sees every live request, takes control when
     * automatic dispatch is struggling, and assigns a driver by hand.
     *
     * It can reveal a passenger's contact because the job is ringing people
     * whose ride has not arrived — but it deliberately has NO wallet, staff,
     * park-administration or badge authority. Assignment still runs through
     * DriverEligibilityService; this role cannot bypass a suspension, a debt
     * block or another active ride.
     */
    [StaffRole.OPERATIONS_DISPATCHER]: [
        StaffPermission.OPS_QUEUE_READ,
        StaffPermission.OPS_TAKEOVER,
        StaffPermission.OPS_RELEASE,
        StaffPermission.OPS_ASSIGN,
        StaffPermission.OPS_CONTACT_DRIVER,
        StaffPermission.RIDE_READ,
        StaffPermission.RIDE_INTERVENE,
        StaffPermission.RIDE_REVEAL_CONTACT,
        StaffPermission.MONITOR_READ,
        StaffPermission.PRESENCE_READ,
        StaffPermission.PARK_READ,
        StaffPermission.AUDIT_READ,
    ],

    /**
     * Handles driver cash. Records top-ups; cannot approve its own settlement
     * and cannot adjust or reverse a balance — those need finance/supervisor
     * authority. This separation is the primary control against cash loss.
     */
    [StaffRole.CASHIER]: [
        StaffPermission.PARK_READ,
        StaffPermission.BADGE_READ,
        StaffPermission.WALLET_READ,
        StaffPermission.WALLET_TOPUP_CREATE,
        StaffPermission.SETTLEMENT_READ,
    ],

    /**
     * Handles live calls, so it is the one non-super role that may reveal a
     * passenger's contact — every reveal is audited and expires.
     */
    [StaffRole.SUPPORT_OFFICER]: [
        StaffPermission.RIDE_READ,
        StaffPermission.RIDE_INTERVENE,
        StaffPermission.RIDE_CANCEL_OVERRIDE,
        StaffPermission.RIDE_REVEAL_CONTACT,
        StaffPermission.WALLET_READ,
        StaffPermission.AUDIT_READ,
        StaffPermission.MONITOR_READ,
        StaffPermission.MONITOR_REVEAL_CONTACT,
        StaffPermission.PARK_READ,
        StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT,
        StaffPermission.PRESENCE_READ,
        StaffPermission.SHIFT_READ,
    ],

    /** Reads numbers. Sees no contact data of any kind. */
    [StaffRole.READ_ONLY_ANALYST]: [
        StaffPermission.PARK_READ,
        StaffPermission.PARK_VIEW_METRICS,
        StaffPermission.WALLET_READ,
        StaffPermission.SETTLEMENT_READ,
        StaffPermission.RIDE_READ,
        StaffPermission.AUDIT_READ,
        StaffPermission.MONITOR_READ,
        StaffPermission.METRICS_READ,
        StaffPermission.BADGE_READ,
        StaffPermission.PRESENCE_READ,
        StaffPermission.SHIFT_READ,
    ],
};

/** Permissions granted by a single role. */
export function permissionsForRole(role: StaffRole): StaffPermissionType[] {
    return ROLE_MATRIX[role] ?? [];
}

/**
 * The effective permission set for a set of roles (union).
 *
 * Callers must NOT pass the roles of a staff member who is not ACTIVE — see
 * StaffAuthService.resolvePermissions, which is the only place that decides
 * whether a person's roles count at all.
 */
export function resolvePermissions(roles: StaffRole[]): Set<StaffPermissionType> {
    const out = new Set<StaffPermissionType>();
    for (const role of roles) {
        for (const permission of permissionsForRole(role)) out.add(permission);
    }
    return out;
}

/** The full matrix, for the admin UI's read-only role view and the doc generator. */
export function roleMatrixSnapshot(): Array<{ role: StaffRole; permissions: StaffPermissionType[] }> {
    return ALL_STAFF_ROLES.map((role) => ({
        role,
        permissions: [...permissionsForRole(role)].sort(),
    }));
}

/** Whether a string is a role we recognise (client input is never trusted). */
export function isStaffRole(value: unknown): value is StaffRole {
    return typeof value === 'string' && (ALL_STAFF_ROLES as string[]).includes(value);
}
