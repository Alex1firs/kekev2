/**
 * The campaign lifecycle, and every gate a message passes before it leaves.
 *
 * ── Nothing here sends in bulk ───────────────────────────────────────────
 * Phase 1 deliberately stops at "approved and ready". `sendTest` delivers to a
 * named staff address and nothing else; there is no method on this class that
 * writes to more than one recipient. Bulk delivery arrives in Phase 2 behind
 * the kill switch, so the first production release cannot email a passenger
 * even by mistake.
 *
 * ── Approval means something ─────────────────────────────────────────────
 * `approvedContentHash` freezes what the approver read. Any later edit to the
 * subject, body, audience, promo code or sender changes the hash, and the
 * campaign drops back to draft rather than going out with an approval that
 * described a different email.
 */

import { AppDataSource } from '../config/data_source';
import { EmailCampaign, CampaignStatus, TERMINAL_CAMPAIGN_STATUSES } from '../models/EmailCampaign';
import { EmailAudienceSegment } from '../models/EmailAudienceSegment';
import { AudienceService, AudienceDefinition, AudiencePreview } from './audience_service';
import { contentFingerprint, MarketingConsentService } from './marketing_consent_service';
import { emailProvider, senderIdentity } from './email_provider';
import { renderTemplate, templateByKey, TEMPLATES, TemplateContent } from './email_templates';
import { loadCommunicationsConfig, marketingSendBlockers } from '../config/communications_config';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

export const CampaignAuditAction = {
    CREATED: 'CAMPAIGN_CREATED',
    EDITED: 'CAMPAIGN_EDITED',
    AUDIENCE_CHANGED: 'CAMPAIGN_AUDIENCE_CHANGED',
    APPROVAL_REQUESTED: 'CAMPAIGN_APPROVAL_REQUESTED',
    APPROVED: 'CAMPAIGN_APPROVED',
    SCHEDULED: 'CAMPAIGN_SCHEDULED',
    SCHEDULE_CANCELLED: 'CAMPAIGN_SCHEDULE_CANCELLED',
    TEST_SENT: 'CAMPAIGN_TEST_SENT',
    CANCELLED: 'CAMPAIGN_CANCELLED',
} as const;

/** Fields whose change invalidates an approval. */
function materialParts(c: EmailCampaign): Record<string, unknown> {
    return {
        subject: c.subject,
        previewText: c.previewText,
        senderName: c.senderName,
        replyTo: c.replyTo,
        templateKey: c.templateKey,
        content: c.content,
        segmentId: c.segmentId,
        audienceDefinition: c.audienceDefinition,
    };
}

export class CampaignService {
    private static get repo() { return AppDataSource.getRepository(EmailCampaign); }
    private static get segments() { return AppDataSource.getRepository(EmailAudienceSegment); }

    static async get(id: string): Promise<EmailCampaign> {
        const c = await this.repo.findOneBy({ id });
        if (!c) throw new AppError(404, ErrorCode.NOT_FOUND, 'Campaign not found.');
        return c;
    }

    static async list(query: { status?: CampaignStatus; limit?: number } = {}) {
        const qb = this.repo.createQueryBuilder('c').orderBy('c."createdAt"', 'DESC')
            .take(Math.min(Math.max(query.limit ?? 50, 1), 200));
        if (query.status) qb.andWhere('c.status = :s', { s: query.status });
        return qb.getMany();
    }

    static async create(actor: AuditActor, input: {
        name: string; subject: string; templateKey: string;
        previewText?: string | null; replyTo?: string | null;
        content?: TemplateContent; segmentId?: string | null;
        audienceDefinition?: AudienceDefinition | null;
    }, ctx: Record<string, unknown> = {}): Promise<EmailCampaign> {
        const template = templateByKey(input.templateKey);
        if (!template) throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown template: ${input.templateKey}`);
        if (!String(input.name ?? '').trim()) {
            throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A campaign name is required.');
        }
        if (!String(input.subject ?? '').trim()) {
            throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A subject is required.');
        }

        const cfg = loadCommunicationsConfig();
        const campaign = await this.repo.save(this.repo.create({
            name: input.name.trim(),
            subject: input.subject.trim(),
            previewText: input.previewText?.trim() || null,
            senderName: cfg.fromName,
            replyTo: input.replyTo?.trim() || cfg.replyToAddress,
            templateKey: input.templateKey,
            content: { ...template.defaults, ...(input.content ?? {}) } as Record<string, unknown>,
            segmentId: input.segmentId ?? null,
            audienceDefinition: (input.audienceDefinition ?? null) as Record<string, unknown> | null,
            status: CampaignStatus.DRAFT,
            createdByStaffId: actor.staffUserId,
        }));

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.CREATED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: campaign.id,
            newValue: `${campaign.name} (${campaign.templateKey})`,
            metadata: { subject: campaign.subject },
            ...ctx,
        });
        return campaign;
    }

    /**
     * Edit a draft.
     *
     * A material change to an APPROVED campaign returns it to draft. That is not
     * an inconvenience to route around — an approval records that a named person
     * read a specific email, and letting the text change underneath it would
     * make the record false.
     */
    static async update(actor: AuditActor, id: string, patch: Partial<{
        name: string; subject: string; previewText: string | null; replyTo: string | null;
        content: TemplateContent; segmentId: string | null;
        audienceDefinition: AudienceDefinition | null;
    }>, ctx: Record<string, unknown> = {}): Promise<EmailCampaign> {
        const campaign = await this.get(id);

        if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)
            || campaign.status === CampaignStatus.SENDING) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `A ${campaign.status} campaign cannot be edited.`);
        }

        const before = contentFingerprint(materialParts(campaign));
        const audienceBefore = JSON.stringify({ s: campaign.segmentId, a: campaign.audienceDefinition });

        if (patch.name !== undefined) campaign.name = String(patch.name).trim();
        if (patch.subject !== undefined) campaign.subject = String(patch.subject).trim();
        if (patch.previewText !== undefined) campaign.previewText = patch.previewText?.trim() || null;
        if (patch.replyTo !== undefined) campaign.replyTo = patch.replyTo?.trim() || null;
        if (patch.content !== undefined) {
            campaign.content = { ...(campaign.content ?? {}), ...patch.content } as Record<string, unknown>;
        }
        if (patch.segmentId !== undefined) campaign.segmentId = patch.segmentId;
        if (patch.audienceDefinition !== undefined) {
            campaign.audienceDefinition = patch.audienceDefinition as Record<string, unknown> | null;
        }

        const after = contentFingerprint(materialParts(campaign));
        const changed = before !== after;

        let reverted = false;
        if (changed && (campaign.status === CampaignStatus.APPROVED
            || campaign.status === CampaignStatus.SCHEDULED
            || campaign.status === CampaignStatus.AWAITING_APPROVAL)) {
            campaign.status = CampaignStatus.DRAFT;
            campaign.approvedByStaffId = null;
            campaign.approvedAt = null;
            campaign.approvedContentHash = null;
            campaign.scheduledAt = null;
            reverted = true;
        }

        const saved = await this.repo.save(campaign);

        if (changed) {
            const audienceAfter = JSON.stringify({ s: saved.segmentId, a: saved.audienceDefinition });
            await AuditService.recordCritical({
                actor,
                action: audienceBefore !== audienceAfter
                    ? CampaignAuditAction.AUDIENCE_CHANGED
                    : CampaignAuditAction.EDITED,
                resourceType: 'EMAIL_CAMPAIGN', resourceId: saved.id,
                previousValue: before.slice(0, 16),
                newValue: after.slice(0, 16),
                metadata: { revertedToDraft: reverted },
                ...ctx,
            });
        }
        return saved;
    }

    /** The audience as it stands right now — never a stored list. */
    static async resolveAudience(campaign: EmailCampaign): Promise<{
        definition: AudienceDefinition; preview: AudiencePreview;
    }> {
        let definition: AudienceDefinition;

        if (campaign.segmentId) {
            const segment = await this.segments.findOneBy({ id: campaign.segmentId });
            if (!segment) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                    'This campaign points at a saved segment that no longer exists.');
            }
            definition = segment.definition as AudienceDefinition;
        } else if (campaign.audienceDefinition) {
            definition = campaign.audienceDefinition as AudienceDefinition;
        } else {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'This campaign has no audience.');
        }

        /*
         * The template decides the consent category, not the campaign author.
         * Otherwise a discount could be sent under the safety-announcement
         * exemption, which is the one category that does not need marketing
         * consent — precisely the loophole worth closing.
         */
        const template = templateByKey(campaign.templateKey);
        definition = { ...definition, category: template?.category ?? 'promotionalOffers' };

        return { definition, preview: await AudienceService.resolve(definition).then((r) => r.preview) };
    }

    /** Rendered preview for the admin screen and for a test send. */
    static async renderFor(campaign: EmailCampaign, sample: {
        firstName?: string | null; city?: string | null;
    } = {}) {
        const cfg = loadCommunicationsConfig();
        const content = campaign.content as TemplateContent;

        return renderTemplate(campaign.templateKey, {
            content,
            personalisation: {
                firstName: sample.firstName ?? 'Chidi',
                city: sample.city ?? 'Onitsha',
                promoCode: (content.promoCode as string) ?? null,
                promoExpiry: (content.promoExpiry as string) ?? null,
                ctaUrl: (content.ctaUrl as string) ?? null,
            },
            // Preview links are clearly marked rather than live, so clicking one
            // in a test cannot unsubscribe a real passenger.
            unsubscribeUrl: `${cfg.publicBaseUrl}/comms/unsubscribe?token=PREVIEW`,
            preferencesUrl: `${cfg.publicBaseUrl}/comms/preferences?token=PREVIEW`,
            supportEmail: cfg.replyToAddress,
            previewText: campaign.previewText,
        });
    }

    /**
     * Send one copy to a staff address.
     *
     * Required before a campaign may be approved: somebody has to have looked
     * at the real thing in a real inbox. Recorded on the campaign so "we tested
     * it" is a fact rather than a claim.
     */
    static async sendTest(actor: AuditActor, id: string, toAddress: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        const to = String(toAddress ?? '').trim().toLowerCase();
        if (!to.includes('@')) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A valid test address is required.');
        }

        const rendered = await this.renderFor(campaign);
        const sender = senderIdentity();

        const result = await emailProvider().send({
            to,
            subject: `[TEST] ${campaign.subject}`,
            html: rendered.html,
            text: rendered.text,
            fromName: sender.fromName,
            fromAddress: sender.fromAddress,
            replyTo: campaign.replyTo ?? sender.replyTo,
            idempotencyKey: `test-${campaign.id}-${Date.now()}`,
        });

        if (!result.ok) {
            throw new AppError(502, ErrorCode.INTERNAL_ERROR, `Test send failed: ${result.error}`);
        }

        campaign.lastTestSentAt = new Date();
        await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.TEST_SENT,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: campaign.id,
            // The recipient is staff, and recording it answers "who checked this".
            newValue: to,
            ...ctx,
        });
        return { ok: true, messageId: result.messageId };
    }

    static async requestApproval(actor: AuditActor, id: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.DRAFT) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `Only a draft can be sent for approval — this one is ${campaign.status}.`);
        }
        // Resolving now surfaces a broken audience here rather than at send.
        await this.resolveAudience(campaign);

        campaign.status = CampaignStatus.AWAITING_APPROVAL;
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.APPROVAL_REQUESTED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: id,
            previousValue: CampaignStatus.DRAFT, newValue: CampaignStatus.AWAITING_APPROVAL,
            ...ctx,
        });
        return saved;
    }

    /**
     * Approve, freezing what was read.
     *
     * The approver may not be the author. One person writing an email to every
     * passenger and also releasing it is the single-person failure this whole
     * workflow exists to prevent.
     */
    static async approve(actor: AuditActor, id: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.AWAITING_APPROVAL) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `Only a campaign awaiting approval can be approved — this one is ${campaign.status}.`);
        }
        if (campaign.createdByStaffId === actor.staffUserId) {
            throw new AppError(403, ErrorCode.FORBIDDEN,
                'A campaign must be approved by somebody other than its author.');
        }
        if (!campaign.lastTestSentAt) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'Send a test email and read it before approving this campaign.');
        }

        campaign.status = CampaignStatus.APPROVED;
        campaign.approvedByStaffId = actor.staffUserId;
        campaign.approvedAt = new Date();
        campaign.approvedContentHash = contentFingerprint(materialParts(campaign));
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.APPROVED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: id,
            previousValue: CampaignStatus.AWAITING_APPROVAL, newValue: CampaignStatus.APPROVED,
            metadata: { contentHash: saved.approvedContentHash },
            ...ctx,
        });
        return saved;
    }

    static async schedule(actor: AuditActor, id: string, whenIso: string, timezone: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.APPROVED) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                'Only an approved campaign can be scheduled.');
        }
        const when = new Date(whenIso);
        if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Choose a time in the future.');
        }

        campaign.status = CampaignStatus.SCHEDULED;
        campaign.scheduledAt = when;
        campaign.scheduleTimezone = timezone || 'Africa/Lagos';
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.SCHEDULED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: id,
            newValue: `${when.toISOString()} (${saved.scheduleTimezone})`,
            ...ctx,
        });
        return saved;
    }

    static async cancelSchedule(actor: AuditActor, id: string, reason: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.SCHEDULED) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'This campaign is not scheduled.');
        }
        const previous = campaign.scheduledAt?.toISOString() ?? null;
        campaign.status = CampaignStatus.APPROVED;
        campaign.scheduledAt = null;
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.SCHEDULE_CANCELLED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: id,
            reason: reason?.trim() || null, previousValue: previous, newValue: null,
            ...ctx,
        });
        return saved;
    }

    static async cancel(actor: AuditActor, id: string, reason: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `Already ${campaign.status}.`);
        }
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to cancel a campaign.');
        }
        const previous = campaign.status;
        campaign.status = CampaignStatus.CANCELLED;
        campaign.stopReason = reason.trim().slice(0, 500);
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAuditAction.CANCELLED,
            resourceType: 'EMAIL_CAMPAIGN', resourceId: id,
            reason: reason.trim(), previousValue: previous, newValue: CampaignStatus.CANCELLED,
            ...ctx,
        });
        return saved;
    }

    /**
     * Everything an admin must see before releasing a campaign.
     *
     * Assembled server-side so the confirmation cannot show one thing while the
     * send does another — the audience here is resolved by the same call the
     * sender will make.
     */
    static async readiness(id: string) {
        const campaign = await this.get(id);
        const { definition, preview } = await this.resolveAudience(campaign);
        const cfg = loadCommunicationsConfig();
        const template = templateByKey(campaign.templateKey);

        const blockers: string[] = [...marketingSendBlockers()];
        if (!campaign.lastTestSentAt) blockers.push('No test email has been sent.');
        if (campaign.status !== CampaignStatus.APPROVED && campaign.status !== CampaignStatus.SCHEDULED) {
            blockers.push(`Campaign is ${campaign.status}, not approved.`);
        }
        if (preview.eligible === 0) blockers.push('No eligible recipients.');
        if (preview.eligible > cfg.maxAudienceSize) {
            blockers.push(`Audience of ${preview.eligible} exceeds the ${cfg.maxAudienceSize} ceiling.`);
        }
        if (campaign.approvedContentHash
            && campaign.approvedContentHash !== contentFingerprint(materialParts(campaign))) {
            blockers.push('The content has changed since it was approved.');
        }

        return {
            campaign,
            template: template ? { key: template.key, name: template.name, category: template.category } : null,
            audience: { definition, ...preview },
            requiresExtraConfirmation: preview.eligible >= cfg.largeAudienceWarning,
            sender: senderIdentity(),
            unsubscribeIncluded: true,
            blockers,
            canSend: blockers.length === 0,
        };
    }

    /** The template catalogue, for the create screen. */
    static templates() {
        return TEMPLATES.map((t) => ({
            key: t.key, name: t.name, description: t.description,
            category: t.category, defaults: t.defaults,
        }));
    }

    /** Consent and suppression totals for the overview. */
    static async overview() {
        const [stats, campaigns] = await Promise.all([
            MarketingConsentService.stats(),
            this.repo.count(),
        ]);
        return {
            consent: stats,
            campaigns,
            sendingEnabled: loadCommunicationsConfig().marketingSendEnabled,
            blockers: marketingSendBlockers(),
        };
    }
}
