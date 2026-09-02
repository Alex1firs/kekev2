/**
 * The geographic invariant, for assignments a human makes.
 *
 * ── Why this exists as its own module ───────────────────────────────────
 * Automatic dispatch gets geography for free: candidate discovery only ever
 * looks at drivers near the pickup, and the eligibility chain re-checks the
 * zone before any offer. A human picking a driver from a list bypasses both.
 *
 * There are TWO such paths, and until now only one of them was guarded:
 *
 *   OperationsDispatchService.assign   the dispatcher console's manual
 *                                      assignment. Guarded since the Kano
 *                                      incident.
 *   ParkDispatchService.assignDriver   park dispatch, for feature-phone
 *                                      drivers. Checks roster, assignability
 *                                      and presence at the park — and, before
 *                                      this file, nothing about geography.
 *
 * Two call sites enforcing "the same" rule in two places is how the rule stops
 * being the same. So the rule lives here once, and both paths call it.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────
 * It does not hide drivers, reorder them, or change what a dispatcher can see.
 * Hiding was never the safety mechanism — a dispatcher who cannot find a
 * driver on screen rings them on the telephone instead. Refusal is server-side
 * and final; visibility is the console's job, and a separate one.
 *
 * ── The three modes ─────────────────────────────────────────────────────
 *   off       inert. `violated` is never computed and nothing is logged.
 *   observe   evaluated, logged, and REPORTED to the caller — but never
 *             refused. The caller may show the operator what would have
 *             happened; it must not act on it.
 *   enforce   refused.
 *
 * Observe and enforce evaluate the identical predicate. If they did not, the
 * data gathered under observation would say nothing about what enforcement
 * will do, and the whole staged rollout would be measuring the wrong thing.
 */
import { DispatchService } from './dispatch_service';
import { resolveAgainst } from './service_zone_resolver';
import { ServiceZoneService } from './service_zone_service';
import {
    ServiceZonePolicy,
    ZoneCoverage,
    logWouldRejectCandidate,
} from './service_zone_policy';

/** The ride fields the guard reads. Deliberately narrow. */
export interface GuardedRide {
    rideId: string;
    zoneCode: string | null;
    zoneMatchKind: string | null;
}

export interface ManualZoneVerdict {
    /**
     * The caller MUST refuse the assignment.
     *
     * True only when the ride's zone is ENFORCING. Under observe this stays
     * false however badly the constraint is violated — turning observation
     * into enforcement by accident is the specific failure this field is
     * shaped to prevent.
     */
    refuse: boolean;

    /**
     * The geographic constraint was violated.
     *
     * True under observe as well as enforce. This is what an operator should be
     * shown, and what the logs count.
     */
    violated: boolean;

    coverage: ZoneCoverage;
    /** The zone's enforcement mode, as a string, for logs and audit rows. */
    mode: string;
    rideZone: string | null;
    driverZone: string | null;

    /** Operator-facing sentence. Null when nothing is wrong. */
    message: string | null;
}

const INERT: ManualZoneVerdict = {
    refuse: false,
    violated: false,
    coverage: ZoneCoverage.UNRESOLVED,
    mode: 'off',
    rideZone: null,
    driverZone: null,
    message: null,
};

export class ManualAssignmentZoneGuard {
    /**
     * May this operator put this driver on this ride, geographically?
     *
     * Never throws. A guard that can fail the assignment by crashing is a
     * worse outage than the one it prevents.
     */
    static async evaluate(ride: GuardedRide, driverId: string): Promise<ManualZoneVerdict> {
        let policy;
        try {
            policy = await ServiceZonePolicy.forRide(ride.zoneCode ?? null, ride.zoneMatchKind ?? null);
        } catch {
            return INERT;
        }

        if (!ServiceZonePolicy.active(policy)) return INERT;

        const driverZone = await this.zoneOfDriver(driverId);

        /*
         * Two distinct refusals, and the second is the one the Kano ride walked
         * straight through:
         *
         *   IN_ZONE          the driver must be in the ride's zone.
         *   OUT_OF_COVERAGE  the ride belongs to NO service area, so there is
         *                    no driver who could serve it. Nobody is
         *                    assignable, and that is the strongest possible
         *                    reason to refuse rather than a case to skip.
         *
         * UNRESOLVED still passes. A resolver fault must not stop a dispatcher
         * working.
         */
        const outOfCoverage = policy.coverage === ZoneCoverage.OUT_OF_COVERAGE;
        const mismatched = policy.coverage === ZoneCoverage.IN_ZONE
            && driverZone !== policy.zoneCode;
        const violated = outOfCoverage || mismatched;

        if (!violated) {
            return {
                refuse: false, violated: false,
                coverage: policy.coverage, mode: String(policy.mode),
                rideZone: policy.zoneCode, driverZone, message: null,
            };
        }

        logWouldRejectCandidate({
            rideId: ride.rideId, driverId,
            rideZone: policy.zoneCode, driverZone,
            mode: String(policy.mode), applied: policy.constrain,
        });

        return {
            refuse: policy.constrain,
            violated: true,
            coverage: policy.coverage,
            mode: String(policy.mode),
            rideZone: policy.zoneCode,
            driverZone,
            message: outOfCoverage
                ? 'This pickup is outside every KekeRide service area, so no driver can be assigned.'
                : `This driver is not currently in the ${policy.zoneCode} service area.`,
        };
    }

    /**
     * The zone a driver's LIVE position resolves to.
     *
     * Null when we do not know — no live fix, resolver fault, or genuinely
     * outside every zone. The caller treats null as "not in the ride's zone",
     * which is the correct reading for an assignment decision: we may not place
     * a driver we cannot locate into a city we cannot confirm they are in.
     *
     * Live position only. A last-known fix is a hint about whose phone to ring,
     * never a statement about which city somebody is in.
     */
    static async zoneOfDriver(driverId: string): Promise<string | null> {
        try {
            const positions = await DispatchService.livePositions([driverId]);
            const p = positions.get(driverId);
            if (!p) return null;
            const zones = await ServiceZoneService.operationalZones();
            const r = resolveAgainst(p, zones);
            return r.kind === 'inside' ? r.zoneCode : null;
        } catch {
            return null;
        }
    }
}
