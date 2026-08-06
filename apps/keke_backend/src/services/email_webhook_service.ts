/**
 * What the email provider tells us afterwards, and what we do about it.
 *
 * ── This is a bystander, not a participant ───────────────────────────────
 * Nothing in this file is on the sending path. It runs when Resend calls us,
 * minutes or hours after a message left, and every method is written on the
 * assumption that it may fail without anybody noticing at the time. The route
 * acknowledges before processing for exactly that reason: a bug in here must
 * not make the provider think delivery failed, must not make it retry
 * indefinitely, and above all must not touch the transactional path that
 * carries OTPs and password resets.
 *
 * ── Why events are recorded before they are acted on ─────────────────────
 * The insert is the idempotency check. Svix retries aggressively; recording
 * first means a duplicate is refused by a unique index before it can increment
 * an open count or re-suppress an address.
 *
 * ── Bounces are the one thing here with teeth ────────────────────────────
 * A hard bounce or a complaint suppresses the address permanently, and that
 * suppression cannot be lifted by staff. This is not caution about marketing
 * metrics: kekeride.ng sends the OTPs. A domain that keeps mailing addresses
 * which reported it as spam loses its reputation, and when it does, passengers
 * stop being able to log in.
 */

import { AppDataSource } from '../config/data_source';
import { EmailWebhookEvent } from '../models/EmailWebhookEvent';
import { EmailCampaignRecipient, RecipientStatus } from '../models/EmailCampaignRecipient';
import { User, UserRole } from '../models/User';
import { SuppressionService, MarketingConsentService } from './marketing_consent_service';
import { ConsentSource } from '../models/PassengerCommunicationPreference';

/** Every Resend event type we act on. Anything else is stored and ignored. */
export const HANDLED_EVENTS = [
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.bounced',
    'email.complained',
    'email.opened',
    'email.clicked',
    'email.failed',
    'contact.updated',
] as const;

export interface WebhookResult {
    accepted: boolean;
    duplicate?: boolean;
    outcome: string;
}

interface ResendEvent {
    type?: string;
    created_at?: string;
    data?: {
        email_id?: string;
        to?: string[] | string;
        from?: string;
        subject?: string;
        bounce?: { type?: string; subType?: string; message?: string };
        click?: { link?: string; timestamp?: string };
        unsubscribed?: boolean;
        email?: string;
        [k: string]: unknown;
    };
}

export class EmailWebhookService {
    private static get events() { return AppDataSource.getRepository(EmailWebhookEvent); }
    private static get recipients() { return AppDataSource.getRepository(EmailCampaignRecipient); }

    /**
     * Record and process one verified event.
     *
     * The caller has already checked the signature. This never throws: the
     * route has already told the provider 200, so an exception here would be
     * an unhandled rejection and nothing more useful.
     */
    static async handle(svixId: string, body: ResendEvent): Promise<WebhookResult> {
        const type = String(body?.type ?? 'unknown');
        const data = body?.data ?? {};
        const providerMessageId = data.email_id ? String(data.email_id) : null;
        const email = this.addressOf(data);

        // Record first. The unique index on svixId is what makes a Svix retry
        // a no-op rather than a second open, a second bounce or a second
        // suppression entry.
        let row: EmailWebhookEvent;
        try {
            row = await this.events.save(this.events.create({
                svixId, type, providerMessageId, email,
                payload: body as unknown as Record<string, unknown>,
                outcome: null, processedAt: null,
            }));
        } catch (err: any) {
            if (String(err?.code) === '23505') {
                return { accepted: true, duplicate: true, outcome: 'duplicate' };
            }
            throw err;
        }

        let outcome: string;
        try {
            outcome = await this.process(type, data, providerMessageId, email);
        } catch (err: any) {
            // Recorded as a processing failure and left. The event is stored,
            // so it can be replayed by hand; nothing upstream is affected.
            outcome = `error: ${String(err?.message ?? err).slice(0, 200)}`;
        }

        row.outcome = outcome;
        row.processedAt = new Date();
        await this.events.save(row);

        return { accepted: true, outcome };
    }

    private static addressOf(data: ResendEvent['data']): string | null {
        if (!data) return null;
        if (typeof data.email === 'string') return data.email;
        const to = data.to;
        if (Array.isArray(to)) return to[0] ?? null;
        if (typeof to === 'string') return to;
        return null;
    }

    private static async process(
        type: string,
        data: NonNullable<ResendEvent['data']>,
        providerMessageId: string | null,
        email: string | null,
    ): Promise<string> {
        switch (type) {
            case 'email.sent':
                return this.mark(providerMessageId, { status: RecipientStatus.SENT, sentAt: new Date() });

            case 'email.delivered':
                return this.mark(providerMessageId, {
                    status: RecipientStatus.DELIVERED, deliveredAt: new Date(),
                });

            case 'email.delivery_delayed':
                /*
                 * Deferred, not failed. The receiving server is asking us to
                 * come back later and Resend will; marking it bounced here
                 * would suppress an address that is about to work.
                 */
                return this.mark(providerMessageId, {
                    status: RecipientStatus.DEFERRED,
                    reason: 'Delivery delayed by the receiving server.',
                });

            case 'email.bounced':
                return this.bounced(providerMessageId, email, data);

            case 'email.complained':
                return this.complained(providerMessageId, email);

            case 'email.opened':
                return this.opened(providerMessageId);

            case 'email.clicked':
                return this.clicked(providerMessageId, data);

            case 'email.failed':
                return this.mark(providerMessageId, {
                    status: RecipientStatus.FAILED,
                    reason: 'The provider could not send it.',
                });

            case 'contact.updated':
                return this.contactUpdated(email, data);

            default:
                return `ignored: ${type} is not a type we act on`;
        }
    }

    /** Apply a change to the campaign recipient, if this message was one. */
    private static async mark(
        providerMessageId: string | null,
        patch: Partial<EmailCampaignRecipient>,
    ): Promise<string> {
        if (!providerMessageId) return 'no message id on the event';

        const row = await this.recipients.findOneBy({ providerMessageId });
        if (!row) {
            /*
             * Almost always transactional mail — an OTP, a password reset, a
             * receipt. Those have no campaign row and are none of this
             * subsystem's business. Recorded rather than treated as an error.
             */
            return 'no campaign recipient for this message (likely transactional)';
        }

        /*
         * Never walk a terminal state backwards. Resend can deliver events out
         * of order, and a late `sent` arriving after a `bounced` must not make
         * a bounced address look deliverable again.
         */
        if (this.isTerminal(row.status) && patch.status && !this.isTerminal(patch.status)) {
            return `kept ${row.status}; ignored out-of-order ${patch.status}`;
        }

        Object.assign(row, patch);
        await this.recipients.save(row);
        return `recipient ${row.id} → ${patch.status ?? 'updated'}`;
    }

    private static isTerminal(s: RecipientStatus): boolean {
        return s === RecipientStatus.HARD_BOUNCED
            || s === RecipientStatus.COMPLAINED
            || s === RecipientStatus.SOFT_BOUNCED
            || s === RecipientStatus.FAILED;
    }

    /**
     * A bounce.
     *
     * Hard bounces suppress; soft ones do not. The distinction matters: a full
     * mailbox is temporary and suppressing it would lose a real passenger,
     * while an address that does not exist will never exist and every further
     * attempt costs sender reputation the OTPs depend on.
     */
    private static async bounced(
        providerMessageId: string | null,
        email: string | null,
        data: NonNullable<ResendEvent['data']>,
    ): Promise<string> {
        const kind = String(data.bounce?.type ?? '').toLowerCase();
        const detail = String(data.bounce?.message ?? data.bounce?.subType ?? '').slice(0, 400);

        // Resend says "Permanent"/"Transient"; older payloads say "hard"/"soft".
        // Unknown is treated as SOFT: suppressing an address we are unsure
        // about loses a passenger permanently, and the next bounce will tell us.
        const hard = kind.startsWith('perm') || kind === 'hard';

        const marked = await this.mark(providerMessageId, {
            status: hard ? RecipientStatus.HARD_BOUNCED : RecipientStatus.SOFT_BOUNCED,
            reason: detail || (hard ? 'Hard bounce.' : 'Soft bounce.'),
        });

        if (hard && email) {
            await SuppressionService.add(email, 'hard_bounce', 'resend_webhook', { detail });
            return `${marked}; suppressed ${this.maskForLog(email)}`;
        }
        return `${marked}; not suppressed (${kind || 'unknown'} bounce)`;
    }

    /**
     * A spam complaint. Always suppresses, and withdraws marketing consent.
     *
     * Both, because they answer different questions. The suppression stops the
     * address being reached by any route at all; withdrawing consent means the
     * passenger's own preferences screen shows the truth rather than claiming
     * they are still subscribed to something we will never send them.
     */
    private static async complained(providerMessageId: string | null, email: string | null): Promise<string> {
        const marked = await this.mark(providerMessageId, {
            status: RecipientStatus.COMPLAINED,
            reason: 'Reported as spam.',
        });
        if (!email) return `${marked}; no address on the event`;

        await SuppressionService.add(email, 'complaint', 'resend_webhook', {
            detail: 'Recipient reported the message as spam.',
        });
        const withdrew = await this.withdrawMarketing(email, 'Reported a message as spam.');
        return `${marked}; suppressed and ${withdrew}`;
    }

    private static async opened(providerMessageId: string | null): Promise<string> {
        if (!providerMessageId) return 'no message id on the event';
        const row = await this.recipients.findOneBy({ providerMessageId });
        if (!row) return 'no campaign recipient for this message (likely transactional)';

        // First open only. Re-opens are real but uninteresting, and a unique
        // open rate is the number anyone actually reads.
        if (!row.openedAt) {
            row.openedAt = new Date();
            await this.recipients.save(row);
            return `recipient ${row.id} opened`;
        }
        return 'already recorded as opened';
    }

    private static async clicked(
        providerMessageId: string | null,
        data: NonNullable<ResendEvent['data']>,
    ): Promise<string> {
        if (!providerMessageId) return 'no message id on the event';
        const row = await this.recipients.findOneBy({ providerMessageId });
        if (!row) return 'no campaign recipient for this message (likely transactional)';

        const link = String(data.click?.link ?? '').slice(0, 200);

        // A click implies an open even when the open pixel was blocked, which
        // it usually is. Recording both keeps the funnel from showing more
        // clicks than opens.
        if (!row.openedAt) row.openedAt = new Date();
        if (!row.clickedAt) {
            row.clickedAt = new Date();
            await this.recipients.save(row);
            return `recipient ${row.id} clicked${link ? ` ${link}` : ''}`;
        }
        await this.recipients.save(row);
        return 'already recorded as clicked';
    }

    /**
     * An unsubscribe made at the provider — the header link in a mail client,
     * or a Resend audience change.
     *
     * Mirrored into our own preferences, because the passenger's screen is what
     * they will look at to check it worked, and a preference that still says
     * "subscribed" after they unsubscribed is worse than no screen at all.
     */
    private static async contactUpdated(
        email: string | null,
        data: NonNullable<ResendEvent['data']>,
    ): Promise<string> {
        if (data.unsubscribed !== true) return 'contact updated, but not an unsubscribe';
        if (!email) return 'unsubscribe with no address';

        await SuppressionService.add(email, 'unsubscribe', 'resend_webhook', {
            detail: 'Unsubscribed at the provider.',
        });
        const withdrew = await this.withdrawMarketing(email, 'Unsubscribed at the provider.');
        return `suppressed and ${withdrew}`;
    }

    /**
     * Turn every marketing channel off for whoever owns this address.
     *
     * Every channel, not just email. Someone who reports an email as spam has
     * not asked to keep receiving push promotions — reading the complaint as
     * being about one channel is a lawyer's reading, not a person's.
     *
     * Operational notifications and safety announcements are untouched: they
     * are part of the service, not marketing, and a passenger who unsubscribed
     * from offers still needs to be told their driver has arrived.
     */
    private static async withdrawMarketing(email: string, reason: string): Promise<string> {
        const user = await AppDataSource.getRepository(User).findOne({
            where: { email: SuppressionService.normalise(email), role: UserRole.PASSENGER },
        });
        if (!user) return 'no passenger account for that address';

        await MarketingConsentService.setPreferences(user.id, {
            marketing: false,
            marketingEmail: false,
            marketingPush: false,
            marketingInApp: false,
            marketingSms: false,
        }, { source: ConsentSource.UNSUBSCRIBE_LINK, reason });
        return 'withdrew marketing consent on every channel';
    }

    /** `a***z@example.com`. Outcomes are read by staff; addresses are not theirs. */
    private static maskForLog(email: string): string {
        const [local, domain] = String(email).split('@');
        if (!domain) return '***';
        const head = local.slice(0, 1);
        const tail = local.length > 2 ? local.slice(-1) : '';
        return `${head}***${tail}@${domain}`;
    }

    // ── Read side, for the dashboard ────────────────────────────────────

    /** Whether webhooks are arriving, and whether they are being processed. */
    static async health(): Promise<{
        configured: boolean;
        lastEventAt: string | null;
        last24h: number;
        failed24h: number;
        unprocessed: number;
    }> {
        const configured = Boolean(process.env.RESEND_WEBHOOK_SECRET);
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [latest, last24h, failed24h, unprocessed] = await Promise.all([
            this.events.findOne({ where: {}, order: { createdAt: 'DESC' } }),
            this.events.createQueryBuilder('e').where('e."createdAt" >= :s', { s: since }).getCount(),
            this.events.createQueryBuilder('e')
                .where('e."createdAt" >= :s', { s: since })
                .andWhere('e.outcome LIKE :p', { p: 'error:%' }).getCount(),
            this.events.createQueryBuilder('e').where('e."processedAt" IS NULL').getCount(),
        ]);

        return {
            configured,
            lastEventAt: latest?.createdAt ? latest.createdAt.toISOString() : null,
            last24h, failed24h, unprocessed,
        };
    }

    /** Recent events, for the admin screen. Addresses masked. */
    static async recent(limit = 50) {
        const rows = await this.events.find({ order: { createdAt: 'DESC' }, take: Math.min(limit, 200) });
        return rows.map((r) => ({
            id: r.id,
            type: r.type,
            emailMasked: r.email ? this.maskForLog(r.email) : null,
            outcome: r.outcome,
            processedAt: r.processedAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
        }));
    }
}
