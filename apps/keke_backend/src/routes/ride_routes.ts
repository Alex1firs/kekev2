import { Router, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { Ride } from "../models/Ride";
import { DriverProfile } from "../models/DriverProfile";
import { User } from "../models/User";
import { LedgerEntry } from "../models/LedgerEntry";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";
import { In } from "typeorm";
import { SettingService } from "../services/setting_service";


const router = Router();

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
router.get("/pricing-config", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const config = await SettingService.getPricingConfig();
        return res.status(200).json(config);
    } catch (err: any) {
        console.error('[RIDES] Pricing config error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load the pricing settings."));
    }
});

export default router;
