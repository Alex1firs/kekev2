import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSosAlert1782888952429 implements MigrationInterface {
    name = 'CreateSosAlert1782888952429'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."sos_alert_initiatorrole_enum" AS ENUM('passenger', 'driver', 'admin')`);
        await queryRunner.query(`CREATE TYPE "public"."sos_alert_status_enum" AS ENUM('active', 'resolved', 'false_alarm')`);
        await queryRunner.query(`CREATE TABLE "sos_alert" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rideId" character varying NOT NULL, "initiatorId" character varying NOT NULL, "initiatorRole" "public"."sos_alert_initiatorrole_enum" NOT NULL, "reason" character varying, "description" text, "lat" numeric(10,7), "lng" numeric(10,7), "status" "public"."sos_alert_status_enum" NOT NULL DEFAULT 'active', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "resolvedAt" TIMESTAMP, CONSTRAINT "PK_bbed2e20b6a304c6fc19a7db294" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e164905352e05709c1053e2f6f" ON "sos_alert" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_6dfabb3f4e7cbe6992a4561ca7" ON "sos_alert" ("rideId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_6dfabb3f4e7cbe6992a4561ca7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e164905352e05709c1053e2f6f"`);
        await queryRunner.query(`DROP TABLE "sos_alert"`);
        await queryRunner.query(`DROP TYPE "public"."sos_alert_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."sos_alert_initiatorrole_enum"`);
    }

}
