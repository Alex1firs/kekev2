/**
 * The emergency stop, and what it must never be able to reach.
 *
 * A screen with a big red button is one keystroke from disaster if the button
 * accepts the wrong name. These tests are about the set of things it accepts.
 */

import { CommunicationsDashboardService } from '../../src/services/communications_dashboard_service';

const store = new Map<string, string>();

jest.mock('../../src/config/redis', () => ({
    redis: {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
        del: async (k: string) => { store.delete(k); return 1; },
        setex: async (k: string, _t: number, v: string) => { store.set(k, v); return 'OK'; },
    },
}));
jest.mock('../../src/config/data_source', () => ({
    AppDataSource: { getRepository: () => ({ createQueryBuilder: () => ({ select: () => ({}) }) }) },
}));
jest.mock('../../src/services/operational_push_health', () => ({
    OperationalPushHealth: {
        pauseMarketing: async () => undefined,
        resumeMarketing: async () => undefined,
        health: async () => ({ healthy: true, attempts: 0, failures: 0, failureRate: 0, avgLatencyMs: null, reasons: [] }),
    },
}));

beforeEach(() => store.clear());

describe('what can be paused', () => {
    it.each(['all', 'email', 'push', 'in_app', 'sms'] as const)('pauses %s', async (channel) => {
        const r = await CommunicationsDashboardService.pause(channel, 'test', 'staff-1');
        expect(r.paused).toBe(true);
        expect(await CommunicationsDashboardService.channelPaused(channel === 'all' ? 'push' : channel)).toBe(true);
    });

    it('pausing all stops every marketing channel', async () => {
        await CommunicationsDashboardService.pause('all', 'incident', 'staff-1');
        for (const c of ['email', 'push', 'in_app', 'sms']) {
            expect(await CommunicationsDashboardService.channelPaused(c)).toBe(true);
        }
    });

    it('resumes individually without lifting the others', async () => {
        await CommunicationsDashboardService.pause('email', 'x', 's');
        await CommunicationsDashboardService.pause('push', 'x', 's');
        await CommunicationsDashboardService.resume('email');

        expect(await CommunicationsDashboardService.channelPaused('email')).toBe(false);
        expect(await CommunicationsDashboardService.channelPaused('push')).toBe(true);
    });
});

describe('what can NEVER be paused', () => {
    /*
     * The guarantee the screen depends on. No value of `channel` reaches an
     * operational notification, so no mis-click and no crafted request can
     * silence a ride alert.
     */
    it.each([
        'operational', 'ride', 'otp', 'sos', 'NEW_REQUEST', 'transactional',
        'all_notifications', '*',
    ])('refuses %p', async (channel) => {
        await expect(CommunicationsDashboardService.pause(channel as any, 'x', 's'))
            .rejects.toThrow(/cannot be paused|Unknown channel/i);
    });

    it('says so in the error, so the refusal is understood', async () => {
        await expect(CommunicationsDashboardService.pause('operational' as any, 'x', 's'))
            .rejects.toThrow(/Operational notifications cannot be paused/);
    });
});

describe('failure direction', () => {
    /*
     * If the pause state cannot be read we assume paused. A marketing message
     * not sent costs nothing; one sent during an emergency stop costs the trust
     * the button existed to protect.
     */
    it('treats an unreadable pause state as paused', async () => {
        const redis = require('../../src/config/redis').redis;
        const original = redis.get;
        redis.get = async () => { throw new Error('redis down'); };

        expect(await CommunicationsDashboardService.channelPaused('push')).toBe(true);
        redis.get = original;
    });
});

describe('the pause records who and why', () => {
    it('stores the reason, the actor and the time', async () => {
        await CommunicationsDashboardService.pause('push', 'FCM incident', 'staff-9');
        const states = await CommunicationsDashboardService.pauseStates();
        expect(states.push.paused).toBe(true);
        expect(states.push.reason).toBe('FCM incident');
        expect(states.push.by).toBe('staff-9');
        expect(states.push.at).toBeTruthy();
    });
});

describe('the audience seam', () => {
    /*
     * The future-expansion guarantee, stated as a test: a campaign addressed to
     * an audience that has no consent record must fail rather than quietly
     * resolving to passengers.
     */
    const { REGISTERED_AUDIENCES } = require('../../src/services/audience_service');

    it('registers passengers and nothing else yet', () => {
        expect(Array.from(REGISTERED_AUDIENCES)).toEqual(['passenger']);
    });

    it.each(['driver', 'dispatcher', 'supervisor', 'staff', 'partner'])(
        'does not register %s', (t) => expect(REGISTERED_AUDIENCES.has(t)).toBe(false));
});
