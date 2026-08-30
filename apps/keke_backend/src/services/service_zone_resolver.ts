/**
 * The RUNTIME resolver. Which operational zone is this point in?
 *
 * ── Scope, and why it is narrow on purpose ──────────────────────────────
 * This resolver sees `active` zones and nothing else. There is no argument, no
 * option and no flag that makes it consider a draft zone, because this is the
 * function that decides where rides go and which drivers may take them.
 * Classifying historical rides against approved-but-not-yet-operating geometry
 * is a genuinely different job and lives in service_zone_classifier.ts, which
 * nothing on a dispatch path may import.
 *
 * ── Three outcomes, not a nullable id ───────────────────────────────────
 * `inside`, `outside` and `error` are separate cases in a discriminated union.
 * A nullable zone id cannot distinguish "there is no coverage here" from "we
 * could not tell", and those must never be merged: the first is a product
 * decision the passenger should be told about, the second is a fault that has
 * to raise an alarm.
 */
import {
    LatLng, isUsablePoint, inBoundingBox, pointInPolygon,
    distanceToPolygonMetres, ON_BOUNDARY_TOLERANCE_M,
} from './service_zone_geometry';
import { ServiceZoneService, LoadedZone, ZoneLoadError } from './service_zone_service';
import { ServiceZoneConfig, warnZonesDisabled } from '../config/service_zone_config';

export type ZoneMatch = 'exact' | 'buffer';

export type ResolverErrorReason =
    | 'zones_disabled'
    | 'no_zones_loaded'
    | 'db_unavailable'
    | 'bad_boundary'
    | 'bad_point';

export type ZoneResolution =
    | { kind: 'inside'; zoneCode: string; match: ZoneMatch; distanceM: number }
    | { kind: 'outside'; nearestZoneCode: string | null; distanceM: number }
    | { kind: 'error'; reason: ResolverErrorReason };

export interface Point { lat: number; lng: number }

/**
 * Shared by both resolvers. Pure: takes a zone set, returns a resolution, does
 * no I/O and knows nothing about status. Keeping the ALGORITHM in one place
 * while keeping the ZONE SETS apart is what makes the two resolvers provably
 * consistent without letting either see the other's zones.
 */
export function resolveAgainst(point: Point, zones: readonly LoadedZone[]): ZoneResolution {
    if (!isUsablePoint(point.lat, point.lng)) return { kind: 'error', reason: 'bad_point' };
    if (zones.length === 0) return { kind: 'error', reason: 'no_zones_loaded' };

    // 1. Bounding-box prefilter, padded by each zone's buffer so a candidate
    //    for the buffer path is not discarded before it is measured.
    const near = zones.filter((z) => inBoundingBox(point.lat, point.lng, z.box, z.bufferMeters));

    // 2. Exact containment.
    const hits = near.filter((z) => pointInPolygon(point.lat, point.lng, z.polygon));
    if (hits.length > 0) return { kind: 'inside', zoneCode: pick(hits).code, match: 'exact', distanceM: 0 };

    // 3. Buffer. Nearest edge wins; ties resolve by the same rule as overlap.
    let best: { zone: LoadedZone; d: number } | null = null;
    for (const z of near) {
        const d = distanceToPolygonMetres(point.lat, point.lng, z.polygon);
        if (d <= z.bufferMeters && (!best || d < best.d
            || (d === best.d && rank(z) < rank(best.zone)))) {
            best = { zone: z, d };
        }
    }
    if (best) {
        // On the line is INSIDE, not inside the tolerance band. Without this a
        // pickup on a boundary counts as buffer-dependent, and that count is
        // the number that tells us whether the boundary is drawn correctly.
        const match: ZoneMatch = best.d < ON_BOUNDARY_TOLERANCE_M ? 'exact' : 'buffer';
        return { kind: 'inside', zoneCode: best.zone.code, match, distanceM: Math.round(best.d) };
    }

    // 4. Genuinely outside. Measure against EVERY zone, not just the bbox
    //    survivors, so the miss record can name the nearest one.
    let nearest: { code: string; d: number } | null = null;
    for (const z of zones) {
        const d = distanceToPolygonMetres(point.lat, point.lng, z.polygon);
        if (!nearest || d < nearest.d) nearest = { code: z.code, d };
    }
    return {
        kind: 'outside',
        nearestZoneCode: nearest?.code ?? null,
        distanceM: nearest ? Math.round(nearest.d) : 0,
    };
}

/** Highest priority, then lowest code. Total and deterministic. */
function rank(z: LoadedZone): string {
    return `${String(100000 - z.priority).padStart(6, '0')}:${z.code}`;
}
function pick(zones: LoadedZone[]): LoadedZone {
    return [...zones].sort((a, b) => (rank(a) < rank(b) ? -1 : 1))[0];
}

export class ServiceZoneResolver {
    /**
     * Resolve a point against OPERATIONAL zones.
     *
     * Never throws. Every failure path returns `kind: 'error'` with a reason,
     * because a caller that has to wrap this in try/catch will eventually
     * forget and treat a thrown fault as a miss.
     */
    static async resolve(point: Point): Promise<ZoneResolution> {
        if (!ServiceZoneConfig.enabled) {
            warnZonesDisabled({ lat: point.lat, lng: point.lng });
            return { kind: 'error', reason: 'zones_disabled' };
        }
        try {
            const zones = await ServiceZoneService.operationalZones();
            return resolveAgainst(point, zones);
        } catch (err) {
            const reason: ResolverErrorReason =
                err instanceof ZoneLoadError ? err.reason : 'db_unavailable';
            return { kind: 'error', reason };
        }
    }

    /** Convenience for the many callers that only need the code or null. */
    static codeOf(r: ZoneResolution): string | null {
        return r.kind === 'inside' ? r.zoneCode : null;
    }
}
