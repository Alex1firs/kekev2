/**
 * The Awka launch rehearsal.
 *
 * Everything here runs against AWK as it will be on launch day — `active` and
 * `enforce` — while production keeps it `draft`/`off`. That is the point: the
 * only thing standing between this passing suite and a live second city is a
 * configuration change somebody makes deliberately.
 *
 * Four things are proven simultaneously, because proving them one at a time is
 * how a multi-city platform leaks:
 *
 *   1. An Awka ride finds Awka drivers and completes.
 *   2. Onitsha is completely unaffected while that happens.
 *   3. A Kano ride reaches nobody in either city.
 *   4. A driver who genuinely drives from Onitsha to Awka becomes eligible in
 *      Awka — and the same driver with a stale position does not.
 *
 * Real Postgres and real Redis: ioredis-mock implements no GEO commands, so a
 * multi-city dispatch test against it would exercise none of the geography.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping Awka launch rehearsal.');

jest.mock('../../src/config/redis', () => {
    const IORedis = require('ioredis');
    // Own logical database — FLUSHALL in a sibling suite would otherwise wipe
    // the presence keys this suite depends on, mid-test.
    const client = new IORedis(process.env.TEST_REDIS_URL || 'redis://localhost:6399/5');
    return { redis: client, default: client };
});

import { Ride, RideStatus } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { ServiceZone, ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';
import { ServiceAreaMiss } from '../../src/models/ServiceAreaMiss';
import { DriverPresenceIntent, PresenceIntent, IntentActor } from '../../src/models/DriverPresenceIntent';
import { DeviceToken } from '../../src/models/DeviceToken';
import { LedgerEntry } from '../../src/models/LedgerEntry';
import { Transaction } from '../../src/models/Transaction';
import { boundingBox, toGeoJson, LatLng } from '../../src/services/service_zone_geometry';
import golden from '../fixtures/service_zone_golden.json';

const SCHEMA = 'awka_launch_test';

/** Real coordinates from the approved boundaries. */
const ONITSHA = { lat: 6.1667, lng: 6.7833 };
const ONITSHA_NEAR = { lat: 6.1670, lng: 6.7840 };
const AWKA = { lat: 6.2109, lng: 7.0740 };
const AWKA_IFITE = { lat: 6.2450, lng: 7.1180 };
const AWKA_AMAWBIA = { lat: 6.1900, lng: 7.0700 };
const KANO = { lat: 12.0363172, lng: 8.4730917 };

describeDb('Awka launch rehearsal (database)', () => {
    let ds: DataSource;
    let redis: any;
    let DispatchService: typeof import('../../src/services/dispatch_service').DispatchService;
    let DriverEligibilityService: typeof import('../../src/services/driver_eligibility_service').DriverEligibilityService;
    let DriverCandidateService: typeof import('../../src/services/driver_candidate_service').DriverCandidateService;
    let DriverZoneEligibility: typeof import('../../src/services/driver_zone_eligibility').DriverZoneEligibility;
    let ServiceZoneService: typeof import('../../src/services/service_zone_service').ServiceZoneService;
    let ServiceZonePolicy: typeof import('../../src/services/service_zone_policy').ServiceZonePolicy;
    let ServiceZoneResolver: typeof import('../../src/services/service_zone_resolver').ServiceZoneResolver;

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
            entities: [Ride, User, Wallet, DriverProfile, ServiceZone, ServiceAreaMiss,
                DriverPresenceIntent, DeviceToken, LedgerEntry, Transaction],
            synchronize: true, logging: false,
        });
        await ds.initialize();
        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });

        DispatchService = require('../../src/services/dispatch_service').DispatchService;
        DriverEligibilityService = require('../../src/services/driver_eligibility_service').DriverEligibilityService;
        DriverCandidateService = require('../../src/services/driver_candidate_service').DriverCandidateService;
        DriverZoneEligibility = require('../../src/services/driver_zone_eligibility').DriverZoneEligibility;
        ServiceZoneService = require('../../src/services/service_zone_service').ServiceZoneService;
        ServiceZonePolicy = require('../../src/services/service_zone_policy').ServiceZonePolicy;
        ServiceZoneResolver = require('../../src/services/service_zone_resolver').ServiceZoneResolver;
        redis = require('../../src/config/redis').redis;
    });

    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy();
        try { await redis?.quit(); } catch { /* already closed */ }
    });

    beforeEach(async () => {
        for (const t of ['ride', 'driver_profile', 'wallet', 'service_area_miss',
            'driver_presence_intent', 'device_token', 'service_zone', 'ledger_entry',
            'transaction', 'user']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
        await redis.flushdb();
        ServiceZoneService.bustCache();
    });

    // ── fixtures ────────────────────────────────────────────────────────

    /** Seed both zones. `awk` decides whether Awka is launched or still drafted. */
    async function seed(oni: { status: ServiceZoneStatus; enforcement: ZoneEnforcement },
                        awk: { status: ServiceZoneStatus; enforcement: ZoneEnforcement }) {
        const repo = ds.getRepository(ServiceZone);
        for (const spec of golden.zones as any[]) {
            const cfg = spec.code === 'ONI' ? oni : awk;
            const polygon: LatLng[] = spec.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
            const box = boundingBox(polygon);
            const existing = await repo.findOneBy({ code: spec.code });
            await repo.save(repo.create({
                ...(existing ? { zoneId: existing.zoneId } : {}),
                code: spec.code, name: spec.name, state: 'Anambra',
                boundary: toGeoJson(polygon) as unknown,
                bboxMinLat: box.minLat, bboxMinLng: box.minLng,
                bboxMaxLat: box.maxLat, bboxMaxLng: box.maxLng,
                bufferMeters: spec.bufferMeters, priority: spec.priority,
                status: cfg.status, enforcement: cfg.enforcement,
            } as any));
        }
        ServiceZoneService.bustCache();
    }

    /** Production today. */
    const seedToday = () => seed(
        { status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.OBSERVE },
        { status: ServiceZoneStatus.DRAFT, enforcement: ZoneEnforcement.OFF });

    /** Awka launch day: both cities live and enforcing. */
    const seedLaunched = () => seed(
        { status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.ENFORCE },
        { status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.ENFORCE });

    /**
     * A working driver: approved, solvent, free, ONLINE, with a live heartbeat
     * and a fresh position — every condition the mobility policy requires.
     */
    async function driver(at: { lat: number; lng: number }, homeZone: string) {
        const id = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id, email: `d${id}@test.local`, phone: '08031234567', password: 'x',
            firstName: 'Driver', lastName: homeZone, role: UserRole.DRIVER,
        } as any));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: id, firstName: 'Driver', lastName: homeZone,
            vehiclePlate: 'ABC-123', vehicleModel: 'Keke',
            status: DriverStatus.APPROVED, homeZoneCode: homeZone,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({
            userId: id, driverAvailableBalance: 0, driverCommissionDebt: 0,
        } as any));
        const intents = ds.getRepository(DriverPresenceIntent);
        await intents.save(intents.create({
            driverId: id, state: PresenceIntent.ONLINE, since: new Date(), actor: IntentActor.DRIVER,
        } as any));
        // Writes geo + availability + lastseen + lastpos in ONE pipeline — which
        // is why a live availability key proves the position is under 45s old.
        await DispatchService.updateDriverLocation(id, at.lat, at.lng);
        return id;
    }

    async function ride(pickup: { lat: number; lng: number }) {
        const r = await ServiceZoneResolver.resolve(pickup);
        const rideId = `RIDE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const passengerId = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id: passengerId, email: `p${passengerId}@test.local`, phone: '08039999999',
            password: 'x', firstName: 'Pass', lastName: 'Enger', role: UserRole.PASSENGER,
        } as any));
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId, status: RideStatus.SEARCHING, fare: 1100,
            paymentMode: 'cash', pickupLat: pickup.lat, pickupLng: pickup.lng,
            zoneCode: r.kind === 'inside' ? r.zoneCode : null,
            zoneMatchKind: r.kind === 'inside' ? r.match : 'none',
        } as any));
        return { rideId, passengerId, resolution: r };
    }

    /** The dispatch chain exactly as socket_handler assembles it. */
    async function dispatch(pickup: { lat: number; lng: number }, rideId: string,
                            zoneCode: string | null, matchKind: string | null) {
        const policy = await ServiceZonePolicy.forRide(zoneCode, matchKind);
        const { candidates } = await DriverCandidateService.findFor(
            pickup.lat, pickup.lng, 5, 10, {
                wantWakes: false, rideId,
                ...(policy.constrain && policy.zoneCode ? { zoneCode: policy.zoneCode } : {}),
            });
        const eligibility = await DriverEligibilityService.filter(
            candidates.map((c) => c.driverId),
            {
                isCash: true, rideId,
                zonePolicy: ServiceZonePolicy.active(policy) ? policy : undefined,
            });
        return { policy, discovered: candidates.map((c) => c.driverId), ...eligibility };
    }

    // ══════════════════════════════════════════════════════════════════
    //  1. Awka works
    // ══════════════════════════════════════════════════════════════════

    it('AWKA LAUNCH — an Awka ride finds only Awka drivers', async () => {
        await seedLaunched();
        const awkaDriver = await driver(AWKA, 'AWK');
        const awkaIfite = await driver(AWKA_IFITE, 'AWK');
        const onitshaDriver = await driver(ONITSHA_NEAR, 'ONI');

        const { rideId, resolution } = await ride(AWKA);
        expect(resolution.kind).toBe('inside');
        if (resolution.kind === 'inside') expect(resolution.zoneCode).toBe('AWK');

        const d = await dispatch(AWKA, rideId, 'AWK', 'exact');
        expect(d.policy.constrain).toBe(true);
        expect(d.eligible).toContain(awkaDriver);
        // 30 km away — the radius never reaches him, and the zone would refuse
        // him even if it did.
        expect(d.eligible).not.toContain(onitshaDriver);
        expect(awkaIfite).toBeTruthy();
    });

    it('AWKA — the ride carries its zone from creation, and the destination is recorded separately', async () => {
        await seedLaunched();
        const { rideId } = await ride(AWKA);
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBe('AWK');
        expect(row!.zoneMatchKind).toBe('exact');

        // Destination must never define the driver pool.
        const dest = await ServiceZoneResolver.resolve(ONITSHA);
        expect(dest.kind).toBe('inside');
        if (dest.kind === 'inside') expect(dest.zoneCode).toBe('ONI');
        const policy = await ServiceZonePolicy.forRide(row!.zoneCode, row!.zoneMatchKind);
        expect(policy.zoneCode).toBe('AWK');   // pickup owns dispatch, not destination
    });

    // ══════════════════════════════════════════════════════════════════
    //  2. Onitsha is unaffected
    // ══════════════════════════════════════════════════════════════════

    it('ONITSHA is untouched while Awka is live — proven simultaneously', async () => {
        await seedLaunched();
        const oniDriver = await driver(ONITSHA_NEAR, 'ONI');
        const awkDriver = await driver(AWKA, 'AWK');

        const oniRide = await ride(ONITSHA);
        const awkRide = await ride(AWKA);
        expect(oniRide.resolution.kind === 'inside' && oniRide.resolution.zoneCode).toBe('ONI');
        expect(awkRide.resolution.kind === 'inside' && awkRide.resolution.zoneCode).toBe('AWK');

        const oni = await dispatch(ONITSHA, oniRide.rideId, 'ONI', 'exact');
        const awk = await dispatch(AWKA, awkRide.rideId, 'AWK', 'exact');

        expect(oni.eligible).toEqual([oniDriver]);
        expect(awk.eligible).toEqual([awkDriver]);
        // The two pools are disjoint. That is the multi-city invariant.
        expect(oni.eligible.some((d) => awk.eligible.includes(d))).toBe(false);
    });

    // ══════════════════════════════════════════════════════════════════
    //  3. Kano reaches nobody
    // ══════════════════════════════════════════════════════════════════

    it('KANO — reaches no driver in either city', async () => {
        await seedLaunched();
        await driver(ONITSHA_NEAR, 'ONI');
        await driver(AWKA, 'AWK');

        const r = await ServiceZoneResolver.resolve(KANO);
        expect(r.kind).toBe('outside');

        const policy = await ServiceZonePolicy.forRide(null, 'none');
        expect(policy.constrain).toBe(true);
        expect(ServiceZonePolicy.refusalReason(policy))
            .toBe('pickup is outside every operational service area');

        // Even if such a ride existed, nobody is in a zone it does not belong to.
        const verdicts = await DriverZoneEligibility.verdicts(
            [await driver(ONITSHA_NEAR, 'ONI')], null);
        expect([...verdicts.values()].every((v) => !v.eligible)).toBe(true);
        expect([...verdicts.values()][0].reason).toBe('ride_has_no_zone');
    });

    // ══════════════════════════════════════════════════════════════════
    //  4. Driver mobility — the policy, both directions
    // ══════════════════════════════════════════════════════════════════

    it('MOBILITY — an Onitsha driver who genuinely drives to Awka becomes eligible in Awka', async () => {
        await seedLaunched();
        // Registered in Onitsha. Physically in Awka, online, fresh heartbeat.
        const traveller = await driver(AWKA, 'ONI');

        const profile = await ds.getRepository(DriverProfile).findOneBy({ userId: traveller });
        expect(profile!.homeZoneCode).toBe('ONI');          // paperwork says Onitsha

        const verdicts = await DriverZoneEligibility.verdicts([traveller], 'AWK');
        const v = verdicts.get(traveller)!;
        expect(v.eligible).toBe(true);                       // position says Awka
        expect(v.reason).toBe('in_zone');
        expect(v.driverZone).toBe('AWK');

        const { rideId } = await ride(AWKA);
        const d = await dispatch(AWKA, rideId, 'AWK', 'exact');
        expect(d.eligible).toContain(traveller);
        // Home zone is administrative metadata and never overrides a live fix.
    });

    it('MOBILITY — and that same driver is NOT eligible back in Onitsha while he is in Awka', async () => {
        await seedLaunched();
        const traveller = await driver(AWKA, 'ONI');
        const verdicts = await DriverZoneEligibility.verdicts([traveller], 'ONI');
        const v = verdicts.get(traveller)!;
        expect(v.eligible).toBe(false);
        expect(v.reason).toBe('in_other_zone');
        expect(v.driverZone).toBe('AWK');
    });

    it('MOBILITY — a STALE position never qualifies a driver in another city', async () => {
        /*
         * The rule that keeps mobility safe. The geo index has no TTL, so a
         * position can outlive the heartbeat that wrote it by days. Eligibility
         * therefore reads the live index only, and a driver with no live
         * heartbeat is excluded upstream before geography is consulted at all.
         */
        await seedLaunched();
        const stale = await driver(AWKA, 'ONI');
        // The heartbeat expires; the geo entry survives, as in production.
        await redis.del(`driver:available:${stale}`);

        const { rideId } = await ride(AWKA);
        const d = await dispatch(AWKA, rideId, 'AWK', 'exact');

        // Never discovered — the availability filter removed him before any
        // zone logic ran. Stale position, no dispatch.
        expect(d.discovered).not.toContain(stale);
        expect(d.eligible).not.toContain(stale);
    });

    it('MOBILITY — a stale last-known position stops excluding once it is too old to mean anything', async () => {
        await seedLaunched();
        const d1 = await driver(AWKA, 'ONI');

        // Fresh last-known position in Awka: excluded from an ONI wake round.
        let keep = await DriverZoneEligibility.wakeCandidatesForZone([d1], 'ONI');
        expect(keep.has(d1)).toBe(false);

        // The same position, an hour old. It no longer says where he is, so we
        // ring him rather than silently writing him off.
        const old = Date.now() - 61 * 60_000;
        await redis.set(`driver:lastpos:${d1}`, JSON.stringify({ lat: AWKA.lat, lng: AWKA.lng, at: old }));
        keep = await DriverZoneEligibility.wakeCandidatesForZone([d1], 'ONI');
        expect(keep.has(d1)).toBe(true);
    });

    it('MOBILITY — a driver with no position at all is never called "wrong city"', async () => {
        await seedLaunched();
        const ghost = uuid();
        const verdicts = await DriverZoneEligibility.verdicts([ghost], 'AWK');
        const v = verdicts.get(ghost)!;
        expect(v.reason).toBe('no_live_position');
        expect(v.eligible).toBe(true);      // excluded upstream, not by geography
    });

    // ══════════════════════════════════════════════════════════════════
    //  Awka stays dormant until deliberately launched
    // ══════════════════════════════════════════════════════════════════

    it('AWKA IS DORMANT TODAY — the same Awka pickup is not operational while AWK is draft', async () => {
        await seedToday();                                   // production, right now
        const r = await ServiceZoneResolver.resolve(AWKA);
        expect(r.kind).toBe('outside');                      // runtime cannot see a draft zone

        const policy = await ServiceZonePolicy.forRide('AWK', 'exact');
        expect(policy.coverage).toBe('out_of_coverage');
        expect(policy.constrain).toBe(false);                // observe applies nothing

        // And activation is the ONLY difference.
        await seedLaunched();
        const after = await ServiceZoneResolver.resolve(AWKA);
        expect(after.kind).toBe('inside');
        if (after.kind === 'inside') expect(after.zoneCode).toBe('AWK');
    });

    it('the candidate pool is not shrunk by the zone filter — it reaches further', async () => {
        /*
         * Discovery is radius-based and zone-agnostic; eligibility is not.
         * Without over-fetching, a tier whose nearest drivers are across a
         * border would offer the ride to whatever few remained instead of to
         * the nearest drivers who can actually take it.
         */
        await seedLaunched();
        const wanted: string[] = [];
        for (let i = 0; i < 6; i++) {
            wanted.push(await driver({ lat: AWKA.lat + i * 0.002, lng: AWKA.lng }, 'AWK'));
        }
        const { rideId } = await ride(AWKA);
        const d = await dispatch(AWKA, rideId, 'AWK', 'exact');
        // All six in-zone drivers survive to eligibility.
        for (const w of wanted) expect(d.eligible).toContain(w);
    });
});
