import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The delivery-event log.
 *
 * Purely additive: one new table, no change to any existing column, index or
 * constraint. Nothing reads it until the webhook endpoint receives its first
 * event, so applying this on a running production changes no behaviour at all.
 *
 * Down drops only the table this created.
 */
export class EmailWebhookEvents1800000000000 implements MigrationInterface {
    name = 'EmailWebhookEvents1800000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "email_webhook_event" (
                "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "svixId"            character varying(120) NOT NULL,
                "type"              character varying(80) NOT NULL,
                "providerMessageId" character varying,
                "email"             character varying,
                "payload"           jsonb NOT NULL,
                "outcome"           character varying(300),
                "processedAt"       TIMESTAMP,
                "createdAt"         TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_email_webhook_event" PRIMARY KEY ("id")
            )
        `);

        /*
         * The unique index is load-bearing, not an optimisation. Svix retries
         * the same event on any timeout, and without this a retry would count a
         * second open or write a second suppression entry.
         */
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_email_webhook_event_svixId"
            ON "email_webhook_event" ("svixId")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_email_webhook_event_type_createdAt"
            ON "email_webhook_event" ("type", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_email_webhook_event_providerMessageId"
            ON "email_webhook_event" ("providerMessageId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "email_webhook_event"`);
    }
}
