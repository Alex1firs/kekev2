import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Assignment timeout: a smartphone driver must accept or decline within a short
 * window before the ride is theirs.
 *
 * A dispatcher choosing a driver is not the same as a driver agreeing to go.
 * Treating the two as identical is how rides get stuck on somebody who put
 * their phone in a pocket — the passenger waits, the dispatcher believes the
 * job is done, and nothing recovers it. PENDING_ACCEPTANCE makes the gap
 * explicit and recoverable.
 *
 * Feature-phone assignments skip this state: the dispatcher has already heard
 * the driver agree out loud before pressing Assign.
 *
 * Additive. One enum value, five nullable columns, and one index rebuilt to
 * include the new live status.
 */
export class AddPendingAcceptance1791000000000 implements MigrationInterface {
    name = 'AddPendingAcceptance1791000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "park_job_status_enum" ADD VALUE IF NOT EXISTS 'pending_acceptance'`,
        );

        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingDriverId" character varying`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingSince" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "pendingExpiresAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "declineCount" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "park_dispatch_job" ADD COLUMN IF NOT EXISTS "declinedDriverIds" jsonb`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_pending_driver" ON "park_dispatch_job" ("pendingDriverId")`);
        // The pending-expiry sweep.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_pending_expires" ON "park_dispatch_job" ("pendingExpiresAt")`);

        /**
         * The one-live-job-per-ride guarantee has to cover the new status too,
         * or a ride could hold a PENDING_ACCEPTANCE job at one park and be
         * offered to another simultaneously.
         *
         * Dropped and recreated rather than altered: Postgres has no ALTER
         * INDEX for a partial predicate.
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
        // The enum value is deliberately retained: Postgres cannot drop one
        // without recreating the type, and rows may reference it.
    }
}
