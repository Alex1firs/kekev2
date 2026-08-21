/**
 * The one path by which anything KekeRide sends actually leaves the building.
 *
 * Before this existed a campaign could be written, approved and scheduled and
 * then simply sat there: nothing moved it to SENDING, nothing read `scheduledAt`
 * back, and `MarketingPushService.runBatch()` — fully written — was never
 * called from anywhere. Three separate gaps, one missing worker.
 *
 * ── The state machine ───────────────────────────────────────────────────
 *
 *   DRAFT → AWAITING_APPROVAL → APPROVED → SCHEDULED → SENDING → COMPLETED
 *                                              │          │
 *                                              ├────→ CANCELLED
 *                                              └────→ PAUSED ⇄ SENDING
 *                                                         └──→ FAILED
 *
 * There is exactly one transition into SENDING and it lives in `claimDue()`.
 * A second execution mechanism would eventually disagree with this one, and the
 * disagreement would be discovered as a double send.
 *
 * ── Why a lease and not a lock ──────────────────────────────────────────
 * A boolean "isSending" flag set by a worker that is then killed strands the
 * campaign forever. A lease with an expiry lapses on its own and another worker
 * resumes, which is safe because every recipient row is idempotent: the unique
 * `idempotencyKey` means resuming re-sends to nobody.
 *
 * ── Restart safety ──────────────────────────────────────────────────────
 * Progress lives in `email_campaign_recipient` rows, not in worker memory. A
 * restart mid-batch resumes from the rows still QUEUED. Nothing depends on an
 * admin leaving a browser open.
 */
import { AppDataSource } from '../config/data_source';
import { CommunicationCampaign, CampaignChannelKind, CommunicationCampaignChannel } from '../models/CommunicationCampaign';
import { CampaignStatus } from '../models/EmailCampaign';
import { EmailCampaignRecipient, RecipientStatus } from '../models/EmailCampaignRecipient';
import { User } from '../models/User';
import { AudienceService } from './audience_service';
import { MarketingConsentService } from './marketing_consent_service';
import { MarketingPushService } from './marketing_push_service';
import { LifecycleAutomationService } from './lifecycle_automation_service';
import { AutomationMode } from '../models/CommunicationTrigger';
import { emailProvider, senderIdentity } from './email_provider';
import { loadCommunicationsConfig, channelSendEnabled } from '../config/communications_config';
import { MultiChannelCampaignService } from './multichannel_campaign_service';
import { randomUUID } from 'crypto';

const TICK_MS = Number(process.env.COMMS_WORKER_TICK_MS || 20_000);
const LEASE_MS = Number(process.env.COMMS_LEASE_MS || 120_000);
const BATCH = Number(process.env.COMMS_SEND_BATCH || 25);

export class CampaignDispatchWorker {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;
    /** Distinguishes this process's lease from another's. */
    private static readonly owner = `${process.pid}-${randomUUID().slice(0, 8)}`;

    private static get campaigns() { return AppDataSource.getRepository(CommunicationCampaign); }
    private static get channels() { return AppDataSource.getRepository(CommunicationCampaignChannel); }
    private static get recipients() { return AppDataSource.getRepository(EmailCampaignRecipient); }

    static start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        console.log(JSON.stringify({
            level: 'info', scope: 'comms_worker', event: 'started',
            tickMs: TICK_MS, owner: this.owner,
        }));
    }

    static stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * One pass. Never throws — a communications fault must not take the process
     * down, and this runs on a timer inside the API process.
     */
    static async tick(): Promise<{
        promoted: number; campaignsSent: number; lifecycle: number; push: number;
    }> {
        const out = { promoted: 0, campaignsSent: 0, lifecycle: 0, push: 0 };
        if (this.running) return out;
        this.running = true;

        try {
            // 1. Scheduled campaigns whose time has come.
            out.promoted = await this.promoteDue();

            // 2. Campaigns already sending.
            out.campaignsSent = await this.progressSending();

            // 3. Lifecycle automations that are due.
            const life = await LifecycleAutomationService.sendDue(BATCH * 2);
            out.lifecycle = life.sent;

            // 4. The marketing push queue, which nothing used to drain.
            const push = await MarketingPushService.runBatch();
            out.push = push.sent ?? 0;
        } catch (err: any) {
            console.error(JSON.stringify({
                level: 'error', scope: 'comms_worker', message: err?.message ?? String(err),
            }));
        } finally {
            this.running = false;
        }
        return out;
    }

    // ── SCHEDULED → SENDING ─────────────────────────────────────────────

    /**
     * Claim scheduled campaigns that are due.
     *
     * The conditional UPDATE is the arbiter. Two workers issuing it
     * concurrently cannot both match the same row: the first commits and moves
     * the status out of `scheduled`, so the second's WHERE no longer holds.
     *
     * `scheduledAt` is a timestamp, compared against `now()` in the database.
     * Both are UTC, so the comparison is timezone-safe regardless of where the
     * operator was standing when they scheduled it; the stored
     * `scheduleTimezone` is for displaying their intent back to them, never for
     * arithmetic.
     */
    private static async promoteDue(): Promise<number> {
        const rows: CommunicationCampaign[] = await this.campaigns.query(
            `UPDATE communication_campaign
                SET status = $1,
                    "sendStartedAt" = COALESCE("sendStartedAt", now()),
                    "dispatchLeaseUntil" = now() + ($2 || ' milliseconds')::interval,
                    "dispatchLeaseOwner" = $3,
                    "updatedAt" = now()
              WHERE status = $4
                AND "scheduledAt" IS NOT NULL
                AND "scheduledAt" <= now()
                AND "approvedAt" IS NOT NULL
              RETURNING *`,
            [CampaignStatus.SENDING, String(LEASE_MS), this.owner, CampaignStatus.SCHEDULED],
        );

        for (const c of rows) {
            console.log(JSON.stringify({
                level: 'info', scope: 'comms_worker', event: 'campaign_released',
                campaignId: c.id, mode: (c as any).mode,
            }));
        }
        return rows.length;
    }

    // ── SENDING ─────────────────────────────────────────────────────────

    private static async progressSending(): Promise<number> {
        // Take the lease on one sending campaign. Expired leases are reclaimable.
        const claimed: CommunicationCampaign[] = await this.campaigns.query(
            `UPDATE communication_campaign
                SET "dispatchLeaseUntil" = now() + ($1 || ' milliseconds')::interval,
                    "dispatchLeaseOwner" = $2
              WHERE id = (
                    SELECT id FROM communication_campaign
                     WHERE status = $3
                       AND ("dispatchLeaseUntil" IS NULL
                            OR "dispatchLeaseUntil" < now()
                            OR "dispatchLeaseOwner" = $2)
                     ORDER BY "sendStartedAt" ASC NULLS FIRST
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
              )
              RETURNING *`,
            [String(LEASE_MS), this.owner, CampaignStatus.SENDING],
        );
        if (claimed.length === 0) return 0;

        const campaign = claimed[0];
        return this.sendBatch(campaign);
    }

    private static async sendBatch(campaign: CommunicationCampaign): Promise<number> {
        // Materialise recipients once, the first time this campaign sends.
        await this.ensureRecipients(campaign);

        const emailChannel = await this.channels.findOne({
            where: { campaignId: campaign.id, channel: CampaignChannelKind.EMAIL, enabled: true },
        });
        if (!emailChannel) { await this.finishIfDone(campaign); return 0; }

        // The kill switch is read every batch, not once per campaign, so
        // flipping it takes effect within one tick rather than at the next
        // campaign.
        if (!channelSendEnabled('email')) return 0;

        const { CommunicationsDashboardService } = await import('./communications_dashboard_service');
        if (await CommunicationsDashboardService.channelPaused('email')) return 0;

        const due = await this.recipients.find({
            where: { campaignId: campaign.id, status: RecipientStatus.QUEUED },
            take: BATCH,
        });
        if (due.length === 0) { await this.finishIfDone(campaign); return 0; }

        const previews = await MultiChannelCampaignService.previews(campaign.id) as any;
        const email = previews?.email;
        if (!email) { await this.finishIfDone(campaign); return 0; }

        const sender = senderIdentity();
        const cfg = loadCommunicationsConfig();
        let sent = 0;

        for (const r of due) {
            // Consent re-checked per recipient at the moment of sending: a
            // passenger who unsubscribed after the audience was built must not
            // receive the rest of the campaign.
            const eligible = await MarketingConsentService.checkChannelEligibility(
                r.userId, 'email', 'promotionalOffers', r.email,
            );
            if (!eligible.eligible) {
                await this.recipients.update(r.id, {
                    status: RecipientStatus.SKIPPED, reason: eligible.reason ?? 'not_eligible',
                });
                continue;
            }

            const token = await MarketingConsentService.ensureToken(r.userId);
            const unsubscribeUrl = `${cfg.publicBaseUrl}/comms/unsubscribe?token=${token}`;

            const result = await emailProvider().send({
                to: r.email,
                subject: email.subject ?? campaign.name,
                html: email.html,
                text: email.text,
                fromName: sender.fromName,
                fromAddress: sender.fromAddress,
                replyTo: sender.replyTo,
                idempotencyKey: r.idempotencyKey,
                listUnsubscribeUrl: unsubscribeUrl,
            });

            if (result.ok) {
                await this.recipients.update(r.id, {
                    status: RecipientStatus.SENT, sentAt: new Date(),
                    providerMessageId: result.messageId ?? null,
                    attempts: r.attempts + 1, lastAttemptAt: new Date(), reason: null,
                });
                sent += 1;
            } else {
                const permanent = result.retryable === false;
                await this.recipients.update(r.id, {
                    status: permanent || r.attempts + 1 >= cfg.maxAttempts
                        ? RecipientStatus.FAILED : RecipientStatus.QUEUED,
                    attempts: r.attempts + 1, lastAttemptAt: new Date(),
                    reason: (result.error ?? 'provider error').slice(0, 300),
                });
            }
        }

        await this.refreshCounts(campaign.id);
        await this.finishIfDone(campaign);
        return sent;
    }

    /**
     * Create the recipient rows, once.
     *
     * The cohort is intersected HERE, before any row exists. In TEST mode a
     * campaign whose audience resolves to 130 passengers creates rows only for
     * the allow-listed ones — so no later mistake can send to the rest, because
     * there is nothing to send.
     */
    private static async ensureRecipients(campaign: CommunicationCampaign): Promise<void> {
        const existing = await this.recipients.count({ where: { campaignId: campaign.id } });
        if (existing > 0) return;

        const definition = (campaign.audienceDefinition ?? {}) as any;
        const { members } = await AudienceService.resolve(definition);

        const mode = (campaign as any).mode ?? AutomationMode.TEST;
        const cohort = await LifecycleAutomationService.cohortIds(mode as AutomationMode);
        const allowed = cohort === null
            ? members
            : members.filter((m: any) => cohort.includes(m.userId ?? m.id));

        if (cohort !== null) {
            console.log(JSON.stringify({
                level: 'info', scope: 'comms_worker', event: 'cohort_intersected',
                campaignId: campaign.id, mode, resolved: members.length, allowed: allowed.length,
            }));
        }

        for (const m of allowed as any[]) {
            const userId = m.userId ?? m.id;
            const address = m.email;
            if (!userId || !address) continue;
            try {
                await this.recipients.insert(this.recipients.create({
                    campaignId: campaign.id,
                    userId,
                    email: address,
                    status: RecipientStatus.QUEUED,
                    // Deterministic, so a retry after an ambiguous provider
                    // timeout is recognised as the same message.
                    idempotencyKey: `${campaign.id}:${userId}`,
                }));
            } catch (err: any) {
                if (String(err?.code) !== '23505') throw err;
            }
        }

        // Push runs off the same allow-listed set.
        const pushChannel = await this.channels.findOne({
            where: { campaignId: campaign.id, channel: CampaignChannelKind.PUSH, enabled: true },
        });
        if (pushChannel) {
            await MarketingPushService.enqueue(
                campaign.id, (allowed as any[]).map((m) => m.userId ?? m.id).filter(Boolean),
            );
        }
    }

    private static async refreshCounts(campaignId: string): Promise<void> {
        const [row] = await AppDataSource.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent,
                    COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
                    COUNT(*) FILTER (WHERE status = 'queued')::int  AS queued
               FROM email_campaign_recipient WHERE "campaignId" = $1`, [campaignId]);
        await this.channels.update(
            { campaignId, channel: CampaignChannelKind.EMAIL },
            { sentCount: Number(row?.sent ?? 0), failedCount: Number(row?.failed ?? 0) },
        );
    }

    private static async finishIfDone(campaign: CommunicationCampaign): Promise<void> {
        const remaining = await this.recipients.count({
            where: { campaignId: campaign.id, status: RecipientStatus.QUEUED },
        });
        if (remaining > 0) return;

        const pushRemaining = await MarketingPushService.report(campaign.id)
            .then((r: any) => Number(r?.queued ?? 0)).catch(() => 0);
        if (pushRemaining > 0) return;

        await this.campaigns.update(
            { id: campaign.id, status: CampaignStatus.SENDING },
            {
                status: CampaignStatus.COMPLETED,
                sendCompletedAt: new Date(),
                dispatchLeaseUntil: null,
                dispatchLeaseOwner: null,
            },
        );
        console.log(JSON.stringify({
            level: 'info', scope: 'comms_worker', event: 'campaign_completed',
            campaignId: campaign.id,
        }));
    }
}
