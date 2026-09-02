/**
 * Whether the geographic constraint DECIDES anything, and for what reason.
 *
 * ── Why this is a separate object ───────────────────────────────────────
 * Every caller needs the same answer — apply it, watch it, or ignore it — and
 * if each worked it out from `zone.enforcement` locally they would drift. More
 * importantly, the parity guarantee rests on exactly one claim: with
 * enforcement `off`, no dispatch code path does anything different. That claim
 * is only checkable if there is a single place where "different" begins.
 *
 * ── The gap this file was rewritten to close ────────────────────────────
 * The first version keyed only on the ride's zone code, and returned an inert
 * policy when that code was null. That made "this ride is 666 km outside every
 * service area" indistinguishable from "we have no opinion" — so the Kano ride
 * passed the Operations guard without the guard ever evaluating, and would have
 * done so even under `enforce`.
 *
 * `undefined` must never mean `allowed`. So coverage is now an explicit,
 * three-valued fact carried alongside the mode:
 *
 *   IN_ZONE          the pickup resolved into a named active zone
 *   OUT_OF_COVERAGE  the pickup resolved, and is outside every active zone
 *   UNRESOLVED       we could not tell — a fault, or a ride from before zones
 *
 * Those are different situations and they get different policies. Only the
 * third is inert, and it is inert deliberately rather than accidentally.
 */
import { ServiceZoneService } from './service_zone_service';
import { ZoneEnforcement } from '../models/ServiceZone';
import { ServiceZoneConfig } from '../config/service_zone_config';

export enum ZoneCoverage {
    /** Pickup is inside a named, active, operational zone. */
    IN_ZONE = 'in_zone',
    /**
     * Pickup resolved successfully and lies outside every ACTIVE zone.
     *
     * Includes a pickup that falls inside a `draft` polygon: a drafted city is
     * geography we have drawn, not a service area we operate. Awka is exactly
     * this case and must stay exactly this case until it is activated.
     */
    OUT_OF_COVERAGE = 'out_of_coverage',
    /**
     * We could not determine coverage. A resolver fault, the kill switch, or a
     * ride created before service zones existed.
     *
     * Deliberately NOT merged with OUT_OF_COVERAGE. "Outside" is a product
     * decision; "we do not know" is a fault, and refusing somebody because a
     * cache was cold is a different and worse mistake than refusing them
     * because we do not operate where they are standing.
     */
    UNRESOLVED = 'unresolved',
}

export interface ZonePolicy {
    /** The ride's zone, or null when it has none. */
    zoneCode: string | null;
    coverage: ZoneCoverage;
    /** The enforcement posture governing this ride. */
    mode: ZoneEnforcement | 'unknown';
    /** Apply the constraint: filter candidates, refuse assignment. */
    constrain: boolean;
    /** Evaluate the constraint and record what it WOULD have done. Never apply. */
    observe: boolean;
}

const INERT: ZonePolicy = {
    zoneCode: null,
    coverage: ZoneCoverage.UNRESOLVED,
    mode: 'unknown',
    constrain: false,
    observe: false,
};

/** Strongest wins: enforce beats observe beats off. */
function strongest(modes: ZoneEnforcement[]): ZoneEnforcement {
    if (modes.includes(ZoneEnforcement.ENFORCE)) return ZoneEnforcement.ENFORCE;
    if (modes.includes(ZoneEnforcement.OBSERVE)) return ZoneEnforcement.OBSERVE;
    return ZoneEnforcement.OFF;
}

/**
 * Which of the three coverage states a ride is in, given the zones that are
 * currently operational.
 *
 * Pure, and shared: `forRide` uses it to decide policy, and the Operations
 * queue uses it to decide what to show an operator. One derivation, so the
 * screen cannot say "Awka" about a ride the dispatcher is not allowed to
 * assign, or "outside every service area" about one that is merely unclassified.
 *
 *   zoneCode names an operational zone  → IN_ZONE
 *   zoneCode names a non-operational one → OUT_OF_COVERAGE  (classified into a
 *                                          draft city: real, but not open)
 *   no zoneCode, matchKind 'none'        → OUT_OF_COVERAGE  (we looked, nothing)
 *   anything else                        → UNRESOLVED       (we never looked)
 */
export function coverageOf(
    zoneCode: string | null | undefined,
    matchKind: string | null | undefined,
    operationalCodes: ReadonlySet<string>,
): ZoneCoverage {
    if (zoneCode) {
        return operationalCodes.has(zoneCode)
            ? ZoneCoverage.IN_ZONE
            : ZoneCoverage.OUT_OF_COVERAGE;
    }
    return matchKind === 'none' ? ZoneCoverage.OUT_OF_COVERAGE : ZoneCoverage.UNRESOLVED;
}

export class ServiceZonePolicy {
    /**
     * The posture governing rides that belong to NO zone.
     *
     * Taken as the strongest mode among active zones, and the reasoning is:
     * if we are enforcing geography anywhere, a ride that belongs to no service
     * area cannot be served by anyone, so it must be governed too. Keying it to
     * one particular zone — the nearest, say — would make the answer depend on
     * an arbitrary choice of neighbour.
     */
    static async globalPosture(): Promise<ZoneEnforcement | 'unknown'> {
        if (!ServiceZoneConfig.enabled) return 'unknown';
        try {
            const zones = await ServiceZoneService.operationalZones();
            if (zones.length === 0) return 'unknown';
            return strongest(zones.map((z) => z.enforcement));
        } catch {
            return 'unknown';
        }
    }

    /**
     * The policy for one ride.
     *
     * `matchKind` is what distinguishes a ride that resolved OUTSIDE from one
     * that never resolved at all. Without it both look like `zoneCode = null`,
     * which is precisely how the Kano ride slipped past the Operations guard.
     *
     *   zoneCode set          → IN_ZONE, that zone's mode
     *   zoneCode null, 'none' → OUT_OF_COVERAGE, the global posture
     *   anything else         → UNRESOLVED, inert
     *
     * Never throws, and fails inert: a policy lookup that cannot answer must
     * leave dispatch exactly as it was. Failing to READ a policy is not grounds
     * for changing behaviour in either direction.
     */
    static async forRide(
        zoneCode: string | null | undefined,
        matchKind?: string | null,
    ): Promise<ZonePolicy> {
        if (!ServiceZoneConfig.enabled) return INERT;

        try {
            if (zoneCode) {
                const zones = await ServiceZoneService.operationalZones();
                const zone = zones.find((z) => z.code === zoneCode);
                // A code that names no ACTIVE zone is not in coverage. This is
                // the AWK case once a ride has been classified into a draft
                // polygon: classified, but not operational. `coverageOf` makes
                // the same call for the Operations screen.
                if (!zone) return this.outOfCoverage(zoneCode);
                return {
                    zoneCode,
                    coverage: ZoneCoverage.IN_ZONE,
                    mode: zone.enforcement,
                    constrain: zone.enforcement === ZoneEnforcement.ENFORCE,
                    observe: zone.enforcement === ZoneEnforcement.OBSERVE,
                };
            }

            // No zone code. Only `matchKind === 'none'` means we actually
            // looked and found nothing; anything else means we never looked.
            if (matchKind === 'none') return this.outOfCoverage(null);
            return INERT;
        } catch {
            return INERT;
        }
    }

    private static async outOfCoverage(zoneCode: string | null): Promise<ZonePolicy> {
        const mode = await this.globalPosture();
        return {
            zoneCode,
            coverage: ZoneCoverage.OUT_OF_COVERAGE,
            mode,
            constrain: mode === ZoneEnforcement.ENFORCE,
            observe: mode === ZoneEnforcement.OBSERVE,
        };
    }

    /** True when this policy asks for any work beyond the legacy path. */
    static active(p: ZonePolicy): boolean {
        return p.constrain || p.observe;
    }

    /**
     * Why enforcement would refuse, if it were on. Null when it would not.
     *
     * One place that decides, so the reason a request WOULD be refused in
     * observe is literally the same computation as the reason it IS refused in
     * enforce — rather than two texts that drift.
     */
    static refusalReason(p: ZonePolicy): string | null {
        if (p.coverage === ZoneCoverage.OUT_OF_COVERAGE) {
            return p.zoneCode
                ? `pickup is in ${p.zoneCode}, which is not an operational service area`
                : 'pickup is outside every operational service area';
        }
        return null;
    }
}

/**
 * The evidence Phase 2's gate reads.
 *
 * Emitted in `observe` AND in `enforce`, so the line means the same thing in
 * both and the transition between them is measurable rather than a step into
 * the dark. `applied` is the only field that differs.
 */
export function logWouldRejectCandidate(fields: {
    rideId: string; driverId: string; rideZone: string | null;
    driverZone: string | null; mode: string; applied: boolean;
}): void {
    console.log(JSON.stringify({
        level: 'info', scope: 'service_zone', event: 'would_reject_candidate', ...fields,
    }));
}

export function logWouldRefuseRequest(fields: {
    passengerId: string; rideId?: string | null; nearestZoneCode: string | null;
    distanceM: number; coverage: string; reason: string | null;
    mode: string; applied: boolean;
}): void {
    console.log(JSON.stringify({
        level: 'info', scope: 'service_zone', event: 'would_refuse_request', ...fields,
    }));
}
