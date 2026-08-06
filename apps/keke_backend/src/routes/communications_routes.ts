/**
 * Passenger Communications — admin API.
 *
 * Mounted inside the admin router, so it inherits the whole staff auth chain.
 * Every route additionally requires a REAL staff actor: the legacy shared key
 * is barred from the entire `communications:` namespace, because emailing every
 * passenger is the least attributable thing a shared secret could do.
 *
 * There is no bulk-send route in this file. Phase 1 stops at approved and
 * ready; the sender arrives in Phase 2 behind the kill switch.
 */

import { Router, Response } from 'express';
import { CampaignService } from '../services/campaign_service';
import { MultiChannelCampaignService } from '../services/multichannel_campaign_service';
import { CampaignSimulator } from '../services/campaign_simulator';
import { CampaignTestSend } from '../services/campaign_test_send';
import { CommunicationsDashboardService } from '../services/communications_dashboard_service';
import { channelBlockers, loadCommunicationsConfig } from '../config/communications_config';
import { AudienceService, AudienceDefinition } from '../services/audience_service';
import { MarketingConsentService, SuppressionService } from '../services/marketing_consent_service';
import { EmailAudienceSegment } from '../models/EmailAudienceSegment';
import { CampaignStatus } from '../models/EmailCampaign';
import { AppDataSource } from '../config/data_source';
import { AuditService } from '../services/audit_service';
import { requireStaffPermission, requireRealStaff, StaffRequest, auditActorOf } from '../middleware/staff_auth';
import { StaffPermission } from '../config/staff_permissions';
import { errBody, ErrorCode, AppError } from '../utils/errors';

const router = Router();

function ctxOf(req: StaffRequest) {
    return {
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        correlationId: (req as any).requestId ?? null,
    };
}

function fail(res: Response, err: any, fallback: string) {
    if (err instanceof AppError) return res.status(err.statusCode).json(errBody(err.code, err.message));
    console.error('[COMMS]', err?.message);
    return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, fallback));
}

// ── Overview ────────────────────────────────────────────────────────────

router.get('/communications/overview',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            return res.json(await CampaignService.overview());
        } catch (err: any) {
            return fail(res, err, "We couldn't load the communications overview.");
        }
    });

router.get('/communications/templates',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    (_req: StaffRequest, res: Response) => res.json({ templates: CampaignService.templates() }));

// ── Audience ────────────────────────────────────────────────────────────

/**
 * Preview an audience without saving anything.
 *
 * Returns counts, exclusion reasons and MASKED sample addresses. A full
 * recipient list is never returned to the browser: an admin needs to know the
 * audience is right, not to receive an export of passenger emails.
 */
router.post('/communications/audience/preview',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const preview = await AudienceService.preview((req.body ?? {}) as AudienceDefinition);
            return res.json(preview);
        } catch (err: any) {
            return fail(res, err, "We couldn't resolve that audience.");
        }
    });

router.get('/communications/segments',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            const items = await AppDataSource.getRepository(EmailAudienceSegment)
                .find({ order: { createdAt: 'DESC' }, take: 100 });
            return res.json({ items });
        } catch (err: any) {
            return fail(res, err, "We couldn't load saved segments.");
        }
    });

router.post('/communications/segments',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const repo = AppDataSource.getRepository(EmailAudienceSegment);
            const name = String(req.body?.name ?? '').trim();
            if (!name) return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, 'A segment name is required.'));

            const definition = (req.body?.definition ?? {}) as AudienceDefinition;
            // Counted once for display; membership is always re-resolved at send.
            const preview = await AudienceService.preview(definition);

            const segment = await repo.save(repo.create({
                name,
                description: String(req.body?.description ?? '').trim() || null,
                definition: definition as Record<string, unknown>,
                createdByStaffId: req.actor!.staffUserId,
                lastCount: preview.eligible,
                lastCountedAt: new Date(),
            }));
            return res.status(201).json({ segment, preview });
        } catch (err: any) {
            return fail(res, err, "We couldn't save that segment.");
        }
    });

// ── Campaigns ───────────────────────────────────────────────────────────

router.get('/communications/campaigns',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const status = req.query.status as CampaignStatus | undefined;
            return res.json({ items: await CampaignService.list({ status }) });
        } catch (err: any) {
            return fail(res, err, "We couldn't load campaigns.");
        }
    });

router.get('/communications/campaigns/:id',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const campaign = await CampaignService.get(String(req.params.id));
            const rendered = await CampaignService.renderFor(campaign);
            return res.json({ campaign, preview: { html: rendered.html, text: rendered.text } });
        } catch (err: any) {
            return fail(res, err, "We couldn't load this campaign.");
        }
    });

router.post('/communications/campaigns',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const campaign = await CampaignService.create(auditActorOf(req.actor), req.body ?? {}, ctxOf(req));
            return res.status(201).json({ campaign });
        } catch (err: any) {
            return fail(res, err, "We couldn't create this campaign.");
        }
    });

router.patch('/communications/campaigns/:id',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const campaign = await CampaignService.update(
                auditActorOf(req.actor), String(req.params.id), req.body ?? {}, ctxOf(req));
            return res.json({ campaign });
        } catch (err: any) {
            return fail(res, err, "We couldn't update this campaign.");
        }
    });

/** Duplicate, always as a fresh draft — never inheriting an approval. */
router.post('/communications/campaigns/:id/duplicate',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const source = await CampaignService.get(String(req.params.id));
            const copy = await CampaignService.create(auditActorOf(req.actor), {
                name: `${source.name} (copy)`,
                subject: source.subject,
                previewText: source.previewText,
                replyTo: source.replyTo,
                templateKey: source.templateKey,
                content: source.content as any,
                segmentId: source.segmentId,
                audienceDefinition: source.audienceDefinition as any,
            }, ctxOf(req));
            return res.status(201).json({ campaign: copy });
        } catch (err: any) {
            return fail(res, err, "We couldn't duplicate this campaign.");
        }
    });

router.post('/communications/campaigns/:id/test',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const result = await CampaignService.sendTest(
                auditActorOf(req.actor), String(req.params.id),
                String(req.body?.to ?? ''), ctxOf(req));
            return res.json(result);
        } catch (err: any) {
            return fail(res, err, "We couldn't send the test email.");
        }
    });

router.post('/communications/campaigns/:id/request-approval',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await CampaignService.requestApproval(
                    auditActorOf(req.actor), String(req.params.id), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't request approval.");
        }
    });

router.post('/communications/campaigns/:id/approve',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_APPROVE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await CampaignService.approve(
                    auditActorOf(req.actor), String(req.params.id), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't approve this campaign.");
        }
    });

router.post('/communications/campaigns/:id/schedule',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_SCHEDULE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await CampaignService.schedule(
                    auditActorOf(req.actor), String(req.params.id),
                    String(req.body?.scheduledAt ?? ''),
                    String(req.body?.timezone ?? 'Africa/Lagos'), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't schedule this campaign.");
        }
    });

router.post('/communications/campaigns/:id/cancel-schedule',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_SCHEDULE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await CampaignService.cancelSchedule(
                    auditActorOf(req.actor), String(req.params.id),
                    String(req.body?.reason ?? ''), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't cancel the schedule.");
        }
    });

router.post('/communications/campaigns/:id/cancel',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await CampaignService.cancel(
                    auditActorOf(req.actor), String(req.params.id),
                    String(req.body?.reason ?? ''), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't cancel this campaign.");
        }
    });

/** Everything that must be true before this campaign may be released. */
router.get('/communications/campaigns/:id/readiness',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await CampaignService.readiness(String(req.params.id)));
        } catch (err: any) {
            return fail(res, err, "We couldn't check this campaign.");
        }
    });

// ── Suppression and preferences ─────────────────────────────────────────

router.get('/communications/suppression',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES),
    async (req: StaffRequest, res: Response) => {
        try {
            const items = await SuppressionService.list({
                search: req.query.search as string,
                reason: req.query.reason as string,
            });
            return res.json({ items });
        } catch (err: any) {
            return fail(res, err, "We couldn't load the suppression list.");
        }
    });

router.post('/communications/suppression',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES),
    async (req: StaffRequest, res: Response) => {
        try {
            const email = String(req.body?.email ?? '');
            if (!email.includes('@')) {
                return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, 'A valid address is required.'));
            }
            const row = await SuppressionService.add(email, 'manual', 'admin', {
                detail: String(req.body?.reason ?? '') || null,
                staffId: req.actor!.staffUserId,
            });
            await AuditService.recordCritical({
                actor: auditActorOf(req.actor), action: 'SUPPRESSION_ADDED',
                resourceType: 'EMAIL_SUPPRESSION', resourceId: row.id,
                newValue: row.email, reason: String(req.body?.reason ?? '') || null,
                ...ctxOf(req),
            });
            return res.status(201).json({ suppression: row });
        } catch (err: any) {
            return fail(res, err, "We couldn't add that address.");
        }
    });

/**
 * Lift a suppression.
 *
 * Refuses for hard bounces and complaints. Re-sending to an address that told
 * a mailbox provider we were spam is how a sending domain is lost — and that
 * domain also carries KekeRide's verification codes and password resets.
 */
router.delete('/communications/suppression/:email',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_PREFERENCES),
    async (req: StaffRequest, res: Response) => {
        try {
            const result = await SuppressionService.remove(
                String(req.params.email), req.actor!.staffUserId);
            if (!result.removed) {
                return res.status(409).json(errBody(ErrorCode.VALIDATION_ERROR,
                    result.reason === 'not_suppressed'
                        ? 'That address is not suppressed.'
                        : 'A hard bounce or spam complaint cannot be lifted — sending again would put the whole sending domain at risk.'));
            }
            await AuditService.recordCritical({
                actor: auditActorOf(req.actor), action: 'SUPPRESSION_REMOVED',
                resourceType: 'EMAIL_SUPPRESSION', resourceId: String(req.params.email),
                previousValue: String(req.params.email), newValue: null,
                reason: String(req.body?.reason ?? '') || null,
                ...ctxOf(req),
            });
            return res.json({ removed: true });
        } catch (err: any) {
            return fail(res, err, "We couldn't remove that suppression.");
        }
    });

router.get('/communications/consent-stats',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            return res.json(await MarketingConsentService.stats());
        } catch (err: any) {
            return fail(res, err, "We couldn't load consent numbers.");
        }
    });


// ═══════════════════════════════════════════════════════════════════════
//  Multi-channel campaigns (Phase B)
//
//  There is no send route here. `readiness` returns canSend: false from the
//  server, so a disabled button in the browser is not the only thing standing
//  between a draft and 57 passengers.
// ═══════════════════════════════════════════════════════════════════════

router.get('/communications/mc/overview',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            return res.json(await MultiChannelCampaignService.overview());
        } catch (err: any) {
            return fail(res, err, "We couldn't load the overview.");
        }
    });

router.get('/communications/mc/campaigns',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                items: await MultiChannelCampaignService.list({ status: req.query.status as any }),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't load campaigns.");
        }
    });

router.get('/communications/mc/campaigns/:id',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const id = String(req.params.id);
            const [campaign, channels, previews] = await Promise.all([
                MultiChannelCampaignService.get(id),
                MultiChannelCampaignService.channelsFor(id),
                MultiChannelCampaignService.previews(id),
            ]);
            return res.json({ campaign, channels, previews });
        } catch (err: any) {
            return fail(res, err, "We couldn't load this campaign.");
        }
    });

router.post('/communications/mc/campaigns',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const campaign = await MultiChannelCampaignService.create(
                auditActorOf(req.actor), req.body ?? {}, ctxOf(req));
            return res.status(201).json({ campaign });
        } catch (err: any) {
            return fail(res, err, "We couldn't create this campaign.");
        }
    });

router.patch('/communications/mc/campaigns/:id',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await MultiChannelCampaignService.update(
                    auditActorOf(req.actor), String(req.params.id), req.body ?? {}, ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't update this campaign.");
        }
    });

router.put('/communications/mc/campaigns/:id/channels/:channel',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                channel: await MultiChannelCampaignService.setChannel(
                    auditActorOf(req.actor), String(req.params.id),
                    String(req.params.channel) as any, req.body ?? {}, ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't update that channel.");
        }
    });

/** Audience resolved once, then evaluated per channel. */
router.get('/communications/mc/campaigns/:id/readiness',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await MultiChannelCampaignService.readiness(String(req.params.id)));
        } catch (err: any) {
            return fail(res, err, "We couldn't check this campaign.");
        }
    });

router.get('/communications/mc/campaigns/:id/previews',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await MultiChannelCampaignService.previews(String(req.params.id)));
        } catch (err: any) {
            return fail(res, err, "We couldn't render the previews.");
        }
    });

router.post('/communications/mc/campaigns/:id/request-approval',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await MultiChannelCampaignService.requestApproval(
                    auditActorOf(req.actor), String(req.params.id), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't request approval.");
        }
    });

router.post('/communications/mc/campaigns/:id/approve',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_APPROVE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await MultiChannelCampaignService.approve(
                    auditActorOf(req.actor), String(req.params.id), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't approve this campaign.");
        }
    });

router.post('/communications/mc/campaigns/:id/cancel',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json({
                campaign: await MultiChannelCampaignService.cancel(
                    auditActorOf(req.actor), String(req.params.id),
                    String(req.body?.reason ?? ''), ctxOf(req)),
            });
        } catch (err: any) {
            return fail(res, err, "We couldn't cancel this campaign.");
        }
    });

/** Channel Health: why each channel can or cannot send. */
router.get('/communications/channel-health',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    (_req: StaffRequest, res: Response) => res.json({ channels: channelBlockers() }));

/** The audience presets offered in the builder. */
router.get('/communications/audience-presets',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    (_req: StaffRequest, res: Response) => {
        const cfg = loadCommunicationsConfig();
        return res.json({
            presets: [
                { key: 'all', label: 'All passengers', definition: { activity: 'all' } },
                { key: 'active', label: 'Completed at least one ride', definition: { activity: 'completed_any' } },
                { key: 'inactive', label: `No ride in ${cfg.inactiveDaysThreshold} days`, definition: { activity: 'inactive' } },
                { key: 'new', label: 'Registered, never requested', definition: { activity: 'never_requested' } },
                { key: 'no_completed', label: 'Requested, never completed', definition: { activity: 'requested_never_completed' } },
                { key: 'frequent', label: `${cfg.frequentRideThreshold}+ completed rides`, definition: { activity: 'frequent' } },
            ],
            thresholds: {
                frequentRideThreshold: cfg.frequentRideThreshold,
                inactiveDaysThreshold: cfg.inactiveDaysThreshold,
                highValueSpendThreshold: cfg.highValueSpendThreshold,
            },
        });
    });

/** The simulator: what a release would actually do, before anybody approves it. */
router.get('/communications/mc/campaigns/:id/simulate',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await CampaignSimulator.run(String(req.params.id)));
        } catch (err: any) {
            return fail(res, err, "We couldn't simulate this campaign.");
        }
    });

/**
 * Test send — staff addresses only.
 *
 * Refuses any address belonging to a passenger, whoever asked for it, and has
 * no access to the audience at all.
 */
router.post('/communications/mc/campaigns/:id/test',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_CREATE),
    async (req: StaffRequest, res: Response) => {
        try {
            const addresses = Array.isArray(req.body?.addresses)
                ? req.body.addresses
                : [req.body?.to].filter(Boolean);
            return res.json(await CampaignTestSend.send(
                auditActorOf(req.actor), String(req.params.id), addresses, ctxOf(req)));
        } catch (err: any) {
            return fail(res, err, "We couldn't send the test.");
        }
    });

// ═══════════════════════════════════════════════════════════════════════
//  Global dashboard and emergency controls
// ═══════════════════════════════════════════════════════════════════════

router.get('/communications/dashboard',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            return res.json(await CommunicationsDashboardService.snapshot());
        } catch (err: any) {
            return fail(res, err, "We couldn't load the dashboard.");
        }
    });

/**
 * Emergency stop for a marketing channel.
 *
 * The route accepts only marketing channel names. There is no value of
 * `:channel` that stops a ride alert, an OTP or an SOS — a screen with a big
 * red button must not be one keystroke away from silencing the notification
 * that tells a passenger their driver has arrived.
 */
/*
 * Deliberately asymmetric: pausing needs only COMMUNICATIONS_VIEW, resuming
 * needs COMMUNICATIONS_SEND.
 *
 * Anyone trusted to watch the dashboard is trusted to stop it. An operations
 * admin who sees something wrong at 2am must not be locked out of the emergency
 * stop because they are not a sender. Starting a send back up is a sending
 * decision and keeps the higher bar.
 */
router.post('/communications/pause/:channel',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const channel = String(req.params.channel);
            const result = await CommunicationsDashboardService.pause(
                channel as any, String(req.body?.reason ?? ''), req.actor!.staffUserId);

            await AuditService.recordCritical({
                actor: auditActorOf(req.actor), action: 'MARKETING_CHANNEL_PAUSED',
                resourceType: 'COMMUNICATION_CHANNEL', resourceId: channel,
                reason: String(req.body?.reason ?? '') || null,
                previousValue: 'running', newValue: 'paused', ...ctxOf(req),
            });
            return res.json(result);
        } catch (err: any) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, err?.message ?? 'Unknown channel.'));
        }
    });

router.post('/communications/resume/:channel',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_SEND),
    async (req: StaffRequest, res: Response) => {
        try {
            const channel = String(req.params.channel);
            const result = await CommunicationsDashboardService.resume(channel as any);
            await AuditService.recordCritical({
                actor: auditActorOf(req.actor), action: 'MARKETING_CHANNEL_RESUMED',
                resourceType: 'COMMUNICATION_CHANNEL', resourceId: channel,
                previousValue: 'paused', newValue: 'running', ...ctxOf(req),
            });
            return res.json(result);
        } catch (err: any) {
            return fail(res, err, "We couldn't resume that channel.");
        }
    });

export default router;
