/**
 * Assignment timeout, driver acceptance and the recommendation ranking.
 *
 * The property under test throughout: a ride must never become stuck because a
 * driver disappeared after being chosen. Every path out of PENDING_ACCEPTANCE —
 * accept, decline, timeout, undeliverable offer — has to return the ride to
 * somebody who can act on it.
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
import { DispatchEvent } from '../../src/models/DispatchEvent';
import { StaffUser, StaffStatus } from '../../src/models/StaffUser';
import { StaffRoleAssignment } from '../../src/models/StaffRoleAssignment';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { StaffRole } from '../../src/config/staff_permissions';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
    // eslint-disable-next-line no-console
    console.warn('[integration] TEST_DATABASE_URL not set — skipping assignment timeout tests.');
}

describeDb('park assignment timeout (database)', () => {
    let ds: DataSource;
    let ParkService: typeof import('../../src/services/park_service').ParkService;
    let ParkRosterService: typeof import('../../src/services/park_roster_service').ParkRosterService;
    let DispatcherShiftService: typeof import('../../src/services/dispatcher_shift_service').DispatcherShiftService;
    let DriverPresenceService: typeof import('../../src/services/driver_presence_service').DriverPresenceService;
    let BadgeService: typeof import('../../src/services/badge_service').BadgeService;
    let ParkDispatchService: typeof import('../../src/services/park_dispatch_service').ParkDispatchService;
    let ParkDispatchJobRepository: typeof import('../../src/repositories/park_dispatch_job_repository').ParkDispatchJobRepository;
    let DriverRecommendationService: typeof import('../../src/services/driver_recommendation_service').DriverRecommendationService;

    const OPS: any = { staffUserId: 'ACTOR_OPS', roles: [StaffRole.OPERATIONS_ADMIN], isLegacy: false };
    let seq = 0;
    const uniq = () => `${Date.now()}${++seq}`;
    const emitted: Array<{ event: string; payload: any }> = [];

    /** Controls whether the simulated driver device can be reached. */
    let offerDeliverable = true;

    const stubHost = {
        assignDriver: async (a: any) => {
            const result = await ds.getRepository(Ride).createQueryBuilder()
                .update()
                .set({
                    driverId: a.driverId, status: 'accepted' as any, dispatchMode: 'park',
                    parkId: a.parkId, parkJobId: a.parkJobId, assignmentMode: a.assignmentMode,
                } as any)
                .where('"rideId" = :rideId AND status = :status', { rideId: a.rideId, status: 'searching' })
                .execute();
            return (result.affected ?? 0) > 0
                ? { ok: true as const }
                : { ok: false as const, code: 'RIDE_ALREADY_TAKEN', message: 'This ride is no longer available.' };
        },
        offerRideToDriver: async () => offerDeliverable,
        emitToRide: (_r: string, event: string, payload: any) => emitted.push({ event, payload }),
        emitToPark: (_p: string, event: string, payload: any) => emitted.push({ event, payload }),
        emitToAdmin: (event: string, payload: any) => emitted.push({ event, payload }),
        notifyPassenger: () => {},
    };

    const makeDriver = async (over: Partial<DriverProfile> = {}) => {
        const n = uniq();
        const user = await ds.getRepository(User).save(ds.getRepository(User).create({
            email: `d${n}@k.test`, phone: `080${n.slice(-8)}`, password: 'x',
            firstName: 'Drv', lastName: n.slice(-4), role: UserRole.DRIVER,
        }));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: user.id, firstName: 'Drv', lastName: n.slice(-4),
            vehiclePlate: `EN-${n.slice(-3)}`, vehicleModel: 'Keke',
            status: DriverStatus.APPROVED, photoUrl: 'p.jpg', unitNumber: `U${n.slice(-3)}`,
            deviceCapability: 'smartphone', ...over,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({ userId: user.id }));
        return user.id;
    };

    const makeStaff = async (role: StaffRole, parkId: string | null) => {
        const n = uniq();
        const staff = await ds.getRepository(StaffUser).save(ds.getRepository(StaffUser).create({
            email: `s${n}@k.test`, phone: `081${n.slice(-8)}`, firstName: 'Disp', lastName: n.slice(-4),
            passwordHash: 'x', status: StaffStatus.ACTIVE,
        }));
        await ds.getRepository(StaffRoleAssignment).save(ds.getRepository(StaffRoleAssignment).create({
            staffUserId: staff.id, role, parkId, grantedByStaffId: 'ACTOR_OPS',
        }));
        return staff.id;
    };

    /** An active park, a dispatcher on duty, and N queued drivers. */
    const makeReadyPark = async (drivers = 2, driverOver: Partial<DriverProfile> = {}) => {
        const n = uniq();
        const park = await ParkService.create(OPS, {
            name: `Park ${n}`, code: `PT-${n.slice(-6)}`, lat: 6.2109, lng: 7.074,
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

        const driverIds: string[] = [];
        for (let i = 0; i < drivers; i += 1) {
            const driverId = await makeDriver(driverOver);
            await ParkRosterService.addDriver(OPS, park.parkId, driverId);
            const badge = await BadgeService.issue(OPS, { driverId, parkId: park.parkId });
            await BadgeService.activate(OPS, badge.badgeSerial);
            await ParkRosterService.joinQueue(dispatcherActor, park.parkId, driverId);
            driverIds.push(driverId);
        }
        return { parkId: park.parkId, dispatcherActor, driverIds };
    };

    const makeSearchingRide = async () => {
        const n = uniq();
        const passenger = await ds.getRepository(User).save(ds.getRepository(User).create({
            email: `p${n}@k.test`, phone: '2348012345678', password: 'x',
            firstName: 'Ada', lastName: 'Pax', role: UserRole.PASSENGER,
        }));
        return ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId: `RIDE-${n}`, passengerId: passenger.id, fare: 1500,
            paymentMode: 'cash', status: 'searching' as any,
            pickupLat: 6.2115, pickupLng: 7.0748,
            pickupAddress: 'Zik Avenue', destinationAddress: 'Amaku',
        } as any));
    };

    /** A ride carried all the way to a CLAIMED job. */
    const claimedJob = async (drivers = 1, driverOver: Partial<DriverProfile> = {}) => {
        const park = await makeReadyPark(drivers, driverOver);
        const ride = await makeSearchingRide();
        await ParkDispatchService.offerToPark(ride.rideId);
        const job = await ParkDispatchJobRepository.findLiveForRide(ride.rideId);
        await ParkDispatchService.claim(park.dispatcherActor, job!.jobId);
        return { ...park, ride, jobId: job!.jobId };
    };

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS park_timeout_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'park_timeout_test',
            entities: [
                Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent,
                ParkDriverRoster, DriverBadge, ParkDispatchJob, DriverProfile, User,
                Wallet, Ride, DispatchEvent, StaffUser, StaffRoleAssignment, StaffAuditEvent,
            ],
            synchronize: true, dropSchema: true,
        });
        await ds.initialize();

        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_open_to"
            ON park_timeout_test.dispatcher_shift ("staffUserId") WHERE status = 'open'`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pdj_live_to"
            ON park_timeout_test.park_dispatch_job ("rideId")
            WHERE status IN ('offered','claimed','pending_acceptance')`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_live_driver_to"
            ON park_timeout_test.driver_badge ("driverId") WHERE status IN ('active','pending_activation')`);

        const dataSourceModule = await import('../../src/config/data_source');
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true, configurable: true });

        ParkService = (await import('../../src/services/park_service')).ParkService;
        ParkRosterService = (await import('../../src/services/park_roster_service')).ParkRosterService;
        DispatcherShiftService = (await import('../../src/services/dispatcher_shift_service')).DispatcherShiftService;
        DriverPresenceService = (await import('../../src/services/driver_presence_service')).DriverPresenceService;
        BadgeService = (await import('../../src/services/badge_service')).BadgeService;
        ParkDispatchService = (await import('../../src/services/park_dispatch_service')).ParkDispatchService;
        ParkDispatchJobRepository = (await import('../../src/repositories/park_dispatch_job_repository')).ParkDispatchJobRepository;
        DriverRecommendationService = (await import('../../src/services/driver_recommendation_service')).DriverRecommendationService;

        ParkDispatchService.setHost(stubHost as any);
        process.env.PARK_DISPATCH_ENABLED = 'true';
    }, 60_000);

    beforeEach(async () => {
        emitted.length = 0;
        offerDeliverable = true;
        await ds.getRepository(Park).createQueryBuilder()
            .update().set({ status: ParkStatus.INACTIVE }).where('status = :a', { a: ParkStatus.ACTIVE }).execute();
        await ds.getRepository(ParkDispatchJob).createQueryBuilder()
            .update().set({ status: ParkJobStatus.CANCELLED, resolvedAt: new Date() })
            .where('status IN (:...live)', { live: [ParkJobStatus.OFFERED, ParkJobStatus.CLAIMED, ParkJobStatus.PENDING_ACCEPTANCE] })
            .execute();
    });

    afterAll(async () => {
        delete process.env.PARK_DISPATCH_ENABLED;
        if (ds?.isInitialized) await ds.destroy();
    });

    // ── smartphone: offer and wait ──────────────────────────────────────
    describe('smartphone assignment', () => {
        it('does NOT make the ride accepted until the driver answers', async () => {
            const { dispatcherActor, jobId, driverIds, ride } = await claimedJob();

            const result = await ParkDispatchService.assignDriver(
                dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            expect(result.pending).toBe(true);
            expect(result.expiresAt).toBeTruthy();

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.PENDING_ACCEPTANCE);
            expect(job!.pendingDriverId).toBe(driverIds[0]);

            // The passenger's ride is untouched until the driver agrees.
            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('searching');
            expect(fresh!.driverId).toBeNull();
        });

        it('hands the job straight back when the offer reaches no device', async () => {
            // Burning the whole window on an offer nobody will see costs the
            // passenger time for nothing.
            offerDeliverable = false;
            const { dispatcherActor, jobId, driverIds } = await claimedJob();

            await expect(ParkDispatchService.assignDriver(
                dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC,
            )).rejects.toThrow(/could not be reached/i);

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.CLAIMED);
            expect(job!.declinedDriverIds).toContain(driverIds[0]);
        });

        it('completes when the driver accepts', async () => {
            const { dispatcherActor, jobId, driverIds, ride } = await claimedJob();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            // What ride:accept does: the context lookup, then the ride flip,
            // then closing the job's books.
            const context = await ParkDispatchService.pendingContextFor(ride.rideId, driverIds[0]);
            expect(context).not.toBeNull();
            expect(context!.jobId).toBe(jobId);

            await stubHost.assignDriver({
                rideId: ride.rideId, driverId: driverIds[0], parkId: context!.parkId,
                parkJobId: context!.jobId, assignmentMode: 'electronic',
            });
            await ParkDispatchService.completePendingAssignment(ride.rideId, driverIds[0]);

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.ASSIGNED);
            expect(job!.assignedDriverId).toBe(driverIds[0]);

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('accepted');
            expect(fresh!.dispatchMode).toBe('park');
        });

        it('returns no pending context for an ordinary direct acceptance', async () => {
            const ride = await makeSearchingRide();
            const driverId = await makeDriver();
            expect(await ParkDispatchService.pendingContextFor(ride.rideId, driverId)).toBeNull();
        });
    });

    // ── decline and timeout ─────────────────────────────────────────────
    describe('a driver who does not go', () => {
        it('a decline returns the job to the dispatcher and remembers who said no', async () => {
            const { dispatcherActor, jobId, driverIds, ride } = await claimedJob();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'driver_declined');

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.CLAIMED);
            expect(job!.pendingDriverId).toBeNull();
            expect(job!.declineCount).toBe(1);
            expect(job!.declinedDriverIds).toContain(driverIds[0]);

            // The ride is still searching — the passenger is not told anything.
            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('searching');
            expect(emitted.some((e) => e.event === 'park:job_driver_declined')).toBe(true);
        });

        it('a timeout does the same thing as a decline', async () => {
            const { dispatcherActor, jobId, driverIds } = await claimedJob();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            const swept = await ParkDispatchService.sweepPendingOffers(new Date(Date.now() + 60_000));
            expect(swept).toBe(1);

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.CLAIMED);
            expect(job!.declinedDriverIds).toContain(driverIds[0]);
        });

        it('leaves an offer inside its window alone', async () => {
            const { dispatcherActor, jobId, driverIds } = await claimedJob();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            expect(await ParkDispatchService.sweepPendingOffers(new Date())).toBe(0);
            expect((await ParkDispatchJobRepository.findById(jobId))!.status).toBe(ParkJobStatus.PENDING_ACCEPTANCE);
        });

        it('the dispatcher can assign somebody else after a decline', async () => {
            const { dispatcherActor, jobId, driverIds, ride } = await claimedJob(2);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);
            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'driver_declined');

            const second = await ParkDispatchService.assignDriver(
                dispatcherActor, jobId, driverIds[1], ParkAssignmentMode.ELECTRONIC);
            expect(second.pending).toBe(true);
            expect((await ParkDispatchJobRepository.findById(jobId))!.pendingDriverId).toBe(driverIds[1]);
        });

        it('a stale decline cannot clobber a fresh offer to another driver', async () => {
            const { dispatcherActor, jobId, driverIds, ride } = await claimedJob(2);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);
            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'driver_declined');
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[1], ParkAssignmentMode.ELECTRONIC);

            // The first driver's decline arrives late — it must be ignored.
            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'late_decline');

            const job = await ParkDispatchJobRepository.findById(jobId);
            expect(job!.status).toBe(ParkJobStatus.PENDING_ACCEPTANCE);
            expect(job!.pendingDriverId).toBe(driverIds[1]);
        });

        it('a declined driver goes back to WAITING, not offline', async () => {
            const { dispatcherActor, jobId, driverIds, ride, parkId } = await claimedJob();
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);
            await DriverPresenceService.setState({
                driverId: driverIds[0], state: DriverPresenceState.ASSIGNED,
                parkId, source: PresenceSource.SYSTEM,
            }, {});

            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'driver_declined');

            // They are still standing in the park.
            expect((await DriverPresenceService.get(driverIds[0])).state).toBe(DriverPresenceState.WAITING);
        });
    });

    // ── feature phone ───────────────────────────────────────────────────
    describe('feature-phone assignment', () => {
        it('is immediate — the dispatcher already heard the driver agree', async () => {
            const { dispatcherActor, jobId, driverIds, ride } =
                await claimedJob(1, { deviceCapability: 'feature_phone' } as any);

            const result = await ParkDispatchService.assignDriver(
                dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.VERBAL);

            expect(result.pending).toBe(false);
            expect((await ParkDispatchJobRepository.findById(jobId))!.status).toBe(ParkJobStatus.ASSIGNED);

            const fresh = await ds.getRepository(Ride).findOneBy({ rideId: ride.rideId });
            expect(String(fresh!.status)).toBe('accepted');
            expect(fresh!.assignmentMode).toBe('verbal');
        });

        it('never enters the pending state', async () => {
            const { dispatcherActor, jobId, driverIds } =
                await claimedJob(1, { deviceCapability: 'feature_phone' } as any);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.VERBAL);
            expect((await ParkDispatchJobRepository.findById(jobId))!.pendingDriverId).toBeNull();
        });

        /**
         * Regression.
         *
         * Assignment did not move the driver out of WAITING, so the board kept
         * showing them as "waiting now" after they had been given a trip and
         * the ranking kept recommending them. The dispatcher would confirm the
         * sheet and only then be told "finish your current ride first" — on the
         * verbal path, AFTER they had already told the driver it was theirs.
         *
         * Found by the acceptance run assigning the same driver twice in a row.
         */
        it('takes the assigned driver off the board', async () => {
            const { dispatcherActor, jobId, driverIds, parkId } =
                await claimedJob(1, { deviceCapability: 'feature_phone' } as any);

            const before = await DriverPresenceService.get(driverIds[0]);
            expect(before.state).toBe(DriverPresenceState.WAITING);

            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.VERBAL);

            const after = await DriverPresenceService.get(driverIds[0]);
            expect(after.state).toBe(DriverPresenceState.ASSIGNED);

            // And the board agrees: they are no longer offered for new work.
            const assignable = await ParkDispatchService.assignableDrivers(parkId);
            expect(assignable.filter((d) => d.assignable).map((d) => d.driverId))
                .not.toContain(driverIds[0]);
        });
    });

    // ── recommendation ranking ──────────────────────────────────────────
    describe('driver recommendation', () => {
        it('puts exactly one recommended driver at the top', async () => {
            const { parkId, jobId } = await claimedJob(3);
            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);

            expect(ranked.length).toBeGreaterThanOrEqual(3);
            expect(ranked[0].recommended).toBe(true);
            expect(ranked.filter((d) => d.recommended)).toHaveLength(1);
            expect(ranked[0].badges[0]).toBe('recommended');
        });

        it('respects queue order among otherwise equal drivers', async () => {
            const { parkId, jobId, driverIds } = await claimedJob(3);
            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);
            // The recommendation agrees with the fairness rules rather than
            // quietly competing with them.
            expect(ranked[0].driverId).toBe(driverIds[0]);
        });

        it('ranks an unassignable driver last with a reason, not hidden', async () => {
            const { parkId, jobId, driverIds } = await claimedJob(2);
            await ds.getRepository(Wallet).update({ userId: driverIds[0] }, { driverCommissionDebt: 5000 });

            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);
            const blocked = ranked.find((d) => d.driverId === driverIds[0])!;

            expect(blocked.assignable).toBe(false);
            expect(blocked.score).toBe(0);
            expect(blocked.badges).toContain('wallet_blocked');
            expect(blocked.reason).toMatch(/owes/i);
            expect(ranked.indexOf(blocked)).toBeGreaterThan(0);
        });

        it('demotes and labels a driver who already declined this ride', async () => {
            const { parkId, jobId, driverIds, dispatcherActor, ride } = await claimedJob(2);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);
            await ParkDispatchService.handleDriverDecline(ride.rideId, driverIds[0], 'driver_declined');

            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);
            const declined = ranked.find((d) => d.driverId === driverIds[0])!;

            expect(declined.assignable).toBe(false);
            expect(declined.badges).toContain('declined_this_ride');
            // Repeating a rejected suggestion is the fastest way to make a
            // recommendation untrusted.
            expect(ranked[0].driverId).not.toBe(driverIds[0]);
        });

        it('labels device capability so the dispatcher sees it before tapping', async () => {
            const { parkId, jobId } = await claimedJob(1, { deviceCapability: 'feature_phone' } as any);
            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);

            expect(ranked[0].badges).toContain('feature_phone');
            expect(ranked[0].requiresVerbalAssignment).toBe(true);
        });

        it('gives a driver with no history a neutral acceptance score', async () => {
            const { parkId, jobId } = await claimedJob(1);
            const ranked = await ParkDispatchService.rankedDriversForJob(jobId, parkId);
            // A first park offer must not be penalised for having no history.
            expect(ranked[0].acceptanceRate).toBeNull();
            expect(ranked[0].score).toBeGreaterThan(0);
        });
    });

    // ── the dashboard ───────────────────────────────────────────────────
    describe('dashboard payload', () => {
        it('reports every counter the workspace renders', async () => {
            const { parkId, dispatcherActor } = await claimedJob(2);
            const { DispatcherDashboardService } = await import('../../src/services/dispatcher_dashboard_service');

            const d = await DispatcherDashboardService.build(parkId, dispatcherActor.staffUserId);

            for (const key of [
                'queueDepth', 'activeAssignments', 'awaitingDriverResponse', 'waitingPassengers',
                'availableDrivers', 'driversOnTrips', 'driversUnavailable', 'driversOffline',
                'parkUtilisationPct', 'jobsAssignedToday', 'jobsCompletedToday',
                'failedAssignmentsToday', 'escalatedJobsToday',
            ]) {
                expect(d.counters).toHaveProperty(key);
            }
            expect(d.counters.queueDepth).toBe(1);
            expect(d.counters.activeAssignments).toBe(1);
            expect(d.drivers.length).toBeGreaterThan(0);
            expect(d.parkHealth.parkId).toBe(parkId);
        });

        it('states plainly that a dispatcher cannot advance a ride', async () => {
            const { parkId, dispatcherActor } = await claimedJob(1);
            const { DispatcherDashboardService } = await import('../../src/services/dispatcher_dashboard_service');
            const d = await DispatcherDashboardService.build(parkId, dispatcherActor.staffUserId);
            expect(d.capabilities.canAdvanceRideLifecycle).toBe(false);
        });

        it('counts a pending offer as awaiting the driver', async () => {
            const { parkId, dispatcherActor, jobId, driverIds } = await claimedJob(1);
            await ParkDispatchService.assignDriver(dispatcherActor, jobId, driverIds[0], ParkAssignmentMode.ELECTRONIC);

            const { DispatcherDashboardService } = await import('../../src/services/dispatcher_dashboard_service');
            const d = await DispatcherDashboardService.build(parkId, dispatcherActor.staffUserId);
            expect(d.counters.awaitingDriverResponse).toBe(1);
        });
    });
});
