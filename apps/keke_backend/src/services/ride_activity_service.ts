/**
 * Evidence that a ride is still alive.
 *
 * The premise of the whole coordination model: a ride is two people working
 * something out in the real world. Traffic, a police checkpoint, road works,
 * rain, a passenger still inside a building, a driver at a locked gate, security
 * clearance, a slow lift, office reception — all normal. So the system looks for
 * evidence of ABANDONMENT, and treats elapsed time only as a reason to talk.
 *
 * Three kinds of evidence, deliberately not equivalent:
 *
 *   LIVENESS  the app is alive — heartbeat, socket, a location fix.
 *             Proves NOT abandoned. Extends no deadline.
 *   APPROACH  distance to pickup genuinely shrinking.
 *             Proves the driver is actually coming. Extends the deadline.
 *   INTENT    a deliberate human action — "still coming", "keep waiting", a
 *             call, a message, arrival. Extends the deadline.
 *
 * The distinction is the point. An open app is not a driver who is coming: a
 * driver parked at home emits location updates indefinitely, and counting those
 * as activity would let them hold a passenger's booking forever. Approach and
 * intent are the signals that mean something.
 *
 * Hot signals live in Redis (a heartbeat every 12s per driver must not become a
 * database write); anything an operator or auditor needs is mirrored to the ride
 * row and the dispatch event log.
 */
import { redis } from '../config/redis';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DispatchService } from './dispatch_service';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { DispatchEventType } from '../models/DispatchEvent';
import { RideActivityType, ActivityKind, StaleRideConfig } from '../config/stale_ride_config';
import { getDriverLiveLocation } from './ride_integrity_service';

const APPROACH_PREFIX = 'ride:approach:';
/** Long enough to outlive any plausible pickup approach. */
const APPROACH_TTL_SECONDS = 3 * 60 * 60;

export interface PartyLiveness {
    /** Any sign of life at all — heartbeat, socket presence, a location fix. */
    live: boolean;
    /** How long with no sign of life, in ms. Null when live. */
    offlineForMs: number | null;
    /** What told us they were alive. */
    via: 'heartbeat' | 'socket' | 'recent_activity' | null;
}

/** Injected by the socket handler: is this user's socket connected right now? */
export type SocketPresenceProbe = (role: 'passenger' | 'driver', userId: string) => Promise<boolean>;

export class RideActivityService {
    private static presenceProbe: SocketPresenceProbe | null = null;

    static setPresenceProbe(probe: SocketPresenceProbe | null): void {
        this.presenceProbe = probe;
    }

    /**
     * Record a deliberate action or a genuine approach.
     *
     * Only INTENT and APPROACH reach the ride row — those are the signals that
     * move a deadline. Liveness is evaluated live and never written, so a
     * heartbeat cannot masquerade as engagement.
     */
    static async record(args: {
        rideId: string;
        type: RideActivityType;
        kind: ActivityKind;
        by?: 'passenger' | 'driver' | null;
        driverId?: string | null;
        detail?: Record<string, unknown>;
    }): Promise<void> {
        if (args.kind === ActivityKind.LIVENESS) return;

        try {
            if (AppDataSource.isInitialized) {
                await AppDataSource.getRepository(Ride)
                    .createQueryBuilder()
                    .update()
                    .set({ lastActivityAt: new Date(), lastActivityType: args.type })
                    .where('"rideId" = :rideId AND "completedAt" IS NULL', { rideId: args.rideId })
                    .execute();
            }
        } catch (err: any) {
            // Never let activity bookkeeping break a ride action.
            console.warn(`[RIDE_ACTIVITY] persist failed for ${args.rideId}: ${err?.message}`);
        }

        DispatchMonitorService.record({
            rideId: args.rideId,
            eventType: DispatchEventType.RIDE_ACTIVITY_RECORDED,
            driverId: args.driverId ?? null,
            detail: { activityType: args.type, kind: args.kind, by: args.by ?? null, ...(args.detail ?? {}) },
        });
    }

    /**
     * Is the driver measurably closer to the pickup point than last time we
     * looked? If so they are genuinely coming, whatever the clock says.
     *
     * Compared against the previous sample rather than the accept point, so a
     * driver who drove most of the way and then stopped stops counting as
     * approaching — which is the honest reading.
     */
    static async checkDriverApproach(
        rideId: string,
        driverId: string,
        pickup: { lat: number; lng: number },
        config: StaleRideConfig,
    ): Promise<{ approaching: boolean; distanceM: number | null; previousDistanceM: number | null }> {
        try {
            const live = await getDriverLiveLocation(driverId);
            if (!live) return { approaching: false, distanceM: null, previousDistanceM: null };

            const distanceM = haversineMetres(live.lat, live.lng, pickup.lat, pickup.lng);
            const key = `${APPROACH_PREFIX}${rideId}`;
            const previousRaw = await redis.get(key);
            const previousDistanceM = previousRaw != null ? Number(previousRaw) : null;

            await redis.set(key, String(Math.round(distanceM)), 'EX', APPROACH_TTL_SECONDS);

            if (previousDistanceM == null || !Number.isFinite(previousDistanceM)) {
                // First sample: nothing to compare against yet.
                return { approaching: false, distanceM, previousDistanceM: null };
            }

            const closedBy = previousDistanceM - distanceM;
            const approaching = closedBy >= config.approachProgressMetres;
            if (approaching) {
                await this.record({
                    rideId,
                    type: RideActivityType.DRIVER_APPROACHING,
                    kind: ActivityKind.APPROACH,
                    by: 'driver',
                    driverId,
                    detail: {
                        distanceM: Math.round(distanceM),
                        previousDistanceM: Math.round(previousDistanceM),
                        closedByM: Math.round(closedBy),
                    },
                });
            }
            return { approaching, distanceM, previousDistanceM };
        } catch {
            return { approaching: false, distanceM: null, previousDistanceM: null };
        }
    }

    /** Drop the approach sample once a ride ends. */
    static async clearApproach(rideId: string): Promise<void> {
        try {
            await redis.del(`${APPROACH_PREFIX}${rideId}`);
        } catch { /* TTL is the backstop */ }
    }

    /**
     * Whether a driver is showing any sign of life.
     *
     * Deliberately generous, and checked in descending order of strength. A phone
     * on a dying battery in heavy traffic must not be called abandoned.
     */
    static async driverLiveness(
        driverId: string,
        lastActivityAt: Date | null,
        config: StaleRideConfig,
    ): Promise<PartyLiveness> {
        try {
            if (await DispatchService.isDriverAvailable(driverId)) {
                return { live: true, offlineForMs: null, via: 'heartbeat' };
            }
            if (this.presenceProbe && await this.presenceProbe('driver', driverId)) {
                return { live: true, offlineForMs: null, via: 'socket' };
            }
            // A deliberate action a few minutes ago still counts.
            if (lastActivityAt != null) {
                const since = Date.now() - lastActivityAt.getTime();
                if (since < config.partyOfflineMinutes * 60_000) {
                    return { live: true, offlineForMs: null, via: 'recent_activity' };
                }
            }
            // How long dark? Use the persistent last-seen key, which outlives the
            // availability TTL, so we can distinguish "10 minutes" from "3 days".
            const lastSeen = await redis.get(`driver:lastseen:${driverId}`);
            const lastSeenMs = lastSeen != null ? Number(lastSeen) : null;
            const offlineForMs = lastSeenMs && Number.isFinite(lastSeenMs)
                ? Math.max(0, Date.now() - lastSeenMs)
                : (lastActivityAt ? Date.now() - lastActivityAt.getTime() : null);
            return { live: false, offlineForMs, via: null };
        } catch {
            // Unknown is not the same as gone. Assume reachable rather than
            // escalating on a Redis blip.
            return { live: true, offlineForMs: null, via: null };
        }
    }

    /**
     * Whether a passenger is showing any sign of life.
     *
     * Passengers have no heartbeat — the app does not report presence the way the
     * driver app does — so the evidence is socket presence and deliberate action.
     * That thinness is exactly why passenger silence escalates to a human rather
     * than terminating a ride.
     */
    static async passengerLiveness(
        passengerId: string,
        lastActivityAt: Date | null,
        config: StaleRideConfig,
    ): Promise<PartyLiveness> {
        try {
            if (this.presenceProbe && await this.presenceProbe('passenger', passengerId)) {
                return { live: true, offlineForMs: null, via: 'socket' };
            }
            if (lastActivityAt != null) {
                const since = Date.now() - lastActivityAt.getTime();
                if (since < config.partyOfflineMinutes * 60_000) {
                    return { live: true, offlineForMs: null, via: 'recent_activity' };
                }
                return { live: false, offlineForMs: since, via: null };
            }
            return { live: false, offlineForMs: null, via: null };
        } catch {
            return { live: true, offlineForMs: null, via: null };
        }
    }
}

/** Great-circle distance in metres. */
function haversineMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const R = 6_371_000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const sLat = Math.sin(dLat / 2);
    const sLng = Math.sin(dLng / 2);
    const h = sLat * sLat
        + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * sLng * sLng;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
