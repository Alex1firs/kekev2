import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPickupCode1757000000000 implements MigrationInterface {
    name = 'AddPickupCode1757000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
            ADD COLUMN IF NOT EXISTS "pickupCode" character varying(4)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN IF EXISTS "pickupCode"`);
    }
}
