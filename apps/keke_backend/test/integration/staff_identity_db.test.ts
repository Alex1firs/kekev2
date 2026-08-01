/**
 * Database-backed staff identity tests.
 *
 * Covers everything that only means something against a real Postgres: unique
 * constraints, login and lockout, suspension revoking authority, credential
 * reset killing live sessions, the contact-privacy compatibility layer, and
 * that no API path can emit a password hash.
 *
 * SKIPPED unless TEST_DATABASE_URL is set; test/setup/guard.ts refuses
 * production-looking URLs. Run against a disposable database:
 *
 *   TEST_DATABASE_URL=postgres://localhost:55432/keke_test npm run test:integration
 *
 * Uses synchronize:true on a throwaway schema — the migration itself is
 * verified separately by applying it to a scratch database (see
 * docs/staff_identity_architecture.md, "Verification").
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { StaffUser, StaffStatus } from '../../src/models/StaffUser';
import { StaffRoleAssignment } from '../../src/models/StaffRoleAssignment';
import { StaffSession } from '../../src/models/StaffSession';
import { StaffAuditEvent } from '../../src/models/StaffAuditEvent';
import { ContactRevealEvent } from '../../src/models/ContactRevealEvent';
import { Ride } from '../../src/models/Ride';
import { User, UserRole } from '../../src/models/User';
import { DeviceToken } from '../../src/models/DeviceToken';
import { StaffRole, StaffPermission } from '../../src/config/staff_permissions';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
    // eslint-disable-next-line no-console
    console.warn('[integration] TEST_DATABASE_URL not set — skipping staff identity DB tests.');
}

describeDb('staff identity (database)', () => {
    let ds: DataSource;
    // Imported lazily so the services bind to the DataSource this suite builds.
    let StaffService: typeof import('../../src/services/staff_service').StaffService;
    let StaffAuthService: typeof import('../../src/services/staff_auth_service').StaffAuthService;
    let StaffAuthError: typeof import('../../src/services/staff_auth_service').StaffAuthError;
    let ContactAccessService: typeof import('../../src/services/contact_access_service').ContactAccessService;
    let AuditService: typeof import('../../src/services/audit_service').AuditService;

    const SUPER: any = { staffUserId: 'ACTOR_SUPER', roles: [StaffRole.SUPER_ADMIN], isLegacy: false };
    let seq = 0;
    const uniq = () => `${Date.now()}${++seq}`;

    const makeStaff = async (over: Partial<{ roles: StaffRole[]; email: string; phone: string }> = {}) => {
        const n = uniq();
        return StaffService.createStaff(SUPER, {
            firstName: 'Test',
            lastName: `User${n}`,
            email: over.email ?? `staff${n}@kekeride.test`,
            phone: over.phone ?? `080${n.slice(-8)}`,
            roles: over.roles ?? [StaffRole.SUPPORT_OFFICER],
        });
    };

    /** Create an account and set a password, so it can actually sign in. */
    const makeActiveStaff = async (password = 'Correct-Horse-99', over: any = {}) => {
        const created = await makeStaff(over);
        await StaffService.completeSetup(created.setupToken, password);
        return created.staff;
    };

    beforeAll(async () => {
        // dropSchema drops the schema but does not recreate it, so it has to
        // exist before the real DataSource synchronises into it.
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS staff_identity_test');
        await bootstrap.destroy();

        // Own Postgres schema, not `public`.
        //
        // Jest runs test FILES in parallel workers against the same
        // TEST_DATABASE_URL, so any two suites sharing `public` with
        // dropSchema:true means whichever starts second drops the other's
        // tables mid-run. Every integration suite here is now scoped to a
        // private schema, which also stops a stray TEST_DATABASE_URL from
        // dropping a real database's public schema.
        ds = new DataSource({
            type: 'postgres',
            url: TEST_DB,
            schema: 'staff_identity_test',
            entities: [StaffUser, StaffRoleAssignment, StaffSession, StaffAuditEvent, ContactRevealEvent, Ride, User, DeviceToken],
            synchronize: true,
            dropSchema: true,
        });
        await ds.initialize();

        // Point the services' AppDataSource at this disposable instance.
        const dataSourceModule = await import('../../src/config/data_source');
        (dataSourceModule as any).AppDataSource = ds;
        Object.defineProperty(dataSourceModule, 'AppDataSource', { value: ds, writable: true, configurable: true });

        StaffService = (await import('../../src/services/staff_service')).StaffService;
        const authModule = await import('../../src/services/staff_auth_service');
        StaffAuthService = authModule.StaffAuthService;
        StaffAuthError = authModule.StaffAuthError;
        ContactAccessService = (await import('../../src/services/contact_access_service')).ContactAccessService;
        AuditService = (await import('../../src/services/audit_service')).AuditService;
    }, 60_000);

    afterAll(async () => {
        if (ds?.isInitialized) await ds.destroy();
    });

    // ── creation and uniqueness ─────────────────────────────────────────
    describe('creation', () => {
        it('1 — creates a staff account in INVITED state with a single-use setup token', async () => {
            const { staff, setupToken, setupTokenExpiresAt } = await makeStaff({ roles: [StaffRole.OPERATIONS_ADMIN] });

            expect(staff.status).toBe(StaffStatus.INVITED);
            expect(staff.roles).toEqual([StaffRole.OPERATIONS_ADMIN]);
            expect(setupToken.length).toBeGreaterThan(20);
            expect(setupTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());

            // Stored as a hash, never as the token itself.
            const row = await ds.getRepository(StaffUser).findOneBy({ id: staff.id });
            expect(row!.setupTokenHash).not.toBe(setupToken);
            expect(row!.passwordHash).toBeNull();
        });

        it('an INVITED account holds no permissions until its password is set', async () => {
            const { staff } = await makeStaff({ roles: [StaffRole.SUPER_ADMIN] });
            expect(staff.permissions).toEqual([]);
        });

        it('2 — rejects a duplicate email', async () => {
            const email = `dupe${uniq()}@kekeride.test`;
            await makeStaff({ email });
            await expect(makeStaff({ email })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('3 — rejects a duplicate phone, including a differently-formatted one', async () => {
            const phone = '08033344455';
            await makeStaff({ phone });
            // Same human number, international shape — normalisation must catch it.
            await expect(makeStaff({ phone: '+2348033344455' })).rejects.toMatchObject({ statusCode: 409 });
        });

        it('rejects an unknown role rather than silently dropping it', async () => {
            await expect(StaffService.createStaff(SUPER, {
                firstName: 'X', lastName: 'Y', email: `bad${uniq()}@k.test`, phone: `080${uniq().slice(-8)}`,
                roles: ['ROOT'],
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('17 — records an audit event naming the creator', async () => {
            const { staff } = await makeStaff();
            const events = await ds.getRepository(StaffAuditEvent).find({
                where: { resourceId: staff.id, action: 'STAFF_CREATED' },
            });
            expect(events).toHaveLength(1);
            expect(events[0].actorStaffUserId).toBe('ACTOR_SUPER');
            expect(events[0].actorIsLegacy).toBe(false);
            expect(events[0].actorRoleSnapshot).toBe(StaffRole.SUPER_ADMIN);
        });
    });

    // ── login ───────────────────────────────────────────────────────────
    describe('login', () => {
        it('4 — a valid credential opens a session and returns a usable token', async () => {
            const staff = await makeActiveStaff();
            const result = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });

            expect(result.accessToken).toBeTruthy();
            expect(result.refreshToken).toBeTruthy();
            const identity = await StaffAuthService.identify(result.accessToken);
            expect(identity?.staffUserId).toBe(staff.id);
            expect(identity?.permissions.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(true);
        });

        it('5 — an invalid password is refused', async () => {
            const staff = await makeActiveStaff();
            await expect(StaffAuthService.login({ email: staff.email, password: 'wrong-password' }))
                .rejects.toBeInstanceOf(StaffAuthError);
        });

        it('an unknown email is refused with the same failure kind — no enumeration oracle', async () => {
            await expect(StaffAuthService.login({ email: 'nobody@kekeride.test', password: 'x' }))
                .rejects.toMatchObject({ kind: 'invalid_credentials' });
        });

        it('6 — repeated failures lock the account, and the lock is then enforced', async () => {
            const staff = await makeActiveStaff();
            for (let i = 0; i < 5; i += 1) {
                await expect(StaffAuthService.login({ email: staff.email, password: 'nope' })).rejects.toThrow();
            }
            const row = await ds.getRepository(StaffUser).findOneBy({ id: staff.id });
            expect(row!.status).toBe(StaffStatus.LOCKED);
            expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

            // Even the CORRECT password is refused while the lock holds.
            await expect(StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' }))
                .rejects.toMatchObject({ kind: 'account_locked' });
        });

        it('a successful login clears the failure counter', async () => {
            const staff = await makeActiveStaff();
            await expect(StaffAuthService.login({ email: staff.email, password: 'nope' })).rejects.toThrow();
            await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            const row = await ds.getRepository(StaffUser).findOneBy({ id: staff.id });
            expect(row!.failedLoginCount).toBe(0);
        });

        it('7 — a suspended account cannot sign in', async () => {
            const staff = await makeActiveStaff();
            await StaffService.suspend(SUPER, staff.id, 'left the company');
            await expect(StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' }))
                .rejects.toMatchObject({ kind: 'account_suspended' });
        });

        it('8 — a deactivated account cannot sign in', async () => {
            const staff = await makeActiveStaff();
            await StaffService.deactivate(SUPER, staff.id, 'contract ended');
            await expect(StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' }))
                .rejects.toMatchObject({ kind: 'account_deactivated' });
        });

        it('an INVITED account with no password cannot sign in', async () => {
            const { staff } = await makeStaff();
            await expect(StaffAuthService.login({ email: staff.email, password: 'anything' }))
                .rejects.toMatchObject({ kind: 'account_not_set_up' });
        });
    });

    // ── setup tokens ────────────────────────────────────────────────────
    describe('setup tokens', () => {
        it('a setup token works exactly once', async () => {
            const created = await makeStaff();
            await StaffService.completeSetup(created.setupToken, 'Correct-Horse-99');
            await expect(StaffService.completeSetup(created.setupToken, 'Another-Pass-11'))
                .rejects.toMatchObject({ statusCode: 400 });
        });

        it('a weak password is refused at setup', async () => {
            const created = await makeStaff();
            await expect(StaffService.completeSetup(created.setupToken, 'short')).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    // ── suspension, reactivation, roles ──────────────────────────────────
    describe('27, 28 — suspension and reactivation', () => {
        it('suspension removes authority immediately from a live session', async () => {
            const staff = await makeActiveStaff();
            const { accessToken } = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            expect(await StaffAuthService.identify(accessToken)).not.toBeNull();

            await StaffService.suspend(SUPER, staff.id, 'under investigation');

            // The token is still cryptographically valid — and useless.
            expect(StaffAuthService.verifyAccessToken(accessToken)).not.toBeNull();
            expect(await StaffAuthService.identify(accessToken)).toBeNull();
        });

        it('suspension requires a reason and records it', async () => {
            const staff = await makeActiveStaff();
            await expect(StaffService.suspend(SUPER, staff.id, '   ')).rejects.toMatchObject({ statusCode: 400 });

            await StaffService.suspend(SUPER, staff.id, 'policy breach');
            const event = await ds.getRepository(StaffAuditEvent).findOne({
                where: { resourceId: staff.id, action: 'STAFF_SUSPENDED' },
            });
            expect(event!.reason).toBe('policy breach');
        });

        it('reactivation restores a suspended account to ACTIVE', async () => {
            const staff = await makeActiveStaff();
            await StaffService.suspend(SUPER, staff.id, 'temporary');
            const restored = await StaffService.reactivate(SUPER, staff.id);
            expect(restored.status).toBe(StaffStatus.ACTIVE);
            await expect(StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' })).resolves.toBeTruthy();
        });

        it('reactivating an account that never set a password returns it to INVITED, not ACTIVE', async () => {
            const { staff } = await makeStaff();
            await StaffService.suspend(SUPER, staff.id, 'paused onboarding');
            const restored = await StaffService.reactivate(SUPER, staff.id);
            expect(restored.status).toBe(StaffStatus.INVITED);
        });

        it('a deactivated account cannot be reactivated', async () => {
            const staff = await makeActiveStaff();
            await StaffService.deactivate(SUPER, staff.id, 'gone');
            await expect(StaffService.reactivate(SUPER, staff.id)).rejects.toMatchObject({ statusCode: 400 });
        });

        it('nobody can suspend or deactivate their own account', async () => {
            const staff = await makeActiveStaff();
            const self: any = { staffUserId: staff.id, roles: [StaffRole.SUPER_ADMIN], isLegacy: false };
            await expect(StaffService.suspend(self, staff.id, 'oops')).rejects.toMatchObject({ statusCode: 400 });
            await expect(StaffService.deactivate(self, staff.id, 'oops')).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    describe('13 — role changes', () => {
        it('a role change invalidates existing sessions', async () => {
            const staff = await makeActiveStaff();
            const { accessToken } = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            expect(await StaffAuthService.identify(accessToken)).not.toBeNull();

            await StaffService.setRoles(SUPER, staff.id, [StaffRole.READ_ONLY_ANALYST], 'moved team');

            expect(await StaffAuthService.identify(accessToken)).toBeNull();
        });

        it('the new permission set takes effect on the next sign-in', async () => {
            const staff = await makeActiveStaff();
            await StaffService.setRoles(SUPER, staff.id, [StaffRole.READ_ONLY_ANALYST], 'moved team');

            const { accessToken } = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            const identity = await StaffAuthService.identify(accessToken);
            // Was SUPPORT_OFFICER, which could reveal contacts. Now it cannot.
            expect(identity!.permissions.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(false);
            expect(identity!.permissions.has(StaffPermission.AUDIT_READ)).toBe(true);
        });

        it('removing a role requires a reason; adding one does not', async () => {
            const staff = await makeActiveStaff();
            await expect(StaffService.setRoles(SUPER, staff.id, [StaffRole.CASHIER], null))
                .rejects.toMatchObject({ statusCode: 400 });
            await expect(StaffService.setRoles(SUPER, staff.id, [StaffRole.SUPPORT_OFFICER, StaffRole.CASHIER], null))
                .resolves.toBeTruthy();
        });

        it('a revoked grant is retained with a timestamp, never deleted', async () => {
            const staff = await makeActiveStaff();
            await StaffService.setRoles(SUPER, staff.id, [StaffRole.CASHIER], 'reassigned');

            const all = await ds.getRepository(StaffRoleAssignment).find({ where: { staffUserId: staff.id } });
            const revoked = all.find((r) => r.role === StaffRole.SUPPORT_OFFICER);
            expect(revoked).toBeDefined();
            expect(revoked!.revokedAt).not.toBeNull();
            expect(revoked!.revokeReason).toBe('reassigned');
        });

        it('an empty role set is refused', async () => {
            const staff = await makeActiveStaff();
            await expect(StaffService.setRoles(SUPER, staff.id, [], 'none')).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    // ── sessions ────────────────────────────────────────────────────────
    describe('29 — credential reset and session revocation', () => {
        it('a credential reset invalidates every existing session', async () => {
            const staff = await makeActiveStaff();
            const a = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            const b = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });

            await StaffService.resetCredentials(SUPER, staff.id, 'suspected compromise');

            expect(await StaffAuthService.identify(a.accessToken)).toBeNull();
            expect(await StaffAuthService.identify(b.accessToken)).toBeNull();
            expect(await StaffAuthService.refresh(a.refreshToken)).toBeNull();
        });

        it('the old password stops working the moment credentials are reset', async () => {
            const staff = await makeActiveStaff();
            await StaffService.resetCredentials(SUPER, staff.id, 'rotation');
            await expect(StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' }))
                .rejects.toMatchObject({ kind: 'account_not_set_up' });
        });

        it('the reset token sets a new password and restores access', async () => {
            const staff = await makeActiveStaff();
            const reset = await StaffService.resetCredentials(SUPER, staff.id, 'rotation');
            await StaffService.completeSetup(reset.setupToken, 'Brand-New-Pass-7');
            await expect(StaffAuthService.login({ email: staff.email, password: 'Brand-New-Pass-7' })).resolves.toBeTruthy();
        });

        it('refresh rotates the token so a stolen one is usable at most once', async () => {
            const staff = await makeActiveStaff();
            const { refreshToken } = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });

            const first = await StaffAuthService.refresh(refreshToken);
            expect(first).not.toBeNull();
            expect(first!.refreshToken).not.toBe(refreshToken);

            // Replaying the original now fails.
            expect(await StaffAuthService.refresh(refreshToken)).toBeNull();
        });

        it('logging out one session leaves the others alone', async () => {
            const staff = await makeActiveStaff();
            const a = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });
            const b = await StaffAuthService.login({ email: staff.email, password: 'Correct-Horse-99' });

            await StaffAuthService.revokeSession(a.session.id, 'logout');

            expect(await StaffAuthService.identify(a.accessToken)).toBeNull();
            expect(await StaffAuthService.identify(b.accessToken)).not.toBeNull();
        });
    });

    // ── output shaping ──────────────────────────────────────────────────
    describe('30 — no response ever carries a secret field', () => {
        it('the staff DTO omits every credential field', async () => {
            const staff = await makeActiveStaff();
            const dto = await StaffService.getById(staff.id);
            const serialized = JSON.stringify(dto);

            for (const forbidden of ['passwordHash', 'mfaSecret', 'setupTokenHash', 'credentialVersion', '$2a$', '$2b$']) {
                expect(serialized).not.toContain(forbidden);
            }
            expect(dto).toHaveProperty('permissions');
        });

        it('26 — the list endpoint pages and filters without leaking secrets', async () => {
            await makeActiveStaff('Correct-Horse-99', { roles: [StaffRole.CASHIER] });
            await makeActiveStaff('Correct-Horse-99', { roles: [StaffRole.CASHIER] });

            const page1 = await StaffService.list({ role: StaffRole.CASHIER, page: 1, pageSize: 1 });
            expect(page1.items).toHaveLength(1);
            expect(page1.total).toBeGreaterThanOrEqual(2);
            expect(page1.pageSize).toBe(1);

            const page2 = await StaffService.list({ role: StaffRole.CASHIER, page: 2, pageSize: 1 });
            expect(page2.items[0].id).not.toBe(page1.items[0].id);
            expect(JSON.stringify(page1)).not.toContain('passwordHash');
        });

        it('filters by status', async () => {
            const staff = await makeActiveStaff();
            await StaffService.suspend(SUPER, staff.id, 'test');
            const suspended = await StaffService.list({ status: StaffStatus.SUSPENDED, pageSize: 100 });
            expect(suspended.items.some((s) => s.id === staff.id)).toBe(true);

            const active = await StaffService.list({ status: StaffStatus.ACTIVE, pageSize: 100 });
            expect(active.items.some((s) => s.id === staff.id)).toBe(false);
        });

        it('caps an oversized page size rather than honouring it', async () => {
            const result = await StaffService.list({ pageSize: 100_000 });
            expect(result.pageSize).toBeLessThanOrEqual(100);
        });
    });

    // ── contact privacy ─────────────────────────────────────────────────
    describe('19–23 — contact access', () => {
        const makeRide = async (over: Partial<Ride> = {}) => {
            const passenger = await ds.getRepository(User).save(ds.getRepository(User).create({
                email: `pax${uniq()}@k.test`,
                phone: '2348012345678',
                password: 'x',
                firstName: 'Pax',
                lastName: 'Enger',
                role: UserRole.PASSENGER,
            }));
            const ride = await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
                rideId: `RIDE-${uniq()}`,
                passengerId: passenger.id,
                driverId: `driver-${uniq()}`,
                fare: 1500,
                paymentMode: 'cash',
                status: 'accepted' as any,
                ...over,
            }));
            return { ride, passenger };
        };

        it('21 — a masked contact is available and is not dialable', async () => {
            const { passenger } = await makeRide();
            const masked = await ContactAccessService.maskedPassengerContact(passenger.id);
            expect(masked!.dialable).toBe(false);
            expect(masked!.phoneMasked).toBe('0801••••678');
            expect(masked!.phoneMasked).not.toContain('2345');
        });

        it('23 — the ASSIGNED driver gets the real number', async () => {
            const { ride } = await makeRide();
            const contact = await ContactAccessService.passengerContactForAssignedDriver(ride.rideId, ride.driverId);
            expect(contact.dialable).toBe(true);
            expect(contact.phone).toBe('08012345678');
            expect(contact.expiresAt.getTime()).toBeGreaterThan(Date.now());
        });

        it('22 — a driver who is NOT assigned is refused', async () => {
            const { ride } = await makeRide();
            await expect(ContactAccessService.passengerContactForAssignedDriver(ride.rideId, 'some-other-driver'))
                .rejects.toMatchObject({ statusCode: 404 });
        });

        it('a ride still searching has no assigned driver, so nobody can fetch contact', async () => {
            const { ride } = await makeRide({ status: 'searching' as any, driverId: null as any });
            await expect(ContactAccessService.passengerContactForAssignedDriver(ride.rideId, 'anyone'))
                .rejects.toMatchObject({ statusCode: 404 });
        });

        it('20 — every driver access writes a ContactRevealEvent', async () => {
            const { ride, passenger } = await makeRide();
            await ContactAccessService.passengerContactForAssignedDriver(ride.rideId, ride.driverId);

            const reveals = await ds.getRepository(ContactRevealEvent).find({ where: { rideId: ride.rideId } });
            expect(reveals).toHaveLength(1);
            expect(reveals[0].actorType).toBe('assigned_driver');
            expect(reveals[0].actorId).toBe(ride.driverId);
            expect(reveals[0].subjectUserId).toBe(passenger.id);
            // The record says WHICH fields were shown, never their values.
            expect(reveals[0].fields).toBe('firstName,phone');
            expect(JSON.stringify(reveals[0])).not.toContain('08012345678');
        });

        it('19, 20 — a staff reveal demands a reason and is audited critically', async () => {
            const { ride } = await makeRide();
            const actor: any = { staffUserId: 'ACTOR_SUPPORT', roles: [StaffRole.SUPPORT_OFFICER], isLegacy: false };

            await expect(ContactAccessService.revealPassengerContactForStaff({
                rideId: ride.rideId, actor, reason: '   ',
            })).rejects.toMatchObject({ statusCode: 400 });

            const contact = await ContactAccessService.revealPassengerContactForStaff({
                rideId: ride.rideId, actor, reason: 'passenger called about a lost bag',
            });
            expect(contact.dialable).toBe(true);

            const audit = await ds.getRepository(StaffAuditEvent).findOne({
                where: { rideId: ride.rideId, action: 'CONTACT_REVEALED' },
            });
            expect(audit).not.toBeNull();
            expect(audit!.reason).toBe('passenger called about a lost bag');
            expect(audit!.actorStaffUserId).toBe('ACTOR_SUPPORT');
            expect(JSON.stringify(audit!.metadata)).not.toContain('08012345678');
        });

        it('a staff reveal is time-boxed', async () => {
            const { ride } = await makeRide();
            const contact = await ContactAccessService.revealPassengerContactForStaff({
                rideId: ride.rideId,
                actor: { staffUserId: 'ACTOR_SUPPORT', roles: [StaffRole.SUPPORT_OFFICER], isLegacy: false } as any,
                reason: 'incident',
            });
            const minutesOut = (contact.expiresAt.getTime() - Date.now()) / 60_000;
            expect(minutesOut).toBeGreaterThan(0);
            expect(minutesOut).toBeLessThanOrEqual(31);
        });
    });

    // ── the compatibility layer ─────────────────────────────────────────
    describe('24, 25 — dispatch offer contact compatibility', () => {
        const passengerFixture = { firstName: 'Pax', phone: '2348012345678' };
        const originalMode = process.env.CONTACT_PRIVACY_MODE;
        const originalMin = process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION;

        afterEach(() => {
            if (originalMode == null) delete process.env.CONTACT_PRIVACY_MODE;
            else process.env.CONTACT_PRIVACY_MODE = originalMode;
            if (originalMin == null) delete process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION;
            else process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION = originalMin;
        });

        const registerDevice = async (driverId: string, appVersion: string | null) => {
            const repo = ds.getRepository(DeviceToken);
            await repo.save(repo.create({
                userId: driverId,
                role: UserRole.DRIVER,
                platform: 'android',
                token: `tok-${uniq()}`,
                isActive: true,
                appVersion,
            }));
        };

        it('the DEFAULT mode is byte-identical to the previous behaviour', async () => {
            delete process.env.CONTACT_PRIVACY_MODE;
            const fields = await ContactAccessService.offerContactFields('driver-x', passengerFixture);
            expect(fields).toEqual({ passengerPhone: '08012345678' });
        });

        it('24 — an app that has never reported a version keeps the legacy payload', async () => {
            process.env.CONTACT_PRIVACY_MODE = 'strict_versioned';
            process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION = '2.0.0';

            const driverId = `driver-old-${uniq()}`;
            await registerDevice(driverId, null);

            const fields = await ContactAccessService.offerContactFields(driverId, passengerFixture);
            expect(fields.passengerPhone).toBe('08012345678');
        });

        it('an app below the minimum version keeps the legacy payload', async () => {
            process.env.CONTACT_PRIVACY_MODE = 'strict_versioned';
            process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION = '2.0.0';

            const driverId = `driver-1x-${uniq()}`;
            await registerDevice(driverId, '1.9.4');

            const fields = await ContactAccessService.offerContactFields(driverId, passengerFixture);
            expect(fields.passengerPhone).toBe('08012345678');
        });

        it('25 — an app at or above the minimum receives NO contact in the offer', async () => {
            process.env.CONTACT_PRIVACY_MODE = 'strict_versioned';
            process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION = '2.0.0';

            const driverId = `driver-new-${uniq()}`;
            await registerDevice(driverId, '2.1.0');

            const fields = await ContactAccessService.offerContactFields(driverId, passengerFixture);
            expect(fields.passengerPhone).toBeNull();
            expect(JSON.stringify(fields)).not.toContain('08012345678');
        });

        it('masked_versioned gives a new app a masked number and no dialable one', async () => {
            process.env.CONTACT_PRIVACY_MODE = 'masked_versioned';
            process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION = '2.0.0';

            const driverId = `driver-mask-${uniq()}`;
            await registerDevice(driverId, '2.0.0');

            const fields = await ContactAccessService.offerContactFields(driverId, passengerFixture);
            expect(fields.passengerPhone).toBeNull();
            expect(fields.passengerPhoneMasked).toBe('0801••••678');
        });

        it('strict withholds contact from every app, regardless of version', async () => {
            process.env.CONTACT_PRIVACY_MODE = 'strict';
            const driverId = `driver-strict-${uniq()}`;
            await registerDevice(driverId, '1.0.0');

            const fields = await ContactAccessService.offerContactFields(driverId, passengerFixture);
            expect(fields.passengerPhone).toBeNull();
        });
    });

    // ── audit durability ────────────────────────────────────────────────
    describe('audit trail', () => {
        it('a critical audit failure aborts the operation instead of proceeding unrecorded', async () => {
            const spy = jest.spyOn(ds.getRepository(StaffAuditEvent), 'save')
                .mockRejectedValueOnce(new Error('disk full'));
            try {
                await expect(AuditService.recordCritical({
                    actor: { staffUserId: 'ACTOR', roles: [], isLegacy: false },
                    action: 'CONTACT_REVEALED',
                    resourceType: 'RIDE_CONTACT',
                    reason: 'test',
                })).rejects.toThrow(/Audit write failed/);
            } finally {
                spy.mockRestore();
            }
        });

        it('a best-effort audit failure is surfaced through the hook, not swallowed', async () => {
            const failures: any[] = [];
            AuditService.setFailureHook((input, error) => failures.push({ input, error }));
            const spy = jest.spyOn(ds.getRepository(StaffAuditEvent), 'save')
                .mockRejectedValueOnce(new Error('transient'));
            try {
                await AuditService.record({
                    actor: { staffUserId: 'ACTOR', roles: [], isLegacy: false },
                    action: 'STAFF_LOGIN_SUCCEEDED',
                    resourceType: 'STAFF_SESSION',
                });
                expect(failures).toHaveLength(1);
                expect(failures[0].error.message).toBe('transient');
            } finally {
                spy.mockRestore();
                AuditService.setFailureHook(null);
            }
        });
    });
});
