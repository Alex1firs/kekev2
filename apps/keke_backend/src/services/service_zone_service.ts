/**
 * Loading, caching and writing service zones.
 *
 * Everything that reads a zone goes through here, and this file is the ONLY
 * place that knows which statuses mean what. That matters for the separation
 * the rollout depends on: an operational zone set and a classifiable zone set
 * are produced by two different methods with two different names, so a caller
 * cannot obtain draft geometry by passing a flag.
 */
import { AppDataSource } from '../config/data_source';
import {
    ServiceZone,
    ServiceZoneStatus,
    ZoneEnforcement,
    OPERATIONAL_STATUSES,
    CLASSIFIABLE_STATUSES,
} from '../models/ServiceZone';
import { ServiceZoneConfig } from '../config/service_zone_config';
import {
    LatLng, BoundingBox, boundingBox, fromGeoJson, toGeoJson,
} from './service_zone_geometry';

/** A zone with its boundary already parsed. What the resolvers actually use. */
export interface LoadedZone {
    code: string;
    name: string;
    polygon: LatLng[];
    box: BoundingBox;
    bufferMeters: number;
    priority: number;
    status: ServiceZoneStatus;
    enforcement: ZoneEnforcement;
    radiusTiersKm: number[] | null;
}

interface CacheEntry {
    zones: LoadedZone[];
    loadedAt: number;
}

export class ZoneLoadError extends Error {
    constructor(readonly reason: 'db_unavailable' | 'no_zones_loaded' | 'bad_boundary') {
        super(`service zone load failed: ${reason}`);
        this.name = 'ZoneLoadError';
    }
}

export class ServiceZoneService {
    private static operationalCache: CacheEntry | null = null;
    private static classifiableCache: CacheEntry | null = null;

    /** Called after any write, and by tests. */
    static bustCache(): void {
        this.operationalCache = null;
        this.classifiableCache = null;
    }

    // ── the two zone sets ───────────────────────────────────────────────

    /**
     * Zones that may influence DISPATCH. `active` only.
     *
     * There is deliberately no parameter here. A draft zone cannot be obtained
     * from this method under any argument, which is what stops a boundary drawn
     * for next quarter from quietly becoming dispatchable.
     */
    static async operationalZones(): Promise<LoadedZone[]> {
        return this.load('operational', OPERATIONAL_STATUSES, () => this.operationalCache,
            (e) => { this.operationalCache = e; });
    }

    /**
     * Zones whose geometry is APPROVED, including drafts.
     *
     * For classifying history and for reporting. Never for selecting a driver.
     * See service_zone_classifier.ts, which is the only consumer, and the
     * architecture test that keeps it that way.
     */
    static async classifiableZones(): Promise<LoadedZone[]> {
        return this.load('classifiable', CLASSIFIABLE_STATUSES, () => this.classifiableCache,
            (e) => { this.classifiableCache = e; });
    }

    private static async load(
        label: string,
        statuses: ServiceZoneStatus[],
        get: () => CacheEntry | null,
        set: (e: CacheEntry) => void,
    ): Promise<LoadedZone[]> {
        const cached = get();
        if (cached && Date.now() - cached.loadedAt < ServiceZoneConfig.cacheTtlMs) {
            return cached.zones;
        }

        let rows: ServiceZone[];
        try {
            rows = await AppDataSource.getRepository(ServiceZone).find();
        } catch (err: any) {
            console.error(JSON.stringify({
                level: 'error', scope: 'service_zone', event: 'zone_load_failed',
                set: label, error: err?.message ?? 'unknown',
            }));
            throw new ZoneLoadError('db_unavailable');
        }

        const zones: LoadedZone[] = [];
        for (const row of rows) {
            if (!statuses.includes(row.status)) continue;
            const polygon = fromGeoJson(row.boundary);
            if (!polygon) {
                // A single malformed boundary must not silently shrink the zone
                // set — that would look exactly like "this point is outside".
                console.error(JSON.stringify({
                    level: 'error', scope: 'service_zone', event: 'bad_boundary',
                    zoneCode: row.code,
                }));
                throw new ZoneLoadError('bad_boundary');
            }
            zones.push({
                code: row.code,
                name: row.name,
                polygon,
                // Trust the stored bbox only if it is present and sane; otherwise
                // derive. The prefilter being wrong would produce false misses.
                box: Number.isFinite(row.bboxMinLat) ? {
                    minLat: row.bboxMinLat, minLng: row.bboxMinLng,
                    maxLat: row.bboxMaxLat, maxLng: row.bboxMaxLng,
                } : boundingBox(polygon),
                bufferMeters: row.bufferMeters,
                priority: row.priority,
                status: row.status,
                enforcement: row.enforcement,
                radiusTiersKm: Array.isArray(row.radiusTiersKm) ? row.radiusTiersKm : null,
            });
        }

        set({ zones, loadedAt: Date.now() });
        return zones;
    }

    // ── the failure policy, derived rather than remembered ──────────────

    /**
     * How many zones are actively enforcing right now.
     *
     * This is what decides whether a resolver FAILURE falls open or fails safe.
     * It is counted from the live zone set rather than configured, so activating
     * Awka flips the policy by itself: nobody edits a condition, nobody names a
     * city, and there is no date for anyone to remember.
     */
    static async enforcingZoneCount(): Promise<number> {
        const zones = await this.operationalZones();
        return zones.filter((z) => z.enforcement === ZoneEnforcement.ENFORCE).length;
    }

    /**
     * Should a resolver failure refuse the request?
     *
     *   0 or 1 enforcing zone — no. A failure cannot produce a cross-city
     *     dispatch because there is nowhere else to dispatch to, so falling
     *     open preserves service, which is the greater risk while one city is
     *     alone. This is the deliberately defined legacy behaviour.
     *   2 or more — yes. A failure could now hand an Onitsha ride to an Awka
     *     driver, and refusing is the safer error.
     */
    static async shouldFailClosed(): Promise<boolean> {
        try {
            return (await this.enforcingZoneCount()) >= 2;
        } catch {
            // Cannot even count the zones. With the architecture this broken,
            // the safe reading is the conservative one — but only once more
            // than one zone has ever been enforcing, which we cannot know here.
            // Falling open matches the single-zone case that is live today and
            // is loudly logged by the caller.
            return false;
        }
    }

    // ── writes ──────────────────────────────────────────────────────────

    static async upsertByCode(input: {
        code: string;
        name: string;
        state?: string | null;
        polygon: LatLng[];
        bufferMeters?: number;
        priority?: number;
        status?: ServiceZoneStatus;
        enforcement?: ZoneEnforcement;
        radiusTiersKm?: number[] | null;
        createdByStaffId?: string | null;
    }): Promise<ServiceZone> {
        const repo = AppDataSource.getRepository(ServiceZone);
        const box = boundingBox(input.polygon);
        const existing = await repo.findOneBy({ code: input.code });

        const row = existing ?? repo.create({ code: input.code });
        row.name = input.name;
        row.state = input.state ?? row.state ?? null;
        row.boundary = toGeoJson(input.polygon) as unknown;
        row.bboxMinLat = box.minLat;
        row.bboxMinLng = box.minLng;
        row.bboxMaxLat = box.maxLat;
        row.bboxMaxLng = box.maxLng;
        if (input.bufferMeters !== undefined) row.bufferMeters = input.bufferMeters;
        if (input.priority !== undefined) row.priority = input.priority;
        if (input.status !== undefined) row.status = input.status;
        if (input.enforcement !== undefined) row.enforcement = input.enforcement;
        if (input.radiusTiersKm !== undefined) row.radiusTiersKm = input.radiusTiersKm;
        if (input.createdByStaffId !== undefined) row.createdByStaffId = input.createdByStaffId;

        const saved = await repo.save(row);
        this.bustCache();
        console.log(JSON.stringify({
            level: 'info', scope: 'service_zone', event: 'zone_saved',
            zoneCode: saved.code, status: saved.status, enforcement: saved.enforcement,
            vertices: input.polygon.length,
        }));
        return saved;
    }

    /**
     * Change a zone's operational dials.
     *
     * Deliberately separate from geometry: redrawing a boundary and turning
     * enforcement on are different decisions with different blast radii, and a
     * single "update zone" endpoint invites doing both in one unreviewed call.
     */
    static async setMode(code: string, patch: {
        status?: ServiceZoneStatus;
        enforcement?: ZoneEnforcement;
    }): Promise<ServiceZone | null> {
        const repo = AppDataSource.getRepository(ServiceZone);
        const row = await repo.findOneBy({ code });
        if (!row) return null;

        const before = { status: row.status, enforcement: row.enforcement };
        if (patch.status !== undefined) row.status = patch.status;
        if (patch.enforcement !== undefined) row.enforcement = patch.enforcement;

        // A zone cannot enforce something it is not operating. Without this,
        // `draft + enforce` is representable and means nothing.
        if (row.enforcement === ZoneEnforcement.ENFORCE && row.status !== ServiceZoneStatus.ACTIVE) {
            throw new Error(
                `zone ${code} cannot enforce while status is "${row.status}" — activate it first.`);
        }

        const saved = await repo.save(row);
        this.bustCache();
        console.log(JSON.stringify({
            level: 'info', scope: 'service_zone', event: 'zone_mode_changed',
            zoneCode: code, before, after: { status: saved.status, enforcement: saved.enforcement },
        }));
        return saved;
    }

    static async list(): Promise<ServiceZone[]> {
        return AppDataSource.getRepository(ServiceZone).find({ order: { code: 'ASC' } });
    }
}
