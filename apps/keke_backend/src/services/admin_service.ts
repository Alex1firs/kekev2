import { In } from "typeorm";
import { AppDataSource } from "../config/data_source";
import { DriverProfile, DriverStatus } from "../models/DriverProfile";
import { Ride, RideStatus } from "../models/Ride";
import { Wallet } from "../models/Wallet";
import { LedgerEntry, BalanceType, TransactionType } from "../models/LedgerEntry";
import { PayoutRecord, PayoutStatus } from "../models/PayoutRecord";
import { AuditLog } from "../models/AuditLog";
import { User, UserRole } from "../models/User";
import { DeviceToken } from "../models/DeviceToken";
import { NotificationService } from "./notification_service";
import { redis } from "../config/redis";
import { DispatchService } from "./dispatch_service";

export class AdminService {
    /**
     * Get overview stats (Daily Revenue, Live Rides, Online Drivers)
     */
    static async getOverview() {
        const activeRideCount = await AppDataSource.getRepository(Ride).count({
            where: [
                { status: RideStatus.SEARCHING },
                { status: RideStatus.ACCEPTED },
                { status: RideStatus.IN_PROGRESS },
                { status: RideStatus.ARRIVED },
            ]
        });
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
     * Get specific driver details, enriched with the linked user's contact info
     * (email + phone) so admins can fully verify identity before approval.
     */
    static async getDriverProfile(userId: string) {
        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId });
        if (!profile) return null;
        const user = await AppDataSource.getRepository(User).findOne({
            where: { id: userId },
            select: ["email", "phone"],
        });
        return {
            ...profile,
            email: user?.email ?? null,
            phone: user?.phone ?? null,
        };
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
    static async updateDriverStatus(userId: string, status: DriverStatus, reason?: string, adminId?: string) {
        const repo = AppDataSource.getRepository(DriverProfile);
        const profile = await repo.findOneBy({ userId });
        if (!profile) throw new Error("Driver profile not found");

        if (status === DriverStatus.APPROVED) {
            const allDocsPresent = profile.licenseUrl && profile.idCardUrl && profile.vehiclePaperUrl && profile.photoUrl;
            if (!allDocsPresent) {
                throw new Error("Cannot approve driver without all required documents (Selfie, License, ID, Vehicle Papers)");
            }
            // No external NIMC API yet: admin approval IS the NIN manual review.
            // Mark it reviewed so the driver app (which gates going online on
            // ninVerified) unblocks. Admin has seen the NIN + ID + selfie in review.
            profile.ninVerified = true;
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
          const auditRepo = AppDataSource.getRepository(AuditLog);
          let action = "UPDATE_DRIVER_STATUS";
          if (status === DriverStatus.APPROVED) action = "APPROVE_DRIVER";
          else if (status === DriverStatus.REJECTED) action = "REJECT_DRIVER";
          else if (status === DriverStatus.SUSPENDED) action = "SUSPEND_DRIVER";

          await auditRepo.save({
            adminId: adminId || "SYSTEM_ADMIN",
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

        // --- Push notification to the driver about their KYC/account decision ---
        // Fire-and-forget: never let a notification failure affect the status change.
        try {
          if (status === DriverStatus.APPROVED) {
            NotificationService.sendToUser(userId, UserRole.DRIVER, 'Account Approved',
              'Your driver account has been approved. You can now receive rides.',
              { type: 'DRIVER_APPROVED', intent: 'status' });
          } else if (status === DriverStatus.REJECTED) {
            NotificationService.sendToUser(userId, UserRole.DRIVER, 'KYC Review Update',
              'Your driver application needs attention. Open the app to view details.',
              { type: 'DRIVER_REJECTED', intent: 'status' });
          } else if (status === DriverStatus.SUSPENDED) {
            NotificationService.sendToUser(userId, UserRole.DRIVER, 'Account Suspended',
              'Your driver account has been suspended. Please contact support for details.',
              { type: 'DRIVER_SUSPENDED', intent: 'status' });
          }
        } catch (err) {
          console.error("Driver status notification failed (Operation Succeeded):", err);
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
        const [walletResult, platformResult] = await Promise.all([
            AppDataSource.getRepository(Wallet)
                .createQueryBuilder("w")
                .select("SUM(w.driverCommissionDebt)", "totalCommissionDebt")
                .addSelect("SUM(w.driverAvailableBalance)", "totalAvailableBalance")
                .addSelect("COUNT(*)", "activeWallets")
                .getRawOne(),
            AppDataSource.getRepository(LedgerEntry)
                .createQueryBuilder("le")
                .where("le.walletId = :walletId", { walletId: 'PLATFORM' })
                .andWhere("le.balanceType = :type", { type: BalanceType.PLATFORM_REVENUE })
                .select("SUM(le.amount)", "total")
                .getRawOne(),
        ]);

        return {
            totalCommissionDebt: parseFloat(walletResult?.totalCommissionDebt || "0"),
            totalAvailableBalance: parseFloat(walletResult?.totalAvailableBalance || "0"),
            activeWallets: parseInt(walletResult?.activeWallets || "0"),
            platformRevenue: parseFloat(platformResult?.total || "0"),
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
        const members = await redis.zrange("drivers:locations", 0, -1);
        const results = [];
        for (const userId of members) {
            const pos = await redis.geopos("drivers:locations", userId);
            if (pos && pos[0]) {
                results.push({ userId, lng: pos[0][0], lat: pos[0][1] });
            }
        }
        return results;
    }

    /**
     * Server-authoritative real-time view of APPROVED drivers for the admin
     * "Live Riders" dashboard. A driver is ACTIVELY_ONLINE only if their Redis
     * availability key is still alive (fresh heartbeat within the 45s TTL) —
     * never trusting the app's local "online" state. Everything is derived from
     * Redis + existing tables; no schema migration.
     */
    static async getLiveDrivers() {
        const TTL_MS = DispatchService.AVAILABILITY_TTL_SECONDS * 1000; // 45s
        const RECENTLY_SEEN_MS = 5 * 60 * 1000;   // <5 min since last heartbeat
        const STALE_MS = 15 * 60 * 1000;          // 5–15 min = stale/problem
        const now = Date.now();

        const thresholds = {
            availabilityTtlSeconds: DispatchService.AVAILABILITY_TTL_SECONDS,
            recentlySeenSeconds: RECENTLY_SEEN_MS / 1000,
            staleSeconds: STALE_MS / 1000,
        };

        // 1) Approved drivers are the eligible-to-be-online population.
        const profiles = await AppDataSource.getRepository(DriverProfile).find({
            where: { status: DriverStatus.APPROVED },
        });
        if (profiles.length === 0) {
            return { generatedAt: new Date(now).toISOString(), thresholds, counts: { total: 0, activelyOnline: 0, onTrip: 0, recentlySeen: 0, stale: 0, offline: 0, missingToken: 0 }, drivers: [] };
        }
        const ids = profiles.map(p => p.userId);

        // 2) Batch-load the relational context (no N+1).
        const [users, tokens, activeRides] = await Promise.all([
            AppDataSource.getRepository(User).find({ where: { id: In(ids) } }),
            AppDataSource.getRepository(DeviceToken).find({ where: { userId: In(ids), role: UserRole.DRIVER } }),
            AppDataSource.getRepository(Ride).find({
                where: { driverId: In(ids), status: In([RideStatus.ACCEPTED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS, RideStatus.STARTED]) },
            }),
        ]);
        const userMap = new Map(users.map(u => [u.id, u]));
        const rideMap = new Map(activeRides.map(r => [r.driverId, r]));
        const tokenMap = new Map<string, DeviceToken[]>();
        for (const t of tokens) {
            const arr = tokenMap.get(t.userId) || [];
            arr.push(t);
            tokenMap.set(t.userId, arr);
        }

        // 3) Batch-load Redis state: availability flag, its TTL, GEO position,
        //    and the persistent last-seen timestamp.
        const availVals = await redis.mget(...ids.map(id => `driver:available:${id}`));
        const lastSeenVals = await redis.mget(...ids.map(id => `driver:lastseen:${id}`));
        const offlineVals = await redis.mget(...ids.map(id => `driver:offline:${id}`));
        const pipe = redis.pipeline();
        ids.forEach(id => pipe.pttl(`driver:available:${id}`));
        ids.forEach(id => pipe.geopos("drivers:locations", id));
        const pipeRes = (await pipe.exec()) as Array<[Error | null, any]>;
        const ttls = pipeRes.slice(0, ids.length).map(r => Number(r?.[1] ?? -2));
        const geos = pipeRes.slice(ids.length).map(r => r?.[1]);

        const counts = { total: profiles.length, activelyOnline: 0, onTrip: 0, recentlySeen: 0, stale: 0, offline: 0, missingToken: 0 };

        const drivers = profiles.map((p, i) => {
            const u = userMap.get(p.userId);
            const fresh = availVals[i] === "true" && ttls[i] > 0;
            const lastSeen = lastSeenVals[i] ? Number(lastSeenVals[i]) : null;
            const wentOffline = !!offlineVals[i]; // deliberate go-offline tombstone
            const ageMs = lastSeen != null ? now - lastSeen : Infinity;

            const posPair = Array.isArray(geos[i]) ? geos[i][0] : null;
            const longitude = posPair ? parseFloat(posPair[0]) : null;
            const latitude = posPair ? parseFloat(posPair[1]) : null;

            // Heartbeat age: exact from the live TTL when fresh, else from last-seen.
            let heartbeatAgeSeconds: number | null = null;
            let lastHeartbeatAt: string | null = null;
            if (fresh) {
                heartbeatAgeSeconds = Math.max(0, Math.round((TTL_MS - ttls[i]) / 1000));
                lastHeartbeatAt = new Date(now - (TTL_MS - ttls[i])).toISOString();
            } else if (lastSeen != null) {
                heartbeatAgeSeconds = Math.round(ageMs / 1000);
                lastHeartbeatAt = new Date(lastSeen).toISOString();
            }

            const ride = rideMap.get(p.userId);
            const isActivelyOnline = fresh;

            let liveStatus: string;
            let reasonOffline: string | null = null;
            if (isActivelyOnline) {
                liveStatus = ride ? "ON_TRIP" : "ACTIVELY_ONLINE";
            } else if (wentOffline) {
                // Deliberately went offline — show Offline immediately regardless
                // of how recent the last heartbeat was.
                liveStatus = "OFFLINE";
                reasonOffline = "went_offline";
            } else if (lastSeen != null && ageMs < RECENTLY_SEEN_MS) {
                liveStatus = "RECENTLY_SEEN";
                reasonOffline = "heartbeat_expired";
            } else if (lastSeen != null && ageMs < STALE_MS) {
                liveStatus = "STALE_HEARTBEAT";
                reasonOffline = "heartbeat_stale";
            } else if (lastSeen != null) {
                liveStatus = "OFFLINE";
                reasonOffline = "heartbeat_long_expired";
            } else {
                liveStatus = "NEVER_SEEN";
                reasonOffline = "never_online";
            }

            const activeTokens = (tokenMap.get(p.userId) || []).filter(t => t.isActive);
            const anyToken = tokenMap.get(p.userId) || [];
            const fcmTokenStatus = activeTokens.length > 0 ? "active" : "missing";
            const platform = (activeTokens[0] || anyToken[0])?.platform ?? "unknown";

            // Tallies for the dashboard header.
            if (liveStatus === "ACTIVELY_ONLINE") counts.activelyOnline++;
            else if (liveStatus === "ON_TRIP") { counts.activelyOnline++; counts.onTrip++; }
            else if (liveStatus === "RECENTLY_SEEN") counts.recentlySeen++;
            else if (liveStatus === "STALE_HEARTBEAT") counts.stale++;
            else counts.offline++;
            if (fcmTokenStatus === "missing") counts.missingToken++;

            const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim()
                || (u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "")
                || "Unknown Driver";

            return {
                driverId: p.userId,
                userId: p.userId,
                name,
                phone: u?.phone ?? null,
                email: u?.email ?? null,
                status: p.status,
                isApproved: p.status === DriverStatus.APPROVED,
                liveStatus,
                isActivelyOnline,
                isHeartbeatFresh: fresh,
                lastHeartbeatAt,
                heartbeatAgeSeconds,
                latitude,
                longitude,
                humanReadableAddress: null, // reverse-geocoded client-side (Nominatim)
                currentRideId: ride?.rideId ?? null,
                currentRideStatus: ride?.status ?? null,
                rideState: ride ? "on_trip" : (isActivelyOnline ? "available" : "offline"),
                fcmTokenStatus,
                platform,
                // App-only fields not yet reported by the heartbeat payload:
                appVersion: null,
                onlineIntent: null,
                batteryOptimization: null,
                socketStatus: null,
                reasonOffline,
            };
        });

        const rank: Record<string, number> = { ACTIVELY_ONLINE: 0, ON_TRIP: 1, RECENTLY_SEEN: 2, STALE_HEARTBEAT: 3, OFFLINE: 4, NEVER_SEEN: 5 };
        drivers.sort((a, b) => (rank[a.liveStatus] - rank[b.liveStatus]) || a.name.localeCompare(b.name));

        return { generatedAt: new Date(now).toISOString(), thresholds, counts, drivers };
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

    /**
     * Update payout status (admin action: processing / success / failed)
     */
    static async updatePayoutStatus(payoutId: string, status: PayoutStatus, adminId: string): Promise<PayoutRecord> {
        return await AppDataSource.transaction(async (manager) => {
            const payout = await manager.findOne(PayoutRecord, { where: { id: payoutId } });
            if (!payout) throw new Error('Payout record not found');

            const allowedTransitions: Record<string, PayoutStatus[]> = {
                [PayoutStatus.PENDING]:    [PayoutStatus.PROCESSING, PayoutStatus.FAILED],
                [PayoutStatus.PROCESSING]: [PayoutStatus.SUCCESS, PayoutStatus.FAILED],
            };
            if (!allowedTransitions[payout.status]?.includes(status)) {
                throw new Error(`Cannot transition payout from ${payout.status} to ${status}`);
            }

            payout.status = status;
            await manager.save(payout);

            // Settle the pending balance on terminal transitions
            if (status === PayoutStatus.SUCCESS || status === PayoutStatus.FAILED) {
                const wallet = await manager.findOne(Wallet, {
                    where: { userId: payout.driverId },
                    lock: { mode: 'pessimistic_write' },
                });
                if (wallet) {
                    const amount = Number(payout.amount);
                    const pendingBefore = Number(wallet.driverPendingBalance);
                    const deducted = Math.min(pendingBefore, amount);

                    if (status === PayoutStatus.SUCCESS) {
                        // Money sent — clear pending
                        wallet.driverPendingBalance = pendingBefore - deducted;
                        await manager.save(wallet);
                        await manager.save(manager.create(LedgerEntry, {
                            walletId: payout.driverId,
                            balanceType: BalanceType.DRIVER_PENDING,
                            transactionType: TransactionType.PAYOUT,
                            amount: -deducted,
                            balanceBefore: pendingBefore,
                            balanceAfter: wallet.driverPendingBalance,
                            metadata: { source: 'payout_success', payoutId },
                        }));
                    } else {
                        // Transfer failed — refund pending back to available
                        const availBefore = Number(wallet.driverAvailableBalance);
                        wallet.driverPendingBalance   = pendingBefore - deducted;
                        wallet.driverAvailableBalance = availBefore + deducted;
                        await manager.save(wallet);
                        await manager.save(manager.create(LedgerEntry, {
                            walletId: payout.driverId,
                            balanceType: BalanceType.DRIVER_PENDING,
                            transactionType: TransactionType.PAYOUT,
                            amount: -deducted,
                            balanceBefore: pendingBefore,
                            balanceAfter: wallet.driverPendingBalance,
                            metadata: { source: 'payout_failed', payoutId },
                        }));
                        await manager.save(manager.create(LedgerEntry, {
                            walletId: payout.driverId,
                            balanceType: BalanceType.DRIVER_AVAILABLE,
                            transactionType: TransactionType.PAYOUT,
                            amount: deducted,
                            balanceBefore: availBefore,
                            balanceAfter: wallet.driverAvailableBalance,
                            metadata: { source: 'payout_refund', payoutId },
                        }));
                    }
                }
            }

            await manager.save(manager.create(AuditLog, {
                adminId,
                action: `PAYOUT_${status.toUpperCase()}`,
                entityType: 'PAYOUT',
                entityId: payoutId,
                details: { amount: payout.amount, driverId: payout.driverId, status },
            }));

            return payout;
        });
    }
}
