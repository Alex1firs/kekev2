import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Staff identity, permissions, audit and contact-reveal foundation.
 *
 * Entirely additive: five new tables plus one nullable column on an existing
 * one. Nothing existing is dropped, renamed or re-typed, so this migration
 * cannot affect dispatch, rides, wallets or the current admin dashboard.
 *
 * The legacy `audit_log` table is deliberately left alone. It records the
 * role-level actions of the shared-key era; rewriting it with identities it
 * never captured would be inventing history. New staff actions go to
 * `staff_audit_event`, and the two are shown together in the admin UI with the
 * legacy rows clearly labelled.
 */
export class CreateStaffIdentity1788000000000 implements MigrationInterface {
    name = 'CreateStaffIdentity1788000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // uuid_generate_v4() comes from uuid-ossp, created by the initial
        // schema migration. Re-asserted here so this migration also applies to
        // a database built from a partial restore.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // ── enums ────────────────────────────────────────────────────────
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "staff_user_status_enum" AS ENUM
                    ('invited', 'active', 'locked', 'suspended', 'deactivated');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "contact_reveal_event_actortype_enum" AS ENUM
                    ('staff', 'assigned_driver', 'legacy_admin');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE TYPE "contact_reveal_event_subjectrole_enum" AS ENUM
                    ('passenger', 'driver');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        // ── staff_user ───────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_user" (
                "id"                    uuid NOT NULL DEFAULT uuid_generate_v4(),
                "email"                 character varying NOT NULL,
                "phone"                 character varying(32) NOT NULL,
                "firstName"             character varying NOT NULL,
                "lastName"              character varying NOT NULL,
                "passwordHash"          character varying,
                "status"                "staff_user_status_enum" NOT NULL DEFAULT 'invited',
                "credentialVersion"     integer NOT NULL DEFAULT 1,
                "lastPasswordChangeAt"  TIMESTAMP,
                "setupTokenHash"        character varying,
                "setupTokenExpiresAt"   TIMESTAMP,
                "lastLoginAt"           TIMESTAMP,
                "failedLoginCount"      integer NOT NULL DEFAULT 0,
                "lockedUntil"           TIMESTAMP,
                "suspendedAt"           TIMESTAMP,
                "suspendedBy"           character varying,
                "suspensionReason"      character varying(500),
                "mfaEnabled"            boolean NOT NULL DEFAULT false,
                "mfaSecret"             character varying,
                "mfaEnrolledAt"         TIMESTAMP,
                "createdByStaffId"      character varying,
                "createdAt"             TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"             TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_staff_user" PRIMARY KEY ("id")
            )
        `);
        // Unique on email and phone: one human, one account. Without these a
        // suspended member could simply be re-invited alongside their old row.
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_staff_user_email" ON "staff_user" ("email")`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_staff_user_phone" ON "staff_user" ("phone")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_staff_user_status" ON "staff_user" ("status")`);

        // ── staff_role_assignment ────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_role_assignment" (
                "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "staffUserId"       character varying NOT NULL,
                "role"              character varying(40) NOT NULL,
                "parkId"            character varying,
                "grantedByStaffId"  character varying NOT NULL,
                "grantedAt"         TIMESTAMP NOT NULL DEFAULT now(),
                "revokedAt"         TIMESTAMP,
                "revokedByStaffId"  character varying,
                "revokeReason"      character varying(500),
                CONSTRAINT "PK_staff_role_assignment" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sra_staff" ON "staff_role_assignment" ("staffUserId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sra_park" ON "staff_role_assignment" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sra_revoked" ON "staff_role_assignment" ("revokedAt")`);
        // The permission-resolution query on every authenticated staff request.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sra_staff_revoked" ON "staff_role_assignment" ("staffUserId", "revokedAt")`);

        // ── staff_session ────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_session" (
                "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
                "staffUserId"        character varying NOT NULL,
                "refreshTokenHash"   character varying NOT NULL,
                "credentialVersion"  integer NOT NULL DEFAULT 1,
                "deviceId"           character varying,
                "issuedAt"           TIMESTAMP NOT NULL DEFAULT now(),
                "expiresAt"          TIMESTAMP NOT NULL,
                "lastUsedAt"         TIMESTAMP,
                "revokedAt"          TIMESTAMP,
                "revokedReason"      character varying(64),
                "ipAddress"          character varying(64),
                "userAgent"          character varying(300),
                CONSTRAINT "PK_staff_session" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ss_staff" ON "staff_session" ("staffUserId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ss_refresh" ON "staff_session" ("refreshTokenHash")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ss_revoked" ON "staff_session" ("revokedAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ss_staff_revoked" ON "staff_session" ("staffUserId", "revokedAt")`);

        // ── staff_audit_event ────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "staff_audit_event" (
                "id"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
                "actorStaffUserId"   character varying NOT NULL,
                "actorRoleSnapshot"  character varying(300),
                "actorIsLegacy"      boolean NOT NULL DEFAULT false,
                "action"             character varying(80) NOT NULL,
                "resourceType"       character varying(60) NOT NULL,
                "resourceId"         character varying,
                "outcome"            character varying(16) NOT NULL DEFAULT 'success',
                "parkId"             character varying,
                "rideId"             character varying,
                "driverId"           character varying,
                "passengerId"        character varying,
                "deviceId"           character varying,
                "reason"             character varying(500),
                "metadata"           jsonb,
                "ipAddress"          character varying(64),
                "userAgent"          character varying(300),
                "correlationId"      character varying(64),
                "createdAt"          TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_staff_audit_event" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_actor" ON "staff_audit_event" ("actorStaffUserId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_action" ON "staff_audit_event" ("action")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_legacy" ON "staff_audit_event" ("actorIsLegacy")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_outcome" ON "staff_audit_event" ("outcome")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_park" ON "staff_audit_event" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_ride" ON "staff_audit_event" ("rideId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_correlation" ON "staff_audit_event" ("correlationId")`);
        // The three list views the admin audit screen offers.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_actor_time" ON "staff_audit_event" ("actorStaffUserId", "createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_action_time" ON "staff_audit_event" ("action", "createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sae_resource" ON "staff_audit_event" ("resourceType", "resourceId")`);

        // ── contact_reveal_event ─────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "contact_reveal_event" (
                "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
                "rideId"         character varying,
                "actorType"      "contact_reveal_event_actortype_enum" NOT NULL,
                "actorId"        character varying NOT NULL,
                "subjectUserId"  character varying NOT NULL,
                "subjectRole"    "contact_reveal_event_subjectrole_enum" NOT NULL,
                "fields"         character varying(200) NOT NULL,
                "reason"         character varying(500),
                "expiresAt"      TIMESTAMP NOT NULL,
                "deviceId"       character varying,
                "ipAddress"      character varying(64),
                "correlationId"  character varying(64),
                "createdAt"      TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_contact_reveal_event" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cre_ride" ON "contact_reveal_event" ("rideId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cre_actor" ON "contact_reveal_event" ("actorId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cre_expires" ON "contact_reveal_event" ("expiresAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cre_ride_time" ON "contact_reveal_event" ("rideId", "createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cre_actor_time" ON "contact_reveal_event" ("actorId", "createdAt")`);

        // ── device_token.appVersion ──────────────────────────────────────
        // Nullable with no default: every existing install stays NULL, which
        // the contact-privacy layer reads as "old app, keep legacy behaviour".
        await queryRunner.query(`
            ALTER TABLE "device_token" ADD COLUMN IF NOT EXISTS "appVersion" character varying(32)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_token" DROP COLUMN IF EXISTS "appVersion"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "contact_reveal_event"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_audit_event"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_session"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_role_assignment"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "staff_user"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "contact_reveal_event_subjectrole_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "contact_reveal_event_actortype_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "staff_user_status_enum"`);
    }
}
