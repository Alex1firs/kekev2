import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record what an operational action changed, not merely that it happened.
 *
 * ── Why ─────────────────────────────────────────────────────────────────
 * The audit trail already answered who, when, from where and to which park.
 * It did not consistently answer "from what, to what": presence changes buried
 * `{from, to}` in metadata, badge actions recorded a serial and no state, and
 * a supervisor reassignment recorded the new holder with no trace of who was
 * displaced. Reconstructing a park's history therefore meant knowing which
 * service wrote which metadata shape — which is exactly the kind of knowledge
 * an audit trail exists to make unnecessary.
 *
 * Two nullable text columns rather than a typed structure: the values compared
 * are a presence state, a staff id, a badge status, a device capability. What
 * they have in common is that a human needs to read them side by side.
 *
 * Nullable because plenty of audited actions create or delete rather than
 * change, and inventing an empty-string "previous value" for a badge that did
 * not exist would be a worse record than saying nothing.
 */
export class AuditValueChange1795000000000 implements MigrationInterface {
    name = 'AuditValueChange1795000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "staff_audit_event"
            ADD COLUMN IF NOT EXISTS "previousValue" text,
            ADD COLUMN IF NOT EXISTS "newValue" text
        `);

        /*
         * Backfill what can be recovered. Presence has always written
         * {from, to} into metadata, so those rows can be given first-class
         * values; nothing else had a reliable shape and is left null rather
         * than guessed at.
         */
        await queryRunner.query(`
            UPDATE "staff_audit_event"
            SET "previousValue" = metadata->>'from',
                "newValue"      = metadata->>'to'
            WHERE metadata ? 'from'
              AND metadata ? 'to'
              AND "previousValue" IS NULL
        `);

        // The operations centre reads this by park and time, newest first.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_staff_audit_park_created"
            ON "staff_audit_event" ("parkId", "createdAt" DESC)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_staff_audit_park_created"`);
        await queryRunner.query(`
            ALTER TABLE "staff_audit_event"
            DROP COLUMN IF EXISTS "previousValue",
            DROP COLUMN IF EXISTS "newValue"
        `);
    }
}
