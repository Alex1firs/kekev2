import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";
import { StaffRole } from "../config/staff_permissions";

/**
 * A durable grant of one role to one staff member.
 *
 * Rows are never deleted — a revocation sets `revokedAt`. "Who could do this
 * last March" has to remain answerable, and a DELETE erases exactly the fact an
 * investigation needs.
 *
 * `parkId` scopes park-bound roles (PARK_SUPERVISOR, PARK_DISPATCHER, CASHIER)
 * to a single park. It is nullable and unused until Phase 2 creates the park
 * table; the column exists now so a grant made today does not have to be
 * rewritten then.
 */
@Entity()
@Index(["staffUserId", "revokedAt"])
export class StaffRoleAssignment {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    staffUserId!: string;

    @Column({ type: "varchar", length: 40 })
    role!: StaffRole;

    /** Park scope for park-bound roles. Null = global. No FK yet (Phase 2). */
    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    @Column({ type: "varchar" })
    grantedByStaffId!: string;

    @CreateDateColumn()
    grantedAt!: Date;

    /** Non-null once revoked. A revoked grant confers nothing. */
    @Index()
    @Column({ type: "timestamp", nullable: true })
    revokedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    revokedByStaffId!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    revokeReason!: string | null;
}
