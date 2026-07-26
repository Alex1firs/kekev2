import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lifecycle-expiry fields for stale-ride detection and recovery, plus the
 * cancellation-reason column the system needs to record WHY it acted.
 *
 * Motivated by a production incident: rides sat in `accepted` for between 17
 * hours and nearly four days, each blocking one passenger from booking and one
 * driver from accepting, with manual SQL the only remedy.
 *
 * Fully additive — all columns nullable or defaulted, plus two partial indexes
 * scoped to the states the sweep actually queries. Safe on live prod, and a
 * rollback loses only the stale bookkeeping, never ride or payment data.
 */
export class AddStaleRideFields1786000000000 implements MigrationInterface {
    name = 'AddStaleRideFields1786000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // New dispatch_event kinds for the stale lifecycle. ADD VALUE IF NOT
        // EXISTS is idempotent, and each runs outside the surrounding
        // transaction because Postgres forbids using a new enum value in the
        // same transaction that added it.
        for (const value of [
            'stale_ride_detected',
            'stale_warning_sent',
            'stale_extension_granted',
            'stale_auto_cancelled',
            'operations_review_required',
            'stale_cleanup_completed',
        ]) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }

        await queryRunner.query(`
            ALTER TABLE "ride"
                -- Why a ride reached a terminal state. Distinguishes a passenger
                -- cancelling from a system recovery, which the status alone cannot.
                ADD COLUMN IF NOT EXISTS "cancellationReason" character varying(120),
                -- In-progress trips are flagged for humans, never auto-cancelled.
                ADD COLUMN IF NOT EXISTS "requiresOperationsReview" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "staleReason" character varying(120),
                ADD COLUMN IF NOT EXISTS "staleDetectedAt" TIMESTAMP,
                -- Persisted rather than held in memory so a restart mid-sweep
                -- cannot re-warn the same driver.
                ADD COLUMN IF NOT EXISTS "staleWarnedAt" TIMESTAMP,
                -- Bounded "still on my way" extensions, so a confirmation can
                -- never hold a passenger's slot open indefinitely.
                ADD COLUMN IF NOT EXISTS "staleExtensionCount" integer NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "staleDeadlineOverrideAt" TIMESTAMP
        `);

        // Partial indexes: the sweep only ever scans these three states, and
        // they are a tiny fraction of the table. A full index on status would be
        // mostly dead weight.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_stale_sweep_accepted"
                ON "ride" ("status", "acceptedAt")
                WHERE "status" IN ('accepted', 'arrived')
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_stale_sweep_inprogress"
                ON "ride" ("status", "startedAt")
                WHERE "status" = 'in_progress'
        `);
        // Ops review queue.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_requires_ops_review"
                ON "ride" ("requiresOperationsReview")
                WHERE "requiresOperationsReview" = true
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_requires_ops_review"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_stale_sweep_inprogress"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_stale_sweep_accepted"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "staleDeadlineOverrideAt",
                DROP COLUMN IF EXISTS "staleExtensionCount",
                DROP COLUMN IF EXISTS "staleWarnedAt",
                DROP COLUMN IF EXISTS "staleDetectedAt",
                DROP COLUMN IF EXISTS "staleReason",
                DROP COLUMN IF EXISTS "requiresOperationsReview",
                DROP COLUMN IF EXISTS "cancellationReason"
        `);
    }
}
