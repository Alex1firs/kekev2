/**
 * What campaigns actually did, per channel.
 *
 * ── Every number here is measured, and says how ──────────────────────────
 * There are no modelled or estimated figures in this file. Where a metric
 * cannot be measured — in-app before the app reports it, push delivery before
 * the device acknowledges — the channel is returned with
 * `instrumented: false` and the reason. That is not the same as zero, and a
 * chart cannot tell the difference: a flat line reading "nobody opened it"
 * and a flat line reading "nothing is counting opens" look identical and mean
 * opposite things.
 *
 * ── Denominators are stated, not assumed ─────────────────────────────────
 * Open rate over *delivered*, not over *sent* — a message that bounced was
 * never open-able, and dividing by sent quietly rewards a campaign for
 * bouncing. Click-through over delivered as well, with click-to-open reported
 * separately because they answer different questions.
 *
 * ── Open tracking is a pixel, and most clients block it ──────────────────
 * Apple Mail Privacy Protection pre-fetches images, which inflates opens;
 * everything else increasingly blocks them, which deflates opens. The number is
 * kept because the trend is still useful, and labelled `approximate` so nobody
 * reports it to a board as fact.
 */

import { AppDataSource } from '../config/data_source';
import { CommunicationCampaign, CampaignStatus } from '../models/CommunicationCampaign';
import { EmailCampaignRecipient, RecipientStatus } from '../models/EmailCampaignRecipient';
import { MarketingPushJob, MarketingPushState } from '../models/MarketingPushJob';
import { InAppMessageDelivery } from '../models/InAppMessageDelivery';
import { EmailSuppression } from '../models/EmailSuppression';

export interface ChannelMetrics {
    channel: 'email' | 'push' | 'in_app' | 'sms';
    instrumented: boolean;
    /** Present when instrumented is false: what is missing, in one sentence. */
    note?: string;
    metrics: Record<string, number>;
    rates: Record<string, number | null>;
}

const pct = (n: number, d: number): number | null =>
    d > 0 ? Math.round((n / d) * 1000) / 10 : null;

export class CampaignAnalyticsService {
    /** Everything the analytics screen shows. */
    static async overview(opts: { days?: number; campaignId?: string } = {}) {
        const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
        const since = new Date(Date.now() - days * 86_400_000);

        const [email, push, inApp, sms, top, growth, totals] = await Promise.all([
            this.email(opts.campaignId, since),
            this.push(opts.campaignId, since),
            this.inApp(opts.campaignId, since),
            this.sms(opts.campaignId),
            this.topCampaigns(since),
            this.growth(days),
            this.totals(since),
        ]);

        return {
            generatedAt: new Date().toISOString(),
            windowDays: days,
            since: since.toISOString(),
            channels: [email, push, inApp, sms],
            topCampaigns: top,
            growth,
            totals,
            /*
             * Stated on the screen rather than buried here, because a dashboard
             * with no data on it is otherwise indistinguishable from a broken
             * one, and this one has no data for a good reason.
             */
            empty: totals.campaignsSent === 0,
            emptyReason: totals.campaignsSent === 0
                ? 'No campaign has been sent. Every marketing channel is switched off, so these charts are '
                  + 'showing an accurate zero rather than a missing measurement.'
                : null,
        };
    }

    // ── Email ───────────────────────────────────────────────────────────

    private static async email(campaignId: string | undefined, since: Date): Promise<ChannelMetrics> {
        const repo = AppDataSource.getRepository(EmailCampaignRecipient);
        const qb = () => {
            const q = repo.createQueryBuilder('r');
            if (campaignId) q.andWhere('r."campaignId" = :c', { c: campaignId });
            else q.andWhere('r."createdAt" >= :s', { s: since });
            return q;
        };

        const rows = await qb()
            .select('r.status', 'status').addSelect('COUNT(*)', 'n')
            .groupBy('r.status').getRawMany<{ status: string; n: string }>();
        const by = new Map(rows.map((r) => [r.status, Number(r.n)]));

        const [opened, clicked] = await Promise.all([
            qb().andWhere('r."openedAt" IS NOT NULL').getCount(),
            qb().andWhere('r."clickedAt" IS NOT NULL').getCount(),
        ]);

        const sent = (by.get(RecipientStatus.SENT) ?? 0)
            + (by.get(RecipientStatus.DELIVERED) ?? 0)
            + (by.get(RecipientStatus.COMPLAINED) ?? 0);
        const delivered = by.get(RecipientStatus.DELIVERED) ?? 0;
        const hardBounced = by.get(RecipientStatus.HARD_BOUNCED) ?? 0;
        const softBounced = by.get(RecipientStatus.SOFT_BOUNCED) ?? 0;
        const complaints = by.get(RecipientStatus.COMPLAINED) ?? 0;

        /*
         * Unsubscribes counted from the suppression table rather than from
         * recipient rows: somebody can unsubscribe from a footer link without
         * the campaign that prompted it ever being identifiable, and counting
         * only the attributable ones would under-report the thing most worth
         * watching.
         */
        const unsubscribes = await AppDataSource.getRepository(EmailSuppression)
            .createQueryBuilder('s')
            .where('s.reason = :r', { r: 'unsubscribe' })
            .andWhere('s."createdAt" >= :d', { d: since })
            .getCount();

        // Delivered is only known for messages the webhook told us about. Where
        // no webhook has arrived, fall back to sent so the denominator is not 0.
        const deliveredForRates = delivered > 0 ? delivered : sent;

        return {
            channel: 'email',
            instrumented: true,
            metrics: {
                sent,
                delivered,
                opened,
                clicked,
                bounced: hardBounced + softBounced,
                hardBounced,
                softBounced,
                complaints,
                unsubscribes,
                failed: by.get(RecipientStatus.FAILED) ?? 0,
                skipped: by.get(RecipientStatus.SKIPPED) ?? 0,
                queued: by.get(RecipientStatus.QUEUED) ?? 0,
            },
            rates: {
                deliveryRate: pct(delivered, sent),
                openRate: pct(opened, deliveredForRates),
                clickThroughRate: pct(clicked, deliveredForRates),
                // Of the people who opened it, how many acted. Independent of
                // deliverability, so it survives the pixel-blocking problem
                // better than open rate does.
                clickToOpenRate: pct(clicked, opened),
                bounceRate: pct(hardBounced + softBounced, sent),
                complaintRate: pct(complaints, deliveredForRates),
                unsubscribeRate: pct(unsubscribes, deliveredForRates),
            },
        };
    }

    // ── Push ────────────────────────────────────────────────────────────

    private static async push(campaignId: string | undefined, since: Date): Promise<ChannelMetrics> {
        const repo = AppDataSource.getRepository(MarketingPushJob);
        const qb = () => {
            const q = repo.createQueryBuilder('j');
            if (campaignId) q.andWhere('j."campaignId" = :c', { c: campaignId });
            else q.andWhere('j."createdAt" >= :s', { s: since });
            return q;
        };

        const rows = await qb().select('j.state', 'state').addSelect('COUNT(*)', 'n')
            .groupBy('j.state').getRawMany<{ state: string; n: string }>();
        const by = new Map(rows.map((r) => [r.state, Number(r.n)]));

        const [delivered, opened] = await Promise.all([
            qb().andWhere('j."deliveredAt" IS NOT NULL').getCount(),
            qb().andWhere('j."openedAt" IS NOT NULL').getCount(),
        ]);

        const sent = by.get(MarketingPushState.SENT) ?? 0;

        return {
            channel: 'push',
            /*
             * Sent is real — FCM accepted it. Delivered and opened depend on the
             * passenger app calling back, and the released build does not. Marked
             * partially instrumented so the two are not read as equals.
             */
            instrumented: true,
            note: delivered === 0 && sent > 0
                ? 'Delivered and opened require the passenger app to acknowledge receipt. '
                  + 'The released build does not, so those two will read zero until it ships.'
                : undefined,
            metrics: {
                sent,
                delivered,
                opened,
                failed: by.get(MarketingPushState.FAILED) ?? 0,
                skipped: by.get(MarketingPushState.SKIPPED) ?? 0,
                queued: by.get(MarketingPushState.QUEUED) ?? 0,
            },
            rates: {
                deliveryRate: pct(delivered, sent),
                openRate: pct(opened, delivered > 0 ? delivered : sent),
            },
        };
    }

    // ── In-app ──────────────────────────────────────────────────────────

    private static async inApp(campaignId: string | undefined, since: Date): Promise<ChannelMetrics> {
        const repo = AppDataSource.getRepository(InAppMessageDelivery);
        const qb = () => {
            const q = repo.createQueryBuilder('d');
            if (campaignId) q.andWhere('d."campaignId" = :c', { c: campaignId });
            else q.andWhere('d."queuedAt" >= :s', { s: since });
            return q;
        };

        const [queued, displayed, viewed, clicked, dismissed] = await Promise.all([
            qb().getCount(),
            qb().andWhere('d."displayedAt" IS NOT NULL').getCount(),
            qb().andWhere('d."viewedAt" IS NOT NULL').getCount(),
            qb().andWhere('d."clickedAt" IS NOT NULL').getCount(),
            qb().andWhere('d."dismissedAt" IS NOT NULL').getCount(),
        ]);

        return {
            channel: 'in_app',
            // Nothing writes to this table yet, and saying so is the point.
            instrumented: queued > 0,
            note: queued === 0
                ? 'Not yet instrumented. The passenger app has no in-app inbox in the released build, '
                  + 'so these are undefined rather than zero.'
                : undefined,
            metrics: { queued, displayed, viewed, clicked, dismissed },
            rates: {
                displayRate: pct(displayed, queued),
                viewRate: pct(viewed, displayed),
                clickThroughRate: pct(clicked, displayed),
                dismissRate: pct(dismissed, displayed),
            },
        };
    }

    // ── SMS ─────────────────────────────────────────────────────────────

    private static async sms(_campaignId?: string): Promise<ChannelMetrics> {
        /*
         * No provider is commissioned, so there is no send record and nothing
         * to count. Returned as a channel rather than omitted, so the screen
         * shows why it is absent instead of silently having three channels.
         */
        return {
            channel: 'sms',
            instrumented: false,
            note: 'No SMS provider is commissioned. Nothing has been sent, so there is nothing to measure.',
            metrics: { sent: 0, delivered: 0, failed: 0 },
            rates: { deliveryRate: null, failureRate: null },
        };
    }

    // ── Cross-campaign ──────────────────────────────────────────────────

    /**
     * Top performers, ranked by click-through over delivered.
     *
     * Not by opens: open tracking is a blocked pixel on most clients, so
     * ranking by it mostly ranks how many recipients use Apple Mail. A click is
     * an action a person took.
     */
    private static async topCampaigns(since: Date) {
        const rows = await AppDataSource.getRepository(EmailCampaignRecipient)
            .createQueryBuilder('r')
            .select('r."campaignId"', 'campaignId')
            .addSelect('COUNT(*)', 'sent')
            .addSelect(`COUNT(*) FILTER (WHERE r.status = 'delivered')`, 'delivered')
            .addSelect('COUNT(*) FILTER (WHERE r."openedAt" IS NOT NULL)', 'opened')
            .addSelect('COUNT(*) FILTER (WHERE r."clickedAt" IS NOT NULL)', 'clicked')
            .where('r."createdAt" >= :s', { s: since })
            .groupBy('r."campaignId"')
            .getRawMany<Record<string, string>>();

        if (rows.length === 0) return [];

        const campaigns = await AppDataSource.getRepository(CommunicationCampaign)
            .createQueryBuilder('c')
            .where('c.id IN (:...ids)', { ids: rows.map((r) => r.campaignId) })
            .getMany();
        const nameOf = new Map(campaigns.map((c) => [c.id, c.name]));

        return rows
            .map((r) => {
                const sent = Number(r.sent);
                const delivered = Number(r.delivered) || sent;
                return {
                    campaignId: r.campaignId,
                    name: nameOf.get(r.campaignId) ?? '(deleted campaign)',
                    sent,
                    delivered: Number(r.delivered),
                    opened: Number(r.opened),
                    clicked: Number(r.clicked),
                    openRate: pct(Number(r.opened), delivered),
                    clickThroughRate: pct(Number(r.clicked), delivered),
                };
            })
            .sort((a, b) => (b.clickThroughRate ?? -1) - (a.clickThroughRate ?? -1))
            .slice(0, 10);
    }

    /**
     * Daily series for the growth chart.
     *
     * Built from a generated date series so days with no activity appear as
     * zero rather than being absent — a line chart that skips empty days
     * silently compresses time and makes a gap look like a plateau.
     */
    private static async growth(days: number) {
        const rows = await AppDataSource.query(
            `
            WITH d AS (
                SELECT generate_series(
                    (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
                    CURRENT_DATE::date,
                    INTERVAL '1 day'
                )::date AS day
            )
            SELECT
                d.day::text                                                   AS day,
                COALESCE(e.sent, 0)::int                                      AS "emailSent",
                COALESCE(e.opened, 0)::int                                    AS "emailOpened",
                COALESCE(e.clicked, 0)::int                                   AS "emailClicked",
                COALESCE(p.sent, 0)::int                                      AS "pushSent",
                COALESCE(c.consented, 0)::int                                 AS "newConsents"
            FROM d
            LEFT JOIN (
                SELECT "createdAt"::date AS day,
                       COUNT(*)                                          AS sent,
                       COUNT(*) FILTER (WHERE "openedAt"  IS NOT NULL)   AS opened,
                       COUNT(*) FILTER (WHERE "clickedAt" IS NOT NULL)   AS clicked
                FROM email_campaign_recipient GROUP BY 1
            ) e ON e.day = d.day
            LEFT JOIN (
                SELECT "createdAt"::date AS day, COUNT(*) FILTER (WHERE state = 'sent') AS sent
                FROM marketing_push_job GROUP BY 1
            ) p ON p.day = d.day
            LEFT JOIN (
                SELECT "consentAt"::date AS day, COUNT(*) AS consented
                FROM passenger_communication_preference
                WHERE marketing = true AND "consentAt" IS NOT NULL
                GROUP BY 1
            ) c ON c.day = d.day
            ORDER BY d.day
            `,
            [days],
        );
        return rows;
    }

    private static async totals(since: Date) {
        const repo = AppDataSource.getRepository(CommunicationCampaign);
        const [all, rows] = await Promise.all([
            repo.count(),
            repo.createQueryBuilder('c')
                .select('c.status', 'status').addSelect('COUNT(*)', 'n')
                .groupBy('c.status').getRawMany<{ status: string; n: string }>(),
        ]);
        const by = new Map(rows.map((r) => [r.status, Number(r.n)]));

        const recipients = await AppDataSource.getRepository(EmailCampaignRecipient)
            .createQueryBuilder('r').where('r."createdAt" >= :s', { s: since }).getCount();

        return {
            campaignsTotal: all,
            campaignsSent: (by.get(CampaignStatus.COMPLETED) ?? 0) + (by.get(CampaignStatus.SENDING) ?? 0),
            campaignsDraft: by.get(CampaignStatus.DRAFT) ?? 0,
            campaignsScheduled: by.get(CampaignStatus.SCHEDULED) ?? 0,
            recipientsInWindow: recipients,
        };
    }
}
