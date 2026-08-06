import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

export enum MarketingPushState {
    QUEUED = "queued",
    SENDING = "sending",
    SENT = "sent",
    FAILED = "failed",
    /** Removed before sending: consent withdrawn, token dead, campaign stopped. */
    SKIPPED = "skipped",
}

/**
 * One marketing push, to one passenger, waiting its turn.
 *
 * ── Why marketing gets its own queue table ───────────────────────────────
 * Operational notifications are sent inline: a ride alert that waits in a queue
 * is a ride alert that arrives too late to matter. Marketing is the opposite —
 * it can wait indefinitely, must be rate limited, must survive a restart, and
 * must be abandonable halfway through. Those are different enough that sharing
 * a mechanism would compromise one of them, and it would be the operational one.
 *
 * Nothing operational reads or writes this table.
 *
 * ── The unique key is what prevents a double send ────────────────────────
 * (campaignId, userId) is unique. A resumed worker, a double-clicked release or
 * a restarted process each attempt an insert that already exists and are
 * refused by the database rather than by a check that could race.
 */
@Entity()
@Index(["campaignId", "userId"], { unique: true })
@Index(["state", "nextAttemptAt"])
@Index(["campaignId", "state"])
export class MarketingPushJob {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    campaignId!: string;

    @Column()
    userId!: string;

    @Column({ type: "enum", enum: MarketingPushState, default: MarketingPushState.QUEUED })
    state!: MarketingPushState;

    @Column({ type: "int", default: 0 })
    attempts!: number;

    /**
     * When this may next be tried, for exponential backoff.
     *
     * A row whose time has not come is invisible to the worker, which is how
     * backoff is expressed without a scheduler: the query simply does not
     * select it yet.
     */
    @Column({ type: "timestamp", nullable: true })
    nextAttemptAt!: Date | null;

    /** The FCM message id, for tying a delivery report back to this row. */
    @Column({ type: "varchar", nullable: true })
    providerMessageId!: string | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    error!: string | null;

    /** Why it was skipped, in a word a report can group by. */
    @Column({ type: "varchar", length: 60, nullable: true })
    skipReason!: string | null;

    @Column({ type: "timestamp", nullable: true })
    sentAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    openedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
