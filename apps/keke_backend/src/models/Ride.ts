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

    // --- Structured locality, captured at request time -----------------
    // The address strings above are whatever Google returned to the handset,
    // and are frequently unusable: plus codes, "Location selected", or a
    // street with no area. These are the geocoder's OWN structured fields,
    // taken from the same response, so operations can group demand by real
    // neighbourhood instead of parsing prose.
    //
    // All nullable. An older passenger build sends none of them, a failed
    // geocode sends none of them, and neither is an error — the ride is built
    // on coordinates, which are always present.

    /** Neighbourhood — "Awada", "Upper Iweka". The most operationally useful. */
    @Index()
    @Column({ type: "varchar", length: 120, nullable: true })
    pickupSubLocality!: string | null;

    /** Town/area — "Obosi", "Nkpor". */
    @Index()
    @Column({ type: "varchar", length: 120, nullable: true })
    pickupLocality!: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    pickupCity!: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    pickupState!: string | null;

    @Index()
    @Column({ type: "varchar", length: 120, nullable: true })
    destinationSubLocality!: string | null;

    @Index()
    @Column({ type: "varchar", length: 120, nullable: true })
    destinationLocality!: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    destinationCity!: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    destinationState!: string | null;

    // --- Terminal outcome, for Ride Operations -------------------------
    // `status` says what happened; these say why. Denormalised onto the ride
    // row on purpose: the operations table renders REASON for every row, and
    // joining the event trail per row would be an N+1 across the console's
    // primary query. The event trail remains authoritative — these are written
    // from it, never instead of it. See services/ride_outcome.ts.

    /**
     * Stable machine-readable code from RideOutcomeCode. Null means the reason
     * was never recorded (a ride predating this telemetry), which the console
     * renders as "Reason unavailable — legacy ride" rather than a guess.
     */
    @Index()
    @Column({ type: "varchar", length: 48, nullable: true })
    outcomeReason!: string | null;

    /**
     * The finer dispatch discriminator when one exists — e.g.
     * `offers_delivered_none_accepted` vs `no_eligible_drivers`. Kept separate
     * from the code so reporting can group coarsely and investigate finely.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    outcomeDetail!: string | null;

    /** 'passenger' | 'driver' | 'admin' | 'system'. Null when nobody cancelled. */
    @Index()
    @Column({ type: "varchar", length: 16, nullable: true })
    cancelledByRole!: string | null;

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

    // --- Evidence the ride is still alive ---
    // A delay is not a failure. Real-world delays are normal: traffic,
    // checkpoints, rain, a gate, a lift, reception. So the system looks for
    // evidence of ABANDONMENT rather than treating elapsed time as proof.

    /**
     * Last deliberate action, or genuine approach toward the pickup, on this ride.
     *
     * Liveness alone does NOT set this. An open app is not a driver who is
     * coming — a driver parked at home emits location updates indefinitely, and
     * counting those would let one hold a passenger's booking forever.
     */
    @Column({ type: "timestamp", nullable: true })
    lastActivityAt!: Date | null;

    @Column({ type: "varchar", length: 40, nullable: true })
    lastActivityType!: string | null;

    /** When we last checked in, so reminders stay humane rather than nagging. */
    @Column({ type: "timestamp", nullable: true })
    lastReminderAt!: Date | null;

    /** Operational state for the support dashboard. See RideDelayState. */
    @Index()
    @Column({ type: "varchar", length: 48, nullable: true })
    delayState!: string | null;

    // --- A cancellation ASKED FOR by one party ---
    // Cancelling is a two-person act. One side requests; the other accepts or
    // says they are continuing.

    @Column({ type: "varchar", length: 16, nullable: true })
    cancellationRequestedBy!: string | null;

    @Column({ type: "timestamp", nullable: true })
    cancellationRequestedAt!: Date | null;

    /** 'pending' | 'accepted' | 'declined' */
    @Column({ type: "varchar", length: 16, nullable: true })
    cancellationRequestState!: string | null;

    /**
     * Set when a human is asked to look at this ride. While set, the system will
     * not terminate it on its own — escalation is explicitly not cancellation.
     */
    @Index()
    @Column({ type: "timestamp", nullable: true })
    escalatedToSupportAt!: Date | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    escalationReason!: string | null;

    // --- Park Dispatch provenance ---------------------------------------
    // How this ride came to have a driver. All nullable and back-compatible:
    // a null dispatchMode means 'direct', which is every ride that exists
    // today. Nothing in dispatch, settlement or the ride lifecycle reads these
    // — they exist so reporting can tell the two supply channels apart, and so
    // support can see at a glance why a ride has no live driver GPS.

    /** 'direct' | 'park'. Null on every pre-existing ride, meaning direct. */
    @Index()
    @Column({ type: "varchar", length: 12, nullable: true })
    dispatchMode!: string | null;

    /** The park that sourced the driver, when one did. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    /** The ParkDispatchJob that produced the assignment. */
    @Column({ type: "varchar", nullable: true })
    parkJobId!: string | null;

    /**
     * 'electronic' | 'verbal'. How the driver was told about the trip.
     *
     * `verbal` is the honest marker that this driver has no app: their
     * lifecycle events and live GPS may be absent, and support should not read
     * that absence as a fault.
     */
    @Column({ type: "varchar", length: 12, nullable: true })
    assignmentMode!: string | null;
}
