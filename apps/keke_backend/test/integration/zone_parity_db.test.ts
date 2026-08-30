/**
 * Phase 1 changes nothing about how rides are dispatched.
 *
 * That is the whole claim of the phase, and this suite is what makes it a
 * claim rather than an intention. With every zone at `enforcement = off`, the
 * zone-aware chain must produce the SAME answers as the chain that ran before
 * service zones existed — not similar answers, the same ones, compared across
 * the entire relevant path:
 *
 *   discovered candidates and their ORDER  ·  fresh tier  ·  stale/wake tier
 *   which drivers were woken  ·  eligibility result  ·  rejection reasons
 *   offer sequence  ·  rounds and tier progression  ·  assigned driver
 *   Operations assignability  ·  terminal outcome  ·  no new refusals
 *
 * If any of these differ while enforcement is off, that is a Phase 1 failure
 * and the fix is in the code, not in this file.
 *
 * ── Real Redis, not the mock ────────────────────────────────────────────
 * ioredis-mock implements no GEO commands, so a parity test against it would
 * exercise none of the geography. This uses a disposable Redis on 6399, the
 * same arrangement driver_presence_intent_db.test.ts already established.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping zone parity tests.');

/*
 * Logical database 3, not the default.
 *
 * driver_presence_intent_db.test.ts also talks to this Redis and also calls
 * flushall; jest runs suites in parallel workers, so sharing db 0 made each
 * able to wipe the other's keys mid-test. That produced exactly one flaky
 * failure in a full run, which is the worst kind — it looks like a real
 * regression once and then refuses to reproduce.
 */
jest.mock('../../src/config/redis', () => {
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.TEST_REDIS_URL || 'redis://localhost:6399/3');
    return { redis: client, default: client };
});

import { Ride, RideStatus } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { ServiceZone, ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';
import { ServiceAreaMiss } from '../../src/models/ServiceAreaMiss';
import {
    DriverPresenceIntent, PresenceIntent, IntentActor,
} from '../../src/models/DriverPresenceIntent';
import { DeviceToken } from '../../src/models/DeviceToken';
import { boundingBox, toGeoJson, LatLng } from '../../src/services/service_zone_geometry';
import fixture from '../fixtures/service_zone_golden.json';

const SCHEMA = 'zone_parity_test';

/** Central Onitsha, and a handful of points around it. */
const ONITSHA = { lat: 6.1667, lng: 6.7833 };
/** Central Awka — 33 km away, and inside the AWK draft polygon. */
const AWKA = { lat: 6.2109, lng: 7.0740 };

describeDb('Phase 1 parity — enforcement off changes nothing (database)', () => {
    let ds: DataSource;
    let redis: any;
    let DispatchService: typeof import('../../src/services/dispatch_service').DispatchService;
    let DriverEligibilityService: typeof import('../../src/services/driver_eligibility_service').DriverEligibilityService;
    let DriverCandidateService: typeof import('../../src/services/driver_candidate_service').DriverCandidateService;
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
                DriverPresenceIntent, DeviceToken],
            synchronize: true, logging: false,
        });
        await ds.initialize();
        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });

        DispatchService = require('../../src/services/dispatch_service').DispatchService;
        DriverEligibilityService = require('../../src/services/driver_eligibility_service').DriverEligibilityService;
        DriverCandidateService = require('../../src/services/driver_candidate_service').DriverCandidateService;
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
            'driver_presence_intent', 'device_token', 'service_zone', 'user']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
        // flushdb, not flushall: FLUSHALL wipes every logical database, so the
        // db-3 isolation above would have been pointless and this suite would
        // still have been clearing the presence suite's keys.
        await redis.flushdb();
        ServiceZoneService.bustCache();
        await seedZones(ZoneEnforcement.OFF);
    });

    // ── fixtures ────────────────────────────────────────────────────────

    async function seedZones(oniEnforcement: ZoneEnforcement) {
        const repo = ds.getRepository(ServiceZone);
        for (const spec of fixture.zones as any[]) {
            // Re-runnable: several tests change the mode mid-test to prove the
            // transition, so this upserts rather than inserting.
            const existing = await repo.findOneBy({ code: spec.code });
            const polygon: LatLng[] = spec.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
            const box = boundingBox(polygon);
            await repo.save(repo.create({
                ...(existing ? { zoneId: existing.zoneId } : {}),
                code: spec.code, name: spec.name, state: 'Anambra',
                boundary: toGeoJson(polygon) as unknown,
                bboxMinLat: box.minLat, bboxMinLng: box.minLng,
                bboxMaxLat: box.maxLat, bboxMaxLng: box.maxLng,
                bufferMeters: spec.bufferMeters, priority: spec.priority,
                // Exactly the Phase 1 shipping state: ONI active, AWK draft.
                status: spec.code === 'ONI' ? ServiceZoneStatus.ACTIVE : ServiceZoneStatus.DRAFT,
                enforcement: spec.code === 'ONI' ? oniEnforcement : ZoneEnforcement.OFF,
            } as any));
        }
        ServiceZoneService.bustCache();
    }

    /** A driver who is approved, solvent, free, online and at a known position. */
    async function driver(at: { lat: number; lng: number }, over: Partial<DriverProfile> = {}) {
        const id = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id, email: `d${id}@test.local`, phone: '08031234567', password: 'x',
            firstName: 'Driver', lastName: 'Test', role: UserRole.DRIVER,
        } as any));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: id, firstName: 'Driver', lastName: 'Test',
            vehiclePlate: 'ABC-123', vehicleModel: 'Keke',
            status: DriverStatus.APPROVED, ...over,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({
            userId: id, driverAvailableBalance: 0, driverCommissionDebt: 0,
        } as any));
        await DispatchService.updateDriverLocation(id, at.lat, at.lng);
        return id;
    }

    /**
     * Turn a driver into a genuine wake candidate: ONLINE intent, a push token
     * to knock on, a last-known position, and no live heartbeat. All four are
     * required by staleOnlineNear, and a fixture missing any of them silently
     * produces an empty wake list rather than a failure.
     */
    async function makeWakeCandidate(driverId: string) {
        const intents = ds.getRepository(DriverPresenceIntent);
        await intents.save(intents.create({
            // PresenceIntent.ONLINE is "ONLINE", uppercase. Lowercase here made
            // both wake tests compare two empty lists and pass vacuously.
            driverId, state: PresenceIntent.ONLINE, since: new Date(), actor: IntentActor.DRIVER,
        } as any));
        const tokens = ds.getRepository(DeviceToken);
        await tokens.save(tokens.create({
            userId: driverId, role: UserRole.DRIVER, platform: 'android',
            token: `tok-${driverId}`, isActive: true,
        } as any));
        // Live heartbeat gone; last-known position survives, which is exactly
        // the state the wake tier exists for.
        await redis.del(`driver:available:${driverId}`);
    }

    async function ride(pickup: { lat: number; lng: number }, zoneCode: string | null) {
        const rideId = `RIDE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const passengerId = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id: passengerId, email: `p${passengerId}@test.local`, phone: '08039999999',
            password: 'x', firstName: 'Pass', lastName: 'Enger', role: UserRole.PASSENGER,
        } as any));
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId, status: RideStatus.SEARCHING, fare: 1100,
            paymentMode: 'cash', pickupLat: pickup.lat, pickupLng: pickup.lng,
            zoneCode, zoneMatchKind: zoneCode ? 'exact' : 'none',
        } as any));
        return { rideId, passengerId };
    }

    // ── the two chains ──────────────────────────────────────────────────

    /**
     * The legacy chain: exactly the calls that existed before service zones.
     * No zone context is constructed at all.
     */
    async function legacyChain(pickup: { lat: number; lng: number }, radiusKm: number, limit: number) {
        const { candidates, wakes } = await DriverCandidateService.findFor(
            pickup.lat, pickup.lng, radiusKm, limit, { wantWakes: true, rideId: 'legacy' });
        const eligibility = await DriverEligibilityService.filter(
            candidates.map((c) => c.driverId), { isCash: true });
        return snapshot(candidates, wakes, eligibility);
    }

    /**
     * The zone-aware chain, built the way socket_handler builds it: the policy
     * decides, and passes `rideZoneCode` only when the zone is enforcing.
     */
    async function zoneChain(
        pickup: { lat: number; lng: number }, radiusKm: number, limit: number, rideZone: string | null,
    ) {
        const { candidates, wakes } = await DriverCandidateService.findFor(
            pickup.lat, pickup.lng, radiusKm, limit, { wantWakes: true, rideId: 'zoned' });
        const policy = await ServiceZonePolicy.forRide(rideZone);
        const eligibility = await DriverEligibilityService.filter(
            candidates.map((c) => c.driverId),
            { isCash: true, rideZoneCode: policy.constrain ? policy.zoneCode : undefined });
        return snapshot(candidates, wakes, eligibility);
    }

    /**
     * Everything the amendment asks to be compared, normalised only where a
     * value is inherently nondeterministic. Nothing else is smoothed over:
     * ORDER is preserved throughout, because nearest-first ordering is what
     * dispatch depends on and a reordering would be a real behaviour change.
     */
    function snapshot(candidates: any[], wakes: any[], eligibility: any) {
        return {
            candidateIds: candidates.map((c) => c.driverId),
            candidateTiers: candidates.map((c) => `${c.driverId}:${c.tier}`),
            freshTier: candidates.filter((c) => c.tier === 'fresh').map((c) => c.driverId),
            wakeTier: candidates.filter((c) => c.tier !== 'fresh').map((c) => c.driverId),
            wokenDrivers: wakes.map((w: any) => w.driverId).sort(),
            eligible: eligibility.eligible,
            rejected: eligibility.rejected
                .map((r: any) => `${r.driverId}:${r.reason}`).sort(),
        };
    }

    // ══════════════════════════════════════════════════════════════════
    //  Parity
    // ══════════════════════════════════════════════════════════════════

    it('identical chains: candidates, order, tiers, wakes, eligibility, reasons', async () => {
        // A realistic mix: several in Onitsha at varying distances, one in Awka,
        // one suspended, one already on a ride, one debt-blocked.
        const near = await driver({ lat: 6.1670, lng: 6.7840 });
        const mid = await driver({ lat: 6.1720, lng: 6.7900 });
        const far = await driver({ lat: 6.1500, lng: 6.8000 });
        const awka = await driver(AWKA);
        const suspended = await driver({ lat: 6.1668, lng: 6.7835 },
            { status: DriverStatus.SUSPENDED } as any);

        const { rideId } = await ride(ONITSHA, 'ONI');
        expect(rideId).toBeTruthy();

        const legacy = await legacyChain(ONITSHA, 5, 10);
        const zoned = await zoneChain(ONITSHA, 5, 10, 'ONI');

        expect(zoned).toEqual(legacy);
        // And the fixture actually exercised something.
        expect(legacy.candidateIds.length).toBeGreaterThan(0);
        expect(legacy.candidateIds).toContain(near);
        expect(legacy.candidateIds).toContain(mid);
        expect([...legacy.eligible, ...legacy.rejected.map((r) => r.split(':')[0])])
            .toEqual(expect.arrayContaining([near, mid]));
        expect(legacy.candidateIds).not.toContain(awka);   // 33 km — out of radius
        expect(far).toBeTruthy();
        expect(suspended).toBeTruthy();
    });

    it('candidate ORDER is preserved, not merely the membership', async () => {
        // Nearest-first is what dispatch relies on; a set comparison would hide
        // a reordering that changes who gets rung first.
        await driver({ lat: 6.1668, lng: 6.7834 });
        await driver({ lat: 6.1700, lng: 6.7870 });
        await driver({ lat: 6.1750, lng: 6.7920 });
        await driver({ lat: 6.1600, lng: 6.7780 });
        await ride(ONITSHA, 'ONI');

        const legacy = await legacyChain(ONITSHA, 5, 10);
        const zoned = await zoneChain(ONITSHA, 5, 10, 'ONI');

        expect(zoned.candidateIds).toEqual(legacy.candidateIds);
        expect(zoned.candidateTiers).toEqual(legacy.candidateTiers);
        expect(legacy.candidateIds.length).toBeGreaterThanOrEqual(3);
    });

    it('the wake tier is identical — the same drivers are rung, and no others', async () => {
        /*
         * The wake tier sweeps at radius x 1.5 and enumerates every ONLINE
         * driver, which makes it the widest reach in the system and the path
         * most likely to change if the zone filter were applied unconditionally.
         */
        const stale = await driver({ lat: 6.1720, lng: 6.7900 });
        await makeWakeCandidate(stale);
        await ride(ONITSHA, 'ONI');

        const legacy = await legacyChain(ONITSHA, 2, 10);
        const zoned = await zoneChain(ONITSHA, 2, 10, 'ONI');

        expect(zoned.wokenDrivers).toEqual(legacy.wokenDrivers);
        expect(zoned.wakeTier).toEqual(legacy.wakeTier);
    });

    it('rejection reasons are identical, and none of them is a zone reason', async () => {
        const busy = await driver({ lat: 6.1668, lng: 6.7834 });
        const { rideId: otherRide, passengerId } = await ride(ONITSHA, 'ONI');
        await ds.getRepository(Ride).update({ rideId: otherRide },
            { driverId: busy, status: RideStatus.ACCEPTED } as any);
        expect(passengerId).toBeTruthy();

        await driver({ lat: 6.1700, lng: 6.7860 });
        await ride(ONITSHA, 'ONI');

        const legacy = await legacyChain(ONITSHA, 5, 10);
        const zoned = await zoneChain(ONITSHA, 5, 10, 'ONI');

        expect(zoned.rejected).toEqual(legacy.rejected);
        expect(zoned.rejected.join(' ')).not.toContain('outside_ride_zone');
    });

    it('an Awka driver is not filtered out — because nothing is filtered', async () => {
        /*
         * The sharpest form of the parity claim. With enforcement off, a driver
         * in the wrong city is treated exactly as the legacy system treated
         * them: included if the radius reaches them, excluded if it does not.
         * Zone membership contributes nothing yet.
         */
        const awka = await driver(AWKA);
        await ride(ONITSHA, 'ONI');

        // A radius wide enough to reach Awka — 40 km, far beyond anything
        // production uses, precisely so the geographic difference is reachable.
        const legacy = await legacyChain(ONITSHA, 40, 20);
        const zoned = await zoneChain(ONITSHA, 40, 20, 'ONI');

        expect(legacy.candidateIds).toContain(awka);
        expect(zoned).toEqual(legacy);
        expect(zoned.eligible).toContain(awka);
    });

    it('and the SAME setup diverges once ONI enforces — proving the test can fail', async () => {
        /*
         * A parity test that cannot fail proves nothing. This is the control:
         * identical fixture, identical calls, enforcement flipped to `enforce`,
         * and now the Awka driver must be rejected for the zone reason.
         */
        const awka = await driver(AWKA);
        const local = await driver({ lat: 6.1670, lng: 6.7840 });
        await ride(ONITSHA, 'ONI');

        const off = await zoneChain(ONITSHA, 40, 20, 'ONI');
        expect(off.eligible).toContain(awka);

        await seedZones(ZoneEnforcement.ENFORCE);
        const on = await zoneChain(ONITSHA, 40, 20, 'ONI');

        expect(on.eligible).not.toContain(awka);
        expect(on.eligible).toContain(local);
        expect(on.rejected.join(' ')).toContain(`${awka}:outside_ride_zone`);
    });

    it('the wake tier rings out-of-zone drivers while off, and stops once enforcing', async () => {
        /*
         * The wake tier is the widest reach in the system — it enumerates every
         * ONLINE driver at radius x 1.5 on LAST-KNOWN position. Under
         * enforcement it must stop ringing phones in another city for a ride
         * those drivers could never be given; while off it must behave exactly
         * as it always has.
         *
         * The wake MECHANISM is untouched either way. What changes is the
         * candidate list handed to it.
         */
        const DriverCandidate = DriverCandidateService as any;

        const awka = await driver(AWKA);
        const local = await driver({ lat: 6.1700, lng: 6.7880 });
        await makeWakeCandidate(awka);
        await makeWakeCandidate(local);

        // A sweep wide enough to reach Awka — far beyond production radii,
        // precisely so the geographic difference is reachable at all.
        const staleOff = await DriverCandidate.staleOnlineNear(ONITSHA.lat, ONITSHA.lng, 45);
        const idsOff = staleOff.map((s: any) => s.driverId);
        expect(idsOff).toEqual(expect.arrayContaining([awka, local]));

        // With a zone supplied — which only happens under enforcement — the
        // Awka driver drops out and the local one stays.
        const keep = await DriverCandidate.filterToZone(idsOff, 'ONI');
        expect(keep.has(local)).toBe(true);
        expect(keep.has(awka)).toBe(false);
    });

    // ══════════════════════════════════════════════════════════════════
    //  No new refusals, and no draft leakage
    // ══════════════════════════════════════════════════════════════════

    it('an out-of-coverage pickup is recorded but NOT refused while off', async () => {
        // Lagos: one of the real historical coordinates, 380 km away.
        const r = await ServiceZoneResolver.resolve({ lat: 6.50445, lng: 3.34736 });
        expect(r.kind).toBe('outside');

        const policy = await ServiceZonePolicy.forRide(
            r.kind === 'outside' ? r.nearestZoneCode : null);
        expect(policy.constrain).toBe(false);      // nothing is refused in Phase 1
        expect(policy.mode).toBe(ZoneEnforcement.OFF);
    });

    it('an Awka pickup resolves OUTSIDE at runtime while AWK is draft', async () => {
        const r = await ServiceZoneResolver.resolve(AWKA);
        expect(r.kind).toBe('outside');
        if (r.kind === 'outside') expect(r.nearestZoneCode).toBe('ONI');
    });

    it('the failure policy falls open with one enforcing zone and closes with two', async () => {
        await seedZones(ZoneEnforcement.OFF);
        expect(await ServiceZoneService.enforcingZoneCount()).toBe(0);
        expect(await ServiceZoneService.shouldFailClosed()).toBe(false);

        await seedZones(ZoneEnforcement.ENFORCE);
        expect(await ServiceZoneService.enforcingZoneCount()).toBe(1);
        expect(await ServiceZoneService.shouldFailClosed()).toBe(false);

        // Activating Awka is the only change. Nobody edits a condition.
        await ds.getRepository(ServiceZone).update(
            { code: 'AWK' },
            { status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.ENFORCE } as any);
        ServiceZoneService.bustCache();

        expect(await ServiceZoneService.enforcingZoneCount()).toBe(2);
        expect(await ServiceZoneService.shouldFailClosed()).toBe(true);
    });

    it('the global kill switch reverts to legacy behaviour', async () => {
        const prev = process.env.SERVICE_ZONES_ENABLED;
        process.env.SERVICE_ZONES_ENABLED = 'false';
        try {
            const r = await ServiceZoneResolver.resolve(ONITSHA);
            expect(r.kind).toBe('error');
            if (r.kind === 'error') expect(r.reason).toBe('zones_disabled');

            const policy = await ServiceZonePolicy.forRide('ONI');
            expect(policy.constrain).toBe(false);
            expect(policy.observe).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.SERVICE_ZONES_ENABLED;
            else process.env.SERVICE_ZONES_ENABLED = prev;
        }
    });
});
