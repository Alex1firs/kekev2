import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Give a voided ride real state on the ride row.
 *
 * Voiding used to leave nothing behind but an audit_log row, and it set
 * `paymentFailed = true` — the same flag a genuinely failed posting sets.
 * Downstream, the two were indistinguishable, so the automatic financial
 * recovery worker would happily charge a driver commission for a
 * field-training ride an admin had deliberately dismissed.
 *
 * The backfill reads the existing VOIDED_HELD_RIDE_PAYMENT audit rows, so
 * it labels history from what was actually recorded rather than inventing it.
 * It changes no balance and writes no ledger entry.
 */
export class RideVoidState1807000000000 implements MigrationInterface {
    name = 'RideVoidState1807000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "voided" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "voidedReason" character varying(200)`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "voidedBy" character varying(160)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_voided" ON "ride" ("voided")`);

        // Backfill from the audit trail — the only place a void was recorded.
        await queryRunner.query(`
            UPDATE "ride" r
               SET "voided"       = true,
                   "voidedAt"     = a."createdAt",
                   "voidedReason" = COALESCE(LEFT(a."details"->>'reason', 200), 'Voided (historical — reason not recorded)'),
                   "voidedBy"     = LEFT(a."adminId", 160)
              FROM (
                    SELECT DISTINCT ON ("entityId") "entityId", "createdAt", "details", "adminId"
                      FROM "audit_log"
                     WHERE "action" = 'VOIDED_HELD_RIDE_PAYMENT'
                     ORDER BY "entityId", "createdAt" DESC
                   ) a
             WHERE r."rideId" = a."entityId"
               AND r."voided" = false
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_voided"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "voidedBy"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "voidedReason"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "voidedAt"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "voided"`);
    }
}
