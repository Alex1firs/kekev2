/**
 * Park scoping and dispatcher authority, tested by trying to break them.
 *
 * Every case here is something a dispatcher could actually attempt from a park
 * tablet — change a park id in a request, act after their shift ended, assign
 * while Park Dispatch is suspended, reach for a passenger's real number. The
 * point is not that the UI hides these; it is that the SERVER refuses them.
 *
 * Runs against real Postgres in its own schema, like the other integration
 * suites, and drives the services directly rather than the HTTP layer so the
 * refusals are attributed to the rules rather than to routing.
 */
import { DataSource } from 'typeorm';
import { Park, ParkStatus } from '../../src/models/Park';
import { ParkZone } from '../../src/models/ParkZone';
import { DispatcherShift } from '../../src/models/DispatcherShift';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../../src/models/DriverPresence';
import { DriverPresenceEvent } from '../../src/models/DriverPresenceEvent';
import { ParkDriverRoster, RosterStatus } from '../../src/models/ParkDriverRoster';
import { DriverBadge, BadgeStatus } from '../../src/models/DriverBadge';
import { ParkDispatchJob, ParkJobStatus } from '../../src/models/ParkDispatchJob';
import { DriverProfile } from '../../src/models/DriverProfile';
import { User } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { Ride } from '../../src/models/Ride';
import { StaffUser, StaffStatus } from '../../src/models/StaffUser';
import { StaffRoleAssignment } from '../../src/models/StaffRoleAssignment';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { StaffSession } from '../../src/models/StaffSession';
import { DispatchEvent } from '../../src/models/DispatchEvent';
import { StaffRole, StaffPermission } from '../../src/config/staff_permissions';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

describeDb('dispatcher security boundaries', () => {
    jest.setTimeout(120_000);

    let ds: DataSource;
    let ParkDispatchService: typeof import('../../src/services/park_dispatch_service').ParkDispatchService;
    let DispatcherShiftService: typeof import('../../src/services/dispatcher_shift_service').DispatcherShiftService;
    let staffParkScope: typeof import('../../src/middleware/park_scope').staffParkScope;
    let ParkDispatchSwitch: typeof import('../../src/services/park_dispatch_switch').ParkDispatchSwitch;
    let permissionsForRole: typeof import('../../src/config/staff_permissions').permissionsForRole;

    /** Two parks, so "the other park" is a real place and not a made-up id. */
    let parkA: Park;
    let parkB: Park;
    let dispatcherA: StaffUser;
    let driverAtB: string;
    let passengerId: string;

    const actorFor = (staff: StaffUser, roles: StaffRole[] = [StaffRole.PARK_DISPATCHER]) =>
        ({ staffUserId: staff.id, roles, isLegacy: false });

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS dispatcher_security_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'dispatcher_security_test',
            entities: [
                Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent,
                ParkDriverRoster, DriverBadge, ParkDispatchJob, DriverProfile, User,
                Wallet, Ride, StaffUser, StaffRoleAssignment, StaffAuditEvent,
                StaffSession, DispatchEvent,
            ],
            synchronize: true, dropSchema: true,
        });
        await ds.initialize();

        // The partial unique index is migration-only; the one-open-shift rule
        // depends on it.
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_open_sec"
            ON dispatcher_security_test.dispatcher_shift ("staffUserId") WHERE status = 'open'`);

        const dataSourceModule = await import('../../src/config/data_source');
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true, configurable: true });

        ({ ParkDispatchService } = await import('../../src/services/park_dispatch_service'));
        ({ DispatcherShiftService } = await import('../../src/services/dispatcher_shift_service'));
        ({ staffParkScope } = await import('../../src/middleware/park_scope'));
        ({ ParkDispatchSwitch } = await import('../../src/services/park_dispatch_switch'));
        ({ permissionsForRole } = await import('../../src/config/staff_permissions'));

        ParkDispatchService.setHost({
            assignDriver: async () => ({ ok: true as const }),
            offerRideToDriver: async () => true,
            emitToRide: () => {}, emitToPark: () => {}, emitToAdmin: () => {}, notifyPassenger: () => {},
        });
    }, 120_000);

    afterAll(async () => {
        await ParkDispatchSwitch?.enable().catch(() => {});
        if (ds?.isInitialized) await ds.destroy();
    });

    beforeEach(async () => {
        const parks = ds.getRepository(Park);
        const mk = (code: string, lat: number) => parks.save(parks.create({
            name: `Park ${code}`, code, lat: lat as any, lng: 7.07 as any,
            serviceRadiusKm: 4, operatingRadiusM: 200, capacityDrivers: 20,
            maxConcurrentAssignments: 3, status: ParkStatus.ACTIVE,
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        } as any));

        await ds.query('DELETE FROM dispatcher_security_test.park_dispatch_job');
        await ds.query('DELETE FROM dispatcher_security_test.dispatcher_shift');
        await ds.query('DELETE FROM dispatcher_security_test.park_driver_roster');
        await ds.query('DELETE FROM dispatcher_security_test.park');
        await ds.query('DELETE FROM dispatcher_security_test.staff_role_assignment');
        await ds.query('DELETE FROM dispatcher_security_test.staff_user');

        parkA = await mk(`A${Date.now() % 100000}`, 6.21);
        parkB = await mk(`B${Date.now() % 100000}`, 6.60);

        const staff = ds.getRepository(StaffUser);
        dispatcherA = await staff.save(staff.create({
            email: `disp.a.${Date.now()}@kekeride.test`, phone: '08010000001',
            firstName: 'Chidi', lastName: 'A', passwordHash: 'x',
            status: StaffStatus.ACTIVE, credentialVersion: 1,
        } as any));

        const roles = ds.getRepository(StaffRoleAssignment);
        await roles.save(roles.create({
            staffUserId: dispatcherA.id, role: StaffRole.PARK_DISPATCHER,
            parkId: parkA.parkId, grantedByStaffId: 'TEST', grantedAt: new Date(),
        } as any));

        // A driver rostered at park B only.
        const users = ds.getRepository(User);
        const u = await users.save(users.create({
            email: `drv.b.${Date.now()}@kekeride.test`, phone: '08020000002',
            firstName: 'Emeka', lastName: 'B', role: 'driver' as any,
            password: 'x', emailVerified: true,
        } as any));
        driverAtB = u.id;

        // A real passenger row: `passengerId` is a uuid column, and the queue
        // joins on it.
        const pax = await users.save(users.create({
            email: `pax.${Date.now()}@kekeride.test`, phone: '08030000003',
            firstName: 'Amaka', lastName: 'P', role: 'passenger' as any,
            password: 'x', emailVerified: true,
        } as any));
        passengerId = pax.id;
        const roster = ds.getRepository(ParkDriverRoster);
        await roster.save(roster.create({
            parkId: parkB.parkId, driverId: driverAtB, status: RosterStatus.ACTIVE,
            queuePosition: 1, queuedAt: new Date(), joinedAt: new Date(),
        } as any));
    });

    async function openShiftAtA() {
        return DispatcherShiftService.open(actorFor(dispatcherA), { parkId: parkA.parkId, lat: null, lng: null, deviceId: null });
    }

    async function liveJobAt(park: Park): Promise<ParkDispatchJob> {
        const rides = ds.getRepository(Ride);
        const ride = await rides.save(rides.create({
            rideId: `RIDE-SEC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            passengerId, fare: 1000 as any, paymentMode: 'cash',
            status: 'searching' as any, pickupLat: Number(park.lat) as any, pickupLng: Number(park.lng) as any,
            pickupAddress: 'Somewhere', destinationAddress: 'Elsewhere',
        } as any));
        const jobs = ds.getRepository(ParkDispatchJob);
        return jobs.save(jobs.create({
            rideId: ride.rideId, parkId: park.parkId, status: ParkJobStatus.OFFERED,
            priority: 1, attemptNumber: 1, offeredAt: new Date(),
            offerExpiresAt: new Date(Date.now() + 60_000),
        } as any));
    }

    // ── the scope itself ─────────────────────────────────────────────────

    it('scopes a dispatcher to their assigned park only', async () => {
        const scope = await staffParkScope(dispatcherA.id);
        expect(scope).not.toBe('*');
        expect([...(scope as Set<string>)]).toEqual([parkA.parkId]);
    });

    it('refuses to open a shift at a park the dispatcher is not assigned to', async () => {
        await expect(
            DispatcherShiftService.open(actorFor(dispatcherA), { parkId: parkB.parkId, lat: null, lng: null, deviceId: null }),
        ).rejects.toThrow();
    });

    // ── acting on another park's work ────────────────────────────────────

    it('refuses to claim a request belonging to another park', async () => {
        await openShiftAtA();
        const jobAtB = await liveJobAt(parkB);

        // The dispatcher knows the job id — it is a uuid, not a secret — and
        // asks for it directly. The shift, not the request, decides.
        await expect(
            ParkDispatchService.claim(actorFor(dispatcherA), jobAtB.jobId, {}),
        ).rejects.toThrow();

        const after = await ds.getRepository(ParkDispatchJob).findOneBy({ jobId: jobAtB.jobId });
        expect(after!.claimedByStaffId).toBeNull();
        expect(after!.status).toBe(ParkJobStatus.OFFERED);
    });

    it("does not show another park's queue", async () => {
        await openShiftAtA();
        await liveJobAt(parkB);
        const queue = await ParkDispatchService.queueForPark(parkA.parkId);
        expect(queue).toHaveLength(0);
    });

    it("does not offer another park's drivers", async () => {
        await openShiftAtA();
        const drivers = await ParkDispatchService.assignableDrivers(parkA.parkId);
        expect(drivers.map((d) => d.driverId)).not.toContain(driverAtB);
    });

    // ── acting without a shift ───────────────────────────────────────────

    it('refuses to claim with no open shift', async () => {
        const job = await liveJobAt(parkA);
        await expect(
            ParkDispatchService.claim(actorFor(dispatcherA), job.jobId, {}),
        ).rejects.toThrow();
    });

    it('refuses to claim after the shift has been closed', async () => {
        await openShiftAtA();
        const job = await liveJobAt(parkA);
        await DispatcherShiftService.close(actorFor(dispatcherA), { handoverNotes: 'done' });

        await expect(
            ParkDispatchService.claim(actorFor(dispatcherA), job.jobId, {}),
        ).rejects.toThrow();
    });

    // ── suspension ───────────────────────────────────────────────────────

    it('stops new work entering the park phase while suspended, but lets claimed work finish', async () => {
        await openShiftAtA();
        const job = await liveJobAt(parkA);
        await ParkDispatchService.claim(actorFor(dispatcherA), job.jobId, {});

        await ParkDispatchSwitch.disable('security test', 'tester');
        try {
            // New work is refused at the doorway.
            const rides = ds.getRepository(Ride);
            const fresh = await rides.save(rides.create({
                rideId: `RIDE-SEC-SUS-${Date.now()}`, passengerId, fare: 900 as any,
                paymentMode: 'cash', status: 'searching' as any,
                pickupLat: Number(parkA.lat) as any, pickupLng: Number(parkA.lng) as any,
            } as any));
            expect(await ParkDispatchService.offerToPark(fresh.rideId)).toBe(false);

            // Work already in hand is NOT abandoned — that would strand a
            // passenger who is being served perfectly well.
            const stillMine = await ds.getRepository(ParkDispatchJob).findOneBy({ jobId: job.jobId });
            expect(stillMine!.status).toBe(ParkJobStatus.CLAIMED);
            expect(stillMine!.claimedByStaffId).toBe(dispatcherA.id);
        } finally {
            await ParkDispatchSwitch.enable();
        }
    });

    // ── the permission matrix itself ─────────────────────────────────────

    it('gives a dispatcher no way to advance a ride, move money, or read a real number', async () => {
        const granted: string[] = permissionsForRole(StaffRole.PARK_DISPATCHER);

        // The things a dispatcher must never be able to do, whatever the
        // client offers them.
        expect(granted).not.toContain(StaffPermission.MONITOR_REVEAL_CONTACT);
        expect(granted).not.toContain(StaffPermission.PARK_SUSPEND);

        // Nothing wallet- or payment-shaped at all.
        expect(granted.filter((p) => /wallet|payout|refund|payment/i.test(p))).toEqual([]);
        // Nothing that mutates a ride's lifecycle.
        expect(granted.filter((p) => /ride:(start|complete|arrive|cancel)/i.test(p))).toEqual([]);
    });

    it('does not let a dispatcher suspend Park Dispatch', () => {
        const granted: string[] = permissionsForRole(StaffRole.PARK_DISPATCHER);
        const supervisor: string[] = permissionsForRole(StaffRole.PARK_SUPERVISOR);
        expect(granted).not.toContain(StaffPermission.PARK_SUSPEND);
        expect(supervisor).not.toContain(StaffPermission.PARK_SUSPEND);
    });
});
