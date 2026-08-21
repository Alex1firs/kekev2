import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from "typeorm";

/**
 * The explicit allow-list for TEST and PILOT sending.
 *
 * An allow-list rather than a flag on the user row so that adding somebody is
 * a deliberate, attributable act with a reason attached, and so the list can be
 * read in one query when the audience is built.
 */
@Entity()
@Index(["userId", "scope"], { unique: true })
export class CommunicationTestSubject {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    userId!: string;

    /** TEST or PILOT. A person may be on both. */
    @Column({ type: "varchar", length: 20 })
    scope!: string;

    @Column({ type: "varchar", length: 200, nullable: true })
    note!: string | null;

    @Column({ type: "varchar", nullable: true })
    addedByStaffId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
