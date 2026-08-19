/**
 * Operations Dispatch API.
 *
 * Every route requires a real staff session — no shared key reaches any of
 * this. Reading the queue needs `ops:queue_read`; each intervention needs its
 * own permission, because taking control, ringing a driver and assigning one
 * are three different powers.
 *
 * The frontend is never the security boundary. Ownership of a takeover, the
 * liveness of a lease and a driver's eligibility are all re-derived here on
 * every request, and the ride row arbitrates the only thing that really
 * matters.
 */
import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
    resolveActor,
    requireStaffAuth,
    requireRealStaff,
    requireStaffPermission,
    StaffRequest,
    auditActorOf,
} from '../middleware/staff_auth';
import { StaffPermission } from '../config/staff_permissions';
import { OperationsQueueService } from '../services/operations_queue_service';
import { OperationsDriverDiscovery, DriverCategory } from '../services/operations_driver_discovery';
import { RideControlService, ControlActor } from '../services/ride_control_service';
import { OperationsDispatchService } from '../services/operations_dispatch_service';
import { OperationsAuditService } from '../services/operations_audit_service';
import { OperationsNotificationService } from '../services/operations_notification_service';
import { ControlReleaseReason } from '../models/RideDispatchControl';
import { InterventionReason } from '../models/OperationsIntervention';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';
import { AuditService } from '../services/audit_service';
import { errBody, ErrorCode, ErrorCodeType } from '../utils/errors';

const router = Router();

router.use(resolveActor);
router.use(requireStaffAuth);
// Nothing here is available to the shared admin key. Seizing a live ride must
// be attributable to a person, for the same reason revealing a contact is.
router.use(requireRealStaff);

/**
 * Intervention endpoints are rate limited per staff member, not per IP: a
 * dispatcher on a park's shared wifi must not be throttled by a colleague.
 */
const interventionLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.actor?.staffUserId ?? ipKeyGenerator(req),
});

/** The acting dispatcher, as the control service understands them. */
function actorOf(req: StaffRequest): ControlActor {
    return {
        staffUserId: req.actor!.staffUserId,
        label: (req.actor as any)?.displayName
            ?? (req.actor as any)?.email
            ?? req.actor!.staffUserId,
    };
}

const fail = (res: Response, status: number, code: ErrorCodeType, message: string) =>
    res.status(status).json(errBody(code, message));

// ── Queue ───────────────────────────────────────────────────────────────

/** GET /operations/queue — the live queue with attention state. */
router.get('/queue', requireStaffPermission(StaffPermission.OPS_QUEUE_READ), async (req: StaffRequest, res: Response) => {
    try {
        const data = await OperationsQueueService.liveQueue({
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            includeRecentMinutes: req.query.recentMinutes ? Number(req.query.recentMinutes) : undefined,
        });
        res.json({ ...data, config: loadOperationsDispatchConfig() });
    } catch (err: any) {
        console.error('[OPS] queue error:', err?.message);
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not load the queue.');
    }
});

/** GET /operations/rides/:rideId/drivers — candidates for one ride. */
router.get('/rides/:rideId/drivers', requireStaffPermission(StaffPermission.OPS_QUEUE_READ), async (req: StaffRequest, res: Response) => {
    try {
        const data = await OperationsDriverDiscovery.forRide(String(req.params.rideId), {
            category: (req.query.category as DriverCategory) || 'ALL',
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(data);
    } catch (err: any) {
        console.error('[OPS] driver discovery error:', err?.message);
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not load drivers.');
    }
});

/** GET /operations/rides/:rideId/interventions — this ride's human history. */
router.get('/rides/:rideId/interventions', requireStaffPermission(StaffPermission.OPS_QUEUE_READ), async (req: StaffRequest, res: Response) => {
    try {
        res.json({ interventions: await OperationsAuditService.forRide(String(req.params.rideId)) });
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not load intervention history.');
    }
});

// ── Control ─────────────────────────────────────────────────────────────

/** POST /operations/rides/:rideId/takeover */
router.post('/rides/:rideId/takeover', interventionLimiter, requireStaffPermission(StaffPermission.OPS_TAKEOVER), async (req: StaffRequest, res: Response) => {
    try {
        const rideId = String(req.params.rideId);
        const result = await RideControlService.takeover(rideId, actorOf(req));
        if (!result.ok) {
            // 409, not 403: losing a takeover race is a conflict, and the UI
            // needs to tell those two apart to show the right message.
            return res.status(result.code === 'DISABLED' ? 503 : 409)
                .json({ code: result.code, message: result.message, control: result.control ?? null });
        }
        await AuditService.record({
            actor: auditActorOf(req.actor!),
            action: 'OPS_TAKEOVER_CLAIMED' as any,
            resourceType: 'RIDE',
            resourceId: rideId,
            rideId,
            ipAddress: req.ip ?? null,
        }).catch(() => {});
        res.json({ ok: true, control: result.control, idempotent: result.idempotent });
    } catch (err: any) {
        console.error('[OPS] takeover error:', err?.message);
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not take control.');
    }
});

/** POST /operations/rides/:rideId/renew — extend the lease. */
router.post('/rides/:rideId/renew', interventionLimiter, requireStaffPermission(StaffPermission.OPS_TAKEOVER), async (req: StaffRequest, res: Response) => {
    try {
        const result = await RideControlService.renew(String(req.params.rideId), actorOf(req));
        if (!result.ok) {
            return res.status(409).json({ code: result.code, message: result.message, control: result.control ?? null });
        }
        res.json({ ok: true, control: result.control });
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not renew control.');
    }
});

/** POST /operations/rides/:rideId/release — hand back to automatic dispatch. */
router.post('/rides/:rideId/release', interventionLimiter, requireStaffPermission(StaffPermission.OPS_RELEASE), async (req: StaffRequest, res: Response) => {
    try {
        const rideId = String(req.params.rideId);
        const expectedVersion = req.body?.version != null ? Number(req.body.version) : undefined;
        const result = await RideControlService.release(
            rideId, actorOf(req), ControlReleaseReason.EXPLICIT, { expectedVersion },
        );
        if (!result.ok) {
            return res.status(409).json({ code: result.code, message: result.message, control: result.control ?? null });
        }
        await AuditService.record({
            actor: auditActorOf(req.actor!),
            action: 'OPS_TAKEOVER_RELEASED' as any,
            resourceType: 'RIDE', resourceId: rideId, rideId,
            ipAddress: req.ip ?? null,
        }).catch(() => {});
        res.json({ ok: true, control: result.control });
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not release control.');
    }
});

// ── Intervention ────────────────────────────────────────────────────────

/** POST /operations/rides/:rideId/assign — manual assignment. */
router.post('/rides/:rideId/assign', interventionLimiter, requireStaffPermission(StaffPermission.OPS_ASSIGN), async (req: StaffRequest, res: Response) => {
    try {
        const rideId = String(req.params.rideId);
        const driverId = String(req.body?.driverId ?? '');
        if (!driverId) return fail(res, 400, ErrorCode.VALIDATION_ERROR, 'driverId is required.');

        const reason = Object.values(InterventionReason).includes(req.body?.reason)
            ? (req.body.reason as InterventionReason)
            : InterventionReason.OPERATIONS_INTERVENTION;

        const result = await OperationsDispatchService.assign(rideId, driverId, actorOf(req), reason);
        if (!result.ok) {
            // RIDE_ALREADY_TAKEN is a 409: a driver won the race, which is a
            // correct outcome the UI must render as "someone got there first"
            // rather than as an error.
            const status =
                result.code === 'RIDE_ALREADY_TAKEN' || result.code === 'RIDE_NOT_ASSIGNABLE' ? 409
                : result.code === 'NOT_CONTROLLER' ? 403
                : result.code === 'DISABLED' ? 503
                : 400;
            return res.status(status).json({
                code: result.code,
                message: result.message,
                eligibilityReason: (result as any).eligibilityReason ?? null,
            });
        }
        await AuditService.record({
            actor: auditActorOf(req.actor!),
            action: 'OPS_DRIVER_ASSIGNED' as any,
            resourceType: 'RIDE', resourceId: rideId, rideId,
            metadata: { driverId },
            ipAddress: req.ip ?? null,
        }).catch(() => {});
        res.json({ ok: true, rideId, driverId });
    } catch (err: any) {
        console.error('[OPS] assign error:', err?.message);
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not assign the driver.');
    }
});

/**
 * POST /operations/rides/:rideId/contact-driver
 * Records that a dispatcher rang a driver. Changes nothing about the ride.
 */
router.post('/rides/:rideId/contact-driver', interventionLimiter, requireStaffPermission(StaffPermission.OPS_CONTACT_DRIVER), async (req: StaffRequest, res: Response) => {
    try {
        const rideId = String(req.params.rideId);
        const driverId = String(req.body?.driverId ?? '');
        if (!driverId) return fail(res, 400, ErrorCode.VALIDATION_ERROR, 'driverId is required.');

        await OperationsDispatchService.recordDriverContacted(rideId, driverId, actorOf(req), {
            presence: req.body?.presence,
            distanceKm: req.body?.distanceKm ?? null,
            lastSeenSeconds: req.body?.lastSeenSeconds ?? null,
        });
        res.json({ ok: true });
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not record the call.');
    }
});

/** POST /operations/drivers/:driverId/favourite — ranking only, never a bypass. */
router.post('/drivers/:driverId/favourite', interventionLimiter, requireStaffPermission(StaffPermission.OPS_QUEUE_READ), async (req: StaffRequest, res: Response) => {
    try {
        await OperationsDriverDiscovery.setFavourite(String(req.params.driverId), req.body?.favourite === true);
        res.json({ ok: true });
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not update favourites.');
    }
});

// ── Notification policy ─────────────────────────────────────────────────

router.get('/notification-policy', requireStaffPermission(StaffPermission.OPS_QUEUE_READ), async (_req: StaffRequest, res: Response) => {
    res.json(await OperationsNotificationService.policy());
});

/** Changing who gets rung is an administrative act, not a dispatcher one. */
router.put('/notification-policy', requireStaffPermission(StaffPermission.ADMIN_WRITE), async (req: StaffRequest, res: Response) => {
    try {
        await OperationsNotificationService.setPolicy(req.body);
        await AuditService.record({
            actor: auditActorOf(req.actor!),
            action: 'OPS_NOTIFICATION_POLICY_UPDATED' as any,
            resourceType: 'SETTING', resourceId: 'operations_notification_policy',
            metadata: { triggers: req.body?.triggers },
            ipAddress: req.ip ?? null,
        }).catch(() => {});
        res.json(await OperationsNotificationService.policy());
    } catch (err: any) {
        fail(res, 500, ErrorCode.INTERNAL_ERROR, 'Could not update the policy.');
    }
});

export default router;
