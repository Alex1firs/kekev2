/**
 * Who may phone the passenger — against a real database.
 *
 * The production failure this suite exists for: Operations assigned a driver
 * by hand, the assignment succeeded, the driver saw the trip, and "Call
 * passenger" said the number was unavailable. Automatic dispatch had never
 * shown the problem because it smuggles the number inside the offer payload,
 * so the only path that ever really EXERCISED the contact authorisation was
 * the one nobody used.
 *
 * The rule being asserted throughout:
 *
 *   Only the driver CURRENTLY assigned to an active, pre-completion ride may
 *   obtain the passenger's number. Access follows the assignment, never the
 *   history of who was once on it.
 *
 * These need a database because the answer is a row: `ride.driverId` is what
 * decides, and a mocked repository would be asserting our own assumptions back
 * at us.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Ride, RideStatus } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { ContactRevealEvent, ContactRevealActorType } from '../../src/models/ContactRevealEvent';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { OperationsIntervention, InterventionType } from '../../src/models/OperationsIntervention';
import { RideDispatchControl } from '../../src/models/RideDispatchControl';
import { DispatchEvent } from '../../src/models/DispatchEvent';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) {
    // eslint-disable-next-line no-console
    console.warn('[integration] TEST_DATABASE_URL not set — skipping contact authorisation tests.');
}

describeDb('passenger contact authorisation (database)', () => {
    let ds: DataSource;
    let ContactAccessService: typeof import('../../src/services/contact_access_service').ContactAccessService;
    let OperationsDispatchService: typeof import('../../src/services/operations_dispatch_service').OperationsDispatchService;

    const uuid = () => require('crypto').randomUUID();
    const SCHEMA = 'contact_auth_test';

    /** A named dispatcher. Staff ids are free-form varchars, not user uuids. */
    const ADA = { staffUserId: 'STAFF_ADA', label: 'Ada O.' };

    beforeAll(async () => {
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        // Into `public` deliberately: created inside this schema it would be
        // invisible to every other suite's uuid_generate_v4() default.
        await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: SCHEMA,
            extra: { options: `-c search_path=${SCHEMA},public` },
            entities: [
                Ride, User, ContactRevealEvent, StaffAuditEvent,
                OperationsIntervention, RideDispatchControl, DispatchEvent,
            ],
            synchronize: true, logging: false,
        });
        await ds.initialize();

        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });

        ContactAccessService = require('../../src/services/contact_access_service').ContactAccessService;
        OperationsDispatchService = require('../../src/services/operations_dispatch_service').OperationsDispatchService;
    });

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        for (const t of ['contact_reveal_event', 'staff_audit_event', 'operations_intervention',
            'ride_dispatch_control', 'dispatch_event', 'ride', 'user']) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }
    });

    // ── fixtures ────────────────────────────────────────────────────────

    let seq = 0;
    async function person(role: UserRole, phone: string | null = '08031234567'): Promise<string> {
        const id = uuid();
        seq += 1;
        await ds.getRepository(User).save(ds.getRepository(User).create({
            id,
            email: `person${seq}.${Date.now()}@example.test`,
            phone: phone as any,
            password: 'x',
            firstName: role === UserRole.DRIVER ? 'Emeka' : 'Chidinma',
            lastName: 'Test',
            role,
        } as any));
        return id;
    }

    async function ride(over: Partial<Ride> = {}): Promise<{ rideId: string; passengerId: string }> {
        const passengerId = (over as any).passengerId ?? await person(UserRole.PASSENGER);
        const rideId = uuid();
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId,
            passengerId,
            status: RideStatus.SEARCHING,
            fare: 1100,
            paymentMode: 'cash',
            ...over,
        } as any));
        return { rideId, passengerId };
    }

    /**
     * The assignment, performed the way the arbiter performs it: one
     * conditional UPDATE from `searching`. Release mirrors it back.
     */
    async function assign(rideId: string, driverId: string): Promise<boolean> {
        const r = await ds.getRepository(Ride).createQueryBuilder().update()
            .set({ driverId, status: 'accepted' as any })
            .where('"rideId" = :rideId AND status = :status', { rideId, status: 'searching' })
            .execute();
        return !!r.affected;
    }

    async function release(rideId: string): Promise<void> {
        await ds.getRepository(Ride).createQueryBuilder().update()
            .set({ driverId: null as any, status: 'searching' as any })
            .where('"rideId" = :rideId', { rideId })
            .execute();
    }

    const reveal = (rideId: string, driverId: string) =>
        ContactAccessService.passengerContactForAssignedDriver(rideId, driverId);

    /** Did the reveal succeed? Errors are the refusal, so they are caught. */
    async function allowed(rideId: string, driverId: string): Promise<boolean> {
        try {
            const c = await reveal(rideId, driverId);
            return c.phone != null;
        } catch {
            return false;
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  The two assignment paths must be indistinguishable
    // ══════════════════════════════════════════════════════════════════

    it('an automatically-assigned driver can obtain the passenger number', async () => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        expect(await assign(rideId, driverId)).toBe(true);

        const contact = await reveal(rideId, driverId);
        expect(contact.phone).toBe('08031234567');
        expect(contact.dialable).toBe(true);
    });

    it('an OPERATIONS-assigned driver can obtain the same number, by the same rule', async () => {
        /*
         * The point of the whole exercise. Contact authorisation reads
         * ride.driverId and the ride status — neither of which knows or cares
         * which surface performed the assignment. There is no "source" in this
         * decision and there must never be one, or the two paths drift.
         */
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        expect(await assign(rideId, driverId)).toBe(true);

        const contact = await reveal(rideId, driverId);
        expect(contact.phone).toBe('08031234567');
    });

    it('a driver who is not on the ride is refused, and is not told the ride exists', async () => {
        const assigned = await person(UserRole.DRIVER);
        const stranger = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, assigned);

        await expect(reveal(rideId, stranger)).rejects.toMatchObject({
            statusCode: 404,            // not 403 — a prober learns nothing
            message: 'Ride not found.',
        });
    });

    // ══════════════════════════════════════════════════════════════════
    //  Reassignment — access follows the assignment, not the history
    // ══════════════════════════════════════════════════════════════════

    it('Driver A loses access the moment Operations releases them, and Driver B gains it', async () => {
        const a = await person(UserRole.DRIVER);
        const b = await person(UserRole.DRIVER);
        const { rideId } = await ride();

        await assign(rideId, a);
        expect(await allowed(rideId, a)).toBe(true);     // A is on the ride
        expect(await allowed(rideId, b)).toBe(false);    // B is not

        await release(rideId);
        // Released: nobody holds it, so nobody may call. A having been on it a
        // second ago buys nothing — this is the property that stops a driver
        // taken off a ride keeping a customer's number.
        expect(await allowed(rideId, a)).toBe(false);
        expect(await allowed(rideId, b)).toBe(false);

        await assign(rideId, b);
        expect(await allowed(rideId, b)).toBe(true);
        expect(await allowed(rideId, a)).toBe(false);
    });

    // ══════════════════════════════════════════════════════════════════
    //  Ride state
    // ══════════════════════════════════════════════════════════════════

    it.each([
        ['accepted', true],
        ['arrived', true],
        ['in_progress', true],
        ['started', true],
    ])('the assigned driver may call during %s', async (status, expected) => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, driverId);
        await ds.getRepository(Ride).update({ rideId }, { status: status as any });

        expect(await allowed(rideId, driverId)).toBe(expected);
    });

    it('a cancelled ride ends contact access immediately', async () => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, driverId);
        await ds.getRepository(Ride).update({ rideId }, { status: RideStatus.CANCELED });

        await expect(reveal(rideId, driverId)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('a just-completed ride keeps access for the grace window — a forgotten bag is real', async () => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, driverId);
        await ds.getRepository(Ride).update({ rideId }, {
            status: RideStatus.COMPLETED, completedAt: new Date(),
        } as any);

        expect(await allowed(rideId, driverId)).toBe(true);
    });

    it('and the grace window ends', async () => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, driverId);
        await ds.getRepository(Ride).update({ rideId }, {
            status: RideStatus.COMPLETED,
            completedAt: new Date(Date.now() - 25 * 3600_000),   // yesterday
        } as any);

        await expect(reveal(rideId, driverId)).rejects.toMatchObject({ statusCode: 403 });
    });

    // ══════════════════════════════════════════════════════════════════
    //  A passenger with no number is a state, not a fault
    // ══════════════════════════════════════════════════════════════════

    it('reports "no number" honestly rather than claiming a dialable contact', async () => {
        /*
         * User.phone is nullable, so an account can exist without one. This
         * used to return `dialable: true` alongside `phone: null`, which is
         * how "we are authorised" and "there is a number" became the same
         * field — and how the driver app ended up showing one message for two
         * completely different situations.
         */
        const driverId = await person(UserRole.DRIVER);
        const passengerId = await person(UserRole.PASSENGER, null);
        const { rideId } = await ride({ passengerId } as any);
        await assign(rideId, driverId);

        const contact = await reveal(rideId, driverId);
        expect(contact.phone).toBeNull();
        expect(contact.dialable).toBe(false);
    });

    // ══════════════════════════════════════════════════════════════════
    //  Every reveal is recorded
    // ══════════════════════════════════════════════════════════════════

    it('writes a reveal event naming the driver, the ride and the subject', async () => {
        const driverId = await person(UserRole.DRIVER);
        const { rideId, passengerId } = await ride();
        await assign(rideId, driverId);
        await reveal(rideId, driverId);

        const events = await ds.getRepository(ContactRevealEvent).find({ where: { rideId } });
        expect(events).toHaveLength(1);
        expect(events[0].actorType).toBe(ContactRevealActorType.ASSIGNED_DRIVER);
        expect(events[0].actorId).toBe(driverId);
        expect(events[0].subjectUserId).toBe(passengerId);
        // The record says WHICH fields were shown, never their values.
        expect(events[0].fields).toBe('firstName,phone');
        expect(JSON.stringify(events[0])).not.toContain('08031234567');
    });

    it('a refused reveal writes no grant', async () => {
        const stranger = await person(UserRole.DRIVER);
        const { rideId } = await ride();
        await assign(rideId, await person(UserRole.DRIVER));

        await expect(reveal(rideId, stranger)).rejects.toBeTruthy();
        expect(await ds.getRepository(ContactRevealEvent).count()).toBe(0);
    });

    // ══════════════════════════════════════════════════════════════════
    //  The Operations dispatcher's own reveal
    // ══════════════════════════════════════════════════════════════════

    it('a dispatcher can reveal the passenger number for a live ride, and it is recorded twice over', async () => {
        const { rideId, passengerId } = await ride();

        const result = await OperationsDispatchService.revealPassengerContact(
            rideId, ADA, 'LONG_WAIT',
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.contact.phone).toBe('08031234567');

        // The privacy ledger: who saw whose number, and until when.
        const grants = await ds.getRepository(ContactRevealEvent).find({ where: { rideId } });
        expect(grants).toHaveLength(1);
        expect(grants[0].actorType).toBe(ContactRevealActorType.STAFF);
        expect(grants[0].actorId).toBe(ADA.staffUserId);
        expect(grants[0].subjectUserId).toBe(passengerId);
        expect(grants[0].reason).toBe('LONG_WAIT');

        // The Operations trail: what a person did on this ride.
        const acts = await ds.getRepository(OperationsIntervention).find({ where: { rideId } });
        expect(acts).toHaveLength(1);
        expect(acts[0].type).toBe(InterventionType.PASSENGER_CONTACTED);
        expect(acts[0].staffLabel).toBe('Ada O.');
        expect(acts[0].outcome).toBe('ok');
        // The intervention row records THAT a number existed, never the number.
        expect(JSON.stringify(acts[0])).not.toContain('08031234567');
    });

    it('a dispatcher does not need to hold the lease to ring a waiting passenger', async () => {
        // Ringing somebody is not an intervention in the ride: it changes
        // nothing, and it is frequently what a dispatcher does BEFORE deciding
        // to take over. The permission is the boundary; the lease is not.
        const { rideId } = await ride();
        expect(await ds.getRepository(RideDispatchControl).count()).toBe(0);

        const result = await OperationsDispatchService.revealPassengerContact(
            rideId, ADA, 'NO_DRIVER_FOUND',
        );
        expect(result.ok).toBe(true);
    });

    it('Operations cannot reach a ride that ended long ago — that is support work', async () => {
        const { rideId } = await ride({
            status: RideStatus.COMPLETED,
            completedAt: new Date(Date.now() - 30 * 3600_000),
        } as any);

        const result = await OperationsDispatchService.revealPassengerContact(
            rideId, ADA, 'INCIDENT',
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('RIDE_TOO_OLD');

        // Refused — and the attempt is still on the record.
        const acts = await ds.getRepository(OperationsIntervention).find({ where: { rideId } });
        expect(acts).toHaveLength(1);
        expect(acts[0].outcome).toBe('refused');
        expect(acts[0].outcomeCode).toBe('RIDE_TOO_OLD');
        // Nothing was revealed.
        expect(await ds.getRepository(ContactRevealEvent).count()).toBe(0);
    });

    it('an unknown ride is refused and recorded, not silently ignored', async () => {
        const result = await OperationsDispatchService.revealPassengerContact(
            uuid(), ADA, 'INCIDENT',
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('RIDE_NOT_FOUND');
        expect(await ds.getRepository(ContactRevealEvent).count()).toBe(0);
    });
});
