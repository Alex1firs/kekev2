import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Dispatcher push: staff-scoped device tokens and honest delivery evidence.
 *
 * Additive. Two new tables and their enums; nothing existing is touched. The
 * customer `device_token` table is deliberately left alone — see
 * docs/dispatcher_web_push_audit.md §3 for why staff tokens cannot live in it.
 *
 * Enum types are created with a guard rather than `CREATE TYPE` alone, because
 * this project runs migrations with `migrationsTransactionMode: 'each'` and a
 * half-applied run must be safe to repeat.
 */
export class CreateStaffPush1794000000000 implements MigrationInterface {
    name = 'CreateStaffPush1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        const createEnum = async (name: string, values: string[]) => {
            await queryRunner.query(`
                DO $$ BEGIN
                    CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(', ')});
                EXCEPTION WHEN duplicate_object THEN NULL;
                END $$;
            `);
        };

        await createEnum('staff_device_token_platform_enum', ['web', 'android', 'ios']);
        await createEnum('staff_device_token_status_enum', ['active', 'invalid', 'revoked']);
        await createEnum('staff_push_delivery_state_enum', [
            'queued', 'provider_accepted', 'service_worker_received',
            'notification_opened', 'request_viewed', 'failed',
            'token_invalid', 'permission_denied', 'unknown',
        ]);
        await createEnum('staff_push_delivery_reason_enum', [
            'new_request', 'reminder', 'final_reminder', 'test',
        ]);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_device_token" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "staffUserId" character varying NOT NULL,
                "token" text NOT NULL,
                "platform" "staff_device_token_platform_enum" NOT NULL DEFAULT 'web',
                "status" "staff_device_token_status_enum" NOT NULL DEFAULT 'active',
                "parkId" character varying,
                "shiftId" character varying,
                "deviceId" character varying,
                "deviceLabel" character varying(120),
                "userAgent" character varying(300),
                "lastSeenAt" TIMESTAMP,
                "lastPushAcceptedAt" TIMESTAMP,
                "lastPushReceivedAt" TIMESTAMP,
                "lastNotificationOpenedAt" TIMESTAMP,
                "revokedReason" character varying(200),
                "revokedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_staff_device_token" PRIMARY KEY ("id")
            )
        `);

        /*
         * One row per token, globally. The same browser cannot be two staff
         * members at once, and enforcing that here rather than only in code is
         * what makes the handover path (revoke, then re-register) correct under
         * concurrency.
         */
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_staff_device_token_token"
            ON "staff_device_token" ("token")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sdt_staff_status"
            ON "staff_device_token" ("staffUserId", "status")`);
        // The send path filters on exactly this: live devices at one park.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sdt_park_status"
            ON "staff_device_token" ("parkId", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sdt_device"
            ON "staff_device_token" ("deviceId")`);

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_push_delivery" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "staffUserId" character varying NOT NULL,
                "parkId" character varying,
                "jobId" character varying,
                "rideId" character varying,
                "staffDeviceTokenId" character varying,
                "tokenRef" character varying(24),
                "reason" "staff_push_delivery_reason_enum" NOT NULL DEFAULT 'new_request',
                "state" "staff_push_delivery_state_enum" NOT NULL DEFAULT 'queued',
                "providerRef" character varying(200),
                "detail" jsonb,
                "receivedAt" TIMESTAMP,
                "openedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_staff_push_delivery" PRIMARY KEY ("id")
            )
        `);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spd_job_staff"
            ON "staff_push_delivery" ("jobId", "staffUserId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spd_park_created"
            ON "staff_push_delivery" ("parkId", "createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_spd_staff"
            ON "staff_push_delivery" ("staffUserId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_push_delivery"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_device_token"`);
        // Enum types are left in place: dropping a type that a rolled-back
        // deploy may re-create costs nothing to keep and risks a failed revert.
    }
}
