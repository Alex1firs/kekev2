import { Router, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { Ride } from "../models/Ride";
import { DriverProfile } from "../models/DriverProfile";
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

        // If driver is assigned, fetch rich details for mobile "healing"
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

        return res.status(200).json({
            ...ride,
            driverDetails
        });
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
        // Always return 200, even if ride is null
        return res.status(200).json(ride || {});
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

export default router;
