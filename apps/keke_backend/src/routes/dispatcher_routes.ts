/**
 * Dispatcher-facing API — /api/v1/dispatcher/*
 *
 * The surface a park dispatcher's device talks to. Everything here requires a
 * real staff session, an appropriate permission, and — for anything park-bound
 * — an OPEN SHIFT at that park.
 *
 * ── What a dispatcher cannot do ─────────────────────────────────────────
 * There is no endpoint on this router that marks a ride arrived, started or
 * completed, and none that touches a wallet. That is not an oversight and not a
 * permission setting: no such capability exists anywhere in the catalogue. A
 * dispatcher receives requests, assigns a driver and monitors the assignment.
 * After assignment the ride belongs to the driver, exactly as it does today.
 *
 * Phase 2 provides the operational surface only — shifts, roster, queue,
 * presence. Receiving park requests and assigning a driver arrive in Phase 4;
 * nothing here touches dispatch.
 */
import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { resolveActor, requireStaffAuth, requireRealStaff, requireStaffPermission, StaffRequest, auditActorOf } from '../middleware/staff_auth';
import { staffMayActAtPark } from '../middleware/park_scope';
import { StaffPermission } from '../config/staff_permissions';
import { DispatcherShiftService } from '../services/dispatcher_shift_service';
import { ParkRosterService } from '../services/park_roster_service';
import { DriverPresenceService } from '../services/driver_presence_service';
import { ParkService } from '../services/park_service';
import { ParkRepository } from '../repositories/park_repository';
import { DriverPresenceState, PresenceSource } from '../models/DriverPresence';
import { errBody, ErrorCode, AppError } from '../utils/errors';

const router = Router();

router.use(resolveActor);
router.use(requireStaffAuth);
// The legacy shared key has no place on a dispatcher device: its actions are
// unattributable, and every action here needs to name a person.
router.use(requireRealStaff);

/**
 * Park devices sit on sponsored mobile data and poll the dashboard. The limit
 * is generous enough for a 5-second refresh and low enough to notice a runaway
 * client.
 */
const dispatcherLimiter = rateLimit({
    windowMs: Number(process.env.DISPATCHER_RATE_WINDOW_MS) || 60_000,
    max: Number(process.env.DISPATCHER_RATE_LIMIT_MAX) || 240,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => req.actor?.staffUserId ?? ipKeyGenerator(req.ip),
    message: { code: ErrorCode.RATE_LIMITED, message: 'Slow down a moment and try again.' },
});
router.use(dispatcherLimiter);

function ctxOf(req: StaffRequest) {
    return {
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        correlationId: (req as any).requestId ?? null,
    };
}

function fail(res: Response, err: any, fallback: string) {
    if (err instanceof AppError) return res.status(err.statusCode).json(errBody(err.code, err.message));
    console.error('[DISPATCHER]', err?.message);
    return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, fallback));
}

/**
 * Resolve the caller's open shift, or refuse.
 *
 * This is the gate that makes "on duty" mean something. A dispatcher with the
 * role but no open shift can read the dashboard; they cannot record anything.
 */
async function requireOpenShift(req: StaffRequest) {
    const actor = req.actor!;
    if (actor.isLegacy) throw new AppError(403, ErrorCode.FORBIDDEN, 'Not a staff session.');
    const shift = await DispatcherShiftService.current(actor.staffUserId);
    if (!shift) {
        throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'You have no open shift. Start your shift first.');
    }
    return shift;
}

// ═══════════════════════════════════════════════════════════════════════
//  Shift
// ═══════════════════════════════════════════════════════════════════════

/** GET /dispatcher/me — who am I, where am I assigned, am I on duty. */
router.get('/me', async (req: StaffRequest, res: Response) => {
    try {
        const actor = req.actor!;
        if (actor.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

        const shift = await DispatcherShiftService.current(actor.staffUserId);

        // Every park this dispatcher may work at, so their device can offer a
        // choice rather than requiring them to know a uuid.
        const { staffParkScope } = await import('../middleware/park_scope');
        const scope = await staffParkScope(actor.staffUserId);
        const parks = scope === '*'
            ? (await ParkRepository.findDispatchable()).map((p) => ({ parkId: p.parkId, name: p.name, code: p.code, status: p.status }))
            : await Promise.all([...scope].map(async (parkId) => {
                const park = await ParkRepository.findById(parkId);
                return park ? { parkId: park.parkId, name: park.name, code: park.code, status: park.status } : null;
            })).then((list) => list.filter(Boolean));

        return res.json({
            staffUserId: actor.staffUserId,
            name: `${actor.firstName} ${actor.lastName}`,
            roles: actor.roles,
            permissions: [...actor.permissions].sort(),
            currentShift: shift,
            onDuty: shift != null,
            assignedParks: parks,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load your dispatcher profile.");
    }
});

/** POST /dispatcher/shifts/open */
router.post('/shifts/open', requireStaffPermission(StaffPermission.SHIFT_OPEN), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await DispatcherShiftService.open(auditActorOf(req.actor), {
            parkId: String(req.body?.parkId ?? ''),
            lat: req.body?.lat != null ? Number(req.body.lat) : null,
            lng: req.body?.lng != null ? Number(req.body.lng) : null,
            deviceId: req.body?.deviceId ?? null,
        }, ctxOf(req));
        return res.status(201).json({ shift });
    } catch (err: any) {
        return fail(res, err, "We couldn't start your shift.");
    }
});

/** POST /dispatcher/shifts/close */
router.post('/shifts/close', requireStaffPermission(StaffPermission.SHIFT_OPEN), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await DispatcherShiftService.close(auditActorOf(req.actor), {
            handoverNotes: req.body?.handoverNotes ?? null,
        }, ctxOf(req));
        return res.json({ shift });
    } catch (err: any) {
        return fail(res, err, "We couldn't close your shift.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Dashboard
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /dispatcher/dashboard
 *
 * Everything a dispatcher device renders in one round trip: the park, live
 * counts, the queue with per-driver assignability, everyone present, and who
 * else is on duty. One call because the device is on metered mobile data and
 * five calls to paint one screen is a real cost, not a theoretical one.
 */
router.get('/dashboard', async (req: StaffRequest, res: Response) => {
    try {
        const actor = req.actor!;
        if (actor.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

        // A park may be named explicitly (a supervisor looking at one of
        // several) or implied by the caller's open shift.
        const explicit = (req.query.parkId as string | undefined)?.trim();
        const shift = await DispatcherShiftService.current(actor.staffUserId);
        const parkId = explicit || shift?.parkId;

        if (!parkId) {
            return res.status(409).json(errBody(ErrorCode.VALIDATION_ERROR,
                'No park selected and no open shift. Start a shift or name a park.'));
        }
        if (!(await staffMayActAtPark(actor.staffUserId, parkId))) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'You are not assigned to this park.'));
        }

        const park = await ParkService.requirePark(parkId);
        const [counts, queue, presence, onDuty, stale] = await Promise.all([
            ParkRepository.counts(park),
            ParkRosterService.queue(parkId),
            DriverPresenceService.atPark(parkId),
            DispatcherShiftService.onDuty(parkId),
            DriverPresenceService.stale(parkId, 180),
        ]);

        return res.json({
            park: ParkService.toDto(park, { counts }),
            onDuty,
            myShift: shift,
            queue,
            presence,
            staleWarnings: stale,
            /**
             * Stated in the payload, not only in documentation. A dispatcher
             * client should have no code path that expects to advance a ride.
             */
            capabilities: {
                canAssignRides: false,
                reason: 'Park request assignment arrives in a later phase. A dispatcher never advances a ride lifecycle.',
            },
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the dashboard.");
    }
});

/** GET /dispatcher/roster — the full roster for the caller's park. */
router.get('/roster', async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const roster = await ParkRosterService.view(shift.parkId, {
            search: (req.query.search as string) || undefined,
        });
        return res.json({ parkId: shift.parkId, roster, total: roster.length });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the roster.");
    }
});

/** GET /dispatcher/queue */
router.get('/queue', async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        return res.json({ parkId: shift.parkId, queue: await ParkRosterService.queue(shift.parkId) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the queue.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Queue and presence management
// ═══════════════════════════════════════════════════════════════════════

router.post('/queue/join', requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const result = await ParkRosterService.joinQueue(
            auditActorOf(req.actor), shift.parkId, String(req.body?.driverId ?? ''), ctxOf(req),
        );
        return res.json(result);
    } catch (err: any) {
        return fail(res, err, "We couldn't add this driver to the queue.");
    }
});

router.post('/queue/leave', requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        await ParkRosterService.leaveQueue(
            auditActorOf(req.actor), shift.parkId, String(req.body?.driverId ?? ''),
            req.body?.reason ?? null, ctxOf(req),
        );
        return res.json({ message: 'Driver removed from the queue.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't remove this driver from the queue.");
    }
});

/**
 * POST /dispatcher/queue/skip
 * Records that a driver was passed over, with a reason. The reason is what
 * makes queue fairness measurable rather than a matter of opinion.
 */
router.post('/queue/skip', requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        await ParkRosterService.recordSkip(
            auditActorOf(req.actor), shift.parkId, String(req.body?.driverId ?? ''),
            String(req.body?.reason ?? ''), ctxOf(req),
        );
        return res.json({ message: 'Skip recorded.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't record the skip.");
    }
});

router.post('/queue/reorder', requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const order = Array.isArray(req.body?.orderedRosterIds) ? req.body.orderedRosterIds.map(String) : [];
        await ParkRosterService.reorderQueue(
            auditActorOf(req.actor), shift.parkId, order, String(req.body?.reason ?? ''), ctxOf(req),
        );
        return res.json({ message: 'Queue reordered.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't reorder the queue.");
    }
});

/**
 * POST /dispatcher/presence
 *
 * A dispatcher recording what a driver is doing — the mechanism that makes a
 * feature-phone driver visible to the system at all. They have no app to report
 * for themselves, so a human at the park does it, and it is attributed to that
 * human.
 */
router.post('/presence', requireStaffPermission(StaffPermission.PRESENCE_WRITE), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const state = req.body?.state as DriverPresenceState;

        const result = await DriverPresenceService.setState({
            driverId: String(req.body?.driverId ?? ''),
            state,
            parkId: shift.parkId,
            rideId: req.body?.rideId ?? null,
            note: req.body?.note ?? null,
            source: PresenceSource.DISPATCHER,
            setByStaffId: req.actor!.isLegacy ? null : req.actor!.staffUserId,
            force: false,
            reason: req.body?.reason ?? null,
        }, { actor: auditActorOf(req.actor), ipAddress: req.ip ?? null, correlationId: (req as any).requestId ?? null });

        return res.json(result);
    } catch (err: any) {
        return fail(res, err, "We couldn't update presence.");
    }
});

/** GET /dispatcher/presence/:driverId — one driver's state and recent history. */
router.get('/presence/:driverId', requireStaffPermission(StaffPermission.PRESENCE_READ), async (req: StaffRequest, res: Response) => {
    try {
        const driverId = String(req.params.driverId);
        const presence = await DriverPresenceService.get(driverId);
        return res.json({
            presence,
            allowedNextStates: DriverPresenceService.allowedNextStates(presence.state),
            history: await DriverPresenceService.history(driverId, 20),
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load presence.");
    }
});

export default router;
