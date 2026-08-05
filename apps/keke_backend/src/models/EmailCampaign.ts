import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

export enum CampaignStatus {
    DRAFT = "draft",
    AWAITING_APPROVAL = "awaiting_approval",
    APPROVED = "approved",
    SCHEDULED = "scheduled",
    SENDING = "sending",
    PAUSED = "paused",
    COMPLETED = "completed",
    CANCELLED = "cancelled",
    FAILED = "failed",
}

/** States from which no further sending may begin. */
export const TERMINAL_CAMPAIGN_STATUSES: CampaignStatus[] = [
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
    CampaignStatus.FAILED,
];

/**
 * One marketing campaign.
 *
 * ── Why the content is hashed ────────────────────────────────────────────
 * Approval has to mean something. Without a hash, an approved campaign could
 * have its subject, body, audience or promo code rewritten before sending and
 * the approval would still read as valid — the approver would be recorded as
 * having sanctioned an email they never saw. `approvedContentHash` freezes what
 * was approved; the service compares it before sending and drops the campaign
 * back to draft if it no longer matches.
 *
 * ── Why the audience is stored as a definition, not a list ───────────────
 * A recipient list captured at draft time goes stale: somebody unsubscribes,
 * bounces or complains between drafting and sending, and a stored list would
 * still contain them. The definition is re-resolved at send time, every time,
 * so consent and suppression are always evaluated against the present.
 */
@Entity()
@Index(["status", "scheduledAt"])
@Index(["createdByStaffId"])
export class EmailCampaign {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    /** Internal only — never shown to a passenger. */
    @Column({ type: "varchar", length: 160 })
    name!: string;

    @Column({ type: "varchar", length: 200 })
    subject!: string;

    /** The grey line after the subject in an inbox list. */
    @Column({ type: "varchar", length: 200, nullable: true })
    previewText!: string | null;

    @Column({ type: "varchar", length: 100, default: "KekeRide" })
    senderName!: string;

    @Column({ type: "varchar", length: 200, nullable: true })
    replyTo!: string | null;

    @Column({ type: "varchar", length: 60 })
    templateKey!: string;

    /**
     * Template slots: headline, body, imageUrl, ctaLabel, ctaUrl, promoCode,
     * promoExpiry. Kept as one document because the set differs per template
     * and a column per slot would be a migration every time a template is added.
     */
    @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
    content!: Record<string, unknown>;

    /** A saved segment, when one was chosen. */
    @Column({ type: "varchar", nullable: true })
    segmentId!: string | null;

    /** An inline audience, when no saved segment was used. */
    @Column({ type: "jsonb", nullable: true })
    audienceDefinition!: Record<string, unknown> | null;

    @Column({ type: "enum", enum: CampaignStatus, default: CampaignStatus.DRAFT })
    status!: CampaignStatus;

    @Column({ type: "timestamp", nullable: true })
    scheduledAt!: Date | null;

    /** IANA zone the schedule was expressed in, e.g. Africa/Lagos. */
    @Column({ type: "varchar", length: 60, nullable: true })
    scheduleTimezone!: string | null;

    // ── People ──────────────────────────────────────────────────────────

    @Column()
    createdByStaffId!: string;

    @Column({ type: "varchar", nullable: true })
    approvedByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    approvedAt!: Date | null;

    /**
     * What was approved. Any material change invalidates it — see the note on
     * this class.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    approvedContentHash!: string | null;

    @Column({ type: "varchar", nullable: true })
    sentByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    sendStartedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    sendCompletedAt!: Date | null;

    /**
     * A test send is required before a real one. Recorded rather than trusted
     * to a checkbox, so "we tested it" is a fact about this campaign.
     */
    @Column({ type: "timestamp", nullable: true })
    lastTestSentAt!: Date | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    failureReason!: string | null;

    /** Why it was cancelled or paused, in a person's words. */
    @Column({ type: "varchar", length: 500, nullable: true })
    stopReason!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
