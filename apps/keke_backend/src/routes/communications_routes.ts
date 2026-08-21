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
import { TEMPLATES } from '../services/email_templates';
import { LifecycleAutomationService } from '../services/lifecycle_automation_service';
import { CommunicationTrigger, AutomationMode } from '../models/CommunicationTrigger';
import { CommunicationTestSubject } from '../models/CommunicationTestSubject';
import { User } from '../models/User';
import { MultiChannelCampaignService } from '../services/multichannel_campaign_service';
import { CampaignSimulator } from '../services/campaign_simulator';
import { CampaignTestSend } from '../services/campaign_test_send';
import { CommunicationsDashboardService } from '../services/communications_dashboard_service';
import { CampaignCalendarService, CalendarScale } from '../services/campaign_calendar_service';
import { CampaignAnalyticsService } from '../services/campaign_analytics_service';
import { AudienceInsightsService } from '../services/audience_insights_service';
import { CampaignHistoryService } from '../services/campaign_history_service';
import { audienceOptions } from '../services/audience_registry';
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

// The legacy '/communications/overview' was removed with the entity behind it.
// '/communications/mc/overview' is the live one.

/**
 * The template library.
 *
 * Marketing templates only. Service templates (ride-completed, ride-not-
 * fulfilled) are deliberately absent: they are not campaign material, they
 * carry no offer, and an operator must not be able to point a campaign at one.
 */
router.get('/communications/templates',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    (_req: StaffRequest, res: Response) => res.json({
        templates: TEMPLATES.map((t) => ({
            key: t.key, name: t.name, description: t.description,
            category: t.category, defaults: t.defaults,
        })),
    }));

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
            const resolved = await AudienceService.resolve((req.body ?? {}) as AudienceDefinition);
            // The eligibility breakdown is computed over everyone the FILTERS
            // matched, not over those already found eligible — the point is to
            // show the gap between "who this campaign is for" and "who can
            // actually receive it", and per channel, because they differ.
            const channels = await AudienceService.channelBreakdown(resolved.matchedIds);
            return res.json({ ...resolved.preview, channels });
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

/*
 * The legacy single-channel campaign endpoints used to live here.
 *
 * They were backed by an entity whose table no longer exists, so every one of
 * them answered HTTP 500 in production. The dashboard had already moved to the
 * multi-channel API below, which is now the only campaign surface — one
 * campaign engine, one send path. See services/campaign_dispatch_worker.ts.
 */

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

// ═══════════════════════════════════════════════════════════════════════
//  Calendar, analytics, insights, history, audiences
// ═══════════════════════════════════════════════════════════════════════

router.get('/communications/calendar',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const scale = String(req.query.scale ?? 'month') as CalendarScale;
            if (!['day', 'week', 'month'].includes(scale)) {
                return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, 'scale must be day, week or month.'));
            }
            const anchor = String(req.query.date ?? new Date().toISOString());
            const statuses = req.query.status
                ? String(req.query.status).split(',').filter(Boolean) as any[]
                : undefined;
            return res.json(await CampaignCalendarService.view(scale, anchor, statuses));
        } catch (err: any) {
            return fail(res, err, "We couldn't load the calendar.");
        }
    });

/*
 * Drag-and-drop rescheduling.
 *
 * Gated on COMMUNICATIONS_SCHEDULE, not on VIEW: moving a send date is a
 * scheduling decision, and a calendar that anybody who can look at it can also
 * rearrange is a calendar nobody can trust.
 */
router.post('/communications/calendar/reschedule',
    requireRealStaff, requireStaffPermission(StaffPermission.COMMUNICATIONS_SCHEDULE),
    async (req: StaffRequest, res: Response) => {
        try {
            const result = await CampaignCalendarService.reschedule({
                campaignId: String(req.body?.campaignId ?? ''),
                toISO: String(req.body?.scheduledAt ?? ''),
                actorStaffId: req.actor!.staffUserId!,
                ipAddress: req.ip ?? null,
                userAgent: String(req.headers['user-agent'] ?? ''),
            });
            await AuditService.recordCritical({
                actor: auditActorOf(req.actor), action: 'CAMPAIGN_RESCHEDULED',
                resourceType: 'COMMUNICATION_CAMPAIGN', resourceId: result.id,
                previousValue: result.movedFrom, newValue: result.scheduledAt, ...ctxOf(req),
            });
            return res.json(result);
        } catch (err: any) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, err?.message ?? 'Could not reschedule.'));
        }
    });

router.get('/communications/analytics',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW_REPORTS),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await CampaignAnalyticsService.overview({
                days: req.query.days ? Number(req.query.days) : undefined,
                campaignId: req.query.campaignId ? String(req.query.campaignId) : undefined,
            }));
        } catch (err: any) {
            return fail(res, err, "We couldn't load analytics.");
        }
    });

router.post('/communications/audience/insights',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            return res.json(await AudienceInsightsService.describe(req.body?.definition ?? {}));
        } catch (err: any) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, err?.message ?? 'Could not describe that audience.'));
        }
    });

router.get('/communications/mc/campaigns/:id/history',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const campaignId = String(req.params.id);
            const [history, attribution] = await Promise.all([
                CampaignHistoryService.forCampaign(campaignId),
                CampaignHistoryService.attribution(campaignId),
            ]);
            return res.json({ history, attribution });
        } catch (err: any) {
            return fail(res, err, "We couldn't load the campaign history.");
        }
    });

/** The audience registry — which audiences exist, which are usable, what each still needs. */
router.get('/communications/audiences',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        return res.json({ audiences: audienceOptions() });
    });

// ── Lifecycle automations ───────────────────────────────────────────────
//
// An automation is a standing instruction, so changing one is a different
// power from drafting a campaign and has its own permission. The consent class
// is deliberately NOT editable through this API: it is what stops a discount
// being sent under service consent, and an operator must not be able to move
// a template across that line.

router.get('/communications/automations',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            return res.json({ items: await LifecycleAutomationService.summary() });
        } catch (err: any) {
            return fail(res, err, "We couldn't load the automations.");
        }
    });

router.patch('/communications/automations/:key',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_AUTOMATIONS),
    async (req: StaffRequest, res: Response) => {
        try {
            const key = String(req.params.key);
            const repo = AppDataSource.getRepository(CommunicationTrigger);
            const trigger = await repo.findOne({ where: { key } });
            if (!trigger) return res.status(404).json({ error: 'No such automation.' });

            const body = (req.body ?? {}) as Record<string, unknown>;

            if ('consentClass' in body && body.consentClass !== trigger.consentClass) {
                return res.status(400).json({
                    error: 'The consent class of an automation cannot be changed. '
                         + 'A service message and a marketing message are different things.',
                });
            }

            const patch: Record<string, unknown> = {};
            if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
            if (typeof body.delayMinutes === 'number') patch.delayMinutes = Math.max(0, body.delayMinutes | 0);
            if (typeof body.cooldownMinutes === 'number') patch.cooldownMinutes = Math.max(0, body.cooldownMinutes | 0);
            if (typeof body.frequencyCap === 'number') patch.frequencyCap = Math.max(0, body.frequencyCap | 0);
            if (typeof body.frequencyWindowDays === 'number') patch.frequencyWindowDays = Math.max(1, body.frequencyWindowDays | 0);

            if (typeof body.mode === 'string') {
                const mode = body.mode.toUpperCase();
                if (!Object.values(AutomationMode).includes(mode as AutomationMode)) {
                    return res.status(400).json({ error: 'Mode must be TEST, PILOT or PRODUCTION.' });
                }
                /*
                 * Going to PRODUCTION is the moment an automation stops being a
                 * rehearsal, so it needs the stronger right — the same one that
                 * releases a campaign — rather than the one that edits a cooldown.
                 */
                if (mode === AutomationMode.PRODUCTION
                    && !req.actor?.permissions?.has(StaffPermission.COMMUNICATIONS_SEND)) {
                    return res.status(403).json({
                        error: 'Moving an automation to PRODUCTION requires the communications send permission.',
                    });
                }
                patch.mode = mode;
            }

            await repo.update(trigger.id, patch as any);

            await AuditService.recordCritical({
                actor: auditActorOf(req.actor),
                action: 'AUTOMATION_UPDATED',
                resourceType: 'COMMUNICATION_TRIGGER',
                resourceId: key,
                metadata: { before: {
                    enabled: trigger.enabled, mode: trigger.mode,
                    cooldownMinutes: trigger.cooldownMinutes,
                }, after: patch },
            });

            const [updated] = (await LifecycleAutomationService.summary()).filter((a: any) => a.key === key);
            return res.json({ automation: updated });
        } catch (err: any) {
            return fail(res, err, "We couldn't update that automation.");
        }
    });

// ── Test / pilot cohort ─────────────────────────────────────────────────

router.get('/communications/test-cohort',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (_req: StaffRequest, res: Response) => {
        try {
            const rows = await AppDataSource.query(
                `SELECT t.id, t."userId", t.scope, t.note, t."createdAt",
                        u."firstName", u.email
                   FROM communication_test_subject t
                   LEFT JOIN "user" u ON u.id = t."userId"
                  ORDER BY t."createdAt" DESC`);
            return res.json({ items: rows });
        } catch (err: any) {
            return fail(res, err, "We couldn't load the test cohort.");
        }
    });

router.post('/communications/test-cohort',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_AUTOMATIONS),
    async (req: StaffRequest, res: Response) => {
        try {
            const userId = String((req.body ?? {}).userId ?? '').trim();
            const scope = String((req.body ?? {}).scope ?? 'TEST').toUpperCase();
            const note = String((req.body ?? {}).note ?? '').trim() || null;
            if (!userId) return res.status(400).json({ error: 'A passenger id is required.' });
            if (scope !== 'TEST' && scope !== 'PILOT') {
                return res.status(400).json({ error: 'Scope must be TEST or PILOT.' });
            }

            const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId } });
            if (!user) return res.status(404).json({ error: 'No such passenger.' });

            const repo = AppDataSource.getRepository(CommunicationTestSubject);
            try {
                await repo.insert(repo.create({
                    userId, scope, note, addedByStaffId: req.actor?.staffUserId ?? null,
                }));
            } catch (err: any) {
                if (String(err?.code) !== '23505') throw err;
            }

            await AuditService.recordCritical({
                actor: auditActorOf(req.actor),
                action: 'COMMS_TEST_SUBJECT_ADDED',
                resourceType: 'USER', resourceId: userId,
                passengerId: userId, metadata: { scope, note },
            });
            return res.status(201).json({ ok: true });
        } catch (err: any) {
            return fail(res, err, "We couldn't add that passenger.");
        }
    });

router.delete('/communications/test-cohort/:id',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_MANAGE_AUTOMATIONS),
    async (req: StaffRequest, res: Response) => {
        try {
            await AppDataSource.getRepository(CommunicationTestSubject)
                .delete({ id: String(req.params.id) });
            return res.json({ ok: true });
        } catch (err: any) {
            return fail(res, err, "We couldn't remove that passenger.");
        }
    });

// ── Per-passenger communication history ─────────────────────────────────

/** What we sent this passenger, and what we deliberately did not send, and why. */
router.get('/communications/history/:userId',
    requireStaffPermission(StaffPermission.COMMUNICATIONS_VIEW),
    async (req: StaffRequest, res: Response) => {
        try {
            const items = await LifecycleAutomationService.historyFor(String(req.params.userId));
            return res.json({ items });
        } catch (err: any) {
            return fail(res, err, "We couldn't load that passenger's history.");
        }
    });

export default router;
