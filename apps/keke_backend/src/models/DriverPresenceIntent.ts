import {
    Entity, PrimaryColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

/**
 * Whether a driver has said they are working. Durable, and nothing but a
 * decision changes it.
 *
 * ── The bug this exists to end ──────────────────────────────────────────
 * "Online" used to be a 45-second Redis TTL (`driver:available:{id}`) refreshed
 * by location heartbeats, and dispatch hard-filtered on it. So the moment a
 * heartbeat stopped for ANY reason — an OEM battery manager killing the
 * foreground service, Doze, a tunnel, iOS suspending the isolate — the driver
 * silently left the dispatch pool. Nothing recorded that they had meant to be
 * working, so nothing could restore them and nothing could even report the
 * discrepancy. The driver found out by reopening the app.
 *
 * Measured in production before this change: 79 drivers with a known position,
 * ZERO dispatchable, and zero who had actually chosen to go offline. One had
 * beaten 15 minutes earlier and was already invisible.
 *
 * ── The rule ────────────────────────────────────────────────────────────
 * Intent changes only when somebody decides: the driver toggles, the driver
 * logs out deliberately, or an authorised admin intervenes. A missing
 * heartbeat, a dropped socket, a backgrounded app, a stale location and a
 * killed process are all facts about a DEVICE. They are recorded as device
 * health and they never rewrite this row.
 *
 * Device health decides HOW we reach a driver — directly, or by waking their
 * phone first. It never decides WHETHER they want work.
 */
export enum PresenceIntent {
    ONLINE = "ONLINE",
    OFFLINE = "OFFLINE",
}

/** Who moved the switch. Every transition is attributable. */
export enum IntentActor {
    /** The driver's own toggle in the app. */
    DRIVER = "DRIVER",
    /** A deliberate sign-out. Not a crash, not a process kill. */
    LOGOUT = "LOGOUT",
    /** A named staff member. */
    ADMIN = "ADMIN",
    /**
     * The platform, for reasons that are about eligibility rather than
     * device health — a suspension, a KYC revocation. Never a timeout.
     */
    SYSTEM = "SYSTEM",
}

@Entity()
@Index(["state"])
export class DriverPresenceIntent {
    /** The driver's user id. One row per driver, forever. */
    @PrimaryColumn()
    driverId!: string;

    @Column({ type: "varchar", length: 20, default: PresenceIntent.OFFLINE })
    state!: PresenceIntent;

    /** When the current state began. Survives restarts and deploys. */
    @Column({ type: "timestamp" })
    since!: Date;

    @Column({ type: "varchar", length: 20, default: IntentActor.DRIVER })
    setBy!: IntentActor;

    /** Staff id when setBy = ADMIN. Null otherwise. */
    @Column({ type: "varchar", nullable: true })
    actorId!: string | null;

    /** Why, in words, for the audit trail. Never used in logic. */
    @Column({ type: "varchar", length: 200, nullable: true })
    reason!: string | null;

    /**
     * Last time the platform confirmed this driver's device was reachable —
     * a heartbeat, or a wake-push the app answered.
     *
     * Device health, recorded beside intent for convenience. Reading it never
     * changes `state`, and no sweeper anywhere is permitted to act on it.
     */
    @Column({ type: "timestamp", nullable: true })
    lastReachableAt!: Date | null;

    /**
     * When we last sent a wake-up push to a stale device, so a burst of
     * requests cannot produce a burst of wakes.
     */
    @Column({ type: "timestamp", nullable: true })
    lastWakeAttemptAt!: Date | null;

    /** Consecutive wake attempts with no answer. Reset by any contact. */
    @Column({ type: "int", default: 0 })
    failedWakeCount!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
