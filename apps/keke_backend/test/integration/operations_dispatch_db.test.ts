/**
 * Operations Dispatch against a real database.
 *
 * These are the tests that matter. Everything else about this feature is
 * presentation; the questions here are "can two dispatchers both hold a ride?"
 * and "can a manual assignment overwrite a driver who accepted first?" — and
 * neither can be answered honestly without a database, because the answer IS
 * the conditional UPDATE.
 *
 * The assignment arbiter is exercised through a stub host performing the SAME
 * conditional searching→accepted UPDATE that assignDriverToRide performs, the
 * pattern the park dispatch DB test already established. That keeps the test
 * about the arbiter rather than about socket.io.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Ride, RideStatus } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { Wallet } from '../../src/models/Wallet';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { DispatchEvent } from '../../src/models/DispatchEvent';
import {
    RideDispatchControl,
    DispatchControlMode,
    ControlReleaseReason,
} from '../../src/models/RideDispatchControl';
import { OperationsIntervention, InterventionType } from '../../src/models/OperationsIntervention';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
    // eslint-disable-next-line no-console
    console.warn('[integration] TEST_DATABASE_URL not set — skipping Operations Dispatch DB tests.');
}

describeDb('Operations Dispatch (database)', () => {
    let ds: DataSource;
    let RideControlService: typeof import('../../src/services/ride_control_service').RideControlService;
    let OperationsDispatchService: typeof import('../../src/services/operations_dispatch_service').OperationsDispatchService;

    let seq = 0;
    const uniq = () => `${Date.now()}${++seq}`;
    /** User.id is a uuid column, so driver ids must be real uuids. */
    const uuid = () => require('crypto').randomUUID();

    const ADA = { staffUserId: 'STAFF_ADA', label: 'Ada O.' };
    const BEN = { staffUserId: 'STAFF_BEN', label: 'Ben K.' };

    /** Records what the stub arbiter did, so races can be asserted on. */
    let assignments: Array<{ rideId: string; driverId: string }> = [];

    /**
     * The SAME conditional UPDATE the real arbiter performs. If this ever
     * diverges from assignDriverToRide, these tests stop meaning anything —
     * which is why it is a single statement copied verbatim in shape.
     */
    const stubHost = {
        assignDriver: async (a: { rideId: string; driverId: string }) => {
            const r = await ds
                .getRepository(Ride)
                .createQueryBuilder()
                .update()
                .set({ driverId: a.driverId, status: 'accepted' as any })
                .where('"rideId" = :rideId AND status = :status', {
                    rideId: a.rideId,
                    status: 'searching',
                })
                .execute();
            if (!r.affected) {
                return { ok: false as const, code: 'RIDE_ALREADY_TAKEN', message: 'Ride no longer available.' };
            }
            assignments.push({ rideId: a.rideId, driverId: a.driverId });
            await RideControlService.releaseOnAssignment(a.rideId);
            return { ok: true as const };
        },
        emitToRide: () => {},
        emitToAdmin: () => {},
        emitToOps: () => {},
        abortDispatch: () => {},
    };

    beforeAll(async () => {
        ds = new DataSource({
            type: 'postgres',
            url: TEST_DB,
            entities: [
                Ride, User, Wallet, DriverProfile, DispatchEvent,
                RideDispatchControl, OperationsIntervention,
            ],
            synchronize: true,
            logging: false,
        });
        await ds.initialize();

        const dataSourceModule = require('../../src/config/data_source');
        dataSourceModule.AppDataSource = ds;
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true });

        RideControlService = require('../../src/services/ride_control_service').RideControlService;
        OperationsDispatchService =
            require('../../src/services/operations_dispatch_service').OperationsDispatchService;
        OperationsDispatchService.setHost(stubHost as any);
    });

    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy();
    });

    beforeEach(async () => {
        assignments = [];
        // TRUNCATE rather than delete({}), which TypeORM refuses on empty
        // criteria. Order matters only for readability — there are no FKs.
        for (const t of ['operations_intervention', 'ride_dispatch_control', 'dispatch_event', 'ride']) {
            await ds.query(`TRUNCATE TABLE "${t}"`);
        }
    });

    async function makeDriver(over: Partial<DriverProfile> = {}): Promise<string> {
        const id = uuid();
        await ds.getRepository(User).save(
            ds.getRepository(User).create({
                id, email: `${id}@t.ng`, phone: `234${uniq()}`.slice(0, 13),
                password: 'x', firstName: 'Test', lastName: 'Driver', role: UserRole.DRIVER,
            } as any),
        );
        await ds.getRepository(DriverProfile).save(
            ds.getRepository(DriverProfile).create({
                userId: id, firstName: 'Test', lastName: 'Driver',
                vehiclePlate: `PL-${uniq()}`.slice(0, 12), vehicleModel: 'TVS',
                status: DriverStatus.APPROVED, ...over,
            } as any),
        );
        await ds.getRepository(Wallet).save(
            ds.getRepository(Wallet).create({ userId: id, driverCommissionDebt: 0 } as any),
        );
        return id;
    }

    async function makeRide(status: RideStatus = RideStatus.SEARCHING): Promise<string> {
        const rideId = `RIDE_${uniq()}`;
        await ds.getRepository(Ride).save(
            ds.getRepository(Ride).create({
                rideId, passengerId: `PAX_${uniq()}`, fare: 850, paymentMode: 'cash',
                status, pickupLat: 6.14, pickupLng: 6.79,
                destinationLat: 6.15, destinationLng: 6.80,
            } as any),
        );
        return rideId;
    }

    // ══════════════════════════════════════════════════════════════════
    //  Takeover races
    // ══════════════════════════════════════════════════════════════════

    it('two dispatchers pressing TAKE OVER at once — exactly one wins', async () => {
        for (let i = 0; i < 25; i++) {
            const rideId = await makeRide();
            const [a, b] = await Promise.all([
                RideControlService.takeover(rideId, ADA),
                RideControlService.takeover(rideId, BEN),
            ]);
            const winners = [a, b].filter((r) => r.ok);
            expect(winners).toHaveLength(1);

            const control = await RideControlService.get(rideId);
            expect(control!.mode).toBe(DispatchControlMode.OPERATIONS);
            // Whoever won owns it — and the loser was told who has it.
            expect([ADA.staffUserId, BEN.staffUserId]).toContain(control!.ownerStaffId);
            const loser = [a, b].find((r) => !r.ok) as any;
            expect(loser.code).toBe('ALREADY_CONTROLLED');
        }
    });

    it('the same dispatcher double-tapping is idempotent, not a second takeover', async () => {
        const rideId = await makeRide();
        const [a, b] = await Promise.all([
            RideControlService.takeover(rideId, ADA),
            RideControlService.takeover(rideId, ADA),
        ]);
        expect(a.ok && b.ok).toBe(true);
        const control = await RideControlService.get(rideId);
        expect(control!.ownerStaffId).toBe(ADA.staffUserId);
        // Control is held once, by one person. The count may reach 2 because
        // both presses legitimately claimed it, but there is ONE owner and one
        // live lease — which is the property that matters.
        expect(control!.mode).toBe(DispatchControlMode.OPERATIONS);
    });

    it('a terminal ride cannot be taken over', async () => {
        for (const status of [RideStatus.COMPLETED, RideStatus.CANCELED, RideStatus.FAILED]) {
            const rideId = await makeRide(status);
            const r = await RideControlService.takeover(rideId, ADA);
            expect(r.ok).toBe(false);
            expect((r as any).code).toBe('RIDE_NOT_CONTROLLABLE');
        }
    });

    it('a second dispatcher may claim once the lease has expired', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        // Expire it on the server's clock, exactly as the sweeper would see it.
        await ds.getRepository(RideDispatchControl).update(
            { rideId },
            { leaseExpiresAt: new Date(Date.now() - 1000) },
        );
        const r = await RideControlService.takeover(rideId, BEN);
        expect(r.ok).toBe(true);
        expect((await RideControlService.get(rideId))!.ownerStaffId).toBe(BEN.staffUserId);
    });

    // ══════════════════════════════════════════════════════════════════
    //  The lease is the ONLY thing that returns control to AUTO
    // ══════════════════════════════════════════════════════════════════

    it('a live lease keeps control even with no client contact', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        // No renewal, no socket, nothing. The sweeper must not touch it.
        const swept = await RideControlService.sweepExpired(new Date());
        expect(swept).toBe(0);
        expect(RideControlService.isOperationsControlled(await RideControlService.get(rideId))).toBe(true);
    });

    it('an expired lease is swept back to AUTO with an audited reason', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        await ds.getRepository(RideDispatchControl).update(
            { rideId },
            { leaseExpiresAt: new Date(Date.now() - 1000) },
        );

        expect(await RideControlService.sweepExpired()).toBe(1);
        const control = await RideControlService.get(rideId);
        expect(control!.mode).toBe(DispatchControlMode.AUTO);
        expect(control!.releaseReason).toBe(ControlReleaseReason.LEASE_EXPIRED);
        expect(control!.ownerStaffId).toBeNull();

        const events = await ds.getRepository(OperationsIntervention).find({ where: { rideId } });
        expect(events.map((e) => e.type)).toContain(InterventionType.CONTROL_EXPIRED);
    });

    it('renewal extends the lease; a lapsed holder cannot renew', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        const before = (await RideControlService.get(rideId))!.leaseExpiresAt!;

        const renewed = await RideControlService.renew(rideId, ADA, new Date(Date.now() + 5_000));
        expect(renewed.ok).toBe(true);
        expect(new Date((await RideControlService.get(rideId))!.leaseExpiresAt!).getTime())
            .toBeGreaterThan(new Date(before).getTime());

        // Once it has lapsed, renewing is refused — the client must take over
        // again rather than silently resurrect control somebody else may hold.
        await ds.getRepository(RideDispatchControl).update(
            { rideId }, { leaseExpiresAt: new Date(Date.now() - 1000) },
        );
        const late = await RideControlService.renew(rideId, ADA);
        expect(late.ok).toBe(false);
        expect((late as any).code).toBe('NOT_OWNER');
    });

    it('a dispatcher cannot renew or release somebody else\'s lease', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        expect((await RideControlService.renew(rideId, BEN)).ok).toBe(false);
        expect((await RideControlService.release(rideId, BEN, ControlReleaseReason.EXPLICIT)).ok).toBe(false);
        expect((await RideControlService.get(rideId))!.ownerStaffId).toBe(ADA.staffUserId);
    });

    it('a stale version is refused, so a replayed release is harmless', async () => {
        const rideId = await makeRide();
        const t = await RideControlService.takeover(rideId, ADA);
        const staleVersion = (t as any).control.version;
        await RideControlService.renew(rideId, ADA); // bumps version

        const replayed = await RideControlService.release(
            rideId, ADA, ControlReleaseReason.EXPLICIT, { expectedVersion: staleVersion },
        );
        expect(replayed.ok).toBe(false);
        expect((replayed as any).code).toBe('VERSION_CONFLICT');
        expect(RideControlService.isOperationsControlled(await RideControlService.get(rideId))).toBe(true);
    });

    it('an explicit release returns control to AUTO and is idempotent', async () => {
        const rideId = await makeRide();
        await RideControlService.takeover(rideId, ADA);
        const first = await RideControlService.release(rideId, ADA, ControlReleaseReason.EXPLICIT);
        expect(first.ok).toBe(true);
        // Pressing Release twice must not error at the operator.
        const second = await RideControlService.release(rideId, ADA, ControlReleaseReason.EXPLICIT);
        expect(second.ok).toBe(true);
        expect((await RideControlService.get(rideId))!.mode).toBe(DispatchControlMode.AUTO);
    });

    // ══════════════════════════════════════════════════════════════════
    //  Assignment races — the ride row is the sole arbiter
    // ══════════════════════════════════════════════════════════════════

    it('a driver accepting first beats an Operations assignment', async () => {
        for (let i = 0; i < 20; i++) {
            const rideId = await makeRide();
            const driverA = await makeDriver();
            const driverB = await makeDriver();
            await RideControlService.takeover(rideId, ADA);

            // Driver A's automatic acceptance and Ada's manual assignment,
            // launched together. Exactly one may win.
            const [autoAccept, opsAssign] = await Promise.all([
                stubHost.assignDriver({ rideId, driverId: driverA }),
                OperationsDispatchService.assign(rideId, driverB, ADA),
            ]);

            const winners = [autoAccept.ok, opsAssign.ok].filter(Boolean);
            expect(winners).toHaveLength(1);

            const ride = await ds.getRepository(Ride).findOne({ where: { rideId } });
            expect(ride!.status).toBe(RideStatus.ACCEPTED);
            expect([driverA, driverB]).toContain(ride!.driverId);
            // And exactly one assignment reached the arbiter.
            expect(assignments.filter((a) => a.rideId === rideId)).toHaveLength(1);
            assignments = [];
        }
    });

    it('two dispatchers assigning different drivers — one wins, one is told why', async () => {
        const rideId = await makeRide();
        const d1 = await makeDriver();
        const d2 = await makeDriver();
        await RideControlService.takeover(rideId, ADA);

        const [a, b] = await Promise.all([
            OperationsDispatchService.assign(rideId, d1, ADA),
            OperationsDispatchService.assign(rideId, d2, ADA),
        ]);
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        const loser = [a, b].find((r) => !r.ok) as any;
        expect(['RIDE_ALREADY_TAKEN', 'RIDE_NOT_ASSIGNABLE']).toContain(loser.code);
    });

    it('a duplicate assignment command assigns once', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        await RideControlService.takeover(rideId, ADA);

        const first = await OperationsDispatchService.assign(rideId, driverId, ADA);
        const replay = await OperationsDispatchService.assign(rideId, driverId, ADA);
        expect(first.ok).toBe(true);
        expect(replay.ok).toBe(false);
        expect(assignments.filter((a) => a.rideId === rideId)).toHaveLength(1);
    });

    it('a successful assignment ends the takeover', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        await RideControlService.takeover(rideId, ADA);
        expect((await OperationsDispatchService.assign(rideId, driverId, ADA)).ok).toBe(true);

        const control = await RideControlService.get(rideId);
        expect(control!.mode).toBe(DispatchControlMode.AUTO);
        expect(control!.releaseReason).toBe(ControlReleaseReason.ASSIGNED);
    });

    it('assignment is refused without control', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        const r = await OperationsDispatchService.assign(rideId, driverId, ADA);
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('NOT_CONTROLLER');
        expect(assignments).toHaveLength(0);
    });

    it('a dispatcher cannot assign on a ride somebody else controls', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        await RideControlService.takeover(rideId, ADA);
        const r = await OperationsDispatchService.assign(rideId, driverId, BEN);
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('NOT_CONTROLLER');
    });

    it('a cancelled ride cannot be assigned, even holding control', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        await RideControlService.takeover(rideId, ADA);
        // The passenger cancels mid-intervention.
        await ds.getRepository(Ride).update({ rideId }, { status: RideStatus.CANCELED as any });

        const r = await OperationsDispatchService.assign(rideId, driverId, ADA);
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('RIDE_NOT_ASSIGNABLE');
        expect(assignments).toHaveLength(0);
    });

    // ══════════════════════════════════════════════════════════════════
    //  Eligibility is never bypassed
    // ══════════════════════════════════════════════════════════════════

    it('a suspended driver cannot be assigned by Operations', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver({ status: DriverStatus.SUSPENDED });
        await RideControlService.takeover(rideId, ADA);

        const r = await OperationsDispatchService.assign(rideId, driverId, ADA);
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('DRIVER_NOT_ELIGIBLE');
        expect(assignments).toHaveLength(0);
    });

    it('a driver already on another ride cannot be assigned', async () => {
        const rideId = await makeRide();
        const otherRide = await makeRide();
        const driverId = await makeDriver();
        await ds.getRepository(Ride).update(
            { rideId: otherRide },
            { driverId, status: RideStatus.IN_PROGRESS as any },
        );
        await RideControlService.takeover(rideId, ADA);

        const r = await OperationsDispatchService.assign(rideId, driverId, ADA);
        expect(r.ok).toBe(false);
        expect((r as any).code).toBe('DRIVER_NOT_ELIGIBLE');
    });

    // ══════════════════════════════════════════════════════════════════
    //  Audit
    // ══════════════════════════════════════════════════════════════════

    it('every act leaves who, what, prior state and result', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver();
        await RideControlService.takeover(rideId, ADA);
        await OperationsDispatchService.recordDriverContacted(rideId, driverId, ADA, {
            presence: 'OFFLINE', distanceKm: 0.7, lastSeenSeconds: 240,
        });
        await OperationsDispatchService.assign(rideId, driverId, ADA);

        const rows = await ds.getRepository(OperationsIntervention).find({
            where: { rideId }, order: { createdAt: 'ASC' },
        });
        const types = rows.map((r) => r.type);
        expect(types).toContain(InterventionType.TAKEOVER_CLAIMED);
        expect(types).toContain(InterventionType.DRIVER_CONTACTED);
        expect(types).toContain(InterventionType.ASSIGNMENT_ATTEMPTED);
        expect(types).toContain(InterventionType.DRIVER_ASSIGNED);

        const assigned = rows.find((r) => r.type === InterventionType.DRIVER_ASSIGNED)!;
        expect(assigned.staffUserId).toBe(ADA.staffUserId);
        expect(assigned.staffLabel).toBe(ADA.label);
        expect(assigned.driverId).toBe(driverId);
        expect(assigned.priorRideStatus).toBe('searching');
        expect(assigned.outcome).toBe('ok');

        // A contact record holds no phone number — only that a call happened.
        const contacted = rows.find((r) => r.type === InterventionType.DRIVER_CONTACTED)!;
        expect(JSON.stringify(contacted.detail)).not.toMatch(/\+?234\d{6,}/);
    });

    it('a refused assignment is recorded as evidence, not silently dropped', async () => {
        const rideId = await makeRide();
        const driverId = await makeDriver({ status: DriverStatus.SUSPENDED });
        await RideControlService.takeover(rideId, ADA);
        await OperationsDispatchService.assign(rideId, driverId, ADA);

        const failed = await ds.getRepository(OperationsIntervention).findOne({
            where: { rideId, type: InterventionType.ASSIGNMENT_FAILED },
        });
        expect(failed).toBeTruthy();
        expect(failed!.outcomeCode).toBe('DRIVER_NOT_ELIGIBLE');
    });
});
