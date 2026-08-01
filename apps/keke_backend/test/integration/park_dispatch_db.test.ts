/**
 * Park Dispatch fallback, against a real database.
 *
 * Covers the end-to-end path — direct dispatch fails, a park is offered, a
 * dispatcher claims and assigns, the ride becomes `accepted` — plus the races
 * that matter: a direct driver winning during the park phase, two dispatchers
 * claiming at once, and windows expiring.
 *
 * The assignment itself is exercised through a stub host that mirrors what
 * SocketHandler.assignDriverToRide does to the ride row (the conditional
 * searching→accepted UPDATE). That keeps the test honest about the ARBITER —
 * the ride row — without needing socket.io in a database test.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Park, ParkStatus } from '../../src/models/Park';
import { ParkZone, ParkZoneKind } from '../../src/models/ParkZone';
import { DispatcherShift } from '../../src/models/DispatcherShift';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../../src/models/DriverPresence';
import { DriverPresenceEvent } from '../../src/models/DriverPresenceEvent';
import { ParkDriverRoster } from '../../src/models/ParkDriverRoster';
import { DriverBadge } from '../../src/models/DriverBadge';
import { ParkDispatchJob, ParkJobStatus, ParkAssignmentMode } from '../../src/models/ParkDispatchJob';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { User, UserRole } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { Ride } from '../../src/models/Ride';
import { StaffUser, StaffStatus } from '../../src/models/StaffUser';
import { StaffRoleAssignment } from '../../src/models/StaffRoleAssignment';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { StaffRole } from '../../src/config/staff_permissions';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
    // eslint-disable-next-line no-console
    console.warn('[integration] TEST_DATABASE_URL not set — skipping park dispatch DB tests.');
}

describeDb('park dispatch fallback (database)', () => {
    let ds: DataSource;
    let ParkService: typeof import('../../src/services/park_service').ParkService;
    let ParkRosterService: typeof import('../../src/services/park_roster_service').ParkRosterService;
    let DispatcherShiftService: typeof import('../../src/services/dispatcher_shift_service').DispatcherShiftService;
    let DriverPresenceService: typeof import('../../src/services/driver_presence_service').DriverPresenceService;
    let BadgeService: typeof import('../../src/services/badge_service').BadgeService;
    let ParkDispatchService: typeof import('../../src/services/park_dispatch_service').ParkDispatchService;
    let ParkDispatchJobRepository: typeof import('../../src/repositories/park_dispatch_job_repository').ParkDispatchJobRepository;

    const OPS: any = { staffUserId: 'ACTOR_OPS', roles: [StaffRole.OPERATIONS_ADMIN], isLegacy: false };
    let seq = 0;
    const uniq = () => `${Date.now()}${++seq}`;
    const emitted: Array<{ target: string; event: string; payload: any }> = [];

    const originalEnabled = process.env.PARK_DISPATCH_ENABLED;

    /**
     * A stub host that performs the SAME conditional UPDATE the real assignment
     * method does. The ride row stays the sole arbiter of ownership.
     */
    const stubHost = {
        assignDriver: async (a: any) => {
            const result = await ds.getRepository(Ride).createQueryBuilder()
                .update()
                .set({
                    driverId: a.driverId,
                    status: 'accepted' as any,
                    dispatchMode: 'park',
                    parkId: a.parkId,
                    parkJobId: a.parkJobId,
                    assignmentMode: a.assignmentMode,
                } as any)
                .where('"rideId" = :rideId AND status = :status', { rideId: a.rideId, status: 'searching' })
                .execute();
            return (result.affected ?? 0) > 0
                ? { ok: true as const }
                : { ok: false as const, code: 'RIDE_ALREADY_TAKEN', message: 'This ride is no longer available.' };
        },
        emitToRide: (rideId: string, event: string, payload: any) => emitted.push({ target: `ride:${rideId}`, event, payload }),
        emitToPark: (parkId: string, event: string, payload: any) => emitted.push({ target: `park:${parkId}`, event, payload }),
        emitToAdmin: (event: string, payload: any) => emitted.push({ target: 'admin', event, payload }),
        notifyPassenger: () => { /* push is not under test here */ },
    };

    const makeDriver = async (over: Partial<DriverProfile> = {}) => {
        const n = uniq();
        const user = await ds.getRepository(User).save(ds.getRepository(User).create({
            email: `drv${n}@k.test`, phone: `080${n.slice(-8)}`, password: 'x',
            firstName: 'Drv', lastName: n.slice(-4), role: UserRole.DRIVER,
        }));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: user.id, firstName: 'Drv', lastName: n.slice(-4),
            vehiclePlate: `ENU-${n.slice(-3)}-KJ`, vehicleModel: 'Keke',
            status: DriverStatus.APPROVED, photoUrl: 'p.jpg', unitNumber: `U${n.slice(-3)}`,
            deviceCapability: 'smartphone', ...over,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({ userId: user.id }));
        return user.id;
    };

    const makeStaff = async (role: StaffRole, parkId: string | null) => {
        const n = uniq();
        const staff = await ds.getRepository(StaffUser).save(ds.getRepository(StaffUser).create({
            email: `st${n}@k.test`, phone: `081${n.slice(-8)}`, firstName: 'Disp', lastName: n.slice(-4),
            passwordHash: 'x', status: StaffStatus.ACTIVE,
        }));
        await ds.getRepository(StaffRoleAssignment).save(ds.getRepository(StaffRoleAssignment).create({
            staffUserId: staff.id, role, parkId, grantedByStaffId: 'ACTOR_OPS',
        }));
        return staff.id;
    };

    /** An active park with a dispatcher on duty and N waiting drivers. */
    const makeReadyPark = async (waitingDrivers = 2) => {
        const n = uniq();
        const park = await ParkService.create(OPS, {
            name: `Park ${n}`, code: `PD-${n.slice(-6)}`, lat: 6.2109, lng: 7.074, city: 'Awka',
        });
        await ParkService.createZone(OPS, park.parkId, {
            name: 'Shed', code: 'BAY-A', kind: ParkZoneKind.STAGING, lat: 6.2109, lng: 7.074,
        });
        const supervisor = await makeStaff(StaffRole.PARK_SUPERVISOR, park.parkId);
        await ParkService.assignSupervisor(OPS, park.parkId, supervisor);
        await ParkService.activate(OPS, park.parkId);

        const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, park.parkId);
        const dispatcherActor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };
        await DispatcherShiftService.open(dispatcherActor, { parkId: park.parkId, lat: 6.2109, lng: 7.074 });

        const drivers: string[] = [];
        for (let i = 0; i < waitingDrivers; i += 1) {
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, park.parkId, driverId);
            const badge = await BadgeService.issue(OPS, { driverId, parkId: park.parkId });
            await BadgeService.activate(OPS, badge.badgeSerial);
            await ParkRosterService.joinQueue(dispatcherActor, park.parkId, driverId);
            drivers.push(driverId);
        }
        return { parkId: park.parkId, dispatcher, dispatcherActor, supervisor, drivers };
    };

    /** A ride sitting in `searching`, as it is when direct dispatch gives up. */
    const makeSearchingRide = async (over: Partial<Ride> = {}) => {
        const n = uniq();
        const passenger = await ds.getRepository(User).save(ds.getRepository(User).create({
            email: `pax${n}@k.test`, phone: `2348012345678`, password: 'x',
            firstName: 'Ada', lastName: 'Pax', role: UserRole.PASSENGER,
        }));
        return ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId: `RIDE-${n}`, passengerId: passenger.id, fare: 1500,
            paymentMode: 'cash', status: 'searching' as any,
            pickupLat: 6.2115, pickupLng: 7.0748,
            pickupAddress: 'Zik Avenue', destinationAddress: 'Amaku',
            ...over,
        } as any));
    };

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS park_dispatch_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'park_dispatch_test',
            entities: [
                Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent,
                ParkDriverRoster, DriverBadge, ParkDispatchJob, DriverProfile, User,
                Wallet, Ride, StaffUser, StaffRoleAssignment, StaffAuditEvent,
            ],
            synchronize: true, dropSchema: true,
        });
        await ds.initialize();

        // Partial unique indexes are migration-only; several tests depend on them.
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_open_pd"
            ON park_dispatch_test.dispatcher_shift ("staffUserId") WHERE status = 'open'`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_roster_live_pd"
            ON park_dispatch_test.park_driver_roster ("parkId", "driverId") WHERE status <> 'removed'`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_live_driver_pd"
            ON park_dispatch_test.driver_badge ("driverId") WHERE status IN ('active','pending_activation')`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_live_code_pd"
            ON park_dispatch_test.driver_badge ("shortCode") WHERE status IN ('active','pending_activation')`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pdj_live_ride_pd"
            ON park_dispatch_test.park_dispatch_job ("rideId") WHERE status IN ('offered','claimed')`);

        const dataSourceModule = await import('../../src/config/data_source');
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true, configurable: true });

        ParkService = (await import('../../src/services/park_service')).ParkService;
        ParkRosterService = (await import('../../src/services/park_roster_service')).ParkRosterService;
        DispatcherShiftService = (await import('../../src/services/dispatcher_shift_service')).DispatcherShiftService;
        DriverPresenceService = (await import('../../src/services/driver_presence_service')).DriverPresenceService;
        BadgeService = (await import('../../src/services/badge_service')).BadgeService;
        ParkDispatchService = (await import('../../src/services/park_dispatch_service')).ParkDispatchService;
        ParkDispatchJobRepository = (await import('../../src/repositories/park_dispatch_job_repository')).ParkDispatchJobRepository;

        ParkDispatchService.setHost(stubHost as any);
        process.env.PARK_DISPATCH_ENABLED = 'true';
    }, 60_000);

    beforeEach(async () => {
        emitted.length = 0;
        // Park selection ranks across EVERY active park, so parks left behind by
        // earlier tests would compete with the one under test — and at identical
        // coordinates the winner is arbitrary. Retiring them first makes each
        // test's own park the only candidate, without weakening the ranking
        // logic being exercised.
        await ds.getRepository(Park).createQueryBuilder()
            .update().set({ status: ParkStatus.INACTIVE }).where('status = :active', { active: ParkStatus.ACTIVE })
            .execute();
        await ds.getRepository(ParkDispatchJob).createQueryBuilder()
            .update().set({ status: ParkJobStatus.CANCELLED, resolvedAt: new Date(), resolutionReason: 'test isolation' })
            .where('status IN (:...live)', { live: [ParkJobStatus.OFFERED, ParkJobStatus.CLAIMED] })
            .execute();
    });

    afterAll(async () => {
        if (originalEnabled == null) delete process.env.PARK_DISPATCH_ENABLED;
        else process.env.PARK_DISPATCH_ENABLED = originalEnabled;
        if (ds?.isInitialized) await ds.destroy();
    });

    // ── the switch ──────────────────────────────────────────────────────
    describe('the feature flag', () => {
        it('offers nothing at all when disabled', async () => {
            process.env.PARK_DISPATCH_ENABLED = 'false';
            try {
                await makeReadyPark();
                const ride = await makeSearchingRide();
                expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(false);
                expect(await ParkDispatchJobRepository.findLiveForRide(ride.rideId)).toBeNull();
            } finally {
                process.env.PARK_DISPATCH_ENABLED = 'true';
            }
        });
    });

    // ── offering ────────────────────────────────────────────────────────
    describe('offering a ride to a park', () => {
        it('creates a job and tells both the park and the passenger', async () => {
            const { parkId } = await makeReadyPark();
            const ride = await makeSearchingRide();

            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(true);

            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            expect(job).not.toBeNull();
            expect(job!.parkId).toBe(parkId);
            expect(job!.status).toBe(ParkJobStatus.OFFERED);
            expect(job!.estimatedTravelMinutes).toBeGreaterThanOrEqual(0);

            expect(emitted.some((e) => e.event === 'park:request_offered')).toBe(true);
            // The compatibility round event that re-arms the passenger app's watchdog.
            const round = emitted.find((e) => e.event === 'ride:dispatch_round');
            expect(round?.payload.dispatchRound).toBe(3);
            expect(emitted.some((e) => e.event === 'ride:park_state')).toBe(true);
        });

        it('leaves the ride SEARCHING — RideStatus gains no park values', async () => {
            await makeReadyPark();
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('searching');
        });

        it('refuses a ride that is no longer searching', async () => {
            await makeReadyPark();
            const ride = await makeSearchingRide({ status: 'accepted' as any });
            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(false);
        });

        it('offers nothing when no park has an assignable driver', async () => {
            const { parkId, drivers, dispatcherActor } = await makeReadyPark(1);
            // Take the only driver out of an assignable state.
            await DriverPresenceService.setState({
                driverId: drivers[0], state: DriverPresenceState.UNAVAILABLE,
                parkId, source: PresenceSource.DISPATCHER, note: 'fuel',
            }, { actor: dispatcherActor });

            const ride = await makeSearchingRide();
            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(false);
        });

        it('offers nothing when the pickup is outside every service radius', async () => {
            await makeReadyPark();
            // ~40km away.
            const ride = await makeSearchingRide({ pickupLat: 6.60, pickupLng: 7.45 } as any);
            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(false);
        });

        it('is idempotent — a second offer returns the existing job', async () => {
            await makeReadyPark();
            const ride = await makeSearchingRide();
            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(true);
            expect(await ParkDispatchService.offerToPark(ride.rideId)).toBe(true);

            const all = await ParkDispatchJobRepository.findAllForRide(ride.rideId);
            expect(all).toHaveLength(1);
        });

        it('ranks the nearer park first', async () => {
            // A far park (still in radius) and a near one; the near one wins.
            const near = await makeReadyPark();
            const farN = uniq();
            const far = await ParkService.create(OPS, {
                name: `Far ${farN}`, code: `FR-${farN.slice(-6)}`, lat: 6.2400, lng: 7.1050,
                serviceRadiusKm: 20,
            });
            await ParkService.createZone(OPS, far.parkId, {
                name: 'Shed', code: 'BAY-A', kind: ParkZoneKind.STAGING, lat: 6.2400, lng: 7.1050,
            });
            const sup = await makeStaff(StaffRole.PARK_SUPERVISOR, far.parkId);
            await ParkService.assignSupervisor(OPS, far.parkId, sup);
            await ParkService.activate(OPS, far.parkId);
            const farDriver = await makeDriver();
            await ParkRosterService.addDriver(OPS, far.parkId, farDriver);
            await DriverPresenceService.setState({
                driverId: farDriver, state: DriverPresenceState.AT_PARK,
                parkId: far.parkId, source: PresenceSource.DISPATCHER,
            });

            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            expect(job!.parkId).toBe(near.parkId);
        });
    });

    // ── claiming ────────────────────────────────────────────────────────
    describe('claiming', () => {
        it('records the response time and moves the passenger message on', async () => {
            const { dispatcherActor } = await makeReadyPark();
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            emitted.length = 0;
            await ParkDispatchService.claim(dispatcherActor, job!.jobId);

            const claimed = await ParkDispatchJobRepository.findById(job!.jobId);
            expect(claimed!.status).toBe(ParkJobStatus.CLAIMED);
            expect(claimed!.claimedByStaffId).toBe(dispatcherActor.staffUserId);
            expect(claimed!.responseTimeMs).toBeGreaterThanOrEqual(0);
            expect(claimed!.assignmentDeadlineAt).not.toBeNull();

            const state = emitted.find((e) => e.event === 'ride:park_state');
            expect(state?.payload.state).toBe('assigning_driver');
        });

        it('only one of two simultaneous claims wins', async () => {
            const { parkId, dispatcherActor } = await makeReadyPark();
            const second = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const secondActor: any = { staffUserId: second, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };
            await DispatcherShiftService.open(secondActor, { parkId, lat: 6.2109, lng: 7.074 });

            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            const results = await Promise.allSettled([
                ParkDispatchService.claim(dispatcherActor, job!.jobId),
                ParkDispatchService.claim(secondActor, job!.jobId),
            ]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        });

        it('refuses a dispatcher with no open shift', async () => {
            const { parkId, dispatcherActor } = await makeReadyPark();
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            await DispatcherShiftService.close(dispatcherActor, {});
            await expect(ParkDispatchService.claim(dispatcherActor, job!.jobId))
                .rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a dispatcher from a different park', async () => {
            await makeReadyPark();
            const other = await makeReadyPark();
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            await expect(ParkDispatchService.claim(other.dispatcherActor, job!.jobId))
                .rejects.toMatchObject({ statusCode: 403 });
        });
    });

    // ── assignment ──────────────────────────────────────────────────────
    describe('assignment', () => {
        const setup = async (driverOver: Partial<DriverProfile> = {}) => {
            const park = await makeReadyPark(0);
            const driverId = await makeDriver(driverOver);
            await ParkRosterService.addDriver(OPS, park.parkId, driverId);
            const badge = await BadgeService.issue(OPS, { driverId, parkId: park.parkId });
            await BadgeService.activate(OPS, badge.badgeSerial);
            await ParkRosterService.joinQueue(park.dispatcherActor, park.parkId, driverId);

            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);
            return { ...park, driverId, ride, jobId: job!.jobId };
        };

        it('makes the ride ACCEPTED and owned by the driver', async () => {
            const { dispatcherActor, driverId, ride, jobId } = await setup();

            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC);

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('accepted');
            expect(fresh!.driverId).toBe(driverId);
            // Provenance, written by the same statement that claimed the ride.
            expect(fresh!.dispatchMode).toBe('park');
            expect(fresh!.assignmentMode).toBe('electronic');
            expect(fresh!.parkJobId).toBe(jobId);
        });

        it('records the job as assigned with its timings', async () => {
            const { dispatcherActor, driverId, jobId } = await setup();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC);

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.ASSIGNED);
            expect(job!.assignedDriverId).toBe(driverId);
            expect(job!.assignmentTimeMs).toBeGreaterThanOrEqual(0);
            expect(job!.passengerWaitMs).toBeGreaterThanOrEqual(0);
        });

        it('supports VERBAL assignment for a feature-phone driver', async () => {
            const { dispatcherActor, driverId, ride, jobId } = await setup({ deviceCapability: 'feature_phone' } as any);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.VERBAL);

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            // The ride is identical in every respect except how the driver was
            // told. Same status, same ownership, same lifecycle from here.
            expect(String(fresh!.status)).toBe('accepted');
            expect(fresh!.driverId).toBe(driverId);
            expect(fresh!.assignmentMode).toBe('verbal');
        });

        it('takes the assigned driver out of the queue', async () => {
            const { dispatcherActor, parkId, driverId, jobId } = await setup();
            expect(await ParkRosterService.queue(parkId)).toHaveLength(1);

            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC);
            expect(await ParkRosterService.queue(parkId)).toHaveLength(0);
        });

        it('refuses a driver who is not in an assignable presence state', async () => {
            const { dispatcherActor, parkId, driverId, jobId } = await setup();
            await DriverPresenceService.setState({
                driverId, state: DriverPresenceState.UNAVAILABLE, parkId,
                source: PresenceSource.DISPATCHER, note: 'gone home',
            }, { actor: dispatcherActor });

            await expect(ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC))
                .rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a driver who is not on this park roster', async () => {
            const { dispatcherActor, jobId } = await setup();
            const stranger = await makeDriver();
            await expect(ParkDispatchService.assignDriver(dispatcherActor, jobId, stranger, ParkAssignmentMode.ELECTRONIC))
                .rejects.toMatchObject({ statusCode: 404 });
        });

        it('refuses a wallet-blocked driver, naming the amount', async () => {
            const { dispatcherActor, driverId, jobId } = await setup();
            await ds.getRepository(Wallet).update({ userId: driverId }, { driverCommissionDebt: 5000 });

            await expect(ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC))
                .rejects.toThrow(/₦5,000|owes/i);
        });

        it('refuses assignment before the job is claimed', async () => {
            const park = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            await expect(ParkDispatchService.assignDriver(
                park.dispatcherActor, job!.jobId, park.drivers[0], ParkAssignmentMode.ELECTRONIC,
            )).rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a dispatcher who did not claim it', async () => {
            const { parkId, jobId, driverId } = await setup();
            const other = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const otherActor: any = { staffUserId: other, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };
            await DispatcherShiftService.open(otherActor, { parkId, lat: 6.2109, lng: 7.074 });

            await expect(ParkDispatchService.assignDriver(otherActor, jobId, driverId, ParkAssignmentMode.ELECTRONIC))
                .rejects.toMatchObject({ statusCode: 403 });
        });

        it('audits the assignment against the dispatcher', async () => {
            const { dispatcherActor, driverId, jobId } = await setup();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverId, ParkAssignmentMode.VERBAL);

            const audit = await ds.getRepository(StaffAuditEvent)
                .findOne({ where: { resourceId: jobId, action: 'PARK_JOB_ASSIGNED' } });
            expect(audit!.actorStaffUserId).toBe(dispatcherActor.staffUserId);
            expect(audit!.driverId).toBe(driverId);
            expect((audit!.metadata as any).assignmentMode).toBe('verbal');
        });
    });

    // ── the race that matters ───────────────────────────────────────────
    describe('a direct driver winning during the park phase', () => {
        it('wins the ride, and the park assignment is refused', async () => {
            const park = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);

            // A smartphone driver accepts directly — the same conditional
            // UPDATE the real ride:accept performs.
            const directDriver = await makeDriver();
            await ds.getRepository(Ride).createQueryBuilder()
                .update().set({ driverId: directDriver, status: 'accepted' as any })
                .where('"rideId" = :rideId AND status = :status', { rideId: ride.rideId, status: 'searching' })
                .execute();

            await expect(ParkDispatchService.assignDriver(
                park.dispatcherActor, job!.jobId, park.drivers[0], ParkAssignmentMode.ELECTRONIC,
            )).rejects.toMatchObject({ statusCode: 409 });

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(fresh!.driverId).toBe(directDriver);
            // Untouched by the park path — it never got that far.
            expect(fresh!.dispatchMode).toBeNull();
        });

        it('cancelForRide clears the dispatcher\'s screen', async () => {
            const park = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);

            await ParkDispatchService.cancelForRide(ride.rideId, 'taken_by_direct_driver');

            expect(await ParkDispatchJobRepository.findLiveForRide(ride.rideId)).toBeNull();
            expect(emitted.some((e) => e.event === 'park:job_cancelled')).toBe(true);
        });
    });

    // ── skip / reject / escalate ────────────────────────────────────────
    describe('the other three actions', () => {
        const claimed = async () => {
            const park = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);
            return { ...park, ride, jobId: job!.jobId };
        };

        it('skip requires a reason and fails the ride when no park is left', async () => {
            const { dispatcherActor, jobId, ride } = await claimed();
            await expect(ParkDispatchService.skip(dispatcherActor, jobId, '')).rejects.toMatchObject({ statusCode: 400 });

            await ParkDispatchService.skip(dispatcherActor, jobId, 'nobody available');

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.SKIPPED);
            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('failed');
        });

        it('reject resolves the job and fails the ride', async () => {
            const { dispatcherActor, jobId, ride } = await claimed();
            await ParkDispatchService.reject(dispatcherActor, jobId, 'destination not served from here');

            expect((await ParkDispatchJobRepository.findById(jobId))!.status).toBe(ParkJobStatus.REJECTED);
            expect(String((await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId }))!.status)).toBe('failed');
        });

        it('escalate does NOT fail the ride — it keeps searching', async () => {
            // Escalation means "somebody look at this", never "this is over".
            const { dispatcherActor, jobId, ride } = await claimed();
            await ParkDispatchService.escalate(dispatcherActor, jobId, 'passenger unreachable, needs support');

            expect((await ParkDispatchJobRepository.findById(jobId))!.status).toBe(ParkJobStatus.ESCALATED);
            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('searching');
        });

        it('an already-resolved job cannot be resolved twice', async () => {
            const { dispatcherActor, jobId } = await claimed();
            await ParkDispatchService.skip(dispatcherActor, jobId, 'nobody available');
            await expect(ParkDispatchService.skip(dispatcherActor, jobId, 'again')).rejects.toMatchObject({ statusCode: 409 });
        });
    });

    // ── expiry ──────────────────────────────────────────────────────────
    describe('expiry', () => {
        it('expires an unclaimed offer and fails the ride', async () => {
            await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);

            const swept = await ParkDispatchService.sweepExpired(new Date(Date.now() + 60_000));
            expect(swept).toBeGreaterThanOrEqual(1);

            expect((await ParkDispatchJobRepository.findById(job!.jobId))!.status).toBe(ParkJobStatus.EXPIRED);
            expect(String((await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId }))!.status)).toBe('failed');
        });

        it('expires a claimed job whose assignment window elapsed', async () => {
            const park = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);

            await ParkDispatchService.sweepExpired(new Date(Date.now() + 120_000));
            expect((await ParkDispatchJobRepository.findById(job!.jobId))!.status).toBe(ParkJobStatus.EXPIRED);
        });

        it('leaves a job inside its window alone', async () => {
            await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);

            await ParkDispatchService.sweepExpired(new Date());
            expect(await ParkDispatchJobRepository.findLiveForRide(ride.rideId)).not.toBeNull();
        });
    });

    // ── the dispatcher's queue ──────────────────────────────────────────
    describe('the queue card', () => {
        it('carries every field the dispatcher needs, with contact masked', async () => {
            const { parkId } = await makeReadyPark(1);
            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);

            const [card] = await ParkDispatchService.queueForPark(parkId);
            expect(card.pickupAddress).toBe('Zik Avenue');
            expect(card.destinationAddress).toBe('Amaku');
            expect(card.passengerName).toBe('Ada');
            expect(card.estimatedFare).toBe(1500);
            expect(card.waitingSeconds).toBeGreaterThanOrEqual(0);
            expect(card.priorityLabel).toBeTruthy();
            expect(card.parksTried).toBe(1);
            expect(card.expiresAt).toBeTruthy();

            // Masked, never dialable. A dispatcher sourcing a driver has no need
            // to phone a passenger who never asked to hear from them.
            expect(card.passengerPhoneMasked).toBe('0801••••678');
            expect(JSON.stringify(card)).not.toContain('08012345678');
        });

        it('orders by priority, then by how long the passenger has waited', async () => {
            const { parkId } = await makeReadyPark(2);
            const old = await makeSearchingRide();
            await ds.getRepository(Ride).update({ rideId: old.rideId },
                { createdAt: new Date(Date.now() - 10 * 60_000) } as any);
            const recent = await makeSearchingRide();

            await ParkDispatchService.offerToPark(old.rideId);
            await ParkDispatchService.offerToPark(recent.rideId);

            const queue = await ParkDispatchService.queueForPark(parkId);
            expect(queue[0].rideId).toBe(old.rideId);
            expect(queue[0].priority).toBeGreaterThan(queue[1].priority);
        });
    });

    // ── monitoring ──────────────────────────────────────────────────────
    describe('monitoring metrics', () => {
        it('computes success rate and response times over the window', async () => {
            const park = await makeReadyPark(0);
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, park.parkId, driverId);
            const badge = await BadgeService.issue(OPS, { driverId, parkId: park.parkId });
            await BadgeService.activate(OPS, badge.badgeSerial);
            await ParkRosterService.joinQueue(park.dispatcherActor, park.parkId, driverId);

            const ride = await makeSearchingRide();
            await ParkDispatchService.offerToPark(ride.rideId);
            const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
            await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);
            await ParkDispatchService.assignDriver(park.dispatcherActor, job!.jobId, driverId, ParkAssignmentMode.ELECTRONIC);

            const metrics = await ParkDispatchJobRepository.metrics(new Date(Date.now() - 3600_000), park.parkId);
            expect(metrics.offered).toBe(1);
            expect(metrics.assigned).toBe(1);
            expect(metrics.assignmentSuccessRatePct).toBe(100);
            expect(metrics.medianResponseTimeMs).not.toBeNull();
            expect(metrics.avgPassengerWaitMs).not.toBeNull();

            const stats = await ParkDispatchJobRepository.dispatcherStats(new Date(Date.now() - 3600_000), park.parkId);
            expect(stats).toHaveLength(1);
            expect(Number(stats[0].assigned)).toBe(1);
        });
    });
});
