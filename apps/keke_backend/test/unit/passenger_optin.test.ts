/**
 * The passenger opt-in path — the only lawful way consent enters the system.
 *
 * The tests that matter here are the ones about NOT recording consent: an older
 * app that sends nothing, a passenger who declines, a body that omits the field.
 * Every one of those must leave the passenger opted out, because a false
 * positive here means emailing a real person who never agreed.
 */

import { MarketingConsentService } from '../../src/services/marketing_consent_service';
import { ConsentSource } from '../../src/models/PassengerCommunicationPreference';

const prefs: any[] = [];
const users: any[] = [];
const suppressions: any[] = [];
const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => row[k] === v);

/**
 * The column defaults TypeORM would apply on insert.
 *
 * Without these the double returns `undefined` where the real entity returns
 * `false` or `true`, which produced three failures that looked like product
 * bugs and were not. A double that does not model defaults will eventually
 * produce the opposite — a false pass — so it models them.
 */
const PREF_DEFAULTS = {
    marketing: false,
    promotionalOffers: false,
    productUpdates: false,
    safetyAnnouncements: true,
    consentSource: null,
    consentAt: null,
    consentIp: null,
    unsubscribedAt: null,
    unsubscribeReason: null,
};

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            // Each entity gets its OWN store. Routing suppression to the user
            // table made every address look suppressed, because a user row
            // happens to have an `email` column too.
            const store = name === 'PassengerCommunicationPreference' ? prefs
                : name === 'EmailSuppression' ? suppressions
                : users;
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

const USER = 'passenger-1';
beforeEach(() => {
    prefs.length = 0;
    users.length = 0;
    suppressions.length = 0;
    users.push({ id: USER, email: 'ada@example.com', role: 'passenger' });
});

describe('signup', () => {
    /*
     * The backward-compatibility guarantee. A passenger using yesterday's build
     * sends no `marketing_opt_in`, the handler writes nothing, and they remain
     * opted out — which is both the safe default and their actual position.
     */
    it('an older app that sends no field leaves the passenger opted out', async () => {
        // Nothing written at all: no row exists.
        expect(await MarketingConsentService.find(USER)).toBeNull();
        expect((await MarketingConsentService.checkEligibility(USER, 'ada@example.com')).eligible).toBe(false);
    });

    it('an explicit true records consent, stamped with source and time', async () => {
        const pref = await MarketingConsentService.setPreferences(USER,
            { marketing: true, promotionalOffers: true, productUpdates: true },
            { source: ConsentSource.SIGNUP, ipAddress: '102.89.1.1' });

        expect(pref.marketing).toBe(true);
        expect(pref.consentSource).toBe('signup');
        expect(pref.consentAt).toBeInstanceOf(Date);
        expect((await MarketingConsentService.checkEligibility(USER, 'ada@example.com')).eligible).toBe(true);
    });

    it('an unticked box records nothing, so the prompt can still ask later', async () => {
        // The handler only acts on `=== true`; false writes no row, leaving
        // `hasBeenAsked` false so the one-time prompt is still owed.
        expect(await MarketingConsentService.find(USER)).toBeNull();
    });
});

describe('the one-time prompt', () => {
    /*
     * Without a recorded decline, "no row" would mean both "never asked" and
     * "asked and said no", and the prompt would reappear on every launch for
     * somebody who already refused.
     */
    it('a decline is recorded, so the passenger is not asked twice', async () => {
        await MarketingConsentService.setPreferences(USER,
            { marketing: false, promotionalOffers: false, productUpdates: false },
            { source: ConsentSource.IN_APP_PROMPT, reason: 'declined_prompt' });

        const pref = await MarketingConsentService.find(USER);
        expect(pref).not.toBeNull();
        expect(pref!.marketing).toBe(false);
        // A row exists — the app reads this as "already asked".
        expect(pref!.consentAt).toBeNull();
    });

    it('a declined passenger is still not eligible', async () => {
        await MarketingConsentService.setPreferences(USER, { marketing: false },
            { source: ConsentSource.IN_APP_PROMPT });
        expect((await MarketingConsentService.checkEligibility(USER, 'ada@example.com')).eligible).toBe(false);
    });

    it('accepting from the prompt records the prompt as the source', async () => {
        const pref = await MarketingConsentService.setPreferences(USER,
            { marketing: true, promotionalOffers: true },
            { source: ConsentSource.IN_APP_PROMPT });
        expect(pref.consentSource).toBe('in_app_prompt');
    });
});

describe('the profile toggle', () => {
    it('lets a passenger opt in later and records the screen they used', async () => {
        const pref = await MarketingConsentService.setPreferences(USER,
            { marketing: true, promotionalOffers: true },
            { source: ConsentSource.PROFILE });
        expect(pref.consentSource).toBe('profile');
        expect(pref.marketing).toBe(true);
    });

    it('lets them turn it back off, and records when', async () => {
        await MarketingConsentService.setPreferences(USER, { marketing: true },
            { source: ConsentSource.PROFILE });
        const off = await MarketingConsentService.setPreferences(USER, { marketing: false },
            { source: ConsentSource.PROFILE });

        expect(off.marketing).toBe(false);
        expect(off.unsubscribedAt).toBeInstanceOf(Date);
        // The consent timestamp survives: the history is "in on the 3rd, out on
        // the 9th", which is what answers a complaint.
        expect(off.consentAt).toBeInstanceOf(Date);
    });

    /*
     * Safety notices are opt-OUT and default on, so a passenger who never
     * touches this screen still receives a service withdrawal.
     */
    it('leaves safety notices on for somebody who only declined marketing', async () => {
        const pref = await MarketingConsentService.setPreferences(USER,
            { marketing: false }, { source: ConsentSource.PROFILE });
        expect(pref.safetyAnnouncements).toBe(true);

        expect((await MarketingConsentService.checkEligibility(
            USER, 'ada@example.com', 'safetyAnnouncements')).eligible).toBe(true);
    });
});

describe('consent source is never invented', () => {
    it.each([
        ConsentSource.SIGNUP,
        ConsentSource.PROFILE,
        ConsentSource.IN_APP_PROMPT,
    ])('records %s verbatim', async (source) => {
        const pref = await MarketingConsentService.setPreferences(USER,
            { marketing: true }, { source });
        expect(pref.consentSource).toBe(source);
    });
});
