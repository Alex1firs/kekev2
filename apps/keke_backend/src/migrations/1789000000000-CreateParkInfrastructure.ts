import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Park Dispatch operational foundation: parks, zones, dispatcher shifts,
 * driver presence, park rosters and driver badges.
 *
 * Additive throughout — seven new tables plus three nullable columns on
 * driver_profile. Nothing existing is dropped, renamed or re-typed, and nothing
 * in dispatch, rides, wallets or the current admin dashboard reads any of it.
 * Applying this migration changes no observable behaviour; it only makes the
 * new surfaces possible.
 *
 * Three constraints here are load-bearing and are worth reading before the DDL:
 *
 *   1. one OPEN shift per dispatcher, enforced by a PARTIAL unique index. A
 *      person cannot be on duty in two places, and enforcing it in application
 *      code alone means the first concurrent request wins by luck;
 *   2. one non-removed roster row per (park, driver), also partial — a driver
 *      may rejoin a park after leaving it, so the constraint must not see
 *      removed rows;
 *   3. one ACTIVE badge per driver and one ACTIVE short code globally, so a
 *      six-digit code can never resolve to two people.
 */
export class CreateParkInfrastructure1789000000000 implements MigrationInterface {
    name = 'CreateParkInfrastructure1789000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // ── enums ────────────────────────────────────────────────────────
        const enums: Array<[string, string[]]> = [
            ['park_status_enum', ['draft', 'active', 'inactive', 'suspended']],
            ['park_zone_kind_enum', ['service', 'staging', 'boarding']],
            ['dispatcher_shift_status_enum', ['open', 'closed', 'abandoned']],
            ['dispatcher_shift_endedby_enum', ['dispatcher', 'supervisor', 'admin', 'system']],
            ['driver_presence_state_enum', [
                'offline', 'online', 'at_park', 'waiting', 'assigned',
                'en_route', 'passenger_boarding', 'trip_started', 'unavailable',
            ]],
            ['driver_presence_source_enum', ['driver_app', 'dispatcher', 'admin', 'system']],
            ['roster_status_enum', ['active', 'suspended', 'removed']],
            ['badge_status_enum', ['pending_activation', 'active', 'revoked', 'lost', 'replaced']],
        ];
        for (const [name, values] of enums) {
            const list = values.map((v) => `'${v}'`).join(', ');
            await queryRunner.query(`
                DO $$ BEGIN
                    CREATE TYPE "${name}" AS ENUM (${list});
                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            `);
        }

        // ── park ─────────────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "park" (
                "parkId"                 uuid NOT NULL DEFAULT uuid_generate_v4(),
                "name"                   character varying(120) NOT NULL,
                "code"                   character varying(24) NOT NULL,
                "addressLine"            character varying(300),
                "city"                   character varying(80),
                "state"                  character varying(80),
                "lat"                    numeric(10,7) NOT NULL,
                "lng"                    numeric(10,7) NOT NULL,
                "operatingRadiusM"       integer NOT NULL DEFAULT 200,
                "serviceRadiusKm"        double precision NOT NULL DEFAULT 4,
                "capacityDrivers"        integer NOT NULL DEFAULT 50,
                "maxConcurrentAssignments" integer NOT NULL DEFAULT 3,
                "priority"               integer NOT NULL DEFAULT 0,
                "status"                 "park_status_enum" NOT NULL DEFAULT 'draft',
                "opensAt"                character varying(5),
                "closesAt"               character varying(5),
                "daysOfWeek"             jsonb NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
                "timezone"               character varying(60) NOT NULL DEFAULT 'Africa/Lagos',
                "supportedTripTypes"     jsonb,
                "supervisorStaffId"      character varying,
                "escalationContactName"  character varying(120),
                "escalationContactPhone" character varying(32),
                "commissionConfig"       jsonb,
                "suspendedAt"            TIMESTAMP,
                "suspendedByStaffId"     character varying,
                "suspensionReason"       character varying(500),
                "createdByStaffId"       character varying,
                "createdAt"              TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"              TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_park" PRIMARY KEY ("parkId")
            )
        `);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_park_code" ON "park" ("code")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_park_status" ON "park" ("status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_park_priority" ON "park" ("priority")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_park_status_priority" ON "park" ("status", "priority")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_park_supervisor" ON "park" ("supervisorStaffId")`);
        // Guard rails that belong in the database, not only in a service: a
        // negative radius or a zero-capacity park is never a legitimate state.
        await queryRunner.query(`
            ALTER TABLE "park" ADD CONSTRAINT "CHK_park_geometry" CHECK (
                "lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180
                AND "operatingRadiusM" > 0 AND "serviceRadiusKm" > 0
                AND "capacityDrivers" > 0 AND "maxConcurrentAssignments" > 0
            )
        `);

        // ── park_zone ────────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "park_zone" (
                "zoneId"           uuid NOT NULL DEFAULT uuid_generate_v4(),
                "parkId"           character varying NOT NULL,
                "name"             character varying(120) NOT NULL,
                "code"             character varying(24) NOT NULL,
                "kind"             "park_zone_kind_enum" NOT NULL DEFAULT 'service',
                "lat"              numeric(10,7) NOT NULL,
                "lng"              numeric(10,7) NOT NULL,
                "radiusM"          integer NOT NULL DEFAULT 150,
                "priority"         integer NOT NULL DEFAULT 0,
                "capacityDrivers"  integer,
                "active"           boolean NOT NULL DEFAULT true,
                "notes"            character varying(500),
                "createdByStaffId" character varying,
                "createdAt"        TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"        TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_park_zone" PRIMARY KEY ("zoneId")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_zone_park" ON "park_zone" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_zone_active" ON "park_zone" ("active")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_zone_park_kind_active" ON "park_zone" ("parkId", "kind", "active")`);
        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_zone_park_code" ON "park_zone" ("parkId", "code")`);
        await queryRunner.query(`ALTER TABLE "park_zone" ADD CONSTRAINT "CHK_zone_radius" CHECK ("radiusM" > 0)`);

        // ── dispatcher_shift ─────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "dispatcher_shift" (
                "shiftId"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "parkId"                 character varying NOT NULL,
                "staffUserId"            character varying NOT NULL,
                "deviceId"               character varying,
                "status"                 "dispatcher_shift_status_enum" NOT NULL DEFAULT 'open',
                "startedAt"              TIMESTAMP NOT NULL,
                "startLat"               numeric(10,7),
                "startLng"               numeric(10,7),
                "startDistanceM"         double precision,
                "startLocationVerified"  boolean NOT NULL DEFAULT false,
                "endedAt"                TIMESTAMP,
                "endedBy"                "dispatcher_shift_endedby_enum",
                "endedByStaffId"         character varying,
                "endReason"              character varying(500),
                "handoverNotes"          character varying(1000),
                "requestsReceived"       integer NOT NULL DEFAULT 0,
                "assignmentsMade"        integer NOT NULL DEFAULT 0,
                "openClaimsAtClose"      integer NOT NULL DEFAULT 0,
                "createdAt"              TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"              TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_dispatcher_shift" PRIMARY KEY ("shiftId")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_park" ON "dispatcher_shift" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_staff" ON "dispatcher_shift" ("staffUserId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_status" ON "dispatcher_shift" ("status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_ended" ON "dispatcher_shift" ("endedAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_park_status" ON "dispatcher_shift" ("parkId", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_staff_status" ON "dispatcher_shift" ("staffUserId", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_shift_park_started" ON "dispatcher_shift" ("parkId", "startedAt")`);
        // ONE open shift per dispatcher, enforced by the database. A person
        // cannot be on duty in two places, and leaving this to application code
        // means two concurrent open requests both succeed.
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_shift_one_open_per_dispatcher"
                ON "dispatcher_shift" ("staffUserId") WHERE "status" = 'open'
        `);

        // ── driver_presence ──────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "driver_presence" (
                "driverId"        character varying NOT NULL,
                "state"           "driver_presence_state_enum" NOT NULL DEFAULT 'offline',
                "parkId"          character varying,
                "since"           TIMESTAMP NOT NULL,
                "source"          "driver_presence_source_enum" NOT NULL DEFAULT 'system',
                "setByStaffId"    character varying,
                "rideId"          character varying,
                "note"            character varying(200),
                "previousState"   "driver_presence_state_enum",
                "lastHeartbeatAt" TIMESTAMP,
                "createdAt"       TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"       TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_driver_presence" PRIMARY KEY ("driverId")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_presence_state" ON "driver_presence" ("state")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_presence_park" ON "driver_presence" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_presence_ride" ON "driver_presence" ("rideId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_presence_state_park" ON "driver_presence" ("state", "parkId")`);
        // The dispatcher board's main query: everyone at this park, in this
        // state, oldest first.
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_presence_park_state_since" ON "driver_presence" ("parkId", "state", "since")`);

        // ── driver_presence_event ────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "driver_presence_event" (
                "id"                       uuid NOT NULL DEFAULT uuid_generate_v4(),
                "driverId"                 character varying NOT NULL,
                "fromState"                "driver_presence_state_enum",
                "toState"                  "driver_presence_state_enum" NOT NULL,
                "parkId"                   character varying,
                "source"                   "driver_presence_source_enum" NOT NULL,
                "setByStaffId"             character varying,
                "rideId"                   character varying,
                "note"                     character varying(200),
                "previousStateDurationSec" integer,
                "occurredAt"               TIMESTAMP NOT NULL,
                "createdAt"                TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_driver_presence_event" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pevent_driver" ON "driver_presence_event" ("driverId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pevent_to" ON "driver_presence_event" ("toState")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pevent_park" ON "driver_presence_event" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pevent_driver_time" ON "driver_presence_event" ("driverId", "occurredAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pevent_park_time" ON "driver_presence_event" ("parkId", "occurredAt")`);

        // ── park_driver_roster ───────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "park_driver_roster" (
                "id"                uuid NOT NULL DEFAULT uuid_generate_v4(),
                "parkId"            character varying NOT NULL,
                "driverId"          character varying NOT NULL,
                "status"            "roster_status_enum" NOT NULL DEFAULT 'active',
                "queuePosition"     integer,
                "queuedAt"          TIMESTAMP,
                "joinedAt"          TIMESTAMP NOT NULL,
                "addedByStaffId"    character varying,
                "removedAt"         TIMESTAMP,
                "removedByStaffId"  character varying,
                "removeReason"      character varying(500),
                "suspensionReason"  character varying(500),
                "skipCount"         integer NOT NULL DEFAULT 0,
                "notes"             character varying(500),
                "createdAt"         TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"         TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_park_driver_roster" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_roster_park" ON "park_driver_roster" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_roster_driver" ON "park_driver_roster" ("driverId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_roster_status" ON "park_driver_roster" ("status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_roster_park_status" ON "park_driver_roster" ("parkId", "status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_roster_park_queue" ON "park_driver_roster" ("parkId", "queuePosition")`);
        // A driver appears on a park's roster ONCE — but may rejoin after
        // leaving, so removed rows are excluded from the constraint.
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_roster_park_driver_live"
                ON "park_driver_roster" ("parkId", "driverId") WHERE "status" <> 'removed'
        `);

        // ── driver_badge ─────────────────────────────────────────────────
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "driver_badge" (
                "badgeSerial"           character varying(24) NOT NULL,
                "driverId"              character varying NOT NULL,
                "driverPublicId"        character varying(32) NOT NULL,
                "shortCode"             character varying(6) NOT NULL,
                "keyVersion"            integer NOT NULL DEFAULT 1,
                "status"                "badge_status_enum" NOT NULL DEFAULT 'pending_activation',
                "parkId"                character varying,
                "issuedAt"              TIMESTAMP NOT NULL,
                "issuedByStaffId"       character varying NOT NULL,
                "printedAt"             TIMESTAMP,
                "activatedAt"           TIMESTAMP,
                "activatedByStaffId"    character varying,
                "revokedAt"             TIMESTAMP,
                "revokedByStaffId"      character varying,
                "revokeReason"          character varying(500),
                "replacedByBadgeSerial" character varying(24),
                "createdAt"             TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt"             TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_driver_badge" PRIMARY KEY ("badgeSerial")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_driver" ON "driver_badge" ("driverId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_public" ON "driver_badge" ("driverPublicId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_short" ON "driver_badge" ("shortCode")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_status" ON "driver_badge" ("status")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_park" ON "driver_badge" ("parkId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_badge_driver_status" ON "driver_badge" ("driverId", "status")`);
        // A six-digit code must never resolve to two people, and a driver must
        // never hold two live badges. Both scoped to usable statuses so a
        // revoked badge's code is retired rather than blocking forever.
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_shortcode_live"
                ON "driver_badge" ("shortCode") WHERE "status" IN ('active', 'pending_activation')
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_badge_one_live_per_driver"
                ON "driver_badge" ("driverId") WHERE "status" IN ('active', 'pending_activation')
        `);

        // ── driver_profile additions ─────────────────────────────────────
        // deviceCapability defaults to 'smartphone' because every driver on the
        // platform today signed up through the app. Nothing may INFER capability
        // from that default — it is corrected by whoever onboards the driver.
        await queryRunner.query(`
            ALTER TABLE "driver_profile"
                ADD COLUMN IF NOT EXISTS "deviceCapability" character varying(20) NOT NULL DEFAULT 'smartphone'
        `);
        await queryRunner.query(`ALTER TABLE "driver_profile" ADD COLUMN IF NOT EXISTS "unitNumber" character varying(24)`);
        await queryRunner.query(`ALTER TABLE "driver_profile" ADD COLUMN IF NOT EXISTS "homeParkId" character varying`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_driver_unit" ON "driver_profile" ("unitNumber")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_driver_home_park" ON "driver_profile" ("homeParkId")`);
        await queryRunner.query(`
            ALTER TABLE "driver_profile" ADD CONSTRAINT "CHK_driver_device_capability"
                CHECK ("deviceCapability" IN ('smartphone', 'feature_phone', 'none'))
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP CONSTRAINT IF EXISTS "CHK_driver_device_capability"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_driver_home_park"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_driver_unit"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN IF EXISTS "homeParkId"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN IF EXISTS "unitNumber"`);
        await queryRunner.query(`ALTER TABLE "driver_profile" DROP COLUMN IF EXISTS "deviceCapability"`);

        await queryRunner.query(`DROP TABLE IF EXISTS "driver_badge"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "park_driver_roster"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "driver_presence_event"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "driver_presence"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "dispatcher_shift"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "park_zone"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "park"`);

        for (const name of [
            'badge_status_enum', 'roster_status_enum', 'driver_presence_source_enum',
            'driver_presence_state_enum', 'dispatcher_shift_endedby_enum',
            'dispatcher_shift_status_enum', 'park_zone_kind_enum', 'park_status_enum',
        ]) {
            await queryRunner.query(`DROP TYPE IF EXISTS "${name}"`);
        }
    }
}
