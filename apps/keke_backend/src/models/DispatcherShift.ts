import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum DispatcherShiftStatus {
    OPEN = "open",
    CLOSED = "closed",
    /**
     * Nobody closed it and the park's operating window ended.
     *
     * Deliberately distinct from CLOSED: a shift that simply stopped is an
     * operational fact worth counting, and folding it into a normal close would
     * hide a dispatcher who never signs off.
     */
    ABANDONED = "abandoned",
}

export enum ShiftEndActor {
    DISPATCHER = "dispatcher",
    SUPERVISOR = "supervisor",
    ADMIN = "admin",
    SYSTEM = "system",
}

/**
 * One dispatcher, at one park, for one stretch of time.
 *
 * Authority to act at a park is the INTERSECTION of two things: a park-scoped
 * role assignment (who may ever dispatch here) and an open shift (who is
 * working right now). A dispatcher with the role but no open shift can read;
 * they cannot act. That is what makes "who was on duty at 14:20" answerable
 * without inferring it from the actions themselves.
 *
 * Multiple dispatchers may hold open shifts at one park simultaneously — the
 * pilot has one, but nothing here assumes it. One dispatcher may hold at most
 * ONE open shift anywhere, enforced by a partial unique index in the migration.
 */
@Entity()
@Index(["parkId", "status"])
@Index(["staffUserId", "status"])
@Index(["parkId", "startedAt"])
export class DispatcherShift {
    @PrimaryGeneratedColumn("uuid")
    shiftId!: string;

    @Index()
    @Column()
    parkId!: string;

    @Index()
    @Column()
    staffUserId!: string;

    /** Bound park device, once Phase 3 introduces them. */
    @Column({ type: "varchar", nullable: true })
    deviceId!: string | null;

    @Index()
    @Column({ type: "enum", enum: DispatcherShiftStatus, default: DispatcherShiftStatus.OPEN })
    status!: DispatcherShiftStatus;

    // ── Start ───────────────────────────────────────────────────────────

    @Column({ type: "timestamp" })
    startedAt!: Date;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    startLat!: number | null;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    startLng!: number | null;

    /** Distance from the park pin when the shift opened. */
    @Column({ type: "double precision", nullable: true })
    startDistanceM!: number | null;

    /**
     * Whether the opening location was inside the park's operatingRadiusM.
     *
     * FALSE does not block the shift — a GPS fix indoors at 6am is unreliable,
     * and refusing to let a dispatcher start work over it would be worse than
     * the risk. It is recorded, surfaced to supervisors, and reportable.
     */
    @Column({ default: false })
    startLocationVerified!: boolean;

    // ── End ─────────────────────────────────────────────────────────────

    @Index()
    @Column({ type: "timestamp", nullable: true })
    endedAt!: Date | null;

    @Column({ type: "enum", enum: ShiftEndActor, nullable: true })
    endedBy!: ShiftEndActor | null;

    /** The staff member who closed it — may differ from staffUserId on a force-close. */
    @Column({ type: "varchar", nullable: true })
    endedByStaffId!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    endReason!: string | null;

    /** Free text passed to whoever takes over. */
    @Column({ type: "varchar", length: 1000, nullable: true })
    handoverNotes!: string | null;

    // ── Counters ────────────────────────────────────────────────────────
    // Maintained by later phases. Present now so a shift closed today is
    // comparable with one closed after park dispatch goes live.

    @Column({ type: "int", default: 0 })
    requestsReceived!: number;

    @Column({ type: "int", default: 0 })
    assignmentsMade!: number;

    /** Claims still open at close. Always 0 until Phase 4 introduces claims. */
    @Column({ type: "int", default: 0 })
    openClaimsAtClose!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
