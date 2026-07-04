import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDriverPhotoUrl1783000000000 implements MigrationInterface {
    name = 'AddDriverPhotoUrl1783000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // The `photoUrl` column exists on the DriverProfile entity (driver selfie
        // upload feature) but was never added to the schema by a migration. With
        // `synchronize: false`, every query on driver_profile SELECTs photoUrl, so
        // the missing column made GET /drivers/status 500 for every driver.
        await queryRunner.query(`
            ALTER TABLE "driver_profile"
            ADD COLUMN IF NOT EXISTS "photoUrl" character varying
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN IF EXISTS "photoUrl"`);
    }
}
