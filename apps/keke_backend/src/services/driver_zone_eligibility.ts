/**
 * May this driver be dispatched a ride in this zone, right now?
 *
 * ── Why this is its own file ────────────────────────────────────────────
 * Multi-city dispatch turns one question — "is this driver near enough" —
 * into two: near enough, AND in the right city. The second is not a distance
 * check, and getting it wrong in either direction is expensive:
 *
 *   too strict  a driver working legitimately in Awka is invisible to Awka
 *               rides because his account was registered in Onitsha.
 *   too loose   a driver whose phone last reported from Onitsha yesterday is
 *               offered an Awka trip he cannot possibly take.
 *
 * So the freshness rules are written down here, in one place, rather than
 * implied by whichever Redis key a given call site happened to read.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  THE MOBILITY POLICY
 * ══════════════════════════════════════════════════════════════════════
 *
 * A driver is eligible in zone Z when ALL of:
 *
 *   1. ONLINE INTENT     driver_presence_intent.state = ONLINE.
 *                        Durable, and deliberately has NO freshness
 *                        requirement — it is a declaration of intent to work,
 *                        not a signal of liveness. This is the presence model
 *                        the Redmi work established and it is not revisited
 *                        here.
 *
 *   2. LIVE HEARTBEAT    `driver:available:{id}` exists. 45-second TTL.
 *
 *   3. FRESH POSITION    Implied by (2), and this is the load-bearing fact:
 *                        DispatchService.updateDriverLocation writes the GEO
 *                        entry and the availability key in the SAME Redis
 *                        pipeline. A live availability key therefore proves the
 *                        geo position was written within the last 45 seconds.
 *                        There is no separate position-age check because there
 *                        cannot be a stale position behind a live key.
 *
 *   4. POSITION IN ZONE  resolve(live position) === Z.
 *
 * ── What is deliberately NOT a criterion ────────────────────────────────
 * `homeZoneCode`. A driver's registered city is administrative metadata for
 * rosters, badges and reporting. A driver who drives from Onitsha to Awka is
 * working in Awka, and the platform must see that from his position rather
 * than from his paperwork. Home zone never grants eligibility and never
 * withholds it.
 *
 * ── The asymmetry that keeps stale data safe ────────────────────────────
 * A stale position can only ever EXCLUDE a driver from a zone, never include
 * him. Eligibility reads the live index; the wake tier (which by its nature
 * works with last-known positions) may skip ringing somebody, but a skipped
 * ring costs one missed opportunity while a wrong inclusion costs a passenger
 * a driver who is 33 km away. And a woken driver still has to heartbeat with a
 * fresh fix before any of this admits him.
 */
import { redis } from '../config/redis';
import { DispatchService } from './dispatch_service';
import { resolveAgainst } from './service_zone_resolver';
import { LoadedZone, ServiceZoneService } from './service_zone_service';

/**
 * How old a LAST-KNOWN position may be and still be trusted to exclude a
 * driver from a zone for wake purposes.
 *
 * Beyond this the position says nothing useful about where the driver is now,
 * so it is treated as unknown and the driver is rung anyway. Without a bound,
 * a fix from yesterday morning would quietly suppress wakes for the rest of a
 * driver's week.
 */
export const WAKE_POSITION_MAX_AGE_MS = 30 * 60_000;

export type ZoneEligibilityReason =
    /** Live position resolves to the ride's zone. */
    | 'in_zone'
    /** No live position — excluded upstream by the heartbeat filter, not by us. */
    | 'no_live_position'
    /** Live position resolves to a different active zone. */
    | 'in_other_zone'
    /** Live position resolves to no active zone at all. */
    | 'outside_all_zones'
    /** The ride itself belongs to no zone, so nobody can be in it. */
    | 'ride_has_no_zone'
    /** Could not evaluate. Never used to exclude. */
    | 'undetermined';

export interface DriverZoneVerdict {
    driverId: string;
    eligible: boolean;
    reason: ZoneEligibilityReason;
    /** The zone the driver's live position resolves to, when there is one. */
    driverZone: string | null;
}

export class DriverZoneEligibility {
    /**
     * Verdicts for a batch of drivers against one ride zone.
     *
     * `rideZoneCode` null means the ride belongs to no service area — the Kano
     * case. Nobody is in a zone that does not exist, so every driver is
     * ineligible, and that is the strongest possible verdict rather than a case
     * to skip. Silently passing here is precisely how a Kano ride reached an
     * Onitsha driver on 31 August.
     */
    static async verdicts(
        driverIds: string[],
        rideZoneCode: string | null,
        zones?: LoadedZone[],
    ): Promise<Map<string, DriverZoneVerdict>> {
        const out = new Map<string, DriverZoneVerdict>();
        if (driverIds.length === 0) return out;

        if (!rideZoneCode) {
            for (const driverId of driverIds) {
                out.set(driverId, {
                    driverId, eligible: false, reason: 'ride_has_no_zone', driverZone: null,
                });
            }
            return out;
        }

        let zoneSet: LoadedZone[];
        let positions: Map<string, { lat: number; lng: number }>;
        try {
            [zoneSet, positions] = await Promise.all([
                zones ? Promise.resolve(zones) : ServiceZoneService.operationalZones(),
                DispatchService.livePositions(driverIds),
            ]);
        } catch {
            // Cannot evaluate. Every driver is `undetermined` and therefore
            // eligible — a Redis or database blip must never take a city's
            // drivers off the road.
            for (const driverId of driverIds) {
                out.set(driverId, {
                    driverId, eligible: true, reason: 'undetermined', driverZone: null,
                });
            }
            return out;
        }

        for (const driverId of driverIds) {
            const p = positions.get(driverId);
            if (!p) {
                // No live geo entry. Such a driver has no live heartbeat either
                // and was already excluded upstream; saying "wrong city" about
                // somebody we cannot locate would be a misleading reason on a
                // dispatcher's screen.
                out.set(driverId, {
                    driverId, eligible: true, reason: 'no_live_position', driverZone: null,
                });
                continue;
            }

            const r = resolveAgainst(p, zoneSet);
            if (r.kind === 'error') {
                out.set(driverId, {
                    driverId, eligible: true, reason: 'undetermined', driverZone: null,
                });
                continue;
            }

            const driverZone = r.kind === 'inside' ? r.zoneCode : null;
            if (driverZone === rideZoneCode) {
                out.set(driverId, { driverId, eligible: true, reason: 'in_zone', driverZone });
            } else {
                out.set(driverId, {
                    driverId,
                    eligible: false,
                    reason: driverZone ? 'in_other_zone' : 'outside_all_zones',
                    driverZone,
                });
            }
        }
        return out;
    }

    /**
     * Which of these drivers are worth WAKING for a ride in `zoneCode`.
     *
     * Different question, different evidence. Wake candidates are by definition
     * drivers with no live heartbeat, so there is no live position to read —
     * only `driver:lastpos`, which may be up to 24 hours old.
     *
     * The rule: a last-known position may exclude a driver only while it is
     * fresh enough to mean something (WAKE_POSITION_MAX_AGE_MS). Older than
     * that, or missing, and the driver is kept — we do not know where he is, and
     * declining to ring somebody on the strength of an absence would quietly
     * shrink supply in exactly the situation the wake tier exists to rescue.
     *
     * This can never make a driver ELIGIBLE in a zone. Waking is an invitation
     * to heartbeat; eligibility is re-decided afterwards on a live fix.
     */
    static async wakeCandidatesForZone(
        driverIds: string[],
        zoneCode: string,
        now: number = Date.now(),
    ): Promise<Set<string>> {
        const keep = new Set(driverIds);
        if (driverIds.length === 0) return keep;

        try {
            const [zones, stored] = await Promise.all([
                ServiceZoneService.operationalZones(),
                DispatchService.lastKnownPositions(driverIds),
            ]);
            for (const id of driverIds) {
                const p = stored.get(id);
                if (!p) continue;                                  // unknown → ring them
                if (!p.at || now - p.at > WAKE_POSITION_MAX_AGE_MS) continue;  // too old to mean anything
                const r = resolveAgainst({ lat: p.lat, lng: p.lng }, zones);
                if (r.kind === 'error') continue;
                if (!(r.kind === 'inside' && r.zoneCode === zoneCode)) keep.delete(id);
            }
        } catch {
            return new Set(driverIds);                             // cannot tell → ring everyone
        }
        return keep;
    }

    /**
     * A driver's current zone from their LIVE position, for display.
     *
     * Null when there is no live fix — which is different from "outside", and
     * the Operations console is expected to render the difference.
     */
    static async currentZone(driverId: string): Promise<string | null> {
        try {
            const [zones, positions] = await Promise.all([
                ServiceZoneService.operationalZones(),
                DispatchService.livePositions([driverId]),
            ]);
            const p = positions.get(driverId);
            if (!p) return null;
            const r = resolveAgainst(p, zones);
            return r.kind === 'inside' ? r.zoneCode : null;
        } catch {
            return null;
        }
    }

    /** Whether a live heartbeat exists — the freshness gate the whole policy rests on. */
    static async hasLiveHeartbeat(driverId: string): Promise<boolean> {
        try {
            return (await redis.get(`driver:available:${driverId}`)) === 'true';
        } catch {
            return false;
        }
    }
}
