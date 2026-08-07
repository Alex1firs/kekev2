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
import { NearbyKekeFeedService } from "../services/nearby_keke_feed_service";
import { coordinationSnapshot, coordinationCopy, CoordinationStage } from "../services/ride_coordination_contract";
import { loadStaleRideConfig } from "../config/stale_ride_config";
import { ContactAccessService } from "../services/contact_access_service";
import { AppError } from "../utils/errors";
import { redis } from '../config/redis';
import { DispatchService } from '../services/dispatch_service';


const router = Router();

/**
 * The app-facing coordination block for one ride, or null when there is nothing
 * to coordinate.
 *
 * Built server-side on purpose. The apps must not re-derive which actions are
 * permitted — that logic lives in StaleRideService and the coordination
 * contract, and a second copy on a phone would drift from it the first time a
 * threshold changed. The phone renders what this returns.
 */
function buildCoordination(ride: Ride, role: 'passenger' | 'driver', canCall: boolean) {
    const snapshot = coordinationSnapshot(ride, loadStaleRideConfig());
    if (snapshot.stage === CoordinationStage.NONE) return null;
    // A trip that is under way is never in a delayed-pickup conversation. It can
    // be flagged for a human, but it is never cancelled on a timer, so showing
    // any of this to either party would be actively misleading.
    if (!['accepted', 'arrived'].includes(snapshot.rideStatus)) return null;
    const copy = coordinationCopy(snapshot, role, { canCall });
    if (!copy) return null;
    return { ...snapshot, ...copy, role };
}


/** Computed driver star average (0 when the driver has no reviews yet). */
function driverAverage(driver: { ratingSum?: number; ratingCount?: number }): number {
    const count = driver.ratingCount ?? 0;
    if (count <= 0) return 0;
    return Number(((driver.ratingSum ?? 0) / count).toFixed(2));
}


/**
 * How long ago this driver's GPS last reached us, in seconds.
 *
 * Lets a passenger app tell two very different failures apart: "my socket is
 * stale" and "the driver's phone stopped publishing". They look identical on a
 * frozen map, and the remedies are opposite — one is a reconnect, the other is
 * a call to the driver.
 *
 * Null when unknown. Never throws: a diagnostics field must not be able to
 * break active-ride recovery.
 */
async function driverGpsAgeSeconds(driverId: string | null | undefined): Promise<number | null> {
    if (!driverId) return null;
    try {
        const raw = await redis.get(`${DispatchService.DRIVER_LASTSEEN_PREFIX}${driverId}`);
        if (!raw) return null;
        const age = Math.round((Date.now() - Number(raw)) / 1000);
        return Number.isFinite(age) && age >= 0 ? age : null;
    } catch {
        return null;
    }
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

        /*
         * Recovery telemetry.
         *
         * Every active-ride recovery in the passenger app IS a call to this
         * endpoint, so this is the one place that sees all of them. The app's
         * own analytics only reach a device console; operations needs the
         * server view to answer "are passengers repeatedly failing to recover
         * their rides".
         *
         * `source` is a hint from the client (cold_start, app_resume, …). It is
         * logged, never trusted, and never used to change behaviour.
         */
        const source = String(req.query.source ?? 'unspecified').slice(0, 40);

        if (!ride) {
            console.log(JSON.stringify({
                level: 'info', scope: 'active_ride_recovery',
                event: 'active_ride_recovery_none', source,
                // The passenger id only. No name, phone or email.
                passengerId: req.user!.userId,
            }));
            return res.status(200).json({});
        }

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

        // The authoritative coordination read. Attached here so a cold start or a
        // reconnect restores the delayed-ride UI in the SAME round trip that
        // restores the ride — an app that had to make two calls would flash the
        // ordinary tracking screen in between.
        const coordination = buildCoordination(ride, 'passenger', driverDetails?.phone != null);

        console.log(JSON.stringify({
            level: 'info', scope: 'active_ride_recovery',
            event: 'active_ride_recovery_found', source,
            rideId: ride.rideId, status: ride.status,
            hasDriver: driverDetails != null,
            hasCoordination: coordination != null,
            passengerId: req.user!.userId,
        }));

        return res.status(200).json({
            ...ride,
            driverDetails,
            coordination,
            // Diagnostics, not ride state. See driverGpsAgeSeconds.
            driverGpsAgeSeconds: await driverGpsAgeSeconds(ride.driverId),
        });
    } catch (err: any) {
        console.error(JSON.stringify({
            level: 'error', scope: 'active_ride_recovery',
            event: 'active_ride_recovery_failed',
            source: String(req.query.source ?? 'unspecified').slice(0, 40),
            error: err?.message,
        }));
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
        if (!ride) return res.status(200).json({});

        // Contact for the ride the driver is ACTUALLY on.
        //
        // This also closes an existing gap: the driver app builds its call
        // button from the dispatch offer payload, so a driver whose app
        // restarted mid-ride previously lost the ability to phone their
        // passenger entirely. Recovery now carries the number, which is both a
        // fix and the precondition for removing it from the offer payload.
        let passengerContact: unknown = null;
        try {
            passengerContact = await ContactAccessService.passengerContactForAssignedDriver(
                ride.rideId,
                req.user!.userId,
                { ipAddress: req.ip ?? null, correlationId: (req as any).requestId ?? null },
            );
        } catch (err: any) {
            // A contact lookup must never break active-ride recovery.
            console.warn('[RIDES] active driver contact unavailable:', err?.message);
        }

        return res.status(200).json({
            ...ride,
            coordination: buildCoordination(ride, 'driver', true),
            passengerContact,
        });
    } catch (err: any) {
        console.error('[RIDES] Active driver ride error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your active ride. Please try again."));
    }
});

/**
 * GET /rides/:rideId/contact
 *
 * The assignment-time contact channel: the real passenger number, for the
 * driver who actually holds the ride, recorded as a ContactRevealEvent.
 *
 * This is the replacement for shipping `passengerPhone` inside every dispatch
 * offer. Once the driver fleet calls this endpoint, CONTACT_PRIVACY_MODE can be
 * moved to `strict` and candidate drivers stop receiving contact data entirely.
 * See docs/contact_privacy_migration.md.
 */
router.get("/:rideId/contact", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const contact = await ContactAccessService.passengerContactForAssignedDriver(
            String(req.params.rideId),
            req.user!.userId,
            { ipAddress: req.ip ?? null, correlationId: (req as any).requestId ?? null },
        );
        return res.status(200).json(contact);
    } catch (err: any) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json(errBody(err.code, err.message));
        }
        console.error('[RIDES] Contact lookup error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load contact details. Please try again."));
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

/**
 * GET /api/v1/rides/:rideId/coordination
 *
 * The authoritative delayed-ride / decision state for one ride, for the party
 * asking. Used on app launch, on socket reconnect and after a process restart:
 * the app throws away whatever it had in memory and renders this instead.
 *
 * Deadlines come back as absolute server timestamps so a countdown resumes where
 * it really is rather than restarting, and `decisionOpen` tells the app whether a
 * prompt it remembers is still worth showing — a resolved decision must not be
 * replayed at someone who already answered it.
 */
router.get("/:rideId/coordination", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const ride = await AppDataSource.getRepository(Ride)
            .findOne({ where: { rideId: String(req.params.rideId) } });
        if (!ride) {
            return res.status(404).json(errBody(ErrorCode.NOT_FOUND, "Ride not found."));
        }

        // Only the two people on this ride. Coordination state says where someone
        // is and whether they are answering their phone.
        const userId = req.user!.userId;
        const role: 'passenger' | 'driver' | null = ride.passengerId === userId
            ? 'passenger'
            : ride.driverId === userId ? 'driver' : null;
        if (role == null) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "This ride is not yours."));
        }

        let canCall = true;
        if (role === 'passenger' && ride.driverId) {
            const driverUser = await AppDataSource.getRepository(User)
                .findOne({ where: { id: ride.driverId } });
            canCall = !!driverUser?.phone;
        }

        return res.status(200).json({
            rideId: ride.rideId,
            rideStatus: ride.status,
            role,
            coordination: buildCoordination(ride, role, canCall),
        });
    } catch (err: any) {
        console.error('[RIDES] Coordination state error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load this ride's status. Please try again."));
    }
});

/**
 * GET /api/v1/rides/:rideId/nearby-kekes
 *
 * Read-only, privacy-safe map feed of genuinely dispatch-eligible Kekes near a
 * SEARCHING ride, for passenger reassurance while dispatch works.
 *
 * Returns anonymous, approximated marker positions and an honest count. No
 * driver id, name, phone, plate, rating, photo, heading or history — and no
 * indication of whether any particular driver was offered the ride. The search
 * area comes from the server's own dispatch context, so a client cannot widen it.
 *
 * Only the ride's passenger may read it, and only while the ride is searching:
 * once a driver accepts, the assigned-driver tracking flow takes over and this
 * returns 409 so the app stops showing unrelated supply.
 */
router.get("/:rideId/nearby-kekes", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { rideId } = req.params;

        const ride = await AppDataSource.getRepository(Ride).findOne({
            where: { rideId: rideId as string },
        });

        if (!ride) {
            return res.status(404).json(errBody(ErrorCode.RIDE_NOT_FOUND, "Ride not found."));
        }
        // Passenger only: a driver has no reason to enumerate nearby competitors.
        if (ride.passengerId !== userId) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "Access denied."));
        }
        if ((ride.status as unknown as string) !== "searching") {
            return res.status(409).json(
                errBody(ErrorCode.VALIDATION_ERROR, "Ride is not searching."),
            );
        }

        const feed = await NearbyKekeFeedService.forSearchingRide({
            rideId: ride.rideId,
            pickupLat: Number(ride.pickupLat),
            pickupLng: Number(ride.pickupLng),
            paymentMode: ride.paymentMode as unknown as string,
        });

        return res.json(feed);
    } catch (err: any) {
        console.error('[RIDE] nearby-kekes error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to load nearby Kekes."));
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
