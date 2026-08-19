import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Who is currently driving dispatch for one ride: the system, or a human.
 *
 * ── Why a row and not a flag on the ride ─────────────────────────────────
 * Control is a separate concern from the ride's lifecycle, and conflating them
 * was the first thing to get wrong. A ride under Operations control is still
 * `searching` — the passenger is still waiting, no driver has accepted, and
 * nothing about their screen should change because a dispatcher is helping.
 * Putting control on the ride row invites code that treats "taken over" as a
 * status, which would leak into the passenger app.
 *
 * ── The lease ────────────────────────────────────────────────────────────
 * Control is held on a LEASE, not on a socket. A dispatcher standing in a park
 * in Onitsha loses signal constantly: 4G handover, a backgrounded PWA, a lift.
 * If a disconnect returned the ride to automatic dispatch, the system would
 * start offering it to other drivers while the dispatcher is mid-sentence on
 * the phone to one.
 *
 * So the client renews; the SERVER decides. A dead client's lease expires on
 * the server's clock, is swept, and control returns to AUTO with an audited
 * reason. Nothing about socket state participates in that decision.
 *
 * ── What control does and does not do ────────────────────────────────────
 * Holding control stops NEW automatic and park offers being created for that
 * ride. It does not, and cannot, undo an assignment that already won the
 * conditional UPDATE in assignDriverToRide — that remains the sole arbiter of
 * who owns a ride, and an in-flight driver acceptance beats a takeover that
 * lands a millisecond later.
 */
export enum DispatchControlMode {
    /** The system dispatches. Every ride starts here. */
    AUTO = "auto",
    /** A named dispatcher holds a live lease on this ride. */
    OPERATIONS = "operations",
}

/** Why control returned to AUTO. Stable codes; never free text. */
export enum ControlReleaseReason {
    /** The dispatcher pressed Release. */
    EXPLICIT = "explicit",
    /** A driver was assigned, by anyone. Control is no longer meaningful. */
    ASSIGNED = "assigned",
    /** The ride reached a terminal state under them. */
    RIDE_TERMINAL = "ride_terminal",
    /** The lease was not renewed in time. The client is gone. */
    LEASE_EXPIRED = "lease_expired",
    /** A supervisor took it back. */
    ADMIN_OVERRIDE = "admin_override",
}

@Entity()
@Index(["mode", "leaseExpiresAt"])
export class RideDispatchControl {
    /** One control row per ride. The ride id IS the key — takeover is a
     *  compare-and-set on this row, so a second row could never exist. */
    @PrimaryColumn()
    rideId!: string;

    @Index()
    @Column({ type: "varchar", length: 16, default: DispatchControlMode.AUTO })
    mode!: string;

    /** The staff member holding the lease. Null whenever mode is AUTO. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    ownerStaffId!: string | null;

    /** Display label captured at takeover, so history reads without a join. */
    @Column({ type: "varchar", length: 160, nullable: true })
    ownerLabel!: string | null;

    @Column({ type: "timestamp", nullable: true })
    takenOverAt!: Date | null;

    /**
     * When control lapses unless renewed. The ONLY thing that returns a ride
     * to AUTO on its own — deliberately not socket state.
     */
    @Column({ type: "timestamp", nullable: true })
    leaseExpiresAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    lastRenewedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    releasedAt!: Date | null;

    @Column({ type: "varchar", length: 32, nullable: true })
    releaseReason!: string | null;

    /**
     * Bumped on every transition. A client that renews or releases sends the
     * version it believes it holds; a stale command is refused rather than
     * applied to a lease somebody else now owns. This is what makes a
     * double-tap and a replayed request harmless.
     */
    @Column({ type: "int", default: 0 })
    version!: number;

    /** How many times this ride has been taken over, ever. For reporting. */
    @Column({ type: "int", default: 0 })
    takeoverCount!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
