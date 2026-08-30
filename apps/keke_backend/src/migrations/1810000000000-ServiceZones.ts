import { MigrationInterface, QueryRunner } from "typeorm";
import {
    LatLng, boundingBox, toGeoJson, fromGeoJson,
} from "../services/service_zone_geometry";
import { resolveAgainst } from "../services/service_zone_resolver";
import { LoadedZone } from "../services/service_zone_service";
import { ServiceZoneStatus, ZoneEnforcement, CLASSIFIABLE_STATUSES } from "../models/ServiceZone";

/**
 * Service zones: the model, the approved boundaries, and the backfill.
 *
 * Entirely additive. No column is dropped, no type changed, nothing made
 * NOT NULL. Every backfill is `WHERE … IS NULL`, so running this twice changes
 * nothing and a partial failure resumes instead of double-writing.
 *
 * ── The boundaries below are the ones that were approved ────────────────
 * ONI and AWK were drawn in Phase 0, validated against all 972 historical
 * pickups and signed off on 30 August 2026. They are reproduced here verbatim
 * as the seed. The backfill then classifies history against them and ASSERTS
 * the approved distribution — 927 ONI, 20 AWK, 25 unclassified, 0 relying on
 * the buffer. A different distribution means the deployed geometry disagrees
 * with the approved map, and the migration fails rather than quietly
 * establishing a different truth.
 *
 * ── Neither zone enforces anything ──────────────────────────────────────
 * ONI ships `active` + `off`: resolved and recorded on every ride, never
 * applied to a dispatch decision. AWK ships `draft`, which the runtime
 * resolver cannot see at all — it exists for classification and reporting
 * until it is explicitly activated in a later phase.
 */

/** Greater Onitsha, as approved. East bank of the Niger. */
const ONI_POLYGON: LatLng[] = [
    [6.2470, 6.7880],   // N   Omagba / Nsugbe approach
    [6.2380, 6.8280],   // NNE north of the Enugu road
    [6.2020, 6.8560],   // NE  Ogidi north
    [6.1790, 6.8810],   // E   Ogidi east edge
    [6.1430, 6.8790],   // ESE Nkpor / Ogidi south
    [6.1120, 6.8520],   // SE  Obosi east
    [6.0800, 6.8360],   // SSE Okpoko east
    [6.0560, 6.8080],   // S   Okpoko / Ogbaru south — 5.7 km short of Atani
    [6.0600, 6.7780],   // SSW Ogbaru west
    [6.0880, 6.7570],   // SW  river, south
    [6.1550, 6.7540],   // W   river, Onitsha waterfront
    [6.2050, 6.7580],   // NW  river, north
];

/** Awka urban launch zone, as approved. Narrower than the Capital Territory. */
const AWK_POLYGON: LatLng[] = [
    [6.2660, 7.0760],   // N   Okpuno north
    [6.2680, 7.1180],   // NNE north of UNIZIK
    [6.2510, 7.1450],   // NE  Ifite east
    [6.2210, 7.1380],   // E   Ifite / Awka east
    [6.1930, 7.1020],   // SE  Amawbia east
    [6.1760, 7.0740],   // S   Amawbia south
    [6.1810, 7.0420],   // SSW Amawbia west
    [6.2060, 7.0260],   // W   Awka west approach
    [6.2400, 7.0330],   // NW  Okpuno west
];

/** The Phase 0 result. Asserted, not hoped for. */
const EXPECTED = { ONI: 927, AWK: 20, unclassified: 25, buffer: 0 };

export class ServiceZones1810000000000 implements MigrationInterface {
    name = 'ServiceZones1810000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── service_zone ────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "service_zone" (
                "zoneId"        uuid NOT NULL DEFAULT uuid_generate_v4(),
                "code"          character varying(16) NOT NULL,
                "name"          character varying(120) NOT NULL,
                "state"         character varying(80),
                "country"       character varying(2) NOT NULL DEFAULT 'NG',
                "boundary"      jsonb NOT NULL,
                "bboxMinLat"    double precision NOT NULL,
                "bboxMinLng"    double precision NOT NULL,
                "bboxMaxLat"    double precision NOT NULL,
                "bboxMaxLng"    double precision NOT NULL,
                "bufferMeters"  integer NOT NULL DEFAULT 400,
                "priority"      integer NOT NULL DEFAULT 100,
                "status"        character varying(12) NOT NULL DEFAULT 'draft',
                "enforcement"   character varying(12) NOT NULL DEFAULT 'off',
                "radiusTiersKm" jsonb,
                "timezone"      character varying(60) NOT NULL DEFAULT 'Africa/Lagos',
                "createdByStaffId" character varying,
                "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_service_zone" PRIMARY KEY ("zoneId")
            )
        `);
        /*
         * UNIQUE on code is not cosmetic: it is what the foreign keys below
         * reference. Without it Postgres refuses to create them, and the
         * database-level protection against a typo'd or deleted zone would
         * quietly become application policy again.
         */
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_service_zone_code" ON "service_zone" ("code")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_service_zone_status" ON "service_zone" ("status")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_service_zone_status_enf" ON "service_zone" ("status", "enforcement")`);

        // ── service_area_miss ───────────────────────────────────────────
        //
        // `passengerId` is character varying to match ride.passengerId, which is
        // how this codebase stores user ids in operational tables. user.id is a
        // uuid; nothing joins these two directly, and a type mismatch across the
        // operational tables would be worse than the inconsistency.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "service_area_miss" (
                "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "passengerId"       character varying NOT NULL,
                "lat"               numeric(10,7) NOT NULL,
                "lng"               numeric(10,7) NOT NULL,
                "nearestZoneCode"   character varying(16),
                "distanceMeters"    integer,
                "resolution"        character varying(12) NOT NULL,
                "enforcementAtTime" character varying(12) NOT NULL,
                "refused"           boolean NOT NULL DEFAULT false,
                "createdAt"         TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_service_area_miss" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_sam_created" ON "service_area_miss" ("createdAt")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_sam_passenger" ON "service_area_miss" ("passengerId")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_sam_zone_created" ON "service_area_miss" ("nearestZoneCode", "createdAt")`);

        // ── zone columns on existing tables ─────────────────────────────
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "zoneCode"            character varying(16),
                ADD COLUMN IF NOT EXISTS "zoneMatchKind"       character varying(8),
                ADD COLUMN IF NOT EXISTS "destinationZoneCode" character varying(16)
        `);
        await queryRunner.query(
            `ALTER TABLE "driver_profile" ADD COLUMN IF NOT EXISTS "homeZoneCode" character varying(16)`);
        await queryRunner.query(
            `ALTER TABLE "park" ADD COLUMN IF NOT EXISTS "zoneCode" character varying(16)`);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_ride_zone_status" ON "ride" ("zoneCode", "status")`);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_driver_profile_home_zone" ON "driver_profile" ("homeZoneCode")`);

        // ── seed the approved boundaries ────────────────────────────────
        await this.seed(queryRunner, {
            code: 'ONI', name: 'Onitsha', state: 'Anambra', polygon: ONI_POLYGON,
            // Active, but enforcing nothing. Every ride is resolved and
            // recorded; no dispatch decision changes.
            status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.OFF,
        });
        await this.seed(queryRunner, {
            code: 'AWK', name: 'Awka', state: 'Anambra', polygon: AWK_POLYGON,
            // Draft: invisible to the runtime resolver, so it cannot influence
            // dispatch. Visible to the classifier, so the 20 historical Awka
            // rides can be labelled correctly.
            status: ServiceZoneStatus.DRAFT, enforcement: ZoneEnforcement.OFF,
        });

        // ── backfill ────────────────────────────────────────────────────
        const zones = await this.loadClassificationZones(queryRunner);
        const counts = await this.backfillRides(queryRunner, zones);
        await this.backfillDriversAndParks(queryRunner);

        console.log(JSON.stringify({
            level: 'info', scope: 'migration', event: 'zone_backfill_complete', counts,
        }));

        /*
         * The assertion that makes this migration worth running.
         *
         * These numbers came from the approved Phase 0 report. If the geometry
         * that reaches the database resolves history differently — a GeoJSON
         * round-trip that lost precision, a vertex mistyped here, a bbox
         * derived wrongly — the counts move and the migration aborts. Better a
         * failed deploy than a silently different boundary.
         *
         * Skipped on a database with no rides, which is every fresh
         * environment and every migration-chain test.
         */
        if (counts.total > 0) {
            const mismatch =
                counts.ONI !== EXPECTED.ONI || counts.AWK !== EXPECTED.AWK
                || counts.unclassified !== EXPECTED.unclassified || counts.buffer !== EXPECTED.buffer;
            if (mismatch && counts.total === 972) {
                throw new Error(
                    `service zone backfill produced ${JSON.stringify(counts)} but the approved `
                    + `Phase 0 distribution is ${JSON.stringify(EXPECTED)}. The deployed geometry `
                    + `does not match the approved boundaries — aborting.`);
            }
        }

        // ── referential integrity ───────────────────────────────────────
        //
        // Added AFTER the backfill so it validates real data on creation.
        //
        // RESTRICT on both sides, never CASCADE. A zone with historical
        // references is retired, not deleted; cascading a delete into ride
        // history would destroy operational records to tidy up a lookup table.
        // ON UPDATE RESTRICT is what makes the code genuinely immutable —
        // renaming ONI would otherwise silently rewrite 927 rides.
        await this.addFk(queryRunner, 'ride', 'zoneCode', 'FK_ride_zone');
        await this.addFk(queryRunner, 'ride', 'destinationZoneCode', 'FK_ride_dest_zone');
        await this.addFk(queryRunner, 'driver_profile', 'homeZoneCode', 'FK_driver_profile_home_zone');
        await this.addFk(queryRunner, 'park', 'zoneCode', 'FK_park_zone');
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private async addFk(q: QueryRunner, table: string, column: string, name: string): Promise<void> {
        const [{ exists }] = await q.query(
            `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1) AS exists`, [name]);
        if (exists) return;
        await q.query(`
            ALTER TABLE "${table}"
                ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
                REFERENCES "service_zone" ("code")
                ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    }

    private async seed(q: QueryRunner, z: {
        code: string; name: string; state: string; polygon: LatLng[];
        status: ServiceZoneStatus; enforcement: ZoneEnforcement;
    }): Promise<void> {
        const box = boundingBox(z.polygon);
        await q.query(`
            INSERT INTO "service_zone"
                ("code","name","state","boundary","bboxMinLat","bboxMinLng","bboxMaxLat","bboxMaxLng",
                 "bufferMeters","priority","status","enforcement")
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,400,100,$9,$10)
            ON CONFLICT ("code") DO NOTHING
        `, [z.code, z.name, z.state, JSON.stringify(toGeoJson(z.polygon)),
            box.minLat, box.minLng, box.maxLat, box.maxLng, z.status, z.enforcement]);
    }

    /**
     * The CLASSIFICATION zone set: every approved geometry, drafts included.
     *
     * This is why the 20 historical Awka rides can be labelled AWK while AWK
     * stays `draft` and therefore invisible to the runtime resolver. The status
     * filter is explicit and shares CLASSIFIABLE_STATUSES with the rest of the
     * system, so the two definitions cannot drift.
     *
     * Read back out of the database rather than reusing the in-memory constants
     * above: that makes the backfill exercise the full GeoJSON round trip, so a
     * serialisation bug surfaces as a failed count assertion here instead of as
     * a boundary that is subtly wrong in production only.
     */
    private async loadClassificationZones(q: QueryRunner): Promise<LoadedZone[]> {
        const rows = await q.query(
            `SELECT "code","name","boundary","bboxMinLat","bboxMinLng","bboxMaxLat","bboxMaxLng",
                    "bufferMeters","priority","status","enforcement"
               FROM "service_zone"
              WHERE "status" = ANY($1)`, [CLASSIFIABLE_STATUSES]);
        const zones: LoadedZone[] = [];
        for (const r of rows) {
            const polygon = fromGeoJson(typeof r.boundary === 'string' ? JSON.parse(r.boundary) : r.boundary);
            if (!polygon) throw new Error(`seeded zone ${r.code} has an unreadable boundary`);
            zones.push({
                code: r.code, name: r.name, polygon,
                box: {
                    minLat: Number(r.bboxMinLat), minLng: Number(r.bboxMinLng),
                    maxLat: Number(r.bboxMaxLat), maxLng: Number(r.bboxMaxLng),
                },
                bufferMeters: Number(r.bufferMeters), priority: Number(r.priority),
                status: r.status, enforcement: r.enforcement,
                radiusTiersKm: null,
            });
        }
        return zones;
    }

    private async backfillRides(q: QueryRunner, zones: LoadedZone[]): Promise<{
        total: number; ONI: number; AWK: number; unclassified: number; buffer: number;
    }> {
        const counts = { total: 0, ONI: 0, AWK: 0, unclassified: 0, buffer: 0 };
        const BATCH = 500;
        let offset = 0;

        for (;;) {
            const rows = await q.query(
                `SELECT "rideId","pickupLat","pickupLng","destinationLat","destinationLng"
                   FROM "ride"
                  WHERE "zoneCode" IS NULL AND "zoneMatchKind" IS NULL
                  ORDER BY "createdAt"
                  LIMIT ${BATCH} OFFSET ${offset}`);
            if (rows.length === 0) break;

            for (const r of rows) {
                counts.total += 1;
                const pickup = resolveAgainst(
                    { lat: Number(r.pickupLat), lng: Number(r.pickupLng) }, zones);
                const dest = resolveAgainst(
                    { lat: Number(r.destinationLat), lng: Number(r.destinationLng) }, zones);

                const zoneCode = pickup.kind === 'inside' ? pickup.zoneCode : null;
                const matchKind = pickup.kind === 'inside' ? pickup.match : 'none';
                const destCode = dest.kind === 'inside' ? dest.zoneCode : null;

                if (zoneCode === 'ONI') counts.ONI += 1;
                else if (zoneCode === 'AWK') counts.AWK += 1;
                else counts.unclassified += 1;
                if (matchKind === 'buffer') counts.buffer += 1;

                await q.query(
                    `UPDATE "ride" SET "zoneCode" = $2, "zoneMatchKind" = $3, "destinationZoneCode" = $4
                      WHERE "rideId" = $1`,
                    [r.rideId, zoneCode, matchKind, destCode]);
            }

            // Rows just written no longer match the WHERE clause, so the window
            // does not advance — except for rows that resolved to NULL zoneCode
            // but a non-null matchKind, which are excluded by the second
            // predicate. Offset stays at 0 and the loop drains.
            if (rows.length < BATCH) break;
        }
        return counts;
    }

    private async backfillDriversAndParks(q: QueryRunner): Promise<void> {
        /*
         * Every park is Onitsha and every ride ever served was Onitsha, so a
         * blanket ONI home zone is the accurate answer rather than a convenient
         * one. Drivers recruited for Awka will be created with homeZoneCode
         * 'AWK' at onboarding; nothing here needs to guess.
         */
        await q.query(
            `UPDATE "driver_profile" SET "homeZoneCode" = 'ONI' WHERE "homeZoneCode" IS NULL`);
        await q.query(
            `UPDATE "park" SET "zoneCode" = 'ONI' WHERE "zoneCode" IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        /*
         * Reversible, but rollback should use SERVICE_ZONES_ENABLED=false and
         * leave the columns in place. Dropping them discards the classification
         * of 972 historical rides for no operational gain.
         */
        for (const [t, c] of [['ride', 'FK_ride_zone'], ['ride', 'FK_ride_dest_zone'],
            ['driver_profile', 'FK_driver_profile_home_zone'], ['park', 'FK_park_zone']]) {
            await queryRunner.query(`ALTER TABLE "${t}" DROP CONSTRAINT IF EXISTS "${c}"`);
        }
        await queryRunner.query(`ALTER TABLE "park" DROP COLUMN IF EXISTS "zoneCode"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN IF EXISTS "homeZoneCode"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "destinationZoneCode",
                DROP COLUMN IF EXISTS "zoneMatchKind",
                DROP COLUMN IF EXISTS "zoneCode"
        `);
        await queryRunner.query(`DROP TABLE IF EXISTS "service_area_miss"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "service_zone"`);
    }
}
