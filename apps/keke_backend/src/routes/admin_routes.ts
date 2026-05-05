import { Router, Request, Response } from "express";
import { AdminService } from "../services/admin_service";
import { adminAuth } from "../middleware/admin_auth";
import { adminLimiter } from "../middleware/rate_limit";
import { adminRejectionSchema } from "../services/validation_service";
import { DriverStatus, DriverProfile } from "../models/DriverProfile";
import { AppDataSource } from "../config/data_source";
import { AuditLog } from "../models/AuditLog";
import path from "path";
import fs from "fs";

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
 * GET /admin/drivers/all
 * All drivers with optional status filter (?status=approved|suspended|pending_review etc.)
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

export default router;
