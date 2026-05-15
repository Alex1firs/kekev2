import { MigrationInterface, QueryRunner } from "typeorm";

export class PatchEnumValuesFix1756600000001 implements MigrationInterface {
    name = 'PatchEnumValuesFix1756600000001'
    transaction = false; // ALTER TYPE ADD VALUE cannot run inside a transaction block in Postgres

    public async up(queryRunner: QueryRunner): Promise<void> {
        // We do not catch errors here so that if it fails, we know about it and it rolls back the migration execution state.
        
        // We first check if the enum values exist to prevent "enum value already exists" errors since we are outside a transaction.
        // Wait, ADD VALUE IF NOT EXISTS is supported in Postgres 10+. We can just use that.
        
        await queryRunner.query(`ALTER TYPE "ledger_entry_balancetype_enum" ADD VALUE IF NOT EXISTS 'platform_revenue'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'commission_credit'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_received'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_externalized'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'debt_recovery'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }
}
