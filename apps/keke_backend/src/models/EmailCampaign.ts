/*
 * Campaign lifecycle states.
 *
 * ── What used to be here ────────────────────────────────────────────────
 * An `EmailCampaign` entity: a single-channel campaign model superseded by
 * `CommunicationCampaign`, which carries the same lifecycle plus a row per
 * channel. The class stayed registered as a TypeORM entity long after its
 * table stopped being created, so `getRepository(EmailCampaign)` compiled
 * cleanly and threw at runtime — every legacy campaign endpoint answered
 * HTTP 500 in production, silently, because the admin dashboard had already
 * moved to the multi-channel API and nobody was calling them.
 *
 * The statuses stay here because they describe the campaign lifecycle itself
 * rather than that one table, and `CommunicationCampaign` uses them unchanged.
 */

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
