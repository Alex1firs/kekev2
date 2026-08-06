/**
 * Multi-channel campaigns: one audience, one approval, many deliveries.
 *
 * ── Nothing here sends ───────────────────────────────────────────────────
 * Phase B stops at "approved and previewed". There is no method on this class
 * that writes to a passenger, and every channel kill switch is off. The Send
 * button in the admin UI is disabled from the server's own readiness response,
 * not merely greyed out in the browser.
 */

import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import {
    CommunicationCampaign, CommunicationCampaignChannel,
    CampaignChannelKind, CampaignStatus,
} from '../models/CommunicationCampaign';
import { TERMINAL_CAMPAIGN_STATUSES } from '../models/EmailCampaign';
import { EmailAudienceSegment } from '../models/EmailAudienceSegment';
import { AudienceService, AudienceDefinition } from './audience_service';
import { contentFingerprint, MarketingChannel } from './marketing_consent_service';
import { MarketingConsentService } from './marketing_consent_service';
import { channelDefaults, validateChannelContent, analyseSms, ChannelIssue } from './channel_content';
import { renderTemplate } from './email_templates';
import { loadCommunicationsConfig, channelSendEnabled, channelBlockers } from '../config/communications_config';
import { AuditService, AuditActor } from './audit_service';
import { CampaignHistoryService, CampaignAction } from './campaign_history_service';
import { AppError, ErrorCode } from '../utils/errors';

/** Naira per SMS segment. Configurable: it is a commercial term, not a fact. */
const SMS_COST_PER_SEGMENT = Number(process.env.SMS_COST_PER_SEGMENT || 4);

/** Maps a campaign channel onto the consent column that gates it. */
const CONSENT_CHANNEL: Partial<Record<CampaignChannelKind, MarketingChannel>> = {
    [CampaignChannelKind.EMAIL]: 'email',
    [CampaignChannelKind.PUSH]: 'push',
    [CampaignChannelKind.IN_APP]: 'in_app',
    [CampaignChannelKind.SMS]: 'sms',
};

export const CampaignAudit = {
    CREATED: 'CAMPAIGN_CREATED',
    EDITED: 'CAMPAIGN_EDITED',
    CHANNEL_CHANGED: 'CAMPAIGN_CHANNEL_CHANGED',
    AUDIENCE_CHANGED: 'CAMPAIGN_AUDIENCE_CHANGED',
    APPROVAL_REQUESTED: 'CAMPAIGN_APPROVAL_REQUESTED',
    APPROVED: 'CAMPAIGN_APPROVED',
    CANCELLED: 'CAMPAIGN_CANCELLED',
} as const;

export class MultiChannelCampaignService {
    private static get repo() { return AppDataSource.getRepository(CommunicationCampaign); }
    private static get channels() { return AppDataSource.getRepository(CommunicationCampaignChannel); }
    private static get segments() { return AppDataSource.getRepository(EmailAudienceSegment); }

    static async get(id: string): Promise<CommunicationCampaign> {
        const c = await this.repo.findOneBy({ id });
        if (!c) throw new AppError(404, ErrorCode.NOT_FOUND, 'Campaign not found.');
        return c;
    }

    static async channelsFor(campaignId: string): Promise<CommunicationCampaignChannel[]> {
        return this.channels.find({ where: { campaignId }, order: { channel: 'ASC' } });
    }

    static async list(query: { status?: CampaignStatus; limit?: number } = {}) {
        const qb = this.repo.createQueryBuilder('c')
            .orderBy('c."updatedAt"', 'DESC')
            .take(Math.min(Math.max(query.limit ?? 100, 1), 200));
        if (query.status) qb.andWhere('c.status = :s', { s: query.status });

        const campaigns = await qb.getMany();
        if (campaigns.length === 0) return [];

        // One query for every campaign's channels rather than N.
        const rows = await this.channels.find({
            where: { campaignId: In(campaigns.map((c) => c.id)) },
        });
        const byCampaign = new Map<string, CommunicationCampaignChannel[]>();
        for (const r of rows) {
            const list = byCampaign.get(r.campaignId) ?? [];
            list.push(r);
            byCampaign.set(r.campaignId, list);
        }

        return campaigns.map((c) => ({
            ...c,
            channels: (byCampaign.get(c.id) ?? []).map((ch) => ({
                channel: ch.channel, enabled: ch.enabled, status: ch.status,
                eligibleCount: ch.eligibleCount,
            })),
        }));
    }

    static async create(actor: AuditActor, input: {
        name: string; description?: string | null; objective?: string | null;
        segmentId?: string | null; audienceDefinition?: AudienceDefinition | null;
        channels?: CampaignChannelKind[];
    }, ctx: Record<string, unknown> = {}): Promise<CommunicationCampaign> {
        const name = String(input.name ?? '').trim();
        if (!name) throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A campaign name is required.');

        const campaign = await this.repo.save(this.repo.create({
            name,
            description: input.description?.trim() || null,
            objective: input.objective?.trim() || null,
            segmentId: input.segmentId ?? null,
            audienceDefinition: (input.audienceDefinition ?? null) as Record<string, unknown> | null,
            status: CampaignStatus.DRAFT,
            createdByStaffId: actor.staffUserId,
        }));

        // Email by default: it is the only channel with a verified provider.
        for (const channel of input.channels?.length ? input.channels : [CampaignChannelKind.EMAIL]) {
            await this.channels.save(this.channels.create({
                campaignId: campaign.id,
                channel,
                enabled: true,
                content: channelDefaults(channel),
            }));
        }

        await AuditService.recordCritical({
            actor, action: CampaignAudit.CREATED,
            resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: campaign.id,
            newValue: campaign.name, ...ctx,
        });
        /*
         * Both records are written. The audit log answers "what did this person
         * do"; the campaign history answers "what happened to this campaign".
         * Same events, different questions, asked months apart by different
         * people — see campaign_history_service.
         */
        await CampaignHistoryService.record({
            campaignId: campaign.id, action: CampaignAction.CREATED,
            actorStaffId: actor.staffUserId, note: campaign.name,
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
        });
        return campaign;
    }

    /**
     * Everything that, if changed, invalidates an approval.
     *
     * Includes every enabled channel's content. An approver read the whole
     * campaign, not its email half.
     */
    private static async materialParts(campaign: CommunicationCampaign) {
        const channels = await this.channelsFor(campaign.id);
        return {
            segmentId: campaign.segmentId,
            audienceDefinition: campaign.audienceDefinition,
            channels: channels
                .filter((c) => c.enabled)
                .map((c) => ({ channel: c.channel, content: c.content }))
                .sort((a, b) => a.channel.localeCompare(b.channel)),
        };
    }

    static async update(actor: AuditActor, id: string, patch: Partial<{
        name: string; description: string | null; objective: string | null;
        segmentId: string | null; audienceDefinition: AudienceDefinition | null;
    }>, ctx: Record<string, unknown> = {}): Promise<CommunicationCampaign> {
        const campaign = await this.get(id);
        this.assertEditable(campaign);

        const before = contentFingerprint(await this.materialParts(campaign));
        // Snapshot for the history diff, before anything is assigned.
        const previousValues = {
            name: campaign.name, description: campaign.description,
            objective: campaign.objective, segmentId: campaign.segmentId,
            audienceDefinition: campaign.audienceDefinition,
        };

        if (patch.name !== undefined) campaign.name = String(patch.name).trim();
        if (patch.description !== undefined) campaign.description = patch.description?.trim() || null;
        if (patch.objective !== undefined) campaign.objective = patch.objective?.trim() || null;
        if (patch.segmentId !== undefined) campaign.segmentId = patch.segmentId;
        if (patch.audienceDefinition !== undefined) {
            campaign.audienceDefinition = patch.audienceDefinition as Record<string, unknown> | null;
        }
        await this.repo.save(campaign);

        await this.invalidateApprovalIfChanged(actor, campaign, before, CampaignAudit.EDITED, ctx);
        await CampaignHistoryService.record({
            campaignId: id, action: CampaignAction.EDITED,
            actorStaffId: actor.staffUserId,
            changes: CampaignHistoryService.diff(previousValues, {
                name: campaign.name, description: campaign.description,
                objective: campaign.objective, segmentId: campaign.segmentId,
                audienceDefinition: campaign.audienceDefinition,
            }),
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
        });
        return this.get(id);
    }

    /** Turn a channel on or off, or edit its content. */
    static async setChannel(actor: AuditActor, id: string, channel: CampaignChannelKind, patch: {
        enabled?: boolean; content?: Record<string, unknown>; templateKey?: string | null;
    }, ctx: Record<string, unknown> = {}): Promise<CommunicationCampaignChannel> {
        const campaign = await this.get(id);
        this.assertEditable(campaign);

        const before = contentFingerprint(await this.materialParts(campaign));

        let row = await this.channels.findOneBy({ campaignId: id, channel });
        if (!row) {
            row = this.channels.create({
                campaignId: id, channel, enabled: true, content: channelDefaults(channel),
            });
        }
        if (patch.enabled !== undefined) row.enabled = patch.enabled;
        if (patch.templateKey !== undefined) row.templateKey = patch.templateKey;
        if (patch.content !== undefined) {
            // Merged, so editing the subject does not wipe the body.
            row.content = { ...(row.content ?? {}), ...patch.content };
        }
        const saved = await this.channels.save(row);

        await this.invalidateApprovalIfChanged(actor, campaign, before, CampaignAudit.CHANNEL_CHANGED, ctx);
        await CampaignHistoryService.record({
            campaignId: id,
            action: patch.content !== undefined
                ? CampaignAction.CONTENT_EDITED
                : patch.enabled ? CampaignAction.CHANNEL_ENABLED : CampaignAction.CHANNEL_DISABLED,
            actorStaffId: actor.staffUserId, channel: String(channel),
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
        });
        return saved;
    }

    private static assertEditable(campaign: CommunicationCampaign) {
        if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)
            || campaign.status === CampaignStatus.SENDING) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `A ${campaign.status} campaign cannot be edited.`);
        }
    }

    /**
     * Any material change after approval returns the campaign to draft.
     *
     * An approval records that a named person read a specific campaign. Letting
     * the content change underneath it would make the record false — and the
     * person accountable for something they never saw.
     */
    private static async invalidateApprovalIfChanged(
        actor: AuditActor, campaign: CommunicationCampaign,
        beforeHash: string, action: string, ctx: Record<string, unknown>,
    ) {
        const afterHash = contentFingerprint(await this.materialParts(campaign));
        if (beforeHash === afterHash) return;

        let reverted = false;
        if ([CampaignStatus.APPROVED, CampaignStatus.SCHEDULED, CampaignStatus.AWAITING_APPROVAL]
            .includes(campaign.status)) {
            campaign.status = CampaignStatus.DRAFT;
            campaign.approvedByStaffId = null;
            campaign.approvedAt = null;
            campaign.approvedContentHash = null;
            campaign.scheduledAt = null;
            await this.repo.save(campaign);
            reverted = true;
        }

        await AuditService.recordCritical({
            actor, action,
            resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: campaign.id,
            previousValue: beforeHash.slice(0, 16), newValue: afterHash.slice(0, 16),
            metadata: { revertedToDraft: reverted },
            ...ctx,
        });
    }

    /** The audience definition this campaign resolves against. */
    private static async definitionFor(campaign: CommunicationCampaign): Promise<AudienceDefinition> {
        if (campaign.segmentId) {
            const segment = await this.segments.findOneBy({ id: campaign.segmentId });
            if (!segment) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                    'This campaign points at a saved segment that no longer exists.');
            }
            return segment.definition as AudienceDefinition;
        }
        if (campaign.audienceDefinition) return campaign.audienceDefinition as AudienceDefinition;
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'This campaign has no audience.');
    }

    /**
     * Resolve the audience ONCE, then evaluate each channel against it.
     *
     * This is the shape the whole design turns on: the audience is a property
     * of the campaign, so it is resolved a single time; consent is a property
     * of the passenger and the channel, so it is evaluated per channel against
     * that one result. Resolving per channel would run the same expensive query
     * four times and — worse — could return four different populations.
     */
    static async resolve(campaignId: string) {
        const campaign = await this.get(campaignId);
        const definition = await this.definitionFor(campaign);
        const channels = await this.channelsFor(campaignId);
        const cfg = loadCommunicationsConfig();

        // Once.
        const { members } = await AudienceService.resolve({ ...definition, category: 'promotionalOffers' });

        const perChannel: Array<{
            channel: CampaignChannelKind; enabled: boolean;
            eligible: number; excluded: number; exclusions: Record<string, number>;
            estimatedCost: number; segments?: number;
            sendEnabled: boolean; issues: ChannelIssue[];
        }> = [];

        for (const ch of channels) {
            const consentChannel = CONSENT_CHANNEL[ch.channel];
            const exclusions: Record<string, number> = {};
            let eligible = 0;

            if (consentChannel) {
                for (const m of members) {
                    const r = await MarketingConsentService.checkChannelEligibility(
                        m.userId, consentChannel, 'promotionalOffers',
                        consentChannel === 'email' ? m.email : 'present',
                    );
                    if (r.eligible) eligible += 1;
                    else exclusions[r.reason ?? 'ineligible'] = (exclusions[r.reason ?? 'ineligible'] ?? 0) + 1;
                }
            }

            // Only SMS has a real per-recipient cost.
            let estimatedCost = 0;
            let segments: number | undefined;
            if (ch.channel === CampaignChannelKind.SMS) {
                segments = analyseSms(String((ch.content as any)?.body ?? '')).segments;
                estimatedCost = segments * eligible * SMS_COST_PER_SEGMENT;
            }

            perChannel.push({
                channel: ch.channel,
                enabled: ch.enabled,
                eligible,
                excluded: members.length - eligible,
                exclusions,
                estimatedCost,
                segments,
                sendEnabled: channelSendEnabled(consentChannel ?? 'email'),
                issues: validateChannelContent(ch.channel, ch.content ?? {}),
            });

            ch.eligibleCount = eligible;
            ch.excludedCount = members.length - eligible;
            ch.exclusions = exclusions;
            ch.estimatedCost = estimatedCost ? estimatedCost.toFixed(2) : null;
            ch.lastCountedAt = new Date();
            await this.channels.save(ch);
        }

        const enabled = perChannel.filter((c) => c.enabled);
        return {
            campaign,
            definition,
            audienceSize: members.length,
            channels: perChannel,
            totals: {
                /*
                 * Reached-by-any-channel, NOT the sum. Sending one campaign by
                 * both email and push is deliberate, so counting a passenger
                 * twice would overstate the reach and, for SMS, the cost.
                 */
                uniquePassengers: members.length,
                totalDeliveries: enabled.reduce((n, c) => n + c.eligible, 0),
                estimatedCost: enabled.reduce((n, c) => n + c.estimatedCost, 0),
            },
            largeAudience: members.length >= cfg.largeAudienceWarning,
        };
    }

    /** Rendered previews, one per enabled channel. */
    static async previews(campaignId: string) {
        const channels = await this.channelsFor(campaignId);
        const cfg = loadCommunicationsConfig();
        const out: Record<string, unknown> = {};

        for (const ch of channels.filter((c) => c.enabled)) {
            const content = ch.content as any;

            if (ch.channel === CampaignChannelKind.EMAIL) {
                const rendered = renderTemplate(ch.templateKey || 'announcement', {
                    content,
                    personalisation: { firstName: 'Chidi', city: 'Onitsha' },
                    // Marked PREVIEW so clicking one cannot unsubscribe a real
                    // passenger from a test.
                    unsubscribeUrl: `${cfg.publicBaseUrl}/comms/unsubscribe?token=PREVIEW`,
                    preferencesUrl: `${cfg.publicBaseUrl}/comms/preferences?token=PREVIEW`,
                    supportEmail: cfg.replyToAddress,
                    previewText: content.previewText,
                });
                out.email = { html: rendered.html, text: rendered.text, subject: content.subject };
            }

            if (ch.channel === CampaignChannelKind.PUSH) {
                out.push = {
                    title: String(content.title ?? ''),
                    body: String(content.body ?? ''),
                    imageUrl: content.imageUrl ?? null,
                    deepLink: content.deepLink ?? null,
                    // Rendered by the client for Android and iOS separately;
                    // the lengths differ and so does the truncation.
                    titleLength: String(content.title ?? '').length,
                    bodyLength: String(content.body ?? '').length,
                };
            }

            if (ch.channel === CampaignChannelKind.IN_APP) {
                out.in_app = {
                    placement: content.placement ?? 'banner',
                    title: String(content.title ?? ''),
                    body: String(content.body ?? ''),
                    imageUrl: content.imageUrl ?? null,
                    ctaLabel: content.ctaLabel ?? null,
                    priority: content.priority ?? 5,
                    frequencyCap: content.frequencyCap ?? null,
                    startsAt: content.startsAt ?? null,
                    endsAt: content.endsAt ?? null,
                };
            }

            if (ch.channel === CampaignChannelKind.SMS) {
                const body = String(content.body ?? '');
                out.sms = { body, senderId: content.senderId ?? 'KekeRide', ...analyseSms(body) };
            }
        }
        return out;
    }

    /**
     * Everything standing between this campaign and a send.
     *
     * `canSend` is FALSE in this phase whatever the campaign looks like: there
     * is no sender. Returned from the server rather than decided in the
     * browser, so a hand-crafted request cannot get past a disabled button.
     */
    static async readiness(campaignId: string) {
        const resolved = await this.resolve(campaignId);
        const campaign = resolved.campaign;

        const blockers: string[] = [];
        const enabled = resolved.channels.filter((c) => c.enabled);

        if (enabled.length === 0) blockers.push('No channel is enabled.');
        for (const c of enabled) {
            for (const issue of c.issues.filter((i) => i.severity === 'error')) {
                blockers.push(`${c.channel}: ${issue.message}`);
            }
            if (c.eligible === 0) blockers.push(`${c.channel}: no eligible recipients.`);
            if (!c.sendEnabled) blockers.push(`${c.channel}: sending is switched off.`);
        }
        if (campaign.status !== CampaignStatus.APPROVED) {
            blockers.push(`Campaign is ${campaign.status}, not approved.`);
        }
        if (campaign.approvedContentHash
            && campaign.approvedContentHash !== contentFingerprint(await this.materialParts(campaign))) {
            blockers.push('The content has changed since it was approved.');
        }

        return {
            ...resolved,
            channelHealth: channelBlockers(),
            blockers,
            /*
             * Phase B ships no sender. Hard false, not a computed value, so no
             * configuration change can accidentally make a campaign sendable
             * before the delivery pipeline exists.
             */
            canSend: false,
            sendingAvailable: false,
            requiresExtraConfirmation: resolved.largeAudience,
        };
    }

    /** Record that a test was sent. Approval requires one. */
    static async markTested(campaignId: string): Promise<void> {
        const campaign = await this.get(campaignId);
        campaign.lastTestSentAt = new Date();
        await this.repo.save(campaign);
    }

    static async requestApproval(actor: AuditActor, id: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.DRAFT) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `Only a draft can be sent for approval — this one is ${campaign.status}.`);
        }
        const readiness = await this.readiness(id);
        const contentErrors = readiness.blockers.filter((b) => !b.includes('sending is switched off')
            && !b.includes('not approved'));
        if (contentErrors.length) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, contentErrors[0]);
        }

        campaign.status = CampaignStatus.AWAITING_APPROVAL;
        const saved = await this.repo.save(campaign);
        await AuditService.recordCritical({
            actor, action: CampaignAudit.APPROVAL_REQUESTED,
            resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: id,
            previousValue: CampaignStatus.DRAFT, newValue: CampaignStatus.AWAITING_APPROVAL, ...ctx,
        });
        await CampaignHistoryService.record({
            campaignId: id, action: CampaignAction.APPROVAL_REQUESTED,
            actorStaffId: actor.staffUserId,
            changes: [{ field: 'status', from: CampaignStatus.DRAFT, to: CampaignStatus.AWAITING_APPROVAL }],
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
        });
        return saved;
    }

    static async approve(actor: AuditActor, id: string, ctx: Record<string, unknown> = {}) {
        const campaign = await this.get(id);
        if (campaign.status !== CampaignStatus.AWAITING_APPROVAL) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `Only a campaign awaiting approval can be approved — this one is ${campaign.status}.`);
        }
        // One person writing a message to every passenger AND releasing it is
        // the single-person failure this workflow exists to prevent.
        if (campaign.createdByStaffId === actor.staffUserId) {
            throw new AppError(403, ErrorCode.FORBIDDEN,
                'A campaign must be approved by somebody other than its author.');
        }
        /*
         * Somebody has to have read the real thing in a real inbox. A preview
         * in the admin screen is rendered by our own code; a test send is the
         * only way to see what a mail client actually does with it.
         */
        if (!campaign.lastTestSentAt) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'Send a test and read it before approving this campaign.');
        }

        campaign.status = CampaignStatus.APPROVED;
        campaign.approvedByStaffId = actor.staffUserId;
        campaign.approvedAt = new Date();
        campaign.approvedContentHash = contentFingerprint(await this.materialParts(campaign));
        const saved = await this.repo.save(campaign);

        await AuditService.recordCritical({
            actor, action: CampaignAudit.APPROVED,
            resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: id,
            previousValue: CampaignStatus.AWAITING_APPROVAL, newValue: CampaignStatus.APPROVED, ...ctx,
        });
        await CampaignHistoryService.record({
            campaignId: id, action: CampaignAction.APPROVED,
            actorStaffId: actor.staffUserId,
            changes: [{ field: 'status', from: CampaignStatus.AWAITING_APPROVAL, to: CampaignStatus.APPROVED }],
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
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
            actor, action: CampaignAudit.CANCELLED,
            resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: id,
            reason: reason.trim(), previousValue: previous, newValue: CampaignStatus.CANCELLED, ...ctx,
        });
        await CampaignHistoryService.record({
            campaignId: id, action: CampaignAction.CANCELLED,
            actorStaffId: actor.staffUserId, note: reason.trim(),
            changes: [{ field: 'status', from: previous, to: CampaignStatus.CANCELLED }],
            ipAddress: (ctx as any).ipAddress ?? null,
            userAgent: (ctx as any).userAgent ?? null,
        });
        return saved;
    }

    /** The Overview screen, in one call. */
    static async overview() {
        const consent = await MarketingConsentService.channelStats();
        const cfg = loadCommunicationsConfig();

        const counts = await this.repo.createQueryBuilder('c')
            .select('c.status', 'status').addSelect('COUNT(*)', 'n')
            .groupBy('c.status').getRawMany<{ status: string; n: string }>();
        const byStatus = new Map(counts.map((r) => [r.status, Number(r.n)]));

        return {
            consent,
            campaigns: {
                draft: byStatus.get(CampaignStatus.DRAFT) ?? 0,
                awaitingApproval: byStatus.get(CampaignStatus.AWAITING_APPROVAL) ?? 0,
                approved: byStatus.get(CampaignStatus.APPROVED) ?? 0,
                scheduled: byStatus.get(CampaignStatus.SCHEDULED) ?? 0,
                sending: byStatus.get(CampaignStatus.SENDING) ?? 0,
                completed: byStatus.get(CampaignStatus.COMPLETED) ?? 0,
                total: [...byStatus.values()].reduce((a, b) => a + b, 0),
            },
            channels: {
                email: { enabled: cfg.marketingEmailEnabled, blockers: channelBlockers().email },
                push: { enabled: cfg.marketingPushEnabled, blockers: channelBlockers().push },
                in_app: { enabled: cfg.marketingInAppEnabled, blockers: channelBlockers().in_app },
                sms: { enabled: cfg.marketingSmsEnabled, blockers: channelBlockers().sms },
            },
            // Stated plainly on the Overview so nobody has to infer it.
            sendingAvailable: false,
        };
    }
}
