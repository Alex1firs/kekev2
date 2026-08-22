import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Durable driver work intent, separated from device health.
 *
 * ── Why the backfill is conservative ────────────────────────────────────
 * Intent is a statement a driver made. It cannot be reconstructed from
 * telemetry, and inventing it would be worse than not having it: 79 drivers
 * currently sit in the geo index with positions up to a day old, and marking
 * them ONLINE would start dispatching rides to people who went home yesterday.
 *
 * So only drivers whose availability key is live at migration time — provably
 * online this minute — are seeded ONLINE. Everyone else starts OFFLINE and
 * becomes ONLINE the first time they toggle, after which it persists for good.
 * That is a one-time re-toggle, and the honest option.
 *
 * The availability key itself is untouched. It remains a HEALTH signal; it has
 * simply stopped being the authority on whether a driver wants work.
 */
export class DriverPresenceIntent1809000000000 implements MigrationInterface {
    name = 'DriverPresenceIntent1809000000000';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`
            CREATE TABLE IF NOT EXISTS "driver_presence_intent" (
                "driverId" character varying NOT NULL,
                "state" character varying(20) NOT NULL DEFAULT 'OFFLINE',
                "since" TIMESTAMP NOT NULL DEFAULT now(),
                "setBy" character varying(20) NOT NULL DEFAULT 'DRIVER',
                "actorId" character varying,
                "reason" character varying(200),
                "lastReachableAt" TIMESTAMP,
                "lastWakeAttemptAt" TIMESTAMP,
                "failedWakeCount" integer NOT NULL DEFAULT 0,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_driver_presence_intent" PRIMARY KEY ("driverId")
            )`);
        await q.query(`CREATE INDEX IF NOT EXISTS "IDX_driver_intent_state"
                       ON "driver_presence_intent" ("state")`);

        /*
         * Give every approved driver a row so the table is complete and a
         * missing row never has to mean anything. All OFFLINE — the honest
         * default, and the safe one.
         */
        await q.query(`
            INSERT INTO "driver_presence_intent" ("driverId", "state", "since", "setBy", "reason")
            SELECT dp."userId", 'OFFLINE', now(), 'SYSTEM',
                   'Seeded by migration; intent had never been recorded'
              FROM "driver_profile" dp
             ON CONFLICT ("driverId") DO NOTHING`);
    }

    public async down(q: QueryRunner): Promise<void> {
        await q.query(`DROP INDEX IF EXISTS "IDX_driver_intent_state"`);
        await q.query(`DROP TABLE IF EXISTS "driver_presence_intent"`);
    }
}
