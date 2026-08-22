/**
 * Who dispatch may offer a ride to, now that "online" is durable.
 *
 * ── The two tiers ───────────────────────────────────────────────────────
 *
 *   FRESH   Beating within the availability window. Dispatched exactly as
 *           before — same geo query, same ordering, same eligibility filter.
 *           This path is untouched, and it is the path almost every offer
 *           still takes.
 *
 *   WOKEN   Intent ONLINE, device quiet. Only consulted when the fresh tier
 *           cannot fill the request. We knock, and a driver joins the
 *           candidate list ONLY if their phone answers with a FRESH fix that
 *           is genuinely near the pickup. Their stale coordinates are used to
 *           decide who is worth waking, and for nothing else.
 *
 * ── What is deliberately absent ─────────────────────────────────────────
 * Nothing here writes intent. A driver who does not answer a wake is not
 * marked offline, is not removed from any pool, and will be tried again on the
 * next request. Recovery needs no toggle and no app reopen: one heartbeat, from
 * any source, puts them straight back in the fresh tier.
 */
import { DispatchService } from './dispatch_service';
import { DriverIntentService } from './driver_intent_service';
import { DriverWakeService } from './driver_wake_service';
import { redis } from '../config/redis';

export interface Candidate {
    driverId: string;
    distanceKm: number | null;
    /** How this driver came to be here. Carried into dispatch evidence. */
    tier: 'fresh' | 'woken';
}

export interface CandidateOutcome {
    candidates: Candidate[];
    /** Drivers we knocked on, and what happened. For the dispatch trail. */
    wakes: Array<{ driverId: string; answered: boolean; reason?: string }>;
}

/** Wake at most this many phones for one dispatch round. */
const MAX_WAKES_PER_ROUND = Number(process.env.DISPATCH_MAX_WAKES || 6);

/**
 * How many stale drivers are rung OUT LOUD for one ride.
 *
 * Deliberately smaller than MAX_WAKES_PER_ROUND: a silent data wake costs the
 * driver nothing, but an audible alert is an interruption, and ringing six
 * phones for one passenger trains drivers to ignore the sound.
 */
const AUDIBLE_WAKE_LIMIT = Number(process.env.DISPATCH_AUDIBLE_WAKES || 3);

/** Radius multiplier when deciding who is worth waking on a stale position. */
const STALE_RADIUS_FACTOR = 1.5;

export class DriverCandidateService {
    /**
     * Candidates for one pickup, freshest first.
     *
     * `wantWakes` is false for callers that must never cause a push — the
     * passenger's nearby-Keke map, for instance, which shows supply rather
     * than requesting it.
     */
    static async findFor(
        lat: number,
        lng: number,
        radiusKm: number,
        limit: number,
        opts: { wantWakes?: boolean; rideId?: string } = {},
    ): Promise<CandidateOutcome> {
        // ── Tier 1: the existing path, unchanged ────────────────────────
        const fresh = await DispatchService.findNearbyDriversWithDistance(lat, lng, radiusKm, limit);
        const candidates: Candidate[] = fresh.map((f) => ({ ...f, tier: 'fresh' as const }));

        if (candidates.length >= limit || opts.wantWakes === false) {
            return { candidates, wakes: [] };
        }

        // ── Tier 2: drivers who want work but whose phone is quiet ──────
        const stale = await this.staleOnlineNear(lat, lng, radiusKm * STALE_RADIUS_FACTOR);
        const already = new Set(candidates.map((c) => c.driverId));
        const toWake = stale.filter((s) => !already.has(s.driverId)).slice(0, MAX_WAKES_PER_ROUND);

        if (toWake.length === 0) return { candidates, wakes: [] };

        console.log(JSON.stringify({
            level: 'info', scope: 'presence', event: 'waking_stale_drivers',
            rideId: opts.rideId ?? null, count: toWake.length,
            freshFound: candidates.length, needed: limit,
        }));

        /*
         * Everyone gets the silent recovery attempt; the nearest few also get
         * an audible alert that rings without our process needing to start.
         * `toWake` is already sorted nearest-first on last-known position —
         * which decides only who is worth ringing, never who gets the ride.
         */
        const results = await DriverWakeService.wakeMany(
            toWake.map((s) => s.driverId),
            { rideId: opts.rideId, audibleLimit: AUDIBLE_WAKE_LIMIT },
        );

        // Re-run the live geo query. A phone that answered has just written a
        // fresh position and availability key, so it now appears in the normal
        // index — which means the freshly woken driver is admitted by exactly
        // the same rule as everyone else, on coordinates taken seconds ago.
        const answered = results.filter((r) => r.answered);
        if (answered.length > 0) {
            const reQueried = await DispatchService.findNearbyDriversWithDistance(
                lat, lng, radiusKm, limit,
            );
            for (const f of reQueried) {
                if (already.has(f.driverId)) continue;
                if (!answered.some((a) => a.driverId === f.driverId)) continue;
                candidates.push({ ...f, tier: 'woken' });
                already.add(f.driverId);
                if (candidates.length >= limit) break;
            }
        }

        return {
            candidates,
            wakes: results.map((r) => ({
                driverId: r.driverId, answered: r.answered, reason: r.reason,
            })),
        };
    }

    /**
     * ONLINE drivers with a last-known position near the pickup, whose device
     * is not currently fresh.
     *
     * The stale position is a heuristic for "worth knocking on", nothing more.
     * A driver admitted through here is only ever dispatched on the fix their
     * phone returns after waking.
     */
    private static async staleOnlineNear(
        lat: number,
        lng: number,
        radiusKm: number,
    ): Promise<Array<{ driverId: string; staleDistanceKm: number | null }>> {
        const onlineIds = await DriverIntentService.onlineDriverIds();
        if (onlineIds.length === 0) return [];

        const health = await DriverIntentService.healthOfMany(onlineIds);
        const out: Array<{ driverId: string; staleDistanceKm: number | null }> = [];

        for (const id of onlineIds) {
            const h = health.get(id);
            if (!h) continue;
            // FRESH drivers came through tier 1. UNREACHABLE ones have no token
            // or have ignored several wakes — still ONLINE, still shown as such,
            // but not worth delaying a passenger for.
            if (h.reachability !== 'STALE') continue;
            if (!h.lastKnownPosition) continue;

            const d = haversineKm(lat, lng, h.lastKnownPosition.lat, h.lastKnownPosition.lng);
            if (d <= radiusKm) out.push({ driverId: id, staleDistanceKm: d });
        }

        out.sort((a, b) => (a.staleDistanceKm ?? 1e9) - (b.staleDistanceKm ?? 1e9));
        return out;
    }
}

/** Straight-line distance in km. Good enough to rank who to wake. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
