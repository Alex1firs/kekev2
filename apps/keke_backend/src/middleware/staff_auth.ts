/**
 * Staff authentication and authorisation middleware.
 *
 * One actor concept for the whole admin surface, resolved from exactly two
 * sources and never from anything the client asserts about itself:
 *
 *   1. `Authorization: Bearer <staff access token>` → a real, named human;
 *   2. `x-admin-key: <shared key>`                  → the LEGACY actor, which is
 *      attributed to the SYSTEM_LEGACY_ADMIN sentinel and is permanently barred
 *      from every sensitive permission (see LEGACY_FORBIDDEN_PERMISSIONS).
 *
 * Deny by default. `requireStaffPermission` grants nothing it was not asked to
 * grant, and an unauthenticated request can never fall through to a default
 * identity — the previous behaviour, where a missing identity resolved to
 * `superadmin`, is gone.
 *
 * 401 vs 403 is kept honest: 401 means "we do not know who you are", 403 means
 * "we know, and you may not". Conflating them makes a permission bug look like
 * an expired session for the rest of its life.
 */
import { Request, Response, NextFunction } from 'express';
import { StaffAuthService, StaffIdentity } from '../services/staff_auth_service';
import { StaffPermissionType, StaffRole, LEGACY_FORBIDDEN_PERMISSIONS } from '../config/staff_permissions';
import { AuditService, AuditAction, SYSTEM_LEGACY_ADMIN, AuditActor } from '../services/audit_service';
import { identifyAdmin, AdminRole, ROLE_PERMISSIONS } from './admin_permissions';
import { errBody, ErrorCode } from '../utils/errors';

/** The shared-key actor. Never a person, and labelled as such everywhere. */
export interface LegacyActor {
    isLegacy: true;
    staffUserId: typeof SYSTEM_LEGACY_ADMIN;
    /** Which configured key was presented — `superadmin`, `operations`, … */
    legacyRole: AdminRole;
    roles: StaffRole[];
    permissions: Set<StaffPermissionType>;
    sessionId: null;
}

export type Actor = StaffIdentity | LegacyActor;

export interface StaffRequest extends Request {
    actor?: Actor;
    requestId?: string;
}

/** Master switch for the transition. See docs/admin_auth_migration.md. */
export function legacyAdminKeyEnabled(): boolean {
    return process.env.LEGACY_ADMIN_KEY_ENABLED !== 'false';
}

/**
 * The permission set a legacy key may hold.
 *
 * Derived from the legacy role map and then filtered through the forbidden
 * list. The filter is redundant today — no legacy role maps to a restricted
 * permission — and that is the point: it stays correct if somebody later adds
 * one, instead of silently handing a shared secret the power to issue badges.
 */
export function legacyPermissions(role: AdminRole): Set<StaffPermissionType> {
    const out = new Set<StaffPermissionType>();
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
        if (LEGACY_FORBIDDEN_PERMISSIONS.has(permission)) continue;
        out.add(permission as StaffPermissionType);
    }
    return out;
}

/** Shape an actor for the audit trail. */
export function auditActorOf(actor: Actor | undefined): AuditActor {
    if (!actor) return { staffUserId: 'ANONYMOUS', roles: [], isLegacy: false };
    return {
        staffUserId: actor.isLegacy ? SYSTEM_LEGACY_ADMIN : actor.staffUserId,
        roles: actor.roles,
        isLegacy: actor.isLegacy === true,
    };
}

function bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
}

/**
 * Populate `req.actor` when a valid credential is present.
 *
 * Does NOT reject on its own — rejection is `requireStaffAuth`'s job, so a
 * route can be public-with-optional-identity if it ever needs to be. A staff
 * token always wins over a legacy key: presenting both must not let a human
 * silently fall back to the shared identity when their session has expired.
 */
export const resolveActor = async (req: StaffRequest, _res: Response, next: NextFunction) => {
    try {
        const token = bearerToken(req);
        if (token) {
            const identity = await StaffAuthService.identify(token);
            if (identity) {
                req.actor = identity;
                return next();
            }
            // A presented-but-invalid staff token is an authentication failure,
            // not an invitation to try the shared key.
            return next();
        }

        if (legacyAdminKeyEnabled()) {
            const legacy = identifyAdmin(req.headers['x-admin-key'] as string | undefined);
            if (legacy) {
                req.actor = {
                    isLegacy: true,
                    staffUserId: SYSTEM_LEGACY_ADMIN,
                    legacyRole: legacy.role,
                    roles: [],
                    permissions: legacyPermissions(legacy.role),
                    sessionId: null,
                };
            }
        }
        return next();
    } catch (err: any) {
        console.error('[STAFF_AUTH] actor resolution failed:', err?.message);
        return next();
    }
};

/** 401 unless some valid credential was presented. */
export const requireStaffAuth = (req: StaffRequest, res: Response, next: NextFunction) => {
    if (!req.actor) {
        return res.status(401).json(errBody(ErrorCode.SESSION_EXPIRED, 'Sign in to continue.'));
    }
    return next();
};

/** 403 for the legacy shared key on routes that require an attributable human. */
export const requireRealStaff = (req: StaffRequest, res: Response, next: NextFunction) => {
    if (!req.actor) {
        return res.status(401).json(errBody(ErrorCode.SESSION_EXPIRED, 'Sign in to continue.'));
    }
    if (req.actor.isLegacy) {
        void AuditService.record({
            actor: auditActorOf(req.actor),
            action: AuditAction.PERMISSION_DENIED,
            resourceType: 'ROUTE',
            resourceId: req.originalUrl,
            outcome: 'denied',
            metadata: { reasonCode: 'legacy_key_not_a_person', method: req.method },
            ipAddress: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            correlationId: (req as any).requestId ?? null,
        });
        return res.status(403).json(errBody(
            ErrorCode.FORBIDDEN,
            'This action requires a named staff account. The shared admin key cannot perform it.',
        ));
    }
    return next();
};

/**
 * Gate a route on one or more permissions.
 *
 * Multiple permissions are OR-ed — a route reachable by two different jobs
 * should say so rather than being duplicated. Denials are audited so an
 * attempted privilege escalation is as visible as a successful action.
 */
export const requireStaffPermission =
    (...permissions: StaffPermissionType[]) =>
    (req: StaffRequest, res: Response, next: NextFunction) => {
        const actor = req.actor;
        if (!actor) {
            return res.status(401).json(errBody(ErrorCode.SESSION_EXPIRED, 'Sign in to continue.'));
        }

        const granted = permissions.some((p) => actor.permissions.has(p));
        if (granted) return next();

        void AuditService.record({
            actor: auditActorOf(actor),
            action: AuditAction.PERMISSION_DENIED,
            resourceType: 'ROUTE',
            resourceId: req.originalUrl,
            outcome: 'denied',
            metadata: {
                required: permissions,
                method: req.method,
                actorKind: actor.isLegacy ? 'legacy_key' : 'staff',
            },
            ipAddress: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            correlationId: (req as any).requestId ?? null,
        });

        return res.status(403).json(errBody(
            ErrorCode.FORBIDDEN,
            actor.isLegacy
                ? 'The shared admin key is not permitted to perform this action.'
                : 'You do not have permission to perform this action.',
        ));
    };

/** Whether an actor holds a permission, for conditional response shaping. */
export function actorHas(actor: Actor | undefined, permission: StaffPermissionType): boolean {
    return actor?.permissions.has(permission) === true;
}
