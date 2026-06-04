import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateSettingTable1759000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: "setting",
                columns: [
                    {
                        name: "key",
                        type: "varchar",
                        isPrimary: true,
                    },
                    {
                        name: "value",
                        type: "varchar",
                    },
                    {
                        name: "createdAt",
                        type: "timestamp",
                        default: "now()",
                    },
                    {
                        name: "updatedAt",
                        type: "timestamp",
                        default: "now()",
                    },
                ],
            }),
            true
        );

        // Seed default pricing configuration settings
        await queryRunner.query(`
            INSERT INTO "setting" ("key", "value") VALUES
            ('baseFare', '1300'),
            ('perKmRate', '300'),
            ('platformFeePercent', '10')
            ON CONFLICT ("key") DO NOTHING;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable("setting");
    }
}
