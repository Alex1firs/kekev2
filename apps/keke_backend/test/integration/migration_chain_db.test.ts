/**
 * The migration chain must build a database from ZERO.
 *
 * It could not, until Phase 5. `1714500000000-InitialSchema` is hand-written
 * and creates the ledger enums as `ledger_entry_balance_type_enum`, while
 * TypeORM — and therefore every migration written after it — uses
 * `ledger_entry_balancetype_enum`. Production never hit it because production's
 * schema was created by `synchronize` before InitialSchema existed, so the
 * `IF NOT EXISTS` guards made InitialSchema a no-op there.
 *
 * The consequence was that no clean environment could be created at all: not a
 * new developer's machine, not staging, not a restore-from-empty during an
 * incident. `1714500000001-NormaliseLegacyEnumNames` reconciles the two.
 *
 * This suite runs the REAL chain against REAL Postgres, both ways round:
 *   - from an empty database;
 *   - from a database shaped like production (synchronize-built, migrations
 *     stamped, park domain absent).
 *
 * It uses its own database rather than its own schema, because migrations
 * address `public` explicitly.
 */
import { DataSource } from 'typeorm';
import path from 'path';
import fs from 'fs';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

/** Same list the production simulation uses: what is actually deployed today. */
const PRODUCTION_ENTITY_FILES = [
    'User', 'DriverProfile', 'Ride', 'RideReview', 'Wallet', 'LedgerEntry',
    'Transaction', 'PayoutRecord', 'DeviceToken', 'AuditLog', 'SavedLocation',
    'Setting', 'SosAlert', 'DispatchEvent',
];
const PRODUCTION_HEAD = 1787000000000;

/**
 * Added by this work; production has never run it. Its old timestamp places it
 * correctly in the ordering, but the `migrations` table records what a database
 * has actually executed — stamping it would skip the migration this case exists
 * to exercise.
 */
const NEVER_DEPLOYED = new Set(['NormaliseLegacyEnumNames1714500000001']);

const MIGRATION_DIR = path.join(__dirname, '..', '..', 'src', 'migrations');

function migrationClasses(): Array<{ ts: number; name: string; cls: Function }> {
    const out: Array<{ ts: number; name: string; cls: Function }> = [];
    for (const file of fs.readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.ts')).sort()) {
        const mod = require(path.join(MIGRATION_DIR, file));
        for (const key of Object.keys(mod)) {
            if (typeof mod[key] === 'function') out.push({ ts: Number(file.split('-')[0]), name: key, cls: mod[key] });
        }
    }
    return out;
}

async function withAdmin<T>(fn: (ds: DataSource) => Promise<T>): Promise<T> {
    const admin = new DataSource({ type: 'postgres', url: ADMIN_URL });
    await admin.initialize();
    try { return await fn(admin); } finally { await admin.destroy(); }
}

/**
 * A scratch database, unique to this worker and run.
 *
 * Jest runs suites in parallel workers against one Postgres. A fixed database
 * name meant two runs — or a leftover from a killed run — could collide, and
 * DROP DATABASE fails outright while anything else holds a connection to it.
 * That surfaced as an occasional single failure in an otherwise green suite,
 * which is the worst kind: it looks like a real defect and it is not.
 *
 * The pid makes the name unique; terminating stragglers first makes the drop
 * reliable even when a previous run died without cleaning up.
 */
const SCRATCH_SUFFIX = `${process.pid}`;

function scratchName(base: string): string {
    return `${base}_${SCRATCH_SUFFIX}`;
}

async function freshDatabase(base: string): Promise<string> {
    const name = scratchName(base);
    await withAdmin(async (admin) => {
        // Anything still attached would make the drop fail.
        await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`, [name],
        ).catch(() => { /* the database may not exist yet */ });
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.query(`CREATE DATABASE "${name}"`);
    });
    return ADMIN_URL!.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

function chainDataSource(url: string): DataSource {
    return new DataSource({
        type: 'postgres',
        url,
        // The classes themselves, not the dist glob the app config uses — the
        // test must exercise the source of truth in this working tree.
        migrations: migrationClasses().map((m) => m.cls as any),
        migrationsTransactionMode: 'each',
    });
}

describeDb('the migration chain', () => {
    jest.setTimeout(180_000);

    it('builds a database from empty, and re-running is a no-op', async () => {
        const url = await freshDatabase('keke_chain_virgin');
        const ds = chainDataSource(url);
        await ds.initialize();
        try {
            const applied = await ds.runMigrations();
            expect(applied.length).toBe(migrationClasses().length);

            /*
             * The specific regression: after the chain, the ledger enums carry
             * the names the CODE reads, not the ones InitialSchema wrote.
             */
            const enums = await ds.query(
                `SELECT typname FROM pg_type WHERE typname LIKE 'ledger_entry%enum' ORDER BY typname`);
            const names = enums.map((e: any) => e.typname);
            expect(names).toContain('ledger_entry_balancetype_enum');
            expect(names).toContain('ledger_entry_transactiontype_enum');
            expect(names).not.toContain('ledger_entry_balance_type_enum');

            // And the values the later migrations were trying to add are there.
            const values = await ds.query(
                `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'ledger_entry_transactiontype_enum'`);
            expect(values.map((v: any) => v.enumlabel)).toEqual(
                expect.arrayContaining(['commission_credit', 'cash_received', 'debt_recovery']));

            // The park domain exists, which is the point of the deploy.
            const parkTables = await ds.query(
                `SELECT table_name FROM information_schema.tables
                 WHERE table_schema='public' AND table_name IN
                 ('park','park_dispatch_job','park_driver_roster','dispatcher_shift',
                  'driver_presence','driver_badge','staff_user')`);
            expect(parkTables).toHaveLength(7);

            expect(await ds.showMigrations()).toBe(false); // nothing pending
        } finally {
            await ds.destroy();
        }
    });

    it('upgrades a production-shaped database without touching its enum names', async () => {
        const url = await freshDatabase('keke_chain_prodsim');

        // Production was built by synchronize, so it has TypeORM's enum names
        // and no park domain.
        const models = await Promise.all(PRODUCTION_ENTITY_FILES.map(async (f) => {
            const mod = require(path.join(__dirname, '..', '..', 'src', 'models', f));
            return mod[f];
        }));
        const seed = new DataSource({ type: 'postgres', url, entities: models, synchronize: true });
        await seed.initialize();
        await seed.query(`CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)`);
        for (const m of migrationClasses().filter((m) => m.ts <= PRODUCTION_HEAD && !NEVER_DEPLOYED.has(m.name))) {
            await seed.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [m.ts, m.name]);
        }
        const before = await seed.query(
            `SELECT typname FROM pg_type WHERE typname LIKE 'ledger_entry%enum' ORDER BY typname`);
        expect(before.map((e: any) => e.typname)).toEqual(
            ['ledger_entry_balancetype_enum', 'ledger_entry_transactiontype_enum']);
        await seed.destroy();

        const ds = chainDataSource(url);
        await ds.initialize();
        try {
            const applied = await ds.runMigrations();
            const names = applied.map((m) => m.name);

            // The repair runs here too — it is not recorded in production's
            // history — and must be a harmless no-op.
            expect(names).toContain('NormaliseLegacyEnumNames1714500000001');
            expect(names).toContain('CreateParkInfrastructure1789000000000');
            expect(names).toContain('AddDriverOfferEvents1793000000000');

            const after = await ds.query(
                `SELECT typname FROM pg_type WHERE typname LIKE 'ledger_entry%enum' ORDER BY typname`);
            expect(after.map((e: any) => e.typname)).toEqual(
                ['ledger_entry_balancetype_enum', 'ledger_entry_transactiontype_enum']);

            expect(await ds.showMigrations()).toBe(false);
        } finally {
            await ds.destroy();
        }
    });

    afterAll(async () => {
        await withAdmin(async (admin) => {
            for (const base of ['keke_chain_virgin', 'keke_chain_prodsim']) {
                const db = scratchName(base);
                await admin.query(
                    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                     WHERE datname = $1 AND pid <> pg_backend_pid()`, [db],
                ).catch(() => {});
                await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => {});
            }
        });
    });
});
