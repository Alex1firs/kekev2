import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Consent, per channel.
 *
 * ── Why this could not wait ──────────────────────────────────────────────
 * Phase 1 modelled consent as one marketing switch plus two content
 * categories. That conflates two different questions: WHAT a passenger wants to
 * hear about, and HOW they are willing to be reached. They are genuinely
 * independent — somebody may happily take a push notification and want no email
 * at all, and SMS is a stronger imposition than either. Collapsing them means
 * the first person who says "email is fine, stop texting me" cannot be honoured
 * without asking them to give up both.
 *
 * It changes now, before the prompt starts collecting answers, because
 * migrating consent after the fact means deciding on somebody's behalf what
 * their single "yes" meant across four channels — and there is no honest
 * answer to that.
 *
 * ── Additive, and safe on the live table ─────────────────────────────────
 * Columns are ADDED to passenger_communication_preference. Nothing is dropped
 * or renamed, so a build still writing the Phase 1 fields keeps working. The
 * backfill maps the old master switch onto the two channels it actually
 * covered — email and in-app — and deliberately leaves push and SMS false,
 * because nobody consented to those and there is no basis for assuming it.
 *
 * Production currently holds zero rows, so the backfill is a formality there.
 * It is written correctly anyway: staging and any future restore will have data.
 */
export class ChannelConsent1797000000000 implements MigrationInterface {
    name = 'ChannelConsent1797000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "passenger_communication_preference"
            ADD COLUMN IF NOT EXISTS "marketingEmail" boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "marketingPush"  boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "marketingInApp" boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "marketingSms"   boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS "surveys"        boolean NOT NULL DEFAULT false
        `);

        /*
         * Prompt state.
         *
         * Without a count and a timestamp, "ask once, allow a limited reminder,
         * never nag" cannot be enforced: the app would either ask forever or
         * never ask again after a single dismissal.
         */
        await queryRunner.query(`
            ALTER TABLE "passenger_communication_preference"
            ADD COLUMN IF NOT EXISTS "promptShownCount" integer NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "promptLastShownAt" TIMESTAMP,
            ADD COLUMN IF NOT EXISTS "promptAnsweredAt" TIMESTAMP,
            ADD COLUMN IF NOT EXISTS "consentAppVersion" character varying(40)
        `);

        /*
         * Map the old switch onto the channels it genuinely covered.
         *
         * `marketing` in Phase 1 only ever gated email — that was the only
         * channel that existed. It is carried to email and to in-app, which is
         * the same surface the passenger was agreeing to see offers on.
         *
         * Push and SMS stay false. Nobody agreed to be texted, and inferring it
         * from an email opt-in is exactly the assumption this whole subsystem
         * exists to refuse.
         */
        await queryRunner.query(`
            UPDATE "passenger_communication_preference"
            SET "marketingEmail" = "marketing" AND "promotionalOffers",
                "marketingInApp" = "marketing" AND "promotionalOffers"
            WHERE "marketing" = true
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_comm_pref_channels"
            ON "passenger_communication_preference"
            ("marketingEmail", "marketingPush", "marketingInApp", "marketingSms")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_comm_pref_channels"`);
        await queryRunner.query(`
            ALTER TABLE "passenger_communication_preference"
            DROP COLUMN IF EXISTS "marketingEmail",
            DROP COLUMN IF EXISTS "marketingPush",
            DROP COLUMN IF EXISTS "marketingInApp",
            DROP COLUMN IF EXISTS "marketingSms",
            DROP COLUMN IF EXISTS "surveys",
            DROP COLUMN IF EXISTS "promptShownCount",
            DROP COLUMN IF EXISTS "promptLastShownAt",
            DROP COLUMN IF EXISTS "promptAnsweredAt",
            DROP COLUMN IF EXISTS "consentAppVersion"
        `);
    }
}
