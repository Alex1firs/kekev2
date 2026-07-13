import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Passenger -> driver rating & review system.
 *  - ride_review: one row per completed ride (rideId PK enforces one review/ride).
 *  - driver_profile.ratingSum / ratingCount: denormalized aggregates so the
 *    driver average never requires scanning ride_review on read.
 * All additive; safe to run on live prod.
 */
export class AddRideReviewsAndDriverRating1784500000000 implements MigrationInterface {
    name = 'AddRideReviewsAndDriverRating1784500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "ride_review" (
                "rideId" character varying NOT NULL,
                "passengerId" character varying NOT NULL,
                "driverId" character varying NOT NULL,
                "stars" integer NOT NULL,
                "tags" jsonb NOT NULL DEFAULT '[]',
                "comment" character varying(500),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_ride_review" PRIMARY KEY ("rideId")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_review_driverId" ON "ride_review" ("driverId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_review_passengerId" ON "ride_review" ("passengerId")`);

        await queryRunner.query(`
            ALTER TABLE "driver_profile"
                ADD COLUMN IF NOT EXISTS "ratingSum" integer NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "ratingCount" integer NOT NULL DEFAULT 0
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "driver_profile"
                DROP COLUMN IF EXISTS "ratingSum",
                DROP COLUMN IF EXISTS "ratingCount"
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_review_passengerId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_review_driverId"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "ride_review"`);
    }
}
