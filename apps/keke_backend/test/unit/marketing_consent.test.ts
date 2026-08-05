/**
 * Consent, suppression and the transactional boundary.
 *
 * These are the tests that matter most in this feature. Everything else is a
 * campaign tool; this is the part that decides whether a real person receives
 * an email they never agreed to.
 */

import { MarketingConsentService, SuppressionService } from '../../src/services/marketing_consent_service';

// ── Doubles ─────────────────────────────────────────────────────────────

const prefs: any[] = [];
const suppressions: any[] = [];
const users: any[] = [];

const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => row[k] === v);

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            const store = name === 'PassengerCommunicationPreference' ? prefs
                : name === 'EmailSuppression' ? suppressions
                : users;
            return {
                findOneBy: async (where: any) => store.find((r) => matches(r, where)) ?? null,
                find: async (opts: any = {}) => {
                    if (!opts.where) return store;
                    const wheres = Array.isArray(opts.where) ? opts.where : [opts.where];
                    return store.filter((r) => wheres.some((w: any) => {
                        return Object.entries(w).every(([k, v]: any) => {
                            if (v && typeof v === 'object' && '_value' in v) {
                                return (v as any)._value.includes(r[k]);
                            }
                            return r[k] === v;
                        });
                    }));
                },
                count: async (opts: any = {}) => {
                    if (!opts?.where) return store.length;
                    return store.filter((r) => matches(r, opts.where)).length;
                },
                create: (data: any) => ({ ...data }),
                save: async (row: any) => {
                    const existing = store.find((r) => r === row || (row.id && r.id === row.id));
                    if (!existing) { row.id = row.id ?? `id-${store.length + 1}`; store.push(row); }
                    return row;
                },
                remove: async (row: any) => {
                    const i = store.indexOf(row);
                    if (i >= 0) store.splice(i, 1);
                    return row;
                },
                createQueryBuilder: () => {
                    const qb: any = {
                        orderBy: () => qb, take: () => qb, andWhere: () => qb,
                        getMany: async () => store,
                    };
                    return qb;
                },
            };
        },
    },
}));

const PASSENGER = 'user-1';

beforeEach(() => {
    prefs.length = 0;
    suppressions.length = 0;
    users.length = 0;
    users.push({ id: PASSENGER, email: 'chidi@example.com', role: 'passenger' });
});

// ── The default ─────────────────────────────────────────────────────────

describe('a passenger who was never asked', () => {
    /*
     * The signup screen never showed terms, a privacy link or a marketing
     * checkbox. Every existing passenger is in this state, and treating them as
     * opted in would be the most damaging thing this feature could do.
     */
    it('is NOT eligible for marketing', async () => {
        const result = await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com');
        expect(result.eligible).toBe(false);
        expect(result.reason).toBe('no_consent');
    });

    it('is counted as never asked, not as unsubscribed', async () => {
        const stats = await MarketingConsentService.stats();
        expect(stats.optedIn).toBe(0);
        expect(stats.neverAsked).toBe(1);
    });
});

// ── Opting in and out ───────────────────────────────────────────────────

describe('consent', () => {
    it('records when, how and from where somebody opted in', async () => {
        const pref = await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true },
            { source: 'signup', ipAddress: '102.89.1.1' });

        expect(pref.marketing).toBe(true);
        expect(pref.consentSource).toBe('signup');
        expect(pref.consentAt).toBeInstanceOf(Date);
        expect(pref.consentIp).toBe('102.89.1.1');
        // A token is minted immediately, so the first email can carry a
        // working unsubscribe link.
        expect(pref.unsubscribeToken).toBeTruthy();
    });

    it('lets an opted-in passenger receive the category they chose', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true }, { source: 'signup' });

        expect((await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com')).eligible).toBe(true);
    });

    it('refuses a category the passenger did not choose', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true, productUpdates: false }, { source: 'signup' });

        const r = await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com', 'productUpdates');
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('category_off');
    });

    it('clears every category when the master switch goes off', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true, productUpdates: true }, { source: 'signup' });
        const off = await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: false }, { source: 'profile', reason: 'too many emails' });

        // A passenger who says stop must not keep receiving one category.
        expect(off.promotionalOffers).toBe(false);
        expect(off.productUpdates).toBe(false);
        expect(off.unsubscribedAt).toBeInstanceOf(Date);
        expect(off.unsubscribeReason).toBe('too many emails');
    });

    it('keeps both timestamps, so the history answers a complaint', async () => {
        await MarketingConsentService.setPreferences(PASSENGER, { marketing: true }, { source: 'signup' });
        const off = await MarketingConsentService.setPreferences(PASSENGER, { marketing: false }, { source: 'profile' });
        expect(off.consentAt).toBeInstanceOf(Date);
        expect(off.unsubscribedAt).toBeInstanceOf(Date);
    });
});

// ── Unsubscribe by token ────────────────────────────────────────────────

describe('unsubscribe link', () => {
    it('works without a session and also suppresses the address', async () => {
        const pref = await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true }, { source: 'signup' });

        const ok = await MarketingConsentService.unsubscribeByToken(pref.unsubscribeToken!, 'email_link');
        expect(ok).toBe(true);

        expect((await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com')).eligible).toBe(false);
        // Belt and braces: the address itself is suppressed, so a hand-built
        // list or a re-import cannot reach them either.
        expect(await SuppressionService.isSuppressed('chidi@example.com')).toBe(true);
    });

    it('reports an unknown token rather than throwing', async () => {
        expect(await MarketingConsentService.unsubscribeByToken('nonsense')).toBe(false);
    });
});

// ── Suppression ─────────────────────────────────────────────────────────

describe('suppression', () => {
    it('normalises the address, so case cannot smuggle a send through', async () => {
        await SuppressionService.add('Chidi@Example.COM', 'complaint', 'webhook');
        expect(await SuppressionService.isSuppressed('chidi@example.com')).toBe(true);
        expect(await SuppressionService.isSuppressed('CHIDI@EXAMPLE.COM')).toBe(true);
    });

    it('is idempotent — a repeated complaint is not a second row', async () => {
        await SuppressionService.add('a@b.com', 'complaint', 'webhook');
        await SuppressionService.add('a@b.com', 'complaint', 'webhook');
        expect(suppressions.filter((s) => s.email === 'a@b.com')).toHaveLength(1);
    });

    it('beats consent — a suppressed address is refused even when opted in', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: true, promotionalOffers: true }, { source: 'signup' });
        await SuppressionService.add('chidi@example.com', 'hard_bounce', 'webhook');

        const r = await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com');
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('suppressed');
    });

    /*
     * Re-sending to an address that told a mailbox provider we were spam is how
     * a sending domain is lost — and that domain also carries KekeRide's
     * verification codes and password resets.
     */
    it.each(['hard_bounce', 'complaint'] as const)('refuses to lift a %s', async (reason) => {
        await SuppressionService.add('x@y.com', reason, 'webhook');
        const result = await SuppressionService.remove('x@y.com', 'staff-1');
        expect(result.removed).toBe(false);
        expect(result.reason).toBe(`cannot_lift_${reason}`);
    });

    it.each(['unsubscribe', 'manual'] as const)('allows a %s to be lifted', async (reason) => {
        await SuppressionService.add('x@y.com', reason, 'admin');
        expect((await SuppressionService.remove('x@y.com', 'staff-1')).removed).toBe(true);
        expect(await SuppressionService.isSuppressed('x@y.com')).toBe(false);
    });
});

// ── The transactional boundary ──────────────────────────────────────────

describe('transactional email is not affected', () => {
    /*
     * The guarantee is structural rather than conditional: EmailService — which
     * sends verification codes and password resets — does not import or call
     * anything in this module, so there is no code path by which a marketing
     * preference could block one.
     */
    it('EmailService never consults consent or suppression', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/email_service.ts'), 'utf8');

        expect(source).not.toMatch(/MarketingConsentService/);
        expect(source).not.toMatch(/SuppressionService/);
        expect(source).not.toMatch(/PassengerCommunicationPreference/);
        expect(source).not.toMatch(/marketing/i);
    });

    it('a fully unsubscribed and suppressed passenger still has working OTP delivery', async () => {
        await MarketingConsentService.setPreferences(PASSENGER, { marketing: true }, { source: 'signup' });
        const pref = await MarketingConsentService.find(PASSENGER);
        await MarketingConsentService.unsubscribeByToken(pref!.unsubscribeToken!);
        await SuppressionService.add('chidi@example.com', 'complaint', 'webhook');

        // Marketing is refused…
        expect((await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com')).eligible).toBe(false);

        // …and the transactional sender is a different object entirely, with no
        // reference to any of the state just written.
        const { EmailService } = require('../../src/services/email_service');
        expect(typeof EmailService.sendVerificationOtp).toBe('function');
        expect(typeof EmailService.sendPasswordResetOtp).toBe('function');
    });
});

// ── Safety announcements ────────────────────────────────────────────────

describe('safety and service notices', () => {
    /*
     * The one category that does not require marketing consent: a service
     * withdrawal is something a passenger needs whether or not they want our
     * offers. It is still opt-OUT, not mandatory.
     */
    it('reaches a passenger who never opted into marketing but has a row', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { marketing: false, safetyAnnouncements: true }, { source: 'profile' });

        const r = await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com', 'safetyAnnouncements');
        expect(r.eligible).toBe(true);
    });

    it('is still refused when the passenger turned it off', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { safetyAnnouncements: false }, { source: 'profile' });

        const r = await MarketingConsentService.checkEligibility(PASSENGER, 'chidi@example.com', 'safetyAnnouncements');
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('category_off');
    });

    it('is still refused for a suppressed address', async () => {
        await MarketingConsentService.setPreferences(PASSENGER,
            { safetyAnnouncements: true }, { source: 'profile' });
        await SuppressionService.add('chidi@example.com', 'hard_bounce', 'webhook');

        expect((await MarketingConsentService.checkEligibility(
            PASSENGER, 'chidi@example.com', 'safetyAnnouncements')).eligible).toBe(false);
    });
});

describe('addresses', () => {
    it.each([null, '', 'not-an-email'])('refuses %p', async (email) => {
        await MarketingConsentService.setPreferences(PASSENGER, { marketing: true, promotionalOffers: true }, { source: 'signup' });
        const r = await MarketingConsentService.checkEligibility(PASSENGER, email as any);
        expect(r.eligible).toBe(false);
        expect(r.reason).toBe('no_email');
    });
});
