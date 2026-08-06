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

/**
 * Four states, and the difference between the middle two matters.
 *
 * healthy  — working.
 * warning  — working, but something will need attention. Nothing is failing.
 * degraded — reachable and failing, or reachable and not trustworthy.
 * offline  — unreachable, or not configured at all.
 *
 * `warning` exists so that "SMS has no provider, which is fine because SMS is
 * off" does not have to be reported in the same colour as "Postgres is down".
 * A screen where everything is amber is a screen nobody reads.
 */
export type HealthState = 'healthy' | 'warning' | 'degraded' | 'offline';

export interface ProviderHealth {
    name: string;
    state: HealthState;
    detail: string;
    /** Grouping for the dashboard: core infrastructure or a sending provider. */
    group?: 'infrastructure' | 'provider' | 'worker';
    /** True when this component is shared with operational traffic. */
    sharedWithOperational?: boolean;
}

export class CommunicationsDashboardService {
    /** Everything the dashboard shows, in one call. */
    static async snapshot() {
        const [queues, infrastructure, operational, campaigns, pauses] = await Promise.all([
            this.queues(),
            this.infrastructure(),
            OperationalPushHealth.health(),
            this.campaignCounts(),
            this.pauseStates(),
        ]);

        const readiness = this.systemReadiness({ infrastructure, operational, queues, pauses });

        return {
            generatedAt: new Date().toISOString(),
            queues,
            /* `providers` is kept as an alias so the existing dashboard section
             * keeps working; `infrastructure` is the same list, grouped. */
            providers: infrastructure,
            infrastructure,
            readiness,
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
     * Every piece of infrastructure the Centre depends on, and its state.
     *
     * Three of these — Redis, Postgres and Firebase — are shared with the
     * operational path, and are marked as such. That flag is the point of
     * putting them on a marketing screen at all: when Redis is down, the reason
     * a campaign is not sending is the same reason ride dispatch is struggling,
     * and an operator should not have to discover that on a second dashboard.
     *
     * `offline` means unreachable or unconfigured; `degraded` means reachable
     * and not trustworthy; `warning` means working but wanting attention. A
     * provider that is merely switched off is not reported as broken — those
     * need different actions.
     */
    static async infrastructure(): Promise<ProviderHealth[]> {
        const cfg = loadCommunicationsConfig();
        const out: ProviderHealth[] = [];

        // ── Core infrastructure, shared with operational traffic ────────
        out.push(await this.redisHealth());
        out.push(await this.postgresHealth());

        try {
            const configured = admin.apps.length > 0;
            out.push({
                name: 'Firebase (FCM)',
                group: 'infrastructure',
                sharedWithOperational: true,
                state: configured ? 'healthy' : 'offline',
                detail: configured
                    ? 'Credentials loaded. Shared by operational and marketing push.'
                    : 'No Firebase credentials — operational push is also affected.',
            });
        } catch {
            out.push({
                name: 'Firebase (FCM)', group: 'infrastructure', sharedWithOperational: true,
                state: 'offline', detail: 'Firebase Admin failed to initialise.',
            });
        }

        // ── Sending providers ───────────────────────────────────────────
        out.push({
            name: 'Email provider (Resend)',
            group: 'provider',
            sharedWithOperational: true,
            state: process.env.RESEND_API_KEY ? 'healthy' : 'offline',
            detail: process.env.RESEND_API_KEY
                ? `Configured. Sending from ${cfg.fromAddress}. Carries OTP and password resets.`
                : 'RESEND_API_KEY is not set — transactional email is also affected.',
        });

        out.push({
            name: 'SMS provider',
            group: 'provider',
            state: process.env.SMS_PROVIDER_API_KEY ? 'healthy' : 'warning',
            detail: process.env.SMS_PROVIDER_API_KEY
                ? 'Configured.'
                : 'No provider configured. SMS cannot send whatever its switch says — '
                  + 'expected, since SMS has not been commissioned.',
        });

        out.push(await this.webhookHealth());

        // ── Workers ─────────────────────────────────────────────────────
        out.push(await this.queueWorkerHealth());
        out.push(await this.retryWorkerHealth());

        return out;
    }

    private static async redisHealth(): Promise<ProviderHealth> {
        const startedAt = Date.now();
        try {
            const pong = await redis.ping();
            const ms = Date.now() - startedAt;
            if (String(pong).toUpperCase() !== 'PONG') {
                return {
                    name: 'Redis', group: 'infrastructure', sharedWithOperational: true,
                    state: 'degraded', detail: `Unexpected reply to PING: ${pong}`,
                };
            }
            return {
                name: 'Redis',
                group: 'infrastructure',
                sharedWithOperational: true,
                // Slow but answering is a warning, not a failure. Redis also
                // holds driver locations and dispatch state, so latency here is
                // worth surfacing before it becomes an outage.
                state: ms > 500 ? 'warning' : 'healthy',
                detail: ms > 500
                    ? `Answering, but slowly (${ms}ms). Also holds driver locations and dispatch state.`
                    : `PING in ${ms}ms. Also holds driver locations, presence and dispatch state.`,
            };
        } catch (err: any) {
            return {
                name: 'Redis', group: 'infrastructure', sharedWithOperational: true,
                state: 'offline',
                detail: `Unreachable: ${String(err?.message ?? err).slice(0, 120)}. `
                    + 'Dispatch and presence are affected too.',
            };
        }
    }

    private static async postgresHealth(): Promise<ProviderHealth> {
        const startedAt = Date.now();
        try {
            if (!AppDataSource.isInitialized) {
                return {
                    name: 'PostgreSQL', group: 'infrastructure', sharedWithOperational: true,
                    state: 'offline', detail: 'The data source is not initialised.',
                };
            }
            await AppDataSource.query('SELECT 1');
            const ms = Date.now() - startedAt;
            return {
                name: 'PostgreSQL',
                group: 'infrastructure',
                sharedWithOperational: true,
                state: ms > 1000 ? 'warning' : 'healthy',
                detail: ms > 1000
                    ? `Answering, but slowly (${ms}ms). Every ride, wallet and account lives here.`
                    : `SELECT 1 in ${ms}ms. Every ride, wallet and account lives here.`,
            };
        } catch (err: any) {
            return {
                name: 'PostgreSQL', group: 'infrastructure', sharedWithOperational: true,
                state: 'offline', detail: `Unreachable: ${String(err?.message ?? err).slice(0, 120)}`,
            };
        }
    }

    /**
     * Webhook health: configured, and actually receiving.
     *
     * Configured-but-silent is reported as a warning rather than healthy. A
     * signing secret that is set while no events have ever arrived usually
     * means the endpoint was never registered at the provider, or was
     * registered against the wrong URL — and the symptom of that is a delivery
     * report that stays empty and looks like nobody opened anything.
     */
    private static async webhookHealth(): Promise<ProviderHealth> {
        if (!process.env.RESEND_WEBHOOK_SECRET) {
            return {
                name: 'Webhooks', group: 'provider', state: 'offline',
                detail: 'No signing secret. Delivery events cannot be verified and are refused, '
                    + 'so bounces and complaints would go unrecorded.',
            };
        }
        try {
            const { EmailWebhookService } = await import('./email_webhook_service');
            const h = await EmailWebhookService.health();

            if (h.failed24h > 0) {
                return {
                    name: 'Webhooks', group: 'provider', state: 'degraded',
                    detail: `${h.failed24h} of ${h.last24h} events in the last 24h failed to process.`,
                };
            }
            if (!h.lastEventAt) {
                return {
                    name: 'Webhooks', group: 'provider', state: 'warning',
                    detail: 'Secret configured; no event has arrived yet. '
                        + 'Expected until the endpoint is registered at Resend and mail is sent.',
                };
            }
            return {
                name: 'Webhooks', group: 'provider', state: 'healthy',
                detail: `${h.last24h} event(s) in the last 24h. Signature verified on every one.`,
            };
        } catch (err: any) {
            return {
                name: 'Webhooks', group: 'provider', state: 'degraded',
                detail: `Cannot read webhook state: ${String(err?.message ?? err).slice(0, 120)}`,
            };
        }
    }

    private static async queueWorkerHealth(): Promise<ProviderHealth> {
        try {
            const beat = await redis.get('push:marketing:worker_beat');
            const age = beat ? Date.now() - Number(beat) : null;
            const sendingOff = !loadCommunicationsConfig().marketingPushEnabled;

            if (age == null) {
                return {
                    name: 'Queue workers', group: 'worker',
                    // Not running while sending is disabled is correct, not broken.
                    state: sendingOff ? 'healthy' : 'offline',
                    detail: sendingOff
                        ? 'Idle. Marketing sending is disabled, so there is nothing to run.'
                        : 'Has not run, but marketing push is enabled — the worker is not starting.',
                };
            }
            return {
                name: 'Queue workers', group: 'worker',
                state: age < 120_000 ? 'healthy' : 'degraded',
                detail: age < 120_000
                    ? `Last ran ${Math.round(age / 1000)}s ago.`
                    : `Last ran ${Math.round(age / 1000)}s ago — it should run at least every 2 minutes.`,
            };
        } catch {
            return { name: 'Queue workers', group: 'worker', state: 'offline', detail: 'Cannot read worker state.' };
        }
    }

    /**
     * The retry worker.
     *
     * Reported by the state of its work rather than by a heartbeat: what
     * matters is whether anything is stuck, not whether a loop is spinning.
     */
    private static async retryWorkerHealth(): Promise<ProviderHealth> {
        try {
            const repo = AppDataSource.getRepository(MarketingPushJob);
            const [retrying, exhausted, overdue] = await Promise.all([
                repo.createQueryBuilder('j')
                    .where('j.state = :s', { s: MarketingPushState.QUEUED })
                    .andWhere('j.attempts > 0').getCount(),
                repo.createQueryBuilder('j')
                    .where('j.state = :s', { s: MarketingPushState.FAILED }).getCount(),
                // Due more than ten minutes ago and still waiting: whatever is
                // meant to pick these up is not picking them up.
                repo.createQueryBuilder('j')
                    .where('j.state = :s', { s: MarketingPushState.QUEUED })
                    .andWhere('j.attempts > 0')
                    .andWhere('j."nextAttemptAt" < :t', { t: new Date(Date.now() - 600_000) })
                    .getCount(),
            ]);

            if (overdue > 0) {
                return {
                    name: 'Retry workers', group: 'worker', state: 'degraded',
                    detail: `${overdue} retry/retries are more than 10 minutes overdue.`,
                };
            }
            if (retrying > 0) {
                return {
                    name: 'Retry workers', group: 'worker', state: 'warning',
                    detail: `${retrying} message(s) awaiting retry; ${exhausted} gave up after the last attempt.`,
                };
            }
            return {
                name: 'Retry workers', group: 'worker', state: 'healthy',
                detail: exhausted === 0
                    ? 'Nothing awaiting retry and nothing exhausted.'
                    : `Nothing awaiting retry. ${exhausted} message(s) previously gave up.`,
            };
        } catch {
            return { name: 'Retry workers', group: 'worker', state: 'offline', detail: 'Cannot read the retry queue.' };
        }
    }

    /**
     * The one card to read before enabling marketing.
     *
     * ── Why it is deliberately hard to make green ────────────────────────
     * Each check answers "is this safe to switch on", not "is this working".
     * The last row is the odd one out: it reports whether sending is enabled,
     * which today is the thing that must be NO. It is included because an
     * operator needs to see the current position, not only the prerequisites —
     * and because after the switches are turned on, this card is where somebody
     * confirms it actually happened.
     */
    static systemReadiness(input: {
        infrastructure: ProviderHealth[];
        operational: { healthy: boolean; reasons: string[] };
        queues: any;
        pauses: Record<string, { paused: boolean }>;
    }) {
        const cfg = loadCommunicationsConfig();
        const find = (n: string) => input.infrastructure.find((p) => p.name === n);
        const ok = (n: string) => {
            const s = find(n)?.state;
            return s === 'healthy' || s === 'warning';
        };

        const anyChannelEnabled = cfg.marketingEmailEnabled || cfg.marketingPushEnabled
            || cfg.marketingInAppEnabled || cfg.marketingSmsEnabled;

        const checks = [
            {
                key: 'marketing_disabled',
                label: 'Marketing disabled',
                pass: !anyChannelEnabled,
                detail: anyChannelEnabled
                    ? 'At least one marketing channel is enabled — sending is possible.'
                    : 'All four channel switches are off. Nothing can send.',
            },
            {
                key: 'kill_switch_active',
                label: 'Kill switch active',
                // Either the switches are off, or the emergency stop is on.
                // Both mean the same thing to an operator: nothing goes out.
                pass: !anyChannelEnabled || Boolean(input.pauses.all?.paused),
                detail: !anyChannelEnabled
                    ? 'Kill switches default to off and remain off.'
                    : input.pauses.all?.paused
                        ? 'Channels are enabled but marketing is paused by the emergency stop.'
                        : 'Channels are enabled and not paused. Sending is live.',
            },
            {
                key: 'webhooks_configured',
                label: 'Webhooks configured',
                pass: ok('Webhooks'),
                detail: find('Webhooks')?.detail ?? 'Unknown.',
            },
            {
                key: 'queue_healthy',
                label: 'Queue healthy',
                pass: ok('Queue workers'),
                detail: find('Queue workers')?.detail ?? 'Unknown.',
            },
            {
                key: 'retry_worker_healthy',
                label: 'Retry worker healthy',
                pass: ok('Retry workers'),
                detail: find('Retry workers')?.detail ?? 'Unknown.',
            },
            {
                key: 'operational_healthy',
                label: 'Operational notifications healthy',
                pass: input.operational.healthy,
                detail: input.operational.healthy
                    ? 'Ride alerts, OTPs and receipts are sending normally.'
                    : input.operational.reasons.join(' '),
            },
        ];

        /*
         * Infrastructure is a prerequisite for all of the above, so a failure
         * here is reported as its own blocking row rather than being folded
         * into the check it happens to break first.
         */
        for (const name of ['Redis', 'PostgreSQL', 'Firebase (FCM)', 'Email provider (Resend)']) {
            const c = find(name);
            if (c && (c.state === 'offline' || c.state === 'degraded')) {
                checks.push({
                    key: `infra_${name.toLowerCase().replace(/\W+/g, '_')}`,
                    label: `${name} available`,
                    pass: false,
                    detail: c.detail,
                });
            }
        }

        return {
            checks,
            /** What is true right now, stated plainly rather than as a tick. */
            campaignSendingEnabled: anyChannelEnabled,
            /*
             * Ready does NOT mean "turn it on". It means the prerequisites are
             * met and enabling is a decision rather than a gamble. The
             * marketing-disabled and kill-switch rows are excluded from this
             * count, because they are the state being changed, not a condition
             * for changing it.
             */
            readyToEnable: checks
                .filter((c) => c.key !== 'marketing_disabled' && c.key !== 'kill_switch_active')
                .every((c) => c.pass),
            blockers: checks
                .filter((c) => c.key !== 'marketing_disabled' && c.key !== 'kill_switch_active')
                .filter((c) => !c.pass)
                .map((c) => c.label),
        };
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
