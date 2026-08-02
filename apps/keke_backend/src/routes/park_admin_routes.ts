/**
 * Park administration, mounted inside the admin router.
 *
 * Inherits the whole Phase 1 auth chain (adminAuth → resolveActor →
 * requireStaffAuth → attachAdminIdentity → adminLimiter). Every mutating route
 * additionally requires a REAL staff actor, so the legacy shared key — which is
 * barred from every park permission anyway — cannot reach any of it.
 *
 * Note what is absent: there is no endpoint here that advances a ride. Park
 * staff configure parks, manage rosters and record presence. The ride lifecycle
 * belongs to the driver, exactly as it does today.
 */
import { Router, Response } from 'express';
import { ParkService } from '../services/park_service';
import { OperationsOverviewService } from '../services/operations_overview_service';
import { ParkRosterService } from '../services/park_roster_service';
import { DispatcherShiftService } from '../services/dispatcher_shift_service';
import { DriverPresenceService } from '../services/driver_presence_service';
import { BadgeService } from '../services/badge_service';
import { ParkRepository } from '../repositories/park_repository';
import { DriverBadgeRepository } from '../repositories/driver_badge_repository';
import { ParkDispatchJobRepository, LIVE_JOB_STATUSES } from '../repositories/park_dispatch_job_repository';
import { ParkJobStatus } from '../models/ParkDispatchJob';
import { loadParkDispatchConfig } from '../config/park_dispatch_config';
import { DispatcherDashboardService } from '../services/dispatcher_dashboard_service';
import { ParkDispatchSwitch } from '../services/park_dispatch_switch';
import { AuditService } from '../services/audit_service';
import { requireStaffPermission, requireRealStaff, StaffRequest, auditActorOf } from '../middleware/staff_auth';
import { requireParkScope, staffParkScope } from '../middleware/park_scope';
import { StaffPermission } from '../config/staff_permissions';
import { ParkStatus } from '../models/Park';
import { RosterStatus } from '../models/ParkDriverRoster';
import { BadgeStatus } from '../models/DriverBadge';
import { DriverPresenceState, PresenceSource } from '../models/DriverPresence';
import { errBody, ErrorCode, AppError } from '../utils/errors';
import { AppDataSource } from '../config/data_source';
import { StaffUser } from '../models/StaffUser';

const router = Router();

function ctxOf(req: StaffRequest) {
    return {
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        correlationId: (req as any).requestId ?? null,
    };
}

function fail(res: Response, err: any, fallback: string) {
    if (err instanceof AppError) return res.status(err.statusCode).json(errBody(err.code, err.message));
    console.error('[PARK_ADMIN]', err?.message);
    return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, fallback));
}

// ═══════════════════════════════════════════════════════════════════════
//  Operations overview
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /admin/operations/overview
 *
 * Every park, what it is doing, and — where it cannot dispatch — the reason.
 *
 * Deliberately NOT park-scoped: this is the screen an operations admin opens to
 * find the park that is failing, and a list filtered to parks they were already
 * thinking about would defeat the purpose. It is read-only and exposes no
 * passenger or driver identity, only counts and reasons.
 */
router.get('/operations/overview', requireStaffPermission(StaffPermission.PARK_VIEW_METRICS), async (_req: StaffRequest, res: Response) => {
    try {
        return res.json(await OperationsOverviewService.build());
    } catch (err: any) {
        return fail(res, err, "We couldn't load the operations overview.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Parks
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /admin/parks
 * Paged list with live counts. Filtered to the caller's park scope, so a park
 * supervisor sees their own park rather than a list they cannot act on.
 */
router.get('/parks', requireStaffPermission(StaffPermission.PARK_READ), async (req: StaffRequest, res: Response) => {
    try {
        const result = await ParkService.list({
            search: (req.query.search as string) || undefined,
            status: req.query.status && Object.values(ParkStatus).includes(req.query.status as ParkStatus)
                ? (req.query.status as ParkStatus) : undefined,
            city: (req.query.city as string) || undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25,
        });

        const actor = req.actor!;
        if (actor.isLegacy) return res.json(result);
        const scope = await staffParkScope(actor.staffUserId);
        if (scope === '*') return res.json(result);

        const items = result.items.filter((p) => scope.has(p.parkId));
        return res.json({ ...result, items, total: items.length });
    } catch (err: any) {
        return fail(res, err, "We couldn't load parks.");
    }
});

router.get('/parks/:parkId', requireStaffPermission(StaffPermission.PARK_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.get(String(req.params.parkId));
        if (!park) return res.status(404).json(errBody(ErrorCode.NOT_FOUND, 'Park not found.'));

        const [zones, onDuty, blockers, assignedStaff] = await Promise.all([
            ParkService.listZones(park.parkId, true),
            DispatcherShiftService.onDuty(park.parkId),
            park.status === ParkStatus.DRAFT
                ? ParkService.activationBlockers(await ParkService.requirePark(park.parkId))
                : Promise.resolve([]),
            ParkRepository.assignedStaff(park.parkId),
        ]);

        const staffIds = [...new Set(assignedStaff.map((a) => a.staffUserId))];
        const staff = staffIds.length
            ? await AppDataSource.getRepository(StaffUser).createQueryBuilder('s')
                .where('s.id IN (:...ids)', { ids: staffIds }).getMany()
            : [];
        const staffBy = new Map(staff.map((s) => [s.id, s]));

        return res.json({
            park,
            zones,
            onDuty,
            activationBlockers: blockers,
            assignedStaff: assignedStaff.map((a) => ({
                staffUserId: a.staffUserId,
                role: a.role,
                grantedAt: a.grantedAt,
                name: staffBy.get(a.staffUserId)
                    ? `${staffBy.get(a.staffUserId)!.firstName} ${staffBy.get(a.staffUserId)!.lastName}`
                    : a.staffUserId,
                status: staffBy.get(a.staffUserId)?.status ?? 'unknown',
            })),
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load this park.");
    }
});

router.post('/parks', requireRealStaff, requireStaffPermission(StaffPermission.PARK_CREATE), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.create(auditActorOf(req.actor), req.body ?? {}, ctxOf(req));
        return res.status(201).json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't create this park.");
    }
});

router.patch('/parks/:parkId', requireRealStaff, requireStaffPermission(StaffPermission.PARK_UPDATE), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.update(auditActorOf(req.actor), String(req.params.parkId), req.body ?? {}, ctxOf(req));
        return res.json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't update this park.");
    }
});

/** POST /admin/parks/:parkId/activate — refuses unless the park is genuinely ready. */
router.post('/parks/:parkId/activate', requireRealStaff, requireStaffPermission(StaffPermission.PARK_ACTIVATE), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.activate(auditActorOf(req.actor), String(req.params.parkId), ctxOf(req));
        return res.json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't activate this park.");
    }
});

router.post('/parks/:parkId/deactivate', requireRealStaff, requireStaffPermission(StaffPermission.PARK_SUSPEND), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.deactivate(auditActorOf(req.actor), String(req.params.parkId), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't deactivate this park.");
    }
});

router.post('/parks/:parkId/suspend', requireRealStaff, requireStaffPermission(StaffPermission.PARK_SUSPEND), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const park = await ParkService.suspend(auditActorOf(req.actor), String(req.params.parkId), String(req.body?.reason ?? ''), ctxOf(req));
        return res.json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't suspend this park.");
    }
});

router.put('/parks/:parkId/supervisor', requireRealStaff, requireStaffPermission(StaffPermission.PARK_ASSIGN_DISPATCHER), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const staffUserId = req.body?.staffUserId ? String(req.body.staffUserId) : null;
        const park = await ParkService.assignSupervisor(auditActorOf(req.actor), String(req.params.parkId), staffUserId, ctxOf(req));
        return res.json({ park });
    } catch (err: any) {
        return fail(res, err, "We couldn't assign the supervisor.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Zones
// ═══════════════════════════════════════════════════════════════════════

router.get('/parks/:parkId/zones', requireStaffPermission(StaffPermission.PARK_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        return res.json({ zones: await ParkService.listZones(String(req.params.parkId), req.query.includeInactive === 'true') });
    } catch (err: any) {
        return fail(res, err, "We couldn't load zones.");
    }
});

router.post('/parks/:parkId/zones', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ZONES), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const zone = await ParkService.createZone(auditActorOf(req.actor), String(req.params.parkId), req.body ?? {}, ctxOf(req));
        return res.status(201).json({ zone });
    } catch (err: any) {
        return fail(res, err, "We couldn't create this zone.");
    }
});

router.patch('/zones/:zoneId', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ZONES), async (req: StaffRequest, res: Response) => {
    try {
        const zone = await ParkService.updateZone(auditActorOf(req.actor), String(req.params.zoneId), req.body ?? {}, ctxOf(req));
        return res.json({ zone });
    } catch (err: any) {
        return fail(res, err, "We couldn't update this zone.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Roster
// ═══════════════════════════════════════════════════════════════════════

router.get('/parks/:parkId/roster', requireStaffPermission(StaffPermission.PARK_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const status = req.query.status as RosterStatus | undefined;
        const roster = await ParkRosterService.view(String(req.params.parkId), {
            status: status && Object.values(RosterStatus).includes(status) ? status : undefined,
            queuedOnly: req.query.queuedOnly === 'true',
            search: (req.query.search as string) || undefined,
        });
        return res.json({ roster, total: roster.length });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the roster.");
    }
});

router.get('/parks/:parkId/queue', requireStaffPermission(StaffPermission.PARK_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        return res.json({ queue: await ParkRosterService.queue(String(req.params.parkId)) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load the queue.");
    }
});

router.post('/parks/:parkId/roster', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const entry = await ParkRosterService.addDriver(
            auditActorOf(req.actor), String(req.params.parkId), String(req.body?.driverId ?? ''), ctxOf(req),
        );
        return res.status(201).json({ entry });
    } catch (err: any) {
        return fail(res, err, "We couldn't add this driver to the roster.");
    }
});

router.delete('/parks/:parkId/roster/:driverId', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        await ParkRosterService.removeDriver(
            auditActorOf(req.actor), String(req.params.parkId), String(req.params.driverId),
            String(req.body?.reason ?? ''), ctxOf(req),
        );
        return res.json({ message: 'Driver removed from roster.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't remove this driver.");
    }
});

router.post('/parks/:parkId/roster/:driverId/suspend', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        await ParkRosterService.setSuspended(
            auditActorOf(req.actor), String(req.params.parkId), String(req.params.driverId),
            true, String(req.body?.reason ?? ''), ctxOf(req),
        );
        return res.json({ message: 'Driver suspended on this roster.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't suspend this driver.");
    }
});

router.post('/parks/:parkId/roster/:driverId/reinstate', requireRealStaff, requireStaffPermission(StaffPermission.PARK_MANAGE_ROSTER), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        await ParkRosterService.setSuspended(
            auditActorOf(req.actor), String(req.params.parkId), String(req.params.driverId), false, null, ctxOf(req),
        );
        return res.json({ message: 'Driver reinstated.' });
    } catch (err: any) {
        return fail(res, err, "We couldn't reinstate this driver.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Shifts
// ═══════════════════════════════════════════════════════════════════════

router.get('/parks/:parkId/shifts', requireStaffPermission(StaffPermission.SHIFT_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const result = await DispatcherShiftService.list({
            parkId: String(req.params.parkId),
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
        });
        const since = new Date(Date.now() - 30 * 86_400_000);
        return res.json({ ...result, stats: await DispatcherShiftService.statsForPark(String(req.params.parkId), since) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load shifts.");
    }
});

/** GET /admin/shifts/on-duty — everyone dispatching right now, across all parks. */
router.get('/shifts/on-duty', requireStaffPermission(StaffPermission.SHIFT_READ), async (_req: StaffRequest, res: Response) => {
    try {
        return res.json({ shifts: await DispatcherShiftService.allOnDuty() });
    } catch (err: any) {
        return fail(res, err, "We couldn't load on-duty dispatchers.");
    }
});

router.post('/shifts/:shiftId/force-close', requireRealStaff, requireStaffPermission(StaffPermission.SHIFT_CLOSE_ANY), async (req: StaffRequest, res: Response) => {
    try {
        const shift = await DispatcherShiftService.forceClose(
            auditActorOf(req.actor), String(req.params.shiftId), String(req.body?.reason ?? ''), ctxOf(req),
        );
        return res.json({ shift });
    } catch (err: any) {
        return fail(res, err, "We couldn't close this shift.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Presence
// ═══════════════════════════════════════════════════════════════════════

router.get('/parks/:parkId/presence', requireStaffPermission(StaffPermission.PRESENCE_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const statesParam = (req.query.states as string | undefined)?.trim();
        const states = statesParam
            ? statesParam.split(',').map((s) => s.trim()).filter((s) => Object.values(DriverPresenceState).includes(s as DriverPresenceState)) as DriverPresenceState[]
            : undefined;
        return res.json({ presence: await DriverPresenceService.atPark(String(req.params.parkId), states) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load presence.");
    }
});

router.get('/parks/:parkId/presence/stale', requireStaffPermission(StaffPermission.PRESENCE_READ), requireParkScope(), async (req: StaffRequest, res: Response) => {
    try {
        const minutes = req.query.minutes ? Number(req.query.minutes) : 180;
        return res.json({ stale: await DriverPresenceService.stale(String(req.params.parkId), minutes) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load stale presence.");
    }
});

router.get('/drivers/:driverId/presence', requireStaffPermission(StaffPermission.PRESENCE_READ), async (req: StaffRequest, res: Response) => {
    try {
        const driverId = String(req.params.driverId);
        return res.json({
            presence: await DriverPresenceService.get(driverId),
            history: await DriverPresenceService.history(driverId, 50),
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load driver presence.");
    }
});

/**
 * POST /admin/drivers/:driverId/presence
 * An administrator correcting presence. `force` bypasses the transition rules
 * and requires a reason; the override is recorded as such.
 */
router.post('/drivers/:driverId/presence', requireRealStaff, requireStaffPermission(StaffPermission.PRESENCE_WRITE), async (req: StaffRequest, res: Response) => {
    try {
        const result = await DriverPresenceService.setState({
            driverId: String(req.params.driverId),
            state: req.body?.state,
            parkId: req.body?.parkId ?? null,
            rideId: req.body?.rideId ?? null,
            note: req.body?.note ?? null,
            source: PresenceSource.ADMIN,
            setByStaffId: req.actor!.isLegacy ? null : req.actor!.staffUserId,
            force: req.body?.force === true,
            reason: req.body?.reason ?? null,
        }, { actor: auditActorOf(req.actor), ipAddress: req.ip ?? null, correlationId: (req as any).requestId ?? null });
        return res.json(result);
    } catch (err: any) {
        return fail(res, err, "We couldn't update presence.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Badges
// ═══════════════════════════════════════════════════════════════════════

router.get('/badges', requireStaffPermission(StaffPermission.BADGE_READ), async (req: StaffRequest, res: Response) => {
    try {
        const status = req.query.status as BadgeStatus | undefined;
        const result = await BadgeService.list({
            parkId: (req.query.parkId as string) || undefined,
            driverId: (req.query.driverId as string) || undefined,
            status: status && Object.values(BadgeStatus).includes(status) ? status : undefined,
            search: (req.query.search as string) || undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
        });
        return res.json({ ...result, counts: await DriverBadgeRepository.countsByStatus() });
    } catch (err: any) {
        return fail(res, err, "We couldn't load badges.");
    }
});

router.post('/badges', requireRealStaff, requireStaffPermission(StaffPermission.BADGE_ISSUE), async (req: StaffRequest, res: Response) => {
    try {
        const badge = await BadgeService.issue(auditActorOf(req.actor), {
            driverId: String(req.body?.driverId ?? ''),
            parkId: req.body?.parkId ?? null,
        }, ctxOf(req));
        return res.status(201).json({ badge });
    } catch (err: any) {
        return fail(res, err, "We couldn't issue this badge.");
    }
});

router.post('/badges/:badgeSerial/activate', requireRealStaff, requireStaffPermission(StaffPermission.BADGE_ISSUE), async (req: StaffRequest, res: Response) => {
    try {
        return res.json({ badge: await BadgeService.activate(auditActorOf(req.actor), String(req.params.badgeSerial), ctxOf(req)) });
    } catch (err: any) {
        return fail(res, err, "We couldn't activate this badge.");
    }
});

router.post('/badges/:badgeSerial/revoke', requireRealStaff, requireStaffPermission(StaffPermission.BADGE_REVOKE), async (req: StaffRequest, res: Response) => {
    try {
        const lost = req.body?.lost === true;
        const badge = await BadgeService.revoke(
            auditActorOf(req.actor), String(req.params.badgeSerial), String(req.body?.reason ?? ''),
            lost ? BadgeStatus.LOST : BadgeStatus.REVOKED, ctxOf(req),
        );
        return res.json({ badge });
    } catch (err: any) {
        return fail(res, err, "We couldn't revoke this badge.");
    }
});

router.post('/badges/:badgeSerial/replace', requireRealStaff, requireStaffPermission(StaffPermission.BADGE_REPLACE), async (req: StaffRequest, res: Response) => {
    try {
        const badge = await BadgeService.replace(auditActorOf(req.actor), String(req.params.badgeSerial), String(req.body?.reason ?? ''), ctxOf(req));
        return res.status(201).json({ badge });
    } catch (err: any) {
        return fail(res, err, "We couldn't replace this badge.");
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  Park Dispatch monitoring  (Phase 3)
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /admin/park-dispatch/overview
 *
 * The operational picture across every park: what is live right now, and how the
 * channel has performed over the window.
 *
 * Response times are MEDIAN, not mean. One dispatcher who left a device on a
 * bench while they went to lunch would drag a mean into meaninglessness, and the
 * number that matters is what a typical request experiences.
 */
router.get('/park-dispatch/overview', requireStaffPermission(StaffPermission.PARK_VIEW_METRICS, StaffPermission.MONITOR_READ), async (req: StaffRequest, res: Response) => {
    try {
        const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 24));
        const since = new Date(Date.now() - hours * 3600_000);
        const parkId = (req.query.parkId as string) || undefined;

        const [metrics, dispatcherStats, live] = await Promise.all([
            ParkDispatchJobRepository.metrics(since, parkId),
            ParkDispatchJobRepository.dispatcherStats(since, parkId),
            ParkDispatchJobRepository.list({ statuses: LIVE_JOB_STATUSES, pageSize: 100 }),
        ]);

        // Park utilisation: how much of each park's capacity is actually being
        // used right now, beside how much work it has been given.
        const parks = await ParkRepository.findDispatchable();
        const counts = await ParkRepository.countsForMany(parks);
        const utilisation = await Promise.all(parks.map(async (p) => ({
            parkId: p.parkId,
            name: p.name,
            code: p.code,
            counts: counts.get(p.parkId),
            liveJobs: await ParkDispatchJobRepository.countLiveForPark(p.parkId),
            windowMetrics: await ParkDispatchJobRepository.metrics(since, p.parkId),
        })));

        // Resolve dispatcher names for display.
        const staffIds = [...new Set(dispatcherStats.map((d) => d.staffUserId))];
        const staff = staffIds.length
            ? await AppDataSource.getRepository(StaffUser).createQueryBuilder('s')
                .where('s.id IN (:...ids)', { ids: staffIds }).getMany()
            : [];
        const nameBy = new Map(staff.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));

        return res.json({
            windowHours: hours,
            enabled: loadParkDispatchConfig().enabled,
            metrics,
            dispatchers: dispatcherStats.map((d) => ({
                staffUserId: d.staffUserId,
                name: nameBy.get(d.staffUserId) ?? d.staffUserId,
                claimed: Number(d.claimed),
                assigned: Number(d.assigned),
                skipped: Number(d.skipped),
                avgResponseMs: d.avgResponseMs == null ? null : Number(d.avgResponseMs),
            })),
            liveJobs: live.items,
            parkUtilisation: utilisation,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't load park dispatch monitoring.");
    }
});

/** GET /admin/park-dispatch/jobs — paged job history for investigation. */
router.get('/park-dispatch/jobs', requireStaffPermission(StaffPermission.PARK_VIEW_METRICS, StaffPermission.MONITOR_READ), async (req: StaffRequest, res: Response) => {
    try {
        const status = req.query.status as ParkJobStatus | undefined;
        const result = await ParkDispatchJobRepository.list({
            parkId: (req.query.parkId as string) || undefined,
            status: status && Object.values(ParkJobStatus).includes(status) ? status : undefined,
            from: req.query.from ? new Date(String(req.query.from)) : undefined,
            to: req.query.to ? new Date(String(req.query.to)) : undefined,
            page: req.query.page ? Number(req.query.page) : 1,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50,
        });
        return res.json(result);
    } catch (err: any) {
        return fail(res, err, "We couldn't load park dispatch jobs.");
    }
});

/**
 * GET /admin/park-dispatch/health
 * Per-park operational health: waiting, assigned, queue depth, who is on duty,
 * assignment and passenger-wait times, acceptance rate and jobs per dispatcher.
 */
router.get('/park-dispatch/health', requireStaffPermission(StaffPermission.PARK_VIEW_METRICS, StaffPermission.MONITOR_READ), async (_req: StaffRequest, res: Response) => {
    try {
        return res.json({ parks: await DispatcherDashboardService.allParkHealth() });
    } catch (err: any) {
        return fail(res, err, "We couldn't load park health.");
    }
});

/**
 * GET /admin/park-dispatch/switch — is Park Dispatch currently accepting work?
 *
 * Reports both layers: the deployed environment setting and the Redis override,
 * because "why is nothing reaching the park?" has two possible answers and an
 * operator should not have to shell into a container to tell them apart.
 */
router.get('/park-dispatch/switch', requireStaffPermission(StaffPermission.PARK_VIEW_METRICS, StaffPermission.MONITOR_READ), async (_req: StaffRequest, res: Response) => {
    try {
        const override = await ParkDispatchSwitch.state();
        const envEnabled = loadParkDispatchConfig().enabled;
        return res.json({
            accepting: envEnabled && !override.disabled,
            envEnabled,
            override,
        });
    } catch (err: any) {
        return fail(res, err, "We couldn't read the Park Dispatch switch.");
    }
});

/**
 * POST /admin/park-dispatch/switch — break-glass disable / re-enable.
 *
 * Body: { disabled: boolean, reason?: string }
 *
 * Gated on PARK_SUSPEND, which only SUPER_ADMIN and OPERATIONS_ADMIN hold — a
 * dispatcher or supervisor cannot take the whole dispatch path offline.
 *
 * Deliberately NOT behind requireRealStaff: this is the control you reach for
 * during an incident, and the shared operations key already carries
 * PARK_SUSPEND. Every use is audited with whoever presented the credential.
 */
router.post('/park-dispatch/switch', requireStaffPermission(StaffPermission.PARK_SUSPEND), async (req: StaffRequest, res: Response) => {
    try {
        const disabled = req.body?.disabled === true;
        const reason = String(req.body?.reason ?? '').trim();
        if (disabled && reason.length < 3) {
            return res.status(400).json({ error: 'Give a reason for disabling Park Dispatch.' });
        }

        const actor = auditActorOf(req.actor);
        if (disabled) {
            await ParkDispatchSwitch.disable(reason, actor.staffUserId);
        } else {
            await ParkDispatchSwitch.enable();
        }

        await AuditService.record({
            actor,
            action: disabled ? 'park_dispatch.disabled' : 'park_dispatch.enabled',
            resourceType: 'park_dispatch',
            resourceId: 'global',
            reason: reason || null,
            ...ctxOf(req),
        });

        return res.json({ ...(await ParkDispatchSwitch.state()), envEnabled: loadParkDispatchConfig().enabled });
    } catch (err: any) {
        return fail(res, err, "We couldn't change the Park Dispatch switch.");
    }
});

/** GET /admin/park-dispatch/rides/:rideId — every park attempt for one ride. */
router.get('/park-dispatch/rides/:rideId', requireStaffPermission(StaffPermission.MONITOR_READ), async (req: StaffRequest, res: Response) => {
    try {
        return res.json({ jobs: await ParkDispatchJobRepository.findAllForRide(String(req.params.rideId)) });
    } catch (err: any) {
        return fail(res, err, "We couldn't load this ride's park history.");
    }
});

export default router;
