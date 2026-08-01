import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum RosterStatus {
    /** On the roster and eligible to be queued. */
    ACTIVE = "active",
    /** On the roster, temporarily not to be assigned. Reversible, reason recorded. */
    SUSPENDED = "suspended",
    /** Off the roster. Row retained so history stays answerable. */
    REMOVED = "removed",
}

/**
 * A driver's membership of one park's roster.
 *
 * Membership is not presence and not queue order, and conflating them is how
 * these systems become unusable. Membership says "this driver works out of this
 * park"; presence says where they are right now; queuePosition says who is next.
 * A driver can be a member while offline, at home, for weeks.
 *
 * A driver may belong to more than one park's roster — a real pattern where two
 * parks sit close together. Uniqueness is therefore on (parkId, driverId) among
 * non-removed rows, not on driverId alone.
 *
 * Deliberately NOT stored here:
 *   - wallet balance and debt — owned by Wallet, joined at read time. A cached
 *     copy would be wrong within one ride and could gate an assignment on a
 *     stale number;
 *   - last ride — derived from Ride in one grouped query;
 *   - device capability and phone — properties of the DRIVER, on DriverProfile
 *     and User, not of one park membership.
 */
@Entity()
@Index(["parkId", "status"])
@Index(["parkId", "queuePosition"])
export class ParkDriverRoster {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    parkId!: string;

    @Index()
    @Column()
    driverId!: string;

    @Index()
    @Column({ type: "enum", enum: RosterStatus, default: RosterStatus.ACTIVE })
    status!: RosterStatus;

    /**
     * Position in this park's queue, 1-based. NULL means "not queued" — which
     * is the normal state for a driver who is not at the park.
     *
     * Held as an explicit integer rather than derived from check-in time so a
     * supervisor can reorder after a real-world event (a driver returns from
     * fuelling and keeps their place) without rewriting timestamps to lie.
     */
    @Column({ type: "int", nullable: true })
    queuePosition!: number | null;

    /** When the driver joined this park's queue. Null when not queued. */
    @Column({ type: "timestamp", nullable: true })
    queuedAt!: Date | null;

    @Column({ type: "timestamp" })
    joinedAt!: Date;

    @Column({ type: "varchar", nullable: true })
    addedByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    removedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    removedByStaffId!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    removeReason!: string | null;

    /** Set while status is SUSPENDED. */
    @Column({ type: "varchar", length: 500, nullable: true })
    suspensionReason!: string | null;

    /** How many times this driver has been skipped in the queue. Fairness signal. */
    @Column({ type: "int", default: 0 })
    skipCount!: number;

    @Column({ type: "varchar", length: 500, nullable: true })
    notes!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
