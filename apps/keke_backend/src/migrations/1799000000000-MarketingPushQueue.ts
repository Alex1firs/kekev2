import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The marketing push queue — separate from everything operational.
 *
 * Additive: one new table and one new enum. No operational table is touched,
 * and nothing in the ride, dispatch or notification path reads this. A rollback
 * drops only what was created and can lose no operational data, because none
 * is stored here.
 */
export class MarketingPushQueue1799000000000 implements MigrationInterface {
    name = 'MarketingPushQueue1799000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "marketing_push_state_enum" AS ENUM
                    ('queued', 'sending', 'sent', 'failed', 'skipped');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "marketing_push_job" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaignId" character varying NOT NULL,
                "userId" character varying NOT NULL,
                "state" "marketing_push_state_enum" NOT NULL DEFAULT 'queued',
                "attempts" integer NOT NULL DEFAULT 0,
                "nextAttemptAt" TIMESTAMP,
                "providerMessageId" character varying,
                "error" character varying(300),
                "skipReason" character varying(60),
                "sentAt" TIMESTAMP,
                "openedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_marketing_push_job" PRIMARY KEY ("id")
            )`);

        // The arbiter of "once per passenger per campaign". A resumed worker or
        // a double release is refused here, by the database.
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mpush_campaign_user" ON "marketing_push_job" ("campaignId", "userId")`);
        // The worker's claim query: due work, oldest first.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mpush_due" ON "marketing_push_job" ("state", "nextAttemptAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mpush_campaign_state" ON "marketing_push_job" ("campaignId", "state")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "marketing_push_job"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "marketing_push_state_enum"`);
    }
}
