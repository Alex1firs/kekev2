import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissingIndexes1714600000000 implements MigrationInterface {
    name = 'AddMissingIndexes1714600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN IF NOT EXISTS "paymentFailed" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_createdAt" ON "ride" ("createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ride_paymentFailed" ON "ride" ("paymentFailed")`);
        await queryRunner.query(`ALTER TABLE "driver_profile" ALTER COLUMN "rejectionReason" TYPE varchar(500)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_paymentFailed"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_createdAt"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" ALTER COLUMN "rejectionReason" TYPE varchar`);
    }
}
