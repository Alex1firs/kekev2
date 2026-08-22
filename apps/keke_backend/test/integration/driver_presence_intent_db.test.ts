/**
 * Driver presence: intent is durable, device health is not, and nothing
 * conflates them.
 *
 * The bug these tests exist to prevent returning: "online" was a 45-second
 * Redis TTL, so a driver whose phone went quiet silently left the dispatch
 * pool and only came back by reopening the app. Measured in production before
 * the fix — 79 drivers with positions, ZERO dispatchable, ZERO who had chosen
 * to go offline.
 *
 * The central assertion, repeated in several shapes: no amount of elapsed
 * time, and no device failure of any kind, may turn ONLINE into OFFLINE.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

import { User, UserRole } from '../../src/models/User';
import { DriverProfile } from '../../src/models/DriverProfile';
import { DeviceToken } from '../../src/models/DeviceToken';
import { DriverPresenceIntent, PresenceIntent, IntentActor } from '../../src/models/DriverPresenceIntent';

/*
 * A REAL Redis for this suite, not the in-memory mock.
 *
 * Presence is built on GEOADD/GEORADIUS and on TTL expiry, and ioredis-mock
 * implements neither faithfully — `geoadd` is not even available inside a
 * pipeline. Testing "is this driver near the pickup" against a fake geo index
 * would prove nothing about the behaviour that actually broke in production.
 */
jest.mock('../../src/config/redis', () => {
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.TEST_REDIS_URL || 'redis://localhost:6399');
    return { redis: client, default: client };
});

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping presence tests.');

const SCHEMA = 'presence_intent_test';

describeDb('driver presence — intent vs device health (database)', () => {
    let ds: DataSource;
    let Intent: typeof import('../../src/services/driver_intent_service').DriverIntentService;
    let Candidates: typeof import('../../src/services/driver_candidate_service').DriverCandidateService;
    let Wake: typeof import('../../src/services/driver_wake_service').DriverWakeService;
    let Dispatch: typeof import('../../src/services/dispatch_service').DispatchService;
    let redis: any;

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: SCHEMA,
            entities: [User, DriverProfile, DeviceToken, DriverPresenceIntent],
            synchronize: true, logging: false,
            extra: { options: `-c search_path=${SCHEMA},public` },
        });
        await ds.initialize();

        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });

        Intent = require('../../src/services/driver_intent_service').DriverIntentService;
        Candidates = require('../../src/services/driver_candidate_service').DriverCandidateService;
        Wake = require('../../src/services/driver_wake_service').DriverWakeService;
        Dispatch = require('../../src/services/dispatch_service').DispatchService;
        redis = require('../../src/config/redis').redis;
    });

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        for (const t of ['driver_presence_intent', 'device_token', 'driver_profile', 'user']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
        await redis.flushall();
        jest.restoreAllMocks();
    });

    // ── Fixtures ────────────────────────────────────────────────────────

    async function driver(opts: { withToken?: boolean } = {}): Promise<string> {
        const id = randomUUID();
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id, email: `d-${id.slice(0, 8)}@example.invalid`,
            firstName: 'Chidi', lastName: 'Eze',
            phone: `+23480${String(Date.now()).slice(-8)}`,
            role: UserRole.DRIVER, password: 'x',
        } as any));
        if (opts.withToken !== false) {
            await ds.getRepository(DeviceToken).save(ds.getRepository(DeviceToken).create({
                userId: id, role: UserRole.DRIVER, token: `tok-${id.slice(0, 8)}`,
                platform: 'android', isActive: true,
            } as any));
        }
        return id;
    }

    /** Put a driver in the live geo index with a fresh beat, as a heartbeat would. */
    const beat = (id: string, lat = 6.14, lng = 6.79) =>
        Dispatch.updateDriverLocation(id, lat, lng);

    /** Age a driver out: position remembered, availability gone. Exactly what
     *  happens when a phone stops beating. */
    async function goQuiet(id: string) {
        await redis.del(`driver:available:${id}`);
    }

    // ══ Intent is durable ═══════════════════════════════════════════════

    it('a driver who goes online stays online after their phone goes silent', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d);

        await goQuiet(d);   // hours pass; no heartbeat

        expect(await Intent.isOnline(d)).toBe(true);
        const health = await Intent.healthOf(d);
        expect(health.intent).toBe(PresenceIntent.ONLINE);
        expect(health.reachability).toBe('STALE');   // device problem, not intent
    });

    it('nothing in the system can turn ONLINE into OFFLINE by elapsed time', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d);
        await goQuiet(d);

        // Everything that used to erase a driver, all at once.
        await Dispatch.removeDriverAvailability(d);
        await redis.del(`driver:lastseen:${d}`);
        await Intent.recordWakeAttempt(d, false);
        await Intent.recordWakeAttempt(d, false);
        await Intent.recordWakeAttempt(d, false);
        await Intent.recordWakeAttempt(d, false);

        const health = await Intent.healthOf(d);
        expect(health.intent).toBe(PresenceIntent.ONLINE);        // still working
        expect(health.reachability).toBe('UNREACHABLE');          // honestly reported
    });

    it('only a decision ends ONLINE', async () => {
        const d = await driver();
        await Intent.setOnline(d);

        await Intent.setOffline(d, IntentActor.DRIVER, null, 'driver toggled offline');

        const row = await Intent.get(d);
        expect(row!.state).toBe(PresenceIntent.OFFLINE);
        expect(row!.setBy).toBe(IntentActor.DRIVER);
        // And going offline DOES stop dispatch immediately.
        expect(await redis.get(`driver:available:${d}`)).toBeNull();
    });

    it('an admin can end it, and it is attributable', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await Intent.setOffline(d, IntentActor.ADMIN, 'staff-42', 'suspended pending review');

        const row = await Intent.get(d);
        expect(row!.setBy).toBe(IntentActor.ADMIN);
        expect(row!.actorId).toBe('staff-42');
        expect(row!.reason).toBe('suspended pending review');
    });

    // ══ Backward compatibility with the shipped APK ═════════════════════

    it('a heartbeat from the shipped APK declares ONLINE — no app release needed', async () => {
        const d = await driver();
        expect(await Intent.isOnline(d)).toBe(false);

        await Intent.recordHeartbeat(d);      // all the old client ever sends

        const row = await Intent.get(d);
        expect(row!.state).toBe(PresenceIntent.ONLINE);
        expect(row!.setBy).toBe(IntentActor.SYSTEM);
        expect(row!.reason).toBe('Declared by heartbeat');
    });

    it('a heartbeat racing a deliberate toggle-off does not drag the driver back on', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await Intent.setOffline(d, IntentActor.DRIVER, null, 'driver toggled offline');

        // A beat already in flight when they pressed the button.
        await Intent.recordHeartbeat(d);

        expect(await Intent.isOnline(d)).toBe(false);
    });

    it('but a heartbeat well after going offline means they are working again', async () => {
        const d = await driver();
        await Intent.setOffline(d, IntentActor.DRIVER, null, 'toggled off');
        // Backdate the decision past the race window.
        await ds.query(
            `UPDATE ${SCHEMA}.driver_presence_intent SET since = now() - interval '10 minutes' WHERE "driverId" = $1`,
            [d]);

        await Intent.recordHeartbeat(d);

        expect(await Intent.isOnline(d)).toBe(true);
    });

    // ══ Recovery is automatic ═══════════════════════════════════════════

    it('connectivity returning restores reachability with no toggle and no app reopen', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d);
        await goQuiet(d);
        await Intent.recordWakeAttempt(d, false);
        await Intent.recordWakeAttempt(d, false);
        await Intent.recordWakeAttempt(d, false);
        expect((await Intent.healthOf(d)).reachability).toBe('UNREACHABLE');

        // One heartbeat — from a wake answer, a regained signal, anything.
        await beat(d);
        await Intent.recordHeartbeat(d);

        const health = await Intent.healthOf(d);
        expect(health.reachability).toBe('FRESH');
        expect(health.failedWakeCount).toBe(0);
    });

    it('a driver with no push token is UNREACHABLE but still ONLINE', async () => {
        const d = await driver({ withToken: false });
        await Intent.setOnline(d);
        await beat(d);
        await goQuiet(d);

        const health = await Intent.healthOf(d);
        expect(health.intent).toBe(PresenceIntent.ONLINE);
        expect(health.hasPushToken).toBe(false);
        expect(health.reachability).toBe('UNREACHABLE');
    });

    // ══ Dispatch behaviour ══════════════════════════════════════════════

    it('a fresh driver is dispatched without anyone being woken', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);

        const wakeSpy = jest.spyOn(Wake, 'wakeMany');
        const { candidates, wakes } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        expect(candidates.map((c) => c.driverId)).toContain(d);
        expect(candidates.find((c) => c.driverId === d)!.tier).toBe('fresh');
        expect(wakes).toHaveLength(0);
        expect(wakeSpy).not.toHaveBeenCalled();
    });

    it('a stale ONLINE driver is woken, and joins only on a FRESH fix', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);       // establishes last-known position
        await goQuiet(d);

        // The wake "succeeds": the phone answers by beating, as the real client does.
        jest.spyOn(Wake, 'wakeMany').mockImplementation(async (ids: string[]) => {
            for (const id of ids) await beat(id, 6.141, 6.791);
            return ids.map((driverId) => ({
                driverId, attempted: true, answered: true,
                freshPosition: { lat: 6.141, lng: 6.791, at: Date.now() },
            }));
        });

        const { candidates, wakes } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        expect(wakes).toHaveLength(1);
        expect(wakes[0].answered).toBe(true);
        const entry = candidates.find((c) => c.driverId === d);
        expect(entry).toBeDefined();
        expect(entry!.tier).toBe('woken');
    });

    it('a stale driver whose phone does NOT answer is not dispatched — and stays ONLINE', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);

        jest.spyOn(Wake, 'wakeMany').mockImplementation(async (ids: string[]) =>
            ids.map((driverId) => ({
                driverId, attempted: true, answered: false, freshPosition: null, reason: 'no_answer',
            })));

        const { candidates, wakes } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        expect(candidates.map((c) => c.driverId)).not.toContain(d);
        expect(wakes[0].answered).toBe(false);
        // The crucial part: not dispatched, but not erased either.
        expect(await Intent.isOnline(d)).toBe(true);
    });

    it('stale coordinates are never used for dispatch, only to decide who to wake', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);

        // The phone answers, but it has MOVED far away since that old fix.
        jest.spyOn(Wake, 'wakeMany').mockImplementation(async (ids: string[]) => {
            for (const id of ids) await beat(id, 6.60, 7.20);   // ~60km away
            return ids.map((driverId) => ({
                driverId, attempted: true, answered: true,
                freshPosition: { lat: 6.60, lng: 7.20, at: Date.now() },
            }));
        });

        const { candidates } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        // Woken, answered — and correctly rejected on the FRESH position.
        expect(candidates.map((c) => c.driverId)).not.toContain(d);
    });

    it('an OFFLINE driver is never woken, however near they are', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await Intent.setOffline(d, IntentActor.DRIVER, null, 'done for the day');

        const wakeSpy = jest.spyOn(Wake, 'wakeMany');
        const { candidates, wakes } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        expect(candidates.map((c) => c.driverId)).not.toContain(d);
        expect(wakes).toHaveLength(0);
        expect(wakeSpy).not.toHaveBeenCalled();
    });

    it('the passenger map never causes a wake', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);

        const wakeSpy = jest.spyOn(Wake, 'wakeMany');
        const { wakes } = await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: false });

        expect(wakes).toHaveLength(0);
        expect(wakeSpy).not.toHaveBeenCalled();
    });

    it('a demand burst produces one wake, not one per request', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);

        // Real wake path, with the FCM send stubbed out.
        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Promise.all([
            Wake.wake(d, { rideId: 'R1' }),
            Wake.wake(d, { rideId: 'R2' }),
            Wake.wake(d, { rideId: 'R3' }),
        ]);

        // The cooldown key is claimed atomically, so only one knock goes out.
        expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('the wake push is data-only — a driver must never see it', async () => {
        const d = await driver();
        await Intent.setOnline(d);

        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wake(d, { rideId: 'R1' });

        const msg = sendSpy.mock.calls[0][0];
        expect(msg.notification).toBeUndefined();          // invisible
        expect(msg.data.type).toBe('PRESENCE_WAKE');
        expect(msg.android.priority).toBe('high');
        // iOS: without these a suspended app is simply never woken.
        expect(msg.apns.payload.aps.contentAvailable).toBe(true);
        expect(msg.apns.headers['apns-push-type']).toBe('background');
    });

    // ══ Path A: the ring must not depend on our process starting ════════

    it('an audible wake carries a notification block on the ride-request channel', async () => {
        const d = await driver();
        await Intent.setOnline(d);

        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wake(d, { rideId: 'R-AUDIBLE', audible: true });

        const msg = sendSpy.mock.calls[0][0];
        /*
         * This block is what Google Play Services renders on the device
         * WITHOUT starting our app. A Redmi with MIUI Autostart off — the
         * default for a sideloaded APK — will never run our background
         * isolate, so a data-only wake is silent there no matter how correct
         * the Dart is. The ring has to live here.
         */
        expect(msg.notification).toBeDefined();
        expect(msg.notification.title).toBe('Ride request nearby');
        expect(msg.android.notification.channelId).toBe('keke_ride_requests');
        expect(msg.android.notification.sound).toBe('keke_ring');
        expect(msg.android.priority).toBe('high');
        // Path B rides along on the same message.
        expect(msg.data.type).toBe('PRESENCE_WAKE');
    });

    it('the audible wake does not claim a ride has been assigned', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wake(d, { rideId: 'R1', audible: true });
        const text = `${sendSpy.mock.calls[0][0].notification.title} ${sendSpy.mock.calls[0][0].notification.body}`.toLowerCase();

        // No ride is assigned at this point and the driver must not be told
        // one is — they would act on it and find nothing.
        expect(text).not.toContain('assigned');
        expect(text).not.toContain('you have a ride');
        expect(text).toContain('nearby');
    });

    it('a silent wake carries no notification block at all', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wake(d, { rideId: 'R1', audible: false });

        expect(sendSpy.mock.calls[0][0].notification).toBeUndefined();
        expect(sendSpy.mock.calls[0][0].android.notification).toBeUndefined();
    });

    it('a driver is rung at most once for the same ride', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wake(d, { rideId: 'R-SAME', audible: true });
        await redis.del(`driver:wake:${d}`);          // clear only the send cooldown
        await Wake.wake(d, { rideId: 'R-SAME', audible: true });

        // Dispatch re-queries every round; a driver rung four times for one
        // passenger learns to ignore the sound.
        expect(sendSpy).toHaveBeenCalledTimes(2);
        expect(sendSpy.mock.calls[0][0].notification).toBeDefined();
        expect(sendSpy.mock.calls[1][0].notification).toBeUndefined();
    });

    it('only the nearest few are rung; the rest are woken silently', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const d = await driver();
            await Intent.setOnline(d);
            ids.push(d);
        }
        const admin = require('firebase-admin');
        const sendSpy = jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
        jest.spyOn(admin, 'messaging').mockReturnValue({ sendEachForMulticast: sendSpy } as any);

        await Wake.wakeMany(ids, { rideId: 'R-MANY', audibleLimit: 3 });

        const audibleCount = sendSpy.mock.calls.filter((c: any[]) => c[0].notification).length;
        expect(sendSpy).toHaveBeenCalledTimes(5);
        expect(audibleCount).toBe(3);
    });

    it('an UNREACHABLE driver is still woken — it must not be a one-way door', async () => {
        const d = await driver();
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);
        // Three unanswered wakes: the driver is now UNREACHABLE.
        for (let i = 0; i < 3; i++) await Intent.recordWakeAttempt(d, false);
        expect((await Intent.healthOf(d)).reachability).toBe('UNREACHABLE');

        const wakeSpy = jest.spyOn(Wake, 'wakeMany').mockResolvedValue([]);
        await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true, rideId: 'R-UNREACH' });

        /*
         * Excluding them stranded exactly the drivers Path A exists for: an
         * unanswered wake usually means the background isolate cannot start on
         * that handset, and only the audible notification gets through. If they
         * were skipped, the sole route back would be a heartbeat — which needs
         * the app running, which is the thing that was failing.
         */
        expect(wakeSpy).toHaveBeenCalled();
        expect(wakeSpy.mock.calls[0][0]).toContain(d);
        expect(await Intent.isOnline(d)).toBe(true);
    });

    it('an unreachable driver with no push token is not woken — there is nowhere to knock', async () => {
        const d = await driver({ withToken: false });
        await Intent.setOnline(d);
        await beat(d, 6.14, 6.79);
        await goQuiet(d);

        const wakeSpy = jest.spyOn(Wake, 'wakeMany').mockResolvedValue([]);
        await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        expect(wakeSpy).not.toHaveBeenCalled();
    });

    it('STALE drivers are ranked ahead of UNREACHABLE ones for the audible slots', async () => {
        const stale = await driver();
        const unreachable = await driver();
        for (const d of [stale, unreachable]) {
            await Intent.setOnline(d);
            await beat(d, 6.14, 6.79);
            await goQuiet(d);
        }
        // Make one unreachable, and put it CLOSER so only ranking can reorder.
        for (let i = 0; i < 3; i++) await Intent.recordWakeAttempt(unreachable, false);
        await beat(unreachable, 6.1401, 6.7901); await goQuiet(unreachable);

        const wakeSpy = jest.spyOn(Wake, 'wakeMany').mockResolvedValue([]);
        await Candidates.findFor(6.14, 6.79, 5, 5, { wantWakes: true });

        const order = wakeSpy.mock.calls[0][0];
        expect(order.indexOf(stale)).toBeLessThan(order.indexOf(unreachable));
    });

    // ══ Fleet reporting ═════════════════════════════════════════════════

    it('reports ONLINE-but-unreachable as its own state instead of hiding it', async () => {
        const fresh = await driver();
        const stale = await driver();
        const dark = await driver({ withToken: false });
        const off = await driver();

        for (const d of [fresh, stale, dark]) await Intent.setOnline(d);
        await Intent.setOffline(off, IntentActor.DRIVER, null, 'done');

        await beat(fresh);
        await beat(stale); await goQuiet(stale);
        await beat(dark);  await goQuiet(dark);

        const summary = await Intent.fleetSummary();
        expect(summary.online).toBe(3);
        expect(summary.fresh).toBe(1);
        expect(summary.stale).toBe(1);
        expect(summary.unreachable).toBe(1);
        expect(summary.offline).toBe(1);
    });
});
