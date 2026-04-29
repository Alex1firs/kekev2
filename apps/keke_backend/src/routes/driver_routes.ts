import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { DriverProfile, DriverStatus } from "../models/DriverProfile";
import { onboardingLimiter } from "../middleware/rate_limit";
import { upload } from "../middleware/upload_middleware";
import { driverOnboardingSchema } from "../services/validation_service";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import path from "path";
import fs from "fs";
import sharp from "sharp";

const router = Router();

/**
 * POST /api/v1/drivers/onboarding
 * Submit driver profile for review.
 */
router.post("/onboarding", authMiddleware, onboardingLimiter, async (req: AuthRequest, res: Response) => {
    try {
        // Strict Validation
        const validated = driverOnboardingSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ error: "Validation Failed", details: validated.error.format() });
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

        // Clear rejection reason on resubmission
        profile.rejectionReason = "";

        await repo.save(profile);

        res.json({ message: "Onboarding submitted successfully", status: profile.status });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/v1/drivers/upload
 * Upload specific document type.
 */
router.post("/upload", authMiddleware, onboardingLimiter, upload.single("document"), async (req: AuthRequest, res: Response) => {
    try {
        const { userId, docType } = req.body;
        if (!userId || !docType || !req.file) {
            return res.status(400).json({ error: "Missing userId, docType, or file" });
        }

        if (req.user!.userId !== userId) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const repo = AppDataSource.getRepository(DriverProfile);
        let profile = await repo.findOneBy({ userId });
        if (!profile) return res.status(404).json({ error: "Profile not found. Onboard first." });

        // KYC Image Processing (Sharp)
        // We compress the image but keep high enough quality for text readability.
        const originalPath = req.file.path;
        const processedFilename = path.basename(`proc_${req.file.filename}`);
        const processedPath = path.join(path.dirname(originalPath), processedFilename);

        await sharp(originalPath)
            .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(processedPath);

        // Remove original, keep processed
        fs.unlinkSync(originalPath);

        // Update specific document field
        if (docType === "license") profile.licenseUrl = path.basename(processedFilename);
        else if (docType === "id_card") profile.idCardUrl = path.basename(processedFilename);
        else if (docType === "vehicle_paper") profile.vehiclePaperUrl = path.basename(processedFilename);
        else return res.status(400).json({ error: "Invalid docType" });

        // Check for complete documentation
        const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl;
        if (allDocsPresent) {
            profile.status = DriverStatus.PENDING_REVIEW;
        }

        await repo.save(profile);

        res.json({
            message: "Document uploaded successfully",
            docType,
            filename: processedFilename,
            status: profile.status
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
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

        res.json({
            status: profile.status,
            rejectionReason: profile.rejectionReason,
            vehiclePlate: profile.vehiclePlate,
            vehicleModel: profile.vehicleModel,
            firstName: profile.firstName,
            lastName: profile.lastName,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
