import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Operations Dispatch: control ownership and intervention history.
 *
 * Two new tables. Nothing existing is touched — no column added to `ride`, no
 * type changed, no data rewritten. A backend that predates this simply never
 * reads them, which is what makes it safe to run ahead of the code and to roll
 * back to the previous colour mid-drain.
 *
 * A ride with no control row is AUTO. That is deliberate: it means the 837
 * existing rides need no backfill and the default posture is the one the
 * system already had.
 */
export class OperationsDispatch1804000000000 implements MigrationInterface {
    name = 'OperationsDispatch1804000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Same pattern as the stale-ride and coordination migrations: extend
        // the existing dispatch_event enum rather than introducing a second
        // event vocabulary. The values are not USED in this transaction, which
        // is what makes ADD VALUE safe inside one on Postgres 12+.
        for (const value of [
            'ops_takeover_claimed',
            'ops_takeover_released',
            'ops_control_expired',
            'ops_driver_contacted',
            'ops_driver_assigned',
            'ops_assignment_failed',
        ]) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "ride_dispatch_control" (
                "rideId"          character varying NOT NULL,
                "mode"            character varying(16) NOT NULL DEFAULT 'auto',
                "ownerStaffId"    character varying,
                "ownerLabel"      character varying(160),
                "takenOverAt"     TIMESTAMP,
                "leaseExpiresAt"  TIMESTAMP,
                "lastRenewedAt"   TIMESTAMP,
                "releasedAt"      TIMESTAMP,
                "releaseReason"   character varying(32),
                "version"         integer NOT NULL DEFAULT 0,
                "takeoverCount"   integer NOT NULL DEFAULT 0,
                "createdAt"       TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"       TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_ride_dispatch_control" PRIMARY KEY ("rideId")
            )
        `);

        // The sweeper's only query: expired leases still marked OPERATIONS.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rdc_mode_lease"
                ON "ride_dispatch_control" ("mode", "leaseExpiresAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rdc_owner"
                ON "ride_dispatch_control" ("ownerStaffId") WHERE "ownerStaffId" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_rdc_mode" ON "ride_dispatch_control" ("mode")
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "operations_intervention" (
                "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "rideId"            character varying NOT NULL,
                "type"              character varying(32) NOT NULL,
                "staffUserId"       character varying,
                "staffLabel"        character varying(160),
                "reason"            character varying(48),
                "driverId"          character varying,
                "priorRideStatus"   character varying(24),
                "priorControlMode"  character varying(16),
                "outcome"           character varying(16),
                "outcomeCode"       character varying(48),
                "detail"            jsonb,
                "createdAt"         TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_operations_intervention" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_oi_ride" ON "operations_intervention" ("rideId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_oi_staff" ON "operations_intervention" ("staffUserId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_oi_type" ON "operations_intervention" ("type", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_oi_driver" ON "operations_intervention" ("driverId")
                WHERE "driverId" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "operations_intervention"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "ride_dispatch_control"`);
    }
}
