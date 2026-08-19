import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Structured locality captured at request time.
 *
 * Purely additive: eight nullable columns and four indexes. Nothing is
 * backfilled — these describe what the passenger app captured, and no ride
 * created before the app started sending them has that information. Deriving
 * a neighbourhood for old rides would mean reverse-geocoding 824 coordinate
 * pairs and presenting the result as if it had been recorded at the time,
 * which is exactly the falsification the outcome work refused to do.
 *
 * The indexes are on the two fields demand reports will group by. `city` and
 * `state` are unindexed on purpose: every ride is Onitsha, Anambra, so an
 * index on them would never narrow anything.
 */
export class AddRideStructuredLocality1803000000000 implements MigrationInterface {
    name = 'AddRideStructuredLocality1803000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "pickupSubLocality" character varying(120),
                ADD COLUMN IF NOT EXISTS "pickupLocality" character varying(120),
                ADD COLUMN IF NOT EXISTS "pickupCity" character varying(120),
                ADD COLUMN IF NOT EXISTS "pickupState" character varying(120),
                ADD COLUMN IF NOT EXISTS "destinationSubLocality" character varying(120),
                ADD COLUMN IF NOT EXISTS "destinationLocality" character varying(120),
                ADD COLUMN IF NOT EXISTS "destinationCity" character varying(120),
                ADD COLUMN IF NOT EXISTS "destinationState" character varying(120)
        `);

        // Partial: the console only ever filters on a locality that exists, and
        // most rows will be NULL for a long while yet.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_pickup_sublocality"
                ON "ride" ("pickupSubLocality") WHERE "pickupSubLocality" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_pickup_locality"
                ON "ride" ("pickupLocality") WHERE "pickupLocality" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_dest_sublocality"
                ON "ride" ("destinationSubLocality") WHERE "destinationSubLocality" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_dest_locality"
                ON "ride" ("destinationLocality") WHERE "destinationLocality" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_dest_locality"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_dest_sublocality"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_pickup_locality"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_pickup_sublocality"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "destinationState",
                DROP COLUMN IF EXISTS "destinationCity",
                DROP COLUMN IF EXISTS "destinationLocality",
                DROP COLUMN IF EXISTS "destinationSubLocality",
                DROP COLUMN IF EXISTS "pickupState",
                DROP COLUMN IF EXISTS "pickupCity",
                DROP COLUMN IF EXISTS "pickupLocality",
                DROP COLUMN IF EXISTS "pickupSubLocality"
        `);
    }
}
