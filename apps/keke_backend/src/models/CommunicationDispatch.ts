import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from "typeorm";

export enum DispatchStatus {
    /** Accepted and awaiting the provider. */
    QUEUED = "queued",
    /**
     * Claimed by a worker and in flight.
     *
     * Without this state two workers both select the same QUEUED row and both
     * deliver it — the unique index prevents a duplicate CLAIM, but says
     * nothing about delivering one claim twice.
     */
    SENDING = "sending",
    SENT = "sent",
    FAILED = "failed",
    /** Deliberately not sent — no consent, suppressed, no destination. */
    SKIPPED = "skipped",
}

/**
 * One row per passenger, per automation, per occurrence, per channel.
 *
 * Two jobs at once:
 *
 *  1. It is the deduplication ledger. The unique index on
 *     (triggerKey, dedupeKey, channel) is what makes "one thank-you per ride"
 *     true even if the completion event fires twice, two workers race, or the
 *     process restarts mid-send. The database refuses the second insert; no
 *     application-level check can offer that guarantee.
 *
 *  2. It is the passenger's communication history. Support can answer "what
 *     did we send this person, and did it arrive" from these rows, including
 *     the ones we deliberately skipped and why.
 *
 * A ledger rather than a cache because it must survive a restart. A Redis-only
 * cooldown resets on deploy, and the passenger gets the apology twice.
 */
@Entity()
@Index(["triggerKey", "dedupeKey", "channel"], { unique: true })
@Index(["userId", "createdAt"])
@Index(["triggerKey", "createdAt"])
@Index(["status"])
export class CommunicationDispatch {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "varchar", length: 60 })
    triggerKey!: string;

    /**
     * What makes this occurrence unique — a rideId for ride-driven automations,
     * a period stamp for recurring ones.
     */
    @Column({ type: "varchar", length: 120 })
    dedupeKey!: string;

    @Column()
    userId!: string;

    @Column({ type: "varchar", length: 20 })
    channel!: string;

    @Column({ type: "varchar", length: 20, default: DispatchStatus.QUEUED })
    status!: DispatchStatus;

    /** Why it was skipped or how it failed. Never a bare boolean. */
    @Column({ type: "varchar", length: 200, nullable: true })
    reason!: string | null;

    /** The ride that caused it, where there was one. */
    @Column({ type: "varchar", nullable: true })
    rideId!: string | null;

    /**
     * The authoritative operational reason, kept per message.
     *
     * NO_ELIGIBLE_DRIVER and NO_DRIVER_ACCEPTED share one passenger-facing
     * message but must stay separable in analytics: one is a supply problem,
     * the other is driver behaviour, and they call for different fixes.
     */
    @Column({ type: "varchar", length: 40, nullable: true })
    outcomeReason!: string | null;

    /** Ties a delivery webhook back to this row. */
    @Column({ type: "varchar", nullable: true })
    providerMessageId!: string | null;

    /** Which cohort this was sent under, for the rollout audit. */
    @Column({ type: "varchar", length: 20, nullable: true })
    mode!: string | null;

    /**
     * Earliest this may be sent. The row is written the moment the event
     * arrives — claiming the dedupe slot immediately — and a worker sends it
     * once this passes. Persisting the delay rather than holding a timer means
     * a restart between event and send loses nothing.
     */
    @Column({ type: "timestamp", nullable: true })
    sendAfter!: Date | null;

    @Column({ type: "int", default: 0 })
    attempts!: number;

    @Column({ type: "timestamp", nullable: true })
    sentAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;
}
