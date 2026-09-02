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
import { DriverZoneEligibility } from './driver_zone_eligibility';
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

/**
 * How much wider to cast the discovery net when a zone constraint will be
 * applied afterwards, so that filtering removes the wrong-city drivers rather
 * than the candidates themselves. 3x keeps the Redis cost trivial while
 * covering a tier where two thirds of the nearest drivers are across a border.
 */
const ZONE_OVERFETCH_FACTOR = 3;

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
        opts: {
            wantWakes?: boolean;
            rideId?: string;
            /**
             * When set, only drivers whose LAST-KNOWN position resolves to this
             * zone are worth waking.
             *
             * Undefined unless the ride's zone is actually enforcing, so in
             * Phase 1 this parameter is never supplied and the wake tier runs
             * the code it has always run.
             *
             * This filters the CANDIDATE LIST, not the wake mechanism. Nothing
             * about durable ONLINE intent, heartbeat timing, the foreground
             * service, the FCM wake payload, the notification channel or the
             * stale/quiet/unreachable state machine changes — a driver who is
             * woken is woken exactly as before. The only difference is that,
             * once a zone enforces, we stop ringing the phone of a driver in
             * another city for a ride they could never be given.
             */
            zoneCode?: string;
        } = {},
    ): Promise<CandidateOutcome> {
        /*
         * ── Tier 1: nearest live drivers ────────────────────────────────
         *
         * When a zone constraint is active we OVER-FETCH, because discovery is
         * radius-based and zone-agnostic while eligibility is not. Without this
         * the zone filter SHRINKS the candidate pool instead of reaching
         * further: a tier that discovers 10 drivers of whom 6 are in the
         * neighbouring city offers the ride to 4, rather than to the 10 nearest
         * drivers who could actually take it.
         *
         * It cannot bite for Onitsha and Awka — 16.3 km apart at their closest
         * edges against a 6.5 km maximum reach, so discovery cannot cross. It
         * would bite the first time two zones share a border, which is the
         * situation this architecture has to survive without being redesigned.
         *
         * Zero cost when unconstrained: the multiplier is 1.
         */
        const overFetch = opts.zoneCode ? ZONE_OVERFETCH_FACTOR : 1;
        const fresh = await DispatchService.findNearbyDriversWithDistance(
            lat, lng, radiusKm, limit * overFetch);
        const candidates: Candidate[] = fresh.map((f) => ({ ...f, tier: 'fresh' as const }));

        if (candidates.length >= limit || opts.wantWakes === false) {
            return { candidates, wakes: [] };
        }

        // ── Tier 2: drivers who want work but whose phone is quiet ──────
        const stale = await this.staleOnlineNear(lat, lng, radiusKm * STALE_RADIUS_FACTOR);
        const already = new Set(candidates.map((c) => c.driverId));
        const inZone = opts.zoneCode
            ? await this.filterToZone(stale.map((s) => s.driverId), opts.zoneCode)
            : null;
        const toWake = stale
            .filter((s) => !already.has(s.driverId))
            .filter((s) => inZone === null || inZone.has(s.driverId))
            .slice(0, MAX_WAKES_PER_ROUND);

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
    /**
     * Which of these drivers were last seen inside `zoneCode`.
     *
     * Uses LAST-KNOWN position, because by definition these drivers have no
     * live fix — that is what makes them wake candidates. A stale position
     * decides only whether ringing them is worth a push; it never makes anyone
     * dispatchable, and DriverEligibilityService re-checks against live GPS
     * before any offer.
     *
     * A driver with no recorded position at all is KEPT. We do not know they
     * are elsewhere, and declining to ring somebody on the strength of an
     * absence would quietly shrink supply.
     */
    /**
     * Which stale-online drivers are worth waking for a ride in `zoneCode`.
     *
     * Delegates to DriverZoneEligibility so the rule about how old a
     * last-known position may be lives in one place. A stale fix may only ever
     * exclude somebody from a wake, never make them eligible — and beyond
     * WAKE_POSITION_MAX_AGE_MS it stops excluding too, because a position that
     * old says nothing about where the driver is now.
     */
    private static async filterToZone(
        driverIds: string[], zoneCode: string,
    ): Promise<Set<string>> {
        return DriverZoneEligibility.wakeCandidatesForZone(driverIds, zoneCode);
    }

    private static async staleOnlineNear(
        lat: number,
        lng: number,
        radiusKm: number,
    ): Promise<Array<{ driverId: string; staleDistanceKm: number | null; rank: number }>> {
        const onlineIds = await DriverIntentService.onlineDriverIds();
        if (onlineIds.length === 0) return [];

        const health = await DriverIntentService.healthOfMany(onlineIds);
        const out: Array<{ driverId: string; staleDistanceKm: number | null; rank: number }> = [];

        for (const id of onlineIds) {
            const h = health.get(id);
            if (!h) continue;
            // FRESH drivers came through tier 1.
            if (h.reachability === 'FRESH' || h.reachability === 'OFFLINE') continue;
            /*
             * UNREACHABLE drivers are included, provided we have somewhere to
             * knock.
             *
             * Excluding them made UNREACHABLE a one-way door: three unanswered
             * wakes and a driver was never rung again, so the only way back was
             * a heartbeat — which needs the app running, which is the very
             * thing that was failing. A driver could sit ONLINE and unreachable
             * for a whole shift with the platform declining to try.
             *
             * They are also precisely who Path A exists for. An unanswered wake
             * usually means our background isolate cannot start on that
             * handset, and the audible notification is the one thing that does
             * not need it.
             */
            if (!h.hasPushToken) continue;
            if (!h.lastKnownPosition) continue;

            const d = haversineKm(lat, lng, h.lastKnownPosition.lat, h.lastKnownPosition.lng);
            if (d <= radiusKm) {
                out.push({
                    driverId: id,
                    staleDistanceKm: d,
                    // STALE first: a phone that has been answering recently is
                    // the better bet, so it gets the nearer audible slots.
                    rank: h.reachability === 'STALE' ? 0 : 1,
                });
            }
        }

        out.sort((a, b) => (a.rank - b.rank)
            || ((a.staleDistanceKm ?? 1e9) - (b.staleDistanceKm ?? 1e9)));
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
