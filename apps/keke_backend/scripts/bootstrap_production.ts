/**
 * First-run setup for a live Park Dispatch deployment.
 *
 * Creates the accounts and the pilot park a park cannot open without, and
 * verifies the result. Idempotent: run it twice and nothing doubles.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────
 * No password is written in this file, accepted on the command line, or
 * printed. Each account is created in INVITED state with a one-time setup
 * token, and the token is shown ONCE so it can be handed over out of band.
 * A password typed into a terminal ends up in shell history and in whatever
 * ships those logs off the box.
 *
 * If BOOTSTRAP_ADMIN_PASSWORD is set in the environment it is used for the
 * first operations account only — the chicken-and-egg case where nobody exists
 * yet to send an invitation. It is never echoed.
 *
 *   npx ts-node scripts/bootstrap_production.ts --check
 *   npx ts-node scripts/bootstrap_production.ts --apply
 *
 * `--check` changes nothing and reports what is missing. Run it first.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/config/data_source';
import { StaffUser, StaffStatus } from '../src/models/StaffUser';
import { StaffRoleAssignment } from '../src/models/StaffRoleAssignment';
import { Park, ParkStatus } from '../src/models/Park';
import { ParkDriverRoster, RosterStatus } from '../src/models/ParkDriverRoster';
import { DriverProfile } from '../src/models/DriverProfile';
import { StaffRole } from '../src/config/staff_permissions';
import { StaffAuthService } from '../src/services/staff_auth_service';
import { loadParkDispatchConfig } from '../src/config/park_dispatch_config';
import { ParkDispatchSwitch } from '../src/services/park_dispatch_switch';
import { DeepPartial, Repository } from 'typeorm';

/**
 * repo.create(x) has an array overload that a plain `as any` argument selects,
 * which then types every result as an array. Pinned once here.
 */
function mk<T extends object>(repo: Repository<T>, data: Record<string, unknown>): T {
    return repo.create(data as DeepPartial<T>);
}

const APPLY = process.argv.includes('--apply');

/**
 * Everything this script needs, from the environment. Nothing here is a
 * credential; the park's identity and the staff addresses are configuration.
 */
const CFG = {
    opsEmail: process.env.BOOTSTRAP_OPS_EMAIL,
    opsPhone: process.env.BOOTSTRAP_OPS_PHONE,
    opsName: process.env.BOOTSTRAP_OPS_NAME || 'Operations Admin',

    supervisorEmail: process.env.BOOTSTRAP_SUPERVISOR_EMAIL,
    supervisorPhone: process.env.BOOTSTRAP_SUPERVISOR_PHONE,
    supervisorName: process.env.BOOTSTRAP_SUPERVISOR_NAME || 'Park Supervisor',

    dispatcherEmail: process.env.BOOTSTRAP_DISPATCHER_EMAIL,
    dispatcherPhone: process.env.BOOTSTRAP_DISPATCHER_PHONE,
    dispatcherName: process.env.BOOTSTRAP_DISPATCHER_NAME || 'Park Dispatcher',

    parkCode: process.env.BOOTSTRAP_PARK_CODE || 'AWK-MAIN',
    parkName: process.env.BOOTSTRAP_PARK_NAME || 'Awka Main Park',
    parkLat: Number(process.env.BOOTSTRAP_PARK_LAT),
    parkLng: Number(process.env.BOOTSTRAP_PARK_LNG),
    parkCity: process.env.BOOTSTRAP_PARK_CITY || 'Awka',
    parkState: process.env.BOOTSTRAP_PARK_STATE || 'Anambra',
    serviceRadiusKm: Number(process.env.BOOTSTRAP_PARK_RADIUS_KM || 4),
    opensAt: process.env.BOOTSTRAP_PARK_OPENS_AT || '05:30',
    closesAt: process.env.BOOTSTRAP_PARK_CLOSES_AT || '21:30',
};

const problems: string[] = [];
const actions: string[] = [];
const handover: string[] = [];

const say = (icon: string, msg: string) => console.log(`  ${icon}  ${msg}`);
const ok = (msg: string) => say('\x1b[32m✓\x1b[0m', msg);
const todo = (msg: string) => { say('\x1b[33m•\x1b[0m', msg); actions.push(msg); };
const bad = (msg: string) => { say('\x1b[31m✗\x1b[0m', msg); problems.push(msg); };

function requireConfig(): void {
    /*
     * Phone numbers are required, not optional. The column is NOT NULL, and
     * more to the point a dispatcher can now sign in with the number on their
     * staff card — an account created without one can only ever be reached by
     * email, which is not what a park tablet has to hand.
     */
    const missing = [
        ['BOOTSTRAP_OPS_EMAIL', CFG.opsEmail],
        ['BOOTSTRAP_OPS_PHONE', CFG.opsPhone],
        ['BOOTSTRAP_SUPERVISOR_EMAIL', CFG.supervisorEmail],
        ['BOOTSTRAP_SUPERVISOR_PHONE', CFG.supervisorPhone],
        ['BOOTSTRAP_DISPATCHER_EMAIL', CFG.dispatcherEmail],
        ['BOOTSTRAP_DISPATCHER_PHONE', CFG.dispatcherPhone],
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) throw new Error(`Set these first: ${missing.join(', ')}`);
    if (!Number.isFinite(CFG.parkLat) || !Number.isFinite(CFG.parkLng)) {
        throw new Error('BOOTSTRAP_PARK_LAT and BOOTSTRAP_PARK_LNG are required — '
            + 'a park with no coordinates can never be selected for a pickup.');
    }
}

/**
 * Create a staff account in INVITED state with a one-time setup token.
 *
 * The token is the only thing printed, once. Whoever runs this hands it to the
 * person by phone or in person; they set their own password and nobody else
 * ever knows it.
 */
async function ensureStaff(
    email: string, phone: string, name: string, role: StaffRole, parkId: string | null,
): Promise<StaffUser | null> {
    const repo = AppDataSource.getRepository(StaffUser);
    const roles = AppDataSource.getRepository(StaffRoleAssignment);
    const [firstName, ...rest] = name.split(' ');

    let staff = await repo.findOneBy({ email: email.toLowerCase() });

    if (!staff) {
        if (!APPLY) { todo(`create ${role} ${email}`); return null; }

        /*
         * The service's own generator, not a local copy. Duplicating the
         * hashing here would work today and silently stop working the moment
         * anyone changed how tokens are hashed or how long they last.
         */
        const { token, hash, expiresAt } = StaffAuthService.generateSetupToken();
        staff = await repo.save(mk(repo, {
            email: email.toLowerCase(),
            phone,
            firstName: firstName || 'Staff',
            lastName: rest.join(' ') || role.toLowerCase(),
            passwordHash: null,
            status: StaffStatus.INVITED,
            credentialVersion: 1,
            setupTokenHash: hash,
            setupTokenExpiresAt: expiresAt,
        }));

        handover.push(`${role.padEnd(18)} ${email}\n      setup token: ${token}`);
        ok(`created ${role} ${email} (invited)`);
    } else {
        ok(`${role} ${email} exists (${staff.status})`);
    }

    const existing = await roles.findOne({ where: { staffUserId: staff!.id, role: role as any } });
    if (!existing) {
        if (!APPLY) { todo(`grant ${role} to ${email}`); return staff; }
        await roles.save(mk(roles, {
            staffUserId: staff!.id, role: role as any, parkId,
            grantedByStaffId: 'BOOTSTRAP', grantedAt: new Date(),
        }));
        ok(`granted ${role}${parkId ? ' scoped to the pilot park' : ' (global)'}`);
    }
    return staff;
}

/**
 * The first operations account may be given a password directly, because there
 * is nobody yet who could send it an invitation. Every later account uses the
 * invite flow.
 */
async function setFirstAdminPassword(staff: StaffUser): Promise<void> {
    const pw = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!pw || staff.passwordHash) return;
    if (pw.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
    if (!APPLY) { todo('set the first operations password from BOOTSTRAP_ADMIN_PASSWORD'); return; }

    staff.passwordHash = await StaffAuthService.hashPassword(pw);
    staff.status = StaffStatus.ACTIVE;
    staff.setupTokenHash = null;
    staff.setupTokenExpiresAt = null;
    await AppDataSource.getRepository(StaffUser).save(staff);
    ok('first operations password set from the environment (not printed)');
}

async function ensurePark(): Promise<Park | null> {
    const repo = AppDataSource.getRepository(Park);
    let park = await repo.findOneBy({ code: CFG.parkCode });

    if (!park) {
        if (!APPLY) { todo(`create park ${CFG.parkCode} at ${CFG.parkLat},${CFG.parkLng}`); return null; }
        park = await repo.save(mk(repo, {
            name: CFG.parkName, code: CFG.parkCode,
            lat: CFG.parkLat as any, lng: CFG.parkLng as any,
            city: CFG.parkCity, state: CFG.parkState,
            serviceRadiusKm: CFG.serviceRadiusKm, operatingRadiusM: 250,
            capacityDrivers: 60, maxConcurrentAssignments: 3,
            opensAt: CFG.opensAt, closesAt: CFG.closesAt,
            daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
            // DRAFT on purpose. A park goes live when a human says so, after
            // its roster and badges are in place — not as a side effect of a
            // setup script.
            status: ParkStatus.DRAFT,
            createdByStaffId: 'BOOTSTRAP',
        }));
        ok(`created park ${park.code} (draft — activate it deliberately)`);
    } else {
        ok(`park ${park.code} exists (${park.status})`);
    }
    return park;
}

async function report(park: Park | null): Promise<void> {
    console.log('\n\x1b[1mReadiness\x1b[0m');

    if (!park) { bad('no pilot park'); return; }

    if (park.status !== ParkStatus.ACTIVE) {
        todo(`activate ${park.code} once its roster and badges are in place`);
    } else {
        ok(`${park.code} is active`);
    }

    const roster = await AppDataSource.getRepository(ParkDriverRoster).count({
        where: { parkId: park!.parkId, status: RosterStatus.ACTIVE },
    });
    if (roster === 0) todo(`add drivers to ${park.code}'s roster`);
    else ok(`${roster} driver(s) on the roster`);

    // Device capability decides smartphone vs verbal handoff. Defaulting it
    // wrongly means offers sent to phones that cannot receive them.
    const unset = await AppDataSource.getRepository(DriverProfile)
        .createQueryBuilder('p')
        .innerJoin(ParkDriverRoster, 'r', 'r."driverId" = p."userId" AND r."parkId" = :parkId', { parkId: park.parkId })
        .where('r.status = :status', { status: RosterStatus.ACTIVE })
        .andWhere(`(p."deviceCapability" IS NULL OR p."deviceCapability" = 'smartphone')`)
        .getCount();
    if (roster > 0 && unset > 0) {
        todo(`${unset} rostered driver(s) are recorded as smartphone — confirm that is true, `
            + 'or offers will be sent to phones that cannot receive them');
    }

    const cfg = loadParkDispatchConfig();
    if (cfg.enabled) ok('PARK_DISPATCH_ENABLED is true'); else bad('PARK_DISPATCH_ENABLED is false');

    const sw = await ParkDispatchSwitch.state();
    if (sw.disabled) bad(`suspended at runtime: ${sw.reason ?? 'no reason recorded'}`);
    else ok('not suspended');

    if (!process.env.STAFF_JWT_SECRET) {
        todo('STAFF_JWT_SECRET is unset — staff tokens are signed with a key derived from JWT_SECRET; '
            + 'workable, but set it properly');
    } else {
        ok('STAFF_JWT_SECRET is set');
    }
}

async function main() {
    requireConfig();
    await AppDataSource.initialize();

    console.log(`\n\x1b[1mKekeRide Park Dispatch — ${APPLY ? 'applying' : 'checking (nothing will change)'}\x1b[0m\n`);

    const park = await ensurePark();

    const ops = await ensureStaff(CFG.opsEmail!, CFG.opsPhone!, CFG.opsName, StaffRole.OPERATIONS_ADMIN, null);
    if (ops) await setFirstAdminPassword(ops);
    await ensureStaff(CFG.supervisorEmail!, CFG.supervisorPhone!, CFG.supervisorName,
        StaffRole.PARK_SUPERVISOR, park?.parkId ?? null);
    await ensureStaff(CFG.dispatcherEmail!, CFG.dispatcherPhone!, CFG.dispatcherName,
        StaffRole.PARK_DISPATCHER, park?.parkId ?? null);

    await report(park);

    if (handover.length) {
        console.log('\n\x1b[1mHand these over in person or by phone — they are shown once\x1b[0m');
        handover.forEach((h) => console.log(`   ${h}`));
        console.log('\n   Nobody but the holder ever sets that password.');
    }

    if (!APPLY && actions.length) {
        console.log('\n\x1b[1mRe-run with --apply to make these changes.\x1b[0m');
    }

    if (problems.length) {
        console.log(`\n\x1b[31m${problems.length} blocking problem(s).\x1b[0m Do not open the park yet.\n`);
        await AppDataSource.destroy();
        process.exit(1);
    }

    console.log(`\n${actions.length ? `\x1b[33m${actions.length} step(s) still to do.\x1b[0m` : '\x1b[32mReady.\x1b[0m'}\n`);
    await AppDataSource.destroy();
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(`\n\x1b[31m${e.message}\x1b[0m\n`);
    process.exit(1);
});
