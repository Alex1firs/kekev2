/**
 * Everything about passenger communications that is a judgement rather than a fact.
 *
 * ── Why these are configuration ──────────────────────────────────────────
 * "Frequent passenger" is not a property of the data; it is a decision about
 * the business, and in Onitsha it may be a different number than in Awka. A
 * hardcoded `>= 5` buried in a query is a decision nobody can find, review or
 * change without a deploy — and worse, one that an operator reading "frequent
 * passengers: 12" cannot interrogate.
 *
 * Every threshold here is surfaced in the admin UI beside the count it produced.
 */

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return fallback;
}

export interface CommunicationsConfig {
    /** Completed rides at or above which a passenger counts as frequent. */
    frequentRideThreshold: number;
    /** Days without a completed ride before a passenger counts as inactive. */
    inactiveDaysThreshold: number;
    /** Total spend at or above which a passenger counts as high value, in naira. */
    highValueSpendThreshold: number;

    /** Recipients per provider batch. */
    batchSize: number;
    /** Pause between batches, to stay inside provider rate limits. */
    batchPauseMs: number;
    /** Attempts per recipient before it is recorded as failed. */
    maxAttempts: number;

    /** Audience size above which the admin must confirm a second time. */
    largeAudienceWarning: number;
    /** Hard ceiling on one campaign. A number this large is probably a mistake. */
    maxAudienceSize: number;

    /**
     * ── ONE KILL SWITCH PER CHANNEL ─────────────────────────────────────
     *
     * Independent on purpose. Email being switched off must not stop a push
     * campaign, and a push provider outage must not take email down with it —
     * a single flag would make every channel hostage to the worst one.
     *
     * Every one of them ships FALSE. A channel is enabled only after it has
     * been verified on its own: its content, its consent rules, its delivery
     * reporting and, for SMS, its cost model.
     *
     * None of these are consulted by transactional communication. Verification
     * codes, password resets and ride alerts do not pass through any of it,
     * which is the entire point of keeping them separate.
     */
    marketingEmailEnabled: boolean;
    marketingPushEnabled: boolean;
    marketingInAppEnabled: boolean;
    marketingSmsEnabled: boolean;

    /** Retained so existing callers keep working: true if ANY channel is on. */
    marketingSendEnabled: boolean;

    /** Where unsubscribe and preference links point. */
    publicBaseUrl: string;
    /** The address a passenger's reply reaches a human at. */
    replyToAddress: string;
    fromAddress: string;
    fromName: string;
}

export function loadCommunicationsConfig(): CommunicationsConfig {
    return {
        frequentRideThreshold: num('COMMS_FREQUENT_RIDE_THRESHOLD', 5),
        inactiveDaysThreshold: num('COMMS_INACTIVE_DAYS', 30),
        highValueSpendThreshold: num('COMMS_HIGH_VALUE_SPEND', 20_000),

        batchSize: Math.max(1, num('COMMS_BATCH_SIZE', 50)),
        batchPauseMs: num('COMMS_BATCH_PAUSE_MS', 1_000),
        maxAttempts: Math.max(1, num('COMMS_MAX_ATTEMPTS', 3)),

        largeAudienceWarning: num('COMMS_LARGE_AUDIENCE_WARNING', 500),
        maxAudienceSize: num('COMMS_MAX_AUDIENCE', 50_000),

        // Each defaults false. Enabling one is a decision somebody makes about
        // that channel alone.
        marketingEmailEnabled: bool('MARKETING_EMAIL_SEND_ENABLED', false),
        marketingPushEnabled: bool('MARKETING_PUSH_SEND_ENABLED', false),
        marketingInAppEnabled: bool('MARKETING_IN_APP_ENABLED', false),
        marketingSmsEnabled: bool('MARKETING_SMS_SEND_ENABLED', false),

        marketingSendEnabled:
            bool('MARKETING_EMAIL_SEND_ENABLED', false)
            || bool('MARKETING_PUSH_SEND_ENABLED', false)
            || bool('MARKETING_IN_APP_ENABLED', false)
            || bool('MARKETING_SMS_SEND_ENABLED', false),

        publicBaseUrl: (process.env.PUBLIC_API_URL || 'https://api.kekeride.ng').replace(/\/+$/, ''),
        replyToAddress: process.env.COMMS_REPLY_TO || 'support@kekeride.ng',
        fromAddress: process.env.COMMS_FROM || process.env.SMTP_FROM || 'noreply@kekeride.ng',
        fromName: process.env.COMMS_FROM_NAME || 'KekeRide',
    };
}

/**
 * Why sending is not possible right now, if it is not.
 *
 * Checked before a campaign can be released, so a misconfigured production
 * refuses loudly at the moment somebody tries rather than silently accepting a
 * campaign and dropping every message.
 */
export function marketingSendBlockers(): string[] {
    const cfg = loadCommunicationsConfig();
    const problems: string[] = [];

    if (!cfg.marketingEmailEnabled) {
        problems.push('MARKETING_EMAIL_SEND_ENABLED is false — email campaigns are switched off.');
    }
    if (!process.env.RESEND_API_KEY) {
        problems.push('RESEND_API_KEY is not set — there is no provider to send through.');
    }
    if (!cfg.fromAddress.includes('@')) {
        problems.push('No valid sender address is configured.');
    }
    /*
     * A personal mailbox as the sender is both unprofessional and a
     * deliverability problem: a free-mail domain cannot be DMARC-aligned for
     * KekeRide, so the mail is far likelier to land in spam.
     */
    if (/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(cfg.fromAddress)) {
        problems.push(`Sender ${cfg.fromAddress} is a personal mailbox — use a verified kekeride.ng address.`);
    }
    if (!cfg.publicBaseUrl.startsWith('https://')) {
        problems.push('PUBLIC_API_URL is not https — unsubscribe links would be insecure.');
    }
    return problems;
}


/**
 * Is this channel permitted to send right now?
 *
 * Checked before anything else in the eligibility chain, so a disabled channel
 * refuses immediately and independently. SMS additionally requires a provider:
 * there is none in the repository yet, so it cannot send whatever the flag says.
 */
export function channelSendEnabled(channel: 'email' | 'push' | 'in_app' | 'sms'): boolean {
    const cfg = loadCommunicationsConfig();
    switch (channel) {
        case 'email': return cfg.marketingEmailEnabled;
        case 'push': return cfg.marketingPushEnabled;
        case 'in_app': return cfg.marketingInAppEnabled;
        case 'sms':
            // Belt and braces: no verified provider exists, so the flag alone
            // must not be able to turn on a channel that would silently fail
            // and cost money on retry.
            return cfg.marketingSmsEnabled && Boolean(process.env.SMS_PROVIDER_API_KEY);
        default: return false;
    }
}

/** Why each channel cannot send, for the admin Channel Health screen. */
export function channelBlockers(): Record<string, string[]> {
    const cfg = loadCommunicationsConfig();
    return {
        email: [
            ...(cfg.marketingEmailEnabled ? [] : ['MARKETING_EMAIL_SEND_ENABLED is false.']),
            ...(process.env.RESEND_API_KEY ? [] : ['RESEND_API_KEY is not set.']),
        ],
        push: [
            ...(cfg.marketingPushEnabled ? [] : ['MARKETING_PUSH_SEND_ENABLED is false.']),
            ...(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? [] : ['Firebase credentials are not set.']),
        ],
        in_app: cfg.marketingInAppEnabled ? [] : ['MARKETING_IN_APP_ENABLED is false.'],
        sms: [
            ...(cfg.marketingSmsEnabled ? [] : ['MARKETING_SMS_SEND_ENABLED is false.']),
            ...(process.env.SMS_PROVIDER_API_KEY ? [] : ['No SMS provider is configured.']),
        ],
    };
}
