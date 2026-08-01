/**
 * Reproduce production's schema shape locally, so the upgrade path can be
 * tested rather than assumed.
 *
 * Production was NOT built by running the migration chain. It was created by
 * TypeORM `synchronize` before the chain existed, and migrations were recorded
 * on top of it afterwards. That is why the ledger enums carry TypeORM's names
 * there and the hand-written InitialSchema's names nowhere — and why the chain
 * had never actually been exercised from zero.
 *
 * This script rebuilds that starting state:
 *   1. synchronize ONLY the entities that exist in production today
 *      (everything except staff identity and the park domain, which have
 *      never been deployed);
 *   2. stamp the migrations production has already recorded.
 *
 * Running `migration:run` against the result is then a faithful rehearsal of
 * Monday's deploy.
 *
 * Local only — it refuses any URL that does not look like a scratch database.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import path from 'path';
import fs from 'fs';

import { User } from '../src/models/User';
import { DriverProfile } from '../src/models/DriverProfile';
import { Ride } from '../src/models/Ride';
import { RideReview } from '../src/models/RideReview';
import { Wallet } from '../src/models/Wallet';
import { LedgerEntry } from '../src/models/LedgerEntry';
import { Transaction } from '../src/models/Transaction';
import { PayoutRecord } from '../src/models/PayoutRecord';
import { DeviceToken } from '../src/models/DeviceToken';
import { AuditLog } from '../src/models/AuditLog';
import { SavedLocation } from '../src/models/SavedLocation';
import { Setting } from '../src/models/Setting';
import { SosAlert } from '../src/models/SosAlert';
import { DispatchEvent } from '../src/models/DispatchEvent';

/** Exactly what production runs today. Staff identity and parks are not here. */
const PRODUCTION_ENTITIES = [
    User, DriverProfile, Ride, RideReview, Wallet, LedgerEntry, Transaction,
    PayoutRecord, DeviceToken, AuditLog, SavedLocation, Setting, SosAlert,
    DispatchEvent,
];

/**
 * The last migration production has applied. Everything after this is what
 * Monday's deploy will run: staff identity, the park domain, and the enum
 * repair.
 */
const PRODUCTION_HEAD = 1787000000000;

/**
 * Migrations added by THIS work, which production has never seen.
 *
 * They must not be stamped even though the enum repair carries an old
 * timestamp — the timestamp places it correctly in the ordering, but the
 * `migrations` table records what a database has actually run, and production
 * has not run this. Stamping it would make the rehearsal skip the very
 * migration it is meant to prove is harmless.
 */
const NEVER_DEPLOYED = new Set(['NormaliseLegacyEnumNames1714500000001']);

async function main() {
    const url = process.env.DATABASE_URL || '';
    if (!/keke_prodsim|keke_virgin|keke_test|127\.0\.0\.1|localhost/.test(url) || process.env.NODE_ENV === 'production') {
        throw new Error(`refusing to run against ${url || 'unset DATABASE_URL'}`);
    }

    const ds = new DataSource({ type: 'postgres', url, entities: PRODUCTION_ENTITIES, synchronize: true });
    await ds.initialize();
    console.log(`synchronized ${PRODUCTION_ENTITIES.length} production entities`);

    await ds.query(`CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)`);
    await ds.query('DELETE FROM migrations');

    const dir = path.join(__dirname, '..', 'src', 'migrations');
    const stamped: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
        const ts = Number(file.split('-')[0]);
        if (ts > PRODUCTION_HEAD) continue;
        const mod = require(path.join(dir, file));
        for (const key of Object.keys(mod)) {
            if (typeof mod[key] !== 'function' || NEVER_DEPLOYED.has(key)) continue;
            await ds.query('INSERT INTO migrations (timestamp, name) VALUES ($1, $2)', [ts, key]);
            stamped.push(key);
        }
    }
    console.log(`stamped ${stamped.length} migrations as already applied (head ${PRODUCTION_HEAD})`);

    const enums = await ds.query(
        `SELECT typname FROM pg_type WHERE typname LIKE 'ledger_entry%enum' ORDER BY typname`);
    console.log('ledger enum names present:', enums.map((e: any) => e.typname).join(', ') || '(none)');

    await ds.destroy();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
