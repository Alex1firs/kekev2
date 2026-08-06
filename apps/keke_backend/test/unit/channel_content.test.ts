/**
 * Channel content rules — the ones that cost money or get truncated.
 *
 * SMS segmentation is the sharp one: a single pasted curly quote switches the
 * whole message to Unicode and more than doubles the price of a campaign.
 * Estimating segments from string length would hide that entirely.
 */

import {
    analyseSms, validateChannelContent, channelDefaults,
    PUSH_TITLE_SOFT_LIMIT,
} from '../../src/services/channel_content';
import { CampaignChannelKind } from '../../src/models/CommunicationCampaign';

describe('SMS segmentation', () => {
    it('counts a short GSM-7 message as one segment', () => {
        const r = analyseSms('KekeRide: 30% off this weekend. Reply STOP to opt out.');
        expect(r.encoding).toBe('GSM-7');
        expect(r.segments).toBe(1);
    });

    it('splits at 160, then at 153 per part because each carries a header', () => {
        expect(analyseSms('a'.repeat(160)).segments).toBe(1);
        expect(analyseSms('a'.repeat(161)).segments).toBe(2);
        expect(analyseSms('a'.repeat(306)).segments).toBe(2);
        expect(analyseSms('a'.repeat(307)).segments).toBe(3);
    });

    /*
     * The expensive surprise. One character outside GSM-7 — an emoji, a curly
     * quote pasted from a document — drops the limit from 160 to 70 for the
     * WHOLE message.
     */
    it('falls back to Unicode on a single foreign character, and says which', () => {
        const r = analyseSms('KekeRide: 30% off 🎉');
        expect(r.encoding).toBe('UCS-2');
        expect(r.segments).toBe(1);
        expect(r.nonGsmCharacters).toContain('🎉');

        // The same text in GSM-7 would be one segment; in Unicode it is two.
        const long = analyseSms('a'.repeat(100) + '🎉');
        expect(long.encoding).toBe('UCS-2');
        expect(long.segments).toBe(2);
    });

    it('bills an escaped character as two', () => {
        // '€' needs an escape in GSM-7, so 80 of them fill 160 slots.
        expect(analyseSms('€'.repeat(80)).segments).toBe(1);
        expect(analyseSms('€'.repeat(81)).segments).toBe(2);
    });

    it('reports an empty message as zero segments, not one', () => {
        expect(analyseSms('').segments).toBe(0);
    });
});

describe('content validation', () => {
    it('requires a subject and body on email', () => {
        const issues = validateChannelContent(CampaignChannelKind.EMAIL, {});
        expect(issues.filter((i) => i.severity === 'error').map((i) => i.field))
            .toEqual(expect.arrayContaining(['subject', 'body']));
    });

    /*
     * A campaign must not be a way to send passengers anywhere on the internet.
     * Only kekeride.ng and the app's own scheme.
     */
    it.each([
        ['https://evil.example.com/offer', true],
        ['http://kekeride.ng/app', true],
        ['https://kekeride.ng.attacker.com', true],
        ['https://kekeride.ng/app', false],
        ['https://www.kekeride.ng/offers', false],
    ])('rejects %s as a CTA link: %s', (url, shouldError) => {
        const issues = validateChannelContent(CampaignChannelKind.EMAIL,
            { subject: 'x', body: 'y', ctaUrl: url });
        const hasError = issues.some((i) => i.field === 'ctaUrl' && i.severity === 'error');
        expect(hasError).toBe(shouldError);
    });

    it('warns rather than blocks on a long push title', () => {
        const issues = validateChannelContent(CampaignChannelKind.PUSH, {
            title: 'x'.repeat(PUSH_TITLE_SOFT_LIMIT + 10), body: 'ok',
        });
        const t = issues.find((i) => i.field === 'title');
        // Too long is not invalid — it is going to be cut, and the writer
        // should be told which.
        expect(t?.severity).toBe('warning');
    });

    it('accepts the app scheme as a push deep link', () => {
        const issues = validateChannelContent(CampaignChannelKind.PUSH, {
            title: 'a', body: 'b', deepLink: 'kekeride://offers',
        });
        expect(issues.some((i) => i.field === 'deepLink')).toBe(false);
    });

    /*
     * An in-app message with no end date runs forever, and a passenger who has
     * seen it forty times has no way to stop it.
     */
    it('requires an end date and a frequency cap on in-app', () => {
        const issues = validateChannelContent(CampaignChannelKind.IN_APP, { title: 'Hi' });
        const fields = issues.filter((i) => i.severity === 'error').map((i) => i.field);
        expect(fields).toEqual(expect.arrayContaining(['endsAt', 'frequencyCap']));
    });

    it('warns when an SMS has no opt-out', () => {
        const issues = validateChannelContent(CampaignChannelKind.SMS, { body: 'Cheap rides today' });
        expect(issues.some((i) => /opt out/i.test(i.message))).toBe(true);
    });

    it('warns about multi-segment cost before it is sent', () => {
        const issues = validateChannelContent(CampaignChannelKind.SMS, {
            body: 'a'.repeat(200) + ' Reply STOP',
        });
        expect(issues.some((i) => /billed as \d+ messages/.test(i.message))).toBe(true);
    });
});

describe('defaults', () => {
    it.each([
        CampaignChannelKind.EMAIL, CampaignChannelKind.PUSH,
        CampaignChannelKind.IN_APP, CampaignChannelKind.SMS,
    ])('%s starts with a usable shape', (channel) => {
        expect(Object.keys(channelDefaults(channel)).length).toBeGreaterThan(0);
    });

    it('gives in-app a frequency cap out of the box', () => {
        expect(channelDefaults(CampaignChannelKind.IN_APP).frequencyCap).toBeGreaterThan(0);
    });
});
