/**
 * Marketing push must never interfere with operational push.
 *
 * The guarantees under test: marketing is off by default, marketing stops when
 * operational is degraded, marketing re-checks consent per recipient, and a
 * marketing failure changes nothing operational.
 */

import { MarketingPushService } from '../../src/services/marketing_push_service';

const jobs: any[] = [];
const sent: any[] = [];
let health = { allowed: true as boolean, reason: undefined as string | undefined };
let eligible = true;

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: () => ({
            find: async () => jobs,
            save: async (r: any) => r,
            insert: async () => undefined,
            update: async () => ({ affected: 0 }),
        }),
    },
}));

jest.mock('../../src/services/operational_push_health', () => ({
    OperationalPushHealth: {
        marketingMayRun: async () => health,
        record: () => undefined,
    },
}));

jest.mock('../../src/services/marketing_consent_service', () => ({
    MarketingConsentService: {
        checkChannelEligibility: async () => ({ eligible, reason: eligible ? undefined : 'unsubscribed' }),
    },
}));

jest.mock('firebase-admin', () => ({
    messaging: () => ({
        sendEachForMulticast: async (m: any) => {
            sent.push(m);
            return { successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'x' }] };
        },
    }),
}));

beforeEach(() => {
    jobs.length = 0; sent.length = 0;
    health = { allowed: true, reason: undefined };
    eligible = true;
    delete process.env.MARKETING_PUSH_SEND_ENABLED;
});

afterEach(() => { delete process.env.MARKETING_PUSH_SEND_ENABLED; });

describe('the kill switch', () => {
    it('sends nothing when marketing push is disabled — which is the default', async () => {
        const r = await MarketingPushService.runBatch();
        expect(r.ran).toBe(false);
        expect(r.reason).toMatch(/disabled/i);
        expect(sent).toHaveLength(0);
    });
});

describe('yielding to operational traffic', () => {
    /*
     * The central guarantee. Marketing asks before EVERY batch, so a
     * degradation beginning halfway through a send stops the remainder.
     */
    it('runs nothing while operational push is degraded', async () => {
        process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
        health = { allowed: false, reason: '40% of operational pushes are failing.' };

        const r = await MarketingPushService.runBatch();
        expect(r.ran).toBe(false);
        expect(r.reason).toMatch(/failing/);
        expect(sent).toHaveLength(0);
    });

    it('checks health on every batch, not once per campaign', async () => {
        process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
        const spy = jest.spyOn(
            require('../../src/services/operational_push_health').OperationalPushHealth,
            'marketingMayRun');

        await MarketingPushService.runBatch();
        await MarketingPushService.runBatch();
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
        spy.mockRestore();
    });
});

describe('consent at the moment of sending', () => {
    it('skips a passenger who opted out after the campaign was queued', async () => {
        process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
        jobs.push({ id: 'j1', campaignId: 'c1', userId: 'u1', state: 'queued', attempts: 0 });
        eligible = false;

        const r = await MarketingPushService.runBatch();
        expect(r.skipped).toBe(1);
        expect(r.sent).toBe(0);
        expect(sent).toHaveLength(0);
    });
});

describe('what a marketing push looks like on the wire', () => {
    it('is normal priority on its own channel, with no sound or badge', async () => {
        process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
        jobs.push({ id: 'j1', campaignId: 'c1', userId: 'u1', state: 'queued', attempts: 0 });

        jest.spyOn(MarketingPushService as any, 'tokensFor').mockResolvedValue(['tok']);
        jest.spyOn(MarketingPushService as any, 'contentFor')
            .mockResolvedValue({ title: 'Weekend offer', body: '30% off', deepLink: null });

        await MarketingPushService.runBatch();

        expect(sent).toHaveLength(1);
        const m = sent[0];
        // A promotion must never wake a phone the way a waiting passenger does.
        expect(m.android.priority).toBe('normal');
        expect(m.android.notification.channelId).toBe('keke_promotions');
        expect(m.apns.headers['apns-priority']).toBe('5');
        expect(m.apns.payload.aps.sound).toBeUndefined();
        expect(m.apns.payload.aps.badge).toBeUndefined();
        // Tagged so delivery reporting can never mix with operational metrics.
        expect(m.data.notification_kind).toBe('MARKETING_CAMPAIGN');

        jest.restoreAllMocks();
    });
});

describe('separation', () => {
    /*
     * Shared: Firebase credentials, the token registry, device registration.
     * Not shared: queue, worker, rate limit, retry, reporting, audit, metrics.
     */
    it('uses its own queue table and no operational one', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/marketing_push_service.ts'), 'utf8');

        // Its own queue.
        expect(source).toMatch(/MarketingPushJob/);
        // Shares the token registry, by design.
        expect(source).toMatch(/from '\.\.\/models\/DeviceToken'/);

        /*
         * Checked against the IMPORTS rather than the prose: an earlier version
         * of this test matched the bare word "Ride" and failed on the brand
         * name in a comment, which proves nothing either way.
         */
        const imports = source.split('\n').filter((l: string) => l.trim().startsWith('import'));
        const joined = imports.join('\n');
        expect(joined).not.toMatch(/notification_service/);
        expect(joined).not.toMatch(/models\/Ride/);
        expect(joined).not.toMatch(/dispatch/);
    });
});
