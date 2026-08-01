/**
 * Create the first SUPER_ADMIN staff account.
 *
 * Solves the obvious chicken-and-egg: creating staff requires `staff:create`,
 * which requires a staff account. Rather than seeding a default credential into
 * a migration — the single most reliable way to ship a production backdoor —
 * the first account is created deliberately, by someone with shell access to
 * the server, and the setup link is printed exactly once.
 *
 *   npm run staff:bootstrap -- --email=ops@kekeride.ng \
 *                              --first=Ada --last=Obi --phone=08012345678
 *
 * No password is set here. The command prints a single-use setup token; the new
 * administrator chooses their own password through
 * POST /api/v1/staff/auth/set-password. Nobody but that person ever knows it.
 *
 * Refuses to run if an active SUPER_ADMIN already exists, so it cannot be used
 * to quietly mint a second one on a live system.
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from '../config/data_source';
import { StaffService } from '../services/staff_service';
import { StaffUser, StaffStatus } from '../models/StaffUser';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { StaffRole } from '../config/staff_permissions';
import { IsNull } from 'typeorm';

dotenv.config();

function arg(name: string): string | undefined {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : undefined;
}

async function main() {
    const email = arg('email');
    const first = arg('first');
    const last = arg('last');
    const phone = arg('phone');
    const force = process.argv.includes('--force');

    if (!email || !first || !last || !phone) {
        console.error('Usage: npm run staff:bootstrap -- --email=<e> --first=<f> --last=<l> --phone=<p> [--force]');
        process.exit(1);
    }

    await AppDataSource.initialize();

    // Guard: an existing, usable SUPER_ADMIN means bootstrap is done.
    const existing = await AppDataSource.getRepository(StaffRoleAssignment).find({
        where: { role: StaffRole.SUPER_ADMIN, revokedAt: IsNull() },
    });
    if (existing.length > 0 && !force) {
        const ids = existing.map((e) => e.staffUserId);
        const holders = await AppDataSource.getRepository(StaffUser)
            .createQueryBuilder('s')
            .where('s.id IN (:...ids)', { ids })
            .andWhere("s.status <> :dead", { dead: StaffStatus.DEACTIVATED })
            .getMany();
        if (holders.length > 0) {
            console.error(
                `Refusing to run: ${holders.length} active SUPER_ADMIN account(s) already exist.\n` +
                `Create further accounts through the admin dashboard so the action is attributable.\n` +
                `Pass --force only for a genuine lockout recovery (it is itself audited).`,
            );
            await AppDataSource.destroy();
            process.exit(2);
        }
    }

    const result = await StaffService.createStaff(
        // Attributed to the command itself, never to a person who did not act.
        { staffUserId: 'SYSTEM_BOOTSTRAP', roles: [], isLegacy: false },
        { firstName: first, lastName: last, email, phone, roles: [StaffRole.SUPER_ADMIN] },
        { correlationId: 'bootstrap' },
    );

    console.log('\n─── Staff account created ───────────────────────────────');
    console.log(`  id      : ${result.staff.id}`);
    console.log(`  name    : ${result.staff.firstName} ${result.staff.lastName}`);
    console.log(`  email   : ${result.staff.email}`);
    console.log(`  roles   : ${result.staff.roles.join(', ')}`);
    console.log(`  status  : ${result.staff.status}`);
    console.log('\n  SETUP TOKEN (shown once — deliver over a trusted channel):');
    console.log(`  ${result.setupToken}`);
    console.log(`\n  Expires : ${result.setupTokenExpiresAt.toISOString()}`);
    console.log('\n  Redeem with:');
    console.log('    POST /api/v1/staff/auth/set-password  { token, password }');
    console.log('─────────────────────────────────────────────────────────\n');

    await AppDataSource.destroy();
}

main().catch(async (err) => {
    console.error('[BOOTSTRAP] failed:', err?.message ?? err);
    try { await AppDataSource.destroy(); } catch { /* ignore */ }
    process.exit(1);
});
