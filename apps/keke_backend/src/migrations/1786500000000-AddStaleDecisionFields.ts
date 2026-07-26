import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The decision window for stale rides.
 *
 * Replaces "timer expires -> cancel" with "timer expires -> ask both parties ->
 * cancel only on an explicit choice or on silence from the party the ride is
 * waiting on". `staleDecisionPromptedAt` is the load-bearing column: cleanup
 * refuses to cancel a stale ride unless it is set, which is what makes a silent
 * cancellation structurally impossible rather than merely unlikely.
 *
 * Additive — all columns nullable or defaulted. Rollback loses the decision
 * audit trail only, never ride or payment data.
 */
export class AddStaleDecisionFields1786500000000 implements MigrationInterface {
    name = 'AddStaleDecisionFields1786500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const value of [
            'stale_decision_requested',
            'stale_decision_received',
            'stale_decision_timed_out',
        ]) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }

        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "staleDecisionPromptedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "staleDecisionDeadlineAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "staleDecisionBy" character varying(16),
                ADD COLUMN IF NOT EXISTS "staleDecisionChoice" character varying(16),
                ADD COLUMN IF NOT EXISTS "staleDecisionAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "staleDecisionRound" integer NOT NULL DEFAULT 0
        `);

        // The sweeper's second query: decision windows that have closed.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_stale_decision_deadline"
                ON "ride" ("staleDecisionDeadlineAt")
                WHERE "staleDecisionDeadlineAt" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_stale_decision_deadline"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "staleDecisionRound",
                DROP COLUMN IF EXISTS "staleDecisionAt",
                DROP COLUMN IF EXISTS "staleDecisionChoice",
                DROP COLUMN IF EXISTS "staleDecisionBy",
                DROP COLUMN IF EXISTS "staleDecisionDeadlineAt",
                DROP COLUMN IF EXISTS "staleDecisionPromptedAt"
        `);
    }
}
