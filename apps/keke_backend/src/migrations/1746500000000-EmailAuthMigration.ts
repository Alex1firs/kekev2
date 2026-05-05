import { MigrationInterface, QueryRunner } from "typeorm";

export class EmailAuthMigration1746500000000 implements MigrationInterface {
    name = 'EmailAuthMigration1746500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add email column (nullable first to allow data migration)
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD COLUMN IF NOT EXISTS "email" character varying
        `);

        // For pre-pilot: backfill existing phone-only accounts with a placeholder email
        // so the UNIQUE constraint can be applied. Real users should reset their email on next login.
        await queryRunner.query(`
            UPDATE "user"
            SET "email" = 'phone_' || "phone" || '@migrate.kekeride.ng'
            WHERE "email" IS NULL
        `);

        // Now make email NOT NULL and add unique constraint
        await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "email" SET NOT NULL`);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "user" ADD CONSTRAINT "UQ_user_email" UNIQUE ("email");
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);

        // Make phone nullable (it's now a profile field, not auth identifier)
        await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "phone" DROP NOT NULL`);

        // Drop the old unique constraint on phone if it exists
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "user" DROP CONSTRAINT "UQ_user_phone";
            EXCEPTION
                WHEN undefined_object THEN NULL;
            END $$;
        `);

        // Add emailVerified column
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD COLUMN IF NOT EXISTS "emailVerified" boolean NOT NULL DEFAULT false
        `);

        // Add emailVerifiedAt column
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP
        `);

        // Index for email lookups
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_email" ON "user" ("email")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_email"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerifiedAt"`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "emailVerified"`);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "user" ADD CONSTRAINT "UQ_user_phone" UNIQUE ("phone");
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
        `);
        await queryRunner.query(`ALTER TABLE "user" ALTER COLUMN "phone" SET NOT NULL`);
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "user" DROP CONSTRAINT "UQ_user_email";
            EXCEPTION
                WHEN undefined_object THEN NULL;
            END $$;
        `);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN IF EXISTS "email"`);
    }
}
