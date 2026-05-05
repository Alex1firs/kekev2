import { Router, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { Ride } from "../models/Ride";
import { DriverProfile } from "../models/DriverProfile";
import { LedgerEntry } from "../models/LedgerEntry";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { In } from "typeorm";

const router = Router();

/**
 * GET /api/v1/rides/active/passenger
 * Returns the most recent active ride for the authenticated passenger, with driver details.
 */
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

        if (!ride) {
            return res.status(200).json({});
        }

        let driverDetails = null;
        if (ride.driverId) {
            const driver = await AppDataSource.getRepository(DriverProfile).findOne({
                where: { userId: ride.driverId }
            });
            if (driver) {
                driverDetails = {
                    name: `${driver.firstName} ${driver.lastName}`,
                    plate: driver.vehiclePlate,
                    model: driver.vehicleModel
                };
            }
        }

        return res.status(200).json({ ...ride, driverDetails });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/rides/active/driver
 * Returns the most recent active ride assigned to the authenticated driver.
 */
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
        return res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/rides/history/driver
 * Last 50 completed/canceled rides for the authenticated driver.
 */
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
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /api/v1/rides/history/passenger
 * Last 50 completed/canceled rides for the authenticated passenger.
 */
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
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * GET /api/v1/rides/:rideId/receipt
 * Full receipt data for a completed ride. Accessible by the passenger or driver on that ride.
 */
router.get("/:rideId/receipt", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { rideId } = req.params;

        const ride = await AppDataSource.getRepository(Ride).findOne({
            where: { rideId: rideId as string }
        });

        if (!ride) {
            return res.status(404).json({ error: "Ride not found" });
        }

        // Only the passenger or assigned driver may fetch the receipt
        if (ride.passengerId !== userId && ride.driverId !== userId) {
            return res.status(403).json({ error: "Forbidden" });
        }

        // Fetch driver details for display
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

        // Fetch relevant ledger entries for this ride to show financial breakdown
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
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;
