import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the `pending_acceptance` value to the park job status enum.
 *
 * DELIBERATELY ALONE in its own migration.
 *
 * Postgres refuses to USE an enum value inside the same transaction that added
 * it ("unsafe use of new value"). This project runs migrations with
 * `migrationsTransactionMode: 'each'`, so a single migration that both adds the
 * value and creates an index whose predicate references it fails at deploy time
 * — which is precisely how this was found.
 *
 * Splitting it means the ADD VALUE commits first, and 1792 can then build the
 * index that depends on it. Anything else that needs to reference
 * `pending_acceptance` in DDL must also come after this migration.
 */
export class AddPendingAcceptance1791000000000 implements MigrationInterface {
    name = 'AddPendingAcceptance1791000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "park_job_status_enum" ADD VALUE IF NOT EXISTS 'pending_acceptance'`,
        );
    }

    public async down(): Promise<void> {
        // Postgres cannot drop an enum value without recreating the type, and
        // rows may already reference it. Intentionally irreversible, matching
        // the other enum migrations in this project.
    }
}
