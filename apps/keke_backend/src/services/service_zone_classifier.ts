/**
 * The CLASSIFICATION resolver. Which approved zone does this historical point
 * belong to?
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS FILE MUST NOT BE IMPORTED BY ANY DISPATCH, SOCKET, OPERATIONS OR
 *  DRIVER-SELECTION CODE. It is for migrations, backfills and reports only.
 *  A test asserts this (see zone_separation.test.ts) and will fail the build
 *  if the import appears anywhere it should not.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this exists at all ──────────────────────────────────────────────
 * Twenty of the 972 historical rides were requested in Awka. They must be
 * classified as AWK — that is simply what they are, and a demand report that
 * called them "outside" would be wrong. But Awka is not open: AWK is seeded as
 * `draft`, and a draft zone must not become dispatchable merely because a
 * migration needed its geometry.
 *
 * The obvious implementation is one resolver with an `includeDraft` flag. That
 * is precisely what is avoided here: a boolean parameter on the function that
 * decides where rides go is one careless call away from making an unopened
 * city live. Instead there are two functions with different names, returning
 * different types, drawing from different zone sets, in different files.
 *
 * The ALGORITHM is shared (resolveAgainst, in the runtime resolver) so the two
 * can never disagree about geometry — only about which zones they can see.
 */
import { resolveAgainst, Point, ZoneMatch } from './service_zone_resolver';
import { ServiceZoneService } from './service_zone_service';

/**
 * Deliberately NOT `ZoneResolution`.
 *
 * A different type means a classification cannot be passed to something
 * expecting a runtime resolution without the compiler objecting — the mistake
 * this whole separation exists to prevent becomes a build failure rather than a
 * production incident.
 */
export type ZoneClassification =
    | { kind: 'classified'; zoneCode: string; match: ZoneMatch }
    | { kind: 'unclassified'; nearestZoneCode: string | null; distanceM: number }
    | { kind: 'indeterminate'; reason: string };

export class ZoneClassifier {
    /**
     * Classify a point against every APPROVED geometry, including drafts.
     *
     * For historical backfill and demand reporting. This answer must never
     * select a driver, gate a request, or reach a dispatch decision.
     */
    static async classify(point: Point): Promise<ZoneClassification> {
        let zones;
        try {
            zones = await ServiceZoneService.classifiableZones();
        } catch (err: any) {
            return { kind: 'indeterminate', reason: err?.reason ?? 'load_failed' };
        }

        const r = resolveAgainst(point, zones);
        switch (r.kind) {
            case 'inside':
                return { kind: 'classified', zoneCode: r.zoneCode, match: r.match };
            case 'outside':
                return {
                    kind: 'unclassified',
                    nearestZoneCode: r.nearestZoneCode,
                    distanceM: r.distanceM,
                };
            case 'error':
                return { kind: 'indeterminate', reason: r.reason };
        }
    }
}
