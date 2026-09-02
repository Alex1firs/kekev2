/**
 * Awka pre-launch certification.
 *
 * Everything a second city has to survive, exercised against the real
 * architecture rather than against mocks of it: real Postgres, real Redis with
 * real GEO commands, the real eligibility chain, the real money path.
 *
 * The suite runs AWK as it will be on launch day — `active` — while production
 * keeps it `draft`. Nothing here activates anything; the difference between
 * this passing and a live second city is one configuration change made by a
 * person.
 *
 * Structured as the certification asks: Onitsha unharmed, Awka whole, the two
 * isolated, mobility correct in both directions, out-of-coverage inert, and the
 * whole thing reversible.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping Awka certification.');

jest.mock('../../src/config/redis', () => {
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.TEST_REDIS_URL || 'redis://localhost:6399/7');
    return { redis: client, default: client };
});

import { Ride, RideStatus } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { LedgerEntry } from '../../src/models/LedgerEntry';
import { Transaction } from '../../src/models/Transaction';
import { PayoutRecord } from '../../src/models/PayoutRecord';
import { Setting } from '../../src/models/Setting';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { ServiceZone, ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';
import { ServiceAreaMiss } from '../../src/models/ServiceAreaMiss';
import { DriverPresenceIntent, PresenceIntent, IntentActor } from '../../src/models/DriverPresenceIntent';
import { DeviceToken } from '../../src/models/DeviceToken';
import { DispatchEvent } from '../../src/models/DispatchEvent';
import { RideDispatchControl } from '../../src/models/RideDispatchControl';
import { OperationsIntervention } from '../../src/models/OperationsIntervention';
import { boundingBox, toGeoJson, LatLng } from '../../src/services/service_zone_geometry';
import golden from '../fixtures/service_zone_golden.json';
import scenarios from '../fixtures/geographic_scenarios.json';

const SCHEMA = 'awka_cert_test';

const ONITSHA = { lat: 6.1667, lng: 6.7833 };
const ONITSHA_NEAR = { lat: 6.1670, lng: 6.7840 };
const AWKA = { lat: 6.2109, lng: 7.0740 };
const AWKA_AROMA = { lat: 6.2130, lng: 7.0700 };
const KANO = { lat: 12.0363172, lng: 8.4730917 };
const LAGOS = { lat: 6.4419225, lng: 3.5525527 };
/** Midway down the corridor: outside both polygons and both buffers. */
const BETWEEN = { lat: 6.19256, lng: 6.95336 };

describeDb('AWKA PRE-LAUNCH CERTIFICATION', () => {
    let ds: DataSource;
    let redis: any;
    let DispatchService: any;
    let DriverEligibilityService: any;
    let DriverCandidateService: any;
    let DriverZoneEligibility: any;
    let ServiceZoneService: any;
    let ServiceZonePolicy: any;
    let ServiceZoneResolver: any;
    let WalletService: any;
    let ServiceAreaMissService: any;
    let OperationsDispatchService: any;
    let RideControlService: any;
    let ManualAssignmentZoneGuard: any;
    let OperationsQueueService: any;
    let OperationsDriverDiscovery: any;

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
            entities: [Ride, User, Wallet, LedgerEntry, Transaction, PayoutRecord, Setting,
                DriverProfile, ServiceZone, ServiceAreaMiss, DriverPresenceIntent, DeviceToken,
                DispatchEvent, RideDispatchControl, OperationsIntervention],
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
        WalletService = require('../../src/services/wallet_service').WalletService;
        ServiceAreaMissService = require('../../src/services/service_area_miss_service').ServiceAreaMissService;
        OperationsDispatchService =
            require('../../src/services/operations_dispatch_service').OperationsDispatchService;
        RideControlService = require('../../src/services/ride_control_service').RideControlService;
        ManualAssignmentZoneGuard =
            require('../../src/services/manual_assignment_zone_guard').ManualAssignmentZoneGuard;
        OperationsQueueService =
            require('../../src/services/operations_queue_service').OperationsQueueService;
        OperationsDriverDiscovery =
            require('../../src/services/operations_driver_discovery').OperationsDriverDiscovery;
        // The same conditional searching→accepted UPDATE the real arbiter runs.
        OperationsDispatchService.setHost({
            assignDriver: async (a: any) => {
                const r = await ds.getRepository(Ride).createQueryBuilder().update()
                    .set({ driverId: a.driverId, status: 'accepted' as any, acceptedAt: new Date() })
                    .where('"rideId" = :r AND status = :s', { r: a.rideId, s: 'searching' })
                    .execute();
                return r.affected === 1
                    ? { ok: true as const, driverId: a.driverId }
                    : { ok: false as const, code: 'RIDE_STATE_CHANGED', message: 'refused' };
            },
            releaseDriver: async () => ({ ok: true as const, driverId: null, priorStatus: null, priorEvidence: {} }),
        } as any);
        redis = require('../../src/config/redis').redis;
    });

    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy();
        try { await redis?.quit(); } catch { /* already closed */ }
    });

    beforeEach(async () => {
        for (const t of ['ride', 'driver_profile', 'wallet', 'ledger_entry', 'transaction',
            'payout_record', 'setting', 'service_area_miss', 'driver_presence_intent',
            'device_token', 'dispatch_event', 'ride_dispatch_control',
            'operations_intervention', 'service_zone', 'user']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
        await redis.flushdb();
        ServiceZoneService.bustCache();
    });

    // ── fixtures ────────────────────────────────────────────────────────

    async function seed(oniEnf: ZoneEnforcement, awkStatus: ServiceZoneStatus, awkEnf: ZoneEnforcement) {
        const repo = ds.getRepository(ServiceZone);
        for (const spec of golden.zones as any[]) {
            const isOni = spec.code === 'ONI';
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
                status: isOni ? ServiceZoneStatus.ACTIVE : awkStatus,
                enforcement: isOni ? oniEnf : awkEnf,
            } as any));
        }
        ServiceZoneService.bustCache();
    }

    /** Production today: ONI observing, AWK drafted. */
    const today = () => seed(ZoneEnforcement.OBSERVE, ServiceZoneStatus.DRAFT, ZoneEnforcement.OFF);
    /** Awka open, nothing enforcing yet — the recommended launch posture. */
    const awkaOpen = () => seed(ZoneEnforcement.OBSERVE, ServiceZoneStatus.ACTIVE, ZoneEnforcement.OBSERVE);
    /** Both cities enforcing — the eventual end state. */
    const enforcing = () => seed(ZoneEnforcement.ENFORCE, ServiceZoneStatus.ACTIVE, ZoneEnforcement.ENFORCE);

    async function driver(at: { lat: number; lng: number } | null, homeZone: string,
                          opts: { online?: boolean; heartbeat?: boolean; pushToken?: boolean } = {}) {
        const id = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id, email: `d${id}@t.local`, phone: '08031234567', password: 'x',
            firstName: 'Driver', lastName: homeZone, role: UserRole.DRIVER,
        } as any));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: id, firstName: 'Driver', lastName: homeZone, vehiclePlate: 'ABC-123',
            vehicleModel: 'Keke', status: DriverStatus.APPROVED, homeZoneCode: homeZone,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({
            userId: id, driverAvailableBalance: 0, driverCommissionDebt: 0,
        } as any));
        if (opts.online !== false) {
            const i = ds.getRepository(DriverPresenceIntent);
            await i.save(i.create({
                driverId: id, state: PresenceIntent.ONLINE, since: new Date(), actor: IntentActor.DRIVER,
            } as any));
        }
        if (opts.pushToken) {
            const t = ds.getRepository(DeviceToken);
            await t.save(t.create({
                userId: id, role: UserRole.DRIVER, platform: 'android',
                token: `tok-${id}`, isActive: true,
            } as any));
        }
        if (at) {
            await DispatchService.updateDriverLocation(id, at.lat, at.lng);
            // Simulate a heartbeat that has expired while the GEO entry survives —
            // exactly what production does, since the geo index has no TTL.
            if (opts.heartbeat === false) await redis.del(`driver:available:${id}`);
        }
        return id;
    }

    async function ride(pickup: { lat: number; lng: number }, dest = ONITSHA, isCash = true) {
        const r = await ServiceZoneResolver.resolve(pickup);
        const d = await ServiceZoneResolver.resolve(dest);
        const rideId = `RIDE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const passengerId = uuid();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id: passengerId, email: `p${passengerId}@t.local`, phone: '08039999999',
            password: 'x', firstName: 'Pass', lastName: 'Enger', role: UserRole.PASSENGER,
        } as any));
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId, status: RideStatus.SEARCHING, fare: 1100,
            paymentMode: isCash ? 'cash' : 'wallet',
            pickupLat: pickup.lat, pickupLng: pickup.lng,
            destinationLat: dest.lat, destinationLng: dest.lng,
            zoneCode: r.kind === 'inside' ? r.zoneCode : null,
            zoneMatchKind: r.kind === 'inside' ? r.match : 'none',
            destinationZoneCode: d.kind === 'inside' ? d.zoneCode : null,
        } as any));
        return { rideId, passengerId, resolution: r };
    }

    /** The dispatch chain exactly as socket_handler assembles it. */
    async function dispatch(pickup: { lat: number; lng: number }, rideId: string,
                            zoneCode: string | null, matchKind: string | null, radiusKm = 5) {
        const policy = await ServiceZonePolicy.forRide(zoneCode, matchKind);
        const { candidates, wakes } = await DriverCandidateService.findFor(
            pickup.lat, pickup.lng, radiusKm, 10, {
                wantWakes: true, rideId,
                ...(policy.constrain && policy.zoneCode ? { zoneCode: policy.zoneCode } : {}),
            });
        const el = await DriverEligibilityService.filter(candidates.map((c: any) => c.driverId), {
            isCash: true, rideId,
            zonePolicy: ServiceZonePolicy.active(policy) ? policy : undefined,
        });
        return { policy, discovered: candidates.map((c: any) => c.driverId), wakes, ...el };
    }

    // ══════════════════════════════════════════════════════════════════
    //  3 · AWKA FULL LIFECYCLE — creation through money
    // ══════════════════════════════════════════════════════════════════

    it('AWKA LIFECYCLE — pickup to completed ride with correct commission', async () => {
        await awkaOpen();
        const drv = await driver(AWKA_AROMA, 'AWK');
        const { rideId, resolution } = await ride(AWKA, AWKA_AROMA);

        // 1. classification
        expect(resolution.kind).toBe('inside');
        if (resolution.kind === 'inside') expect(resolution.zoneCode).toBe('AWK');
        let row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBe('AWK');
        expect(row!.destinationZoneCode).toBe('AWK');

        // 2. discovery + eligibility
        const d = await dispatch(AWKA, rideId, 'AWK', 'exact');
        expect(d.eligible).toContain(drv);

        // 3. assignment — the same conditional UPDATE the real arbiter performs
        const claimed = await ds.getRepository(Ride).createQueryBuilder().update()
            .set({ driverId: drv, status: 'accepted' as any, acceptedAt: new Date() })
            .where('"rideId" = :rideId AND status = :s', { rideId, s: 'searching' })
            .execute();
        expect(claimed.affected).toBe(1);

        // 4. arrived → started → completed
        for (const st of [RideStatus.ARRIVED, RideStatus.IN_PROGRESS, RideStatus.COMPLETED]) {
            await ds.getRepository(Ride).update({ rideId }, { status: st } as any);
        }
        await ds.getRepository(Ride).update({ rideId },
            { completedAt: new Date(), finalFare: 1100 } as any);

        // 5. money — the real posting path
        await WalletService.postRideFinancials({
            rideId, passengerId: row!.passengerId, driverId: drv,
            totalFare: 1100, isCash: true,
        });

        // 10% is a MARKUP on net: net = 1100/1.1 = 1000, commission = 100.
        const wallet = await ds.getRepository(Wallet).findOneBy({ userId: drv });
        expect(Number(wallet!.driverCommissionDebt)).toBeCloseTo(100, 2);

        const entries = await ds.getRepository(LedgerEntry)
            .createQueryBuilder('le').where(`le.metadata->>'rideId' = :r`, { r: rideId }).getMany();
        expect(entries.length).toBeGreaterThan(0);

        // 6. final persisted state carries the zone for the life of the ride
        row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.status).toBe(RideStatus.COMPLETED);
        expect(row!.zoneCode).toBe('AWK');
        expect(row!.driverId).toBe(drv);
    });

    it('AWKA — a cross-zone trip is one ride, owned by its PICKUP', async () => {
        await awkaOpen();
        const { rideId } = await ride(AWKA, ONITSHA);        // Awka → Onitsha
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBe('AWK');                    // dispatch owner
        expect(row!.destinationZoneCode).toBe('ONI');         // reporting only
        const policy = await ServiceZonePolicy.forRide(row!.zoneCode, row!.zoneMatchKind);
        expect(policy.zoneCode).toBe('AWK');
    });

    // ══════════════════════════════════════════════════════════════════
    //  4 · CITY ISOLATION — scenarios A–E
    // ══════════════════════════════════════════════════════════════════

    it('SCENARIO A+B — both cities dispatch simultaneously with disjoint pools', async () => {
        await enforcing();
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
        const awkDrv = await driver(AWKA_AROMA, 'AWK');

        const a = await ride(ONITSHA);
        const b = await ride(AWKA);
        const ra = await dispatch(ONITSHA, a.rideId, 'ONI', 'exact');
        const rb = await dispatch(AWKA, b.rideId, 'AWK', 'exact');

        expect(ra.eligible).toEqual([oniDrv]);
        expect(rb.eligible).toEqual([awkDrv]);
        expect(ra.eligible.some((x: string) => rb.eligible.includes(x))).toBe(false);
        // No contamination in either direction, and no wake crossed over.
        expect(ra.wakes.map((w: any) => w.driverId)).not.toContain(awkDrv);
        expect(rb.wakes.map((w: any) => w.driverId)).not.toContain(oniDrv);
    });

    it.each([
        ['SCENARIO C — Kano', KANO],
        ['SCENARIO D — Lagos', LAGOS],
        ['SCENARIO E — between the cities', BETWEEN],
    ])('%s is OUT_OF_COVERAGE and reaches no driver in either city', async (_l, pickup: any) => {
        await enforcing();
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
        const awkDrv = await driver(AWKA_AROMA, 'AWK');

        const r = await ServiceZoneResolver.resolve(pickup);
        expect(r.kind).toBe('outside');

        const policy = await ServiceZonePolicy.forRide(null, 'none');
        expect(policy.coverage).toBe('out_of_coverage');
        expect(policy.constrain).toBe(true);

        // Nobody is in a zone the ride does not belong to.
        const v = await DriverZoneEligibility.verdicts([oniDrv, awkDrv], null);
        expect([...v.values()].every((x: any) => !x.eligible)).toBe(true);
        expect([...v.values()].every((x: any) => x.reason === 'ride_has_no_zone')).toBe(true);
    });

    it('SCENARIO E — the corridor is NOT assigned to whichever city is nearer', async () => {
        await enforcing();
        const r = await ServiceZoneResolver.resolve(BETWEEN);
        expect(r.kind).toBe('outside');
        if (r.kind === 'outside') {
            // It names a nearest zone for the demand record — but never joins it.
            expect(['ONI', 'AWK']).toContain(r.nearestZoneCode);
            expect(r.distanceM).toBeGreaterThan(400);
        }
    });

    it('demand evidence is preserved for every out-of-coverage attempt', async () => {
        await enforcing();
        const passengerId = uuid();
        for (const p of [KANO, LAGOS, BETWEEN]) {
            const res = await ServiceZoneResolver.resolve(p);
            await ServiceAreaMissService.record({
                passengerId, lat: p.lat, lng: p.lng, resolution: res,
                enforcementAtTime: 'enforce', refused: true,
            });
        }
        const misses = await ds.getRepository(ServiceAreaMiss).find();
        expect(misses).toHaveLength(3);
        expect(misses.every((m) => m.resolution === 'outside')).toBe(true);
        expect(misses.every((m) => m.refused)).toBe(true);
        // Refused, and still measurable. Enforcement must not cost us the signal.
        expect(misses.every((m) => Number(m.distanceMeters) > 400)).toBe(true);
    });

    // ══════════════════════════════════════════════════════════════════
    //  5 · DRIVER MOBILITY — end to end, both directions
    // ══════════════════════════════════════════════════════════════════

    it('MOBILITY — ONI-home driver in ONI with a fresh fix is ONI-eligible', async () => {
        await enforcing();
        const d = await driver(ONITSHA_NEAR, 'ONI');
        const v = (await DriverZoneEligibility.verdicts([d], 'ONI')).get(d)!;
        expect(v.eligible).toBe(true);
        expect(v.reason).toBe('in_zone');
    });

    it('MOBILITY — ONI-home driver who travels to AWK becomes AWK-eligible immediately on his first fresh fix', async () => {
        await enforcing();
        const d = await driver(AWKA_AROMA, 'ONI');       // paperwork ONI, body AWK
        const awk = (await DriverZoneEligibility.verdicts([d], 'AWK')).get(d)!;
        const oni = (await DriverZoneEligibility.verdicts([d], 'ONI')).get(d)!;
        expect(awk.eligible).toBe(true);
        expect(awk.reason).toBe('in_zone');
        expect(oni.eligible).toBe(false);
        expect(oni.reason).toBe('in_other_zone');
        // "When" is precise: the moment the heartbeat that carries the new fix
        // lands. There is no settling period and no home-zone override.
    });

    it('MOBILITY — AWK-home driver who travels to ONI behaves reciprocally', async () => {
        await enforcing();
        const d = await driver(ONITSHA_NEAR, 'AWK');
        expect((await DriverZoneEligibility.verdicts([d], 'ONI')).get(d)!.eligible).toBe(true);
        expect((await DriverZoneEligibility.verdicts([d], 'AWK')).get(d)!.eligible).toBe(false);
    });

    it('MOBILITY — a STALE coordinate showing AWK never makes an ONI driver AWK-eligible', async () => {
        await enforcing();
        const d = await driver(AWKA_AROMA, 'ONI', { heartbeat: false });
        const { rideId } = await ride(AWKA);
        const r = await dispatch(AWKA, rideId, 'AWK', 'exact');
        // Never discovered: the availability filter removes him before geography.
        expect(r.discovered).not.toContain(d);
        expect(r.eligible).not.toContain(d);
    });

    it('MOBILITY — an OFFLINE driver is never dispatch-eligible', async () => {
        await enforcing();
        const d = await driver(AWKA_AROMA, 'AWK', { online: false, heartbeat: false });
        const { rideId } = await ride(AWKA);
        const r = await dispatch(AWKA, rideId, 'AWK', 'exact');
        expect(r.discovered).not.toContain(d);
        expect(r.wakes.map((w: any) => w.driverId)).not.toContain(d);
    });

    it('MOBILITY — a GEO coordinate with a dead heartbeat is never treated as live', async () => {
        await enforcing();
        const d = await driver(AWKA_AROMA, 'AWK', { heartbeat: false });
        expect(await DriverZoneEligibility.hasLiveHeartbeat(d)).toBe(false);
        const geo = await redis.geopos('drivers:locations', d);
        expect(geo[0]).toBeTruthy();                    // the coordinate is still there
        const { rideId } = await ride(AWKA);
        expect((await dispatch(AWKA, rideId, 'AWK', 'exact')).discovered).not.toContain(d);
    });

    it('MOBILITY — an ORPHAN GEO entry with no driver profile is never eligible', async () => {
        await enforcing();
        const ghost = uuid();
        await DispatchService.updateDriverLocation(ghost, AWKA_AROMA.lat, AWKA_AROMA.lng);
        const { rideId } = await ride(AWKA);
        const r = await dispatch(AWKA, rideId, 'AWK', 'exact');
        expect(r.eligible).not.toContain(ghost);
        expect(r.rejected.map((x: any) => x.driverId)).toContain(ghost);
        expect(r.rejected.find((x: any) => x.driverId === ghost).reason).toBe('no_driver_profile');
    });

    // ══════════════════════════════════════════════════════════════════
    //  6 · BOUNDARY TORTURE
    // ══════════════════════════════════════════════════════════════════

    it('BOUNDARY — GPS jitter across an edge never produces cross-city dispatch', async () => {
        await enforcing();
        // A driver wobbling either side of the ONI boundary. Whatever the fix
        // says, he can only ever be ONI or nowhere — never AWK, 16 km away.
        const seen = new Set<string | null>();
        for (let i = 0; i < 60; i++) {
            const jitterM = (i % 2 === 0 ? 1 : -1) * (50 + (i * 13) % 700);
            const lat = 6.1790 + jitterM / 110574;
            const r = await ServiceZoneResolver.resolve({ lat, lng: 6.8810 });
            seen.add(r.kind === 'inside' ? r.zoneCode : null);
        }
        expect(seen.has('AWK')).toBe(false);
        expect([...seen].every((z) => z === 'ONI' || z === null)).toBe(true);
    });

    it('BOUNDARY — repeated alternating coordinates are deterministic', async () => {
        await enforcing();
        const a = { lat: 6.1667, lng: 6.7833 };
        const b = { lat: 12.0363172, lng: 8.4730917 };
        const results: string[] = [];
        for (let i = 0; i < 40; i++) {
            const r = await ServiceZoneResolver.resolve(i % 2 ? b : a);
            results.push(JSON.stringify(r));
        }
        // Every even index identical, every odd index identical. No drift, no
        // cache poisoning, no dependence on call order.
        expect(new Set(results.filter((_, i) => i % 2 === 0)).size).toBe(1);
        expect(new Set(results.filter((_, i) => i % 2 === 1)).size).toBe(1);
    });

    it.each([
        ['null island', 0, 0],
        ['NaN', NaN, 6.78],
        ['Infinity', 6.16, Infinity],
        ['impossible latitude', 91.5, 6.78],
        ['impossible longitude', 6.16, 181],
    ])('BOUNDARY — %s is an ERROR, and never dispatches', async (_l, lat, lng) => {
        await enforcing();
        const r = await ServiceZoneResolver.resolve({ lat: lat as number, lng: lng as number });
        expect(r.kind).toBe('error');
        // An error is UNRESOLVED, which is inert — it must not refuse a ride,
        // and it must not silently place one in a city either.
        const policy = await ServiceZonePolicy.forRide(null, null);
        expect(policy.coverage).toBe('unresolved');
        expect(policy.constrain).toBe(false);
    });

    it('BOUNDARY — 1 m inside, on the edge and 1 m outside all behave predictably', async () => {
        await enforcing();
        const onEdge = { lat: 6.1790, lng: 6.8810 };                 // an ONI vertex
        const inside = { lat: 6.1790 - 1 / 110574, lng: 6.8810 };
        const outside = { lat: 6.1790 + 1 / 110574, lng: 6.8810 };
        for (const p of [onEdge, inside, outside]) {
            const r = await ServiceZoneResolver.resolve(p);
            // Within a metre of the line, all three are ONI — the buffer and the
            // on-boundary tolerance make this stable rather than a coin flip.
            expect(r.kind).toBe('inside');
            if (r.kind === 'inside') expect(r.zoneCode).toBe('ONI');
        }
    });

    it('BOUNDARY — the fixture buffer probes hold for both cities', async () => {
        await enforcing();
        const V = (scenarios as any).vectors as any[];
        const BUFFER = ['ONI_BUFFER', 'AWK_BUFFER'];
        const OUTSIDE = ['ONI_JUST_OUTSIDE_BUFFER', 'AWK_JUST_OUTSIDE_BUFFER'];
        for (const v of V.filter((x) => BUFFER.includes(x.scenario))) {
            const r = await ServiceZoneResolver.resolve({ lat: v.lat, lng: v.lng });
            expect(r.kind).toBe('inside');
            if (r.kind === 'inside') expect(r.match).toBe('buffer');
        }
        for (const v of V.filter((x) => OUTSIDE.includes(x.scenario))) {
            const r = await ServiceZoneResolver.resolve({ lat: v.lat, lng: v.lng });
            expect(r.kind).toBe('outside');
        }
    });

    // ══════════════════════════════════════════════════════════════════
    //  7 · KANO — refused, but never banned
    // ══════════════════════════════════════════════════════════════════

    it('KANO — the request class can no longer reach ONI/AWK dispatch under enforcement', async () => {
        await enforcing();
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
        const awkDrv = await driver(AWKA_AROMA, 'AWK');
        const r = await ServiceZoneResolver.resolve(KANO);
        expect(r.kind).toBe('outside');
        const v = await DriverZoneEligibility.verdicts([oniDrv, awkDrv], null);
        expect([...v.values()].some((x: any) => x.eligible)).toBe(false);
    });

    it('KANO — the passenger account is NOT banned, and rides normally from Onitsha', async () => {
        /*
         * The distinction that matters most in the product. We restrict where a
         * ride may be dispatched FROM, not who may use KekeRide. The same
         * passenger who was refused in Kano must be served the moment they are
         * standing in a city we operate in.
         */
        await enforcing();
        const drv = await driver(ONITSHA_NEAR, 'ONI');
        const kano = await ride(KANO);
        const kanoRow = await ds.getRepository(Ride).findOneBy({ rideId: kano.rideId });
        expect(kanoRow!.zoneCode).toBeNull();

        // Same passenger, now in Onitsha.
        const rideId = `RIDE-${Date.now()}-onitsha`;
        const res = await ServiceZoneResolver.resolve(ONITSHA);
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId: kano.passengerId, status: RideStatus.SEARCHING, fare: 1100,
            paymentMode: 'cash', pickupLat: ONITSHA.lat, pickupLng: ONITSHA.lng,
            zoneCode: res.kind === 'inside' ? res.zoneCode : null,
            zoneMatchKind: res.kind === 'inside' ? res.match : 'none',
        } as any));

        const d = await dispatch(ONITSHA, rideId, 'ONI', 'exact');
        expect(d.eligible).toContain(drv);          // served, no account-level penalty
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(row!.zoneCode).toBe('ONI');
    });

    // ══════════════════════════════════════════════════════════════════
    //  10 · AWK ACTIVATION AND ROLLBACK — independent of ONI
    // ══════════════════════════════════════════════════════════════════

    it('ACTIVATION — turning AWK on is a configuration change and nothing else', async () => {
        await today();                                    // AWK draft
        const before = await ServiceZoneResolver.resolve(AWKA);
        expect(before.kind).toBe('outside');

        await ServiceZoneService.setMode('AWK', { status: ServiceZoneStatus.ACTIVE });
        const after = await ServiceZoneResolver.resolve(AWKA);
        expect(after.kind).toBe('inside');
        if (after.kind === 'inside') expect(after.zoneCode).toBe('AWK');
    });

    it('ROLLBACK — AWK can be taken dark again WITHOUT disturbing ONI', async () => {
        await awkaOpen();
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
        const oniRide = await ride(ONITSHA);
        const oniBefore = await dispatch(ONITSHA, oniRide.rideId, 'ONI', 'exact');
        expect(oniBefore.eligible).toContain(oniDrv);

        // Take Awka dark.
        await ServiceZoneService.setMode('AWK', {
            status: ServiceZoneStatus.DRAFT, enforcement: ZoneEnforcement.OFF,
        });

        expect((await ServiceZoneResolver.resolve(AWKA)).kind).toBe('outside');
        // Onitsha is byte-identical either side of the rollback.
        const oniAfter = await dispatch(ONITSHA, oniRide.rideId, 'ONI', 'exact');
        expect(oniAfter.eligible).toEqual(oniBefore.eligible);
        expect(oniAfter.rejected).toEqual(oniBefore.rejected);
        const oni = (await ServiceZoneService.list()).find((z: any) => z.code === 'ONI');
        expect(oni.status).toBe(ServiceZoneStatus.ACTIVE);
    });

    it('ACTIVATION SAFETY — a draft zone can never be set to enforce', async () => {
        await today();
        await expect(ServiceZoneService.setMode('AWK', { enforcement: ZoneEnforcement.ENFORCE }))
            .rejects.toThrow(/cannot enforce/);
        const awk = (await ServiceZoneService.list()).find((z: any) => z.code === 'AWK');
        expect(awk.enforcement).toBe(ZoneEnforcement.OFF);
    });

    // ══════════════════════════════════════════════════════════════════
    //  9 · OPERATIONS — can an operator answer the two questions?
    // ══════════════════════════════════════════════════════════════════

    it('OPERATIONS — the payload answers "why did this ride go to this driver?"', async () => {
        await enforcing();
        const drv = await driver(AWKA_AROMA, 'ONI');       // travelled from Onitsha
        const { rideId } = await ride(AWKA);
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        const profile = await ds.getRepository(DriverProfile).findOneBy({ userId: drv });
        const v = (await DriverZoneEligibility.verdicts([drv], row!.zoneCode)).get(drv)!;

        // Ride zone, driver current zone, driver home zone, and the verdict —
        // everything needed to explain the decision without reading source.
        expect(row!.zoneCode).toBe('AWK');
        expect(v.driverZone).toBe('AWK');
        expect(profile!.homeZoneCode).toBe('ONI');
        expect(v.reason).toBe('in_zone');
    });

    it('OPERATIONS — the payload answers "why was this request not dispatched?"', async () => {
        await enforcing();
        const drv = await driver(ONITSHA_NEAR, 'ONI');
        const { rideId } = await ride(KANO);
        const row = await ds.getRepository(Ride).findOneBy({ rideId });
        const policy = await ServiceZonePolicy.forRide(row!.zoneCode, row!.zoneMatchKind);
        const v = (await DriverZoneEligibility.verdicts([drv], row!.zoneCode)).get(drv)!;

        expect(row!.zoneCode).toBeNull();
        expect(row!.zoneMatchKind).toBe('none');
        expect(policy.coverage).toBe('out_of_coverage');
        expect(ServiceZonePolicy.refusalReason(policy))
            .toBe('pickup is outside every operational service area');
        expect(v.reason).toBe('ride_has_no_zone');
        expect(rideId).toBeTruthy();
    });

    // ══════════════════════════════════════════════════════════════════
    //  2 · ONITSHA HAS NOT REGRESSED
    // ══════════════════════════════════════════════════════════════════

    it('ONI REGRESSION — Onitsha dispatch is byte-identical whether AWK is drafted, active or enforcing', async () => {
        /*
         * The question the live city actually cares about. Onitsha carries real
         * revenue today; a second city that changes any of its behaviour is not
         * an expansion, it is a regression with a launch date.
         */
        const snapshots: any[] = [];
        for (const posture of [today, awkaOpen, enforcing]) {
            await posture();
            const drv = await driver(ONITSHA_NEAR, 'ONI');
            const { rideId } = await ride(ONITSHA);
            const row = await ds.getRepository(Ride).findOneBy({ rideId });
            const d = await dispatch(ONITSHA, rideId, row!.zoneCode, row!.zoneMatchKind);
            snapshots.push({
                zoneCode: row!.zoneCode,
                matchKind: row!.zoneMatchKind,
                coverage: d.policy.coverage,
                eligibleCount: d.eligible.length,
                eligibleIsTheDriver: d.eligible[0] === drv,
                rejected: d.rejected.map((r: any) => r.reason),
                wakeCount: d.wakes.length,
            });
            // Each posture gets a clean slate; only the zone configuration differs.
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."ride", ${SCHEMA}."driver_profile", `
                + `${SCHEMA}."wallet", ${SCHEMA}."driver_presence_intent", ${SCHEMA}."user" CASCADE`);
            await redis.flushdb();
        }
        expect(snapshots[0].zoneCode).toBe('ONI');
        expect(snapshots[0].eligibleIsTheDriver).toBe(true);
        expect(snapshots[1]).toEqual(snapshots[0]);
        expect(snapshots[2]).toEqual(snapshots[0]);
    });

    it('ONI REGRESSION — an ONI ride never sees an AWK driver, in any posture', async () => {
        for (const posture of [today, awkaOpen, enforcing]) {
            await posture();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const { rideId } = await ride(ONITSHA);
            const d = await dispatch(ONITSHA, rideId, 'ONI', 'exact');
            expect(d.eligible).toEqual([oniDrv]);
            expect(d.discovered).not.toContain(awkDrv);
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."ride", ${SCHEMA}."driver_profile", `
                + `${SCHEMA}."wallet", ${SCHEMA}."driver_presence_intent", ${SCHEMA}."user" CASCADE`);
            await redis.flushdb();
        }
    });

    it('ONI REGRESSION — the ONI money path is unchanged by the presence of a second city', async () => {
        await enforcing();
        const drv = await driver(ONITSHA_NEAR, 'ONI');
        const { rideId, passengerId } = await ride(ONITSHA);
        await WalletService.postRideFinancials({
            rideId, passengerId, driverId: drv, totalFare: 1100, isCash: true,
        });
        const wallet = await ds.getRepository(Wallet).findOneBy({ userId: drv });
        // Identical to the Awka rehearsal: commission is a property of the
        // pricing config, not of geography.
        expect(Number(wallet!.driverCommissionDebt)).toBeCloseTo(100, 2);
    });

    // ══════════════════════════════════════════════════════════════════
    //  8 · WAKE AND BACKGROUND DELIVERY
    // ══════════════════════════════════════════════════════════════════

    it('WAKE — a backgrounded AWK driver is rung, answers, and is then dispatched on his FRESH fix', async () => {
        await enforcing();
        // ONLINE, push token registered, last-known position in Awka, phone
        // quiet — the exact state a driver's handset sits in between trips.
        const drv = await driver(AWKA_AROMA, 'AWK', { heartbeat: false, pushToken: true });
        const { rideId } = await ride(AWKA);

        const wakeMod = require('../../src/services/driver_wake_service');
        const spy = jest.spyOn(wakeMod.DriverWakeService, 'wakeMany')
            .mockImplementation(async (ids: any) => {
                // The handset answers: the app comes up and writes a real fix,
                // which is the ONLY thing that makes it dispatchable.
                for (const id of ids) await DispatchService.updateDriverLocation(id, AWKA_AROMA.lat, AWKA_AROMA.lng);
                return ids.map((id: string) => ({ driverId: id, answered: true }));
            });
        try {
            const d = await dispatch(AWKA, rideId, 'AWK', 'exact');
            expect(spy).toHaveBeenCalled();
            expect(spy.mock.calls[0][0]).toContain(drv);   // he was actually rung
            expect(d.wakes.find((w: any) => w.driverId === drv)?.answered).toBe(true);
            expect(d.discovered).toContain(drv);           // re-queried on the new fix
            expect(d.eligible).toContain(drv);             // and offered the ride
        } finally { spy.mockRestore(); }
    });

    it('WAKE — an ONI driver is NEVER rung for an Awka ride', async () => {
        await enforcing();
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI', { heartbeat: false, pushToken: true });
        const awkDrv = await driver(AWKA_AROMA, 'AWK', { heartbeat: false, pushToken: true });
        const { rideId } = await ride(AWKA);

        const wakeMod = require('../../src/services/driver_wake_service');
        const spy = jest.spyOn(wakeMod.DriverWakeService, 'wakeMany')
            .mockResolvedValue([] as any);
        try {
            await dispatch(AWKA, rideId, 'AWK', 'exact', 60);   // wide enough to reach Onitsha
            const rung: string[] = spy.mock.calls.flatMap((c: any) => c[0]);
            expect(rung).not.toContain(oniDrv);
            expect(rung).toContain(awkDrv);
        } finally { spy.mockRestore(); }
    });

    it('WAKE — answering the ring does NOT by itself make a driver eligible', async () => {
        await enforcing();
        // He answers from Onitsha, for an Awka ride. Waking is an invitation to
        // report a position, never a promise of work.
        const drv = await driver(ONITSHA_NEAR, 'ONI', { heartbeat: false, pushToken: true });
        const { rideId } = await ride(AWKA);
        const wakeMod = require('../../src/services/driver_wake_service');
        const spy = jest.spyOn(wakeMod.DriverWakeService, 'wakeMany')
            .mockImplementation(async (ids: any) => {
                for (const id of ids) await DispatchService.updateDriverLocation(id, ONITSHA_NEAR.lat, ONITSHA_NEAR.lng);
                return ids.map((id: string) => ({ driverId: id, answered: true }));
            });
        try {
            const d = await dispatch(AWKA, rideId, 'AWK', 'exact', 60);
            expect(d.eligible).not.toContain(drv);
        } finally { spy.mockRestore(); }
    });

    // ══════════════════════════════════════════════════════════════════
    //  4b · OPERATIONS MANUAL ASSIGNMENT — the original cross-city hole
    // ══════════════════════════════════════════════════════════════════

    describe('OPERATIONS ASSIGNMENT — the path that had no geography at all', () => {
        const ADA = { staffUserId: 'STAFF_ADA', label: 'Ada O.' };

        /** A dispatcher holding control of a searching ride, ready to assign. */
        async function controlled(pickup: { lat: number; lng: number }) {
            const { rideId } = await ride(pickup);
            const t = await RideControlService.takeover(rideId, ADA);
            expect(t.ok).toBe(true);
            return rideId;
        }

        it('REFUSES an Awka driver for an Onitsha ride', async () => {
            await enforcing();
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const rideId = await controlled(ONITSHA);
            const r = await OperationsDispatchService.assign(rideId, awkDrv, ADA);
            expect(r.ok).toBe(false);
            expect(r.code).toBe('DRIVER_OUTSIDE_RIDE_ZONE');
            expect(r.rideZone).toBe('ONI');
            expect(r.driverZone).toBe('AWK');
        });

        it('REFUSES any driver for an out-of-coverage ride — the Kano case', async () => {
            /*
             * This is the exact hole. Operations enumerates the whole approved
             * driver population with no distance filter, and before the null
             * zone was given a meaning, a ride with `zoneCode = NULL` reached
             * this guard and passed it without the check ever running.
             */
            await enforcing();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const rideId = await controlled(KANO);
            const r = await OperationsDispatchService.assign(rideId, oniDrv, ADA);
            expect(r.ok).toBe(false);
            expect(r.code).toBe('DRIVER_OUTSIDE_RIDE_ZONE');
            expect(r.coverage).toBe('out_of_coverage');
        });

        it('ALLOWS the right driver for an Awka ride, through the same arbiter', async () => {
            await enforcing();
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const rideId = await controlled(AWKA);
            const r = await OperationsDispatchService.assign(rideId, awkDrv, ADA);
            expect(r.ok).toBe(true);
            const row = await ds.getRepository(Ride).findOneBy({ rideId });
            expect(row!.driverId).toBe(awkDrv);
            expect(row!.status).toBe('accepted');
        });

        it('ALLOWS an ONI-home driver standing in Awka — mobility applies here too', async () => {
            await enforcing();
            const travelled = await driver(AWKA_AROMA, 'ONI');
            const rideId = await controlled(AWKA);
            const r = await OperationsDispatchService.assign(rideId, travelled, ADA);
            expect(r.ok).toBe(true);
        });

        it('OBSERVE reports the cross-city assignment but does NOT refuse it', async () => {
            // The two modes must measure the same thing, or the miss data
            // collected under observe says nothing about what enforce will do.
            await seed(ZoneEnforcement.OBSERVE, ServiceZoneStatus.ACTIVE, ZoneEnforcement.OBSERVE);
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const rideId = await controlled(ONITSHA);
            const r = await OperationsDispatchService.assign(rideId, awkDrv, ADA);
            expect(r.ok).toBe(true);
        });

        it('a refused assignment is recorded as evidence', async () => {
            await enforcing();
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const rideId = await controlled(ONITSHA);
            await OperationsDispatchService.assign(rideId, awkDrv, ADA);
            const rows = await ds.getRepository(OperationsIntervention).findBy({ rideId });
            const refusal = rows.find((x: any) => x.outcomeCode === 'DRIVER_OUTSIDE_RIDE_ZONE');
            expect(refusal).toBeTruthy();
            expect(refusal!.staffUserId).toBe(ADA.staffUserId);
            expect(refusal!.driverId).toBe(awkDrv);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    //  H1 · THE SHARED MANUAL-ASSIGNMENT GUARD
    // ══════════════════════════════════════════════════════════════════

    describe('MANUAL GUARD — one rule, both human assignment paths', () => {
        /*
         * Operations and park dispatch are the two ways a person puts a driver
         * on a ride. Until this module they enforced "the same" rule in one
         * place and no rule in the other. These tests are about the rule
         * itself; the two call sites are proven to consult it separately.
         */
        async function verdictFor(
            pickup: { lat: number; lng: number },
            driverAt: { lat: number; lng: number },
        ) {
            const drv = await driver(driverAt, 'ONI');
            const { rideId } = await ride(pickup);
            const row = await ds.getRepository(Ride).findOneBy({ rideId });
            return {
                drv,
                verdict: await ManualAssignmentZoneGuard.evaluate(
                    { rideId, zoneCode: row!.zoneCode, zoneMatchKind: row!.zoneMatchKind }, drv),
            };
        }

        it('OFF — inert. Nothing is evaluated and nothing is reported.', async () => {
            await seed(ZoneEnforcement.OFF, ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF);
            const { verdict } = await verdictFor(ONITSHA, AWKA_AROMA);
            expect(verdict.refuse).toBe(false);
            expect(verdict.violated).toBe(false);
        });

        it('OBSERVE — the violation is REPORTED but never refused', async () => {
            await awkaOpen();
            const { verdict } = await verdictFor(ONITSHA, AWKA_AROMA);
            expect(verdict.violated).toBe(true);      // the operator can be told
            expect(verdict.refuse).toBe(false);       // and the platform allows it
            expect(verdict.rideZone).toBe('ONI');
            expect(verdict.driverZone).toBe('AWK');
            expect(verdict.message).toContain('ONI');
        });

        it('ENFORCE — the same violation is refused', async () => {
            await enforcing();
            const { verdict } = await verdictFor(ONITSHA, AWKA_AROMA);
            expect(verdict.violated).toBe(true);
            expect(verdict.refuse).toBe(true);
        });

        it('OBSERVE and ENFORCE evaluate the IDENTICAL predicate', async () => {
            // If they diverged, the miss data gathered under observation would
            // say nothing about what enforcement is going to do.
            await awkaOpen();
            const observed = await verdictFor(ONITSHA, AWKA_AROMA);
            await enforcing();
            const enforced = await ManualAssignmentZoneGuard.evaluate(
                { rideId: 'X', zoneCode: 'ONI', zoneMatchKind: 'exact' }, observed.drv);
            expect(enforced.violated).toBe(observed.verdict.violated);
            expect(enforced.driverZone).toBe(observed.verdict.driverZone);
            expect(enforced.refuse).toBe(true);
            expect(observed.verdict.refuse).toBe(false);   // the ONLY difference
        });

        it('a same-zone assignment is never a violation, in any mode', async () => {
            for (const posture of [today, awkaOpen, enforcing]) {
                await posture();
                const { verdict } = await verdictFor(ONITSHA, ONITSHA_NEAR);
                expect(verdict.violated).toBe(false);
                expect(verdict.refuse).toBe(false);
                await ds.query(`TRUNCATE TABLE ${SCHEMA}."ride", ${SCHEMA}."driver_profile", `
                    + `${SCHEMA}."wallet", ${SCHEMA}."driver_presence_intent", ${SCHEMA}."user" CASCADE`);
                await redis.flushdb();
            }
        });

        it('a driver we cannot locate is treated as NOT in the ride zone', async () => {
            // Never place a driver we cannot find into a city we cannot confirm
            // they are in. A missing fix is not permission.
            await enforcing();
            const drv = await driver(ONITSHA_NEAR, 'ONI', { heartbeat: false });
            await redis.zrem('drivers:locations', drv);
            const { rideId } = await ride(ONITSHA);
            const v = await ManualAssignmentZoneGuard.evaluate(
                { rideId, zoneCode: 'ONI', zoneMatchKind: 'exact' }, drv);
            expect(v.driverZone).toBeNull();
            expect(v.refuse).toBe(true);
        });

        it('an UNRESOLVED ride never refuses anybody — a fault must not stop work', async () => {
            await enforcing();
            const drv = await driver(ONITSHA_NEAR, 'ONI');
            const v = await ManualAssignmentZoneGuard.evaluate(
                { rideId: 'LEGACY', zoneCode: null, zoneMatchKind: null }, drv);
            expect(v.refuse).toBe(false);
            expect(v.violated).toBe(false);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    //  H2 · THE PREVIOUS FAILURE CASE, BOTH DIRECTIONS
    // ══════════════════════════════════════════════════════════════════

    describe('OPERATIONS ASSIGNMENT — the reciprocal cases end to end', () => {
        const ADA = { staffUserId: 'STAFF_ADA', label: 'Ada O.' };

        async function controlled(pickup: { lat: number; lng: number }) {
            const { rideId } = await ride(pickup);
            const t = await RideControlService.takeover(rideId, ADA);
            expect(t.ok).toBe(true);
            return rideId;
        }

        it('AWKA ride + ONITSHA driver — REFUSED under enforce', async () => {
            await enforcing();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const rideId = await controlled(AWKA);
            const r = await OperationsDispatchService.assign(rideId, oniDrv, ADA);
            expect(r.ok).toBe(false);
            expect(r.code).toBe('DRIVER_OUTSIDE_RIDE_ZONE');
            expect(r.rideZone).toBe('AWK');
            expect(r.driverZone).toBe('ONI');
        });

        it('AWKA ride + ONITSHA driver — ALLOWED under observe, and visible to the operator', async () => {
            await awkaOpen();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const rideId = await controlled(AWKA);

            // What the console shows the operator before they press Assign.
            const discovery = await OperationsDriverDiscovery.forRide(rideId, {});
            expect(discovery.rideZone.name).toBe('Awka');
            expect(discovery.rideZone.enforced).toBe(false);      // observe: not blocked
            const row = discovery.drivers.find((d: any) => d.driverId === oniDrv);
            expect(row.zoneLabel).toBe('Onitsha');
            expect(row.inRideZone).toBe(false);

            // And the platform genuinely allows it — observation is not enforcement.
            const r = await OperationsDispatchService.assign(rideId, oniDrv, ADA);
            expect(r.ok).toBe(true);
        });

        it('ONITSHA ride + AWKA driver — REFUSED under enforce, ALLOWED under observe', async () => {
            await enforcing();
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            const refused = await OperationsDispatchService.assign(
                await controlled(ONITSHA), awkDrv, ADA);
            expect(refused.ok).toBe(false);
            expect(refused.code).toBe('DRIVER_OUTSIDE_RIDE_ZONE');

            await awkaOpen();
            const allowed = await OperationsDispatchService.assign(
                await controlled(ONITSHA), awkDrv, ADA);
            expect(allowed.ok).toBe(true);
        });

        it('SAME-ZONE assignment succeeds in both cities', async () => {
            await enforcing();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const awkDrv = await driver(AWKA_AROMA, 'AWK');
            expect((await OperationsDispatchService.assign(
                await controlled(ONITSHA), oniDrv, ADA)).ok).toBe(true);
            expect((await OperationsDispatchService.assign(
                await controlled(AWKA), awkDrv, ADA)).ok).toBe(true);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    //  H3 · WHAT THE OPERATOR ACTUALLY SEES
    // ══════════════════════════════════════════════════════════════════

    describe('OPERATIONS VISIBILITY — the payload the console renders', () => {
        it('the queue names the city in words, not in a three-letter code', async () => {
            await awkaOpen();
            await ride(ONITSHA);
            await ride(AWKA);
            const q = await OperationsQueueService.liveQueue({ limit: 50 });
            const byZone = new Map(q.rows.map((r: any) => [r.zoneCode, r]));
            expect((byZone.get('ONI') as any).zoneName).toBe('Onitsha');
            expect((byZone.get('AWK') as any).zoneName).toBe('Awka');
            expect((byZone.get('ONI') as any).zoneCoverage).toBe('in_zone');
        });

        it('an out-of-coverage pickup is distinguishable from an unclassified one', async () => {
            /*
             * The distinction that has to survive: "this pickup is outside every
             * service area" and "this ride predates zones" both have a null
             * zoneCode, and rendering both as an empty cell is how the Kano
             * ride looked ordinary on screen.
             */
            await awkaOpen();
            const kano = await ride(KANO);
            const legacyId = `RIDE-${Date.now()}-legacy`;
            await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
                rideId: legacyId, passengerId: uuid(), status: RideStatus.SEARCHING,
                fare: 900, paymentMode: 'cash', pickupLat: ONITSHA.lat, pickupLng: ONITSHA.lng,
                zoneCode: null, zoneMatchKind: null,          // never classified
            } as any));

            const q = await OperationsQueueService.liveQueue({ limit: 50 });
            const k = q.rows.find((r: any) => r.rideId === kano.rideId);
            const l = q.rows.find((r: any) => r.rideId === legacyId);
            expect(k.zoneCoverage).toBe('out_of_coverage');
            expect(l.zoneCoverage).toBe('unresolved');
            expect(k.zoneCoverage).not.toBe(l.zoneCoverage);
        });

        it('a ride classified into a DRAFT city is out of coverage, not "Awka"', async () => {
            // Production today. The ride really is in Awka geographically, and
            // Awka really is not open — the screen must say the second thing,
            // because that is the one that governs whether anyone can be sent.
            await today();
            const r = await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
                rideId: `RIDE-${Date.now()}-draftcity`, passengerId: uuid(),
                status: RideStatus.SEARCHING, fare: 900, paymentMode: 'cash',
                pickupLat: AWKA.lat, pickupLng: AWKA.lng,
                zoneCode: 'AWK', zoneMatchKind: 'exact',
            } as any));
            const q = await OperationsQueueService.liveQueue({ limit: 50 });
            const row = q.rows.find((x: any) => x.rideId === r.rideId);
            expect(row.zoneCoverage).toBe('out_of_coverage');
            expect(row.zoneName).toBeNull();
        });

        it('the driver picker distinguishes in-zone, outside, and NO LIVE FIX', async () => {
            await enforcing();
            const inZone = await driver(AWKA_AROMA, 'AWK');
            const elsewhere = await driver(ONITSHA_NEAR, 'ONI');
            const between = await driver(BETWEEN, 'AWK');
            const noFix = await driver(AWKA_AROMA, 'AWK', { heartbeat: false });
            const { rideId } = await ride(AWKA);

            const d = await OperationsDriverDiscovery.forRide(rideId, { limit: 100 });
            const row = (id: string) => d.drivers.find((x: any) => x.driverId === id);

            expect(row(inZone).zoneState).toBe('in_zone');
            expect(row(inZone).zoneLabel).toBe('Awka');
            expect(row(elsewhere).zoneState).toBe('in_zone');
            expect(row(elsewhere).zoneLabel).toBe('Onitsha');
            expect(row(between).zoneState).toBe('outside');
            expect(row(between).zoneLabel).toBe('Outside service areas');

            // The one that matters most: a driver whose last-known position is
            // in Awka but who has no live fix must NOT be labelled "Awka".
            expect(row(noFix).zoneState).toBe('stale');
            expect(row(noFix).zoneLabel).toBe('Location stale');
            expect(row(noFix).zoneCode).toBeNull();
        });

        it('the picker header states which city the operator is choosing FOR', async () => {
            await enforcing();
            await driver(AWKA_AROMA, 'AWK');
            const awk = await ride(AWKA);
            const kano = await ride(KANO);

            const a = await OperationsDriverDiscovery.forRide(awk.rideId, {});
            expect(a.rideZone.label).toBe('Awka');
            expect(a.rideZone.enforced).toBe(true);

            const k = await OperationsDriverDiscovery.forRide(kano.rideId, {});
            expect(k.rideZone.label).toBe('Outside every service area');
            expect(k.rideZone.enforced).toBe(true);
            // Nobody is in the right zone for a ride that has none.
            expect(k.drivers.every((x: any) => x.inRideZone === false)).toBe(true);
        });

        it('under OBSERVE the picker reports the mismatch but does not claim it is blocked', async () => {
            await awkaOpen();
            const oniDrv = await driver(ONITSHA_NEAR, 'ONI');
            const { rideId } = await ride(AWKA);
            const d = await OperationsDriverDiscovery.forRide(rideId, {});
            expect(d.rideZone.enforced).toBe(false);
            expect(d.drivers.find((x: any) => x.driverId === oniDrv).inRideZone).toBe(false);
        });
    });

    // ══════════════════════════════════════════════════════════════════
    //  13 · THE NEXT CITY
    // ══════════════════════════════════════════════════════════════════

    it('FUTURE CITY — adding Nnewi is configuration, not a dispatch project', async () => {
        await enforcing();
        // A third zone, created exactly the way the migration created the first
        // two: a polygon and a row. No code path is added or altered.
        const NNEWI: LatLng[] = [
            [6.0500, 6.8900], [6.0500, 6.9500], [6.0000, 6.9600],
            [5.9700, 6.9200], [5.9900, 6.8800],
        ];
        const box = boundingBox(NNEWI);
        const repo = ds.getRepository(ServiceZone);
        await repo.save(repo.create({
            code: 'NNE', name: 'Nnewi', state: 'Anambra',
            boundary: toGeoJson(NNEWI) as unknown,
            bboxMinLat: box.minLat, bboxMinLng: box.minLng,
            bboxMaxLat: box.maxLat, bboxMaxLng: box.maxLng,
            bufferMeters: 400, priority: 100,
            status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.ENFORCE,
        } as any));
        ServiceZoneService.bustCache();

        const nnewiDrv = await driver({ lat: 6.0167, lng: 6.9167 }, 'NNE');
        const oniDrv = await driver(ONITSHA_NEAR, 'ONI');

        const r = await ServiceZoneResolver.resolve({ lat: 6.0167, lng: 6.9167 });
        expect(r.kind).toBe('inside');
        if (r.kind === 'inside') expect(r.zoneCode).toBe('NNE');

        // Three-way isolation, with no change to dispatch.
        expect((await DriverZoneEligibility.verdicts([nnewiDrv], 'NNE')).get(nnewiDrv)!.eligible).toBe(true);
        expect((await DriverZoneEligibility.verdicts([nnewiDrv], 'ONI')).get(nnewiDrv)!.eligible).toBe(false);
        expect((await DriverZoneEligibility.verdicts([oniDrv], 'NNE')).get(oniDrv)!.eligible).toBe(false);

        // And Onitsha is unaffected by the new neighbour.
        expect((await ServiceZoneResolver.resolve(ONITSHA)).kind).toBe('inside');
    });
});
