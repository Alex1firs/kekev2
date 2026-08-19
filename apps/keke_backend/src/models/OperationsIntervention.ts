import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Append-only record of every deliberate Operations act on a ride.
 *
 * The dispatch_event trail already records what the SYSTEM did. This records
 * what a PERSON did, and the two are kept apart on purpose: "no driver was
 * available" and "Ada took control and rang Emeka" are different kinds of
 * fact, and a report that mixed them could not answer how many rides
 * Operations actually rescued.
 *
 * Every act is also projected onto the dispatch_event timeline, so the
 * investigation view tells one continuous story. This table is the queryable
 * source for intervention reporting; the timeline is the narrative.
 *
 * Contains NO personal data — staff id, ride id, driver id and reason codes.
 * Names and phone numbers are joined at render time, masked by default.
 */
export enum InterventionType {
    TAKEOVER_CLAIMED = "takeover_claimed",
    TAKEOVER_RENEWED = "takeover_renewed",
    TAKEOVER_RELEASED = "takeover_released",
    CONTROL_EXPIRED = "control_expired",
    DRIVER_CONTACTED = "driver_contacted",
    ASSIGNMENT_ATTEMPTED = "assignment_attempted",
    DRIVER_ASSIGNED = "driver_assigned",
    ASSIGNMENT_FAILED = "assignment_failed",
}

/**
 * Why Operations stepped in. Machine-readable so the question "what fraction
 * of interventions were supply problems?" is a GROUP BY rather than a
 * text search.
 */
export enum InterventionReason {
    NO_NEARBY_DRIVER = "NO_NEARBY_DRIVER",
    NO_DRIVER_ACCEPTED = "NO_DRIVER_ACCEPTED",
    PASSENGER_CONTACTED_SUPPORT = "PASSENGER_CONTACTED_SUPPORT",
    DRIVER_CONTACTED_MANUALLY = "DRIVER_CONTACTED_MANUALLY",
    PARK_ASSISTANCE = "PARK_ASSISTANCE",
    OPERATIONS_INTERVENTION = "OPERATIONS_INTERVENTION",
    OTHER = "OTHER",
}

@Entity()
@Index(["rideId", "createdAt"])
@Index(["staffUserId", "createdAt"])
@Index(["type", "createdAt"])
export class OperationsIntervention {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    rideId!: string;

    @Index()
    @Column({ type: "varchar", length: 32 })
    type!: string;

    /** Null only for CONTROL_EXPIRED, which no human performed. */
    @Column({ type: "varchar", nullable: true })
    staffUserId!: string | null;

    /** Captured at write time so history reads without joining staff. */
    @Column({ type: "varchar", length: 160, nullable: true })
    staffLabel!: string | null;

    @Column({ type: "varchar", length: 48, nullable: true })
    reason!: string | null;

    /** The driver this act concerned, when it concerned one. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    driverId!: string | null;

    /**
     * The ride's status and control mode immediately BEFORE this act.
     * Recorded because "assigned a driver" means something different to a ride
     * that was searching than to one that had already failed.
     */
    @Column({ type: "varchar", length: 24, nullable: true })
    priorRideStatus!: string | null;

    @Column({ type: "varchar", length: 16, nullable: true })
    priorControlMode!: string | null;

    /** 'ok' | 'refused' | 'error'. An attempt that lost a race is still evidence. */
    @Column({ type: "varchar", length: 16, nullable: true })
    outcome!: string | null;

    /** Stable code when the act failed — e.g. RIDE_ALREADY_TAKEN. */
    @Column({ type: "varchar", length: 48, nullable: true })
    outcomeCode!: string | null;

    /** Non-personal structured context: counts, distances, eligibility codes. */
    @Column({ type: "jsonb", nullable: true })
    detail!: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt!: Date;
}
