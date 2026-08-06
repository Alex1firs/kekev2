/**
 * The delivery-event webhook.
 *
 * Two things are being protected here. The first is the recipient records — a
 * retried event must not count a second open. The second, and the one that
 * matters more, is the sending domain: kekeride.ng carries every OTP and
 * password reset, so a forged bounce that suppresses a real address, or a
 * genuine complaint we fail to act on, both end in passengers unable to log in.
 */

import * as crypto from 'crypto';
import { ResendProvider } from '../../src/services/email_provider';

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');

/** Sign a body the way Svix does, so the verifier is tested against real input. */
function sign(id: string, timestamp: number, body: string, secret = SECRET): string {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const mac = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    return `v1,${mac}`;
}

function headers(id: string, ts: number, sig: string) {
    return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig };
}

describe('signature verification', () => {
    const provider = new ResendProvider('test-key');
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'm1' } });

    beforeEach(() => { process.env.RESEND_WEBHOOK_SECRET = SECRET; });
    afterEach(() => { delete process.env.RESEND_WEBHOOK_SECRET; });

    it('accepts a correctly signed event', () => {
        const ts = Math.floor(Date.now() / 1000);
        expect(provider.verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body)))).toBe(true);
    });

    it('rejects a body that was altered after signing', () => {
        const ts = Math.floor(Date.now() / 1000);
        const sig = sign('msg_1', ts, body);
        const tampered = JSON.stringify({ type: 'email.bounced', data: { email_id: 'm1' } });
        expect(provider.verifyWebhook(tampered, headers('msg_1', ts, sig))).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
        const ts = Math.floor(Date.now() / 1000);
        const other = 'whsec_' + Buffer.from('a-different-key-of-32-bytes-here').toString('base64');
        expect(provider.verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body, other)))).toBe(false);
    });

    /*
     * Replay. A captured event is valid forever without this — and a captured
     * `email.bounced` replayed later would re-suppress an address a human had
     * just restored.
     */
    it('rejects an event older than five minutes', () => {
        const ts = Math.floor(Date.now() / 1000) - 600;
        expect(provider.verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body)))).toBe(false);
    });

    it('rejects an event timestamped in the future', () => {
        const ts = Math.floor(Date.now() / 1000) + 600;
        expect(provider.verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body)))).toBe(false);
    });

    it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('rejects when %s is missing', (missing) => {
        const ts = Math.floor(Date.now() / 1000);
        const h: Record<string, string> = headers('msg_1', ts, sign('msg_1', ts, body));
        delete h[missing];
        expect(provider.verifyWebhook(body, h)).toBe(false);
    });

    it('rejects everything when no secret is configured', () => {
        delete process.env.RESEND_WEBHOOK_SECRET;
        const ts = Math.floor(Date.now() / 1000);
        expect(provider.verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body)))).toBe(false);
    });

    /*
     * The hole that would exist if the route verified via emailProvider():
     * without an API key that returns NullProvider, whose verifyWebhook is
     * `true` so tests need no signing. The route uses ResendProvider directly.
     */
    it('NullProvider accepts anything — which is why the route must not use it', () => {
        const { NullProvider } = require('../../src/services/email_provider');
        expect(new NullProvider().verifyWebhook()).toBe(true);
    });
});

// ── Event handling ──────────────────────────────────────────────────────

describe('event handling', () => {
    let events: any[];
    let recipients: any[];
    let suppressed: any[];
    let prefsWritten: any[];
    let users: any[];

    const load = () => {
        jest.resetModules();
        events = []; recipients = []; suppressed = []; prefsWritten = []; users = [];

        const eventRepo = {
            create: (x: any) => ({ ...x }),
            save: async (x: any) => {
                if (!x.id) {
                    if (events.some((e) => e.svixId === x.svixId)) {
                        const err: any = new Error('duplicate key'); err.code = '23505'; throw err;
                    }
                    x.id = `ev-${events.length + 1}`;
                    x.createdAt = new Date();
                    events.push(x);
                }
                return x;
            },
            findOne: async () => events[events.length - 1] ?? null,
            createQueryBuilder: () => ({
                where: function () { return this; }, andWhere: function () { return this; },
                getCount: async () => 0,
            }),
            find: async () => events,
        };

        const recipientRepo = {
            findOneBy: async (w: any) =>
                recipients.find((r) => r.providerMessageId === w.providerMessageId) ?? null,
            save: async (r: any) => r,
        };

        const userRepo = { findOne: async (q: any) => users.find((u) => u.email === q.where.email) ?? null };

        jest.doMock('../../src/config/data_source', () => ({
            AppDataSource: {
                getRepository: (m: any) => {
                    const n = m?.name ?? '';
                    if (n === 'EmailWebhookEvent') return eventRepo;
                    if (n === 'EmailCampaignRecipient') return recipientRepo;
                    if (n === 'User') return userRepo;
                    throw new Error(`unexpected repository: ${n}`);
                },
            },
        }));

        jest.doMock('../../src/services/marketing_consent_service', () => ({
            SuppressionService: {
                normalise: (e: string) => String(e).trim().toLowerCase(),
                add: async (email: string, reason: string, source: string, extra: any) => {
                    suppressed.push({ email, reason, source, ...extra });
                    return { email, reason };
                },
            },
            MarketingConsentService: {
                setPreferences: async (userId: string, input: any, meta: any) => {
                    prefsWritten.push({ userId, input, meta });
                },
            },
        }));

        return require('../../src/services/email_webhook_service').EmailWebhookService;
    };

    const ev = (type: string, data: any = {}) => ({ type, data });

    it('records the raw event before acting on it', async () => {
        const S = load();
        await S.handle('msg_1', ev('email.delivered', { email_id: 'm1' }));
        expect(events).toHaveLength(1);
        expect(events[0].payload.type).toBe('email.delivered');
        expect(events[0].processedAt).toBeTruthy();
    });

    /*
     * Svix retries on any timeout. Without the unique index this would count a
     * second open, and a campaign's open rate would be a function of how often
     * the database was slow.
     */
    it('treats a retried delivery of the same event as a no-op', async () => {
        const S = load();
        recipients.push({ id: 'r1', providerMessageId: 'm1', openedAt: null, clickedAt: null });

        const first = await S.handle('msg_1', ev('email.opened', { email_id: 'm1' }));
        const opened = recipients[0].openedAt;
        const second = await S.handle('msg_1', ev('email.opened', { email_id: 'm1' }));

        expect(first.duplicate).toBeFalsy();
        expect(second.duplicate).toBe(true);
        expect(recipients[0].openedAt).toBe(opened);
        expect(events).toHaveLength(1);
    });

    it('marks delivery', async () => {
        const S = load();
        recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'sent' });
        await S.handle('a', ev('email.delivered', { email_id: 'm1' }));
        expect(recipients[0].status).toBe('delivered');
        expect(recipients[0].deliveredAt).toBeTruthy();
    });

    it('records the first open only', async () => {
        const S = load();
        recipients.push({ id: 'r1', providerMessageId: 'm1', openedAt: null });
        await S.handle('a', ev('email.opened', { email_id: 'm1' }));
        const first = recipients[0].openedAt;
        const r = await S.handle('b', ev('email.opened', { email_id: 'm1' }));
        expect(recipients[0].openedAt).toBe(first);
        expect(r.outcome).toMatch(/already recorded as opened/);
    });

    /*
     * Open tracking is a pixel, and most clients block it. A click that did not
     * also count as an open would give reports more clicks than opens.
     */
    it('a click implies an open even when the pixel was blocked', async () => {
        const S = load();
        recipients.push({ id: 'r1', providerMessageId: 'm1', openedAt: null, clickedAt: null });
        await S.handle('a', ev('email.clicked', { email_id: 'm1', click: { link: 'https://kekeride.ng/x' } }));
        expect(recipients[0].clickedAt).toBeTruthy();
        expect(recipients[0].openedAt).toBeTruthy();
    });

    describe('bounces', () => {
        it.each(['Permanent', 'permanent', 'hard'])('suppresses on a %s bounce', async (kind) => {
            const S = load();
            recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'sent' });
            await S.handle('a', ev('email.bounced', {
                email_id: 'm1', to: ['gone@example.com'], bounce: { type: kind, message: 'no such user' },
            }));
            expect(recipients[0].status).toBe('hard_bounced');
            expect(suppressed).toHaveLength(1);
            expect(suppressed[0]).toMatchObject({ email: 'gone@example.com', reason: 'hard_bounce' });
        });

        /*
         * A full mailbox is temporary. Suppressing it would lose a real
         * passenger permanently over a condition that clears itself.
         */
        it.each(['Transient', 'soft'])('does NOT suppress on a %s bounce', async (kind) => {
            const S = load();
            recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'sent' });
            await S.handle('a', ev('email.bounced', {
                email_id: 'm1', to: ['full@example.com'], bounce: { type: kind, message: 'mailbox full' },
            }));
            expect(recipients[0].status).toBe('soft_bounced');
            expect(suppressed).toHaveLength(0);
        });

        it('treats an unrecognised bounce type as soft', async () => {
            const S = load();
            recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'sent' });
            await S.handle('a', ev('email.bounced', { email_id: 'm1', to: ['x@example.com'], bounce: {} }));
            expect(recipients[0].status).toBe('soft_bounced');
            expect(suppressed).toHaveLength(0);
        });
    });

    describe('complaints', () => {
        it('suppresses and withdraws consent on every channel', async () => {
            const S = load();
            recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'delivered' });
            users.push({ id: 'u1', email: 'annoyed@example.com' });

            await S.handle('a', ev('email.complained', { email_id: 'm1', to: ['annoyed@example.com'] }));

            expect(recipients[0].status).toBe('complained');
            expect(suppressed[0]).toMatchObject({ reason: 'complaint' });
            expect(prefsWritten).toHaveLength(1);
            expect(prefsWritten[0].input).toEqual({
                marketing: false, marketingEmail: false, marketingPush: false,
                marketingInApp: false, marketingSms: false,
            });
        });

        /*
         * Safety announcements and operational notifications are not marketing.
         * Someone who reported an offer as spam still needs to be told their
         * driver has arrived.
         */
        it('does not touch safety or operational preferences', async () => {
            const S = load();
            users.push({ id: 'u1', email: 'annoyed@example.com' });
            await S.handle('a', ev('email.complained', { email_id: 'm1', to: ['annoyed@example.com'] }));
            expect(prefsWritten[0].input).not.toHaveProperty('safetyAnnouncements');
        });

        it('still suppresses when the address has no passenger account', async () => {
            const S = load();
            await S.handle('a', ev('email.complained', { email_id: 'm1', to: ['stranger@example.com'] }));
            expect(suppressed).toHaveLength(1);
            expect(prefsWritten).toHaveLength(0);
        });
    });

    describe('unsubscribes', () => {
        it('mirrors a provider-side unsubscribe into our own preferences', async () => {
            const S = load();
            users.push({ id: 'u1', email: 'bye@example.com' });
            await S.handle('a', ev('contact.updated', { email: 'bye@example.com', unsubscribed: true }));
            expect(suppressed[0]).toMatchObject({ reason: 'unsubscribe' });
            expect(prefsWritten[0].input.marketing).toBe(false);
        });

        it('ignores a contact update that is not an unsubscribe', async () => {
            const S = load();
            users.push({ id: 'u1', email: 'bye@example.com' });
            const r = await S.handle('a', ev('contact.updated', { email: 'bye@example.com', unsubscribed: false }));
            expect(suppressed).toHaveLength(0);
            expect(r.outcome).toMatch(/not an unsubscribe/);
        });
    });

    describe('what it refuses to do', () => {
        /*
         * Transactional mail — OTPs, receipts, password resets — has no
         * campaign row. Those events must land harmlessly, not raise errors
         * that would make the provider retry and eventually disable us.
         */
        it('handles an event for transactional mail without error', async () => {
            const S = load();
            const r = await S.handle('a', ev('email.delivered', { email_id: 'otp-123' }));
            expect(r.accepted).toBe(true);
            expect(r.outcome).toMatch(/likely transactional/);
        });

        /*
         * Resend does not promise ordering. A late `sent` arriving after a
         * `bounced` must not make a suppressed address look deliverable.
         */
        it('does not walk a terminal state backwards', async () => {
            const S = load();
            recipients.push({ id: 'r1', providerMessageId: 'm1', status: 'hard_bounced' });
            const r = await S.handle('a', ev('email.sent', { email_id: 'm1' }));
            expect(recipients[0].status).toBe('hard_bounced');
            expect(r.outcome).toMatch(/out-of-order/);
        });

        it('stores an unrecognised event type and does nothing', async () => {
            const S = load();
            const r = await S.handle('a', ev('email.something_new', { email_id: 'm1' }));
            expect(events).toHaveLength(1);
            expect(r.outcome).toMatch(/ignored/);
        });

        /*
         * The containment guarantee. A failure while processing is recorded on
         * the event row and goes no further — the route has already answered,
         * and nothing on the sending path is waiting on this.
         */
        it('records a processing failure instead of throwing', async () => {
            const S = load();
            recipients.push({
                get id() { throw new Error('database exploded'); },
                providerMessageId: 'm1',
            });
            const r = await S.handle('a', ev('email.delivered', { email_id: 'm1' }));
            expect(r.accepted).toBe(true);
            expect(r.outcome).toMatch(/^error:/);
            expect(events[0].processedAt).toBeTruthy();
        });

        it('never writes to a table outside communications', async () => {
            const S = load();
            users.push({ id: 'u1', email: 'annoyed@example.com' });
            // The mocked getRepository throws for anything but the three
            // communications repositories, so reaching a ride, wallet or
            // payment table would fail this test rather than pass silently.
            await S.handle('a', ev('email.complained', { email_id: 'm1', to: ['annoyed@example.com'] }));
            expect(events[0].outcome).not.toMatch(/^error:/);
        });
    });
});
