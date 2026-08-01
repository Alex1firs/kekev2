/**
 * Dispatcher push: registration, scoping, lifecycle and evidence.
 *
 * Every case here is something that decides whether a dispatcher's phone rings
 * for the right work, stops ringing for work that is not theirs, or records
 * something untrue about what happened.
 *
 * Firebase is never contacted. `notifyParkDispatchers` is exercised with push
 * unconfigured, which is a real deployment state and the one where the honest
 * evidence model matters most — a send that could not happen must not be
 * recorded as one that did.
 */
import { DataSource } from 'typeorm';
import { Park, ParkStatus } from '../../src/models/Park';
import { ParkZone } from '../../src/models/ParkZone';
import { DispatcherShift } from '../../src/models/DispatcherShift';
import { DriverPresence, DriverPresenceEvent } from '../../src/models';
import { ParkDriverRoster } from '../../src/models/ParkDriverRoster';
import { DriverBadge } from '../../src/models/DriverBadge';
import { ParkDispatchJob } from '../../src/models/ParkDispatchJob';
import { DriverProfile } from '../../src/models/DriverProfile';
import { User } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { Ride } from '../../src/models/Ride';
import { StaffUser, StaffStatus } from '../../src/models/StaffUser';
import { StaffRoleAssignment } from '../../src/models/StaffRoleAssignment';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { StaffSession } from '../../src/models/StaffSession';
import { DispatchEvent } from '../../src/models/DispatchEvent';
import { StaffDeviceToken, StaffTokenStatus } from '../../src/models/StaffDeviceToken';
import { StaffPushDelivery, PushDeliveryState, PushReason } from '../../src/models/StaffPushDelivery';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('dispatcher push', () => {
    jest.setTimeout(120_000);

    let ds: DataSource;
    let StaffPushService: typeof import('../../src/services/staff_push_service').StaffPushService;

    let parkA: Park;
    let parkB: Park;
    let alice: StaffUser;
    let bob: StaffUser;

    /** A token long enough to pass the shape check, unique per call. */
    let n = 0;
    const tok = (label: string) => `${label}-${Date.now()}-${++n}-aaaaaaaaaaaaaaaaaaaaaaaa`;

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS staff_push_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'staff_push_test',
            entities: [
                Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent,
                ParkDriverRoster, DriverBadge, ParkDispatchJob, DriverProfile, User,
                Wallet, Ride, StaffUser, StaffRoleAssignment, StaffAuditEvent,
                StaffSession, DispatchEvent, StaffDeviceToken, StaffPushDelivery,
            ],
            synchronize: true, dropSchema: true,
        });
        await ds.initialize();

        const mod = await import('../../src/config/data_source');
        Object.defineProperty(mod, 'AppDataSource', { value: ds, writable: true, configurable: true });

        ({ StaffPushService } = await import('../../src/services/staff_push_service'));
    }, 120_000);

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        await ds.query('DELETE FROM staff_push_test.staff_push_delivery');
        await ds.query('DELETE FROM staff_push_test.staff_device_token');
        await ds.query('DELETE FROM staff_push_test.park');
        await ds.query('DELETE FROM staff_push_test.staff_user');

        const parks = ds.getRepository(Park);
        const mkPark = (code: string, lat: number) => parks.save(parks.create({
            name: `Park ${code}`, code, lat: lat as any, lng: 7.07 as any,
            serviceRadiusKm: 4, operatingRadiusM: 200, capacityDrivers: 20,
            maxConcurrentAssignments: 3, status: ParkStatus.ACTIVE,
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        } as any));
        parkA = await mkPark(`PA${Date.now() % 100000}`, 6.21);
        parkB = await mkPark(`PB${Date.now() % 100000}`, 6.40);

        const staff = ds.getRepository(StaffUser);
        const mkStaff = (email: string) => staff.save(staff.create({
            email: `${email}.${Date.now()}@kekeride.test`, phone: `0801${Date.now() % 10000000}`,
            firstName: email, lastName: 'T', passwordHash: 'x',
            status: StaffStatus.ACTIVE, credentialVersion: 1,
        } as any));
        alice = await mkStaff('alice');
        bob = await mkStaff('bob');
    });

    // ── registration ─────────────────────────────────────────────────────

    it('registers a token and binds it to the staff member', async () => {
        const t = tok('reg');
        const row = await StaffPushService.register({
            staffUserId: alice.id, token: t, parkId: parkA.parkId,
            deviceId: 'tablet-1', deviceLabel: 'Park tablet',
        });

        expect(row.staffUserId).toBe(alice.id);
        expect(row.status).toBe(StaffTokenStatus.ACTIVE);
        expect(row.parkId).toBe(parkA.parkId);
    });

    it('is idempotent — re-registering the same token does not create a second device', async () => {
        const t = tok('idem');
        await StaffPushService.register({ staffUserId: alice.id, token: t, deviceId: 'tablet-1' });
        await StaffPushService.register({ staffUserId: alice.id, token: t, deviceId: 'tablet-1' });

        const active = await StaffPushService.activeForStaff(alice.id);
        expect(active).toHaveLength(1);
    });

    /**
     * Token rotation is routine — browsers do it on their own schedule. Without
     * this, one tablet would accumulate rows and get several copies of every
     * alert, which is exactly the thing that gets a phone silenced.
     */
    it('replaces an older token on the same device rather than accumulating', async () => {
        const first = tok('old');
        const second = tok('new');
        await StaffPushService.register({ staffUserId: alice.id, token: first, deviceId: 'tablet-1' });
        await StaffPushService.register({ staffUserId: alice.id, token: second, deviceId: 'tablet-1' });

        const active = await StaffPushService.activeForStaff(alice.id);
        expect(active).toHaveLength(1);
        expect(active[0].token).toBe(second);

        const old = await ds.getRepository(StaffDeviceToken).findOne({ where: { token: first } });
        expect(old!.status).toBe(StaffTokenStatus.REVOKED);
    });

    /**
     * A park tablet handed from one dispatcher to the next must stop alerting
     * the first one.
     *
     * The token is globally unique — one browser, one token — so the row moves
     * rather than being duplicated. An earlier implementation tried to keep a
     * revoked row AND insert a new one with the same token, which the unique
     * index refused; this test is what caught it.
     */
    it('moves the device to the new holder when another staff member registers the same browser', async () => {
        const t = tok('shared');
        await StaffPushService.register({
            staffUserId: alice.id, token: t, deviceId: 'shared-tablet', parkId: parkA.parkId,
        });
        await StaffPushService.register({ staffUserId: bob.id, token: t, deviceId: 'shared-tablet' });

        // Alice must no longer be reachable on this device.
        expect(await StaffPushService.activeForStaff(alice.id)).toHaveLength(0);

        const bobs = await StaffPushService.activeForStaff(bob.id);
        expect(bobs).toHaveLength(1);
        expect(bobs[0].token).toBe(t);

        // And the park binding does not travel with the hardware — Bob gets
        // whatever his own shift says, not Alice's park.
        expect(bobs[0].parkId).toBeNull();
    });

    it('refuses something that is not a token', async () => {
        await expect(StaffPushService.register({ staffUserId: alice.id, token: 'short' }))
            .rejects.toThrow();
    });

    // ── lifecycle ────────────────────────────────────────────────────────

    it('revokes on sign-out', async () => {
        const t = tok('out');
        await StaffPushService.register({ staffUserId: alice.id, token: t, deviceId: 'd1' });
        const n = await StaffPushService.revoke({ staffUserId: alice.id, token: t, reason: 'signed out' });

        expect(n).toBe(1);
        expect(await StaffPushService.activeForStaff(alice.id)).toHaveLength(0);
    });

    it('keeps the row after revocation, so the reason survives', async () => {
        const t = tok('keep');
        await StaffPushService.register({ staffUserId: alice.id, token: t });
        await StaffPushService.revoke({ staffUserId: alice.id, reason: 'staff suspended: policy' });

        const row = await ds.getRepository(StaffDeviceToken).findOne({ where: { token: t } });
        expect(row).not.toBeNull();
        expect(row!.status).toBe(StaffTokenStatus.REVOKED);
        expect(row!.revokedReason).toContain('suspended');
        expect(row!.revokedAt).not.toBeNull();
    });

    it('binds every live device to the park when a shift opens', async () => {
        await StaffPushService.register({ staffUserId: alice.id, token: tok('b1'), deviceId: 'd1' });
        await StaffPushService.register({ staffUserId: alice.id, token: tok('b2'), deviceId: 'd2' });

        await StaffPushService.bindToShift(alice.id, parkA.parkId, 'shift-1');

        const active = await StaffPushService.activeForStaff(alice.id);
        expect(active).toHaveLength(2);
        expect(active.every((d) => d.parkId === parkA.parkId)).toBe(true);
        expect(active.every((d) => d.shiftId === 'shift-1')).toBe(true);
    });

    // ── park scoping ─────────────────────────────────────────────────────

    /**
     * The whole point. A dispatcher at park A must never be alerted about work
     * at park B, and the send path filters on park rather than on person.
     */
    it("never alerts a device bound to another park", async () => {
        await StaffPushService.register({
            staffUserId: alice.id, token: tok('at-a'), parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.register({
            staffUserId: bob.id, token: tok('at-b'), parkId: parkB.parkId, deviceId: 'b1',
        });

        const result = await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-1', rideId: 'ride-1',
            title: 'x', body: 'y',
        });

        // One device considered — alice's. Bob's was never a candidate.
        expect(result.tokens).toBe(1);

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-1' } });
        expect(rows.every((r) => r.staffUserId !== bob.id)).toBe(true);
    });

    it('does not alert a device with no park', async () => {
        await StaffPushService.register({ staffUserId: alice.id, token: tok('nopark'), deviceId: 'a1' });

        const result = await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-2', rideId: 'ride-2', title: 'x', body: 'y',
        });
        expect(result.tokens).toBe(0);
    });

    it('does not alert a revoked device', async () => {
        const t = tok('revoked');
        await StaffPushService.register({
            staffUserId: alice.id, token: t, parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.revoke({ staffUserId: alice.id, reason: 'shift closed' });

        const result = await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-3', rideId: 'ride-3', title: 'x', body: 'y',
        });
        expect(result.tokens).toBe(0);
    });

    // ── evidence ─────────────────────────────────────────────────────────

    /**
     * The property that matters most in the whole file.
     *
     * A send that did not succeed must NEVER be recorded as one that did.
     * Whether the cause is a missing credential, a rejected token or a network
     * failure, the row must not say `provider_accepted` — that is the state an
     * operations report reads as "the dispatcher was alerted".
     *
     * The token here is fabricated, so a configured Firebase rejects it and an
     * unconfigured one never tries. Both are correct; neither may claim
     * acceptance.
     */
    it('never records acceptance for a send that did not succeed', async () => {
        await StaffPushService.register({
            staffUserId: alice.id, token: tok('unconf'), parkId: parkA.parkId, deviceId: 'a1',
        });

        const result = await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-4', rideId: 'ride-4', title: 'x', body: 'y',
        });
        expect(result.accepted).toBe(0);

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-4' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].state).not.toBe(PushDeliveryState.PROVIDER_ACCEPTED);
        expect([
            PushDeliveryState.FAILED,
            PushDeliveryState.TOKEN_INVALID,
            PushDeliveryState.UNKNOWN,
        ]).toContain(rows[0].state);
    });

    it('records that no device exists rather than silently doing nothing', async () => {
        const result = await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-5', rideId: 'ride-5', title: 'x', body: 'y',
        });
        expect(result.tokens).toBe(0);

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-5' } });
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows[0].detail)).toContain('no registered dispatcher device');
    });

    /** Acknowledgements only ever move forward. */
    it('does not let a late "received" overwrite an "opened"', async () => {
        const t = tok('ack');
        await StaffPushService.register({
            staffUserId: alice.id, token: t, parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-6', rideId: 'ride-6', title: 'x', body: 'y',
        });

        await StaffPushService.acknowledge({
            staffUserId: alice.id, jobId: 'job-6', token: t,
            state: PushDeliveryState.NOTIFICATION_OPENED,
        });
        await StaffPushService.acknowledge({
            staffUserId: alice.id, jobId: 'job-6', token: t,
            state: PushDeliveryState.SERVICE_WORKER_RECEIVED,
        });

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-6' } });
        expect(rows[0].state).toBe(PushDeliveryState.NOTIFICATION_OPENED);
    });

    it('advances to opened and stamps the device', async () => {
        const t = tok('open');
        await StaffPushService.register({
            staffUserId: alice.id, token: t, parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-7', rideId: 'ride-7', title: 'x', body: 'y',
        });

        await StaffPushService.acknowledge({
            staffUserId: alice.id, jobId: 'job-7', token: t,
            state: PushDeliveryState.NOTIFICATION_OPENED,
        });

        const device = await ds.getRepository(StaffDeviceToken).findOne({ where: { token: t } });
        expect(device!.lastNotificationOpenedAt).not.toBeNull();

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-7' } });
        expect(rows[0].openedAt).not.toBeNull();
    });

    /** The full token is a sending credential and must not be in an audit row. */
    it('never stores a full token in the delivery record', async () => {
        const t = tok('secret');
        await StaffPushService.register({
            staffUserId: alice.id, token: t, parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-8', rideId: 'ride-8', title: 'x', body: 'y',
        });

        const rows = await ds.getRepository(StaffPushDelivery).find({ where: { jobId: 'job-8' } });
        for (const r of rows) {
            expect(r.tokenRef ?? '').not.toContain(t);
            if (r.tokenRef) expect(r.tokenRef.length).toBeLessThanOrEqual(24);
        }
    });

    it('reports configuration as missing rather than pretending push works', () => {
        const before = process.env.FIREBASE_WEB_API_KEY;
        delete process.env.FIREBASE_WEB_API_KEY;
        try {
            expect(StaffPushService.webConfig()).toBeNull();
            expect(StaffPushService.missingConfig()).toContain('FIREBASE_WEB_API_KEY');
        } finally {
            if (before) process.env.FIREBASE_WEB_API_KEY = before;
        }
    });

    it('keeps deliveries retrievable per job for the operations view', async () => {
        await StaffPushService.register({
            staffUserId: alice.id, token: tok('view'), parkId: parkA.parkId, deviceId: 'a1',
        });
        await StaffPushService.notifyParkDispatchers({
            parkId: parkA.parkId, jobId: 'job-9', rideId: 'ride-9',
            title: 'x', body: 'y', reason: PushReason.REMINDER,
        });

        const rows = await StaffPushService.forJob('job-9');
        expect(rows).toHaveLength(1);
        expect(rows[0].reason).toBe(PushReason.REMINDER);
    });
});
