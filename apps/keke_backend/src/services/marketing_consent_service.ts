/**
 * Who may lawfully be sent marketing, and who may not.
 *
 * ── The one rule ─────────────────────────────────────────────────────────
 * A passenger with no preference row is NOT opted in. Every existing passenger
 * is in that state, because the signup screen never showed terms, a privacy
 * link or a marketing checkbox — they were never asked, so there is nothing to
 * infer and inferring anything would be the most damaging thing this feature
 * could do.
 *
 * ── Transactional email never comes through here ─────────────────────────
 * There is no method on this class that a password reset or a ride receipt
 * would call. That is deliberate: unsubscribing from offers must not cost
 * somebody the code that gets them back into their account, and the surest way
 * to guarantee that is to leave transactional mail no way to ask.
 */

import { randomBytes, createHash } from 'crypto';
import { In, IsNull, Not } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import {
    PassengerCommunicationPreference, ConsentSource,
} from '../models/PassengerCommunicationPreference';
import { EmailSuppression } from '../models/EmailSuppression';
import { User, UserRole } from '../models/User';
import { channelSendEnabled } from '../config/communications_config';

/** The marketing categories a campaign can target. */
export type MarketingCategory = 'promotionalOffers' | 'productUpdates' | 'safetyAnnouncements' | 'surveys';

/**
 * How a passenger can be reached.
 *
 * Separate from the category, because they answer different questions: the
 * category is WHAT a campaign is about, the channel is HOW it arrives. Both
 * must pass for a message to be sent.
 */
export type MarketingChannel = 'email' | 'push' | 'in_app' | 'sms';

/** Asked once, then one reminder. A third ask is pestering. */
const PROMPT_MAX_SHOWS = 2;

/**
 * How long before the single reminder is allowed.
 *
 * Long enough that it does not feel like the same ask repeated; short enough
 * that a passenger who was simply busy is still reachable.
 */
const PROMPT_REMINDER_GAP_MS = 14 * 24 * 60 * 60 * 1000;

/** The preference column that gates each channel. */
const CHANNEL_COLUMN: Record<MarketingChannel, 'marketingEmail' | 'marketingPush' | 'marketingInApp' | 'marketingSms'> = {
    email: 'marketingEmail',
    push: 'marketingPush',
    in_app: 'marketingInApp',
    sms: 'marketingSms',
};

export interface EligibilityResult {
    eligible: boolean;
    /** Why not, in words an operator can read in a report. */
    reason?: 'no_consent' | 'unsubscribed' | 'category_off' | 'channel_off'
        | 'suppressed' | 'no_email' | 'no_destination' | 'not_passenger' | 'channel_disabled';
}

export class MarketingConsentService {
    private static get repo() {
        return AppDataSource.getRepository(PassengerCommunicationPreference);
    }

    /** The stored preference, or null when the passenger has never expressed one. */
    static async find(userId: string): Promise<PassengerCommunicationPreference | null> {
        return this.repo.findOneBy({ userId });
    }

    /**
     * Record a passenger's own decision.
     *
     * `source` says which screen they used, and it is stored rather than
     * assumed: "they opted in" is only a defence if we can say when, how and
     * from where.
     */
    static async setPreferences(
        userId: string,
        input: {
            marketing?: boolean;
            promotionalOffers?: boolean;
            productUpdates?: boolean;
            safetyAnnouncements?: boolean;
            surveys?: boolean;
            marketingEmail?: boolean;
            marketingPush?: boolean;
            marketingInApp?: boolean;
            marketingSms?: boolean;
        },
        ctx: {
            source: string; ipAddress?: string | null;
            reason?: string | null; appVersion?: string | null;
        },
    ): Promise<PassengerCommunicationPreference> {
        let pref = await this.repo.findOneBy({ userId });
        if (!pref) {
            pref = this.repo.create({
                userId,
                unsubscribeToken: randomBytes(24).toString('base64url'),
            });
        }
        if (!pref.unsubscribeToken) pref.unsubscribeToken = randomBytes(24).toString('base64url');

        const wasMarketing = pref.marketing;

        if (input.marketing !== undefined) pref.marketing = input.marketing;
        if (input.promotionalOffers !== undefined) pref.promotionalOffers = input.promotionalOffers;
        if (input.productUpdates !== undefined) pref.productUpdates = input.productUpdates;
        if (input.safetyAnnouncements !== undefined) pref.safetyAnnouncements = input.safetyAnnouncements;
        if (input.surveys !== undefined) pref.surveys = input.surveys;
        if (input.marketingEmail !== undefined) pref.marketingEmail = input.marketingEmail;
        if (input.marketingPush !== undefined) pref.marketingPush = input.marketingPush;
        if (input.marketingInApp !== undefined) pref.marketingInApp = input.marketingInApp;
        if (input.marketingSms !== undefined) pref.marketingSms = input.marketingSms;

        /*
         * Turning the master switch on is a consent event and is stamped.
         * Turning it off is an unsubscribe and is stamped separately — both
         * timestamps are kept, because "opted in on the 3rd, out on the 9th" is
         * the history a complaint is answered with.
         */
        if (input.marketing === true && !wasMarketing) {
            pref.consentSource = ctx.source;
            pref.consentAt = new Date();
            pref.consentIp = ctx.ipAddress ?? null;
            pref.consentAppVersion = ctx.appVersion ?? null;
            pref.unsubscribedAt = null;
            pref.unsubscribeReason = null;
        }
        if (input.marketing === false && wasMarketing) {
            pref.unsubscribedAt = new Date();
            pref.unsubscribeReason = ctx.reason ?? null;
            /*
             * Everything downstream of the master switch goes with it —
             * categories AND channels. A passenger who says "stop" must not
             * keep receiving one category down one channel because a flag was
             * left set.
             */
            pref.promotionalOffers = false;
            pref.productUpdates = false;
            pref.surveys = false;
            pref.marketingEmail = false;
            pref.marketingPush = false;
            pref.marketingInApp = false;
            pref.marketingSms = false;
        }

        return this.repo.save(pref);
    }

    /**
     * Unsubscribe by the token in an email footer.
     *
     * Returns false only when the token matches nobody. It must not require a
     * session: a passenger reading mail on a device they are not signed in on
     * still gets to stop it, and an unsubscribe link that demands a login is an
     * unsubscribe link that produces a spam complaint instead.
     */
    static async unsubscribeByToken(token: string, reason?: string | null): Promise<boolean> {
        const pref = await this.repo.findOneBy({ unsubscribeToken: token });
        if (!pref) return false;

        await this.setPreferences(pref.userId, { marketing: false }, {
            source: ConsentSource.UNSUBSCRIBE_LINK,
            reason: reason ?? null,
        });

        /*
         * Also suppressed by address. The preference stops us choosing them; the
         * suppression stops them being reached by any other route — a hand-built
         * recipient list, a re-import, a second account on the same address.
         */
        const user = await AppDataSource.getRepository(User).findOneBy({ id: pref.userId });
        if (user?.email) {
            await SuppressionService.add(user.email, 'unsubscribe', 'passenger', {
                detail: reason ?? null,
            });
        }
        return true;
    }

    /**
     * Should the one-time prompt be shown to this passenger?
     *
     * ── The nagging rule, in one place ──────────────────────────────────
     * Answered — accepted or declined — means never again. Dismissed without
     * an answer earns exactly one reminder, and only after a cooling-off
     * period, because somebody who swiped a sheet away while hailing a Keke has
     * not refused; they were busy. Beyond that we stop, because a third ask is
     * pestering and the answer it extracts is not worth having.
     *
     * Server-side rather than in the app: reinstalling must not reset it.
     */
    static async shouldShowPrompt(userId: string): Promise<{
        show: boolean;
        reason: 'never_asked' | 'reminder_due' | 'answered' | 'limit_reached' | 'too_soon';
    }> {
        const pref = await this.repo.findOneBy({ userId });

        if (!pref) return { show: true, reason: 'never_asked' };
        if (pref.promptAnsweredAt) return { show: false, reason: 'answered' };
        if (pref.promptShownCount >= PROMPT_MAX_SHOWS) return { show: false, reason: 'limit_reached' };
        if (pref.promptShownCount === 0) return { show: true, reason: 'never_asked' };

        const since = pref.promptLastShownAt
            ? Date.now() - new Date(pref.promptLastShownAt).getTime()
            : Number.POSITIVE_INFINITY;
        return since >= PROMPT_REMINDER_GAP_MS
            ? { show: true, reason: 'reminder_due' }
            : { show: false, reason: 'too_soon' };
    }

    /** Record that the prompt was put on screen. Never records an answer. */
    static async recordPromptShown(userId: string): Promise<void> {
        let pref = await this.repo.findOneBy({ userId });
        if (!pref) {
            pref = this.repo.create({
                userId,
                unsubscribeToken: randomBytes(24).toString('base64url'),
            });
        }
        pref.promptShownCount = (pref.promptShownCount ?? 0) + 1;
        pref.promptLastShownAt = new Date();
        await this.repo.save(pref);
    }

    /**
     * Record an answer — accept or decline — which ends the prompt for good.
     *
     * A decline writes a row with everything false. Without it, "no row" would
     * mean both "never asked" and "asked and refused", and the prompt would
     * return on every launch for somebody who already said no.
     */
    static async answerPrompt(
        userId: string,
        accepted: boolean,
        channels: { email?: boolean; push?: boolean; inApp?: boolean; sms?: boolean },
        ctx: { ipAddress?: string | null; appVersion?: string | null },
    ): Promise<PassengerCommunicationPreference> {
        const pref = await this.setPreferences(userId, {
            marketing: accepted,
            promotionalOffers: accepted,
            productUpdates: accepted,
            marketingEmail: accepted && (channels.email ?? true),
            marketingPush: accepted && (channels.push ?? true),
            marketingInApp: accepted && (channels.inApp ?? true),
            // SMS is never granted by a general "yes". It costs money and is the
            // most intrusive channel, so it is only ever turned on deliberately
            // on the preferences screen.
            marketingSms: accepted && (channels.sms ?? false),
        }, {
            source: ConsentSource.IN_APP_PROMPT,
            ipAddress: ctx.ipAddress ?? null,
            reason: accepted ? 'accepted_prompt' : 'declined_prompt',
            appVersion: ctx.appVersion ?? null,
        });

        pref.promptAnsweredAt = new Date();
        return this.repo.save(pref);
    }

    /** Resolve a preference row from an email-link token. */
    static async findByToken(token: string): Promise<PassengerCommunicationPreference | null> {
        if (!token) return null;
        return this.repo.findOneBy({ unsubscribeToken: token });
    }

    /** Ensure a token exists so a link can be built for this passenger. */
    static async ensureToken(userId: string): Promise<string> {
        let pref = await this.repo.findOneBy({ userId });
        if (!pref) {
            pref = await this.repo.save(this.repo.create({
                userId,
                unsubscribeToken: randomBytes(24).toString('base64url'),
            }));
        } else if (!pref.unsubscribeToken) {
            pref.unsubscribeToken = randomBytes(24).toString('base64url');
            await this.repo.save(pref);
        }
        return pref.unsubscribeToken!;
    }

    /**
     * The final gate, applied per recipient at send time.
     *
     * Called for every recipient immediately before the provider call — not
     * once when the audience was built. A passenger who unsubscribes while a
     * campaign is going out must not receive the rest of it.
     */
    static async checkEligibility(
        userId: string,
        email: string | null,
        category: MarketingCategory = 'promotionalOffers',
    ): Promise<EligibilityResult> {
        if (!email || !email.includes('@')) return { eligible: false, reason: 'no_email' };

        if (await SuppressionService.isSuppressed(email)) {
            return { eligible: false, reason: 'suppressed' };
        }

        const pref = await this.repo.findOneBy({ userId });

        // No row means never asked, which means no.
        if (!pref) return { eligible: false, reason: 'no_consent' };
        if (pref.unsubscribedAt && !pref.marketing) return { eligible: false, reason: 'unsubscribed' };

        /*
         * Safety and service announcements are the one category that does not
         * require the marketing switch: a service withdrawal is something a
         * passenger needs whether or not they want our offers. It is still an
         * opt-OUT — `safetyAnnouncements` false means no.
         */
        if (category === 'safetyAnnouncements') {
            return pref.safetyAnnouncements
                ? { eligible: true }
                : { eligible: false, reason: 'category_off' };
        }

        if (!pref.marketing) return { eligible: false, reason: 'no_consent' };
        if (!pref[category]) return { eligible: false, reason: 'category_off' };

        return { eligible: true };
    }

    /**
     * May this passenger be reached on this channel, about this category?
     *
     * BOTH must pass. The category says what the message is about; the channel
     * says how it arrives, and a passenger who took email and refused SMS has
     * answered those separately. Suppression is checked first because it
     * outranks any preference — it is a fact from the mail system, not a wish.
     *
     * Applied per recipient immediately before sending, not once when the
     * audience was built: somebody who opts out mid-campaign must not receive
     * the rest of it.
     */
    static async checkChannelEligibility(
        userId: string,
        channel: MarketingChannel,
        category: MarketingCategory = 'promotionalOffers',
        destination?: string | null,
    ): Promise<EligibilityResult> {
        /*
         * The per-channel kill switch, first. A disabled channel must refuse
         * before anything else is considered, and must not affect the others —
         * push being switched off cannot stop an email campaign.
         */
        if (!channelSendEnabled(channel)) {
            return { eligible: false, reason: 'channel_disabled' };
        }

        // Email is the only channel whose destination we suppress on, because
        // it is the only one that reports bounces and complaints back to us.
        if (channel === 'email') {
            if (!destination || !destination.includes('@')) {
                return { eligible: false, reason: 'no_email' };
            }
            if (await SuppressionService.isSuppressed(destination)) {
                return { eligible: false, reason: 'suppressed' };
            }
        } else if (destination !== undefined && !destination) {
            // No device token, no phone number: nothing to send to.
            return { eligible: false, reason: 'no_destination' };
        }

        const pref = await this.repo.findOneBy({ userId });
        if (!pref) return { eligible: false, reason: 'no_consent' };

        /*
         * Safety notices are the one category exempt from the marketing switch
         * — a service withdrawal is something a passenger needs whether or not
         * they want our offers — but they are NOT exempt from the channel
         * choice. Somebody who refused SMS does not get texted a safety notice;
         * it reaches them another way.
         */
        if (category === 'safetyAnnouncements') {
            if (!pref.safetyAnnouncements) return { eligible: false, reason: 'category_off' };
        } else {
            if (!pref.marketing) {
                return { eligible: false, reason: pref.unsubscribedAt ? 'unsubscribed' : 'no_consent' };
            }
            if (category !== 'promotionalOffers' && !pref[category]) {
                return { eligible: false, reason: 'category_off' };
            }
            if (category === 'promotionalOffers' && !pref.promotionalOffers) {
                return { eligible: false, reason: 'category_off' };
            }
        }

        if (!pref[CHANNEL_COLUMN[channel]]) return { eligible: false, reason: 'channel_off' };

        return { eligible: true };
    }

    /** Consenting passenger ids, for the audience query to start from. */
    static async consentingUserIds(category: MarketingCategory): Promise<string[]> {
        const where: Record<string, unknown> = category === 'safetyAnnouncements'
            ? { safetyAnnouncements: true }
            : { marketing: true, [category]: true };

        const rows = await this.repo.find({ where: where as any, select: ['userId'] });
        return rows.map((r) => r.userId);
    }

    /** Headline consent numbers for the overview screen. */
    static async stats(): Promise<{
        passengers: number; optedIn: number; unsubscribed: number; neverAsked: number; suppressed: number;
    }> {
        const passengers = await AppDataSource.getRepository(User)
            .count({ where: { role: UserRole.PASSENGER } });
        const optedIn = await this.repo.count({ where: { marketing: true } });
        const unsubscribed = await this.repo.count({ where: { unsubscribedAt: Not(IsNull()) } });
        const withRow = await this.repo.count();
        const suppressed = await AppDataSource.getRepository(EmailSuppression).count();

        return {
            passengers,
            optedIn,
            unsubscribed,
            // The number that matters on day one: people we have simply never
            // asked, and therefore may not email.
            neverAsked: Math.max(0, passengers - withRow),
            suppressed,
        };
    }
}

/**
 * Addresses that must never receive marketing again.
 *
 * Separate from consent because it answers a different question. Consent is
 * what a passenger wants; suppression is what the mail system has told us —
 * a hard bounce or a complaint — and it outranks any list an admin can build.
 */
export class SuppressionService {
    private static get repo() {
        return AppDataSource.getRepository(EmailSuppression);
    }

    static normalise(email: string): string {
        return String(email ?? '').trim().toLowerCase();
    }

    static async isSuppressed(email: string): Promise<boolean> {
        const found = await this.repo.findOneBy({ email: this.normalise(email) });
        return found != null;
    }

    /** Which of these addresses are suppressed — one query, for audience building. */
    static async suppressedAmong(emails: string[]): Promise<Set<string>> {
        if (emails.length === 0) return new Set();
        const rows = await this.repo.find({
            where: { email: In(emails.map((e) => this.normalise(e))) },
            select: ['email'],
        });
        return new Set(rows.map((r) => r.email));
    }

    /**
     * Add an address. Idempotent: a repeated complaint is not a second row, and
     * the first reason is kept because it is the one that explains the history.
     */
    static async add(
        email: string,
        reason: EmailSuppression['reason'],
        source: string,
        extra: { detail?: string | null; staffId?: string | null; campaignId?: string | null } = {},
    ): Promise<EmailSuppression> {
        const normalised = this.normalise(email);
        const existing = await this.repo.findOneBy({ email: normalised });
        if (existing) return existing;

        try {
            return await this.repo.save(this.repo.create({
                email: normalised,
                reason,
                source,
                detail: extra.detail ?? null,
                createdByStaffId: extra.staffId ?? null,
                campaignId: extra.campaignId ?? null,
            }));
        } catch (err: any) {
            // Lost a race with a concurrent webhook. The row exists, which is
            // the outcome we wanted.
            if (String(err?.code) === '23505') {
                return (await this.repo.findOneBy({ email: normalised }))!;
            }
            throw err;
        }
    }

    /**
     * Remove an address.
     *
     * Deliberately narrow: an unsubscribe or a manual entry may be lifted — a
     * passenger can ask to be put back on — but a hard bounce or a complaint
     * may not. Re-sending to an address that told the provider it was spam is
     * how a sending domain is lost, and that domain also carries the OTPs.
     */
    static async remove(email: string, staffId: string): Promise<{ removed: boolean; reason?: string }> {
        const normalised = this.normalise(email);
        const row = await this.repo.findOneBy({ email: normalised });
        if (!row) return { removed: false, reason: 'not_suppressed' };

        if (row.reason === 'hard_bounce' || row.reason === 'complaint') {
            return { removed: false, reason: `cannot_lift_${row.reason}` };
        }

        await this.repo.remove(row);
        return { removed: true };
    }

    static async list(query: { search?: string; reason?: string; limit?: number } = {}) {
        const qb = this.repo.createQueryBuilder('s').orderBy('s."createdAt"', 'DESC')
            .take(Math.min(Math.max(query.limit ?? 100, 1), 500));
        if (query.search?.trim()) {
            qb.andWhere('s.email ILIKE :term', { term: `%${query.search.trim().toLowerCase()}%` });
        }
        if (query.reason) qb.andWhere('s.reason = :reason', { reason: query.reason });
        return qb.getMany();
    }
}

/** Stable hash of what an approver saw, for detecting edits after approval. */
export function contentFingerprint(parts: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
