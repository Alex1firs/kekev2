/**
 * Park scoping for park-bound staff roles.
 *
 * Closes the limitation recorded in docs/staff_identity_architecture.md §10.4:
 * `StaffRoleAssignment.parkId` was stored from Phase 1 but nothing consulted
 * it, so a PARK_DISPATCHER granted at one park was effectively a dispatcher
 * everywhere. Now that parks exist, that gap is real rather than theoretical
 * and this closes it.
 *
 * The rule, in full:
 *
 *   - a grant WITH a parkId authorises that park and no other;
 *   - a grant with parkId = NULL is global, and is how OPERATIONS_ADMIN and
 *     SUPER_ADMIN reach every park;
 *   - a permission alone is never sufficient for a park-bound route. The scope
 *     check runs in addition to `requireStaffPermission`, never instead of it.
 *
 * Scope is resolved from the database on each check rather than cached in the
 * token, for the same reason Phase 1 re-reads status on every request: a
 * reassignment that only takes effect in an hour is not a reassignment.
 */
import { Response, NextFunction } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { StaffRole } from '../config/staff_permissions';
import { StaffRequest, auditActorOf } from './staff_auth';
import { AuditService, AuditAction } from '../services/audit_service';
import { errBody, ErrorCode } from '../utils/errors';

/** Roles whose authority is confined to the park they were granted at. */
export const PARK_BOUND_ROLES: StaffRole[] = [
    StaffRole.PARK_DISPATCHER,
    StaffRole.PARK_SUPERVISOR,
    StaffRole.CASHIER,
];

/**
 * Every park this staff member may act at, or `'*'` when their authority is
 * global.
 */
export async function staffParkScope(staffUserId: string): Promise<Set<string> | '*'> {
    const grants = await AppDataSource.getRepository(StaffRoleAssignment).find({
        where: { staffUserId, revokedAt: IsNull() },
    });

    const scoped = new Set<string>();
    for (const grant of grants) {
        const role = grant.role as StaffRole;
        // A global grant of any role that is not park-bound — OPERATIONS_ADMIN,
        // SUPER_ADMIN, SUPPORT_OFFICER — carries platform-wide authority.
        if (!PARK_BOUND_ROLES.includes(role) && grant.parkId == null) return '*';
        // A park-bound role granted with no park is also global. Operations can
        // create one deliberately (a relief supervisor covering every park);
        // it is unusual, and visible in the grant itself.
        if (grant.parkId == null) return '*';
        scoped.add(grant.parkId);
    }
    return scoped;
}

/** Whether a staff member may act at a specific park. */
export async function staffMayActAtPark(staffUserId: string, parkId: string): Promise<boolean> {
    const scope = await staffParkScope(staffUserId);
    return scope === '*' || scope.has(parkId);
}

/**
 * Whether a staff member holds one of the given roles AT a park.
 *
 * Stricter than `staffMayActAtPark`: opening a shift needs the dispatcher or
 * supervisor role specifically, not merely some authority that reaches the park.
 */
export async function staffHoldsParkRole(
    staffUserId: string,
    parkId: string,
    roles: StaffRole[],
): Promise<boolean> {
    const grants = await AppDataSource.getRepository(StaffRoleAssignment).find({
        where: { staffUserId, revokedAt: IsNull() },
    });
    return grants.some((g) => {
        if (!roles.includes(g.role as StaffRole)) return false;
        return g.parkId == null || g.parkId === parkId;
    });
}

/**
 * Gate a route on the caller being scoped to the park in the request.
 *
 * `paramName` is the route parameter carrying the park id. A route whose park
 * comes from the body should read it explicitly and call `staffMayActAtPark`
 * rather than contorting this middleware — an authorisation check that guesses
 * where its subject lives is a bug waiting to happen.
 */
export const requireParkScope =
    (paramName = 'parkId') =>
    async (req: StaffRequest, res: Response, next: NextFunction) => {
        const actor = req.actor;
        if (!actor) {
            return res.status(401).json(errBody(ErrorCode.SESSION_EXPIRED, 'Sign in to continue.'));
        }
        // The legacy shared key has no park scope and never will: it is barred
        // from every park permission, so it cannot reach these routes anyway.
        if (actor.isLegacy) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN,
                'The shared admin key cannot perform park operations.'));
        }

        const parkId = String((req.params as any)?.[paramName] ?? '');
        if (!parkId) {
            return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, 'A park id is required.'));
        }

        if (await staffMayActAtPark(actor.staffUserId, parkId)) return next();

        await AuditService.record({
            actor: auditActorOf(actor),
            action: AuditAction.PERMISSION_DENIED,
            resourceType: 'PARK',
            resourceId: parkId,
            parkId,
            outcome: 'denied',
            metadata: { reasonCode: 'park_scope', route: req.originalUrl, method: req.method },
            ipAddress: req.ip ?? null,
            correlationId: (req as any).requestId ?? null,
        });

        return res.status(403).json(errBody(ErrorCode.FORBIDDEN,
            'You are not assigned to this park.'));
    };
