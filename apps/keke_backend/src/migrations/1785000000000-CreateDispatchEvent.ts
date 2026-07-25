import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Durable dispatch audit trail for the Live Ride Requests admin monitor, plus
 * the two optional trip-estimate columns the monitor reports.
 *
 * `dispatch_event` is append-only and holds no personal data — only opaque ride
 * and driver ids. It is a projection of the authoritative in-memory dispatch
 * evidence, written from the same hooks; nothing in the dispatch path reads it.
 *
 * Fully additive and safe to run against live prod: new table plus two nullable
 * columns. No existing column is altered, so a rollback loses only monitoring
 * history, never ride or payment data.
 */
export class CreateDispatchEvent1785000000000 implements MigrationInterface {
    name = 'CreateDispatchEvent1785000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "dispatch_event_eventtype_enum" AS ENUM (
                    'ride_created',
                    'round_started',
                    'round_transition',
                    'candidate_discovered',
                    'eligibility_passed',
                    'eligibility_rejected',
                    'candidate_stale',
                    'reservation_acquired',
                    'reservation_conflict',
                    'notification_queued',
                    'socket_offer_emitted',
                    'fcm_accepted_by_provider',
                    'offer_delivery_failed',
                    'device_offer_ack',
                    'driver_rejected',
                    'offer_expired',
                    'driver_accepted',
                    'dispatch_failed',
                    'ride_cancelled'
                );
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "dispatch_event" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "rideId" character varying NOT NULL,
                "sequence" integer NOT NULL DEFAULT 0,
                "eventType" "dispatch_event_eventtype_enum" NOT NULL,
                "dispatchRound" integer,
                "driverId" character varying,
                "radiusKm" double precision,
                "distanceKm" double precision,
                "heartbeatAgeMs" integer,
                "locationAgeMs" integer,
                "detail" jsonb,
                "occurredAt" TIMESTAMP NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_dispatch_event" PRIMARY KEY ("id")
            )
        `);

        // Timeline for one ride, in stable order.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_event_ride_seq" ON "dispatch_event" ("rideId", "sequence")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_event_rideId" ON "dispatch_event" ("rideId")`);
        // Per-driver behaviour metrics over a time window.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_event_driver_created" ON "dispatch_event" ("driverId", "createdAt")`);
        // Historical analytics by event kind.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_event_type_created" ON "dispatch_event" ("eventType", "createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_dispatch_event_eventType" ON "dispatch_event" ("eventType")`);

        // Trip estimates the passenger app already computes for its own fare
        // screen but never transmitted. Optional, so older app builds that omit
        // them simply leave these null and the monitor shows "—".
        await queryRunner.query(`
            ALTER TABLE "ride"
                ADD COLUMN IF NOT EXISTS "estimatedDistanceM" integer,
                ADD COLUMN IF NOT EXISTS "estimatedDurationSec" integer
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "ride"
                DROP COLUMN IF EXISTS "estimatedDistanceM",
                DROP COLUMN IF EXISTS "estimatedDurationSec"
        `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dispatch_event_eventType"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dispatch_event_type_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dispatch_event_driver_created"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dispatch_event_rideId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dispatch_event_ride_seq"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "dispatch_event"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "dispatch_event_eventtype_enum"`);
    }
}
