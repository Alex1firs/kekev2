/**
 * The migration's classification, as a test that runs in CI.
 *
 * The real proof is the rehearsal against restored production data, where the
 * migration classified 926 ONI / 20 AWK / 25 unclassified / 0 buffer-dependent
 * on the 971 rides the backup contained — 927 ONI once the one ride created
 * after the backup is included, which is exactly the approved Phase 0
 * distribution.
 *
 * That rehearsal cannot run in CI, because CI has no production data. What CI
 * can hold is the LOGIC: that classification sees draft zones, that the runtime
 * resolver does not, that a re-run writes nothing, and that a ride the resolver
 * cannot place is left null rather than forced into the nearest zone.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Ride, RideStatus } from '../../src/models/Ride';
import { ServiceZone, ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';
import { boundingBox, toGeoJson, LatLng } from '../../src/services/service_zone_geometry';
import { resolveAgainst } from '../../src/services/service_zone_resolver';
import { LoadedZone } from '../../src/services/service_zone_service';
import fixture from '../fixtures/service_zone_golden.json';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping zone backfill tests.');

const SCHEMA = 'zone_backfill_test';

/** Real coordinates from the production export, one per expected outcome. */
const SAMPLES = [
    { label: 'Onitsha core',    lat: 6.1667000, lng: 6.7833000, expect: 'ONI' },
    { label: 'Nkpor',           lat: 6.1500000, lng: 6.8333000, expect: 'ONI' },
    { label: 'Okpoko (redraw)', lat: 6.0732400, lng: 6.8185900, expect: 'ONI' },
    { label: 'Awka centre',     lat: 6.2109000, lng: 7.0740000, expect: 'AWK' },
    { label: 'Ifite',           lat: 6.2198900, lng: 7.1074800, expect: 'AWK' },
    { label: 'toward Nnewi',    lat: 6.0582400, lng: 6.8618400, expect: null  },
    { label: 'Lagos',           lat: 6.5044500, lng: 3.3473600, expect: null  },
    { label: 'Abuja',           lat: 9.0512213, lng: 7.4590974, expect: null  },
];

describeDb('service zone backfill (database)', () => {
    let ds: DataSource;
    const uuid = () => require('crypto').randomUUID();

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: SCHEMA,
            extra: { options: `-c search_path=${SCHEMA},public` },
            entities: [Ride, ServiceZone], synchronize: true, logging: false,
        });
        await ds.initialize();
        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });
    });

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        for (const t of ['ride', 'service_zone']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
        await seed();
    });

    async function seed() {
        const repo = ds.getRepository(ServiceZone);
        for (const spec of fixture.zones as any[]) {
            const polygon: LatLng[] = spec.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
            const box = boundingBox(polygon);
            await repo.save(repo.create({
                code: spec.code, name: spec.name, boundary: toGeoJson(polygon) as unknown,
                bboxMinLat: box.minLat, bboxMinLng: box.minLng,
                bboxMaxLat: box.maxLat, bboxMaxLng: box.maxLng,
                bufferMeters: spec.bufferMeters, priority: spec.priority,
                status: spec.code === 'ONI' ? ServiceZoneStatus.ACTIVE : ServiceZoneStatus.DRAFT,
                enforcement: ZoneEnforcement.OFF,
            } as any));
        }
    }

    /** Load a zone set the way the migration does, from the database. */
    async function zoneSet(statuses: ServiceZoneStatus[]): Promise<LoadedZone[]> {
        const rows = await ds.getRepository(ServiceZone).find();
        return rows.filter((r) => statuses.includes(r.status)).map((r) => {
            const g = r.boundary as any;
            const polygon = g.coordinates[0].slice(0, -1)
                .map((p: number[]) => [p[1], p[0]] as LatLng);
            return {
                code: r.code, name: r.name, polygon, box: boundingBox(polygon),
                bufferMeters: r.bufferMeters, priority: r.priority,
                status: r.status, enforcement: r.enforcement, radiusTiersKm: null,
            };
        });
    }

    async function ride(lat: number, lng: number) {
        const rideId = `RIDE-${uuid()}`;
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId: uuid(), status: RideStatus.COMPLETED, fare: 1000,
            paymentMode: 'cash', pickupLat: lat, pickupLng: lng,
        } as any));
        return rideId;
    }

    /** The migration's backfill, in the same shape. */
    async function backfill(zones: LoadedZone[]) {
        const rows = await ds.query(
            `SELECT "rideId","pickupLat","pickupLng" FROM ${SCHEMA}."ride"
              WHERE "zoneCode" IS NULL AND "zoneMatchKind" IS NULL`);
        let written = 0;
        for (const r of rows) {
            const res = resolveAgainst({ lat: Number(r.pickupLat), lng: Number(r.pickupLng) }, zones);
            await ds.query(
                `UPDATE ${SCHEMA}."ride" SET "zoneCode" = $2, "zoneMatchKind" = $3 WHERE "rideId" = $1`,
                [r.rideId, res.kind === 'inside' ? res.zoneCode : null,
                    res.kind === 'inside' ? res.match : 'none']);
            written += 1;
        }
        return written;
    }

    it.each(SAMPLES)('classifies $label as $expect', async (s) => {
        const rideId = await ride(s.lat, s.lng);
        await backfill(await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]));

        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBe(s.expect);
        expect(row!.zoneMatchKind).toBe(s.expect ? 'exact' : 'none');
    });

    it('an Awka ride is classified AWK even though AWK is draft', async () => {
        // The apparent contradiction, resolved: classification sees drafts.
        const rideId = await ride(6.2109, 7.0740);
        await backfill(await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]));
        expect((await ds.getRepository(Ride).findOneBy({ rideId }))!.zoneCode).toBe('AWK');

        // And the runtime set, which is `active` only, cannot reach it.
        const runtime = await zoneSet([ServiceZoneStatus.ACTIVE]);
        expect(runtime.map((z) => z.code)).toEqual(['ONI']);
        const live = resolveAgainst({ lat: 6.2109, lng: 7.0740 }, runtime);
        expect(live.kind).toBe('outside');
    });

    it('an unclassifiable ride is left NULL, never forced into the nearest zone', async () => {
        const rideId = await ride(6.5044500, 3.3473600);        // Lagos
        await backfill(await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]));
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBeNull();
        expect(row!.zoneMatchKind).toBe('none');
    });

    it('is idempotent — a second run writes nothing and changes nothing', async () => {
        for (const s of SAMPLES) await ride(s.lat, s.lng);
        const zones = await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]);

        const first = await backfill(zones);
        const after = await ds.query(
            `SELECT "rideId","zoneCode","zoneMatchKind" FROM ${SCHEMA}."ride" ORDER BY "rideId"`);

        const second = await backfill(zones);
        const again = await ds.query(
            `SELECT "rideId","zoneCode","zoneMatchKind" FROM ${SCHEMA}."ride" ORDER BY "rideId"`);

        expect(first).toBe(SAMPLES.length);
        expect(second).toBe(0);                 // nothing left matching the guard
        expect(again).toEqual(after);
    });

    it('never overwrites a zone already recorded on a ride', async () => {
        const rideId = await ride(6.1667, 6.7833);
        await ds.query(
            `UPDATE ${SCHEMA}."ride" SET "zoneCode"='AWK', "zoneMatchKind"='exact' WHERE "rideId"=$1`,
            [rideId]);

        const written = await backfill(await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]));

        expect(written).toBe(0);
        // Deliberately wrong, and deliberately left alone: history is not
        // recomputed, and a backfill that "corrected" rows would be doing
        // exactly that.
        expect((await ds.getRepository(Ride).findOneBy({ rideId }))!.zoneCode).toBe('AWK');
    });

    it('the approved distribution shape holds on a representative sample', async () => {
        for (const s of SAMPLES) await ride(s.lat, s.lng);
        await backfill(await zoneSet([ServiceZoneStatus.ACTIVE, ServiceZoneStatus.DRAFT]));

        const rows = await ds.query(
            `SELECT "zoneCode", "zoneMatchKind", count(*)::int AS n
               FROM ${SCHEMA}."ride" GROUP BY 1,2`);
        const by = Object.fromEntries(rows.map((r: any) => [`${r.zoneCode}:${r.zoneMatchKind}`, r.n]));

        expect(by['ONI:exact']).toBe(3);
        expect(by['AWK:exact']).toBe(2);
        expect(by['null:none']).toBe(3);
        // The property that matters most: nothing relied on the buffer.
        expect(Object.keys(by).some((k) => k.endsWith(':buffer'))).toBe(false);
    });
});
