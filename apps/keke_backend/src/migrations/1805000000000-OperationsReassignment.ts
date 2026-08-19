import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Operations driver reassignment.
 *
 * One enum value. The intervention and release reason codes live in
 * `operations_intervention`, whose `type` and `reason` are plain varchar
 * precisely so a new code needs no migration — only the dispatch_event enum is
 * constrained, because it is shared with the ride timeline.
 */
export class OperationsReassignment1805000000000 implements MigrationInterface {
    name = 'OperationsReassignment1805000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "dispatch_event_eventtype_enum" ADD VALUE IF NOT EXISTS 'ops_driver_released'`,
        );
    }

    public async down(): Promise<void> {
        // Postgres cannot drop an enum value without rewriting the type and
        // every row that references it. The value is additive and harmless;
        // leaving it is the safe rollback.
    }
}
