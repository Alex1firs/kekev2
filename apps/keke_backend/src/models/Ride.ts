import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum RideStatus {
    SEARCHING = "searching",
    ACCEPTED = "accepted",
    ARRIVED = "arrived",
    IN_PROGRESS = "in_progress",
    STARTED = "started",
    COMPLETED = "completed",
    CANCELED = "canceled",
    FAILED = "failed"
}

@Entity()
@Index(["passengerId", "status"])
@Index(["driverId", "status"])
@Index(["status", "updatedAt"])
export class Ride {
    @PrimaryColumn()
    rideId!: string;

    @Index()
    @Column()
    passengerId!: string;

    @Index()
    @Column({ nullable: true })
    driverId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    fare!: number;

    @Column()
    paymentMode!: "wallet" | "cash";

    @Index()
    @Column({ type: "enum", enum: RideStatus, default: RideStatus.SEARCHING })
    status!: RideStatus;

    @Column({ nullable: true })
    pickupAddress!: string;

    @Column({ nullable: true })
    destinationAddress!: string;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    pickupLat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    pickupLng!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    destinationLat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    destinationLng!: number;

    @Column({ nullable: true, default: false })
    paymentFailed!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ nullable: true })
    completedAt!: Date;

    @Column({ nullable: true, length: 4 })
    pickupCode!: string;

    // Trip estimates the passenger app computes for its own fare screen. Sent
    // for operational reporting only — never used for charging (see finalFare).
    // Optional: older app builds omit them and the monitor shows "—".
    @Column({ type: "int", nullable: true })
    estimatedDistanceM!: number | null;

    @Column({ type: "int", nullable: true })
    estimatedDurationSec!: number | null;

    // --- Anti-fraud evidence (captured from the driver's live GPS at each
    // transition). All nullable/back-compatible. See RideIntegrityService. ---
    @Column({ type: "timestamp", nullable: true })
    acceptedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    arrivedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    startedAt!: Date | null;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    acceptLat!: number | null;
    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    acceptLng!: number | null;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    arrivedLat!: number | null;
    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    arrivedLng!: number | null;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    startLat!: number | null;
    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    startLng!: number | null;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    endLat!: number | null;
    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    endLng!: number | null;

    // Distances (metres) computed at each transition.
    @Column({ type: "double precision", nullable: true })
    arrivedPickupDistanceM!: number | null;
    @Column({ type: "double precision", nullable: true })
    startPickupDistanceM!: number | null;
    @Column({ type: "double precision", nullable: true })
    endDestinationDistanceM!: number | null;
    @Column({ type: "double precision", nullable: true })
    movementDistanceM!: number | null;
    @Column({ type: "int", nullable: true })
    tripDurationSec!: number | null;

    // Fare audit — the client-supplied fare is recorded but never trusted for
    // charging; finalFare is the backend-authoritative amount actually used.
    @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
    clientSuppliedFare!: number | null;
    @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
    finalFare!: number | null;

    // Review flags.
    @Index()
    @Column({ default: false })
    suspicious!: boolean;

    @Column({ type: "varchar", length: 500, nullable: true })
    suspiciousReason!: string | null;

    /** Wallet debit / commission settlement withheld pending admin review. */
    @Index()
    @Column({ default: false })
    paymentHeld!: boolean;

    // --- Early drop-off / passenger consent ---
    // A legitimate early end (traffic, changed mind, wants to walk) means the
    // Keke never reaches the booked destination pin. Passenger consent lets the
    // ride settle despite ended_far_from_destination — but ONLY that check;
    // movement / duration / stale-GPS holds still apply.

    /** Passenger tapped "End Trip Here" on their own screen. */
    @Column({ default: false })
    endedEarlyByPassenger!: boolean;

    /** Driver swiped End while far from the pin and asked the passenger to confirm. */
    @Column({ default: false })
    earlyEndRequestedByDriver!: boolean;

    /** Consent recorded via either path — overrides only ended_far_from_destination. */
    @Column({ default: false })
    passengerConsentedEnd!: boolean;

    @Column({ type: "timestamp", nullable: true })
    passengerConsentAt!: Date | null;

    @Column({ type: "double precision", nullable: true })
    passengerConsentLat!: number | null;
    @Column({ type: "double precision", nullable: true })
    passengerConsentLng!: number | null;

    /** Why a ride is held for review (e.g. early_end_no_passenger_response). */
    @Column({ type: "varchar", length: 120, nullable: true })
    reviewReason!: string | null;

    // --- Lifecycle expiry / stale-ride recovery ---
    // A ride left in accepted/arrived blocks its passenger from booking AND its
    // driver from accepting, so these states need a deadline. See
    // config/stale_ride_config.ts and services/stale_ride_service.ts.

    /**
     * Why this ride reached a terminal state — e.g. `passenger_cancelled` or
     * `SYSTEM_DRIVER_DID_NOT_ARRIVE`. The status alone cannot distinguish a
     * passenger changing their mind from an automatic recovery.
     */
    @Column({ type: "varchar", length: 120, nullable: true })
    cancellationReason!: string | null;

    /**
     * An in-progress trip far past its expected duration. Flagged for a human,
     * never auto-cancelled: a real trip happened and a real fare is owed.
     */
    @Index()
    @Column({ default: false })
    requiresOperationsReview!: boolean;

    @Column({ type: "varchar", length: 120, nullable: true })
    staleReason!: string | null;

    @Column({ type: "timestamp", nullable: true })
    staleDetectedAt!: Date | null;

    /**
     * When the stale warning was sent. Persisted rather than kept in memory so a
     * restart mid-sweep cannot re-warn the same driver.
     */
    @Column({ type: "timestamp", nullable: true })
    staleWarnedAt!: Date | null;

    /** Extensions granted so far. Bounded by STALE_MAX_EXTENSIONS. */
    @Column({ type: "int", default: 0 })
    staleExtensionCount!: number;

    /** Deadline pushed to this moment by a "keep waiting" choice. */
    @Column({ type: "timestamp", nullable: true })
    staleDeadlineOverrideAt!: Date | null;

    // --- The decision window ---
    // A stale ride is never cancelled on a timer alone. Both parties are asked
    // first, and a cancellation only follows an explicit choice or silence from
    // the party the ride is waiting on. These columns hold that conversation.

    /**
     * When both parties were asked to choose. Its presence is the invariant that
     * makes silent cancellation impossible: cleanup refuses to cancel a stale
     * ride unless this is set.
     */
    @Column({ type: "timestamp", nullable: true })
    staleDecisionPromptedAt!: Date | null;

    /** When the current decision window closes. */
    @Column({ type: "timestamp", nullable: true })
    staleDecisionDeadlineAt!: Date | null;

    /** Who answered: 'passenger' | 'driver'. Null while nobody has. */
    @Column({ type: "varchar", length: 16, nullable: true })
    staleDecisionBy!: string | null;

    /** What they chose: 'wait' | 'cancel'. */
    @Column({ type: "varchar", length: 16, nullable: true })
    staleDecisionChoice!: string | null;

    @Column({ type: "timestamp", nullable: true })
    staleDecisionAt!: Date | null;

    /** How many decision rounds this ride has been through. */
    @Column({ type: "int", default: 0 })
    staleDecisionRound!: number;
}
