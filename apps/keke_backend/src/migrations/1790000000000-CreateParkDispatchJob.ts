import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Park Dispatch fallback: the job a park works on, and the provenance columns
 * that let reporting tell the two supply channels apart.
 *
 * Additive. One new table, four nullable columns on `ride`, and eight new
 * values on the existing dispatch-event enum. No column is dropped, renamed or
 * re-typed, and `RideStatus` is deliberately untouched — the park phase runs
 * entirely while a ride is `searching`, so every existing conditional UPDATE,
 * sweeper query and eligibility filter keeps working without knowing park
 * dispatch exists.
 *
 * Applying this migration changes no behaviour: PARK_DISPATCH_ENABLED defaults
 * to false, so the fallback is never consulted.
 */
export class CreateParkDispatchJob1790000000000 implements MigrationInterface {
    name = 'CreateParkDispatchJob1790000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "park_job_status_enum" AS ENUM
                    ('offered', 'claimed', 'assigned', 'skipped', 'escalated', 'rejected', 'expired', 'cancelled');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "park_assignment_mode_enum" AS ENUM ('electronic', 'verbal');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "park_dispatch_job" (
                "jobId"                  uuid NOT NULL DEFAULT uuid_generate_v4(),
                "rideId"                 character varying NOT NULL,
                "parkId"                 character varying NOT NULL,
                "status"                 "park_job_status_enum" NOT NULL DEFAULT 'offered',
                "priority"               integer NOT NULL DEFAULT 1,
                "attemptNumber"          integer NOT NULL DEFAULT 1,
                "previousJobId"          character varying,
                "offeredAt"              TIMESTAMP NOT NULL,
                "offerExpiresAt"         TIMESTAMP NOT NULL,
                "parkToPickupKm"         double precision,
                "estimatedTravelMinutes" integer,
                "claimedAt"              TIMESTAMP,
                "claimedByStaffId"       character varying,
                "shiftId"                character varying,
                "assignmentDeadlineAt"   TIMESTAMP,
                "assignedAt"             TIMESTAMP,
                "assignedDriverId"       character varying,
                "assignedByStaffId"      character varying,
                "assignmentMode"         "park_assignment_mode_enum",
                "resolvedAt"             TIMESTAMP,
                "resolutionReason"       character varying(500),
                "responseTimeMs"         integer,
                "assignmentTimeMs"       integer,
                "passengerWaitMs"        integer,
                "createdAt"              TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"              TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_park_dispatch_job" PRIMARY KEY ("jobId")
            )
        `);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_ride" ON "park_dispatch_job" ("rideId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_park" ON "park_dispatch_job" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_status" ON "park_dispatch_job" ("status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_priority" ON "park_dispatch_job" ("priority")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_claimed_by" ON "park_dispatch_job" ("claimedByStaffId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_driver" ON "park_dispatch_job" ("assignedDriverId")`);
        // The dispatcher queue read: this park, still live, most urgent first.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_park_status" ON "park_dispatch_job" ("parkId", "status")`);
        // The expiry sweep: everything still live, oldest first.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pdj_status_offered" ON "park_dispatch_job" ("status", "offeredAt")`);

        /**
         * ONE live job per ride, enforced by the database.
         *
         * The whole safety argument for the fallback is that a ride is only ever
         * in one park's hands at a time. Two concurrent offers — a retry racing
         * the expiry sweep, say — would both pass an application-level check and
         * put the same passenger in two queues.
         */
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pdj_one_live_per_ride"
                ON "park_dispatch_job" ("rideId") WHERE "status" IN ('offered', 'claimed')
        `);

        // ── ride provenance ──────────────────────────────────────────────
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "dispatchMode" character varying(12)`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "parkId" character varying`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "parkJobId" character varying`);
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "assignmentMode" character varying(12)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_dispatch_mode" ON "ride" ("dispatchMode")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_park" ON "ride" ("parkId")`);

        // ── dispatch event types ─────────────────────────────────────────
        // Same pattern as 1746600000000 / 1787000000000. ADD VALUE cannot run
        // inside a transaction block on older Postgres, which is why this
        // project uses migrationsTransactionMode: 'each'.
        for (const value of [
            'park_offered', 'park_claimed', 'park_driver_assigned', 'park_skipped',
            'park_rejected', 'park_escalated', 'park_job_expired', 'park_dispatch_exhausted',
        ]) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_park"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_dispatch_mode"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "assignmentMode"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "parkJobId"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "parkId"`);
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "dispatchMode"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "park_dispatch_job"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "park_assignment_mode_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "park_job_status_enum"`);
        // Enum VALUES are deliberately not removed: Postgres cannot drop one
        // without recreating the type, and rows may already reference them.
    }
}
