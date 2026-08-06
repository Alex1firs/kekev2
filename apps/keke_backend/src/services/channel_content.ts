/**
 * What each channel's content looks like, and what is true about it.
 *
 * ── Why the limits live here rather than in the UI ───────────────────────
 * A push title truncated by Android, an SMS that silently became three
 * messages, an in-app banner with no expiry — each is discovered after the fact
 * unless something states the limit up front. The admin screen shows these
 * numbers as it is typed; the server applies the same ones, so a client that
 * skips the warning cannot save something the channel will mangle.
 */

import { CampaignChannelKind } from '../models/CommunicationCampaign';

// ── Email ───────────────────────────────────────────────────────────────

export interface EmailChannelContent {
    subject?: string;
    previewText?: string;
    senderName?: string;
    replyTo?: string;
    headline?: string;
    body?: string;
    imageUrl?: string | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
    promoCode?: string | null;
    promoExpiry?: string | null;
    footnote?: string | null;
}

// ── Push ────────────────────────────────────────────────────────────────

/**
 * Android collapses a notification title beyond roughly this, and iOS shows
 * about the same on a locked screen. Not a hard limit — a warning, because a
 * long title is not invalid, it is just going to be cut.
 */
export const PUSH_TITLE_SOFT_LIMIT = 40;
export const PUSH_BODY_SOFT_LIMIT = 120;

export interface PushChannelContent {
    title?: string;
    body?: string;
    imageUrl?: string | null;
    /** Where tapping it goes. Must be a KekeRide destination — see validate. */
    deepLink?: string | null;
}

// ── In-app ──────────────────────────────────────────────────────────────

export type InAppPlacement = 'banner' | 'modal' | 'inbox';

export interface InAppChannelContent {
    placement?: InAppPlacement;
    title?: string;
    body?: string;
    imageUrl?: string | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
    /** Higher wins when two are eligible at once. */
    priority?: number;
    startsAt?: string | null;
    endsAt?: string | null;
    dismissible?: boolean;
    /** Times one passenger may see this, ever. */
    frequencyCap?: number;
}

// ── SMS ─────────────────────────────────────────────────────────────────

/**
 * A GSM-7 message is 160 characters; a concatenated one is 153 per part
 * because each carries a header. Any character outside GSM-7 — an emoji, a
 * curly quote pasted from a document — switches the whole message to UCS-2 and
 * the limits fall to 70 and 67.
 *
 * This is why the segment count must be calculated rather than estimated from
 * length: one pasted apostrophe can double the cost of a campaign.
 */
const GSM7 = new Set(
    '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?'
    + '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\n\r'
        .split('').concat(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']).join(''),
);

/** Characters that occupy two GSM-7 slots because they need an escape. */
const GSM7_EXTENDED = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export interface SmsSegmentInfo {
    encoding: 'GSM-7' | 'UCS-2';
    characters: number;
    /** Billable units: what the provider charges for. */
    segments: number;
    /** Why the encoding fell back, when it did. */
    nonGsmCharacters: string[];
}

export function analyseSms(text: string): SmsSegmentInfo {
    const body = String(text ?? '');
    const nonGsm = [...new Set([...body].filter((c) => !GSM7.has(c)))];
    const isGsm = nonGsm.length === 0;

    if (!isGsm) {
        const chars = [...body].length;
        return {
            encoding: 'UCS-2',
            characters: chars,
            segments: chars === 0 ? 0 : chars <= 70 ? 1 : Math.ceil(chars / 67),
            nonGsmCharacters: nonGsm.slice(0, 8),
        };
    }

    // Escaped characters bill as two.
    const weight = [...body].reduce((n, c) => n + (GSM7_EXTENDED.has(c) ? 2 : 1), 0);
    return {
        encoding: 'GSM-7',
        characters: weight,
        segments: weight === 0 ? 0 : weight <= 160 ? 1 : Math.ceil(weight / 153),
        nonGsmCharacters: [],
    };
}

export interface SmsChannelContent {
    body?: string;
    senderId?: string;
}

// ── Validation ──────────────────────────────────────────────────────────

export interface ChannelIssue {
    field: string;
    message: string;
    /** `error` blocks approval; `warning` is shown and allowed. */
    severity: 'error' | 'warning';
}

/** Only KekeRide destinations. A campaign must not be a way to send traffic anywhere. */
function isTrustedUrl(url: string): boolean {
    if (!url) return false;

    /*
     * The app's own scheme, checked FIRST.
     *
     * `new URL('kekeride://offers')` parses perfectly well in Node — custom
     * schemes are valid URLs — so it never threw and never reached the fallback
     * below, and every deep link was rejected as "not https". Checking the
     * scheme before parsing is the fix.
     */
    if (/^kekeride:\/\//i.test(url)) return true;

    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        // Anchored, so kekeride.ng.attacker.com does not match.
        return /(^|\.)kekeride\.ng$/i.test(parsed.hostname);
    } catch {
        return false;
    }
}

export function validateChannelContent(
    channel: CampaignChannelKind,
    content: Record<string, unknown>,
): ChannelIssue[] {
    const issues: ChannelIssue[] = [];
    const str = (k: string) => String((content as any)[k] ?? '').trim();

    if (channel === CampaignChannelKind.EMAIL) {
        if (!str('subject')) issues.push({ field: 'subject', message: 'A subject is required.', severity: 'error' });
        if (str('subject').length > 90) {
            issues.push({ field: 'subject', message: 'Most inboxes cut a subject around 90 characters.', severity: 'warning' });
        }
        if (!str('body')) issues.push({ field: 'body', message: 'The email has no body.', severity: 'error' });
        if (str('ctaUrl') && !isTrustedUrl(str('ctaUrl'))) {
            issues.push({ field: 'ctaUrl', message: 'Links must point at a kekeride.ng address.', severity: 'error' });
        }
    }

    if (channel === CampaignChannelKind.PUSH) {
        if (!str('title')) issues.push({ field: 'title', message: 'A title is required.', severity: 'error' });
        if (!str('body')) issues.push({ field: 'body', message: 'A body is required.', severity: 'error' });
        if (str('title').length > PUSH_TITLE_SOFT_LIMIT) {
            issues.push({
                field: 'title',
                message: `${str('title').length} characters — Android will cut this around ${PUSH_TITLE_SOFT_LIMIT}.`,
                severity: 'warning',
            });
        }
        if (str('body').length > PUSH_BODY_SOFT_LIMIT) {
            issues.push({
                field: 'body',
                message: `${str('body').length} characters — a locked screen shows about ${PUSH_BODY_SOFT_LIMIT}.`,
                severity: 'warning',
            });
        }
        if (str('deepLink') && !isTrustedUrl(str('deepLink'))) {
            issues.push({ field: 'deepLink', message: 'Deep links must be a kekeride.ng or kekeride:// destination.', severity: 'error' });
        }
    }

    if (channel === CampaignChannelKind.IN_APP) {
        if (!str('title')) issues.push({ field: 'title', message: 'A title is required.', severity: 'error' });
        if (!['banner', 'modal', 'inbox'].includes(str('placement') || 'banner')) {
            issues.push({ field: 'placement', message: 'Choose banner, modal or inbox.', severity: 'error' });
        }
        /*
         * An in-app message with no end date runs forever, and the passenger
         * who has seen it forty times has no way to stop it. Required, not
         * advisory.
         */
        if (!str('endsAt')) {
            issues.push({ field: 'endsAt', message: 'An end date is required — a message with no expiry never stops.', severity: 'error' });
        }
        const cap = Number((content as any).frequencyCap ?? 0);
        if (!Number.isFinite(cap) || cap < 1) {
            issues.push({ field: 'frequencyCap', message: 'Set how many times one passenger may see this.', severity: 'error' });
        }
        if (str('ctaUrl') && !isTrustedUrl(str('ctaUrl'))) {
            issues.push({ field: 'ctaUrl', message: 'Links must point at a kekeride.ng address.', severity: 'error' });
        }
    }

    if (channel === CampaignChannelKind.SMS) {
        const body = str('body');
        if (!body) issues.push({ field: 'body', message: 'A message is required.', severity: 'error' });

        const info = analyseSms(body);
        if (info.encoding === 'UCS-2') {
            issues.push({
                field: 'body',
                message: `A character here (${info.nonGsmCharacters.join(' ')}) forces Unicode encoding — `
                    + `the limit drops from 160 to 70 and this costs ${info.segments} messages.`,
                severity: 'warning',
            });
        }
        if (info.segments > 1) {
            issues.push({
                field: 'body',
                message: `${info.characters} characters — billed as ${info.segments} messages per recipient.`,
                severity: 'warning',
            });
        }
        // An SMS with no way out is a complaint waiting to happen, and in
        // several jurisdictions is simply not allowed.
        if (body && !/stop/i.test(body)) {
            issues.push({ field: 'body', message: 'Include how to opt out, e.g. "Reply STOP".', severity: 'warning' });
        }
    }

    return issues;
}

/** What the builder shows before a single character is typed. */
export function channelDefaults(channel: CampaignChannelKind): Record<string, unknown> {
    switch (channel) {
        case CampaignChannelKind.EMAIL:
            return { subject: '', previewText: '', headline: '', body: '', ctaLabel: 'Book a ride' };
        case CampaignChannelKind.PUSH:
            return { title: '', body: '', deepLink: 'kekeride://home' };
        case CampaignChannelKind.IN_APP:
            return {
                placement: 'banner', title: '', body: '', priority: 5,
                dismissible: true, frequencyCap: 3,
            };
        case CampaignChannelKind.SMS:
            return { body: '', senderId: 'KekeRide' };
        default:
            return {};
    }
}
