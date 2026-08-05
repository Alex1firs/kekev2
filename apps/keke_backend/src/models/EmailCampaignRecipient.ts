import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * Honest states. "Accepted by the provider" is not "delivered".
 *
 * QUEUED   — we intend to send it; nothing has left yet.
 * SENT     — the provider accepted it and gave us a message id.
 * DELIVERED — the receiving server confirmed acceptance, via webhook.
 * The rest are outcomes reported afterwards.
 */
export enum RecipientStatus {
    QUEUED = "queued",
    SENT = "sent",
    DELIVERED = "delivered",
    DEFERRED = "deferred",
    SOFT_BOUNCED = "soft_bounced",
    HARD_BOUNCED = "hard_bounced",
    COMPLAINED = "complained",
    FAILED = "failed",
    /** Removed before sending: unsubscribed, suppressed, or consent withdrawn. */
    SKIPPED = "skipped",
}

/**
 * One passenger's copy of one campaign.
 *
 * ── The unique key is what prevents a double send ────────────────────────
 * `(campaignId, email)` is unique. A resumed batch, a double-clicked Send, a
 * worker that restarts mid-campaign — each tries to insert a row that already
 * exists and is refused by the database rather than by a check that might have
 * raced. The row is created BEFORE the provider call, so a crash between the
 * two leaves a QUEUED row that is retried, never a silent second email.
 *
 * ── Why the email is copied here ─────────────────────────────────────────
 * The address at the moment of sending. A passenger who later changes their
 * email must not make a delivery report retroactively describe a message that
 * went somewhere else.
 */
@Entity()
@Index(["campaignId", "email"], { unique: true })
@Index(["campaignId", "status"])
@Index(["providerMessageId"])
export class EmailCampaignRecipient {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    campaignId!: string;

    @Column()
    userId!: string;

    @Column()
    email!: string;

    @Column({ type: "enum", enum: RecipientStatus, default: RecipientStatus.QUEUED })
    status!: RecipientStatus;

    /** The provider's id, for tying a webhook back to this row. */
    @Column({ type: "varchar", nullable: true })
    providerMessageId!: string | null;

    /**
     * Sent to the provider so a retry after an ambiguous timeout cannot produce
     * a second delivery. Derived from campaign and recipient, never random.
     */
    @Column({ type: "varchar", length: 120 })
    idempotencyKey!: string;

    @Column({ type: "int", default: 0 })
    attempts!: number;

    @Column({ type: "timestamp", nullable: true })
    lastAttemptAt!: Date | null;

    /** Why it was skipped or why it failed, for the report. */
    @Column({ type: "varchar", length: 300, nullable: true })
    reason!: string | null;

    @Column({ type: "timestamp", nullable: true })
    sentAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    deliveredAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    openedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    clickedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;
}
