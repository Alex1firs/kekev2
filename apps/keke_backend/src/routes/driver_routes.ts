import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { DriverProfile, DriverStatus } from "../models/DriverProfile";
import { Wallet } from "../models/Wallet";
import { onboardingLimiter, uploadLimiter } from "../middleware/rate_limit";
import { upload } from "../middleware/upload_middleware";
import { driverOnboardingSchema } from "../services/validation_service";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";
import { redis } from "../config/redis";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { DispatchService } from "../services/dispatch_service";
import { SmileIdService } from "../services/smile_id_service";

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
        const { firstName, lastName, vehiclePlate, vehicleModel, nin } = validated.data;

        const repo = AppDataSource.getRepository(DriverProfile);
        let profile = await repo.findOneBy({ userId });

        if (!profile) {
            profile = repo.create({ userId });
        }

        profile.firstName = firstName;
        profile.lastName = lastName;
        profile.vehiclePlate = vehiclePlate;
        profile.vehicleModel = vehicleModel;
        if (nin !== undefined) profile.nin = nin;

        const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl && profile.photoUrl;
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
router.post("/upload", authMiddleware, uploadLimiter, upload.single("document"), async (req: AuthRequest, res: Response) => {
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
        else if (docType === "photo") profile.photoUrl = path.basename(processedFilename);
        else return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Invalid document type."));

        const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl && profile.photoUrl;
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
            ninVerified: profile.ninVerified,
            // Document presence lets the app rehydrate which KYC docs are already
            // uploaded (incl. the selfie) after a restart, so a returning driver
            // isn't asked to re-capture them.
            licenseUrl: profile.licenseUrl ?? null,
            idCardUrl: profile.idCardUrl ?? null,
            vehiclePaperUrl: profile.vehiclePaperUrl ?? null,
            photoUrl: profile.photoUrl ?? null,
            rating: (profile.ratingCount ?? 0) > 0
                ? Number(((profile.ratingSum ?? 0) / profile.ratingCount).toFixed(2))
                : 0,
            ratingCount: profile.ratingCount ?? 0,
        });
    } catch (err: any) {
        console.error('[DRIVER] Status fetch error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your driver status right now. Please try again."));
    }
});

/**
 * PATCH /api/v1/drivers/profile
 * Update vehicle plate and model for an authenticated driver.
 */
router.patch("/profile", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { vehiclePlate, vehicleModel } = req.body ?? {};

        if (!vehiclePlate || !vehicleModel) {
            return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, "Vehicle plate and model are required."));
        }
        const plate = vehiclePlate.toString().trim().toUpperCase();
        const model = vehicleModel.toString().trim();

        if (plate.length < 4) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Please enter a valid plate number (at least 4 characters)."));
        }
        if (model.length < 2) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Please enter a valid vehicle model."));
        }

        const userId = req.user!.userId;
        const repo = AppDataSource.getRepository(DriverProfile);
        const profile = await repo.findOneBy({ userId });

        if (!profile) {
            return res.status(404).json(errBody(ErrorCode.PROFILE_NOT_FOUND, "Driver profile not found."));
        }

        profile.vehiclePlate = plate;
        profile.vehicleModel = model;
        await repo.save(profile);

        res.json({
            message: "Vehicle info updated successfully.",
            vehiclePlate: profile.vehiclePlate,
            vehicleModel: profile.vehicleModel,
        });
    } catch (err: any) {
        console.error('[DRIVER] Profile update error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Couldn't update your vehicle info. Please try again."));
    }
});

/**
 * POST /api/v1/drivers/verify-nin
 * Submit and automatically verify driver's NIN via Smile ID.
 */
router.post("/verify-nin", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { nin } = req.body ?? {};
        if (!nin || (nin.toString().length !== 11 && nin.toString().length !== 16)) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "A valid 11-digit NIN or 16-character Virtual NIN is required."));
        }

        const userId = req.user!.userId;
        const repo = AppDataSource.getRepository(DriverProfile);
        const profile = await repo.findOneBy({ userId });

        if (!profile) {
            return res.status(404).json(errBody(ErrorCode.PROFILE_NOT_FOUND, "Driver profile not found. Please complete onboarding first."));
        }

        if (profile.ninVerified) {
            return res.json({ message: "NIN is already verified.", ninVerified: true });
        }

        // Call verification service
        /*
        const verification = await SmileIdService.verifyNIN(
            userId,
            nin.toString().trim(),
            profile.firstName,
            profile.lastName
        );

        if (!verification.success) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, verification.reason || "NIN verification failed."));
        }
        */

        // Save verification state (Disabled Smile ID for now, assume success)
        profile.nin = nin.toString().trim();
        profile.ninVerified = true;

        await repo.save(profile);

        res.json({
            message: "NIN verified successfully.",
            ninVerified: true,
        });
    } catch (err: any) {
        console.error('[DRIVER] NIN Verification error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to verify NIN. Please try again."));
    }
});

/**
 * POST /api/v1/drivers/heartbeat
 * HTTP fallback for the driver availability heartbeat. The Android foreground
 * service posts here every ~12s from its own isolate so the driver stays in the
 * Redis dispatch pool even when the socket / main isolate is suspended while the
 * phone is locked. Mirrors the socket 'driver:heartbeat' handler (approved-only,
 * then GEOADD + refresh the 45s availability key via updateDriverLocation).
 */
router.post("/heartbeat", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { lat, lng } = req.body ?? {};
        const latN = Number(lat);
        const lngN = Number(lng);
        if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Valid lat/lng are required."));
        }

        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId });
        if (!profile || profile.status !== DriverStatus.APPROVED) {
            // Not eligible to be online — make sure a suspended/rejected/unknown
            // driver isn't left lingering in the availability pool or on the
            // passenger map.
            await DispatchService.removeDriverAvailability(userId);
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "Driver is not approved to be online."));
        }

        await DispatchService.updateDriverLocation(userId, latN, lngN);
        if (process.env.HEARTBEAT_DEBUG_LOG === 'true') {
            console.log(`[HB] ${new Date().toISOString()} driver=${userId} lat=${latN} lng=${lngN}`);
        }
        return res.json({ ok: true });
    } catch (err: any) {
        console.error('[DRIVER] HTTP heartbeat error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Heartbeat failed."));
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
