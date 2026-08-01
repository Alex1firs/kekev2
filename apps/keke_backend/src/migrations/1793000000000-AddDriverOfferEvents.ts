import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Dispatch-event values for the driver-acceptance step.
 *
 * The TypeScript enum gained `park_driver_offered`, `park_driver_accepted` and
 * `park_driver_declined` when assignment timeouts landed, but the Postgres type
 * did not — so the first query that filtered on them failed with
 * "invalid input value for enum". Found by running the workflow against a real
 * database rather than by reading the diff.
 *
 * Enum additions live alone, for the reason recorded in 1791: Postgres refuses
 * to USE a value in the transaction that created it, and this project runs
 * migrations with transactionMode 'each'.
 */
export class AddDriverOfferEvents1793000000000 implements MigrationInterface {
    name = 'AddDriverOfferEvents1793000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const value of ['park_driver_offered', 'park_driver_accepted', 'park_driver_declined']) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }
    }

    public async down(): Promise<void> {
        // Postgres cannot drop an enum value without recreating the type, and
        // rows may already reference these. Intentionally irreversible.
    }
}
