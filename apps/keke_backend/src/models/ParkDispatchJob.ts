import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Where a park-dispatched request is in the dispatcher's hands.
 *
 * Deliberately a SEPARATE state machine from `RideStatus`. The ride stays
 * `searching` for the whole of the park phase and flips to `accepted` through
 * the same conditional UPDATE a direct acceptance uses. Adding park states to
 * `RideStatus` would have meant auditing every existing conditional UPDATE,
 * sweeper query and eligibility filter in the platform; keeping them apart means
 * none of that code has to know park dispatch exists.
 */
export enum ParkJobStatus {
    /** Offered to a park, nobody has taken responsibility yet. */
    OFFERED = "offered",
    /** A dispatcher accepted responsibility for sourcing a driver. */
    CLAIMED = "claimed",
    /** A driver was assigned; the ride is now `accepted` and belongs to them. */
    ASSIGNED = "assigned",
    /** The dispatcher has no driver for this one. Moves on immediately. */
    SKIPPED = "skipped",
    /** Handed to a human — something is wrong that a dispatcher cannot fix. */
    ESCALATED = "escalated",
    /** The dispatcher declined it outright, with a reason. */
    REJECTED = "rejected",
    /** The claim or assignment window elapsed with nothing happening. */
    EXPIRED = "expired",
    /** The passenger cancelled, or a direct driver took the ride first. */
    CANCELLED = "cancelled",
}

/** How the driver was told about the trip. */
export enum ParkAssignmentMode {
    /** Smartphone driver — the assignment appeared in their app. */
    ELECTRONIC = "electronic",
    /**
     * Feature-phone driver — the dispatcher read the trip details out and
     * recorded the assignment on their behalf. The DRIVER still owns the ride
     * afterwards; this records only how they came to know about it.
     */
    VERBAL = "verbal",
}

/**
 * One offer of one ride to one park.
 *
 * A ride offered to two parks in sequence produces two jobs, chained by
 * `previousJobId`, so "how many parks did we try" is a fact rather than a
 * reconstruction.
 */
@Entity()
@Index(["parkId", "status"])
@Index(["status", "offeredAt"])
export class ParkDispatchJob {
    @PrimaryGeneratedColumn("uuid")
    jobId!: string;

    @Index()
    @Column()
    rideId!: string;

    @Index()
    @Column()
    parkId!: string;

    @Index()
    @Column({ type: "enum", enum: ParkJobStatus, default: ParkJobStatus.OFFERED })
    status!: ParkJobStatus;

    /**
     * 1 = normal, 2 = elevated, 3 = urgent. Derived from how long the PASSENGER
     * has waited — never from fare, which would teach dispatchers to serve
     * expensive trips first.
     */
    @Index()
    @Column({ type: "int", default: 1 })
    priority!: number;

    /** Which park attempt this is for the ride, 1-based. */
    @Column({ type: "int", default: 1 })
    attemptNumber!: number;

    /** The preceding job when a ride moves from one park to the next. */
    @Column({ type: "varchar", nullable: true })
    previousJobId!: string | null;

    // ── offer ───────────────────────────────────────────────────────────

    @Column({ type: "timestamp" })
    offeredAt!: Date;

    @Column({ type: "timestamp" })
    offerExpiresAt!: Date;

    /** Straight-line estimate from park to pickup, for ranking and reporting. */
    @Column({ type: "double precision", nullable: true })
    parkToPickupKm!: number | null;

    @Column({ type: "int", nullable: true })
    estimatedTravelMinutes!: number | null;

    // ── claim ───────────────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    claimedAt!: Date | null;

    @Index()
    @Column({ type: "varchar", nullable: true })
    claimedByStaffId!: string | null;

    /** The shift the claim happened during, so accountability survives handover. */
    @Column({ type: "varchar", nullable: true })
    shiftId!: string | null;

    /** Deadline for producing a driver, set when the job is claimed. */
    @Column({ type: "timestamp", nullable: true })
    assignmentDeadlineAt!: Date | null;

    // ── assignment ──────────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    assignedAt!: Date | null;

    @Index()
    @Column({ type: "varchar", nullable: true })
    assignedDriverId!: string | null;

    @Column({ type: "varchar", nullable: true })
    assignedByStaffId!: string | null;

    @Column({ type: "enum", enum: ParkAssignmentMode, nullable: true })
    assignmentMode!: ParkAssignmentMode | null;

    // ── resolution ──────────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    resolvedAt!: Date | null;

    /** Why it ended this way. Required for skip, reject and escalate. */
    @Column({ type: "varchar", length: 500, nullable: true })
    resolutionReason!: string | null;

    // ── measurement ─────────────────────────────────────────────────────
    // Stored rather than derived because the monitoring queries run over
    // hundreds of finished jobs, and recomputing intervals across a join to
    // `ride` for each one is the kind of query that is fine in a demo and
    // unusable at volume.

    /** Offer → claim, in ms. Null when never claimed. The dispatcher response time. */
    @Column({ type: "int", nullable: true })
    responseTimeMs!: number | null;

    /** Claim → assignment, in ms. Null when never assigned. */
    @Column({ type: "int", nullable: true })
    assignmentTimeMs!: number | null;

    /** Ride creation → assignment, in ms. What the passenger actually waited. */
    @Column({ type: "int", nullable: true })
    passengerWaitMs!: number | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
