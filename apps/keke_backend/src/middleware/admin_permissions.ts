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

const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
    superadmin: ['monitor:read', 'monitor:reveal_contact', 'metrics:read', 'admin:write'],
    // Dispatch/supply operators: full monitoring, no contact reveal.
    operations: ['monitor:read', 'metrics:read'],
    // Support agents handle live calls, so they may reveal a contact.
    support: ['monitor:read', 'monitor:reveal_contact'],
    readonly: ['monitor:read'],
};

export interface AdminIdentity {
    role: AdminRole;
    /** Stable label recorded in the audit log. Never the key itself. */
    label: string;
}

export interface AdminRequest extends Request {
    admin?: AdminIdentity;
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
 * Attach the caller's identity. Runs after adminAuth, which has already rejected
 * anything that matches no configured key at all.
 */
export const attachAdminIdentity = (req: AdminRequest, _res: Response, next: NextFunction) => {
    req.admin = identifyAdmin(req.headers['x-admin-key'] as string | undefined) ?? {
        role: 'superadmin',
        label: 'superadmin',
    };
    next();
};

/** Gate a route on a permission. */
export const requirePermission =
    (permission: AdminPermission) =>
    (req: AdminRequest, res: Response, next: NextFunction) => {
        const role = req.admin?.role ?? 'superadmin';
        if (!hasPermission(role, permission)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: `Role "${role}" lacks permission "${permission}".`,
            });
        }
        next();
    };
