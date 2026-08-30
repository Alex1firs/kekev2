/**
 * Whether the geographic constraint DECIDES anything, for one ride.
 *
 * ── Why this is a separate object ───────────────────────────────────────
 * Every caller needs the same three-way answer — apply it, watch it, ignore it
 * — and if each worked it out from `zone.enforcement` locally they would drift.
 * More importantly, the parity guarantee for Phase 1 rests on exactly one
 * claim: with enforcement `off`, no dispatch code path does anything different.
 * That claim is only checkable if there is a single place where "different"
 * begins.
 *
 * ── The Phase 1 contract ────────────────────────────────────────────────
 *   off      constrain = false, observe = false
 *            Nothing extra is computed. No additional Redis call, no filtering,
 *            no reordering. The dispatch path is byte-identical to the one that
 *            ran before service zones existed.
 *   observe  constrain = false, observe = true
 *            The constraint is evaluated and logged; results are discarded.
 *            Costs one extra pipelined lookup and changes no outcome.
 *   enforce  constrain = true
 *            The constraint applies.
 */
import { ServiceZoneService } from './service_zone_service';
import { ZoneEnforcement } from '../models/ServiceZone';
import { ServiceZoneConfig } from '../config/service_zone_config';

export interface ZonePolicy {
    /** The ride's zone, or null when unknown/unresolved. */
    zoneCode: string | null;
    mode: ZoneEnforcement | 'unknown';
    /** Apply the constraint to dispatch decisions. */
    constrain: boolean;
    /** Compute and log what the constraint WOULD have done. */
    observe: boolean;
}

const INERT: ZonePolicy = { zoneCode: null, mode: 'unknown', constrain: false, observe: false };

export class ServiceZonePolicy {
    /**
     * Never throws, and fails inert. A policy lookup that cannot answer must
     * leave dispatch exactly as it was — the failure to READ a policy is not
     * grounds for changing behaviour in either direction.
     */
    static async forRide(zoneCode: string | null | undefined): Promise<ZonePolicy> {
        if (!ServiceZoneConfig.enabled || !zoneCode) return INERT;
        try {
            const zones = await ServiceZoneService.operationalZones();
            const zone = zones.find((z) => z.code === zoneCode);
            if (!zone) return INERT;
            return {
                zoneCode,
                mode: zone.enforcement,
                constrain: zone.enforcement === ZoneEnforcement.ENFORCE,
                observe: zone.enforcement === ZoneEnforcement.OBSERVE,
            };
        } catch {
            return INERT;
        }
    }

    /** True when this policy asks for any work at all beyond the legacy path. */
    static active(p: ZonePolicy): boolean {
        return p.constrain || p.observe;
    }
}

/**
 * The evidence Phase 2's gate reads.
 *
 * Emitted in `observe` AND in `enforce`, so the log line means the same thing
 * in both and the transition between them is measurable rather than a step into
 * the dark.
 */
export function logWouldRejectCandidate(fields: {
    rideId: string; driverId: string; rideZone: string;
    driverZone: string | null; mode: string; applied: boolean;
}): void {
    console.log(JSON.stringify({
        level: 'info', scope: 'service_zone', event: 'would_reject_candidate', ...fields,
    }));
}

export function logWouldRefuseRequest(fields: {
    passengerId: string; nearestZoneCode: string | null;
    distanceM: number; mode: string; applied: boolean;
}): void {
    console.log(JSON.stringify({
        level: 'info', scope: 'service_zone', event: 'would_refuse_request', ...fields,
    }));
}
