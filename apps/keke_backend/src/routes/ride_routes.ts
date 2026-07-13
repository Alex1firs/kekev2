import { Router, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { Ride } from "../models/Ride";
import { RideReview } from "../models/RideReview";
import { DriverProfile } from "../models/DriverProfile";
import { User } from "../models/User";
import { LedgerEntry } from "../models/LedgerEntry";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";
import { In } from "typeorm";
import { SettingService } from "../services/setting_service";


const router = Router();

/** Computed driver star average (0 when the driver has no reviews yet). */
function driverAverage(driver: { ratingSum?: number; ratingCount?: number }): number {
    const count = driver.ratingCount ?? 0;
    if (count <= 0) return 0;
    return Number(((driver.ratingSum ?? 0) / count).toFixed(2));
}

router.get("/active/passenger", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({
            where: {
                passengerId: req.user!.userId,
                status: In(["searching", "accepted", "arrived", "in_progress", "started"])
            },
            order: { createdAt: "DESC" }
        });

        if (!ride) return res.status(200).json({});

        let driverDetails = null;
        if (ride.driverId) {
            const [driver, driverUser] = await Promise.all([
                AppDataSource.getRepository(DriverProfile).findOne({ where: { userId: ride.driverId } }),
                AppDataSource.getRepository(User).findOne({ where: { id: ride.driverId } }),
            ]);
            if (driver) {
                driverDetails = {
                    name: `${driver.firstName} ${driver.lastName}`,
                    plate: driver.vehiclePlate,
                    model: driver.vehicleModel,
                    phone: driverUser?.phone ?? null,
                    // Include the verified KYC selfie so the passenger still sees
                    // the driver photo after a reconnect / app resume (the live
                    // `ride:assigned` socket event already sends this; this REST
                    // fallback previously omitted it, so the photo vanished).
                    photoUrl: driver.photoUrl ?? null,
                    rating: driverAverage(driver),
                    ratingCount: driver.ratingCount ?? 0,
                };
            }
        }

        return res.status(200).json({ ...ride, driverDetails });
    } catch (err: any) {
        console.error('[RIDES] Active passenger ride error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your active ride. Please try again."));
    }
});

router.get("/active/driver", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const ride = await AppDataSource.getRepository(Ride).findOne({
            where: {
                driverId: req.user!.userId,
                status: In(["accepted", "arrived", "in_progress", "started"])
            },
            order: { createdAt: "DESC" }
        });
        return res.status(200).json(ride || {});
    } catch (err: any) {
        console.error('[RIDES] Active driver ride error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your active ride. Please try again."));
    }
});

router.get("/history/driver", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const rides = await AppDataSource.getRepository(Ride).find({
            where: {
                driverId: req.user!.userId,
                status: In(["completed", "canceled", "failed"])
            },
            order: { createdAt: "DESC" },
            take: 50,
        });
        return res.status(200).json(rides);
    } catch (err: any) {
        console.error('[RIDES] Driver history error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your trip history. Please try again."));
    }
});

router.get("/history/passenger", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const rides = await AppDataSource.getRepository(Ride).find({
            where: {
                passengerId: req.user!.userId,
                status: In(["completed", "canceled", "failed"])
            },
            order: { createdAt: "DESC" },
            take: 50,
        });
        return res.status(200).json(rides);
    } catch (err: any) {
        console.error('[RIDES] Passenger history error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your trip history. Please try again."));
    }
});

router.get("/:rideId/receipt", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { rideId } = req.params;

        const ride = await AppDataSource.getRepository(Ride).findOne({
            where: { rideId: rideId as string }
        });

        if (!ride) {
            return res.status(404).json(errBody(ErrorCode.RIDE_NOT_FOUND, "Receipt not found."));
        }

        if (ride.passengerId !== userId && ride.driverId !== userId) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "Access denied."));
        }

        let driverInfo: any = null;
        if (ride.driverId) {
            const driver = await AppDataSource.getRepository(DriverProfile).findOne({
                where: { userId: ride.driverId }
            });
            if (driver) {
                driverInfo = {
                    name: `${driver.firstName} ${driver.lastName}`,
                    plate: driver.vehiclePlate,
                    model: driver.vehicleModel,
                    rating: driverAverage(driver),
                    ratingCount: driver.ratingCount ?? 0,
                };
            }
        }

        const ledgerEntries = await AppDataSource.getRepository(LedgerEntry)
            .createQueryBuilder("entry")
            .where("entry.metadata->>'rideId' = :rideId", { rideId })
            .orderBy("entry.createdAt", "ASC")
            .getMany();

        return res.status(200).json({
            rideId: ride.rideId,
            status: ride.status,
            fare: ride.fare,
            paymentMode: ride.paymentMode,
            paymentFailed: ride.paymentFailed,
            pickupAddress: ride.pickupAddress,
            destinationAddress: ride.destinationAddress,
            completedAt: ride.completedAt,
            createdAt: ride.createdAt,
            driver: driverInfo,
            ledger: ledgerEntries,
        });
    } catch (err: any) {
        console.error('[RIDES] Receipt error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your receipt. Please try again."));
    }
});

/**
 * GET /api/v1/rides/pricing-config
 * Returns current dynamic pricing configurations.
 */
router.get("/pricing-config", async (req: AuthRequest, res: Response) => {
    try {
        const config = await SettingService.getPricingConfig();
        return res.status(200).json(config);
    } catch (err: any) {
        console.error('[RIDES] Pricing config error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load the pricing settings."));
    }
});

/**
 * POST /api/v1/rides/:rideId/review
 * Passenger rates the driver for a completed ride. One review per ride
 * (idempotent on rideId). Updates the driver's denormalized rating aggregates
 * in the same transaction so the average is always exact.
 */
const ALLOWED_TAGS = new Set([
    "reckless_driving", "unclean_vehicle", "rude_behavior",
    "long_wait", "overcharged", "unsafe_vehicle", "great_service",
]);

router.post("/:rideId/review", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const passengerId = req.user!.userId;
        const rideId = String(req.params.rideId);

        // --- validate input ---
        const stars = Number((req.body ?? {}).stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Please pick a rating between 1 and 5 stars."));
        }
        const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];
        const tags = rawTags
            .filter((t: unknown): t is string => typeof t === "string" && ALLOWED_TAGS.has(t))
            .slice(0, 6);
        let comment: string | null = null;
        if (typeof req.body?.comment === "string") {
            const trimmed = req.body.comment.trim();
            comment = trimmed.length ? trimmed.slice(0, 500) : null;
        }

        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });
        if (!ride) {
            return res.status(404).json(errBody(ErrorCode.NOT_FOUND, "Ride not found."));
        }
        if (ride.passengerId !== passengerId) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "You can only review your own rides."));
        }
        if (ride.status !== "completed") {
            return res.status(409).json(errBody(ErrorCode.VALIDATION_ERROR, "You can only review a completed ride."));
        }
        if (!ride.driverId) {
            return res.status(409).json(errBody(ErrorCode.VALIDATION_ERROR, "This ride has no driver to review."));
        }

        // --- persist review + bump driver aggregates atomically ---
        let alreadyReviewed = false;
        await AppDataSource.transaction(async (manager) => {
            const existing = await manager.getRepository(RideReview).findOne({ where: { rideId } });
            if (existing) { alreadyReviewed = true; return; }

            await manager.getRepository(RideReview).insert({
                rideId,
                passengerId,
                driverId: ride.driverId,
                stars,
                tags,
                comment,
            });
            await manager.getRepository(DriverProfile)
                .createQueryBuilder()
                .update()
                .set({
                    ratingSum: () => `"ratingSum" + ${stars}`,
                    ratingCount: () => `"ratingCount" + 1`,
                })
                .where("userId = :userId", { userId: ride.driverId })
                .execute();
        });

        if (alreadyReviewed) {
            return res.status(409).json(errBody(ErrorCode.VALIDATION_ERROR, "You have already reviewed this ride."));
        }

        const profile = await AppDataSource.getRepository(DriverProfile).findOne({ where: { userId: ride.driverId } });
        const count = profile?.ratingCount ?? 1;
        const sum = profile?.ratingSum ?? stars;
        const average = count > 0 ? Number((sum / count).toFixed(2)) : 0;

        return res.status(201).json({ ok: true, driverAverageRating: average, driverRatingCount: count });
    } catch (err: any) {
        console.error('[RIDES] Review error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't save your review. Please try again."));
    }
});

export default router;
