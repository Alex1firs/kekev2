/**
 * Channel-specific consent, and the independence between channels.
 *
 * The rule this file exists to protect: a passenger who accepted email and
 * refused SMS has answered two questions, not one. Every test here is a way
 * that distinction could quietly collapse.
 */

import { MarketingConsentService } from '../../src/services/marketing_consent_service';
import { ConsentSource } from '../../src/models/PassengerCommunicationPreference';

const prefs: any[] = [];
const users: any[] = [];
const suppressions: any[] = [];
const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => row[k] === v);

const PREF_DEFAULTS = {
    marketing: false,
    promotionalOffers: false,
    productUpdates: false,
    surveys: false,
    safetyAnnouncements: true,
    marketingEmail: false,
    marketingPush: false,
    marketingInApp: false,
    marketingSms: false,
    promptShownCount: 0,
    promptLastShownAt: null,
    promptAnsweredAt: null,
    consentSource: null,
    consentAt: null,
    consentIp: null,
    consentAppVersion: null,
    unsubscribedAt: null,
    unsubscribeReason: null,
};

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            const store = name === 'PassengerCommunicationPreference' ? prefs
                : name === 'EmailSuppression' ? suppressions : users;
            const defaults = name === 'PassengerCommunicationPreference' ? PREF_DEFAULTS : {};
            return {
                findOneBy: async (w: any) => store.find((r) => matches(r, w)) ?? null,
                find: async () => store,
                count: async () => store.length,
                create: (d: any) => ({ ...defaults, ...d }),
                save: async (row: any) => {
                    if (!store.includes(row)) { row.id = `p${store.length + 1}`; store.push(row); }
                    return row;
                },
                remove: async (row: any) => {
                    const i = store.indexOf(row);
                    if (i >= 0) store.splice(i, 1);
                    return row;
                },
            };
        },
    },
}));

const USER = 'p1';

/** Every channel on, so a test only has to switch off the one it is about. */
function enableAllChannels() {
    process.env.MARKETING_EMAIL_SEND_ENABLED = 'true';
    process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
    process.env.MARKETING_IN_APP_ENABLED = 'true';
    process.env.MARKETING_SMS_SEND_ENABLED = 'true';
    process.env.SMS_PROVIDER_API_KEY = 'test-key';
}

beforeEach(() => {
    prefs.length = 0;
    users.length = 0;
    suppressions.length = 0;
    users.push({ id: USER, email: 'ada@example.com', role: 'passenger' });
    enableAllChannels();
});

afterEach(() => {
    delete process.env.MARKETING_EMAIL_SEND_ENABLED;
    delete process.env.MARKETING_PUSH_SEND_ENABLED;
    delete process.env.MARKETING_IN_APP_ENABLED;
    delete process.env.MARKETING_SMS_SEND_ENABLED;
    delete process.env.SMS_PROVIDER_API_KEY;
});

// ── The central rule ────────────────────────────────────────────────────

describe('a passenger who took email and refused SMS', () => {
    beforeEach(async () => {
        await MarketingConsentService.setPreferences(USER, {
            marketing: true,
            promotionalOffers: true,
            marketingEmail: true,
            marketingPush: true,
            marketingInApp: true,
            marketingSms: false,
        }, { source: ConsentSource.PROFILE });
    });

    it('is eligible for email', async () => {
        const r = await MarketingConsentService.checkChannelEligibility(
            USER, 'email', 'promotionalOffers', 'ada@example.com');
        expect(r.eligible).toBe(true);
    });

    it('is eligible for push', async () => {
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'push', 'promotionalOffers', 'token-abc')).eligible).toBe(true);
    });

    it('is NOT eligible for SMS', async () => {
        const r = await MarketingConsentService.checkChannelEligibility(
            USER, 'sms', 'promotionalOffers', '+2348012345678');
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('channel_off');
    });
});

describe('a passenger who took push and unsubscribed from email', () => {
    it('keeps push while email is refused', async () => {
        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: false, marketingPush: true,
        }, { source: ConsentSource.PROFILE });

        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'email', 'promotionalOffers', 'ada@example.com')).reason).toBe('channel_off');
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'push', 'promotionalOffers', 'token')).eligible).toBe(true);
    });

    /*
     * The email unsubscribe link turns off EMAIL. It must not silently take
     * push with it — the passenger asked to stop one thing.
     */
    it('an email unsubscribe does not disable push', async () => {
        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true,
        }, { source: ConsentSource.PROFILE });

        await MarketingConsentService.setPreferences(USER, { marketingEmail: false },
            { source: ConsentSource.UNSUBSCRIBE_LINK });

        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'push', 'promotionalOffers', 'token')).eligible).toBe(true);
    });
});

// ── The master switch still means stop ──────────────────────────────────

describe('turning marketing off entirely', () => {
    it('clears every channel, so nothing survives on a flag left set', async () => {
        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true, marketingInApp: true, marketingSms: true,
        }, { source: ConsentSource.PROFILE });

        const off = await MarketingConsentService.setPreferences(USER, { marketing: false },
            { source: ConsentSource.PROFILE });

        expect(off.marketingEmail).toBe(false);
        expect(off.marketingPush).toBe(false);
        expect(off.marketingInApp).toBe(false);
        expect(off.marketingSms).toBe(false);

        for (const ch of ['email', 'push', 'in_app', 'sms'] as const) {
            expect((await MarketingConsentService.checkChannelEligibility(
                USER, ch, 'promotionalOffers', 'x@y.com')).eligible).toBe(false);
        }
    });
});

// ── Kill switches ───────────────────────────────────────────────────────

describe('kill switches', () => {
    it.each(['email', 'push', 'in_app', 'sms'] as const)('%s defaults to OFF', async (channel) => {
        delete process.env.MARKETING_EMAIL_SEND_ENABLED;
        delete process.env.MARKETING_PUSH_SEND_ENABLED;
        delete process.env.MARKETING_IN_APP_ENABLED;
        delete process.env.MARKETING_SMS_SEND_ENABLED;

        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true, marketingInApp: true, marketingSms: true,
        }, { source: ConsentSource.PROFILE });

        const r = await MarketingConsentService.checkChannelEligibility(
            USER, channel, 'promotionalOffers', 'ada@example.com');
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('channel_disabled');
    });

    /*
     * Independence is the whole reason there are four switches. Email being
     * off must not take push down with it.
     */
    it('disabling one channel leaves the others working', async () => {
        process.env.MARKETING_EMAIL_SEND_ENABLED = 'false';

        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true,
        }, { source: ConsentSource.PROFILE });

        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'email', 'promotionalOffers', 'ada@example.com')).reason).toBe('channel_disabled');
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'push', 'promotionalOffers', 'token')).eligible).toBe(true);
    });

    /*
     * There is no SMS provider in the repository. The flag alone must not be
     * able to turn on a channel that would silently fail and cost money on
     * every retry.
     */
    it('SMS stays off without a provider, even when its flag is true', async () => {
        delete process.env.SMS_PROVIDER_API_KEY;
        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true, marketingSms: true,
        }, { source: ConsentSource.PROFILE });

        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'sms', 'promotionalOffers', '+234801')).reason).toBe('channel_disabled');
    });
});

// ── Suppression is email-only ───────────────────────────────────────────

describe('suppression', () => {
    it('blocks email but not push — a bounce is a fact about an address', async () => {
        const { SuppressionService } = require('../../src/services/marketing_consent_service');
        await MarketingConsentService.setPreferences(USER, {
            marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true,
        }, { source: ConsentSource.PROFILE });
        await SuppressionService.add('ada@example.com', 'hard_bounce', 'webhook');

        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'email', 'promotionalOffers', 'ada@example.com')).reason).toBe('suppressed');
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'push', 'promotionalOffers', 'token')).eligible).toBe(true);
    });
});

// ── Safety notices ──────────────────────────────────────────────────────

describe('safety notices', () => {
    it('bypass the marketing switch but NOT the channel choice', async () => {
        await MarketingConsentService.setPreferences(USER, {
            marketing: false, safetyAnnouncements: true,
            marketingEmail: true, marketingSms: false,
        }, { source: ConsentSource.PROFILE });

        // Reaches them by email…
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'email', 'safetyAnnouncements', 'ada@example.com')).eligible).toBe(true);

        // …but somebody who refused SMS is not texted a safety notice either.
        expect((await MarketingConsentService.checkChannelEligibility(
            USER, 'sms', 'safetyAnnouncements', '+234801')).reason).toBe('channel_off');
    });
});

// ── The one-time prompt ─────────────────────────────────────────────────

describe('the prompt', () => {
    it('is owed to a passenger who has never been asked', async () => {
        expect(await MarketingConsentService.shouldShowPrompt(USER))
            .toEqual({ show: true, reason: 'never_asked' });
    });

    it('is not shown again once answered, whatever the answer', async () => {
        await MarketingConsentService.answerPrompt(USER, false, {}, {});
        expect((await MarketingConsentService.shouldShowPrompt(USER)).reason).toBe('answered');

        prefs.length = 0;
        await MarketingConsentService.answerPrompt(USER, true, {}, {});
        expect((await MarketingConsentService.shouldShowPrompt(USER)).reason).toBe('answered');
    });

    /*
     * Dismissed without answering is not a refusal — somebody swiping a sheet
     * away while hailing a Keke was busy, not opposed. One reminder, and only
     * after a wait.
     */
    it('waits before the single reminder, then stops for good', async () => {
        await MarketingConsentService.recordPromptShown(USER);
        expect((await MarketingConsentService.shouldShowPrompt(USER)).reason).toBe('too_soon');

        // Fifteen days later.
        const pref = await MarketingConsentService.find(USER);
        pref!.promptLastShownAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
        expect((await MarketingConsentService.shouldShowPrompt(USER)).reason).toBe('reminder_due');

        await MarketingConsentService.recordPromptShown(USER);
        pref!.promptLastShownAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        // A third ask is pestering, however long we wait.
        expect((await MarketingConsentService.shouldShowPrompt(USER)).reason).toBe('limit_reached');
    });

    /*
     * SMS costs money and is the most intrusive channel. A general "yes, keep
     * me updated" must never be read as permission to text somebody.
     */
    it('accepting never grants SMS', async () => {
        const pref = await MarketingConsentService.answerPrompt(USER, true, {}, {});
        expect(pref.marketingEmail).toBe(true);
        expect(pref.marketingPush).toBe(true);
        expect(pref.marketingInApp).toBe(true);
        expect(pref.marketingSms).toBe(false);
    });

    it('records the app version the consent was given in', async () => {
        const pref = await MarketingConsentService.answerPrompt(USER, true, {}, { appVersion: '1.4.2' });
        expect(pref.consentAppVersion).toBe('1.4.2');
        expect(pref.consentSource).toBe('in_app_prompt');
    });

    it('a decline records the answer without recording consent', async () => {
        const pref = await MarketingConsentService.answerPrompt(USER, false, {}, {});
        expect(pref.marketing).toBe(false);
        expect(pref.promptAnsweredAt).toBeInstanceOf(Date);
        expect(pref.consentAt).toBeNull();
    });
});
