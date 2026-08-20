import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Automatic recovery for failed financial postings, and quarantine for the
 * historical ones.
 *
 * Purely additive: six nullable/defaulted columns and two indexes. No fare,
 * flag or ledger entry is touched.
 *
 * The backfill QUARANTINES the historical failures — it does not charge them.
 * It marks which rides the automatic retry worker must leave alone, so that
 * turning recovery on cannot silently post ₦80k across 46 drivers who have
 * been operating for a month as though they owed nothing. Anything failing
 * from this deployment onward is NOT quarantined and will be recovered
 * automatically.
 */
export class FinancialRecovery1806000000000 implements MigrationInterface {
    name = 'FinancialRecovery1806000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "financialQuarantine" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "financialQuarantineReason" character varying(64),
                ADD COLUMN IF NOT EXISTS "financialQuarantinedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "financialRetryCount" integer NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "financialNextRetryAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "financialLastError" character varying(300)
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_financial_quarantine"
                ON "ride" ("financialQuarantine") WHERE "financialQuarantine" = true
        `);
        // The worker's only query: due, not quarantined, still unposted.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_financial_retry"
                ON "ride" ("financialNextRetryAt") WHERE "financialNextRetryAt" IS NOT NULL
        `);

        // ── Quarantine every EXISTING unposted completed ride ────────────
        // Scoped by completedAt < now() so it captures exactly what already
        // exists at migration time and nothing created afterwards.
        await queryRunner.query(`
            UPDATE "ride"
               SET "financialQuarantine" = true,
                   "financialQuarantineReason" = 'historical_unposted_2026_08',
                   "financialQuarantinedAt" = now()
             WHERE status = 'completed'
               AND COALESCE("paymentFailed", false) = true
               AND "completedAt" < now()
               AND NOT EXISTS (
                   SELECT 1 FROM ledger_entry le WHERE le.metadata->>'rideId' = "ride"."rideId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_financial_retry"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_financial_quarantine"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "financialLastError",
                DROP COLUMN IF EXISTS "financialNextRetryAt",
                DROP COLUMN IF EXISTS "financialRetryCount",
                DROP COLUMN IF EXISTS "financialQuarantinedAt",
                DROP COLUMN IF EXISTS "financialQuarantineReason",
                DROP COLUMN IF EXISTS "financialQuarantine"
        `);
    }
}
