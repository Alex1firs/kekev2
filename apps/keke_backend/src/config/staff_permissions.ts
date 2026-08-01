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

    // ── Finance ─────────────────────────────────────────────────────────
    WALLET_READ: 'wallet:read',
    WALLET_TOPUP_CREATE: 'wallet:topup_create',
    WALLET_TOPUP_CONFIRM: 'wallet:topup_confirm',
    WALLET_ADJUST: 'wallet:adjust',
    WALLET_REVERSE: 'wallet:reverse',
    SETTLEMENT_READ: 'settlement:read',
    SETTLEMENT_APPROVE: 'settlement:approve',

    // ── Support / rides ─────────────────────────────────────────────────
    RIDE_READ: 'ride:read',
    RIDE_INTERVENE: 'ride:intervene',
    RIDE_CANCEL_OVERRIDE: 'ride:cancel_override',
    RIDE_REVEAL_CONTACT: 'ride:reveal_contact',

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
    StaffPermission.WALLET_REVERSE,
    StaffPermission.SETTLEMENT_APPROVE,
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
     */
    [StaffRole.OPERATIONS_ADMIN]: [
        StaffPermission.STAFF_READ,
        StaffPermission.PARK_CREATE,
        StaffPermission.PARK_READ,
        StaffPermission.PARK_UPDATE,
        StaffPermission.PARK_ACTIVATE,
        StaffPermission.PARK_SUSPEND,
        StaffPermission.PARK_ASSIGN_DISPATCHER,
        StaffPermission.PARK_VIEW_METRICS,
        StaffPermission.BADGE_ISSUE,
        StaffPermission.BADGE_READ,
        StaffPermission.BADGE_REVOKE,
        StaffPermission.BADGE_REPLACE,
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
     * handles incidents. Cannot create parks or issue badges.
     */
    [StaffRole.PARK_SUPERVISOR]: [
        StaffPermission.PARK_READ,
        StaffPermission.PARK_VIEW_METRICS,
        StaffPermission.PARK_ASSIGN_DISPATCHER,
        StaffPermission.BADGE_READ,
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
