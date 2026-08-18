/**
 * Durable projection of dispatch events, for the Live Ride Requests monitor.
 *
 * This service only WRITES. It is called from the same authoritative hooks the
 * in-memory DispatchEvidence ledger uses, so the admin trail and the live ledger
 * can never disagree — there is no second ledger, no second eligibility rule and
 * no second nearby-driver calculation anywhere in here.
 *
 * Two hard rules:
 *  1. Never block or fail dispatch. Every write is fire-and-forget and swallows
 *     its own errors: a monitoring outage must not cost a passenger a ride.
 *  2. Never record an event stronger than the signal that actually occurred.
 *     There is no "delivered" or "seen" event to record.
 */
import { AppDataSource } from '../config/data_source';
import { DispatchEvent, DispatchEventType } from '../models/DispatchEvent';
import { DispatchService } from './dispatch_service';
import { redis } from '../config/redis';

export interface RecordArgs {
    rideId: string;
    eventType: DispatchEventType;
    dispatchRound?: number | null;
    driverId?: string | null;
    radiusKm?: number | null;
    distanceKm?: number | null;
    detail?: Record<string, unknown> | null;
    occurredAt?: Date;
    /** Look up live heartbeat/location ages for this driver before writing. */
    withFreshness?: boolean;
}

/** Emitter injected by the socket handler so admins get incremental updates. */
export type AdminEventEmitter = (event: string, payload: Record<string, unknown>) => void;

export class DispatchMonitorService {
    private static emitter: AdminEventEmitter | null = null;
    /** Per-ride monotonic sequence, so same-millisecond events stay ordered. */
    private static sequences = new Map<string, number>();

    /** Wired once at socket-handler construction. */
    static setEmitter(emitter: AdminEventEmitter | null): void {
        this.emitter = emitter;
    }

    /** Testing seam: drop in-memory sequence state. */
    static resetSequences(): void {
        this.sequences.clear();
    }

    private static nextSequence(rideId: string): number {
        const next = (this.sequences.get(rideId) ?? 0) + 1;
        this.sequences.set(rideId, next);
        return next;
    }

    /** Forget a finished ride's counter so the map cannot grow without bound. */
    static forget(rideId: string): void {
        this.sequences.delete(rideId);
    }

    /**
     * Heartbeat and location age for a driver, right now.
     *
     * Heartbeat age is derived from the remaining TTL on the availability key
     * (the same key dispatch gates on), so it needs no extra bookkeeping. A
     * driver with no live key reports null age and `fresh: false`.
     */
    static async freshness(driverId: string): Promise<{
        heartbeatAgeMs: number | null;
        locationAgeMs: number | null;
        fresh: boolean;
    }> {
        try {
            const [ttlMs, lastSeen] = await Promise.all([
                redis.pttl(`driver:available:${driverId}`),
                redis.get(`driver:lastseen:${driverId}`),
            ]);
            const ttl = Number(ttlMs);
            const heartbeatAgeMs =
                Number.isFinite(ttl) && ttl > 0
                    ? DispatchService.AVAILABILITY_TTL_SECONDS * 1000 - ttl
                    : null;
            const lastSeenMs = lastSeen ? Number(lastSeen) : null;
            const locationAgeMs =
                lastSeenMs && Number.isFinite(lastSeenMs) ? Math.max(0, Date.now() - lastSeenMs) : null;
            return { heartbeatAgeMs, locationAgeMs, fresh: heartbeatAgeMs != null };
        } catch {
            return { heartbeatAgeMs: null, locationAgeMs: null, fresh: false };
        }
    }

    /**
     * Persist one event and push it to admin subscribers.
     *
     * Fire-and-forget by design — callers do not await it, and it never throws.
     */
    static record(args: RecordArgs): void {
        // `void` alone is not enough. A rejection from recordAsync would become
        // an UNHANDLED promise rejection — which, under Node's default in
        // recent majors, terminates the process. This is called from inside the
        // dispatch offer loop, so an unhandled rejection here would take out
        // the API mid-ride. The catch is the difference between losing a
        // monitoring row and losing every ride in flight.
        this.recordAsync(args).catch((err: any) => {
            console.warn(`[DISPATCH_MONITOR] record failed (${args.eventType}): ${err?.message}`);
        });
    }

    /** Awaitable form, for tests and for callers that want ordering guarantees. */
    static async recordAsync(args: RecordArgs): Promise<DispatchEvent | null> {
        const sequence = this.nextSequence(args.rideId);
        const occurredAt = args.occurredAt ?? new Date();

        let heartbeatAgeMs: number | null = null;
        let locationAgeMs: number | null = null;
        if (args.withFreshness && args.driverId) {
            // `freshness` guards its own await, but a synchronous throw from
            // the Redis client (a closed connection surfaces that way) would
            // escape this whole method. Freshness is decoration on a monitoring
            // row; missing it is not a reason to lose the row.
            try {
                const f = await this.freshness(args.driverId);
                heartbeatAgeMs = f.heartbeatAgeMs;
                locationAgeMs = f.locationAgeMs;
            } catch {
                /* recorded without freshness rather than not recorded */
            }
        }

        const row: Partial<DispatchEvent> = {
            rideId: args.rideId,
            sequence,
            eventType: args.eventType,
            dispatchRound: args.dispatchRound ?? null,
            driverId: args.driverId ?? null,
            radiusKm: args.radiusKm ?? null,
            distanceKm: args.distanceKm ?? null,
            heartbeatAgeMs,
            locationAgeMs,
            detail: args.detail ?? null,
            occurredAt,
        };

        // Push to admins first: monitoring value is highest while it is live, and
        // a slow database must not delay the operator's view.
        try {
            this.emitter?.('admin:dispatch_event', {
                ...row,
                occurredAt: occurredAt.toISOString(),
            });
        } catch {
            /* an admin socket problem must never affect dispatch */
        }

        try {
            if (!AppDataSource.isInitialized) return null;
            const repo = AppDataSource.getRepository(DispatchEvent);
            return await repo.save(repo.create(row));
        } catch (err: any) {
            // Deliberately swallowed: losing a monitoring row is acceptable,
            // breaking a ride is not.
            console.warn(`[DISPATCH_MONITOR] persist failed (${args.eventType}): ${err?.message}`);
            return null;
        }
    }

}
