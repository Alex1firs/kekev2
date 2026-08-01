/**
 * Staff management and audit endpoints, mounted INSIDE the admin router.
 *
 * Mounting here rather than at a new top-level path is deliberate: the admin
 * dashboard already points at /api/v1/admin, and these routes inherit the whole
 * chain that guards it (adminAuth → resolveActor → requireStaffAuth →
 * attachAdminIdentity → adminLimiter). One authentication path, not two.
 *
 * Every mutating route additionally requires a REAL staff actor, so the legacy
 * shared key can read the role matrix but cannot create a colleague, change a
 * role, reset a credential or reveal a phone number.
 */
import { Router, Response } from 'express';
import { StaffService } from '../services/staff_service';
import { StaffAuthService } from '../services/staff_auth_service';
import { ContactAccessService } from '../services/contact_access_service';
import { AuditService, AuditAction, SYSTEM_LEGACY_ADMIN } from '../services/audit_service';
import { StaffAuditEvent } from '../models/StaffAuditEvent';
import { StaffUser, StaffStatus } from '../models/StaffUser';
import { AppDataSource } from '../config/data_source';
import {
    requireStaffPermission,
    requireRealStaff,
    StaffRequest,
    auditActorOf,
} from '../middleware/staff_auth';
import { StaffPermission, roleMatrixSnapshot, isStaffRole, StaffRole } from '../config/staff_permissions';
import { errBody, ErrorCode, AppError } from '../utils/errors';
import { maskPhoneNumber } from '../services/contact_access_service';

const router = Router();

function ctxOf(req: StaffRequest) {
    return {
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        correlationId: (req as any).requestId ?? null,
    };
}

function fail(res: Response, err: any, fallback: string) {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json(errBody(err.code, err.message));
    }
    console.error('[STAFF_ADMIN]', err?.message);
    return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, fallback));
}

// ===================== Role matrix =====================

/**
 * GET /admin/staff/role-matrix
 * Read-only view of what each role can do. Not sensitive — it is the
 * authorisation model, and hiding it helps nobody.
 */
router.get('/staff/role-matrix', requireStaffPermission(StaffPermission.STAFF_READ, StaffPermission.AUDIT_READ), (_req, res) => {
    return res.json({ roles: roleMatrixSnapshot() });
});

// ===================== Staff CRUD =====================

/**
 * GET /admin/staff
 * Paged, filterable list. Phone numbers are MASKED here — a staff directory is
 * not a reason to expose every colleague's personal number on a list screen.
 */
router.get('/staff', requireStaffPermission(StaffPermission.STAFF_READ), async (req: StaffRequest, res: Response) => {
    try {
        const status = req.query.status as StaffStatus | undefined;
        const role = req.query.role as string | undefined;
        const result = await StaffService.list({
            search: (req.query.search as string) || undefined,
            status: status && Object.values(StaffStatus).includes(status) ? status : undefined,
            role: role && isStaffRole(role) ? (role as StaffRole) : undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25,
        });
        return res.json({
            ...result,
            items: result.items.map((s) => ({ ...s, phone: maskPhoneNumber(s.phone) })),
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load staff accounts.");
    }
});

/**
 * GET /admin/staff/:id
 * Detail view: roles, effective permissions, status, recent actions.
 */
router.get('/staff/:id', requireStaffPermission(StaffPermission.STAFF_READ), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.getById(String(req.params.id));
        if (!staff) return res.status(404).json(errBody(ErrorCode.NOT_FOUND, 'Staff member not found.'));

        const recent = await StaffService.recentActions(String(req.params.id), 25);
        return res.json({
            staff: { ...staff, phone: maskPhoneNumber(staff.phone) },
            recentActions: recent,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load this staff account.");
    }
});

/**
 * POST /admin/staff
 * Create an account in INVITED state and return a single-use setup token.
 *
 * The token is returned ONCE, in this response, and never again — it exists
 * only as a hash afterwards. The caller is responsible for delivering it.
 */
router.post('/staff', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_CREATE), async (req: StaffRequest, res: Response) => {
    try {
        const result = await StaffService.createStaff(
            auditActorOf(req.actor),
            {
                firstName: req.body?.firstName,
                lastName: req.body?.lastName,
                email: req.body?.email,
                phone: req.body?.phone,
                roles: req.body?.roles,
            },
            ctxOf(req),
        );
        return res.status(201).json({
            staff: result.staff,
            setupToken: result.setupToken,
            setupTokenExpiresAt: result.setupTokenExpiresAt,
            note: 'Deliver this setup link to the staff member. It is shown once and cannot be retrieved again.',
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't create this staff account.");
    }
});

/** PATCH /admin/staff/:id — name and phone only. Email is identity; roles have their own route. */
router.patch('/staff/:id', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_UPDATE), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.updateProfile(
            auditActorOf(req.actor),
            String(req.params.id),
            { firstName: req.body?.firstName, lastName: req.body?.lastName, phone: req.body?.phone },
            ctxOf(req),
        );
        return res.json({ staff });
    } catch (err: any) {
        return fail(res, err, "We couldn't update this staff account.");
    }
});

/** PUT /admin/staff/:id/roles — replace the role set. A removal requires a reason. */
router.put('/staff/:id/roles', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_ASSIGN_ROLES), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.setRoles(
            auditActorOf(req.actor),
            String(req.params.id),
            req.body?.roles,
            typeof req.body?.reason === 'string' ? req.body.reason : null,
            ctxOf(req),
        );
        return res.json({ staff });
    } catch (err: any) {
        return fail(res, err, "We couldn't update roles for this staff account.");
    }
});

/** POST /admin/staff/:id/suspend — reason mandatory. */
router.post('/staff/:id/suspend', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_SUSPEND), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.suspend(auditActorOf(req.actor), String(req.params.id), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ staff });
    } catch (err: any) {
        return fail(res, err, "We couldn't suspend this staff account.");
    }
});

/** POST /admin/staff/:id/reactivate */
router.post('/staff/:id/reactivate', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_SUSPEND), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.reactivate(auditActorOf(req.actor), String(req.params.id), ctxOf(req));
        return res.json({ staff });
    } catch (err: any) {
        return fail(res, err, "We couldn't reactivate this staff account.");
    }
});

/** POST /admin/staff/:id/deactivate — permanent. Reason mandatory. */
router.post('/staff/:id/deactivate', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_SUSPEND), async (req: StaffRequest, res: Response) => {
    try {
        const staff = await StaffService.deactivate(auditActorOf(req.actor), String(req.params.id), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ staff });
    } catch (err: any) {
        return fail(res, err, "We couldn't deactivate this staff account.");
    }
});

/**
 * POST /admin/staff/:id/reset-credentials
 * Kills every session and issues a fresh single-use setup token. Reason mandatory.
 */
router.post('/staff/:id/reset-credentials', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_RESET_CREDENTIALS), async (req: StaffRequest, res: Response) => {
    try {
        const result = await StaffService.resetCredentials(
            auditActorOf(req.actor),
            String(req.params.id),
            String(req.body?.reason ?? ''),
            ctxOf(req),
        );
        return res.json({
            staff: result.staff,
            setupToken: result.setupToken,
            setupTokenExpiresAt: result.setupTokenExpiresAt,
            note: 'All existing sessions have been ended. Deliver this reset link to the staff member.',
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't reset credentials for this staff account.");
    }
});

// ===================== Audit log =====================

/**
 * GET /admin/audit/events
 * Filterable, paged staff audit trail. Sensitive values are already redacted at
 * write time; this route adds no un-redaction path of any kind.
 */
router.get('/audit/events', requireStaffPermission(StaffPermission.AUDIT_READ), async (req: StaffRequest, res: Response) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

        const qb = AppDataSource.getRepository(StaffAuditEvent).createQueryBuilder('e');
        if (req.query.actor) qb.andWhere('e."actorStaffUserId" = :actor', { actor: req.query.actor });
        if (req.query.action) qb.andWhere('e.action = :action', { action: req.query.action });
        if (req.query.resourceType) qb.andWhere('e."resourceType" = :rt', { rt: req.query.resourceType });
        if (req.query.resourceId) qb.andWhere('e."resourceId" = :ri', { ri: req.query.resourceId });
        if (req.query.parkId) qb.andWhere('e."parkId" = :pid', { pid: req.query.parkId });
        if (req.query.outcome) qb.andWhere('e.outcome = :outcome', { outcome: req.query.outcome });
        if (req.query.from) qb.andWhere('e."createdAt" >= :from', { from: new Date(String(req.query.from)) });
        if (req.query.to) qb.andWhere('e."createdAt" <= :to', { to: new Date(String(req.query.to)) });

        qb.orderBy('e."createdAt"', 'DESC').skip((page - 1) * pageSize).take(pageSize);
        const [rows, total] = await qb.getManyAndCount();

        // Resolve actor ids to names for display, in one query.
        const staffIds = [...new Set(rows.map((r) => r.actorStaffUserId).filter((id) => id !== SYSTEM_LEGACY_ADMIN && id !== 'ANONYMOUS'))];
        const actors = staffIds.length
            ? await AppDataSource.getRepository(StaffUser).createQueryBuilder('s')
                .where('s.id IN (:...ids)', { ids: staffIds }).getMany()
            : [];
        const nameById = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));

        return res.json({
            items: rows.map((r) => ({
                ...r,
                actorName: r.actorIsLegacy
                    ? 'Legacy shared key'
                    : (nameById.get(r.actorStaffUserId) ?? r.actorStaffUserId),
            })),
            total,
            page,
            pageSize,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the audit log.");
    }
});

/**
 * GET /admin/audit/events/export
 * CSV export. A separate, rarer permission than reading: an export is a bulk
 * egress of operational data and should not ride along with day-to-day access.
 */
router.get('/audit/events/export', requireRealStaff, requireStaffPermission(StaffPermission.AUDIT_EXPORT), async (req: StaffRequest, res: Response) => {
    try {
        const limit = Math.min(10_000, Math.max(1, Number(req.query.limit) || 1000));
        const rows = await AppDataSource.getRepository(StaffAuditEvent).find({
            order: { createdAt: 'DESC' },
            take: limit,
        });

        await AuditService.recordCritical({
            actor: auditActorOf(req.actor),
            action: AuditAction.AUDIT_EXPORTED,
            resourceType: 'AUDIT_LOG',
            resourceId: null,
            reason: String(req.query.reason ?? 'operational export'),
            metadata: { rowCount: rows.length, limit },
            ...ctxOf(req),
        });

        const header = 'createdAt,actor,actorIsLegacy,action,resourceType,resourceId,outcome,parkId,rideId,reason,correlationId';
        const escape = (v: unknown) => {
            const s = v == null ? '' : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const body = rows.map((r) => [
            r.createdAt.toISOString(), r.actorStaffUserId, r.actorIsLegacy, r.action,
            r.resourceType, r.resourceId, r.outcome, r.parkId, r.rideId, r.reason, r.correlationId,
        ].map(escape).join(',')).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="staff-audit.csv"');
        return res.send(`${header}\n${body}`);
    } catch (err: any) {
        return fail(res, err, "We couldn't export the audit log.");
    }
});

// ===================== Contact reveal =====================

/**
 * POST /admin/rides/:rideId/passenger-contact
 *
 * The audited, time-boxed, reason-required way for a staff member to obtain a
 * passenger's real number. Distinct from the older
 * /live-requests/:rideId/reveal-contact route, which stays as-is for the
 * existing dashboard; new surfaces use this one.
 */
router.post('/rides/:rideId/passenger-contact', requireRealStaff, requireStaffPermission(
    StaffPermission.RIDE_REVEAL_CONTACT,
    StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT,
), async (req: StaffRequest, res: Response) => {
    try {
        const contact = await ContactAccessService.revealPassengerContactForStaff({
            rideId: String(req.params.rideId),
            actor: auditActorOf(req.actor),
            reason: String(req.body?.reason ?? ''),
            deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : null,
            ...ctxOf(req),
        });
        return res.json(contact);
    } catch (err: any) {
        return fail(res, err, "We couldn't reveal contact details.");
    }
});

/** GET /admin/rides/:rideId/passenger-contact/masked — no reveal, no audit weight. */
router.get('/rides/:rideId/passenger-contact/masked', requireStaffPermission(
    StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT,
    StaffPermission.RIDE_READ,
    StaffPermission.MONITOR_READ,
), async (req: StaffRequest, res: Response) => {
    try {
        const ride = await AppDataSource.getRepository(
            (await import('../models/Ride')).Ride,
        ).findOne({ where: { rideId: String(req.params.rideId) } });
        if (!ride) return res.status(404).json(errBody(ErrorCode.RIDE_NOT_FOUND, 'Ride not found.'));

        const masked = await ContactAccessService.maskedPassengerContact(ride.passengerId);
        return res.json(masked ?? {});
    } catch (err: any) {
        return fail(res, err, "We couldn't load contact details.");
    }
});

/** GET /admin/rides/:rideId/contact-reveals — who has seen this passenger's number. */
router.get('/rides/:rideId/contact-reveals', requireStaffPermission(StaffPermission.AUDIT_READ), async (req: StaffRequest, res: Response) => {
    try {
        return res.json({ items: await ContactAccessService.revealHistory(String(req.params.rideId)) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the reveal history.");
    }
});

// ===================== Session administration =====================

/** POST /admin/staff/:id/revoke-sessions — kick a colleague off every device. */
router.post('/staff/:id/revoke-sessions', requireRealStaff, requireStaffPermission(StaffPermission.STAFF_RESET_CREDENTIALS), async (req: StaffRequest, res: Response) => {
    try {
        const revoked = await StaffAuthService.revokeAllSessions(String(req.params.id), 'admin_revoked');
        await AuditService.recordCritical({
            actor: auditActorOf(req.actor),
            action: AuditAction.STAFF_SESSIONS_REVOKED,
            resourceType: 'STAFF_SESSION',
            resourceId: String(req.params.id),
            reason: String(req.body?.reason ?? 'administrative session revocation'),
            metadata: { revokedCount: revoked },
            ...ctxOf(req),
        });
        return res.json({ revoked });
    } catch (err: any) {
        return fail(res, err, "We couldn't revoke sessions.");
    }
});

export default router;
