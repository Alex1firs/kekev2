import { Router, Request, Response } from "express";
import { AdminService } from "../services/admin_service";
import { adminAuth } from "../middleware/admin_auth";
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

// Apply Admin Auth & Rate Limiting
router.use(adminAuth);
router.use(adminLimiter);

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

        const adminId = `admin_${(req.headers["x-admin-key"] as string).slice(-8)}`;
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
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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

        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
        const payout = await AdminService.updatePayoutStatus(req.params.id as string, 'processing' as any, adminId);
        res.json(payout);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/finance/payouts/:id/complete", async (req: Request, res: Response) => {
    try {
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
        const payout = await AdminService.updatePayoutStatus(req.params.id as string, 'success' as any, adminId);
        res.json(payout);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/finance/payouts/:id/fail", async (req: Request, res: Response) => {
    try {
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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

        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
        
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
        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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

        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
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

        const adminId = `admin_${(req.headers['x-admin-key'] as string).slice(-8)}`;
        await AppDataSource.getRepository(AuditLog).save(AppDataSource.getRepository(AuditLog).create({
            adminId, action: "VOIDED_HELD_RIDE_PAYMENT", entityType: "RIDE", entityId: rideId,
            details: { reason: (req.body?.reason ?? null), suspiciousReason: ride.suspiciousReason },
        }));
        res.json({ message: "Held payment voided — passenger not charged.", rideId });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

