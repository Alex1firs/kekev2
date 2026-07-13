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
}
