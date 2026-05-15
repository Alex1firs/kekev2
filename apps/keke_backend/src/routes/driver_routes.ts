import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { DriverProfile, DriverStatus } from "../models/DriverProfile";
import { Wallet } from "../models/Wallet";
import { onboardingLimiter } from "../middleware/rate_limit";
import { upload } from "../middleware/upload_middleware";
import { driverOnboardingSchema } from "../services/validation_service";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";
import { redis } from "../config/redis";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { DispatchService } from "../services/dispatch_service";

const router = Router();

/**
 * POST /api/v1/drivers/onboarding
 * Submit driver profile for review.
 */
router.post("/onboarding", authMiddleware, onboardingLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const validated = driverOnboardingSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Please check your details and try again."));
        }

        const userId = req.user!.userId;
        const { firstName, lastName, vehiclePlate, vehicleModel } = validated.data;

        const repo = AppDataSource.getRepository(DriverProfile);
        let profile = await repo.findOneBy({ userId });

        if (!profile) {
            profile = repo.create({ userId });
        }

        profile.firstName = firstName;
        profile.lastName = lastName;
        profile.vehiclePlate = vehiclePlate;
        profile.vehicleModel = vehicleModel;

        const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl;
        profile.status = allDocsPresent ? DriverStatus.PENDING_REVIEW : DriverStatus.PENDING_DOCUMENTS;
        profile.rejectionReason = "";

        await repo.save(profile);

        res.json({ message: "Onboarding submitted successfully.", status: profile.status });
    } catch (err: any) {
        console.error('[DRIVER] Onboarding error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't submit your details right now. Please try again."));
    }
});

/**
 * POST /api/v1/drivers/upload
 * Upload a specific KYC document.
 */
router.post("/upload", authMiddleware, onboardingLimiter, upload.single("document"), async (req: AuthRequest, res: Response) => {
    try {
        const { userId, docType } = req.body ?? {};
        if (!userId || !docType || !req.file) {
            return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, "Document file and type are required."));
        }

        if (req.user!.userId !== userId) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "Access denied."));
        }

        const repo = AppDataSource.getRepository(DriverProfile);
        let profile = await repo.findOneBy({ userId });
        if (!profile) {
            return res.status(404).json(errBody(ErrorCode.PROFILE_NOT_FOUND, "Driver profile not found. Please complete onboarding first."));
        }

        const originalPath = req.file.path;
        const processedFilename = path.basename(`proc_${req.file.filename}`);
        const processedPath = path.join(path.dirname(originalPath), processedFilename);

        try {
            await sharp(originalPath)
                .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(processedPath);
            fs.unlinkSync(originalPath);
        } catch (sharpErr: any) {
            console.error('[DRIVER] Image processing error:', sharpErr?.message);
            // Clean up uploaded file if processing fails
            try { fs.unlinkSync(originalPath); } catch (_) {}
            return res.status(500).json(errBody(ErrorCode.UPLOAD_FAILED, "We couldn't process your document. Please try a clearer image."));
        }

        if (docType === "license") profile.licenseUrl = path.basename(processedFilename);
        else if (docType === "id_card") profile.idCardUrl = path.basename(processedFilename);
        else if (docType === "vehicle_paper") profile.vehiclePaperUrl = path.basename(processedFilename);
        else return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Invalid document type."));

        const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl;
        if (allDocsPresent) {
            profile.status = DriverStatus.PENDING_REVIEW;
        }

        await repo.save(profile);

        res.json({
            message: "Document uploaded successfully.",
            docType,
            filename: processedFilename,
            status: profile.status,
        });
    } catch (err: any) {
        console.error('[DRIVER] Upload error:', err?.message);
        res.status(500).json(errBody(ErrorCode.UPLOAD_FAILED, "Document upload failed. Please try again."));
    }
});

/**
 * GET /api/v1/drivers/status/:userId
 */
router.get("/status/:userId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({
            userId: req.params.userId as string
        });

        if (!profile) {
            return res.json({ status: "unregistered" });
        }

        const wallet = await AppDataSource.getRepository(Wallet).findOneBy({ userId: req.params.userId as string });
        const commissionDebt = wallet ? Number(wallet.driverCommissionDebt) : 0;

        res.json({
            status: profile.status,
            rejectionReason: profile.rejectionReason,
            vehiclePlate: profile.vehiclePlate,
            vehicleModel: profile.vehicleModel,
            firstName: profile.firstName,
            lastName: profile.lastName,
            commissionDebt,
        });
    } catch (err: any) {
        console.error('[DRIVER] Status fetch error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your driver status right now. Please try again."));
    }
});

// Diagnostic: lets the driver app verify heartbeats are reaching the backend.
router.get("/availability/check", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const driverId = req.user!.userId;
        const available = await redis.get(`driver:available:${driverId}`);
        const ttl = available ? await redis.pttl(`driver:available:${driverId}`) : 0;
        const geoPos = await redis.geopos('drivers:locations', driverId) as any[];
        const location = geoPos?.[0] ? { lng: geoPos[0][0], lat: geoPos[0][1] } : null;
        return res.json({ driverId, isAvailable: !!available, ttlMs: ttl, location });
    } catch (err: any) {
        return res.status(500).json({ error: err?.message });
    }
});

/**
 * GET /api/v1/drivers/nearby
 * Get nearby active drivers with their coordinates.
 */
router.get("/nearby", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const lat = parseFloat(req.query.lat as string);
        const lng = parseFloat(req.query.lng as string);
        const radius = parseFloat(req.query.radius as string) || 5;

        if (isNaN(lat) || isNaN(lng)) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Valid lat and lng query parameters are required."));
        }

        const drivers = await DispatchService.getNearbyActiveDriversWithLocations(lat, lng, radius);
        
        // Return only coordinates to the client for privacy
        const locations = drivers.map(d => ({
            lat: d.lat,
            lng: d.lng
        }));

        res.json({ drivers: locations });
    } catch (err: any) {
        console.error('[DRIVER] Fetch nearby error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to fetch nearby drivers."));
    }
});

export default router;
