import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Columns and indexes for the assignment timeout.
 *
 * Separate from 1791, which added the `pending_acceptance` enum value: Postgres
 * refuses to use a new enum value in the same transaction that created it, and
 * the unique index below has that value in its predicate. 1791 commits, then
 * this runs.
 *
 * Additive: five nullable columns, two indexes, and one existing index rebuilt
 * to cover the new live status.
 */
export class PendingAcceptanceColumns1792000000000 implements MigrationInterface {
    name = 'PendingAcceptanceColumns1792000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingDriverId" character varying`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingSince" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingExpiresAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "declineCount" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "declinedDriverIds" jsonb`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_pending_driver" ON "park_dispatch_job" ("pendingDriverId")`);
        // The pending-expiry sweep runs every ten seconds.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_pending_expires" ON "park_dispatch_job" ("pendingExpiresAt")`);

        /**
         * The one-live-job-per-ride guarantee has to cover the new status, or a
         * ride could hold a pending offer at one park and be offered to another
         * at the same moment.
         *
         * Dropped and recreated because Postgres has no ALTER INDEX for a
         * partial predicate.
         */
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pdj_one_live_per_ride"`);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pdj_one_live_per_ride"
                ON "park_dispatch_job" ("rideId")
                WHERE "status" IN ('offered', 'claimed', 'pending_acceptance')
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pdj_one_live_per_ride"`);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pdj_one_live_per_ride"
                ON "park_dispatch_job" ("rideId") WHERE "status" IN ('offered', 'claimed')
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pdj_pending_expires"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pdj_pending_driver"`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" DROP COLUMN IF EXISTS "declinedDriverIds"`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" DROP COLUMN IF EXISTS "declineCount"`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" DROP COLUMN IF EXISTS "pendingExpiresAt"`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" DROP COLUMN IF EXISTS "pendingSince"`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" DROP COLUMN IF EXISTS "pendingDriverId"`);
    }
}
