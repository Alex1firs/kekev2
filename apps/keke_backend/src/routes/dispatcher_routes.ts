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
 * Phase 2 built the operational surface — shifts, roster, queue, presence.
 * Phase 3 adds the park request queue: requests direct dispatch could not fill,
 * and the four actions a dispatcher may take on one (claim, assign, skip,
 * reject, escalate). Assignment is the LAST thing a dispatcher does; from that
 * moment the ride belongs to the driver and runs through the existing lifecycle.
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
import { ParkDispatchService } from '../services/park_dispatch_service';
import { ParkAssignmentMode } from '../models/ParkDispatchJob';
import { DispatcherDashboardService } from '../services/dispatcher_dashboard_service';
import { errBody, ErrorCode, AppError } from '../utils/errors';
import { ParkDispatchSwitch } from '../services/park_dispatch_switch';
import { StaffPushService } from '../services/staff_push_service';
import { AuditService } from '../services/audit_service';
import { PushDeliveryState } from '../models/StaffPushDelivery';
import { IdempotencyService, InFlightError } from '../services/idempotency_service';
import { ParkDispatchJobRepository } from '../repositories/park_dispatch_job_repository';
import { loadParkDispatchConfig } from '../config/park_dispatch_config';

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

// ═══════════════════════════════════════════════════════════════════════
//  Push notifications
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /dispatcher/push/config
 *
 * The PUBLIC Firebase web configuration and VAPID public key.
 *
 * None of this is secret — Firebase documents these as client identifiers, and
 * they ship in every web app that uses the JS SDK. It is served from here
 * rather than committed to a file so that an unconfigured deployment says so
 * once, clearly, instead of shipping placeholders that fail inside a browser.
 *
 * Staff session required anyway: there is no reason for an anonymous caller to
 * enumerate our project identifiers.
 */
router.get('/push/config', async (req: StaffRequest, res: Response) => {
    if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

    const config = StaffPushService.webConfig();
    if (!config) {
        return res.json({
            available: false,
            missing: StaffPushService.missingConfig(),
            message: 'Push is not configured on this server. Alerts will only work while the app is open.',
        });
    }
    return res.json({ available: true, config });
});

/**
 * POST /dispatcher/push/register
 *
 * Bind this browser's push token to the signed-in dispatcher.
 *
 * Staff auth only. A passenger or driver token cannot reach this route at all —
 * they authenticate against a different middleware with a different JWT
 * audience, and `req.actor` is only ever a StaffUser.
 */
router.post('/push/register', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) {
            // The shared key has no human behind it and no device.
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'The shared admin key cannot register a device.'));
        }

        const token = String(req.body?.token ?? '');
        const deviceId = req.body?.deviceId ? String(req.body.deviceId).slice(0, 100) : null;

        /*
         * The park comes from the OPEN SHIFT, never from the request body.
         * A device that could name its own park would be a way to receive
         * another park's requests, which is the whole scoping model undone by
         * one field.
         */
        const shift = await DispatcherShiftService.current(req.actor!.staffUserId);

        const row = await StaffPushService.register({
            staffUserId: req.actor!.staffUserId,
            token,
            parkId: shift?.parkId ?? null,
            shiftId: shift?.shiftId ?? null,
            deviceId,
            deviceLabel: req.body?.deviceLabel ? String(req.body.deviceLabel).slice(0, 120) : null,
            userAgent: req.headers['user-agent'] ?? null,
        });

        return res.json({
            registered: true,
            deviceTokenId: row.id,
            parkId: row.parkId,
            boundToShift: row.shiftId != null,
            // Said plainly: a device with no shift is registered but will not
            // receive job alerts, because alerts are addressed by park.
            message: row.parkId
                ? 'This device will receive alerts for your park.'
                : 'Registered. Open a shift to start receiving alerts for a park.',
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't register this device for alerts.");
    }
});

/** POST /dispatcher/push/unregister — sign-out and device replacement. */
router.post('/push/unregister', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));
        const revoked = await StaffPushService.revoke({
            staffUserId: req.actor!.staffUserId,
            token: req.body?.token ? String(req.body.token) : undefined,
            deviceId: req.body?.deviceId ? String(req.body.deviceId) : undefined,
            reason: String(req.body?.reason ?? 'signed out'),
        });
        return res.json({ revoked });
    } catch (err: any) {
        return fail(res, err, "We couldn't remove this device.");
    }
});

/**
 * POST /dispatcher/push/ack
 *
 * The device reporting what actually happened: the service worker ran, or a
 * human opened the notification, or the request was displayed.
 *
 * This is the only evidence that distinguishes "Google accepted it" from
 * "somebody saw it", so it is worth the extra round trip.
 */
router.post('/push/ack', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

        // Only these three may be self-reported. A device cannot claim
        // "provider accepted" — that is the server's observation, not the
        // client's, and letting a client assert it would let a broken device
        // manufacture evidence that an alert was delivered.
        const ACKNOWLEDGEABLE = [
            PushDeliveryState.SERVICE_WORKER_RECEIVED,
            PushDeliveryState.NOTIFICATION_OPENED,
            PushDeliveryState.REQUEST_VIEWED,
        ] as const;
        type Ackable = typeof ACKNOWLEDGEABLE[number];

        const raw = String(req.body?.state ?? '');
        const state = ACKNOWLEDGEABLE.find((s) => s === raw) as Ackable | undefined;
        if (!state) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, 'Unknown acknowledgement state.'));
        }

        await StaffPushService.acknowledge({
            staffUserId: req.actor!.staffUserId,
            jobId: req.body?.jobId ? String(req.body.jobId) : null,
            token: req.body?.token ? String(req.body.token) : null,
            state,
        });
        return res.json({ recorded: true });
    } catch (err: any) {
        return fail(res, err, "We couldn't record that acknowledgement.");
    }
});

/** POST /dispatcher/push/test — a real push to one of your own devices. */
router.post('/push/test', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));
        const result = await StaffPushService.sendTest(
            req.actor!.staffUserId, String(req.body?.deviceTokenId ?? ''));
        return res.json(result);
    } catch (err: any) {
        return fail(res, err, "We couldn't send a test alert.");
    }
});

/**
 * GET /dispatcher/push/status
 *
 * Everything the setup and diagnostics screen shows, and the thing that decides
 * whether a shift may start.
 */
router.get('/push/status', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

        const staffUserId = req.actor!.staffUserId;
        const [devices, recent, shift] = await Promise.all([
            StaffPushService.activeForStaff(staffUserId),
            StaffPushService.recentFor(staffUserId, 10),
            DispatcherShiftService.current(staffUserId),
        ]);

        const configured = StaffPushService.webConfig() != null;
        const lastAccepted = devices.map((d) => d.lastPushAcceptedAt).filter(Boolean).sort().pop() ?? null;
        const lastReceived = devices.map((d) => d.lastPushReceivedAt).filter(Boolean).sort().pop() ?? null;
        const lastOpened = devices.map((d) => d.lastNotificationOpenedAt).filter(Boolean).sort().pop() ?? null;

        return res.json({
            pushConfigured: configured,
            missingConfig: configured ? [] : StaffPushService.missingConfig(),
            devices: devices.map((d) => ({
                id: d.id,
                deviceLabel: d.deviceLabel,
                deviceId: d.deviceId,
                platform: d.platform,
                parkId: d.parkId,
                boundToShift: d.shiftId != null,
                lastSeenAt: d.lastSeenAt,
                lastPushAcceptedAt: d.lastPushAcceptedAt,
                lastPushReceivedAt: d.lastPushReceivedAt,
                lastNotificationOpenedAt: d.lastNotificationOpenedAt,
                tokenRef: d.token.length > 12 ? `…${d.token.slice(-12)}` : d.token,
            })),
            shift: shift ? { shiftId: shift.shiftId, parkId: shift.parkId } : null,
            lastPushAcceptedAt: lastAccepted,
            lastPushReceivedAt: lastReceived,
            lastNotificationOpenedAt: lastOpened,
            recent: recent.map((r) => ({
                state: r.state, reason: r.reason, jobId: r.jobId,
                providerRef: r.providerRef, createdAt: r.createdAt,
                receivedAt: r.receivedAt, openedAt: r.openedAt,
            })),
            /*
             * Whether a shift may start silently. The client blocks on this and
             * a supervisor override is the only way past it — see
             * POST /dispatcher/shifts/open.
             */
            readyForShift: configured && devices.length > 0,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't check your alert setup.");
    }
});

/**
 * GET /dispatcher/switch-state
 *
 * Is Park Dispatch accepting new work? Read-only, and deliberately available to
 * any staff session — a dispatcher checking before a shift needs the answer,
 * and it reveals nothing beyond what an empty queue already implies.
 *
 * Distinct from the admin endpoint of the same name: this one cannot change
 * anything and does not report which environment variable is responsible.
 */
router.get('/switch-state', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));
        const override = await ParkDispatchSwitch.state();
        const envEnabled = loadParkDispatchConfig().enabled;
        return res.json({
            accepting: envEnabled && !override.disabled,
            reason: override.disabled ? (override.reason ?? 'paused by operations') : null,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't check whether Park Dispatch is running.");
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

        /*
         * Bind this dispatcher's devices to the park they just opened at.
         *
         * Push is addressed by PARK, so a device registered before a shift has
         * no park and receives nothing. This is the moment it gains one.
         */
        await StaffPushService.bindToShift(req.actor!.staffUserId, shift.parkId, shift.shiftId)
            .catch(() => { /* the shift stands regardless */ });

        /*
         * A shift started without working background alerts is recorded as
         * such. Nobody is stopped — a dispatcher who will keep the app open is
         * still better than an unstaffed park — but operations can see which
         * shifts ran with a dispatcher reachable only while looking at a
         * screen, which is exactly the sort of thing that explains a missed
         * request three days later.
         */
        if (req.body?.pushUnavailableAcknowledged === true) {
            await AuditService.record({
                actor: auditActorOf(req.actor),
                action: 'SHIFT_OPENED_WITHOUT_PUSH',
                resourceType: 'DISPATCHER_SHIFT',
                resourceId: shift.shiftId,
                parkId: shift.parkId,
                reason: 'dispatcher acknowledged background alerts are unavailable',
                ...ctxOf(req),
            }).catch(() => { /* never block a shift on an audit write */ });
        }

        return res.status(201).json({ shift });
    } catch (err: any) {
        return fail(res, err, "We couldn't start your shift.");
    }
});

/**
 * GET /dispatcher/shifts/summary
 *
 * What this shift did and what it is about to leave behind — shown BEFORE
 * signing off, so the consequences are visible while they can still be acted
 * on.
 */
router.get('/shifts/summary', async (req: StaffRequest, res: Response) => {
    try {
        if (req.actor?.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));
        return res.json({ summary: await DispatcherShiftService.summary(req.actor!.staffUserId) });
    } catch (err: any) {
        return fail(res, err, "We couldn't summarise your shift.");
    }
});

/**
 * POST /dispatcher/shifts/close
 *
 * Refuses while the dispatcher still holds live requests, unless they write a
 * handover note. See DispatcherShiftService.close.
 */
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

        return res.json(await DispatcherDashboardService.build(parkId, actor.staffUserId));
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

// ═══════════════════════════════════════════════════════════════════════
//  Park Dispatch queue  (Phase 3)
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /dispatcher/requests
 *
 * The queue of ride requests direct dispatch could not fill, for the park this
 * dispatcher is on duty at. Each card carries everything the brief specifies:
 * pickup, destination, passenger name, estimated fare, time waiting, priority
 * and how many parks have already been tried.
 *
 * Passenger contact is MASKED. A dispatcher sourcing a driver has no need to
 * phone a passenger who never asked to hear from them; a supervisor can reveal
 * it deliberately, and that reveal is audited and expires.
 */
router.get('/requests', async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const queue = await ParkDispatchService.queueForPark(shift.parkId);
        return res.json({
            parkId: shift.parkId,
            requests: queue,
            total: queue.length,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load park requests.");
    }
});

/**
 * GET /dispatcher/requests/:jobId/drivers
 *
 * Every roster driver, RANKED for this specific ride, best first, each with
 * badges and one honest line of reasoning.
 *
 * Unassignable drivers are included rather than hidden: a dispatcher who cannot
 * see somebody wonders where they went and re-asks the queue. Showing them with
 * "Owes ₦2,400" answers the question before it is asked.
 */
router.get('/requests/:jobId/drivers', async (req: StaffRequest, res: Response) => {
    try {
        const shift = await requireOpenShift(req);
        const jobId = String(req.params.jobId);
        const drivers = await ParkDispatchService.rankedDriversForJob(jobId, shift.parkId);
        return res.json({
            parkId: shift.parkId,
            jobId,
            drivers,
            total: drivers.length,
            assignableCount: drivers.filter((d) => d.assignable).length,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load drivers for this request.");
    }
});

/*
 * There is deliberately NO contact-reveal endpoint here.
 *
 * One was added in Phase 5 and it could never have worked: it required an open
 * dispatcher shift AND `monitor:reveal_contact`, and no role holds both.
 * `monitor:reveal_contact` belongs to SUPER_ADMIN and SUPPORT_OFFICER, neither
 * of whom opens a shift at a park. Every call would have returned 403 — an
 * endpoint that looks like a way out of a problem and never is.
 *
 * Revealing a passenger's number is a support action, and the route for it
 * already exists: POST /admin/live-requests/:rideId/reveal-contact, gated on
 * the same permission, audited, with no shift requirement. A dispatcher who
 * genuinely needs a number escalates the request; support makes the call.
 *
 * That the park cannot self-serve here is the Phase 1 privacy posture working
 * as designed, not a gap.
 */

/** POST /dispatcher/requests/:jobId/claim — take responsibility for sourcing a driver. */
router.post('/requests/:jobId/claim', requireStaffPermission(StaffPermission.DISPATCH_CLAIM), async (req: StaffRequest, res: Response) => {
    try {
        const card = await ParkDispatchService.claim(auditActorOf(req.actor), String(req.params.jobId), ctxOf(req));
        return res.json({ request: card });
    } catch (err: any) {
        return fail(res, err, "We couldn't take this request.");
    }
});

/**
 * POST /dispatcher/requests/:jobId/assign
 *
 * The dispatcher's LAST act on this ride. After this the ride is `accepted`,
 * owned by the driver, and every later transition runs through the existing
 * lifecycle handlers exactly as for a ride a smartphone driver accepted.
 *
 * `mode`:
 *   electronic — smartphone driver; the assignment appears in their app.
 *   verbal     — feature-phone driver; the dispatcher read the trip details out
 *                and is recording that they did. The DRIVER still owns the ride.
 */
router.post('/requests/:jobId/assign', requireStaffPermission(StaffPermission.DISPATCH_ASSIGN_DRIVER), async (req: StaffRequest, res: Response) => {
    try {
        const rawMode = String(req.body?.mode ?? ParkAssignmentMode.ELECTRONIC);
        if (!Object.values(ParkAssignmentMode).includes(rawMode as ParkAssignmentMode)) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, 'mode must be "electronic" or "verbal".'));
        }
        /*
         * Idempotent by key. A tablet that loses the reply and retries gets the
         * ORIGINAL outcome back, not a second assignment and not a spurious
         * "already assigned" error. The atomic arbiter still decides who gets
         * the ride; this only stops it being asked twice.
         */
        const { replayed, value: result } = await IdempotencyService.run(
            'park_assign',
            req.actor!.staffUserId,
            typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null,
            () => ParkDispatchService.assignDriver(
                auditActorOf(req.actor),
                String(req.params.jobId),
                String(req.body?.driverId ?? ''),
                rawMode as ParkAssignmentMode,
                ctxOf(req),
            ),
        );

        return res.json({
            ...result,
            replayed,
            message: 'Driver assigned. The ride now belongs to the driver — nothing further is needed from you.',
        });
    } catch (err: any) {
        if (err instanceof InFlightError) {
            // 409, not 500: nothing is wrong, the first tap is still working.
            return res.status(409).json(errBody(ErrorCode.RIDE_ALREADY_TAKEN,
                'That assignment is already going through. Give it a moment.'));
        }
        return fail(res, err, "We couldn't assign this driver.");
    }
});

/** POST /dispatcher/requests/:jobId/skip — no driver here for this one. */
router.post('/requests/:jobId/skip', requireStaffPermission(StaffPermission.DISPATCH_RELEASE), async (req: StaffRequest, res: Response) => {
    try {
        await ParkDispatchService.skip(auditActorOf(req.actor), String(req.params.jobId), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ message: 'Request skipped.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't skip this request.");
    }
});

/** POST /dispatcher/requests/:jobId/reject — decline outright, with a reason. */
router.post('/requests/:jobId/reject', requireStaffPermission(StaffPermission.DISPATCH_RELEASE), async (req: StaffRequest, res: Response) => {
    try {
        await ParkDispatchService.reject(auditActorOf(req.actor), String(req.params.jobId), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ message: 'Request rejected.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't reject this request.");
    }
});

/**
 * POST /dispatcher/requests/:jobId/escalate
 * Hands the request to a human. Deliberately NOT a cancellation — the ride keeps
 * searching and the existing coordination flow continues to own it.
 */
router.post('/requests/:jobId/escalate', requireStaffPermission(StaffPermission.DISPATCH_REPORT_ISSUE), async (req: StaffRequest, res: Response) => {
    try {
        await ParkDispatchService.escalate(auditActorOf(req.actor), String(req.params.jobId), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ message: 'Escalated to support. The ride keeps searching.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't escalate this request.");
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
