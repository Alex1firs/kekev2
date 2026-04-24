import { AppDataSource } from "../config/data_source";
import { DriverProfile, DriverStatus } from "../models/DriverProfile";
import { Ride, RideStatus } from "../models/Ride";
import { Wallet } from "../models/Wallet";
import { PayoutRecord } from "../models/PayoutRecord";
import { redis } from "../config/redis";

export class AdminService {
    /**
     * Get overview stats (Daily Revenue, Live Rides, Online Drivers)
     */
    static async getOverview() {
        const activeRideCount = (await redis.keys("ride:*:lock")).length;
        const onlineDriverCount = (await redis.zcount("drivers:locations", "-inf", "+inf")) || 0;
        
        // Simple daily revenue from today's completed rides
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const dailyRevenue = await AppDataSource.getRepository(Ride)
            .createQueryBuilder("ride")
            .where("ride.status = :status", { status: RideStatus.COMPLETED })
            .andWhere("ride.completedAt >= :todayStart", { todayStart })
            .select("SUM(ride.fare * 0.10)", "total")
            .getRawOne();

        return {
            activeRides: activeRideCount,
            onlineDrivers: onlineDriverCount,
            dailyRevenue: parseFloat(dailyRevenue?.total || "0"),
            systemStatus: "healthy"
        };
    }

    /**
     * Get specific driver details
     */
    static async getDriverProfile(userId: string) {
        return await AppDataSource.getRepository(DriverProfile).findOneBy({ userId });
    }

    /**
     * Get drivers by status (e.g., PENDING_REVIEW or PENDING_DOCUMENTS)
     */
    static async getDriversByStatus(status: DriverStatus) {
        return await AppDataSource.getRepository(DriverProfile).find({
            where: { status },
            order: { createdAt: "ASC" }
        });
    }

    /**
     * Approve or Reject a driver
     * Logic: Mutation first, Audit Log second.
     */
    static async updateDriverStatus(userId: string, status: DriverStatus, reason?: string) {
        const repo = AppDataSource.getRepository(DriverProfile);
        const profile = await repo.findOneBy({ userId });
        if (!profile) throw new Error("Driver profile not found");

        if (status === DriverStatus.APPROVED) {
            const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl;
            if (!allDocsPresent) {
                throw new Error("Cannot approve driver without all required documents (License, ID, Vehicle Papers)");
            }
        }

        const oldStatus = profile.status;
        profile.status = status;
        
        // Clear rejection reason if move back to review or approved or suspended (new reason will be set)
        if (status !== DriverStatus.REJECTED) {
            profile.rejectionReason = reason || "";
        } else if (reason) {
            profile.rejectionReason = reason;
        }
        
        const saved = await repo.save(profile);
        
        // --- Audit Logging (Successful Mutation) ---
        try {
          const auditRepo = AppDataSource.getRepository(require("../models").AuditLog);
          let action = "UPDATE_DRIVER_STATUS";
          if (status === DriverStatus.APPROVED) action = "APPROVE_DRIVER";
          else if (status === DriverStatus.REJECTED) action = "REJECT_DRIVER";
          else if (status === DriverStatus.SUSPENDED) action = "SUSPEND_DRIVER";

          await auditRepo.save({
            adminId: "SYSTEM_ADMIN",
            action,
            entityType: "DRIVER_PROFILE",
            entityId: userId,
            details: {
              oldStatus,
              newStatus: status,
              reason: reason || "none"
            }
          });
        } catch (err) {
          console.error("Audit logging failed (Operation Succeeded):", err);
        }

        return saved;
    }

    /**
     * Get active rides from Redis state (Hybrid)
     */
    static async getActiveRides() {
        const { MoreThan } = require("typeorm");
        // Only show rides that have heartbeat/updates in the last 6 hours to prevent dashboard clog
        const recentlyActiveThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000);

        return await AppDataSource.getRepository(Ride).find({
            where: [
                { status: RideStatus.ACCEPTED, updatedAt: MoreThan(recentlyActiveThreshold) },
                { status: RideStatus.STARTED, updatedAt: MoreThan(recentlyActiveThreshold) },
                { status: RideStatus.SEARCHING, updatedAt: MoreThan(recentlyActiveThreshold) }
            ],
            order: { updatedAt: "DESC" }
        });
    }

    /**
     * Get Ride History (Last 100)
     */
    static async getRideHistory() {
        return await AppDataSource.getRepository(Ride).find({
            order: { createdAt: "DESC" },
            take: 100
        });
    }

    /**
     * Get Finance Summary
     */
    static async getFinanceSummary() {
        const wallets = await AppDataSource.getRepository(Wallet).find();
        
        const totalCommissionDebt = wallets.reduce((acc, w) => acc + Number(w.driverCommissionDebt), 0);
        const totalAvailableBalance = wallets.reduce((acc, w) => acc + Number(w.driverAvailableBalance), 0);

        return {
            totalCommissionDebt,
            totalAvailableBalance,
            activeWallets: wallets.length
        };
    }

    /**
     * Get Debt Leaderboard
     */
    static async getDebtLeaderboard() {
        return await AppDataSource.getRepository(Wallet).find({
            order: { driverCommissionDebt: "DESC" },
            take: 20
        });
    }

    /**
     * Get Online Drivers (Redis + Profile Join)
     */
    static async getOnlineDrivers() {
        const locations = await redis.zrange("drivers:locations", 0, -1, "WITHSCORES");
        const results = [];
        
        // ZRANGE returns [member, score, member, score, ...]
        for (let i = 0; i < locations.length; i += 2) {
            const userId = locations[i];
            results.push({ userId, location: locations[i+1] });
        }
        return results;
    }

    /**
     * Get Payout Records
     */
    static async getPayouts() {
        return await AppDataSource.getRepository(PayoutRecord).find({
            order: { createdAt: "DESC" },
            take: 50
        });
    }
}
