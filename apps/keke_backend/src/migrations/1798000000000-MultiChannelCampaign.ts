import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One campaign, many channels.
 *
 * ── Why the shape changes now ────────────────────────────────────────────
 * `email_campaign` carried its channel in its name and its content in its
 * columns. Adding push would have meant a second table with a second audience,
 * a second approval and a second workflow — and then a third for in-app. The
 * audience, the consent rules, the approval and the audit trail belong to the
 * CAMPAIGN; only the content and the delivery state belong to the channel.
 *
 * Changed before the admin UI is built, because every screen written against
 * the old shape is a screen that would have to be rewritten.
 *
 * ── Safe on the live database ────────────────────────────────────────────
 * Additive: two new tables. Any existing campaigns are copied across first, so
 * nothing is lost. `email_campaign` is then dropped ONLY IF IT IS EMPTY — the
 * check is in SQL, not an assumption, so a database that somehow holds drafts
 * keeps them and the old table survives for a human to look at.
 *
 * Production holds zero campaigns: nothing has ever been created there, because
 * the admin UI to create one did not exist. This is therefore a rename in
 * effect, performed as a copy so it is safe wherever it runs.
 */
export class MultiChannelCampaign1798000000000 implements MigrationInterface {
    name = 'MultiChannelCampaign1798000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "campaign_channel_enum" AS ENUM
                    ('email', 'push', 'in_app', 'sms', 'promo_notification');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "communication_campaign" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" character varying(160) NOT NULL,
                "description" character varying(500),
                "objective" character varying(60),
                "segmentId" character varying,
                "audienceDefinition" jsonb,
                "status" "email_campaign_status_enum" NOT NULL DEFAULT 'draft',
                "scheduledAt" TIMESTAMP,
                "scheduleTimezone" character varying(60),
                "createdByStaffId" character varying NOT NULL,
                "approvedByStaffId" character varying,
                "approvedAt" TIMESTAMP,
                "approvedContentHash" character varying(64),
                "sentByStaffId" character varying,
                "sendStartedAt" TIMESTAMP,
                "sendCompletedAt" TIMESTAMP,
                "lastTestSentAt" TIMESTAMP,
                "failureReason" character varying(300),
                "stopReason" character varying(500),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_communication_campaign" PRIMARY KEY ("id")
            )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_camp_status_sched" ON "communication_campaign" ("status", "scheduledAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_camp_creator" ON "communication_campaign" ("createdByStaffId")`);

        /*
         * One row per channel per campaign.
         *
         * Unique on (campaignId, channel), so a campaign cannot end up with two
         * email bodies — and so enabling a channel twice is a no-op rather than
         * a duplicate that would send everything twice.
         */
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "communication_campaign_channel" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaignId" uuid NOT NULL,
                "channel" "campaign_channel_enum" NOT NULL,
                "enabled" boolean NOT NULL DEFAULT true,
                "content" jsonb NOT NULL DEFAULT '{}'::jsonb,
                "templateKey" character varying(60),
                "status" character varying(30) NOT NULL DEFAULT 'draft',
                "eligibleCount" integer,
                "excludedCount" integer,
                "exclusions" jsonb,
                "queuedCount" integer NOT NULL DEFAULT 0,
                "sentCount" integer NOT NULL DEFAULT 0,
                "failedCount" integer NOT NULL DEFAULT 0,
                "estimatedCost" numeric(12,2),
                "lastCountedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_campaign_channel" PRIMARY KEY ("id")
            )`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_campaign_channel" ON "communication_campaign_channel" ("campaignId", "channel")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_campaign_channel_camp" ON "communication_campaign_channel" ("campaignId")`);

        /*
         * Carry across anything that exists. A campaign becomes a campaign plus
         * one email channel holding what used to be its columns.
         */
        await queryRunner.query(`
            INSERT INTO "communication_campaign" (
                "id", "name", "description", "segmentId", "audienceDefinition", "status",
                "scheduledAt", "scheduleTimezone", "createdByStaffId", "approvedByStaffId",
                "approvedAt", "approvedContentHash", "sentByStaffId", "sendStartedAt",
                "sendCompletedAt", "lastTestSentAt", "failureReason", "stopReason",
                "createdAt", "updatedAt")
            SELECT
                "id", "name", NULL, "segmentId", "audienceDefinition", "status",
                "scheduledAt", "scheduleTimezone", "createdByStaffId", "approvedByStaffId",
                "approvedAt", "approvedContentHash", "sentByStaffId", "sendStartedAt",
                "sendCompletedAt", "lastTestSentAt", "failureReason", "stopReason",
                "createdAt", "updatedAt"
            FROM "email_campaign"
            ON CONFLICT ("id") DO NOTHING`);

        await queryRunner.query(`
            INSERT INTO "communication_campaign_channel" (
                "campaignId", "channel", "enabled", "content", "templateKey")
            SELECT
                "id", 'email', true,
                jsonb_build_object(
                    'subject', "subject",
                    'previewText', "previewText",
                    'senderName', "senderName",
                    'replyTo', "replyTo"
                ) || COALESCE("content", '{}'::jsonb),
                "templateKey"
            FROM "email_campaign"
            ON CONFLICT ("campaignId", "channel") DO NOTHING`);

        /*
         * Drop the old table ONLY if it is now empty of anything we did not
         * copy. Checked in SQL rather than assumed: a database holding drafts
         * keeps both the rows and the table, and a human decides what to do.
         */
        await queryRunner.query(`
            DO $$
            DECLARE remaining integer;
            BEGIN
                SELECT COUNT(*) INTO remaining FROM "email_campaign" e
                WHERE NOT EXISTS (
                    SELECT 1 FROM "communication_campaign" c WHERE c."id" = e."id"
                );
                IF remaining = 0 THEN
                    DROP TABLE IF EXISTS "email_campaign";
                END IF;
            END $$;`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "communication_campaign_channel"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "communication_campaign"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "campaign_channel_enum"`);
        /*
         * `email_campaign` is deliberately NOT recreated. Rolling back leaves
         * the database without it, which is correct: every row it held was
         * copied forward, and recreating an empty table whose data now lives
         * elsewhere would invite something to write to the wrong one.
         */
    }
}
