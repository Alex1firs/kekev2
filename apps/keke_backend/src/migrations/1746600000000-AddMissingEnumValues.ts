import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissingEnumValues1746600000000 implements MigrationInterface {
    name = 'AddMissingEnumValues1746600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Add missing BalanceType enum values
        await queryRunner.query(`ALTER TYPE "ledger_entry_balancetype_enum" ADD VALUE IF NOT EXISTS 'platform_revenue'`);

        // Add missing TransactionType enum values
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'commission_credit'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_received'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_externalized'`);
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'debt_recovery'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing enum values without recreating the type.
        // This migration is intentionally irreversible.
    }
}
