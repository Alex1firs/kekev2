/**
 * Minimal, real role layer for admin endpoints.
 *
 * The existing auth is a single shared ADMIN_API_KEY with no per-admin identity,
 * so "who did what" was unanswerable and AuditLog.adminId was hardcoded to
 * "SYSTEM_ADMIN". Rather than invent an admin-user table in this phase, this adds
 * OPTIONAL scoped keys: each key maps to a role, and the role's label is what
 * gets audit-logged.
 *
 * Backwards compatible: with no extra env vars, ADMIN_API_KEY continues to work
 * exactly as before and is treated as the full-access `superadmin` role.
 */
import { Request, Response, NextFunction } from 'express';

export type AdminRole = 'superadmin' | 'operations' | 'support' | 'readonly';

export type AdminPermission =
    /** See the Live Ride Requests list, map and timelines (masked data). */
    | 'monitor:read'
    /** Reveal unmasked passenger/driver contact details. */
    | 'monitor:reveal_contact'
    /** Read driver behaviour metrics. */
    | 'metrics:read'
    /** Everything else (existing admin actions). */
    | 'admin:write';

/**
 * The LEGACY role map. Frozen deliberately.
 *
 * These four permissions are the entire authority a shared `x-admin-key` can
 * ever carry. New capabilities are defined in config/staff_permissions.ts and
 * granted to named humans only — see docs/admin_auth_migration.md.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
    superadmin: ['monitor:read', 'monitor:reveal_contact', 'metrics:read', 'admin:write'],
    // Dispatch/supply operators: full monitoring, no contact reveal.
    operations: ['monitor:read', 'metrics:read'],
    // Support agents handle live calls, so they may reveal a contact.
    support: ['monitor:read', 'monitor:reveal_contact'],
    readonly: ['monitor:read'],
};

export interface AdminIdentity {
    role: AdminRole;
    /**
     * Stable label recorded in the legacy audit log. Never the key itself.
     *
     * For a real staff session this is the staff member's id, so the existing
     * `audit_log` rows written by admin_routes stop saying "superadmin" and
     * start naming a human. Staff actions are ALSO written to
     * staff_audit_event, which is the richer, authoritative trail.
     */
    label: string;
    /** True when this identity came from the shared key rather than a person. */
    isLegacy?: boolean;
    /** Set for real staff sessions. Absent for legacy keys. */
    staffUserId?: string;
}

export interface AdminRequest extends Request {
    admin?: AdminIdentity;
    /** Populated by middleware/staff_auth.ts resolveActor. */
    actor?: import('./staff_auth').Actor;
}

/**
 * Resolve a presented key to an identity.
 *
 * Optional scoped keys, any subset may be set:
 *   ADMIN_OPERATIONS_API_KEY, ADMIN_SUPPORT_API_KEY, ADMIN_READONLY_API_KEY
 */
export function identifyAdmin(apiKey: string | undefined): AdminIdentity | null {
    if (!apiKey) return null;
    const candidates: Array<[string | undefined, AdminRole, string]> = [
        [process.env.ADMIN_API_KEY, 'superadmin', 'superadmin'],
        [process.env.ADMIN_OPERATIONS_API_KEY, 'operations', 'operations'],
        [process.env.ADMIN_SUPPORT_API_KEY, 'support', 'support'],
        [process.env.ADMIN_READONLY_API_KEY, 'readonly', 'readonly'],
    ];
    for (const [value, role, label] of candidates) {
        // Only non-empty configured keys can ever match.
        if (value && value.length > 0 && apiKey === value) return { role, label };
    }
    return null;
}

export function hasPermission(role: AdminRole, permission: AdminPermission): boolean {
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Project the resolved actor (middleware/staff_auth.ts) onto the legacy
 * `req.admin` shape the existing admin routes read.
 *
 * This is the whole of the compatibility bridge: every route in
 * admin_routes.ts keeps working untouched, while the identity behind it is now
 * either a named staff member or an explicitly-labelled legacy key.
 *
 * Runs after resolveActor, which has already rejected nothing — authentication
 * is enforced by adminOrStaffAuth before this point.
 */
export const attachAdminIdentity = (req: AdminRequest, _res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) {
        // No identity resolved. Deliberately leave req.admin unset so
        // requirePermission denies — the previous default-to-superadmin
        // behaviour was a privilege-escalation waiting to happen.
        return next();
    }
    if (actor.isLegacy) {
        req.admin = { role: actor.legacyRole, label: actor.legacyRole, isLegacy: true };
    } else {
        req.admin = {
            // Legacy shape needs a role string; staff authority comes from
            // actor.permissions, which requirePermission consults first.
            role: 'superadmin',
            label: actor.staffUserId,
            isLegacy: false,
            staffUserId: actor.staffUserId,
        };
    }
    return next();
};

/**
 * Gate a route on a legacy monitoring permission.
 *
 * DENY BY DEFAULT: a request with no resolved actor is refused. Authority comes
 * from the resolved actor's permission set; the legacy role map is consulted
 * only for legacy keys, which is the only identity it still describes.
 */
export const requirePermission =
    (permission: AdminPermission) =>
    (req: AdminRequest, res: Response, next: NextFunction) => {
        const actor = req.actor;
        if (!actor) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Sign in to continue.',
            });
        }
        if (actor.permissions.has(permission as any)) return next();

        return res.status(403).json({
            error: 'Forbidden',
            message: `You lack permission "${permission}".`,
        });
    };
