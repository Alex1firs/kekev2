import { Router, Request, Response } from "express";
import { AdminService } from "../services/admin_service";
import { adminAuth } from "../middleware/admin_auth";
import { attachAdminIdentity, requirePermission, AdminRequest } from "../middleware/admin_permissions";
import { resolveActor, requireStaffAuth } from "../middleware/staff_auth";
import { SYSTEM_LEGACY_ADMIN } from "../services/audit_service";
import staffAdminRoutes from "./staff_admin_routes";
import parkAdminRoutes from "./park_admin_routes";
import communicationsRoutes from "./communications_routes";
import { DispatchMonitorQueryService } from "../services/dispatch_monitor_query_service";
import { RideOperationsService, RideOperationsFilters } from "../services/ride_operations_service";
import { RideOperationsSwitch } from "../services/ride_operations_switch";
import { adminLimiter } from "../middleware/rate_limit";
import { adminRejectionSchema } from "../services/validation_service";
import { DriverStatus, DriverProfile } from "../models/DriverProfile";
import { AppDataSource } from "../config/data_source";
import { AuditLog } from "../models/AuditLog";
import { SettingService } from "../services/setting_service";
import { SosAlert, SosAlertStatus } from "../models/SosAlert";
import { Ride } from "../models/Ride";
import { User } from "../models/User";
import { WalletService } from "../services/wallet_service";
import { upload } from "../middleware/upload_middleware";
import path from "path";
import fs from "fs";
import sharp from "sharp";

const router = Router();

// Apply Admin Auth & Rate Limiting.
//
// adminAuth      — refuses anything presenting neither a bearer token nor a
//                  valid legacy key, so nothing unauthenticated gets further.
// resolveActor   — resolves the credential to a named staff member, or to the
//                  explicitly-labelled legacy actor.
// requireStaffAuth — 401 when the credential was presented but did not resolve
//                  (expired session, revoked account, bumped credentialVersion).
// attachAdminIdentity — projects the actor onto the legacy req.admin shape the
//                  handlers below already read.
router.use(adminAuth);
router.use(resolveActor);
router.use(requireStaffAuth);
router.use(attachAdminIdentity);
router.use(adminLimiter);

/**
 * The identity recorded in the LEGACY `audit_log` table for this request.
 *
 * A named staff member is recorded by their staff id — so these rows finally
 * name a human. A legacy shared-key request keeps the previous
 * `admin_<last 8 chars>` shape so historical rows stay comparable.
 *
 * This helper exists because the previous inline expression dereferenced
 * `req.headers['x-admin-key']` unconditionally. With staff sessions there is no
 * such header, and `.slice()` on undefined would throw — turning every one of
 * these handlers into a 500 the moment somebody signed in properly.
 */
function legacyAuditActor(req: AdminRequest): string {
    if (req.actor && !req.actor.isLegacy) return req.actor.staffUserId;
    const key = req.headers['x-admin-key'] as string | undefined;
    return key ? `admin_${key.slice(-8)}` : SYSTEM_LEGACY_ADMIN;
}

/** Record a sensitive admin action against the acting role. */
async function auditAdmin(
    req: AdminRequest,
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
) {
    try {
        const repo = AppDataSource.getRepository(AuditLog);
        await repo.save(repo.create({
            adminId: req.admin?.label ?? 'superadmin',
            action,
            entityType,
            entityId,
            details: details ?? null,
        }));
    } catch (err: any) {
        console.warn(`[ADMIN_AUDIT] failed to record ${action}: ${err?.message}`);
    }
}

// ===================== Live Ride Requests monitor =====================

/**
 * GET /admin/live-requests
 * Active searching/offered/accepted/arriving/in-progress rides with dispatch
 * rollups. Contact data is MASKED — see /reveal-contact for escalation.
 */
router.get("/live-requests", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        const statusParam = (req.query.status as string | undefined)?.trim();
        const statuses = statusParam && statusParam !== 'all'
            ? statusParam.split(',').map(s => s.trim()).filter(Boolean) as any[]
            : undefined;
        const data = await DispatchMonitorQueryService.liveRequests({
            statuses,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(data);
    } catch (err: any) {
        console.error('[ADMIN] live-requests error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════
//  RIDE OPERATIONS
//
//  The investigation console: every ride ever requested, with the reason it
//  ended the way it did. Registered ahead of `/live-requests/:rideId` only for
//  readability — these are their own path space.
//
//  Ordering within this block DOES matter: the literal sub-paths must be
//  declared before `/:rideId`, or "summary" is read as a ride id.
// ═══════════════════════════════════════════════════════════════════════

/** Comma-separated or repeated query params, normalised to a string[]. */
function listParam(v: unknown): string[] | undefined {
    if (v == null) return undefined;
    const raw = Array.isArray(v) ? v.map(String) : String(v).split(',');
    const out = raw.map((s) => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
}

function operationsFilters(req: AdminRequest): RideOperationsFilters {
    const q = req.query;
    return {
        from: q.from ? String(q.from) : undefined,
        to: q.to ? String(q.to) : undefined,
        status: listParam(q.status),
        outcomeReason: listParam(q.outcomeReason),
        cancelledByRole: listParam(q.cancelledByRole),
        pickupArea: q.pickupArea ? String(q.pickupArea) : undefined,
        destinationArea: q.destinationArea ? String(q.destinationArea) : undefined,
        passengerId: q.passengerId ? String(q.passengerId) : undefined,
        driverId: q.driverId ? String(q.driverId) : undefined,
        q: q.q ? String(q.q) : undefined,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    };
}

/**
 * GET /admin/rides/operations
 * One page of rides, filtered and searched server-side.
 */
router.get("/rides/operations", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        res.json(await RideOperationsService.list(operationsFilters(req)));
    } catch (err: any) {
        console.error('[ADMIN] ride-operations list error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/operations/summary
 * The cards above the table. Honours the same filters as the list, so the
 * numbers always describe the rows underneath them.
 */
router.get("/rides/operations/summary", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        res.json(await RideOperationsService.summary(operationsFilters(req)));
    } catch (err: any) {
        console.error('[ADMIN] ride-operations summary error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /admin/rides/operations/filters — dropdown values drawn from real data. */
router.get("/rides/operations/filters", requirePermission('monitor:read'), async (_req: AdminRequest, res: Response) => {
    try {
        res.json(await RideOperationsService.filterOptions());
    } catch (err: any) {
        console.error('[ADMIN] ride-operations filters error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/operations/telemetry
 * Whether the durable dispatch trail is currently being written. Shown in the
 * console so an operator reading a thin timeline can tell "nothing happened"
 * apart from "we were not recording".
 */
router.get("/rides/operations/telemetry", requirePermission('monitor:read'), async (_req: AdminRequest, res: Response) => {
    try {
        res.json(await RideOperationsSwitch.state());
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/rides/operations/telemetry
 * The no-deploy kill switch. Disable-only by design: it cannot switch telemetry
 * on when the environment says off, so a monitoring credential can never enable
 * writes the deployment did not sanction. Requires admin:write, not monitor:read.
 */
router.post("/rides/operations/telemetry", requirePermission('admin:write'), async (req: AdminRequest, res: Response) => {
    try {
        const enabled = req.body?.enabled === true;
        const reason = (req.body?.reason as string | undefined)?.slice(0, 200) || 'no reason given';
        const actor = req.admin?.label ?? SYSTEM_LEGACY_ADMIN;

        if (enabled) await RideOperationsSwitch.enable();
        else await RideOperationsSwitch.disable(reason, String(actor));

        await auditAdmin(req, enabled ? 'ENABLE_RIDE_TELEMETRY' : 'DISABLE_RIDE_TELEMETRY', 'SETTING', 'ride_operations_telemetry', { reason });
        res.json(await RideOperationsSwitch.state());
    } catch (err: any) {
        console.error('[ADMIN] ride-operations telemetry toggle error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/operations/:rideId
 * The investigation view for ANY ride, live or terminal.
 *
 * This is deliberately the same DispatchMonitorQueryService.requestDetail the
 * live monitor uses — it was always keyed by rideId alone, and the only thing
 * that ever made it "live only" was that nothing linked to it for a finished
 * ride. Reusing it means a completed ride and an in-flight one are investigated
 * through one code path, and cannot disagree.
 */
router.get("/rides/operations/:rideId", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        const detail = await DispatchMonitorQueryService.requestDetail(String(req.params.rideId));
        if (!detail) return res.status(404).json({ error: 'Ride not found' });
        await auditAdmin(req, 'VIEW_RIDE_INVESTIGATION', 'RIDE', String(req.params.rideId), {
            status: detail.ride.status,
        });
        res.json(detail);
    } catch (err: any) {
        console.error('[ADMIN] ride-operations detail error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/live-requests/:rideId
 * Full detail: trip, dispatch summary and the per-driver offer timeline.
 */
router.get("/live-requests/:rideId", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        const detail = await DispatchMonitorQueryService.requestDetail(String(req.params.rideId));
        if (!detail) return res.status(404).json({ error: 'Ride not found' });
        // Opening a request exposes a passenger's trip and history counts, so the
        // access itself is recorded even though the payload is masked.
        await auditAdmin(req, 'VIEW_LIVE_REQUEST', 'RIDE', String(req.params.rideId), {
            status: detail.ride.status,
        });
        res.json(detail);
    } catch (err: any) {
        console.error('[ADMIN] live-request detail error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/live-requests/:rideId/reveal-contact
 * Unmasked passenger/driver contact for a live support call. Always audited.
 */
router.post("/live-requests/:rideId/reveal-contact", requirePermission('monitor:reveal_contact'), async (req: AdminRequest, res: Response) => {
    try {
        const reason = (req.body?.reason as string | undefined)?.slice(0, 200) || null;
        const data = await DispatchMonitorQueryService.revealContact(String(req.params.rideId));
        if (!data) return res.status(404).json({ error: 'Ride not found' });
        await auditAdmin(req, 'REVEAL_RIDE_CONTACT', 'RIDE', String(req.params.rideId), { reason });
        res.json(data);
    } catch (err: any) {
        console.error('[ADMIN] reveal-contact error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/dispatch/driver-metrics
 * Descriptive per-driver dispatch behaviour. No scoring, ranking or penalties.
 */
router.get("/dispatch/driver-metrics", requirePermission('metrics:read'), async (req: AdminRequest, res: Response) => {
    try {
        const data = await DispatchMonitorQueryService.driverMetrics({
            sinceHours: req.query.hours ? Number(req.query.hours) : undefined,
            driverId: (req.query.driverId as string | undefined) || undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json(data);
    } catch (err: any) {
        console.error('[ADMIN] driver-metrics error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/dispatch/events
 * Paginated historical dispatch-event query.
 */
router.get("/dispatch/events", requirePermission('monitor:read'), async (req: AdminRequest, res: Response) => {
    try {
        const typesParam = (req.query.eventTypes as string | undefined)?.trim();
        const data = await DispatchMonitorQueryService.historicalEvents({
            rideId: (req.query.rideId as string | undefined) || undefined,
            driverId: (req.query.driverId as string | undefined) || undefined,
            eventTypes: typesParam ? (typesParam.split(',').map(s => s.trim()).filter(Boolean) as any[]) : undefined,
            from: req.query.from ? new Date(req.query.from as string) : undefined,
            to: req.query.to ? new Date(req.query.to as string) : undefined,
            dispatchRound: req.query.round ? Number(req.query.round) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            offset: req.query.offset ? Number(req.query.offset) : undefined,
        });
        res.json(data);
    } catch (err: any) {
        console.error('[ADMIN] dispatch events error:', err?.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /admin/whoami — the acting role, so the UI can hide what it cannot use. */
router.get("/whoami", async (req: AdminRequest, res: Response) => {
    res.json({ role: req.admin?.role ?? 'superadmin', label: req.admin?.label ?? 'superadmin' });
});

/**
 * GET /admin/overview
 */
router.get("/overview", async (req: Request, res: Response) => {
    try {
        const stats = await AdminService.getOverview();
        res.json(stats);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/pending
 */
router.get("/drivers/pending", async (req: Request, res: Response) => {
    try {
        const drivers = await AdminService.getDriversByStatus(DriverStatus.PENDING_REVIEW);
        res.json(drivers);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/incomplete
 */
router.get("/drivers/incomplete", async (req: Request, res: Response) => {
    try {
        const drivers = await AdminService.getDriversByStatus(DriverStatus.PENDING_DOCUMENTS);
        res.json(drivers);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/online
 */
router.get("/drivers/online", async (req: Request, res: Response) => {
    try {
        const drivers = await AdminService.getOnlineDrivers();
        res.json(drivers);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/live
 * Real-time "Live Riders" view: approved drivers with server-authoritative
 * online status (fresh Redis heartbeat only), location, ride state, and push
 * token status. Must be registered BEFORE "/drivers/:userId".
 */
router.get("/drivers/live", async (req: Request, res: Response) => {
    try {
        const data = await AdminService.getLiveDrivers();
        res.json(data);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/all
 * All drivers with optional status filter (?status=approved|suspended|pending_review etc.)
 * NOTE: must be registered BEFORE "/drivers/:userId" or Express matches this as
 * userId="all" and the handler below returns null.
 */
router.get("/drivers/all", async (req: Request, res: Response) => {
    try {
        const where = req.query.status ? { status: req.query.status as any } : {};
        const drivers = await AppDataSource.getRepository(DriverProfile).find({
            where,
            order: { createdAt: "DESC" },
            take: 200,
        });
        res.json(drivers);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/:userId
 */
router.get("/drivers/:userId", async (req: Request, res: Response) => {
    try {
        const profile = await AdminService.getDriverProfile(req.params.userId as string);
        res.json(profile);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/drivers/:userId/documents/:docType
 * Serve private documents to authorized admins.
 */
router.get("/drivers/:userId/documents/:docType", async (req: Request, res: Response) => {
    try {
        const { userId, docType } = req.params;
        const profile = await AdminService.getDriverProfile(userId as string);
        if (!profile) return res.status(404).json({ error: "Profile not found" });

        let filename = "";
        if (docType === "license") filename = profile.licenseUrl;
        else if (docType === "id_card") filename = profile.idCardUrl;
        else if (docType === "vehicle_paper") filename = profile.vehiclePaperUrl;
        else if (docType === "photo") filename = profile.photoUrl;

        if (!filename) return res.status(404).json({ error: "Document not uploaded" });

        filename = path.basename(filename);
        const filePath = path.join(__dirname, "../../uploads", filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found on disk" });

        res.sendFile(filePath);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/drivers/:userId/documents/:docType
 * Admin uploads / replaces a KYC document on the driver's behalf
 * (e.g. the driver submitted the wrong file). Mirrors the driver-side
 * upload pipeline (sharp downscale + jpeg re-encode) but is gated by
 * admin auth instead of ownership, and does NOT change the driver's
 * status — an already-approved driver stays approved after a fix.
 */
router.post("/drivers/:userId/documents/:docType", upload.single("document"), async (req: Request, res: Response) => {
    try {
        const { userId, docType } = req.params as { userId: string; docType: string };
        if (!req.file) return res.status(400).json({ error: "Document file is required" });

        const validTypes = ["license", "id_card", "vehicle_paper", "photo"];
        if (!validTypes.includes(docType)) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return res.status(400).json({ error: "Invalid document type" });
        }

        const repo = AppDataSource.getRepository(DriverProfile);
        const profile = await repo.findOneBy({ userId });
        if (!profile) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return res.status(404).json({ error: "Driver profile not found" });
        }

        const originalPath = req.file.path;
        const processedFilename = path.basename(`proc_${req.file.filename}`);
        const processedPath = path.join(path.dirname(originalPath), processedFilename);

        try {
            await sharp(originalPath)
                .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(processedPath);
            fs.unlinkSync(originalPath);
        } catch (sharpErr: any) {
            console.error("[ADMIN] Image processing error:", sharpErr?.message);
            try { fs.unlinkSync(originalPath); } catch (_) {}
            return res.status(500).json({ error: "Could not process document. Try a clearer image." });
        }

        // Remember the previous file so we can remove it from disk after the swap.
        const oldFilename =
            docType === "license" ? profile.licenseUrl :
            docType === "id_card" ? profile.idCardUrl :
            docType === "vehicle_paper" ? profile.vehiclePaperUrl :
            profile.photoUrl;

        if (docType === "license") profile.licenseUrl = processedFilename;
        else if (docType === "id_card") profile.idCardUrl = processedFilename;
        else if (docType === "vehicle_paper") profile.vehiclePaperUrl = processedFilename;
        else if (docType === "photo") profile.photoUrl = processedFilename;

        await repo.save(profile);

        // Best-effort cleanup of the replaced file (never fail the request on this).
        if (oldFilename && path.basename(oldFilename) !== processedFilename) {
            try { fs.unlinkSync(path.join(__dirname, "../../uploads", path.basename(oldFilename))); } catch (_) {}
        }

        const adminId = legacyAuditActor(req as AdminRequest);
        try {
            await AppDataSource.getRepository(AuditLog).save(AppDataSource.getRepository(AuditLog).create({
                adminId,
                action: "REPLACE_DRIVER_DOCUMENT",
                entityType: "DRIVER_PROFILE",
                entityId: userId,
                details: { docType, status: profile.status },
            }));
        } catch (auditErr) {
            console.error("[ADMIN] Audit logging failed (upload succeeded):", auditErr);
        }

        res.json({ message: "Document replaced successfully.", docType, status: profile.status });
    } catch (err: any) {
        console.error("[ADMIN] Document replace error:", err?.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/drivers/:id/approve
 */
router.post("/drivers/:userId/approve", async (req: Request, res: Response) => {
    try {
        const userId = req.params.userId as string;
        const adminId = legacyAuditActor(req as AdminRequest);
        const result = await AdminService.updateDriverStatus(userId, DriverStatus.APPROVED, undefined, adminId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/drivers/:id/reject
 */
router.post("/drivers/:userId/reject", async (req: Request, res: Response) => {
    try {
        const userId = req.params.userId as string;

        // Strict Validation
        const validated = adminRejectionSchema.safeParse(req.body);
        if (!validated.success) {
          return res.status(400).json({ error: "Validation Failed", details: validated.error.format() });
        }

        const adminId = legacyAuditActor(req as AdminRequest);
        const result = await AdminService.updateDriverStatus(userId, DriverStatus.REJECTED, validated.data.reason, adminId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/drivers/:userId/suspend
 */
router.post("/drivers/:userId/suspend", async (req: Request, res: Response) => {
    try {
        const userId = req.params.userId as string;
        const adminId = legacyAuditActor(req as AdminRequest);
        const result = await AdminService.updateDriverStatus(userId, DriverStatus.SUSPENDED, req.body.reason || "Policy violation", adminId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/drivers/:userId/activate
 */
router.post("/drivers/:userId/activate", async (req: Request, res: Response) => {
    try {
        const userId = req.params.userId as string;
        const adminId = legacyAuditActor(req as AdminRequest);
        const result = await AdminService.updateDriverStatus(userId, DriverStatus.APPROVED, undefined, adminId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/active
 */
router.get("/rides/active", async (req: Request, res: Response) => {
    try {
        const rides = await AdminService.getActiveRides();
        res.json(rides);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/history
 */
router.get("/rides/history", async (req: Request, res: Response) => {
    try {
        const rides = await AdminService.getRideHistory();
        res.json(rides);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/finance/summary
 */
router.get("/finance/summary", async (req: Request, res: Response) => {
    try {
        const stats = await AdminService.getFinanceSummary();
        res.json(stats);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/finance/debts
 */
router.get("/finance/debts", async (req: Request, res: Response) => {
    try {
        const debts = await AdminService.getDebtLeaderboard();
        res.json(debts);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/finance/payouts
 */
router.get("/finance/payouts", async (req: Request, res: Response) => {
    try {
        const payouts = await AdminService.getPayouts();
        res.json(payouts);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/finance/payouts/:id/process  — mark PROCESSING
 * POST /admin/finance/payouts/:id/complete — mark SUCCESS
 * POST /admin/finance/payouts/:id/fail     — mark FAILED
 */
router.post("/finance/payouts/:id/process", async (req: Request, res: Response) => {
    try {
        const adminId = legacyAuditActor(req as AdminRequest);
        const payout = await AdminService.updatePayoutStatus(req.params.id as string, 'processing' as any, adminId);
        res.json(payout);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/finance/payouts/:id/complete", async (req: Request, res: Response) => {
    try {
        const adminId = legacyAuditActor(req as AdminRequest);
        const payout = await AdminService.updatePayoutStatus(req.params.id as string, 'success' as any, adminId);
        res.json(payout);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/finance/payouts/:id/fail", async (req: Request, res: Response) => {
    try {
        const adminId = legacyAuditActor(req as AdminRequest);
        const payout = await AdminService.updatePayoutStatus(req.params.id as string, 'failed' as any, adminId);
        res.json(payout);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * GET /admin/audit-log
 */
router.get("/audit-log", async (req: Request, res: Response) => {
    try {
        const logs = await AppDataSource.getRepository(AuditLog).find({
            order: { createdAt: "DESC" },
            take: 100,
        });
        res.json(logs);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/settings
 */
router.get("/settings", async (req: Request, res: Response) => {
    try {
        const config = await SettingService.getPricingConfig();
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/settings
 */
router.post("/settings", async (req: Request, res: Response) => {
    try {
        const { baseFare, perKmRate, platformFeePercent } = req.body;
        if (baseFare === undefined || perKmRate === undefined || platformFeePercent === undefined) {
            return res.status(400).json({ error: "Missing configuration fields" });
        }

        await SettingService.setSetting("baseFare", String(baseFare));
        await SettingService.setSetting("perKmRate", String(perKmRate));
        await SettingService.setSetting("platformFeePercent", String(platformFeePercent));

        const adminId = legacyAuditActor(req as AdminRequest);
        
        // Log this action to the AuditLog
        const auditRepo = AppDataSource.getRepository(AuditLog);
        const audit = auditRepo.create({
            adminId,
            action: "UPDATE_PRICING_SETTINGS",
            entityType: "SETTING",
            entityId: "PRICING_CONFIG",
            details: { baseFare, perKmRate, platformFeePercent }
        });
        await auditRepo.save(audit);

        res.json({ message: "Settings updated successfully", config: { baseFare, perKmRate, platformFeePercent } });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/sos/active
 */
router.get("/sos/active", async (req: Request, res: Response) => {
    try {
        const alerts = await AppDataSource.getRepository(SosAlert).find({
            where: { status: SosAlertStatus.ACTIVE },
            order: { createdAt: "DESC" },
        });

        // Enrich alerts with driver and passenger names/phones
        const enrichedAlerts = await Promise.all(alerts.map(async (alert) => {
            let driverName = "Unknown";
            let driverPhone = "Unknown";
            let passengerName = "Unknown";
            let passengerPhone = "Unknown";

            const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: alert.rideId } });
            if (ride) {
                if (ride.driverId) {
                    const driverProfile = await AppDataSource.getRepository(DriverProfile).findOne({ where: { userId: ride.driverId } });
                    if (driverProfile) {
                        driverName = `${driverProfile.firstName} ${driverProfile.lastName}`;
                    }
                    const driverUser = await AppDataSource.getRepository(User).findOne({ where: { id: ride.driverId } });
                    if (driverUser) {
                        driverPhone = driverUser.phone || "Unknown";
                    }
                }
                if (ride.passengerId) {
                    const passengerUser = await AppDataSource.getRepository(User).findOne({ where: { id: ride.passengerId } });
                    if (passengerUser) {
                        passengerName = `${passengerUser.firstName} ${passengerUser.lastName}`;
                        passengerPhone = passengerUser.phone || "Unknown";
                    }
                }
            }

            return {
                ...alert,
                driverName,
                driverPhone,
                passengerName,
                passengerPhone
            };
        }));

        res.json(enrichedAlerts);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/sos/:id/resolve
 */
router.post("/sos/:id/resolve", async (req: Request, res: Response) => {
    try {
        const adminId = legacyAuditActor(req as AdminRequest);
        const repo = AppDataSource.getRepository(SosAlert);
        const alert = await repo.findOne({ where: { id: req.params.id as string } });
        if (!alert) return res.status(404).json({ error: "Alert not found" });

        alert.status = SosAlertStatus.RESOLVED;
        alert.resolvedAt = new Date();
        await repo.save(alert);

        const auditRepo = AppDataSource.getRepository(AuditLog);
        const audit = auditRepo.create({
            adminId,
            action: "RESOLVED_SOS_ALERT",
            entityType: "SOS_ALERT",
            entityId: alert.id,
            details: { rideId: alert.rideId }
        });
        await auditRepo.save(audit);

        res.json(alert);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /admin/rides/flagged
 * Rides flagged as suspicious or with payment held for review.
 */
router.get("/rides/flagged", async (req: Request, res: Response) => {
    try {
        const rideRepo = AppDataSource.getRepository(Ride);
        const rides = await rideRepo.find({
            where: [{ suspicious: true }, { paymentHeld: true }],
            order: { updatedAt: "DESC" },
            take: 200,
        });
        res.json(rides);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/rides/:rideId/release
 * Release a held ride's payment — runs the (previously withheld) settlement
 * using the backend-authoritative finalFare, then clears the hold.
 */
router.post("/rides/:rideId/release", async (req: Request, res: Response) => {
    try {
        const rideId = req.params.rideId as string;
        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });
        if (!ride) return res.status(404).json({ error: "Ride not found" });
        if (!ride.paymentHeld) return res.status(400).json({ error: "Ride payment is not held" });

        const amount = Number(ride.finalFare ?? ride.fare);
        await WalletService.postRideFinancials({
            rideId,
            passengerId: ride.passengerId,
            driverId: ride.driverId,
            totalFare: amount,
            isCash: ride.paymentMode === "cash",
        });
        await rideRepo.update(rideId, { paymentHeld: false } as any);

        const adminId = legacyAuditActor(req as AdminRequest);
        await AppDataSource.getRepository(AuditLog).save(AppDataSource.getRepository(AuditLog).create({
            adminId, action: "RELEASED_HELD_RIDE_PAYMENT", entityType: "RIDE", entityId: rideId,
            details: { amount, paymentMode: ride.paymentMode },
        }));
        res.json({ message: "Payment released.", rideId, amount });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /admin/rides/:rideId/void
 * Dismiss a held ride without charging (e.g. confirmed fraud / no valid trip).
 */
router.post("/rides/:rideId/void", async (req: Request, res: Response) => {
    try {
        const rideId = req.params.rideId as string;
        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });
        if (!ride) return res.status(404).json({ error: "Ride not found" });

        await rideRepo.update(rideId, { paymentHeld: false, paymentFailed: true } as any);

        const adminId = legacyAuditActor(req as AdminRequest);
        await AppDataSource.getRepository(AuditLog).save(AppDataSource.getRepository(AuditLog).create({
            adminId, action: "VOIDED_HELD_RIDE_PAYMENT", entityType: "RIDE", entityId: rideId,
            details: { reason: (req.body?.reason ?? null), suspiciousReason: ride.suspiciousReason },
        }));
        res.json({ message: "Held payment voided — passenger not charged.", rideId });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Staff management, the audit log and the new contact-reveal endpoints.
//
// Mounted LAST so every route above keeps precedence — this addition cannot
// shadow an existing admin path. It inherits the auth chain applied at the top
// of this file, so there is one way in, not two.
router.use(staffAdminRoutes);
// Park infrastructure, rosters, shifts, presence and badges. Same auth chain,
// same precedence rule: mounted last so nothing above can be shadowed.
router.use(parkAdminRoutes);
// Passenger Communications. Inherits the full staff auth chain above; the
// legacy shared key is barred from every communications: permission.
router.use(communicationsRoutes);

export default router;

