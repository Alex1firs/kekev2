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
 * No account gets a password here, including the first one. Every account is
 * created INVITED with a single-use activation link, and the holder chooses
 * their own password on a page that is the only thing which ever sees it.
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
import { activationLink, activationInstructions, dispatchBaseUrl } from '../src/utils/activation_link';
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
 * Create only the super admin, and no park.
 *
 * ── Why this mode exists ────────────────────────────────────────────────
 * The full run wants four people and a set of coordinates before it will do
 * anything, which assumes you have hired the whole team and stood in the park
 * with a phone before you can log in once. In practice the first account comes
 * first, and everything else follows from it: SUPER_ADMIN is the only role
 * holding staff:create, and OPERATIONS_ADMIN — which it can grant — creates
 * parks through the dashboard.
 *
 * Preferring that route is not merely convenient. An account created here is
 * attributed to 'BOOTSTRAP'; one created through the dashboard is attributed to
 * the named human who created it, with a reason, in the audit log. This script
 * is the smallest possible exception to that, not a shortcut around it.
 */
const SUPER_ADMIN_ONLY = process.argv.includes('--super-admin-only');

/**
 * Everything this script needs, from the environment. Nothing here is a
 * credential; the park's identity and the staff addresses are configuration.
 */
const CFG = {
    /*
     * The super admin. Not optional, and created first.
     *
     * Only SUPER_ADMIN holds staff:create, staff:reset_credentials and
     * staff:assign_roles. Without one, a freshly bootstrapped production can
     * never onboard another person or reissue a lost activation link, and the
     * accounts created here would be all there would ever be.
     */
    superAdminEmail: process.env.BOOTSTRAP_SUPERADMIN_EMAIL,
    superAdminPhone: process.env.BOOTSTRAP_SUPERADMIN_PHONE,
    superAdminName: process.env.BOOTSTRAP_SUPERADMIN_NAME || 'Super Admin',

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
        ['BOOTSTRAP_SUPERADMIN_EMAIL', CFG.superAdminEmail],
        ['BOOTSTRAP_SUPERADMIN_PHONE', CFG.superAdminPhone],
        ...(SUPER_ADMIN_ONLY ? [] : [
            ['BOOTSTRAP_OPS_EMAIL', CFG.opsEmail],
            ['BOOTSTRAP_OPS_PHONE', CFG.opsPhone],
            ['BOOTSTRAP_SUPERVISOR_EMAIL', CFG.supervisorEmail],
            ['BOOTSTRAP_SUPERVISOR_PHONE', CFG.supervisorPhone],
            ['BOOTSTRAP_DISPATCHER_EMAIL', CFG.dispatcherEmail],
            ['BOOTSTRAP_DISPATCHER_PHONE', CFG.dispatcherPhone],
        ]),
    ].filter(([, v]) => !v).map(([k]) => k);

    if (missing.length) throw new Error(`Set these first: ${missing.join(', ')}`);

    // No park is created in super-admin-only mode, so there is nothing for
    // coordinates to belong to. The park is made later, through the dashboard,
    // by someone standing in it.
    if (!SUPER_ADMIN_ONLY && (!Number.isFinite(CFG.parkLat) || !Number.isFinite(CFG.parkLng))) {
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

        /*
         * A link, not a token. Whoever runs this has to get somebody into an
         * account; handing them a bare string means explaining where to type
         * it. The link opens the page that sets the password, and that page is
         * the only thing that ever sees it.
         */
        handover.push(
            `${role}\n`
            + `      ${email}\n`
            + `      ${activationLink(token)}\n`
            + `      ${activationInstructions(expiresAt)}`,
        );
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

/*
 * There is deliberately NO way to set a password from this script.
 *
 * An earlier version let the first account take one from
 * BOOTSTRAP_ADMIN_PASSWORD, to solve the chicken-and-egg of having nobody to
 * send an invitation. It is gone: a password passed through an environment
 * variable is a password in a shell history, a process listing and whatever
 * ships logs off the box, and it is a password somebody other than its owner
 * has seen.
 *
 * Every account created here — including the super admin — is INVITED with a
 * single-use activation link. The holder chooses their own password on a page
 * that is the only thing which ever sees it.
 */

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

/**
 * Readiness for the super-admin-only run.
 *
 * Deliberately does not complain about the absent park or empty roster: in this
 * mode those are the next steps, not defects. What it does check is the things
 * that would make the one account it just created unusable.
 */
async function reportSuperAdminOnly(): Promise<void> {
    console.log('\n\x1b[1mReadiness\x1b[0m');

    /*
     * The activation link is built from DISPATCH_PUBLIC_URL, falling back to
     * PUBLIC_API_URL. With neither set it comes out as '/dispatch/activate.html',
     * which is a valid path and a useless thing to send someone — it resolves
     * against whatever host they happen to be on. Catch it here, where the link
     * is about to be printed, rather than after it has been pasted into WhatsApp.
     */
    const base = dispatchBaseUrl();
    if (!base.startsWith('http')) {
        bad(`activation links would be relative ('${base}') and unusable off this host — `
            + 'set DISPATCH_PUBLIC_URL (e.g. https://api.kekeride.ng/dispatch) and re-run');
    } else {
        ok(`activation links point at ${base}`);
    }

    if (!process.env.STAFF_JWT_SECRET) {
        todo('STAFF_JWT_SECRET is unset — staff tokens are signed with a key derived from '
            + 'JWT_SECRET; workable, but set it properly');
    } else {
        ok('STAFF_JWT_SECRET is set');
    }

    const cfg = loadParkDispatchConfig();
    if (cfg.enabled) ok('PARK_DISPATCH_ENABLED is true'); else todo('PARK_DISPATCH_ENABLED is false');

    const sw = await ParkDispatchSwitch.state();
    if (sw.disabled) todo(`suspended at runtime: ${sw.reason ?? 'no reason recorded'}`);
    else ok('not suspended');

    console.log('\n\x1b[1mNext, in the dashboard — not in this script\x1b[0m');
    console.log('   1. Open the activation link below and set a password.');
    console.log('   2. Sign in at the operations dashboard as a staff account.');
    console.log('   3. Staff → New staff → create the Operations Admin and Dispatcher.');
    console.log('      Each one gets their own activation link, attributed to you.');
    console.log('   4. Parks → New park, with coordinates read standing in the park.');
    console.log('   5. Roster the drivers, then activate the park.');
}

async function main() {
    requireConfig();
    await AppDataSource.initialize();

    const mode = SUPER_ADMIN_ONLY ? ' (super admin only)' : '';
    console.log(`\n\x1b[1mKekeRide Park Dispatch — ${APPLY ? 'applying' : 'checking (nothing will change)'}${mode}\x1b[0m\n`);

    const park = SUPER_ADMIN_ONLY ? null : await ensurePark();

    await ensureStaff(CFG.superAdminEmail!, CFG.superAdminPhone!, CFG.superAdminName,
        StaffRole.SUPER_ADMIN, null);

    if (!SUPER_ADMIN_ONLY) {
        await ensureStaff(CFG.opsEmail!, CFG.opsPhone!, CFG.opsName, StaffRole.OPERATIONS_ADMIN, null);
        await ensureStaff(CFG.supervisorEmail!, CFG.supervisorPhone!, CFG.supervisorName,
            StaffRole.PARK_SUPERVISOR, park?.parkId ?? null);
        await ensureStaff(CFG.dispatcherEmail!, CFG.dispatcherPhone!, CFG.dispatcherName,
            StaffRole.PARK_DISPATCHER, park?.parkId ?? null);
    }

    if (SUPER_ADMIN_ONLY) {
        await reportSuperAdminOnly();
    } else {
        await report(park);
    }

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
