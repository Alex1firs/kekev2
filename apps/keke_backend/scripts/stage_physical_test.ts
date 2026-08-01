/**
 * Stage a park for the physical acceptance test.
 *
 * Creates the three staff accounts, an ACTIVE pilot park with staging and
 * boarding zones, and a roster with both a smartphone driver and a
 * feature-phone driver — everything §2 of the launch brief asks for, in a state
 * a tester can walk up to and start using.
 *
 * ── Passwords ───────────────────────────────────────────────────────────
 * Read from the environment, one per role. Nothing is defaulted and nothing is
 * committed; generate them per run and hand them over out of band. The script
 * refuses to run against anything that does not look like a test database.
 *
 *   OPS_PASSWORD=… SUPERVISOR_PASSWORD=… DISPATCHER_PASSWORD=… \
 *   npx ts-node scripts/stage_physical_test.ts
 *
 * Unlike bootstrap_production.ts this ACTIVATES the park and opens nothing —
 * the dispatcher starts their own shift on the phone, because starting a shift
 * is one of the things under test.
 */
import 'reflect-metadata';
import { DeepPartial, Repository } from 'typeorm';
import { AppDataSource } from '../src/config/data_source';
import { StaffUser, StaffStatus } from '../src/models/StaffUser';
import { StaffRoleAssignment } from '../src/models/StaffRoleAssignment';
import { Park, ParkStatus } from '../src/models/Park';
import { ParkZone, ParkZoneKind } from '../src/models/ParkZone';
import { ParkDriverRoster, RosterStatus } from '../src/models/ParkDriverRoster';
import { DriverBadge, BadgeStatus } from '../src/models/DriverBadge';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../src/models/DriverPresence';
import { DriverProfile, DriverStatus } from '../src/models/DriverProfile';
import { User } from '../src/models/User';
import { Wallet } from '../src/models/Wallet';
import { StaffRole } from '../src/config/staff_permissions';
import { StaffAuthService } from '../src/services/staff_auth_service';

function mk<T extends object>(repo: Repository<T>, data: Record<string, unknown>): T {
    return repo.create(data as DeepPartial<T>);
}

/** The pilot park. Coordinates are the real Awka Main Park forecourt. */
const PARK = {
    code: 'AWK-PILOT',
    name: 'Awka Pilot Park',
    lat: 6.2109,
    lng: 7.0740,
    serviceRadiusKm: 4,
    operatingRadiusM: 250,
};

const STAFF = [
    { role: StaffRole.OPERATIONS_ADMIN, email: 'ops.test@kekeride.ng', phone: '08099000001', name: 'Ops Tester', env: 'OPS_PASSWORD', scoped: false },
    { role: StaffRole.PARK_SUPERVISOR, email: 'supervisor.test@kekeride.ng', phone: '08099000002', name: 'Super Tester', env: 'SUPERVISOR_PASSWORD', scoped: true },
    { role: StaffRole.PARK_DISPATCHER, email: 'dispatcher.test@kekeride.ng', phone: '08099000003', name: 'Dispatch Tester', env: 'DISPATCHER_PASSWORD', scoped: true },
];

/**
 * Two drivers, which is the minimum that makes the matrix meaningful: one who
 * can be sent an offer electronically, and one who can only be told out loud.
 */
const DRIVERS = [
    { first: 'Sunday', last: 'Okonkwo', unit: 'T101', phone: '08099100001', smartphone: true },
    { first: 'Ifeoma', last: 'Balogun', unit: 'T102', phone: '08099100002', smartphone: false },
];

/** A second park, so "another park is inaccessible" is testable against a real one. */
const OTHER_PARK = { code: 'AWK-OTHER', name: 'Other Park (scoping control)', lat: 6.35, lng: 7.20 };

function guard(): void {
    const url = process.env.DATABASE_URL || '';
    if (process.env.NODE_ENV === 'production') throw new Error('refusing to stage a test park in production');
    if (!/keke_demo|keke_test|keke_staging|localhost|127\.0\.0\.1/.test(url)) {
        throw new Error(`refusing: DATABASE_URL does not look like a test database (${url || 'unset'})`);
    }
}

async function main() {
    guard();

    const missing = STAFF.filter((s) => !process.env[s.env]).map((s) => s.env);
    if (missing.length) throw new Error(`Set these (generate them, do not reuse): ${missing.join(', ')}`);

    await AppDataSource.initialize();

    // ── park ─────────────────────────────────────────────────────────────
    const parks = AppDataSource.getRepository(Park);
    let park = await parks.findOneBy({ code: PARK.code });
    if (!park) {
        park = await parks.save(mk(parks, {
            name: PARK.name, code: PARK.code, lat: PARK.lat, lng: PARK.lng,
            city: 'Awka', state: 'Anambra',
            serviceRadiusKm: PARK.serviceRadiusKm, operatingRadiusM: PARK.operatingRadiusM,
            capacityDrivers: 40, maxConcurrentAssignments: 3,
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
            status: ParkStatus.ACTIVE,
            createdByStaffId: 'PHYSICAL_TEST',
        }));
    } else if (park.status !== ParkStatus.ACTIVE) {
        park.status = ParkStatus.ACTIVE;
        await parks.save(park);
    }
    console.log(`park       ${park.code} ${park.status}  ${PARK.lat},${PARK.lng}  radius ${PARK.serviceRadiusKm}km`);

    // A second ACTIVE park the dispatcher is NOT assigned to. Without it,
    // "another park is inaccessible" is untestable — there is nothing to try.
    let other = await parks.findOneBy({ code: OTHER_PARK.code });
    if (!other) {
        other = await parks.save(mk(parks, {
            name: OTHER_PARK.name, code: OTHER_PARK.code,
            lat: OTHER_PARK.lat, lng: OTHER_PARK.lng, city: 'Awka', state: 'Anambra',
            serviceRadiusKm: 3, operatingRadiusM: 200, capacityDrivers: 10,
            maxConcurrentAssignments: 2, daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
            status: ParkStatus.ACTIVE, createdByStaffId: 'PHYSICAL_TEST',
        }));
    }
    console.log(`park       ${other.code} ${other.status}  (scoping control — dispatcher must NOT see this)`);

    // ── zones ────────────────────────────────────────────────────────────
    const zones = AppDataSource.getRepository(ParkZone);
    for (const z of [
        { name: 'Staging shed', code: 'STAGE-A', kind: ParkZoneKind.STAGING, lat: PARK.lat, lng: PARK.lng },
        { name: 'Boarding bay', code: 'BOARD-A', kind: ParkZoneKind.BOARDING, lat: PARK.lat + 0.0004, lng: PARK.lng + 0.0004 },
    ]) {
        if (!await zones.findOne({ where: { parkId: park.parkId, code: z.code } })) {
            await zones.save(mk(zones, { parkId: park.parkId, ...z }));
        }
        console.log(`zone       ${z.code.padEnd(9)} ${z.kind}`);
    }

    // ── staff ────────────────────────────────────────────────────────────
    const staffRepo = AppDataSource.getRepository(StaffUser);
    const roleRepo = AppDataSource.getRepository(StaffRoleAssignment);

    for (const s of STAFF) {
        const password = process.env[s.env]!;
        const policy = StaffAuthService.validatePassword(password);
        if (!policy.ok) throw new Error(`${s.env}: ${policy.message}`);

        const [firstName, ...rest] = s.name.split(' ');
        let u = await staffRepo.findOneBy({ email: s.email });
        const passwordHash = await StaffAuthService.hashPassword(password);

        if (!u) {
            u = await staffRepo.save(mk(staffRepo, {
                email: s.email, phone: s.phone, firstName, lastName: rest.join(' '),
                passwordHash, status: StaffStatus.ACTIVE, credentialVersion: 1,
            }));
        } else {
            u.passwordHash = passwordHash;
            u.status = StaffStatus.ACTIVE;
            u.failedLoginCount = 0;
            u.lockedUntil = null;
            await staffRepo.save(u);
        }

        if (!await roleRepo.findOne({ where: { staffUserId: u!.id, role: s.role as any } })) {
            await roleRepo.save(mk(roleRepo, {
                staffUserId: u!.id, role: s.role as any,
                // The dispatcher and supervisor are scoped to the PILOT park
                // only. That scoping is what scenario "another park is
                // inaccessible" actually tests.
                parkId: s.scoped ? park.parkId : null,
                grantedByStaffId: 'PHYSICAL_TEST', grantedAt: new Date(),
            }));
        }
        console.log(`staff      ${s.email.padEnd(30)} ${s.role}${s.scoped ? ` @ ${park.code}` : ' (global)'}`);
    }

    // ── drivers ──────────────────────────────────────────────────────────
    const users = AppDataSource.getRepository(User);
    const profiles = AppDataSource.getRepository(DriverProfile);
    const roster = AppDataSource.getRepository(ParkDriverRoster);
    const badges = AppDataSource.getRepository(DriverBadge);
    const presence = AppDataSource.getRepository(DriverPresence);
    const wallets = AppDataSource.getRepository(Wallet);

    // Drivers sign in on real phones, so they need a real password too.
    const driverPassword = process.env.DRIVER_PASSWORD || process.env.DISPATCHER_PASSWORD!;
    const driverHash = await StaffAuthService.hashPassword(driverPassword);

    let queuePos = 1;
    for (const d of DRIVERS) {
        const email = `test.${d.unit.toLowerCase()}@kekeride.ng`;
        let u = await users.findOneBy({ email });
        if (!u) {
            u = await users.save(mk(users, {
                email, phone: d.phone, firstName: d.first, lastName: d.last,
                role: 'driver', password: driverHash, emailVerified: true,
            }));
        }

        if (!await profiles.findOneBy({ userId: u!.id })) {
            await profiles.save(mk(profiles, {
                userId: u!.id, firstName: d.first, lastName: d.last,
                vehiclePlate: `AWK-${d.unit}`, vehicleModel: 'Keke NAPEP',
                status: DriverStatus.APPROVED,
                // Selfie KYC gates dispatch eligibility.
                photoUrl: 'test/driver.jpg',
                unitNumber: d.unit,
                deviceCapability: d.smartphone ? 'smartphone' : 'feature_phone',
            }));
        } else {
            await profiles.update({ userId: u!.id }, {
                deviceCapability: d.smartphone ? 'smartphone' : 'feature_phone',
                unitNumber: d.unit,
            } as any);
        }

        if (!await wallets.findOneBy({ userId: u!.id })) {
            await wallets.save(mk(wallets, { userId: u!.id }));
        }

        if (!await roster.findOne({ where: { parkId: park.parkId, driverId: u!.id } })) {
            await roster.save(mk(roster, {
                parkId: park.parkId, driverId: u!.id, status: RosterStatus.ACTIVE,
                queuePosition: queuePos++, queuedAt: new Date(), joinedAt: new Date(),
            }));
        }

        if (!await badges.findOne({ where: { driverId: u!.id } })) {
            await badges.save(mk(badges, {
                driverId: u!.id, parkId: park.parkId,
                badgeSerial: `TEST-${d.unit}`, shortCode: d.unit.replace('T', '7'),
                driverPublicId: `TEST${d.unit}`, keyVersion: 1,
                status: BadgeStatus.ACTIVE, issuedAt: new Date(),
                issuedByStaffId: 'PHYSICAL_TEST', activatedAt: new Date(),
            }));
        }

        let pr = await presence.findOneBy({ driverId: u!.id });
        if (!pr) pr = mk(presence, { driverId: u!.id });
        pr.state = DriverPresenceState.WAITING;
        pr.parkId = park.parkId;
        pr.since = new Date();
        pr.source = PresenceSource.DISPATCHER;
        await presence.save(pr);

        console.log(`driver     ${d.unit}  ${(d.first + ' ' + d.last).padEnd(18)} `
            + `${d.smartphone ? 'smartphone' : 'FEATURE PHONE'}  badge  waiting  ${email}`);
    }

    // ── a passenger to book with ─────────────────────────────────────────
    const paxEmail = 'test.passenger@kekeride.ng';
    if (!await users.findOneBy({ email: paxEmail })) {
        await users.save(mk(users, {
            email: paxEmail, phone: '08099200001', firstName: 'Amaka', lastName: 'Tester',
            role: 'passenger', password: driverHash, emailVerified: true,
        }));
    }
    console.log(`passenger  ${paxEmail}`);

    console.log('\nNo shift is opened — starting one on the phone is part of the test.');
    await AppDataSource.destroy();
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
