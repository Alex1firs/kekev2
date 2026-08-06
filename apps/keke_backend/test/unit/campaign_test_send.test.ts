/**
 * A test send must be structurally incapable of reaching a passenger.
 *
 * Two independent guarantees, and these tests cover both: the recipient list
 * never comes from the audience, and every address is checked against the
 * passenger table regardless of who typed it.
 */

import { CampaignTestSend } from '../../src/services/campaign_test_send';

const users: any[] = [];
const staff: any[] = [];
const sent: any[] = [];

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            const store = name === 'StaffUser' ? staff : users;
            return {
                find: async (opts: any = {}) => {
                    if (!opts.where) return store;
                    const w = opts.where;
                    return store.filter((r) => {
                        const emailMatch = w.email?._value
                            ? w.email._value.includes(r.email)
                            : true;
                        const roleMatch = w.role ? r.role === w.role : true;
                        return emailMatch && roleMatch;
                    });
                },
                createQueryBuilder: () => {
                    const qb: any = {
                        where: () => qb, andWhere: () => qb,
                        getCount: async () => store.length,
                        select: () => qb, getRawOne: async () => ({ n: '0' }),
                    };
                    return qb;
                },
            };
        },
    },
}));

jest.mock('../../src/services/multichannel_campaign_service', () => ({
    MultiChannelCampaignService: {
        get: async () => ({ id: 'c1', name: 'Weekend offer' }),
        previews: async () => ({
            email: { subject: 'Weekend offer', html: '<p>hi</p>', text: 'hi' },
        }),
        markTested: async () => undefined,
    },
}));

jest.mock('../../src/services/email_provider', () => ({
    emailProvider: () => ({
        send: async (m: any) => { sent.push(m); return { ok: true, messageId: 'm1' }; },
    }),
    senderIdentity: () => ({ fromName: 'KekeRide', fromAddress: 'noreply@kekeride.ng', replyTo: 's@kekeride.ng' }),
}));

jest.mock('../../src/services/audit_service', () => ({
    AuditService: { recordCritical: async () => undefined },
}));

const ACTOR = { staffUserId: 'staff-1', roles: [], isLegacy: false } as any;

beforeEach(() => {
    users.length = 0; staff.length = 0; sent.length = 0;
    staff.push({ email: 'ops@kekeride.ng' }, { email: 'alex@kekeride.ng' });
    users.push({ email: 'chidi@gmail.com', role: 'passenger' });
});

describe('the passenger guarantee', () => {
    /*
     * The whole point. A staff member typing a customer's address by hand is
     * exactly how a "test" reaches somebody who never consented.
     */
    it('refuses an address belonging to a passenger', async () => {
        await expect(CampaignTestSend.send(ACTOR, 'c1', ['chidi@gmail.com']))
            .rejects.toThrow(/belongs to a passenger/i);
        expect(sent).toHaveLength(0);
    });

    it('refuses a passenger address even when mixed with a valid staff one', async () => {
        const r = await CampaignTestSend.send(ACTOR, 'c1', ['ops@kekeride.ng', 'chidi@gmail.com']);
        expect(r.sent.map((s) => s.address)).toEqual(['ops@kekeride.ng']);
        expect(r.refused).toContainEqual({ address: 'chidi@gmail.com', reason: 'belongs_to_a_passenger' });
        // The passenger got nothing.
        expect(sent.map((m) => m.to)).not.toContain('chidi@gmail.com');
    });

    /*
     * An arbitrary external address is the other route to a non-consenting
     * inbox, and "I was only testing" is not a defence the recipient accepts.
     */
    it('refuses an external address that is neither staff nor kekeride.ng', async () => {
        await expect(CampaignTestSend.send(ACTOR, 'c1', ['someone@example.com']))
            .rejects.toThrow(/no usable test address/i);
    });

    it('allows a kekeride.ng address that has no staff account yet', async () => {
        const r = await CampaignTestSend.send(ACTOR, 'c1', ['newhire@kekeride.ng']);
        expect(r.sent).toHaveLength(1);
    });
});

describe('limits and shape', () => {
    it('caps the number of test recipients', async () => {
        const many = Array.from({ length: 11 }, (_, i) => `t${i}@kekeride.ng`);
        await expect(CampaignTestSend.send(ACTOR, 'c1', many))
            .rejects.toThrow(/at most 10/i);
    });

    it('requires at least one address', async () => {
        await expect(CampaignTestSend.send(ACTOR, 'c1', []))
            .rejects.toThrow(/at least one/i);
    });

    it('marks the subject so a forward cannot be mistaken for a live campaign', async () => {
        await CampaignTestSend.send(ACTOR, 'c1', ['ops@kekeride.ng']);
        expect(sent[0].subject).toMatch(/^\[TEST\]/);
    });

    it('de-duplicates and lower-cases addresses', async () => {
        const r = await CampaignTestSend.send(ACTOR, 'c1', ['OPS@kekeride.ng', 'ops@kekeride.ng']);
        expect(r.sent).toHaveLength(1);
    });

    /*
     * The structural half of the guarantee: this module has no way to reach the
     * audience, so even a bug in the address checks could not turn a test into
     * a campaign.
     */
    it('does not import the audience service at all', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/campaign_test_send.ts'), 'utf8');
        expect(source).not.toMatch(/from '\.\/audience_service'/);
        expect(source).not.toMatch(/AudienceService\./);
    });
});
