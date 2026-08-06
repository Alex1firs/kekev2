/**
 * Template rendering, personalisation fallbacks and the plain-text alternative.
 *
 * The failures worth guarding here are the embarrassing ones — "Hello null",
 * "Hello {{firstName}}", a missing unsubscribe link — and the dangerous one:
 * personal data reaching a marketing email.
 */

import { render, renderTemplate, TEMPLATES, templateByKey } from '../../src/services/email_templates';

const ctx = (overrides: any = {}) => ({
    content: { headline: 'Hello', body: 'Body copy.', ...(overrides.content ?? {}) },
    personalisation: overrides.personalisation ?? {},
    unsubscribeUrl: 'https://api.kekeride.ng/comms/unsubscribe?token=abc',
    preferencesUrl: 'https://api.kekeride.ng/comms/preferences?token=abc',
    supportEmail: 'support@kekeride.ng',
    previewText: overrides.previewText ?? null,
});

describe('personalisation fallbacks', () => {
    it.each([
        [{ firstName: null }, 'there'],
        [{ firstName: '' }, 'there'],
        [{ firstName: '   ' }, 'there'],
        [{ firstName: 'Chidi' }, 'Chidi'],
    ])('renders %p as a greeting containing %p', (p, expected) => {
        expect(render('Hello {{firstName}},', p as any)).toBe(`Hello ${expected},`);
    });

    it('never emits the words null or undefined', () => {
        const out = render('Hi {{firstName}} from {{city}} — code {{promoCode}}', {
            firstName: null, city: undefined as any, promoCode: null,
        });
        expect(out).not.toMatch(/null|undefined/i);
    });

    /*
     * A typo in a template must not reach an inbox as raw syntax. Anything
     * still shaped like a placeholder after substitution is removed.
     */
    it('strips an unknown placeholder rather than delivering it', () => {
        const out = render('Hello {{frstName}} and {{internalUserId}}', { firstName: 'Chidi' });
        expect(out).not.toContain('{{');
        expect(out).not.toContain('}}');
        expect(out).not.toContain('frstName');
    });

    it('substitutes only the approved variables', () => {
        // `password` is not on the allow-list, so it can never be interpolated
        // even if a template author writes it.
        const out = render('{{password}}|{{email}}|{{firstName}}', { firstName: 'Ada' } as any);
        expect(out).toBe('||Ada');
    });

    it('handles whitespace inside the braces', () => {
        expect(render('Hi {{  firstName  }}', { firstName: 'Ada' })).toBe('Hi Ada');
    });
});

describe('every template', () => {
    /*
     * Deliberately not a fixed count. This asserted `toHaveLength(8)` and broke
     * the moment the library grew — a test that fails for adding a template is
     * testing the wrong thing. What matters is that every template carries a
     * consent category and a unique key.
     */
    it('every template has a valid consent category', () => {
        expect(TEMPLATES.length).toBeGreaterThanOrEqual(8);
        for (const t of TEMPLATES) {
            expect(['promotionalOffers', 'productUpdates', 'safetyAnnouncements']).toContain(t.category);
        }
    });

    it('every template key is unique', () => {
        const keys = TEMPLATES.map((t) => t.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    /*
     * Category is bound to the template, not chosen per campaign. Otherwise a
     * discount could be sent under the safety-announcement exemption — the one
     * category that does not require marketing consent.
     */
    it('binds the safety notice to the safety category, and offers to marketing', () => {
        expect(templateByKey('safety_notice')!.category).toBe('safetyAnnouncements');
        expect(templateByKey('promotional_offer')!.category).toBe('promotionalOffers');
        expect(templateByKey('reactivation')!.category).toBe('promotionalOffers');
    });

    it.each(TEMPLATES.map((t) => t.key))('%s renders both HTML and plain text', (key) => {
        const out = renderTemplate(key, ctx());
        expect(out.html.length).toBeGreaterThan(200);
        expect(out.text.length).toBeGreaterThan(40);
    });

    it.each(TEMPLATES.map((t) => t.key))('%s carries an unsubscribe link in BOTH parts', (key) => {
        const out = renderTemplate(key, ctx());
        // A passenger reading the text version must have the same way out as
        // one reading the HTML.
        expect(out.html).toContain('/comms/unsubscribe');
        expect(out.text).toContain('/comms/unsubscribe');
        expect(out.html).toContain('/comms/preferences');
        expect(out.text).toContain('/comms/preferences');
    });

    it.each(TEMPLATES.map((t) => t.key))('%s leaves no template syntax in the output', (key) => {
        const t = templateByKey(key)!;
        const out = renderTemplate(key, ctx({ content: t.defaults, personalisation: {} }));
        expect(out.html).not.toContain('{{');
        expect(out.text).not.toContain('{{');
    });
});

describe('email-client compatibility', () => {
    /*
     * Outlook renders through Word and Gmail strips <style> from forwarded
     * mail. Tables with inline styles are the only construction that lands the
     * same everywhere.
     */
    it('uses table layout and inline styles, not flexbox or a stylesheet', () => {
        const out = renderTemplate('promotional_offer', ctx());
        expect(out.html).toContain('<table');
        expect(out.html).toContain('style="');
        expect(out.html).not.toMatch(/display:\s*flex/);
        expect(out.html).not.toMatch(/<link[^>]+stylesheet/);
    });

    it('constrains the width so it fits a phone', () => {
        expect(renderTemplate('welcome', ctx())).toHaveProperty('html');
        expect(renderTemplate('welcome', ctx()).html).toContain('max-width:600px');
    });

    it('hides the preview text from the body but includes it for the inbox list', () => {
        const out = renderTemplate('welcome', ctx({ previewText: 'A free ride awaits' }));
        expect(out.html).toContain('A free ride awaits');
        expect(out.html).toMatch(/display:none[^"]*overflow:hidden/);
    });
});

describe('content safety', () => {
    it('escapes HTML in staff-written copy', () => {
        const out = renderTemplate('announcement', ctx({
            content: { headline: '<script>alert(1)</script>', body: 'Fine.' },
        }));
        expect(out.html).not.toContain('<script>');
        expect(out.html).toContain('&lt;script&gt;');
    });

    /*
     * Marketing mail is forwarded, screenshotted and read over shoulders. It
     * gets a first name and a promo code — never a ride, a fare, an address or
     * an identifier.
     */
    it('exposes no ride, fare, address or identifier', () => {
        const out = renderTemplate('reactivation', ctx({
            personalisation: { firstName: 'Chidi', completedRides: 12 },
        }));
        const all = `${out.html} ${out.text}`;
        expect(all).not.toMatch(/passengerId|userId|rideId|driverId/i);
        expect(all).not.toMatch(/\bfare\b/i);
        expect(all).not.toMatch(/pickup|destination/i);
    });

    it('omits a call-to-action button that has no destination', () => {
        const out = renderTemplate('announcement', ctx({
            content: { headline: 'Hi', body: 'Text.', ctaLabel: 'Book now', ctaUrl: '' },
        }));
        // A button pointing nowhere is worse than no button.
        expect(out.html).not.toContain('Book now');
    });

    it('renders the promo block only when there is a code', () => {
        expect(renderTemplate('promotional_offer', ctx()).html).not.toContain('Your code');
        const withCode = renderTemplate('promotional_offer', ctx({
            content: { promoCode: 'KEKE500', promoExpiry: '31 August' },
        }));
        expect(withCode.html).toContain('KEKE500');
        expect(withCode.text).toContain('KEKE500');
        expect(withCode.html).toContain('31 August');
    });
});
