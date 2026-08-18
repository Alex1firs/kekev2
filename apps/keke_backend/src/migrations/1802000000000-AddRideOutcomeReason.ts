import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Ride Operations: persist WHY a ride ended, not just what happened.
 *
 * Purely additive. Three nullable columns and four indexes; no column is
 * dropped, renamed, retyped or made NOT NULL, and no existing row's meaning
 * changes. Old backend builds ignore the new columns entirely, so this is safe
 * to run ahead of the code that writes them — which is what the blue-green
 * rollout requires.
 *
 * ## The backfill projects evidence; it never guesses
 *
 * Three sources, each authoritative, applied strictest-first:
 *
 *   1. `status = 'completed'` → COMPLETED. The status IS the evidence.
 *   2. `cancellationReason` → the matching cancellation code and actor.
 *   3. the `dispatch_failed` event's recorded `outcomeCode` → the failure code.
 *
 * Anything with none of those keeps `outcomeReason = NULL`, and the console
 * renders "Reason unavailable — legacy ride". At the time of writing that is
 * ~256 failed and ~188 cancelled production rides which ended before the
 * dispatch trail existed. Filling those in with a plausible-looking cause would
 * poison the supply reports this console exists to produce, so they stay blank.
 */
export class AddRideOutcomeReason1802000000000 implements MigrationInterface {
    name = 'AddRideOutcomeReason1802000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "outcomeReason" character varying(48),
                ADD COLUMN IF NOT EXISTS "outcomeDetail" character varying(64),
                ADD COLUMN IF NOT EXISTS "cancelledByRole" character varying(16)
        `);

        // Filter indexes for the operations console. Partial where it helps:
        // the console never filters on a NULL outcome, so NULLs are excluded
        // and the index stays small as legacy rides accumulate behind it.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_outcome_reason"
                ON "ride" ("outcomeReason") WHERE "outcomeReason" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_cancelled_by_role"
                ON "ride" ("cancelledByRole") WHERE "cancelledByRole" IS NOT NULL
        `);
        // The console's default view is "newest first", and every filter narrows
        // that. Descending to match the ORDER BY exactly.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_created_at_desc"
                ON "ride" ("createdAt" DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_status_created_at"
                ON "ride" ("status", "createdAt" DESC)
        `);

        // ── Backfill 1: completed rides. The status is the evidence. ──────
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = 'COMPLETED'
             WHERE "status" = 'completed'
               AND "outcomeReason" IS NULL
        `);

        // ── Backfill 2: recorded cancellation reasons. ────────────────────
        // The vocabulary is closed — only two writers exist — so these are
        // exact translations, not interpretation. Kept in SQL rather than
        // application code so the mapping is visible in the migration history.
        // The vocabulary is the union of the passenger cancel handler's literal
        // and every StaleResolution member. `CANCELLED_MUTUAL_*` and
        // `SUPPORT_RESOLVED` do not appear in production data at the time of
        // writing, but they are reachable flows and rides can end that way
        // between this being written and it being run — so they are handled
        // rather than left to fall through to "system", which would blame the
        // platform for a driver's or an agent's decision.
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = 'PASSENGER_CANCELLED',
                   "cancelledByRole" = 'passenger'
             WHERE "cancellationReason" IN ('passenger_cancelled',
                                            'CANCELLED_MUTUAL_PASSENGER_INITIATED')
               AND "outcomeReason" IS NULL
        `);
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = 'DRIVER_CANCELLED',
                   "cancelledByRole" = 'driver'
             WHERE "cancellationReason" IN ('driver_cancelled',
                                            'CANCELLED_MUTUAL_DRIVER_INITIATED')
               AND "outcomeReason" IS NULL
        `);
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = 'ADMIN_CANCELLED',
                   "cancelledByRole" = 'admin'
             WHERE "cancellationReason" IN ('admin_cancelled', 'SUPPORT_RESOLVED')
               AND "outcomeReason" IS NULL
        `);
        // An unanswered cancellation request ended because of whoever ASKED.
        // That actor is on the ride row, so it is read rather than guessed;
        // only when it is absent does this fall back to 'system'.
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = CASE "cancellationRequestedBy"
                                       WHEN 'passenger' THEN 'PASSENGER_CANCELLED'
                                       WHEN 'driver'    THEN 'DRIVER_CANCELLED'
                                       ELSE 'SYSTEM_CANCELLED' END,
                   "cancelledByRole" = COALESCE("cancellationRequestedBy", 'system')
             WHERE "cancellationReason" = 'CANCELLED_REQUEST_UNANSWERED'
               AND "outcomeReason" IS NULL
        `);
        await queryRunner.query(`
            UPDATE "ride"
               SET "outcomeReason" = 'SYSTEM_CANCELLED',
                   "cancelledByRole" = 'system'
             WHERE "cancellationReason" LIKE 'SYSTEM\\_%'
               AND "outcomeReason" IS NULL
        `);

        // ── Backfill 3: the recorded dispatch outcome. ────────────────────
        // Only for rides that actually FAILED. A ride that failed direct
        // dispatch and then completed through the park fallback carries a
        // dispatch_failed event but is not a failure, and must keep COMPLETED
        // — hence the status guard as well as the IS NULL guard.
        //
        // DISTINCT ON picks the last dispatch_failed event per ride; a ride
        // with two rounds can have more than one, and the final one is the
        // outcome that stood.
        await queryRunner.query(`
            UPDATE "ride" r
               SET "outcomeReason" = e."outcomeCode",
                   "outcomeDetail" = e."dispatchResult"
              FROM (
                    SELECT DISTINCT ON ("rideId")
                           "rideId",
                           "detail"->>'outcomeCode'    AS "outcomeCode",
                           "detail"->>'dispatchResult' AS "dispatchResult"
                      FROM "dispatch_event"
                     WHERE "eventType" = 'dispatch_failed'
                       AND "detail"->>'outcomeCode' IS NOT NULL
                     ORDER BY "rideId", "sequence" DESC
                   ) e
             WHERE r."rideId" = e."rideId"
               AND r."status" = 'failed'
               AND r."outcomeReason" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_status_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_created_at_desc"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_cancelled_by_role"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_outcome_reason"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "cancelledByRole",
                DROP COLUMN IF EXISTS "outcomeDetail",
                DROP COLUMN IF EXISTS "outcomeReason"
        `);
    }
}
