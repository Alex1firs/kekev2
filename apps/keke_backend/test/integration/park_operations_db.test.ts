/**
 * Database-backed park operations tests.
 *
 * Covers what only means something against a real Postgres: park creation and
 * the activation gate, dispatcher shifts and their one-open-shift constraint,
 * presence transitions and their event trail, roster membership, queue ordering,
 * badge issuance and park scoping.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Uses its own Postgres schema for the
 * same reason the staff suite does: sibling integration files run in parallel
 * workers and would otherwise drop each other's tables.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Park, ParkStatus } from '../../src/models/Park';
import { ParkZone, ParkZoneKind } from '../../src/models/ParkZone';
import { DispatcherShift, DispatcherShiftStatus } from '../../src/models/DispatcherShift';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../../src/models/DriverPresence';
import { DriverPresenceEvent } from '../../src/models/DriverPresenceEvent';
import { ParkDriverRoster, RosterStatus } from '../../src/models/ParkDriverRoster';
import { DriverBadge, BadgeStatus } from '../../src/models/DriverBadge';
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
    console.warn('[integration] TEST_DATABASE_URL not set — skipping park operations DB tests.');
}

describeDb('park operations (database)', () => {
    let ds: DataSource;
    let ParkService: typeof import('../../src/services/park_service').ParkService;
    let ParkRosterService: typeof import('../../src/services/park_roster_service').ParkRosterService;
    let DispatcherShiftService: typeof import('../../src/services/dispatcher_shift_service').DispatcherShiftService;
    let DriverPresenceService: typeof import('../../src/services/driver_presence_service').DriverPresenceService;
    let BadgeService: typeof import('../../src/services/badge_service').BadgeService;
    let ParkRepository: typeof import('../../src/repositories/park_repository').ParkRepository;
    let parkScope: typeof import('../../src/middleware/park_scope');

    const OPS: any = { staffUserId: 'ACTOR_OPS', roles: [StaffRole.OPERATIONS_ADMIN], isLegacy: false };
    let seq = 0;
    const uniq = () => `${Date.now()}${++seq}`;

    /** A driver who could legitimately be rostered: approved, with a photo. */
    const makeDriver = async (over: Partial<DriverProfile> = {}) => {
        const n = uniq();
        const user = await ds.getRepository(User).save(ds.getRepository(User).create({
            email: `drv${n}@k.test`, phone: `080${n.slice(-8)}`, password: 'x',
            firstName: 'Drv', lastName: n.slice(-4), role: UserRole.DRIVER,
        }));
        await ds.getRepository(DriverProfile).save(ds.getRepository(DriverProfile).create({
            userId: user.id, firstName: 'Drv', lastName: n.slice(-4),
            vehiclePlate: `ENU-${n.slice(-3)}-KJA`, vehicleModel: 'Keke',
            status: DriverStatus.APPROVED, photoUrl: 'photo.jpg',
            unitNumber: `U${n.slice(-3)}`, deviceCapability: 'smartphone',
            ...over,
        } as any));
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({ userId: user.id }));
        return user.id;
    };

    const makeStaff = async (role: StaffRole, parkId: string | null) => {
        const n = uniq();
        const staff = await ds.getRepository(StaffUser).save(ds.getRepository(StaffUser).create({
            email: `st${n}@k.test`, phone: `081${n.slice(-8)}`, firstName: 'St', lastName: n.slice(-4),
            passwordHash: 'x', status: StaffStatus.ACTIVE,
        }));
        await ds.getRepository(StaffRoleAssignment).save(ds.getRepository(StaffRoleAssignment).create({
            staffUserId: staff.id, role, parkId, grantedByStaffId: 'ACTOR_OPS',
        }));
        return staff.id;
    };

    /** A park taken all the way to ACTIVE. */
    const makeActivePark = async (over: Record<string, any> = {}) => {
        const n = uniq();
        const dto = await ParkService.create(OPS, {
            name: `Park ${n}`, code: `PK-${n.slice(-6)}`, lat: 6.2109, lng: 7.074,
            city: 'Awka', ...over,
        });
        await ParkService.createZone(OPS, dto.parkId, {
            name: 'Main shed', code: 'BAY-A', kind: ParkZoneKind.STAGING, lat: 6.2109, lng: 7.074,
        });
        const supervisor = await makeStaff(StaffRole.PARK_SUPERVISOR, dto.parkId);
        await ParkService.assignSupervisor(OPS, dto.parkId, supervisor);
        await ParkService.activate(OPS, dto.parkId);
        return { parkId: dto.parkId, supervisor };
    };

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS park_ops_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres',
            url: TEST_DB,
            schema: 'park_ops_test',
            entities: [
                Park, ParkZone, DispatcherShift, DriverPresence, DriverPresenceEvent,
                ParkDriverRoster, DriverBadge, DriverProfile, User, Wallet, Ride,
                StaffUser, StaffRoleAssignment, StaffAuditEvent,
            ],
            synchronize: true,
            dropSchema: true,
        });
        await ds.initialize();

        // The partial unique indexes are migration-only (synchronize does not
        // create them), and several tests depend on them being real.
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_one_open_test"
            ON park_ops_test.dispatcher_shift ("staffUserId") WHERE status = 'open'`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_roster_live_test"
            ON park_ops_test.park_driver_roster ("parkId", "driverId") WHERE status <> 'removed'`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_live_driver_test"
            ON park_ops_test.driver_badge ("driverId") WHERE status IN ('active','pending_activation')`);
        await ds.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_live_code_test"
            ON park_ops_test.driver_badge ("shortCode") WHERE status IN ('active','pending_activation')`);

        const dataSourceModule = await import('../../src/config/data_source');
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true, configurable: true });

        ParkService = (await import('../../src/services/park_service')).ParkService;
        ParkRosterService = (await import('../../src/services/park_roster_service')).ParkRosterService;
        DispatcherShiftService = (await import('../../src/services/dispatcher_shift_service')).DispatcherShiftService;
        DriverPresenceService = (await import('../../src/services/driver_presence_service')).DriverPresenceService;
        BadgeService = (await import('../../src/services/badge_service')).BadgeService;
        ParkRepository = (await import('../../src/repositories/park_repository')).ParkRepository;
        parkScope = await import('../../src/middleware/park_scope');
    }, 60_000);

    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy();
    });

    // ── Part A: parks ───────────────────────────────────────────────────
    describe('Part A — parks', () => {
        it('creates a park as DRAFT, whatever status the caller asks for', async () => {
            const n = uniq();
            const park = await ParkService.create(OPS, {
                name: 'Draft Park', code: `DR-${n.slice(-6)}`, lat: 6.21, lng: 7.07,
                status: 'active',   // ignored
            });
            expect(park.status).toBe(ParkStatus.DRAFT);
        });

        it('rejects a duplicate code', async () => {
            const code = `DUP-${uniq().slice(-6)}`;
            await ParkService.create(OPS, { name: 'A', code, lat: 6.21, lng: 7.07 });
            await expect(ParkService.create(OPS, { name: 'B', code, lat: 6.21, lng: 7.07 }))
                .rejects.toMatchObject({ statusCode: 409 });
        });

        it('rejects coordinates outside the service area — catching swapped lat/lng', async () => {
            await expect(ParkService.create(OPS, {
                name: 'Swapped', code: `SW-${uniq().slice(-6)}`, lat: 7.074, lng: 45.0,
            })).rejects.toMatchObject({ statusCode: 400 });

            // 0,0 is the classic silent data-entry failure.
            await expect(ParkService.create(OPS, {
                name: 'Null Island', code: `NI-${uniq().slice(-6)}`, lat: 0, lng: 0,
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('rejects a malformed opening time', async () => {
            await expect(ParkService.create(OPS, {
                name: 'Bad hours', code: `BH-${uniq().slice(-6)}`, lat: 6.21, lng: 7.07, opensAt: '6am',
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('refuses to activate a park with no supervisor and no staging zone', async () => {
            const n = uniq();
            const park = await ParkService.create(OPS, { name: 'Bare', code: `BA-${n.slice(-6)}`, lat: 6.21, lng: 7.07 });
            await expect(ParkService.activate(OPS, park.parkId)).rejects.toMatchObject({ statusCode: 400 });

            const blockers = await ParkService.activationBlockers(await ParkService.requirePark(park.parkId));
            expect(blockers).toContain('no supervisor assigned');
            expect(blockers).toContain('no staging zone defined');
        });

        it('activates once every blocker is resolved', async () => {
            const { parkId } = await makeActivePark();
            const park = await ParkService.get(parkId);
            expect(park!.status).toBe(ParkStatus.ACTIVE);
            expect(await ParkService.activationBlockers(await ParkService.requirePark(parkId))).toEqual([]);
        });

        it('refuses a supervisor who does not hold the role at this park', async () => {
            const n = uniq();
            const park = await ParkService.create(OPS, { name: 'S', code: `SU-${n.slice(-6)}`, lat: 6.21, lng: 7.07 });
            const otherPark = await ParkService.create(OPS, { name: 'O', code: `OT-${n.slice(-6)}`, lat: 6.22, lng: 7.08 });
            const wrongScope = await makeStaff(StaffRole.PARK_SUPERVISOR, otherPark.parkId);

            await expect(ParkService.assignSupervisor(OPS, park.parkId, wrongScope))
                .rejects.toMatchObject({ statusCode: 400 });
        });

        it('suspension requires a reason and records it', async () => {
            const { parkId } = await makeActivePark();
            await expect(ParkService.suspend(OPS, parkId, '  ')).rejects.toMatchObject({ statusCode: 400 });

            await ParkService.suspend(OPS, parkId, 'flooding at the site');
            const park = await ParkService.get(parkId);
            expect(park!.status).toBe(ParkStatus.SUSPENDED);
            expect(park!.suspensionReason).toBe('flooding at the site');

            const audit = await ds.getRepository(StaffAuditEvent)
                .findOne({ where: { resourceId: parkId, action: 'PARK_SUSPENDED' } });
            expect(audit!.reason).toBe('flooding at the site');
            expect(audit!.actorStaffUserId).toBe('ACTOR_OPS');
        });

        it('refuses a staging zone placed far from the park', async () => {
            const n = uniq();
            const park = await ParkService.create(OPS, { name: 'Z', code: `ZO-${n.slice(-6)}`, lat: 6.21, lng: 7.07 });
            await expect(ParkService.createZone(OPS, park.parkId, {
                name: 'Wrong place', code: 'FAR', kind: ParkZoneKind.STAGING, lat: 6.60, lng: 7.60,
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('allows a SERVICE zone away from the park — that is what it is for', async () => {
            const n = uniq();
            const park = await ParkService.create(OPS, { name: 'Z2', code: `Z2-${n.slice(-6)}`, lat: 6.21, lng: 7.07 });
            await expect(ParkService.createZone(OPS, park.parkId, {
                name: 'Amaku district', code: 'AMK', kind: ParkZoneKind.SERVICE, lat: 6.30, lng: 7.15,
            })).resolves.toBeTruthy();
        });

        it('derives live counts rather than storing them', async () => {
            const { parkId } = await makeActivePark();
            const a = await makeDriver();
            const b = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, a);
            await ParkRosterService.addDriver(OPS, parkId, b);

            await DriverPresenceService.setState({ driverId: a, state: DriverPresenceState.AT_PARK, parkId, source: PresenceSource.DISPATCHER });
            await DriverPresenceService.setState({ driverId: a, state: DriverPresenceState.WAITING, parkId, source: PresenceSource.DISPATCHER });
            await DriverPresenceService.setState({ driverId: b, state: DriverPresenceState.AT_PARK, parkId, source: PresenceSource.DISPATCHER });

            const counts = await ParkRepository.counts(await ParkService.requirePark(parkId));
            expect(counts.rosterSize).toBe(2);
            expect(counts.waitingDriverCount).toBe(1);
            expect(counts.activeDriverCount).toBe(2);
            expect(counts.onRideCount).toBe(0);
        });
    });

    // ── Part B: shifts ──────────────────────────────────────────────────
    describe('Part B — dispatcher shifts', () => {
        it('opens a shift and records whether the start location was on-site', async () => {
            const { parkId } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const actor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };

            const shift = await DispatcherShiftService.open(actor, { parkId, lat: 6.2109, lng: 7.074 });
            expect(shift.status).toBe(DispatcherShiftStatus.OPEN);
            expect(shift.startLocationVerified).toBe(true);
            expect(shift.startDistanceM).toBeLessThan(50);
        });

        it('records an off-site start WITHOUT blocking it', async () => {
            // A bad GPS fix must not stop somebody starting work; it is recorded
            // and surfaced instead.
            const { parkId } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const actor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };

            const shift = await DispatcherShiftService.open(actor, { parkId, lat: 6.40, lng: 7.30 });
            expect(shift.status).toBe(DispatcherShiftStatus.OPEN);
            expect(shift.startLocationVerified).toBe(false);
            expect(shift.startDistanceM).toBeGreaterThan(1000);
        });

        it('refuses a second open shift for the same dispatcher', async () => {
            const { parkId } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const actor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };

            await DispatcherShiftService.open(actor, { parkId });
            await expect(DispatcherShiftService.open(actor, { parkId })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('refuses a shift at a park the dispatcher is not assigned to', async () => {
            const { parkId } = await makeActivePark();
            const other = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, other.parkId);
            const actor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };

            await expect(DispatcherShiftService.open(actor, { parkId })).rejects.toMatchObject({ statusCode: 403 });
        });

        it('refuses a shift at a park that is not active', async () => {
            const n = uniq();
            const draft = await ParkService.create(OPS, { name: 'D', code: `DF-${n.slice(-6)}`, lat: 6.21, lng: 7.07 });
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, draft.parkId);
            const actor: any = { staffUserId: dispatcher, roles: [StaffRole.PARK_DISPATCHER], isLegacy: false };

            await expect(DispatcherShiftService.open(actor, { parkId: draft.parkId })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('supports several dispatchers on duty at one park simultaneously', async () => {
            const { parkId } = await makeActivePark();
            const a = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const b = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);

            await DispatcherShiftService.open({ staffUserId: a, roles: [], isLegacy: false } as any, { parkId });
            await DispatcherShiftService.open({ staffUserId: b, roles: [], isLegacy: false } as any, { parkId });

            const onDuty = await DispatcherShiftService.onDuty(parkId);
            expect(onDuty).toHaveLength(2);
        });

        it('closes a shift and frees the dispatcher to open another', async () => {
            const { parkId } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const actor: any = { staffUserId: dispatcher, roles: [], isLegacy: false };

            await DispatcherShiftService.open(actor, { parkId });
            const closed = await DispatcherShiftService.close(actor, { handoverNotes: 'quiet morning' });
            expect(closed.status).toBe(DispatcherShiftStatus.CLOSED);
            expect(closed.handoverNotes).toBe('quiet morning');

            await expect(DispatcherShiftService.open(actor, { parkId })).resolves.toBeTruthy();
        });

        it('a force-close requires a reason and is attributed to the closer', async () => {
            const { parkId, supervisor } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const shift = await DispatcherShiftService.open({ staffUserId: dispatcher, roles: [], isLegacy: false } as any, { parkId });
            const supervisorActor: any = { staffUserId: supervisor, roles: [StaffRole.PARK_SUPERVISOR], isLegacy: false };

            await expect(DispatcherShiftService.forceClose(supervisorActor, shift.shiftId, '')).rejects.toMatchObject({ statusCode: 400 });

            const closed = await DispatcherShiftService.forceClose(supervisorActor, shift.shiftId, 'left without signing off');
            expect(closed.status).toBe(DispatcherShiftStatus.CLOSED);
            expect(closed.endedBy).toBe('supervisor');

            const audit = await ds.getRepository(StaffAuditEvent)
                .findOne({ where: { resourceId: shift.shiftId, action: 'SHIFT_FORCE_CLOSED' } });
            expect(audit!.actorStaffUserId).toBe(supervisor);
        });

        it('closing a shift twice is refused rather than silently overwriting', async () => {
            const { parkId, supervisor } = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, parkId);
            const shift = await DispatcherShiftService.open({ staffUserId: dispatcher, roles: [], isLegacy: false } as any, { parkId });
            const sup: any = { staffUserId: supervisor, roles: [], isLegacy: false };

            await DispatcherShiftService.forceClose(sup, shift.shiftId, 'first');
            await expect(DispatcherShiftService.forceClose(sup, shift.shiftId, 'second')).rejects.toMatchObject({ statusCode: 409 });
        });
    });

    // ── Part C: presence ────────────────────────────────────────────────
    describe('Part C — driver presence', () => {
        it('starts every driver OFFLINE without needing a row up front', async () => {
            const driverId = await makeDriver();
            const presence = await DriverPresenceService.get(driverId);
            expect(presence.state).toBe(DriverPresenceState.OFFLINE);
        });

        it('records a transition event with the time spent in the previous state', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();

            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.ONLINE, source: PresenceSource.DRIVER_APP });
            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.AT_PARK, parkId, source: PresenceSource.DRIVER_APP });

            const events = await ds.getRepository(DriverPresenceEvent).find({ where: { driverId }, order: { occurredAt: 'ASC' } });
            expect(events).toHaveLength(2);
            expect(events[0].toState).toBe(DriverPresenceState.ONLINE);
            expect(events[1].fromState).toBe(DriverPresenceState.ONLINE);
            expect(events[1].toState).toBe(DriverPresenceState.AT_PARK);
            expect(events[1].previousStateDurationSec).toBeGreaterThanOrEqual(0);
        });

        it('a repeated report of the same state writes no event and does not reset the clock', async () => {
            const driverId = await makeDriver();
            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.ONLINE, source: PresenceSource.DRIVER_APP });
            const first = await DriverPresenceService.get(driverId);

            const again = await DriverPresenceService.setState({ driverId, state: DriverPresenceState.ONLINE, source: PresenceSource.DRIVER_APP });
            expect(again.changed).toBe(false);
            expect(again.presence.since.getTime()).toBe(first.since.getTime());

            const events = await ds.getRepository(DriverPresenceEvent).count({ where: { driverId } });
            expect(events).toBe(1);
        });

        it('refuses an impossible transition', async () => {
            const driverId = await makeDriver();
            await expect(DriverPresenceService.setState({
                driverId, state: DriverPresenceState.TRIP_STARTED, source: PresenceSource.DISPATCHER,
            })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('allows an override with a reason, and records it as forced', async () => {
            const driverId = await makeDriver();
            const actor: any = { staffUserId: 'ACTOR_ADMIN', roles: [StaffRole.SUPER_ADMIN], isLegacy: false };

            await expect(DriverPresenceService.setState({
                driverId, state: DriverPresenceState.TRIP_STARTED, source: PresenceSource.ADMIN, force: true,
            })).rejects.toMatchObject({ statusCode: 400 });   // no reason

            const result = await DriverPresenceService.setState({
                driverId, state: DriverPresenceState.TRIP_STARTED, source: PresenceSource.ADMIN,
                force: true, reason: 'driver reported by phone, app crashed',
            }, { actor });
            expect(result.presence.state).toBe(DriverPresenceState.TRIP_STARTED);

            const audit = await ds.getRepository(StaffAuditEvent)
                .findOne({ where: { resourceId: driverId, action: 'PRESENCE_FORCED' } });
            expect(audit!.reason).toBe('driver reported by phone, app crashed');
        });

        it('requires a park for WAITING — a driver cannot be waiting at no park', async () => {
            const driverId = await makeDriver();
            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.ONLINE, source: PresenceSource.DRIVER_APP });
            await expect(DriverPresenceService.setState({
                driverId, state: DriverPresenceState.WAITING, parkId: null, source: PresenceSource.DRIVER_APP,
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('clears the park when a driver goes offline', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.AT_PARK, parkId, source: PresenceSource.DISPATCHER });
            const off = await DriverPresenceService.setState({ driverId, state: DriverPresenceState.OFFLINE, source: PresenceSource.DRIVER_APP });
            expect(off.presence.parkId).toBeNull();
        });

        it('a heartbeat never promotes OFFLINE to ONLINE', async () => {
            // An app that is merely running is not a person who has started work.
            const driverId = await makeDriver();
            const after = await DriverPresenceService.heartbeat(driverId);
            expect(after.state).toBe(DriverPresenceState.OFFLINE);
            expect(after.lastHeartbeatAt).not.toBeNull();
        });

        it('does not audit driver-app presence, only human-recorded presence', async () => {
            const driverId = await makeDriver();
            const actor: any = { staffUserId: 'ACTOR_X', roles: [], isLegacy: false };
            await DriverPresenceService.setState(
                { driverId, state: DriverPresenceState.ONLINE, source: PresenceSource.DRIVER_APP }, { actor },
            );
            const count = await ds.getRepository(StaffAuditEvent).count({ where: { resourceId: driverId } });
            expect(count).toBe(0);
        });

        it('presence is independent of the ride lifecycle', async () => {
            // Creating a ride and assigning a driver changes nothing about
            // presence: something has to record it deliberately.
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await DriverPresenceService.setState({ driverId, state: DriverPresenceState.AT_PARK, parkId, source: PresenceSource.DISPATCHER });

            await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
                rideId: `RIDE-${uniq()}`, passengerId: 'pax-1', driverId,
                fare: 1500, paymentMode: 'cash', status: 'accepted' as any,
            }));

            expect((await DriverPresenceService.get(driverId)).state).toBe(DriverPresenceState.AT_PARK);
        });
    });

    // ── Part D: roster, queue and badges ────────────────────────────────
    describe('Part D — roster and queue', () => {
        it('adds a driver, and refuses a duplicate', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();

            const entry = await ParkRosterService.addDriver(OPS, parkId, driverId);
            expect(entry.status).toBe(RosterStatus.ACTIVE);
            expect(entry.smartphoneCapable).toBe(true);

            await expect(ParkRosterService.addDriver(OPS, parkId, driverId)).rejects.toMatchObject({ statusCode: 409 });
        });

        it('carries device capability and phone through to the roster view', async () => {
            const { parkId } = await makeActivePark();
            const featurePhone = await makeDriver({ deviceCapability: 'feature_phone' } as any);
            await ParkRosterService.addDriver(OPS, parkId, featurePhone);

            const view = await ParkRosterService.view(parkId);
            const entry = view.find((e) => e.driverId === featurePhone)!;
            expect(entry.smartphoneCapable).toBe(false);
            expect(entry.featurePhoneOnly).toBe(true);
            expect(entry.phone).toBeTruthy();
        });

        it('a driver may be on two parks\' rosters', async () => {
            const a = await makeActivePark();
            const b = await makeActivePark();
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, a.parkId, driverId);
            await expect(ParkRosterService.addDriver(OPS, b.parkId, driverId)).resolves.toBeTruthy();
        });

        it('removal needs a reason and allows a later rejoin', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, driverId);

            await expect(ParkRosterService.removeDriver(OPS, parkId, driverId, '')).rejects.toMatchObject({ statusCode: 400 });
            await ParkRosterService.removeDriver(OPS, parkId, driverId, 'moved to another town');
            await expect(ParkRosterService.addDriver(OPS, parkId, driverId)).resolves.toBeTruthy();
        });

        it('joins the queue in order and sets presence to WAITING', async () => {
            const { parkId } = await makeActivePark();
            const a = await makeDriver();
            const b = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, a);
            await ParkRosterService.addDriver(OPS, parkId, b);

            expect((await ParkRosterService.joinQueue(OPS, parkId, a)).queuePosition).toBe(1);
            expect((await ParkRosterService.joinQueue(OPS, parkId, b)).queuePosition).toBe(2);
            expect((await DriverPresenceService.get(a)).state).toBe(DriverPresenceState.WAITING);
        });

        it('leaving the queue compacts positions and leaves the driver AT_PARK', async () => {
            const { parkId } = await makeActivePark();
            const drivers = [await makeDriver(), await makeDriver(), await makeDriver()];
            for (const d of drivers) {
                await ParkRosterService.addDriver(OPS, parkId, d);
                await ParkRosterService.joinQueue(OPS, parkId, d);
            }

            await ParkRosterService.leaveQueue(OPS, parkId, drivers[0], 'gone for fuel');

            const queue = await ParkRosterService.queue(parkId);
            expect(queue.map((q) => q.queuePosition)).toEqual([1, 2]);
            // Still at the park — claiming they went home would be a lie.
            expect((await DriverPresenceService.get(drivers[0])).state).toBe(DriverPresenceState.AT_PARK);
        });

        it('suspending a roster driver pulls them out of the queue', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, driverId);
            await ParkRosterService.joinQueue(OPS, parkId, driverId);

            await ParkRosterService.setSuspended(OPS, parkId, driverId, true, 'repeated no-shows');
            expect(await ParkRosterService.queue(parkId)).toHaveLength(0);
        });

        it('reordering must be a permutation of the current queue', async () => {
            const { parkId } = await makeActivePark();
            const drivers = [await makeDriver(), await makeDriver()];
            for (const d of drivers) {
                await ParkRosterService.addDriver(OPS, parkId, d);
                await ParkRosterService.joinQueue(OPS, parkId, d);
            }
            const queue = await ParkRosterService.queue(parkId);

            // A partial list would silently drop whoever was omitted.
            await expect(ParkRosterService.reorderQueue(OPS, parkId, [queue[0].rosterId], 'partial'))
                .rejects.toMatchObject({ statusCode: 400 });

            await ParkRosterService.reorderQueue(OPS, parkId, [queue[1].rosterId, queue[0].rosterId], 'driver returned from fuel');
            const after = await ParkRosterService.queue(parkId);
            expect(after[0].driverId).toBe(queue[1].driverId);
        });

        it('a skip requires a reason, is counted, and keeps the driver\'s place', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, driverId);
            await ParkRosterService.joinQueue(OPS, parkId, driverId);

            await expect(ParkRosterService.recordSkip(OPS, parkId, driverId, '')).rejects.toMatchObject({ statusCode: 400 });
            await ParkRosterService.recordSkip(OPS, parkId, driverId, 'vehicle unsuitable for the load');

            const queue = await ParkRosterService.queue(parkId);
            expect(queue[0].skipCount).toBe(1);
            expect(queue[0].queuePosition).toBe(1);
        });

        it('reports why a driver cannot take work, without blocking anything', async () => {
            const { parkId } = await makeActivePark();
            const driverId = await makeDriver();
            await ParkRosterService.addDriver(OPS, parkId, driverId);
            await ParkRosterService.joinQueue(OPS, parkId, driverId);

            // Debt above the cash-block threshold.
            await ds.getRepository(Wallet).update({ userId: driverId }, { driverCommissionDebt: 3000 });

            const queue = await ParkRosterService.queue(parkId);
            expect(queue[0].assignable).toBe(false);
            expect(queue[0].problems.map((p) => p.code)).toEqual(expect.arrayContaining(['wallet_blocked', 'no_badge']));
        });
    });

    describe('Part D — badges', () => {
        it('issues a badge with an opaque, verifiable payload', async () => {
            const driverId = await makeDriver();
            const badge = await BadgeService.issue(OPS, { driverId });

            expect(badge.status).toBe(BadgeStatus.PENDING_ACTIVATION);
            expect(badge.shortCode).toMatch(/^\d{6}$/);
            expect(BadgeService.verifyPayload(badge.qrPayload).valid).toBe(true);
            expect(badge.qrPayload).not.toContain(driverId);
        });

        it('refuses a badge for a driver who is not approved', async () => {
            const driverId = await makeDriver({ status: DriverStatus.PENDING_REVIEW } as any);
            await expect(BadgeService.issue(OPS, { driverId })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('refuses a badge for a driver with no verified photo', async () => {
            // The photo is the control that defeats badge sharing.
            const driverId = await makeDriver({ photoUrl: null } as any);
            await expect(BadgeService.issue(OPS, { driverId })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('refuses a second live badge for one driver', async () => {
            const driverId = await makeDriver();
            await BadgeService.issue(OPS, { driverId });
            await expect(BadgeService.issue(OPS, { driverId })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('activates, then revokes with a reason', async () => {
            const driverId = await makeDriver();
            const badge = await BadgeService.issue(OPS, { driverId });

            const active = await BadgeService.activate(OPS, badge.badgeSerial);
            expect(active.status).toBe(BadgeStatus.ACTIVE);

            await expect(BadgeService.revoke(OPS, badge.badgeSerial, '')).rejects.toMatchObject({ statusCode: 400 });
            const revoked = await BadgeService.revoke(OPS, badge.badgeSerial, 'card damaged');
            expect(revoked.status).toBe(BadgeStatus.REVOKED);
        });

        it('replacing retires the old badge and links it to the new one', async () => {
            const driverId = await makeDriver();
            const original = await BadgeService.issue(OPS, { driverId });
            await BadgeService.activate(OPS, original.badgeSerial);

            const replacement = await BadgeService.replace(OPS, original.badgeSerial, 'lost in the rain');
            expect(replacement.badgeSerial).not.toBe(original.badgeSerial);

            const old = await ds.getRepository(DriverBadge).findOneBy({ badgeSerial: original.badgeSerial });
            expect(old!.status).toBe(BadgeStatus.REPLACED);
            expect(old!.replacedByBadgeSerial).toBe(replacement.badgeSerial);
        });

        it('a revoked badge frees its short code for reuse', async () => {
            const driverId = await makeDriver();
            const badge = await BadgeService.issue(OPS, { driverId });
            await BadgeService.revoke(OPS, badge.badgeSerial, 'test');
            // A fresh badge for the same driver is now possible.
            await expect(BadgeService.issue(OPS, { driverId })).resolves.toBeTruthy();
        });
    });

    // ── park scoping ────────────────────────────────────────────────────
    describe('park scoping (closes the Phase 1 gap)', () => {
        it('a park-scoped dispatcher may act only at their own park', async () => {
            const a = await makeActivePark();
            const b = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, a.parkId);

            expect(await parkScope.staffMayActAtPark(dispatcher, a.parkId)).toBe(true);
            expect(await parkScope.staffMayActAtPark(dispatcher, b.parkId)).toBe(false);
        });

        it('a global operations grant reaches every park', async () => {
            const a = await makeActivePark();
            const ops = await makeStaff(StaffRole.OPERATIONS_ADMIN, null);
            expect(await parkScope.staffParkScope(ops)).toBe('*');
            expect(await parkScope.staffMayActAtPark(ops, a.parkId)).toBe(true);
        });

        it('a revoked grant removes park authority', async () => {
            const a = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, a.parkId);
            expect(await parkScope.staffMayActAtPark(dispatcher, a.parkId)).toBe(true);

            await ds.getRepository(StaffRoleAssignment).update({ staffUserId: dispatcher }, { revokedAt: new Date() });
            expect(await parkScope.staffMayActAtPark(dispatcher, a.parkId)).toBe(false);
        });

        it('holding a role at one park does not grant the role at another', async () => {
            const a = await makeActivePark();
            const b = await makeActivePark();
            const dispatcher = await makeStaff(StaffRole.PARK_DISPATCHER, a.parkId);

            expect(await parkScope.staffHoldsParkRole(dispatcher, a.parkId, [StaffRole.PARK_DISPATCHER])).toBe(true);
            expect(await parkScope.staffHoldsParkRole(dispatcher, b.parkId, [StaffRole.PARK_DISPATCHER])).toBe(false);
        });
    });
});
