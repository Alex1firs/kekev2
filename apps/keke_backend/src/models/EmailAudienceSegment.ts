import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

/**
 * A saved audience definition — a query, never a list of people.
 *
 * Storing membership would mean a segment built in June still contains the
 * passenger who unsubscribed in July. The definition is re-resolved every time
 * it is used, so consent, suppression and activity are always evaluated as they
 * are now.
 */
@Entity()
@Index(["name"])
export class EmailAudienceSegment {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "varchar", length: 160 })
    name!: string;

    @Column({ type: "varchar", length: 500, nullable: true })
    description!: string | null;

    /** Filters, in the shape AudienceService understands. */
    @Column({ type: "jsonb" })
    definition!: Record<string, unknown>;

    @Column()
    createdByStaffId!: string;

    /** Last resolved size, for display only. Never used to send. */
    @Column({ type: "int", nullable: true })
    lastCount!: number | null;

    @Column({ type: "timestamp", nullable: true })
    lastCountedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
