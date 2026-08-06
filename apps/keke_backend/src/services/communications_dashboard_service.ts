/**
 * The global view: both queues, every channel, every provider, live.
 *
 * ── Why operational and marketing are reported side by side ──────────────
 * They are separate systems, and the screen exists to make that visible rather
 * than to blur it. Somebody watching a campaign go out needs to see, in the
 * same glance, that ride alerts are unaffected — and if they are not, that
 * marketing has already stood down.
 *
 * ── Read-only, except for the emergency controls ─────────────────────────
 * Nothing here sends. The pause controls are the one exception, and they can
 * only ever stop things: there is no method on this class that starts a send,
 * and operational notifications cannot be paused from here at all.
 */

import { AppDataSource } from '../config/data_source';
import { MarketingPushJob, MarketingPushState } from '../models/MarketingPushJob';
import { EmailCampaignRecipient, RecipientStatus } from '../models/EmailCampaignRecipient';
import { CommunicationCampaign, CampaignStatus } from '../models/CommunicationCampaign';
import { OperationalPushHealth } from './operational_push_health';
import { loadCommunicationsConfig, channelBlockers } from '../config/communications_config';
import { redis } from '../config/redis';
import * as admin from 'firebase-admin';

export type HealthState = 'healthy' | 'degraded' | 'offline';

export interface ProviderHealth {
    name: string;
    state: HealthState;
    detail: string;
}

export class CommunicationsDashboardService {
    /** Everything the dashboard shows, in one call. */
    static async snapshot() {
        const [queues, providers, operational, campaigns, pauses] = await Promise.all([
            this.queues(),
            this.providers(),
            OperationalPushHealth.health(),
            this.campaignCounts(),
            this.pauseStates(),
        ]);

        return {
            generatedAt: new Date().toISOString(),
            queues,
            providers,
            operational: {
                /*
                 * Operational throughput, from the same rolling window the
                 * yielding decision uses — so the number on screen is the
                 * number marketing is actually reacting to.
                 */
                attempts: operational.attempts,
                failures: operational.failures,
                failureRatePct: Math.round(operational.failureRate * 100),
                medianLatencyMs: operational.avgLatencyMs,
                healthy: operational.healthy,
                reasons: operational.reasons,
                // Stated explicitly, because the screen offers pause buttons and
                // none of them may touch this.
                pausable: false,
            },
            campaigns,
            pauses,
            channels: this.channelStates(),
        };
    }

    /**
     * The two queues, reported separately and labelled as independent.
     *
     * Operational has no queue at all — it sends inline, because a ride alert
     * that waits is a ride alert that arrives too late. That is a fact worth
     * showing rather than an omission to explain.
     */
    private static async queues() {
        const push = AppDataSource.getRepository(MarketingPushJob);
        const email = AppDataSource.getRepository(EmailCampaignRecipient);

        const [pushRows, emailRows] = await Promise.all([
            push.createQueryBuilder('j')
                .select('j.state', 'state').addSelect('COUNT(*)', 'n')
                .groupBy('j.state').getRawMany<{ state: string; n: string }>(),
            email.createQueryBuilder('r')
                .select('r.status', 'status').addSelect('COUNT(*)', 'n')
                .groupBy('r.status').getRawMany<{ status: string; n: string }>(),
        ]);

        const pushBy = new Map(pushRows.map((r) => [r.state, Number(r.n)]));
        const emailBy = new Map(emailRows.map((r) => [r.status, Number(r.n)]));

        const retrying = await push.createQueryBuilder('j')
            .where('j.state = :s', { s: MarketingPushState.QUEUED })
            .andWhere('j.attempts > 0')
            .getCount();

        const marketingWaiting = (pushBy.get(MarketingPushState.QUEUED) ?? 0)
            + (emailBy.get(RecipientStatus.QUEUED) ?? 0);
        const marketingSent = (pushBy.get(MarketingPushState.SENT) ?? 0)
            + (emailBy.get(RecipientStatus.SENT) ?? 0);
        const marketingFailed = (pushBy.get(MarketingPushState.FAILED) ?? 0)
            + (emailBy.get(RecipientStatus.FAILED) ?? 0);
        const marketingProcessing = (pushBy.get(MarketingPushState.SENDING) ?? 0);

        const attempted = marketingSent + marketingFailed;

        return {
            operational: {
                label: 'Operational',
                // Inline delivery: there is nothing to queue.
                mechanism: 'inline',
                depth: 0,
                waiting: 0,
                processing: 0,
                note: 'Sent immediately. Operational notifications are never queued or throttled.',
            },
            marketing: {
                label: 'Marketing',
                mechanism: 'queued',
                depth: marketingWaiting + marketingProcessing,
                waiting: marketingWaiting,
                processing: marketingProcessing,
                sent: marketingSent,
                failed: marketingFailed,
                skipped: (pushBy.get(MarketingPushState.SKIPPED) ?? 0)
                    + (emailBy.get(RecipientStatus.SKIPPED) ?? 0),
                retrying,
                successRatePct: attempted === 0 ? null : Math.round((marketingSent / attempted) * 100),
                failureRatePct: attempted === 0 ? null : Math.round((marketingFailed / attempted) * 100),
                byChannel: {
                    push: {
                        waiting: pushBy.get(MarketingPushState.QUEUED) ?? 0,
                        sent: pushBy.get(MarketingPushState.SENT) ?? 0,
                        failed: pushBy.get(MarketingPushState.FAILED) ?? 0,
                    },
                    email: {
                        waiting: emailBy.get(RecipientStatus.QUEUED) ?? 0,
                        sent: emailBy.get(RecipientStatus.SENT) ?? 0,
                        failed: emailBy.get(RecipientStatus.FAILED) ?? 0,
                    },
                },
            },
            // The point of the screen, said in words as well as layout.
            independent: true,
        };
    }

    /**
     * Provider and worker health.
     *
     * `offline` means unreachable or unconfigured; `degraded` means reachable
     * but not trustworthy. A provider that is merely switched off is reported
     * as healthy-but-disabled rather than broken — those need different actions.
     */
    private static async providers(): Promise<ProviderHealth[]> {
        const cfg = loadCommunicationsConfig();
        const out: ProviderHealth[] = [];

        // Firebase: shared by both systems, so its state matters to both.
        try {
            const configured = admin.apps.length > 0;
            out.push({
                name: 'Firebase (FCM)',
                state: configured ? 'healthy' : 'offline',
                detail: configured
                    ? 'Credentials loaded. Shared by operational and marketing push.'
                    : 'No Firebase credentials — operational push is also affected.',
            });
        } catch {
            out.push({ name: 'Firebase (FCM)', state: 'offline', detail: 'Firebase Admin failed to initialise.' });
        }

        out.push({
            name: 'Email provider (Resend)',
            state: process.env.RESEND_API_KEY ? 'healthy' : 'offline',
            detail: process.env.RESEND_API_KEY
                ? `Configured. Sending from ${cfg.fromAddress}. Carries OTP and password resets.`
                : 'RESEND_API_KEY is not set — transactional email is also affected.',
        });

        out.push({
            name: 'SMS provider',
            state: process.env.SMS_PROVIDER_API_KEY ? 'healthy' : 'offline',
            detail: process.env.SMS_PROVIDER_API_KEY
                ? 'Configured.'
                : 'No provider configured. SMS cannot send whatever its switch says.',
        });

        // Marketing worker: has it run recently?
        try {
            const beat = await redis.get('push:marketing:worker_beat');
            const age = beat ? Date.now() - Number(beat) : null;
            out.push({
                name: 'Marketing queue worker',
                state: age == null ? 'offline' : age < 120_000 ? 'healthy' : 'degraded',
                detail: age == null
                    ? 'Has not run. Marketing sending is disabled, so this is expected.'
                    : `Last ran ${Math.round(age / 1000)}s ago.`,
            });
        } catch {
            out.push({ name: 'Marketing queue worker', state: 'offline', detail: 'Cannot read worker state.' });
        }

        const retrying = await AppDataSource.getRepository(MarketingPushJob)
            .createQueryBuilder('j')
            .where('j.state = :s', { s: MarketingPushState.QUEUED })
            .andWhere('j.attempts > 0').getCount();
        out.push({
            name: 'Retry queue',
            state: 'healthy',
            detail: retrying === 0 ? 'Nothing awaiting retry.' : `${retrying} message(s) awaiting retry.`,
        });

        out.push({
            name: 'Webhooks',
            state: process.env.RESEND_WEBHOOK_SECRET ? 'healthy' : 'degraded',
            detail: process.env.RESEND_WEBHOOK_SECRET
                ? 'Signing secret configured; events are verified.'
                : 'No signing secret — delivery events cannot be verified and are refused.',
        });

        return out;
    }

    private static async campaignCounts() {
        const rows = await AppDataSource.getRepository(CommunicationCampaign)
            .createQueryBuilder('c')
            .select('c.status', 'status').addSelect('COUNT(*)', 'n')
            .groupBy('c.status').getRawMany<{ status: string; n: string }>();
        const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
        return {
            draft: by.get(CampaignStatus.DRAFT) ?? 0,
            awaitingApproval: by.get(CampaignStatus.AWAITING_APPROVAL) ?? 0,
            approved: by.get(CampaignStatus.APPROVED) ?? 0,
            scheduled: by.get(CampaignStatus.SCHEDULED) ?? 0,
            sending: by.get(CampaignStatus.SENDING) ?? 0,
        };
    }

    private static channelStates() {
        const cfg = loadCommunicationsConfig();
        const blockers = channelBlockers();
        return {
            email: { enabled: cfg.marketingEmailEnabled, blockers: blockers.email },
            push: { enabled: cfg.marketingPushEnabled, blockers: blockers.push },
            in_app: { enabled: cfg.marketingInAppEnabled, blockers: blockers.in_app },
            sms: { enabled: cfg.marketingSmsEnabled, blockers: blockers.sms },
        };
    }

    // ── Emergency controls ──────────────────────────────────────────────

    private static pauseKey(channel: string) { return `comms:pause:${channel}`; }

    /**
     * Pause a marketing channel, or all of them.
     *
     * ── What cannot be paused ───────────────────────────────────────────
     * Operational notifications. There is no channel name this accepts that
     * would stop a ride alert, an OTP or an SOS — the allow-list below is the
     * whole set, and it contains only marketing channels. A screen with a big
     * red button must not be one keystroke away from silencing the thing that
     * tells a passenger their driver has arrived.
     *
     * Takes effect immediately: the pause is read before every batch, not
     * cached at campaign start.
     */
    static async pause(channel: 'all' | 'email' | 'push' | 'in_app' | 'sms', reason: string, staffId: string) {
        const allowed = ['all', 'email', 'push', 'in_app', 'sms'];
        if (!allowed.includes(channel)) {
            throw new Error(`Unknown channel: ${channel}. Operational notifications cannot be paused.`);
        }
        const payload = JSON.stringify({ reason: reason || 'paused', by: staffId, at: new Date().toISOString() });
        await redis.set(this.pauseKey(channel), payload);
        if (channel === 'all' || channel === 'push') {
            await OperationalPushHealth.pauseMarketing(reason || 'paused by operations');
        }
        return { channel, paused: true };
    }

    static async resume(channel: 'all' | 'email' | 'push' | 'in_app' | 'sms') {
        await redis.del(this.pauseKey(channel));
        if (channel === 'all') {
            for (const c of ['email', 'push', 'in_app', 'sms']) await redis.del(this.pauseKey(c));
        }
        if (channel === 'all' || channel === 'push') {
            await OperationalPushHealth.resumeMarketing();
        }
        return { channel, paused: false };
    }

    static async pauseStates(): Promise<Record<string, { paused: boolean; reason?: string; by?: string; at?: string }>> {
        const out: Record<string, any> = {};
        for (const c of ['all', 'email', 'push', 'in_app', 'sms']) {
            try {
                const raw = await redis.get(this.pauseKey(c));
                out[c] = raw ? { paused: true, ...JSON.parse(raw) } : { paused: false };
            } catch {
                /*
                 * Cannot read it. Reported as unknown rather than running, so
                 * the screen never shows "sending" for a channel the sender is
                 * simultaneously refusing to run — channelPaused() fails closed.
                 */
                out[c] = { paused: false, unknown: true };
            }
        }
        return out;
    }

    /** Whether a marketing channel may run. Consulted before every batch. */
    static async channelPaused(channel: string): Promise<boolean> {
        try {
            const [all, one] = await Promise.all([
                redis.get(this.pauseKey('all')),
                redis.get(this.pauseKey(channel)),
            ]);
            return Boolean(all || one);
        } catch {
            // Cannot read the pause state: assume paused. A marketing message
            // not sent costs nothing; one sent during an emergency stop costs
            // the trust the button was meant to protect.
            return true;
        }
    }
}
