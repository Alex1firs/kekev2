import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEarlyEndConsentFields1784000000000 implements MigrationInterface {
    name = 'AddEarlyEndConsentFields1784000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Passenger-consented early drop-off fields. All additive/nullable so
        // existing rows and in-flight rides are unaffected. Consent overrides
        // ONLY ended_far_from_destination at settlement time.
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "endedEarlyByPassenger" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "earlyEndRequestedByDriver" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "passengerConsentedEnd" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "passengerConsentAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "passengerConsentLat" double precision,
                ADD COLUMN IF NOT EXISTS "passengerConsentLng" double precision,
                ADD COLUMN IF NOT EXISTS "reviewReason" character varying(120)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "endedEarlyByPassenger",
                DROP COLUMN IF EXISTS "earlyEndRequestedByDriver",
                DROP COLUMN IF EXISTS "passengerConsentedEnd",
                DROP COLUMN IF EXISTS "passengerConsentAt",
                DROP COLUMN IF EXISTS "passengerConsentLat",
                DROP COLUMN IF EXISTS "passengerConsentLng",
                DROP COLUMN IF EXISTS "reviewReason"
        `);
    }
}
