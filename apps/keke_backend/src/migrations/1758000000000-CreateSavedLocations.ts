import { MigrationInterface, QueryRunner, Table, TableForeignKey } from "typeorm";

export class CreateSavedLocations1758000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: "saved_locations",
                columns: [
                    {
                        name: "id",
                        type: "uuid",
                        isPrimary: true,
                        isGenerated: true,
                        generationStrategy: "uuid",
                    },
                    {
                        name: "userId",
                        type: "uuid",
                    },
                    {
                        name: "name",
                        type: "varchar",
                    },
                    {
                        name: "address",
                        type: "varchar",
                    },
                    {
                        name: "lat",
                        type: "decimal",
                        precision: 10,
                        scale: 7,
                    },
                    {
                        name: "lng",
                        type: "decimal",
                        precision: 10,
                        scale: 7,
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

        await queryRunner.createForeignKey(
            "saved_locations",
            new TableForeignKey({
                columnNames: ["userId"],
                referencedColumnNames: ["id"],
                referencedTableName: "user",
                onDelete: "CASCADE",
            })
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable("saved_locations");
    }
}
