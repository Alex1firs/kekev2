import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Human-centred stale-ride coordination.
 *
 * Reframes a delay as a coordination state rather than a failure. Real-world
 * delays — traffic, checkpoints, rain, a gate, a lift, office reception — are
 * normal, so the system now looks for evidence of ABANDONMENT instead of
 * treating elapsed time as proof of it.
 *
 * Adds: activity evidence (what proves the ride is alive), the operational
 * delay state support staff see, a two-sided cancellation request, and
 * escalation. Additive and nullable throughout.
 */
export class AddRideCoordinationState1787000000000 implements MigrationInterface {
    name = 'AddRideCoordinationState1787000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const value of [
            'ride_activity_recorded',
            'stale_reminder_sent',
            'cancellation_requested',
            'cancellation_request_accepted',
            'cancellation_request_declined',
            'stale_escalated_to_support',
            'rematch_offered',
        ]) {
            await queryRunner.query(
                `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
            );
        }

        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "lastActivityType" character varying(40),
                ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "delayState" character varying(48),
                ADD COLUMN IF NOT EXISTS "cancellationRequestedBy" character varying(16),
                ADD COLUMN IF NOT EXISTS "cancellationRequestedAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "cancellationRequestState" character varying(16),
                ADD COLUMN IF NOT EXISTS "escalatedToSupportAt" TIMESTAMP,
                ADD COLUMN IF NOT EXISTS "escalationReason" character varying(120)
        `);

        // The operations dashboard filters on delay state.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_delay_state"
                ON "ride" ("delayState")
                WHERE "delayState" IS NOT NULL
        `);
        // The support queue: escalated rides the system will not touch.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_escalated"
                ON "ride" ("escalatedToSupportAt")
                WHERE "escalatedToSupportAt" IS NOT NULL
        `);
        // Pending cancellation requests awaiting the other party.
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_ride_cancellation_request"
                ON "ride" ("cancellationRequestState")
                WHERE "cancellationRequestState" = 'pending'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_cancellation_request"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_escalated"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_delay_state"`);
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "escalationReason",
                DROP COLUMN IF EXISTS "escalatedToSupportAt",
                DROP COLUMN IF EXISTS "cancellationRequestState",
                DROP COLUMN IF EXISTS "cancellationRequestedAt",
                DROP COLUMN IF EXISTS "cancellationRequestedBy",
                DROP COLUMN IF EXISTS "delayState",
                DROP COLUMN IF EXISTS "lastReminderAt",
                DROP COLUMN IF EXISTS "lastActivityType",
                DROP COLUMN IF EXISTS "lastActivityAt"
        `);
    }
}
