import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Campaign history, in-app delivery tracking, and two push timestamps.
 *
 * Purely additive:
 *   - two new tables, which nothing but the communications code reads;
 *   - two nullable columns on `marketing_push_job`, a table that has never
 *     held a row in production.
 *
 * No existing column is altered, no constraint changed, no data rewritten.
 * `IF NOT EXISTS` throughout so a partial application can be re-run.
 *
 * Down drops exactly what up created and nothing else.
 */
export class CampaignHistoryAndInApp1801000000000 implements MigrationInterface {
    name = 'CampaignHistoryAndInApp1801000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── Campaign history ────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "communication_campaign_event" (
                "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaignId"    uuid NOT NULL,
                "action"        character varying(40) NOT NULL,
                "actorStaffId"  character varying,
                "actorName"     character varying(160),
                "actorRole"     character varying(80),
                "channel"       character varying(30),
                "note"          character varying(500),
                "changes"       jsonb,
                "ipAddress"     character varying(60),
                "userAgent"     character varying(300),
                "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_communication_campaign_event" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cce_campaign_createdAt"
            ON "communication_campaign_event" ("campaignId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_cce_action_createdAt"
            ON "communication_campaign_event" ("action", "createdAt")
        `);

        // ── In-app delivery ─────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "in_app_message_delivery" (
                "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaignId"   uuid NOT NULL,
                "userId"       character varying NOT NULL,
                "queuedAt"     TIMESTAMP NOT NULL DEFAULT now(),
                "displayedAt"  TIMESTAMP,
                "viewedAt"     TIMESTAMP,
                "clickedAt"    TIMESTAMP,
                "dismissedAt"  TIMESTAMP,
                "surface"      character varying(20) NOT NULL DEFAULT 'banner',
                "appVersion"   character varying(40),
                CONSTRAINT "PK_in_app_message_delivery" PRIMARY KEY ("id")
            )
        `);
        /*
         * One row per passenger per campaign. The unique index is what stops a
         * retried enqueue showing the same passenger the same banner twice.
         */
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_iamd_campaign_user"
            ON "in_app_message_delivery" ("campaignId", "userId")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_iamd_campaign_displayed"
            ON "in_app_message_delivery" ("campaignId", "displayedAt")
        `);

        // ── Push delivery timestamps ────────────────────────────────────
        // Nullable with no default, so existing rows are untouched and the
        // absence of a value keeps meaning "we were never told".
        await queryRunner.query(`
            ALTER TABLE "marketing_push_job"
            ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketing_push_job" DROP COLUMN IF EXISTS "deliveredAt"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "in_app_message_delivery"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "communication_campaign_event"`);
    }
}
