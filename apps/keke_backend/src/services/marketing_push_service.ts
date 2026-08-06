/**
 * Marketing push: its own queue, its own worker, its own limits, its own books.
 *
 * ── What is shared with operational push, and what is not ────────────────
 * Shared: the Firebase credentials, the FCM token registry, device
 * registration. Those are facts about KekeRide's relationship with Google and
 * about which phones exist — duplicating them would mean two token tables
 * disagreeing about which devices are real.
 *
 * NOT shared: the queue, the worker, the rate limit, the retry policy, the
 * reporting, the audit trail and the delivery metrics. Every one of those is
 * a place where marketing volume could delay, exhaust or misreport operational
 * traffic, so every one of them is separate.
 *
 * ── The yielding rule ────────────────────────────────────────────────────
 * Before every batch — not once per campaign — this asks whether operational
 * push is healthy. A degradation that begins halfway through a send stops the
 * remainder of it. Operational push never asks anything of this module and
 * cannot be paused by it.
 *
 * ── Nothing sends yet ────────────────────────────────────────────────────
 * `MARKETING_PUSH_SEND_ENABLED` defaults false and is checked at the top of
 * every batch. With it off, this enqueues, reports and yields — and delivers
 * nothing.
 */

import * as admin from 'firebase-admin';
import { In, IsNull, LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { MarketingPushJob, MarketingPushState } from '../models/MarketingPushJob';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import { MarketingConsentService } from './marketing_consent_service';
import { OperationalPushHealth } from './operational_push_health';
import { channelSendEnabled } from '../config/communications_config';
import { fcmPriority, androidChannel, NotificationPriority } from './notification_priority';

/** The kind every marketing push is classified as. Never anything else. */
const KIND = 'MARKETING_CAMPAIGN';

function num(name: string, fallback: number): number {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Marketing's own rate limits, deliberately conservative.
 *
 * Low enough that a campaign cannot consume the FCM capacity a surge of ride
 * alerts would need. Operational traffic has no limit at all — it is sent
 * inline, as fast as Firebase will take it.
 */
const RATE = {
    batchSize: () => num('MARKETING_PUSH_BATCH_SIZE', 100),
    perMinute: () => num('MARKETING_PUSH_PER_MINUTE', 600),
    maxAttempts: () => num('MARKETING_PUSH_MAX_ATTEMPTS', 3),
    /** 1st retry ~1min, 2nd ~5min, 3rd ~25min. */
    backoffBaseMs: () => num('MARKETING_PUSH_BACKOFF_MS', 60_000),
};

export interface BatchOutcome {
    ran: boolean;
    reason?: string;
    claimed: number;
    sent: number;
    failed: number;
    skipped: number;
    retryScheduled: number;
}

export class MarketingPushService {
    private static get jobs() { return AppDataSource.getRepository(MarketingPushJob); }

    /**
     * Queue a campaign's push recipients.
     *
     * Enqueuing is not sending: rows are created QUEUED and go nowhere until a
     * batch runs, which requires the kill switch to be on and operational push
     * to be healthy. The unique index makes a second enqueue of the same
     * campaign a no-op rather than a duplicate delivery.
     */
    static async enqueue(campaignId: string, userIds: string[]): Promise<{ queued: number; alreadyQueued: number }> {
        let queued = 0;
        let alreadyQueued = 0;

        for (const userId of userIds) {
            try {
                await this.jobs.insert(this.jobs.create({
                    campaignId, userId,
                    state: MarketingPushState.QUEUED,
                    nextAttemptAt: new Date(),
                }));
                queued += 1;
            } catch (err: any) {
                // 23505: already queued for this campaign. Exactly what the
                // unique index is for.
                if (String(err?.code) === '23505') alreadyQueued += 1;
                else throw err;
            }
        }
        return { queued, alreadyQueued };
    }

    /**
     * Run one batch.
     *
     * Every guard is checked here rather than once per campaign, because each
     * can change mid-send: the kill switch can be flipped, operational push can
     * degrade, and a passenger can withdraw consent between two batches.
     */
    static async runBatch(): Promise<BatchOutcome> {
        const empty: BatchOutcome = {
            ran: false, claimed: 0, sent: 0, failed: 0, skipped: 0, retryScheduled: 0,
        };

        // 1. The kill switch.
        if (!channelSendEnabled('push')) {
            return { ...empty, reason: 'Marketing push is disabled.' };
        }

        // 2. Operational health. Marketing yields; this is the whole point.
        const permission = await OperationalPushHealth.marketingMayRun();
        if (!permission.allowed) {
            return { ...empty, reason: permission.reason };
        }

        // 3. Marketing's own rate limit, independent of anything operational.
        const allowance = Math.min(RATE.batchSize(), Math.ceil(RATE.perMinute() / 6));
        const due = await this.jobs.find({
            where: { state: MarketingPushState.QUEUED, nextAttemptAt: LessThanOrEqual(new Date()) },
            order: { createdAt: 'ASC' },
            take: allowance,
        });
        if (due.length === 0) return { ...empty, ran: true, reason: 'Nothing due.' };

        const outcome: BatchOutcome = {
            ran: true, claimed: due.length, sent: 0, failed: 0, skipped: 0, retryScheduled: 0,
        };

        for (const job of due) {
            /*
             * Consent re-checked per recipient at the moment of sending, not
             * when the campaign was queued. Somebody who opts out while a
             * campaign is going out must not receive the rest of it.
             */
            const eligibility = await MarketingConsentService.checkChannelEligibility(
                job.userId, 'push', 'promotionalOffers', 'present');
            if (!eligibility.eligible) {
                job.state = MarketingPushState.SKIPPED;
                job.skipReason = eligibility.reason ?? 'ineligible';
                await this.jobs.save(job);
                outcome.skipped += 1;
                continue;
            }

            const tokens = await this.tokensFor(job.userId);
            if (tokens.length === 0) {
                job.state = MarketingPushState.SKIPPED;
                job.skipReason = 'no_device';
                await this.jobs.save(job);
                outcome.skipped += 1;
                continue;
            }

            const content = await this.contentFor(job.campaignId);
            if (!content) {
                job.state = MarketingPushState.SKIPPED;
                job.skipReason = 'no_content';
                await this.jobs.save(job);
                outcome.skipped += 1;
                continue;
            }

            try {
                const response = await admin.messaging().sendEachForMulticast({
                    tokens,
                    notification: { title: content.title, body: content.body },
                    data: {
                        ...(content.deepLink ? { deep_link: content.deepLink } : {}),
                        campaign_id: job.campaignId,
                        // Marked so the app can route it and so delivery
                        // reporting never mixes with operational metrics.
                        notification_kind: KIND,
                        click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    },
                    android: {
                        // NORMAL, not high. A promotion must never wake a phone
                        // the way a waiting passenger does.
                        priority: fcmPriority(KIND),
                        notification: { channelId: androidChannel(KIND) },
                    },
                    apns: {
                        headers: { 'apns-priority': '5' },
                        // No sound and no badge: a promotion is not an event.
                        payload: { aps: { 'content-available': 1 } as any },
                    },
                });

                if (response.successCount > 0) {
                    job.state = MarketingPushState.SENT;
                    job.sentAt = new Date();
                    job.providerMessageId = response.responses.find((r) => r.success)?.messageId ?? null;
                    outcome.sent += 1;
                } else {
                    this.scheduleRetryOrFail(job, response.responses[0]?.error?.message ?? 'no_success', outcome);
                }

                await this.deactivateDeadTokens(response, tokens);
                await this.jobs.save(job);
            } catch (err: any) {
                this.scheduleRetryOrFail(job, String(err?.message ?? err), outcome);
                await this.jobs.save(job);
            }
        }

        return outcome;
    }

    /**
     * Retry with exponential backoff, or give up.
     *
     * Marketing's own policy, and deliberately shallow: three attempts, then
     * the row is closed. A promotion that has failed three times is not worth
     * the capacity a fourth would consume.
     */
    private static scheduleRetryOrFail(job: MarketingPushJob, error: string, outcome: BatchOutcome): void {
        job.attempts += 1;
        job.error = error.slice(0, 300);

        if (job.attempts >= RATE.maxAttempts()) {
            job.state = MarketingPushState.FAILED;
            outcome.failed += 1;
            return;
        }
        job.state = MarketingPushState.QUEUED;
        job.nextAttemptAt = new Date(Date.now() + RATE.backoffBaseMs() * Math.pow(5, job.attempts - 1));
        outcome.retryScheduled += 1;
    }

    /**
     * The SHARED token registry, read-only from here.
     *
     * Marketing reads which devices exist; it does not decide. The one write it
     * makes is deactivating a token FCM has told us is dead, which is a fact
     * about the device rather than about marketing — and leaving it active
     * would make operational sends fail too.
     */
    private static async tokensFor(userId: string): Promise<string[]> {
        const rows = await AppDataSource.getRepository(DeviceToken).find({
            where: { userId, role: UserRole.PASSENGER, isActive: true },
            select: ['token'],
        });
        return rows.map((r) => r.token);
    }

    private static async deactivateDeadTokens(
        response: admin.messaging.BatchResponse, tokens: string[],
    ): Promise<void> {
        const dead: string[] = [];
        response.responses.forEach((r, i) => {
            const code = r.error?.code;
            if (code === 'messaging/invalid-registration-token'
                || code === 'messaging/registration-token-not-registered') {
                dead.push(tokens[i]);
            }
        });
        if (dead.length) {
            await AppDataSource.getRepository(DeviceToken)
                .update({ token: In(dead) }, { isActive: false });
        }
    }

    private static async contentFor(campaignId: string): Promise<{
        title: string; body: string; deepLink?: string | null;
    } | null> {
        const { MultiChannelCampaignService } = await import('./multichannel_campaign_service');
        const channels = await MultiChannelCampaignService.channelsFor(campaignId);
        const push = channels.find((c) => c.channel === 'push' && c.enabled);
        if (!push) return null;

        const content = push.content as any;
        if (!content?.title || !content?.body) return null;
        return { title: String(content.title), body: String(content.body), deepLink: content.deepLink ?? null };
    }

    /** Marketing's own delivery metrics. Never mixed with operational ones. */
    static async report(campaignId: string) {
        const rows = await this.jobs.find({ where: { campaignId } });
        const by = (s: MarketingPushState) => rows.filter((r) => r.state === s).length;

        const skipReasons: Record<string, number> = {};
        for (const r of rows.filter((x) => x.state === MarketingPushState.SKIPPED)) {
            const k = r.skipReason ?? 'unknown';
            skipReasons[k] = (skipReasons[k] ?? 0) + 1;
        }

        return {
            queued: by(MarketingPushState.QUEUED),
            sending: by(MarketingPushState.SENDING),
            // "Sent" means FCM accepted it. Delivery to the handset is not
            // something FCM reports, and claiming otherwise would be a lie the
            // reporting screen repeats.
            sent: by(MarketingPushState.SENT),
            failed: by(MarketingPushState.FAILED),
            skipped: by(MarketingPushState.SKIPPED),
            opened: rows.filter((r) => r.openedAt != null).length,
            skipReasons,
            total: rows.length,
        };
    }

    /** Abandon a campaign's remaining queue. Sent rows are left alone. */
    static async stop(campaignId: string, reason: string): Promise<number> {
        const result = await this.jobs.update(
            { campaignId, state: MarketingPushState.QUEUED },
            { state: MarketingPushState.SKIPPED, skipReason: reason.slice(0, 60) },
        );
        return result.affected ?? 0;
    }

    /** Recorded when the app reports a marketing notification was opened. */
    static async recordOpen(campaignId: string, userId: string): Promise<void> {
        await this.jobs.update(
            { campaignId, userId, openedAt: IsNull() },
            { openedAt: new Date() },
        );
    }
}
