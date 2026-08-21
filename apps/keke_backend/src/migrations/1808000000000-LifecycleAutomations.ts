import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lifecycle automations, the campaign dispatch lease, and the test allow-list.
 *
 * Entirely additive: three new tables and four new campaign columns. No
 * existing column is altered or dropped, no passenger row is written, and no
 * consent is created — a passenger with no preference record stays exactly as
 * they are, which means no marketing.
 *
 * The four automations are seeded DISABLED and in TEST mode. Applying this
 * migration changes nothing about what production sends.
 */
export class LifecycleAutomations1808000000000 implements MigrationInterface {
    name = 'LifecycleAutomations1808000000000';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`
            CREATE TABLE IF NOT EXISTS "communication_trigger" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "key" character varying(60) NOT NULL,
                "name" character varying(120) NOT NULL,
                "description" character varying(400),
                "consentClass" character varying(20) NOT NULL,
                "channels" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "templateKey" character varying(60) NOT NULL,
                "triggerCodes" jsonb NOT NULL DEFAULT '[]'::jsonb,
                "enabled" boolean NOT NULL DEFAULT false,
                "mode" character varying(20) NOT NULL DEFAULT 'TEST',
                "delayMinutes" integer NOT NULL DEFAULT 0,
                "cooldownMinutes" integer NOT NULL DEFAULT 0,
                "frequencyCap" integer NOT NULL DEFAULT 0,
                "frequencyWindowDays" integer NOT NULL DEFAULT 30,
                "audienceCriteria" jsonb,
                "lastTriggeredAt" TIMESTAMP,
                "sentCount" integer NOT NULL DEFAULT 0,
                "failedCount" integer NOT NULL DEFAULT 0,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_communication_trigger" PRIMARY KEY ("id")
            )`);
        await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comm_trigger_key" ON "communication_trigger" ("key")`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_trigger_enabled" ON "communication_trigger" ("enabled")`);

        await q.query(`
            CREATE TABLE IF NOT EXISTS "communication_dispatch" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "triggerKey" character varying(60) NOT NULL,
                "dedupeKey" character varying(120) NOT NULL,
                "userId" character varying NOT NULL,
                "channel" character varying(20) NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'queued',
                "reason" character varying(200),
                "rideId" character varying,
                "outcomeReason" character varying(40),
                "providerMessageId" character varying,
                "mode" character varying(20),
                "sendAfter" TIMESTAMP,
                "attempts" integer NOT NULL DEFAULT 0,
                "sentAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_communication_dispatch" PRIMARY KEY ("id")
            )`);
        /*
         * The guarantee behind "one thank-you per ride". Enforced by the
         * database because a duplicate completion event, two racing workers and
         * a restart mid-send are all things application code cannot exclude.
         */
        await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comm_dispatch_dedupe"
                       ON "communication_dispatch" ("triggerKey", "dedupeKey", "channel")`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_dispatch_user" ON "communication_dispatch" ("userId", "createdAt")`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_dispatch_trigger" ON "communication_dispatch" ("triggerKey", "createdAt")`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_dispatch_status" ON "communication_dispatch" ("status")`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_comm_dispatch_due" ON "communication_dispatch" ("status", "sendAfter")`);

        await q.query(`
            CREATE TABLE IF NOT EXISTS "communication_test_subject" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" character varying NOT NULL,
                "scope" character varying(20) NOT NULL,
                "note" character varying(200),
                "addedByStaffId" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_communication_test_subject" PRIMARY KEY ("id")
            )`);
        await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_comm_test_subject"
                       ON "communication_test_subject" ("userId", "scope")`);

        // Campaign dispatch lease + rollout mode.
        await q.query(`ALTER TABLE "communication_campaign" ADD COLUMN IF NOT EXISTS "dispatchLeaseUntil" TIMESTAMP`);
        await q.query(`ALTER TABLE "communication_campaign" ADD COLUMN IF NOT EXISTS "dispatchLeaseOwner" character varying(80)`);
        await q.query(`ALTER TABLE "communication_campaign" ADD COLUMN IF NOT EXISTS "mode" character varying(20) NOT NULL DEFAULT 'TEST'`);

        /*
         * Seed the four automations. All disabled, all TEST.
         *
         * The apology fires for NO_ELIGIBLE_DRIVER and NO_DRIVER_ACCEPTED
         * alike — the passenger's experience is identical — while the dispatch
         * row keeps whichever code actually applied, so supply and driver
         * behaviour stay separable in reporting.
         */
        await q.query(`
            INSERT INTO "communication_trigger"
                ("key","name","description","consentClass","channels","templateKey",
                 "triggerCodes","enabled","mode","delayMinutes","cooldownMinutes",
                 "frequencyCap","frequencyWindowDays")
            VALUES
                ('ride_completed','Ride completed',
                 'Thanks a passenger after a genuine completed trip.',
                 'service','["email","push"]'::jsonb,'ride_completed_thank_you',
                 '["COMPLETED"]'::jsonb,false,'TEST',5,0,0,30),

                ('ride_not_fulfilled','Ride not fulfilled',
                 'Apologises when KekeRide could not connect the passenger with a Keke.',
                 'service','["email","push"]'::jsonb,'ride_not_fulfilled_apology',
                 '["NO_ELIGIBLE_DRIVER","NO_DRIVER_ACCEPTED"]'::jsonb,false,'TEST',10,360,2,7),

                ('first_ride_reminder','First ride reminder',
                 'Encourages a registered passenger who has never completed a ride.',
                 'marketing','["email","push"]'::jsonb,'welcome',
                 '[]'::jsonb,false,'TEST',0,10080,1,30),

                ('inactive_passenger','Inactive passenger',
                 'Re-engages a passenger who has not ridden recently.',
                 'marketing','["email","push"]'::jsonb,'reactivation',
                 '[]'::jsonb,false,'TEST',0,20160,1,30)
            ON CONFLICT DO NOTHING`);
    }

    public async down(q: QueryRunner): Promise<void> {
        await q.query(`ALTER TABLE "communication_campaign" DROP COLUMN IF EXISTS "mode"`);
        await q.query(`ALTER TABLE "communication_campaign" DROP COLUMN IF EXISTS "dispatchLeaseOwner"`);
        await q.query(`ALTER TABLE "communication_campaign" DROP COLUMN IF EXISTS "dispatchLeaseUntil"`);
        await q.query(`DROP TABLE IF EXISTS "communication_test_subject"`);
        await q.query(`DROP TABLE IF EXISTS "communication_dispatch"`);
        await q.query(`DROP TABLE IF EXISTS "communication_trigger"`);
    }
}
