import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRideIntegrityFields1783100000000 implements MigrationInterface {
    name = 'AddRideIntegrityFields1783100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Anti-fraud evidence + review flags on the ride. All nullable and
        // additive so existing rows and in-flight rides are unaffected.
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "arrivedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "acceptLat" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "acceptLng" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "arrivedLat" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "arrivedLng" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "startLat" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "startLng" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "endLat" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "endLng" numeric(10,7),
                ADD COLUMN IF NOT EXISTS "arrivedPickupDistanceM" double precision,
                ADD COLUMN IF NOT EXISTS "startPickupDistanceM" double precision,
                ADD COLUMN IF NOT EXISTS "endDestinationDistanceM" double precision,
                ADD COLUMN IF NOT EXISTS "movementDistanceM" double precision,
                ADD COLUMN IF NOT EXISTS "tripDurationSec" integer,
                ADD COLUMN IF NOT EXISTS "clientSuppliedFare" numeric(12,2),
                ADD COLUMN IF NOT EXISTS "finalFare" numeric(12,2),
                ADD COLUMN IF NOT EXISTS "suspicious" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "suspiciousReason" character varying(500),
                ADD COLUMN IF NOT EXISTS "paymentHeld" boolean NOT NULL DEFAULT false
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_suspicious" ON "ride" ("suspicious")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_paymentHeld" ON "ride" ("paymentHeld")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_paymentHeld"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_suspicious"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "acceptedAt",
                DROP COLUMN IF EXISTS "arrivedAt",
                DROP COLUMN IF EXISTS "startedAt",
                DROP COLUMN IF EXISTS "acceptLat",
                DROP COLUMN IF EXISTS "acceptLng",
                DROP COLUMN IF EXISTS "arrivedLat",
                DROP COLUMN IF EXISTS "arrivedLng",
                DROP COLUMN IF EXISTS "startLat",
                DROP COLUMN IF EXISTS "startLng",
                DROP COLUMN IF EXISTS "endLat",
                DROP COLUMN IF EXISTS "endLng",
                DROP COLUMN IF EXISTS "arrivedPickupDistanceM",
                DROP COLUMN IF EXISTS "startPickupDistanceM",
                DROP COLUMN IF EXISTS "endDestinationDistanceM",
                DROP COLUMN IF EXISTS "movementDistanceM",
                DROP COLUMN IF EXISTS "tripDurationSec",
                DROP COLUMN IF EXISTS "clientSuppliedFare",
                DROP COLUMN IF EXISTS "finalFare",
                DROP COLUMN IF EXISTS "suspicious",
                DROP COLUMN IF EXISTS "suspiciousReason",
                DROP COLUMN IF EXISTS "paymentHeld"
        `);
    }
}
