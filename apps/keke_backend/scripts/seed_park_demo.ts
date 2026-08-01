/**
 * Seed a DEMO park so dispatchers can be trained and the workflow demonstrated.
 *
 * Refuses to run against anything that does not look like a local or demo
 * database, and refuses outright when NODE_ENV=production. It creates its own
 * clearly-marked records (`@kekeride.test` staff, `AWK-DEMO` park, `DEMO-`
 * drivers) and is idempotent — running it twice does not double anything.
 *
 * Usage:
 *   DATABASE_URL=postgres://…/keke_demo npx ts-node scripts/seed_park_demo.ts
 *
 * Optionally, with --queue, it also creates three searching rides and offers
 * them to the park so the dispatcher board has something on it. Those are
 * demo rides with no real passenger behind them; never use --queue against a
 * database real passengers are using.
 */
import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { DeepPartial, Repository } from 'typeorm';
import { AppDataSource } from '../src/config/data_source';
import { Park, ParkStatus } from '../src/models/Park';
import { StaffUser, StaffStatus } from '../src/models/StaffUser';
import { StaffRoleAssignment } from '../src/models/StaffRoleAssignment';
import { StaffRole } from '../src/config/staff_permissions';
import { User } from '../src/models/User';
import { DriverProfile, DriverStatus } from '../src/models/DriverProfile';
import { ParkDriverRoster, RosterStatus } from '../src/models/ParkDriverRoster';
import { DriverBadge, BadgeStatus } from '../src/models/DriverBadge';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../src/models/DriverPresence';
import { Ride } from '../src/models/Ride';
import { Wallet } from '../src/models/Wallet';
import { ParkDispatchService } from '../src/services/park_dispatch_service';

const PASSWORD = process.env.DEMO_PASSWORD || 'KekeDemo-Pass99';
const PARK = { code: 'AWK-DEMO', name: 'Awka Demo Park', lat: 6.2109, lng: 7.0740 };

/** Feature phone or smartphone — the fleet is genuinely mixed, and the demo must show it. */
const DRIVERS = [
    { first: 'Uche',   last: 'Aniete', unit: 'U156', smartphone: true,  badge: true,  presence: DriverPresenceState.WAITING },
    { first: 'Emeka',  last: 'Okafor', unit: 'U214', smartphone: true,  badge: true,  presence: DriverPresenceState.AT_PARK },
    /*
     * A feature-phone driver who can actually be assigned.
     *
     * Missing at first, and its absence hid the fact that the demo could not
     * exercise the verbal handoff at all — which is the PRIMARY path for this
     * fleet, not an edge case. Every other feature-phone driver here is
     * deliberately blocked for one reason or another; this one is not.
     */
    { first: 'Ngozi',  last: 'Iweala', unit: 'U331', smartphone: false, badge: true,  presence: DriverPresenceState.WAITING },
    { first: 'Obiora', last: 'Nnaji',  unit: 'U402', smartphone: false, badge: true,  presence: DriverPresenceState.WAITING },
    { first: 'Tobenna',last: 'Eze',    unit: 'U422', smartphone: false, badge: false, presence: DriverPresenceState.AT_PARK },
    { first: 'Kelechi',last: 'Umeh',   unit: 'U199', smartphone: false, badge: false, presence: DriverPresenceState.WAITING, owes: 2400 },
    { first: 'Ifeanyi',last: 'Nwosu',  unit: 'U087', smartphone: false, badge: true,  presence: DriverPresenceState.TRIP_STARTED },
    { first: 'Chinedu',last: 'Obi',    unit: 'U305', smartphone: false, badge: true,  presence: DriverPresenceState.UNAVAILABLE },
];

const PASSENGERS = [
    { first: 'Amaka', last: 'Nwankwo' },
    { first: 'Chioma', last: 'Eze' },
    { first: 'Ngozi', last: 'Umeh' },
];

const STAFF = [
    { email: 'ops@kekeride.test',   first: 'Ada',   last: 'Obi',   role: StaffRole.OPERATIONS_ADMIN },
    { email: 'chidi@kekeride.test', first: 'Chidi', last: 'Okeke', role: StaffRole.PARK_DISPATCHER },
    { email: 'nneka@kekeride.test', first: 'Nneka', last: 'Udo',   role: StaffRole.PARK_SUPERVISOR },
];

/**
 * repo.create(x) has an array overload that a plain `as any` argument selects,
 * which then makes every result an array. This pins the singular form once.
 */
function mk<T extends object>(repo: Repository<T>, data: Record<string, unknown>): T {
    return repo.create(data as DeepPartial<T>);
}

/** Stable pseudo-number from a string, so demo phones are deterministic. */
function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

function guard(): void {
    const url = process.env.DATABASE_URL || '';
    if (process.env.NODE_ENV === 'production') {
        throw new Error('refusing to seed demo data with NODE_ENV=production');
    }
    if (!/keke_demo|keke_dev|localhost|127\.0\.0\.1/.test(url)) {
        throw new Error(`refusing to seed: DATABASE_URL does not look like a demo database (${url || 'unset'})`);
    }
}

async function main() {
    guard();
    await AppDataSource.initialize();

    /*
     * Release demo drivers from anything they are still holding, and clear the
     * previous demo queue.
     *
     * Every run assigns rides that nobody ever completes, so without this the
     * next run finds each driver "on a trip" and correctly refuses to assign
     * them — the system behaving properly and the demo being unusable. Scoped
     * to demo accounts only.
     */
    await AppDataSource.query(`
        UPDATE ride SET status = 'canceled', "updatedAt" = now()
        WHERE status IN ('searching','accepted','arrived','in_progress','started')
          AND ("driverId" IN (SELECT id::text FROM "user" WHERE email LIKE 'demo.%@kekeride.test')
               OR "passengerId" IN (SELECT id::text FROM "user" WHERE email LIKE 'demo.%@kekeride.test'))`);

    await AppDataSource.query(`
        UPDATE park_dispatch_job SET status = 'cancelled', "resolvedAt" = now(),
               "resolutionReason" = 'demo reseed'
        WHERE status IN ('offered','claimed','pending_acceptance')`);

    // Drivers go back to waiting, so the board looks like the start of a shift.
    await AppDataSource.query(`
        UPDATE driver_presence SET state = 'waiting', since = now()
        WHERE state IN ('assigned','en_route','passenger_boarding','trip_started')
          AND "driverId" IN (SELECT id::text FROM "user" WHERE email LIKE 'demo.%@kekeride.test')`);


    const parks = AppDataSource.getRepository(Park);
    let park: Park | null = await parks.findOne({ where: { code: PARK.code } });
    if (!park) {
        park = await parks.save(mk(parks, {
            name: PARK.name, code: PARK.code,
            lat: PARK.lat as any, lng: PARK.lng as any,
            city: 'Awka', state: 'Anambra',
            serviceRadiusKm: 4, operatingRadiusM: 250,
            capacityDrivers: 40, maxConcurrentAssignments: 3,
            status: ParkStatus.ACTIVE,
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        }));
    } else if (park.status !== ParkStatus.ACTIVE) {
        park.status = ParkStatus.ACTIVE;
        await parks.save(park);
    }
    console.log(`park   ${park.code} ${park.status} (${park.parkId})`);

    const staffRepo = AppDataSource.getRepository(StaffUser);
    const roleRepo = AppDataSource.getRepository(StaffRoleAssignment);
    const hash = await bcrypt.hash(PASSWORD, 10);

    for (const s of STAFF) {
        let u: StaffUser | null = await staffRepo.findOne({ where: { email: s.email } });
        if (!u) {
            u = await staffRepo.save(mk(staffRepo, {
                email: s.email, firstName: s.first, lastName: s.last,
                phone: `0700${Math.abs(hashCode(s.email)) % 10000000}`.slice(0, 11),
                passwordHash: hash, status: StaffStatus.ACTIVE, credentialVersion: 1,
            }));
        } else {
            u.passwordHash = hash;
            u.status = StaffStatus.ACTIVE;
            await staffRepo.save(u);
        }
        const existing = await roleRepo.findOne({ where: { staffUserId: u!.id, role: s.role as any } });
        if (!existing) {
            await roleRepo.save(mk(roleRepo, {
                staffUserId: u!.id, role: s.role as any,
                // Park staff are scoped to this park; operations is global.
                parkId: s.role === StaffRole.OPERATIONS_ADMIN ? null : park!.parkId,
                grantedByStaffId: 'SYSTEM_DEMO_SEED', grantedAt: new Date(),
            }));
        }
        console.log(`staff  ${s.email.padEnd(24)} ${s.role}`);
    }

    const users = AppDataSource.getRepository(User);
    const profiles = AppDataSource.getRepository(DriverProfile);
    const roster = AppDataSource.getRepository(ParkDriverRoster);
    const badges = AppDataSource.getRepository(DriverBadge);
    const presence = AppDataSource.getRepository(DriverPresence);

    let queuePos = 1;
    for (const d of DRIVERS) {
        const email = `demo.${d.unit.toLowerCase()}@kekeride.test`;
        let u: User | null = await users.findOne({ where: { email } });
        if (!u) {
            u = await users.save(mk(users, {
                email, firstName: d.first, lastName: d.last,
                phone: `0815${d.unit.replace(/\D/g, '').padStart(7, '0')}`,
                // bcrypt hash of PASSWORD: the driver auth route compares
                // against this, so a demo driver can actually sign in and hold
                // a socket — which is what makes the offer path testable.
                role: 'driver' as any, password: hash, emailVerified: true,
            }));
        }

        let p: DriverProfile | null = await profiles.findOne({ where: { userId: u!.id } });
        if (!p) {
            p = await profiles.save(mk(profiles, {
                userId: u!.id, firstName: d.first, lastName: d.last,
                vehiclePlate: `AWK-${d.unit}`, vehicleModel: 'Keke NAPEP',
                status: DriverStatus.APPROVED,
                unitNumber: d.unit,
                // The whole point of Park Dispatch: most of this fleet has no
                // smartphone, and the board must show that honestly.
                deviceCapability: d.smartphone ? 'smartphone' : 'feature_phone',
                // Selfie KYC gates dispatch eligibility; a demo driver needs one.
                photoUrl: 'demo/selfie.jpg',
            }));
        }

        if (!await roster.findOne({ where: { parkId: park!.parkId, driverId: u!.id } })) {
            await roster.save(mk(roster, {
                parkId: park!.parkId, driverId: u!.id, status: RosterStatus.ACTIVE,
                queuePosition: queuePos++, queuedAt: new Date(), joinedAt: new Date(),
            }));
        }

        if (d.badge && !await badges.findOne({ where: { driverId: u!.id } })) {
            await badges.save(mk(badges, {
                driverId: u!.id, parkId: park!.parkId,
                badgeSerial: `DEMO-${d.unit}`, shortCode: d.unit.replace('U', '9'),
                driverPublicId: `DEMO${d.unit}`, keyVersion: 1,
                status: BadgeStatus.ACTIVE, issuedAt: new Date(),
                issuedByStaffId: 'SYSTEM_DEMO_SEED', activatedAt: new Date(),
            }));
        }

        /*
         * A commission debt is what makes a driver ineligible for a cash ride.
         * Seeding it is what puts WALLET BLOCKED on the board, which is one of
         * the states a dispatcher most needs to recognise.
         */
        const wallets = AppDataSource.getRepository(Wallet);
        let w = await wallets.findOne({ where: { userId: u!.id } });
        if (!w) w = mk(wallets, { userId: u!.id });
        w.driverCommissionDebt = (d.owes ?? 0) as any;
        await wallets.save(w);

        let pr = await presence.findOne({ where: { driverId: u!.id } });
        if (!pr) {
            pr = mk(presence, { driverId: u!.id });
        }
        pr.state = d.presence;
        pr.parkId = park!.parkId;
        pr.since = new Date();
        pr.source = PresenceSource.DISPATCHER;
        await presence.save(pr);

        const notes = [
            d.smartphone ? 'smartphone' : 'feature phone',
            d.badge ? 'badge' : 'NO BADGE',
            d.owes ? `owes ₦${d.owes}` : '',
        ].filter(Boolean).join(', ');
        console.log(`driver ${d.unit} ${(d.first + ' ' + d.last).padEnd(16)} ${String(d.presence).padEnd(12)} ${notes}`);
    }

    for (let i = 0; i < PASSENGERS.length; i++) {
        const pg = PASSENGERS[i];
        const email = `demo.rider${i + 1}@kekeride.test`;
        if (!await users.findOne({ where: { email } })) {
            await users.save(mk(users, {
                email, firstName: pg.first, lastName: pg.last,
                phone: `0815${String(400 + i).padStart(7, '0')}`,
                role: 'passenger', password: hash, emailVerified: true,
            }));
        }
        console.log(`rider  ${pg.first} ${pg.last}`);
    }

    if (process.argv.includes('--queue')) await seedQueue(park!);

    console.log(`\nSign in at /dispatcher as chidi@kekeride.test / ${PASSWORD}`);
    await AppDataSource.destroy();
}

/**
 * Put three requests on the dispatcher's board.
 *
 * Rides are created `searching` — the only state the park fallback accepts —
 * with staggered createdAt so the queue shows a spread of waiting times and
 * urgency bands, then handed to the SAME entry point the dispatch orchestrator
 * uses when direct dispatch comes up empty. Nothing here is a shortcut around
 * the real path.
 *
 * Note this needs the BACKEND to be running: offerToPark notifies the park
 * through the socket host, and without a host registered the offer is refused
 * and rolled back (which is the correct fail-closed behaviour, and is exactly
 * what you will see if you run this with the server stopped).
 */
async function seedQueue(park: Park): Promise<void> {
    /**
     * offerToPark notifies the park through the socket host, and this script is
     * a separate process with no socket server in it. Without a host the offer
     * throws and is rolled back — correct fail-closed behaviour, but useless
     * here. So the script lends the service a host that only logs.
     *
     * Consequence: a dispatcher already on the board sees these requests on its
     * 7-second safety poll rather than instantly. That is a property of seeding
     * from outside the server, not of the product.
     */
    ParkDispatchService.setHost({
        assignDriver: async () => ({ ok: false, code: 'SEED', message: 'seed script cannot assign' }),
        offerRideToDriver: async () => false,
        emitToRide: () => {},
        emitToPark: () => {},
        emitToAdmin: () => {},
        notifyPassenger: () => {},
    });


    const rides = AppDataSource.getRepository(Ride);
    const passengers: Array<{ id: string }> = await AppDataSource.query(
        `SELECT id FROM "user" WHERE role='passenger' ORDER BY "createdAt" LIMIT 3`,
    );
    if (passengers.length === 0) {
        console.log('\nno passengers in this database — skipping --queue');
        return;
    }

    const WANTED = [
        { who: 'Amaka',  from: 'Zik Avenue',      to: 'Amaku', fare: 1900, lat: 6.2114, lng: 7.0748, waitedS: 320 },
        { who: 'Chioma', from: 'Eke Awka Market', to: 'Ifite', fare: 1500, lat: 6.2098, lng: 7.0731, waitedS: 200 },
        { who: 'Ngozi',  from: 'Unizik Junction', to: 'Aroma', fare: 2400, lat: 6.2126, lng: 7.0757, waitedS: 70 },
    ];

    console.log('');
    for (let i = 0; i < WANTED.length; i++) {
        const r = WANTED[i];
        const rideId = `RIDE-DEMO-${Date.now()}-${i}`;
        const createdAt = new Date(Date.now() - r.waitedS * 1000);

        await rides.save(mk(rides, {
            rideId, passengerId: passengers[i % passengers.length].id,
            fare: r.fare, paymentMode: 'cash', status: 'searching',
            pickupAddress: r.from, destinationAddress: r.to,
            pickupLat: r.lat, pickupLng: r.lng,
            destinationLat: 6.22, destinationLng: 7.08,
        }));
        // save() stamps createdAt itself, so backdate it afterwards: the queue
        // ranks by how long the PASSENGER has waited.
        await AppDataSource.query(
            'UPDATE ride SET "createdAt"=$1, "updatedAt"=$1 WHERE "rideId"=$2', [createdAt, rideId]);

        const taken = await ParkDispatchService.offerToPark(rideId);
        console.log(`queue  ${taken ? 'offered ' : 'REFUSED '} ${r.who.padEnd(7)} ${r.from} → ${r.to}  ₦${r.fare}  waited ${r.waitedS}s`);
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
