import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1714500000000 implements MigrationInterface {
    name = 'InitialSchema1714500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

        // Enum types
        await queryRunner.query(`CREATE TYPE "user_role_enum" AS ENUM ('passenger', 'driver', 'admin')`);
        await queryRunner.query(`CREATE TYPE "driver_profile_status_enum" AS ENUM ('pending_documents', 'pending_review', 'approved', 'rejected', 'suspended')`);
        await queryRunner.query(`CREATE TYPE "ride_status_enum" AS ENUM ('searching', 'accepted', 'arrived', 'in_progress', 'started', 'completed', 'canceled', 'failed')`);
        await queryRunner.query(`CREATE TYPE "ledger_entry_balance_type_enum" AS ENUM ('passenger', 'driver_available', 'driver_pending', 'driver_commission_debt')`);
        await queryRunner.query(`CREATE TYPE "ledger_entry_transaction_type_enum" AS ENUM ('topup', 'trip_payment', 'commission_charge', 'payout', 'refund')`);
        await queryRunner.query(`CREATE TYPE "transaction_status_enum" AS ENUM ('pending', 'success', 'failed', 'reversed')`);
        await queryRunner.query(`CREATE TYPE "device_token_role_enum" AS ENUM ('passenger', 'driver', 'admin')`);
        await queryRunner.query(`CREATE TYPE "payout_record_status_enum" AS ENUM ('pending', 'processing', 'success', 'failed')`);

        // user
        await queryRunner.query(`
            CREATE TABLE "user" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "phone" character varying NOT NULL,
                "password" character varying NOT NULL,
                "firstName" character varying NOT NULL,
                "lastName" character varying NOT NULL,
                "role" "user_role_enum" NOT NULL DEFAULT 'passenger',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_user_phone" UNIQUE ("phone"),
                CONSTRAINT "PK_user" PRIMARY KEY ("id")
            )
        `);

        // wallet
        await queryRunner.query(`
            CREATE TABLE "wallet" (
                "userId" character varying NOT NULL,
                "passengerBalance" numeric(12,2) NOT NULL DEFAULT '0',
                "driverAvailableBalance" numeric(12,2) NOT NULL DEFAULT '0',
                "driverPendingBalance" numeric(12,2) NOT NULL DEFAULT '0',
                "driverCommissionDebt" numeric(12,2) NOT NULL DEFAULT '0',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_wallet" PRIMARY KEY ("userId")
            )
        `);

        // driver_profile
        await queryRunner.query(`
            CREATE TABLE "driver_profile" (
                "userId" character varying NOT NULL,
                "firstName" character varying NOT NULL,
                "lastName" character varying NOT NULL,
                "vehiclePlate" character varying NOT NULL,
                "vehicleModel" character varying NOT NULL,
                "status" "driver_profile_status_enum" NOT NULL DEFAULT 'pending_documents',
                "rejectionReason" character varying,
                "licenseUrl" character varying,
                "idCardUrl" character varying,
                "vehiclePaperUrl" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_driver_profile" PRIMARY KEY ("userId")
            )
        `);

        // ride
        await queryRunner.query(`
            CREATE TABLE "ride" (
                "rideId" character varying NOT NULL,
                "passengerId" character varying NOT NULL,
                "driverId" character varying,
                "fare" numeric(12,2) NOT NULL,
                "paymentMode" character varying NOT NULL,
                "status" "ride_status_enum" NOT NULL DEFAULT 'searching',
                "pickupAddress" character varying,
                "destinationAddress" character varying,
                "pickupLat" numeric(10,7),
                "pickupLng" numeric(10,7),
                "destinationLat" numeric(10,7),
                "destinationLng" numeric(10,7),
                "paymentFailed" boolean DEFAULT false,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "completedAt" TIMESTAMP,
                CONSTRAINT "PK_ride" PRIMARY KEY ("rideId")
            )
        `);

        // ledger_entry (FK to wallet)
        await queryRunner.query(`
            CREATE TABLE "ledger_entry" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "walletId" character varying NOT NULL,
                "balanceType" "ledger_entry_balance_type_enum" NOT NULL,
                "transactionType" "ledger_entry_transaction_type_enum" NOT NULL,
                "amount" numeric(12,2) NOT NULL,
                "balanceBefore" numeric(12,2) NOT NULL,
                "balanceAfter" numeric(12,2) NOT NULL,
                "metadata" jsonb,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_ledger_entry" PRIMARY KEY ("id"),
                CONSTRAINT "FK_ledger_entry_wallet" FOREIGN KEY ("walletId") REFERENCES "wallet"("userId") ON DELETE CASCADE
            )
        `);

        // transaction
        await queryRunner.query(`
            CREATE TABLE "transaction" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" character varying NOT NULL,
                "amount" numeric(12,2) NOT NULL,
                "reference" character varying NOT NULL,
                "status" "transaction_status_enum" NOT NULL DEFAULT 'pending',
                "paymentMethod" character varying,
                "metadata" jsonb,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_transaction_reference" UNIQUE ("reference"),
                CONSTRAINT "PK_transaction" PRIMARY KEY ("id")
            )
        `);

        // device_token
        await queryRunner.query(`
            CREATE TABLE "device_token" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" character varying NOT NULL,
                "role" "device_token_role_enum" NOT NULL,
                "platform" character varying NOT NULL,
                "token" character varying NOT NULL,
                "deviceLabel" character varying,
                "isActive" boolean NOT NULL DEFAULT true,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                "lastSeenAt" TIMESTAMP,
                CONSTRAINT "UQ_device_token_token" UNIQUE ("token"),
                CONSTRAINT "PK_device_token" PRIMARY KEY ("id")
            )
        `);

        // audit_log
        await queryRunner.query(`
            CREATE TABLE "audit_log" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "adminId" character varying NOT NULL,
                "action" character varying NOT NULL,
                "entityType" character varying NOT NULL,
                "entityId" character varying NOT NULL,
                "details" jsonb,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_audit_log" PRIMARY KEY ("id")
            )
        `);

        // payout_record
        await queryRunner.query(`
            CREATE TABLE "payout_record" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "driverId" character varying NOT NULL,
                "amount" numeric(12,2) NOT NULL,
                "status" "payout_record_status_enum" NOT NULL DEFAULT 'pending',
                "bankCode" character varying,
                "accountNumber" character varying,
                "reference" character varying,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_payout_record" PRIMARY KEY ("id")
            )
        `);

        // Indexes
        await queryRunner.query(`CREATE INDEX "IDX_driver_profile_status" ON "driver_profile" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_passengerId" ON "ride" ("passengerId")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_driverId" ON "ride" ("driverId")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_status" ON "ride" ("status")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_passengerId_status" ON "ride" ("passengerId", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_driverId_status" ON "ride" ("driverId", "status")`);
        await queryRunner.query(`CREATE INDEX "IDX_ride_status_updatedAt" ON "ride" ("status", "updatedAt")`);
        await queryRunner.query(`CREATE INDEX "IDX_ledger_entry_walletId" ON "ledger_entry" ("walletId")`);
        await queryRunner.query(`CREATE INDEX "IDX_device_token_userId" ON "device_token" ("userId")`);
        await queryRunner.query(`CREATE INDEX "IDX_device_token_isActive" ON "device_token" ("isActive")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_token_isActive"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_token_userId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ledger_entry_walletId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_status_updatedAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_driverId_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_passengerId_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_status"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_driverId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ride_passengerId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_driver_profile_status"`);

        await queryRunner.query(`DROP TABLE IF EXISTS "payout_record"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "device_token"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "transaction"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "ledger_entry"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "ride"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "driver_profile"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "wallet"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "user"`);

        await queryRunner.query(`DROP TYPE IF EXISTS "payout_record_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "device_token_role_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "transaction_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "ledger_entry_transaction_type_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "ledger_entry_balance_type_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "ride_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "driver_profile_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "user_role_enum"`);
    }
}
