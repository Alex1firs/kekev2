import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";
import { CampaignStatus } from "./EmailCampaign";

export { CampaignStatus };

/** Every channel a campaign may go out on. */
export enum CampaignChannelKind {
    EMAIL = "email",
    PUSH = "push",
    IN_APP = "in_app",
    SMS = "sms",
    PROMO_NOTIFICATION = "promo_notification",
}

/**
 * One campaign, however many channels it goes out on.
 *
 * ── What lives here, and what does not ───────────────────────────────────
 * The audience, the consent rules, the schedule, the approval and the audit
 * trail belong to the campaign — they are the same decision however many ways
 * it is delivered. Only the content and the delivery state are per channel, and
 * those live on CommunicationCampaignChannel.
 *
 * The alternative — a campaign per channel — would mean the same audience
 * resolved twice, approved twice and reported on twice, and the two copies
 * drifting the first time somebody edited one of them.
 */
@Entity()
@Index(["status", "scheduledAt"])
@Index(["createdByStaffId"])
export class CommunicationCampaign {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "varchar", length: 160 })
    name!: string;

    /** Internal note. Never seen by a passenger. */
    @Column({ type: "varchar", length: 500, nullable: true })
    description!: string | null;

    /** What this campaign is for: reactivation, announcement, promotion… */
    @Column({ type: "varchar", length: 60, nullable: true })
    objective!: string | null;

    @Column({ type: "varchar", nullable: true })
    segmentId!: string | null;

    @Column({ type: "jsonb", nullable: true })
    audienceDefinition!: Record<string, unknown> | null;

    @Column({ type: "enum", enum: CampaignStatus, default: CampaignStatus.DRAFT })
    status!: CampaignStatus;

    @Column({ type: "timestamp", nullable: true })
    scheduledAt!: Date | null;

    @Column({ type: "varchar", length: 60, nullable: true })
    scheduleTimezone!: string | null;

    @Column()
    createdByStaffId!: string;

    @Column({ type: "varchar", nullable: true })
    approvedByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    approvedAt!: Date | null;

    /**
     * What was approved, across EVERY enabled channel.
     *
     * A material edit to any one of them changes this and returns the campaign
     * to draft — otherwise an approver could sanction an email and have the
     * push body rewritten underneath their approval.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    approvedContentHash!: string | null;

    @Column({ type: "varchar", nullable: true })
    sentByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    sendStartedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    sendCompletedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    lastTestSentAt!: Date | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    failureReason!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    stopReason!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

/**
 * One channel's content and delivery state.
 *
 * Unique on (campaignId, channel): a campaign cannot hold two email bodies, and
 * enabling a channel twice is a no-op rather than a duplicate that would send
 * everything twice.
 */
@Entity()
@Index(["campaignId", "channel"], { unique: true })
@Index(["campaignId"])
export class CommunicationCampaignChannel {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "uuid" })
    campaignId!: string;

    @Column({ type: "enum", enum: CampaignChannelKind })
    channel!: CampaignChannelKind;

    /** Unticking a channel keeps its content, so it can be turned back on. */
    @Column({ default: true })
    enabled!: boolean;

    /**
     * The channel's own fields. Shapes differ enough — a subject and HTML for
     * email, a title and deep link for push, a placement and priority for
     * in-app — that a column per field would be a migration per channel.
     */
    @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
    content!: Record<string, unknown>;

    @Column({ type: "varchar", length: 60, nullable: true })
    templateKey!: string | null;

    @Column({ type: "varchar", length: 30, default: "draft" })
    status!: string;

    // ── Counts, from the last audience resolution ───────────────────────
    // Display only. Membership is always re-resolved at send time, so these are
    // never what decides who receives anything.

    @Column({ type: "int", nullable: true })
    eligibleCount!: number | null;

    @Column({ type: "int", nullable: true })
    excludedCount!: number | null;

    @Column({ type: "jsonb", nullable: true })
    exclusions!: Record<string, number> | null;

    @Column({ type: "int", default: 0 })
    queuedCount!: number;

    @Column({ type: "int", default: 0 })
    sentCount!: number;

    @Column({ type: "int", default: 0 })
    failedCount!: number;

    /** Naira. Only SMS has a real one; the rest are effectively zero. */
    @Column({ type: "numeric", precision: 12, scale: 2, nullable: true })
    estimatedCost!: string | null;

    @Column({ type: "timestamp", nullable: true })
    lastCountedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
