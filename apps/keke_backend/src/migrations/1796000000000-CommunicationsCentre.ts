import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Passenger Communications Centre.
 *
 * ── Strictly additive ────────────────────────────────────────────────────
 * Six new tables and two new enums. It ALTERS NOTHING that already exists: no
 * column is added to `user`, `ride`, `driver_profile` or any other live table,
 * nothing is renamed, nothing is dropped, no existing row is written to. A
 * passenger signing in while this runs is unaffected, because none of the code
 * paths they touch read or write any of it.
 *
 * `down` drops only what `up` created, so a rollback restores the database to
 * exactly its prior shape and no live data can be lost by taking it.
 *
 * ── Consent is created empty, on purpose ─────────────────────────────────
 * There is no backfill. Every existing passenger ends this migration with no
 * preference row, and a missing row means NOT opted in. That is not an
 * oversight to be corrected later: the passenger signup screen never showed
 * terms, a privacy link or a marketing checkbox, so there is no consent to
 * migrate and inventing one would be the single most damaging thing this
 * feature could do.
 */
export class CommunicationsCentre1796000000000 implements MigrationInterface {
    name = 'CommunicationsCentre1796000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── Consent ─────────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "passenger_communication_preference" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" character varying NOT NULL,
                "marketing" boolean NOT NULL DEFAULT false,
                "promotionalOffers" boolean NOT NULL DEFAULT false,
                "productUpdates" boolean NOT NULL DEFAULT false,
                "safetyAnnouncements" boolean NOT NULL DEFAULT true,
                "consentSource" character varying(40),
                "consentAt" TIMESTAMP,
                "consentIp" character varying(64),
                "unsubscribedAt" TIMESTAMP,
                "unsubscribeReason" character varying(300),
                "unsubscribeToken" character varying(64),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_passenger_comm_pref" PRIMARY KEY ("id")
            )`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comm_pref_user" ON "passenger_communication_preference" ("userId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_pref_marketing" ON "passenger_communication_preference" ("marketing")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_pref_token" ON "passenger_communication_preference" ("unsubscribeToken")`);

        // ── Suppression ─────────────────────────────────────────────────
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "email_suppression_reason_enum" AS ENUM
                    ('hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_suppression" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "email" character varying NOT NULL,
                "reason" "email_suppression_reason_enum" NOT NULL,
                "source" character varying(40) NOT NULL,
                "detail" character varying(500),
                "createdByStaffId" character varying,
                "campaignId" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_email_suppression" PRIMARY KEY ("id")
            )`);
        // Unique on the address: recording the same complaint twice is a no-op.
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_suppression_email" ON "email_suppression" ("email")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_suppression_reason" ON "email_suppression" ("reason", "createdAt")`);

        // ── Segments ────────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_audience_segment" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" character varying(160) NOT NULL,
                "description" character varying(500),
                "definition" jsonb NOT NULL,
                "createdByStaffId" character varying NOT NULL,
                "lastCount" integer,
                "lastCountedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_email_segment" PRIMARY KEY ("id")
            )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_segment_name" ON "email_audience_segment" ("name")`);

        // ── Campaigns ───────────────────────────────────────────────────
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "email_campaign_status_enum" AS ENUM
                    ('draft', 'awaiting_approval', 'approved', 'scheduled',
                     'sending', 'paused', 'completed', 'cancelled', 'failed');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_campaign" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name" character varying(160) NOT NULL,
                "subject" character varying(200) NOT NULL,
                "previewText" character varying(200),
                "senderName" character varying(100) NOT NULL DEFAULT 'KekeRide',
                "replyTo" character varying(200),
                "templateKey" character varying(60) NOT NULL,
                "content" jsonb NOT NULL DEFAULT '{}'::jsonb,
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
                CONSTRAINT "PK_email_campaign" PRIMARY KEY ("id")
            )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_campaign_status_sched" ON "email_campaign" ("status", "scheduledAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_campaign_creator" ON "email_campaign" ("createdByStaffId")`);

        // ── Recipients ──────────────────────────────────────────────────
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "email_recipient_status_enum" AS ENUM
                    ('queued', 'sent', 'delivered', 'deferred', 'soft_bounced',
                     'hard_bounced', 'complained', 'failed', 'skipped');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_campaign_recipient" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaignId" character varying NOT NULL,
                "userId" character varying NOT NULL,
                "email" character varying NOT NULL,
                "status" "email_recipient_status_enum" NOT NULL DEFAULT 'queued',
                "providerMessageId" character varying,
                "idempotencyKey" character varying(120) NOT NULL,
                "attempts" integer NOT NULL DEFAULT 0,
                "lastAttemptAt" TIMESTAMP,
                "reason" character varying(300),
                "sentAt" TIMESTAMP,
                "deliveredAt" TIMESTAMP,
                "openedAt" TIMESTAMP,
                "clickedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_email_recipient" PRIMARY KEY ("id")
            )`);
        /*
         * The arbiter of "send exactly once". A resumed batch, a double-clicked
         * Send or a restarted worker all attempt an insert that already exists
         * and are refused here — by the database, not by a check that can race.
         */
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recipient_campaign_email" ON "email_campaign_recipient" ("campaignId", "email")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recipient_campaign_status" ON "email_campaign_recipient" ("campaignId", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_recipient_provider_msg" ON "email_campaign_recipient" ("providerMessageId")`);

        // ── Delivery events ─────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_delivery_event" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "providerEventId" character varying(200) NOT NULL,
                "campaignId" character varying,
                "recipientId" character varying,
                "providerMessageId" character varying,
                "type" character varying(40) NOT NULL,
                "payload" jsonb,
                "occurredAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_email_event" PRIMARY KEY ("id")
            )`);
        // Providers retry webhooks; a repeat insert is refused rather than
        // double-counting a complaint or inflating an open rate.
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_event_provider_id" ON "email_delivery_event" ("providerEventId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_campaign_type" ON "email_delivery_event" ("campaignId", "type")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_event_recipient" ON "email_delivery_event" ("recipientId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Only what `up` created. Nothing here touches a pre-existing table, so
        // a rollback cannot lose passenger, ride or payment data.
        await queryRunner.query(`DROP TABLE IF EXISTS "email_delivery_event"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "email_campaign_recipient"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "email_campaign"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "email_audience_segment"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "email_suppression"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "passenger_communication_preference"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "email_recipient_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "email_campaign_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "email_suppression_reason_enum"`);
    }
}
