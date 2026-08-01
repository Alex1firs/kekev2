import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Reconcile the two enum-naming conventions this schema was built with.
 *
 * ── The problem ─────────────────────────────────────────────────────────
 * `1714500000000-InitialSchema` is hand-written and creates the ledger enums as
 * `ledger_entry_balance_type_enum` / `ledger_entry_transaction_type_enum`.
 *
 * TypeORM derives enum type names from the table and column with the camelCase
 * flattened — `ledger_entry_balancetype_enum` — and that is the name every
 * later migration uses, starting with `1746600000000-AddMissingEnumValues`.
 *
 * Production never noticed, because production's schema was created by
 * `synchronize` before InitialSchema was written: it has the TypeORM names, so
 * InitialSchema's `IF NOT EXISTS` guards made it a no-op and the later
 * migrations found the types they expected.
 *
 * A VIRGIN database takes the other path. InitialSchema really does create the
 * underscore-form types, and `AddMissingEnumValues` then fails with
 * `type "ledger_entry_balancetype_enum" does not exist`. That is why a clean
 * environment could not be built from migrations at all — not a missing
 * migration, a naming fork.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * Rename the underscore form to the canonical form when only the underscore
 * form is present. Renaming a type does not touch the columns that use it —
 * they reference it by OID — so this is metadata-only and instant.
 *
 * Timestamped between InitialSchema and AddMissingEnumValues so it lands in the
 * right place in the ordering. It has not been recorded in production's
 * `migrations` table, so it WILL run there on the next deploy — where it finds
 * the canonical names already present and does nothing. That no-op is the
 * point: one chain that is correct from either starting state.
 *
 * InitialSchema itself is deliberately left alone. Editing an applied migration
 * changes nothing for any database that already ran it and only creates a
 * second version of history to reason about.
 */
export class NormaliseLegacyEnumNames1714500000001 implements MigrationInterface {
    name = 'NormaliseLegacyEnumNames1714500000001'

    /** [written by InitialSchema, expected by everything after it] */
    private static readonly RENAMES: Array<[string, string]> = [
        ['ledger_entry_balance_type_enum', 'ledger_entry_balancetype_enum'],
        ['ledger_entry_transaction_type_enum', 'ledger_entry_transactiontype_enum'],
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [legacy, canonical] of NormaliseLegacyEnumNames1714500000001.RENAMES) {
            const [{ legacy_exists, canonical_exists }] = await queryRunner.query(
                `SELECT
                    EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                            WHERE t.typname = $1 AND n.nspname = current_schema()) AS legacy_exists,
                    EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                            WHERE t.typname = $2 AND n.nspname = current_schema()) AS canonical_exists`,
                [legacy, canonical],
            );

            if (canonical_exists) {
                // Production, and any database built by synchronize. If the
                // legacy name also exists it is an unused duplicate from a
                // half-run chain; drop it rather than leave a decoy behind.
                if (legacy_exists) {
                    await queryRunner.query(`DROP TYPE IF EXISTS "${legacy}"`);
                }
                continue;
            }

            if (legacy_exists) {
                await queryRunner.query(`ALTER TYPE "${legacy}" RENAME TO "${canonical}"`);
            }
            // Neither present: an empty database that has not run InitialSchema
            // yet, or one where the ledger was never created. Nothing to do.
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reversing would rename production's types to a form nothing in the
        // codebase reads, breaking it. The forward direction is the only safe
        // one; a rollback past this point should restore from backup.
        void queryRunner;
    }
}
