import { MigrationInterface, QueryRunner } from "typeorm";

export class PatchEnumValues1756600000000 implements MigrationInterface {
    name = 'PatchEnumValues1756600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Safe alteration of enums
        // In case the previous migration had typos and didn't apply properly on production
        await queryRunner.query(`ALTER TYPE "ledger_entry_balancetype_enum" ADD VALUE IF NOT EXISTS 'platform_revenue'`).catch(() => {});
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'commission_credit'`).catch(() => {});
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_received'`).catch(() => {});
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'cash_externalized'`).catch(() => {});
        await queryRunner.query(`ALTER TYPE "ledger_entry_transactiontype_enum" ADD VALUE IF NOT EXISTS 'debt_recovery'`).catch(() => {});
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }
}
