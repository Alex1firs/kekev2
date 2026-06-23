import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDriverNIN1782232745051 implements MigrationInterface {
    name = 'AddDriverNIN1782232745051'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "saved_locations" DROP CONSTRAINT "FK_4ceca06c8cb5a0c5ca8ba1c213e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ledger_entry_walletId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_driver_profile_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_passengerId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_driverId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_passengerId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_driverId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_status_updatedAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_createdAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ride_paymentFailed"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_email"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_device_token_userId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_device_token_isActive"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" ADD "nin" character varying(50)`);
        await queryRunner.query(`ALTER TABLE "driver_profile" ADD "ninVerified" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "ride" ALTER COLUMN "paymentFailed" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_fe0c2aa0b8901c9162834737c0" ON "ledger_entry" ("walletId") `);
        await queryRunner.query(`CREATE INDEX "IDX_19a5a90ec2b6d7dc1a41756788" ON "driver_profile" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d459d7fcb3ae6af092f7dcba68" ON "driver_profile" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_1699e40f3304c5b41371e27112" ON "ride" ("passengerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a212335bd593ecd23b665309e9" ON "ride" ("driverId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5e2cfa23856583505a4fee554" ON "ride" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef83f75bc3f6e4dc5a3332c7d8" ON "ride" ("status", "updatedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_0899e912a67667ab87492ac704" ON "ride" ("driverId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_63839a656c6267804c1b5b05c1" ON "ride" ("passengerId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba0cbbc3097f061e197e71c112" ON "device_token" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9434611964c4cdd4c97f95e944" ON "device_token" ("isActive") `);
        await queryRunner.query(`ALTER TABLE "saved_locations" ADD CONSTRAINT "FK_4ceca06c8cb5a0c5ca8ba1c213e" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "saved_locations" DROP CONSTRAINT "FK_4ceca06c8cb5a0c5ca8ba1c213e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9434611964c4cdd4c97f95e944"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ba0cbbc3097f061e197e71c112"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_63839a656c6267804c1b5b05c1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0899e912a67667ab87492ac704"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ef83f75bc3f6e4dc5a3332c7d8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d5e2cfa23856583505a4fee554"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a212335bd593ecd23b665309e9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1699e40f3304c5b41371e27112"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d459d7fcb3ae6af092f7dcba68"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_19a5a90ec2b6d7dc1a41756788"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fe0c2aa0b8901c9162834737c0"`);
        await queryRunner.query(`ALTER TABLE "ride" ALTER COLUMN "paymentFailed" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN "ninVerified"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN "nin"`);
        await queryRunner.query(`CREATE INDEX "IDX_device_token_isActive" ON "device_token" ("isActive") `);
        await queryRunner.query(`CREATE INDEX "IDX_device_token_userId" ON "device_token" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_email" ON "user" ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_paymentFailed" ON "ride" ("paymentFailed") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_createdAt" ON "ride" ("createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_status_updatedAt" ON "ride" ("status", "updatedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_driverId_status" ON "ride" ("driverId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_passengerId_status" ON "ride" ("passengerId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_status" ON "ride" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_driverId" ON "ride" ("driverId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ride_passengerId" ON "ride" ("passengerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_driver_profile_status" ON "driver_profile" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ledger_entry_walletId" ON "ledger_entry" ("walletId") `);
        await queryRunner.query(`ALTER TABLE "saved_locations" ADD CONSTRAINT "FK_4ceca06c8cb5a0c5ca8ba1c213e" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
