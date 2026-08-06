/**
 * The KekeRide marketing email design system.
 *
 * ── Table layout and inline styles, on purpose ───────────────────────────
 * This looks like 2005 HTML because email clients are 2005 browsers. Outlook
 * renders through Word, Gmail strips <style> blocks from forwarded mail, and
 * flexbox is unavailable in enough places to be useless. Tables with inline
 * styles are the only construction that lands the same everywhere, and a
 * "modern" rewrite is how a campaign arrives as a column of unstyled text on
 * the cheap Android handsets most KekeRide passengers read mail on.
 *
 * ── Every variable has a fallback ────────────────────────────────────────
 * A passenger whose first name is missing gets "Hello there", never "Hello ",
 * "Hello null" or "Hello {{firstName}}". `render` substitutes only from an
 * allow-list and strips any placeholder that survives, so an unknown token can
 * never reach an inbox as raw template syntax.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 * No ride history, no addresses, no fares, no driver names, no identifiers.
 * Marketing mail is forwarded, screenshotted and read over shoulders; it gets
 * a first name and a promo code and nothing that would matter if it leaked.
 */

const BRAND = {
    ink: '#1a1a2e',
    amber: '#f5c518',
    paper: '#ffffff',
    wash: '#f4f4f5',
    body: '#3f4654',
    muted: '#6b7280',
    line: '#e5e7eb',
};

/** Values a template may use. Anything else is not substituted. */
export interface Personalisation {
    firstName?: string | null;
    city?: string | null;
    promoCode?: string | null;
    promoExpiry?: string | null;
    completedRides?: number | null;
    ctaUrl?: string | null;
}

export interface TemplateContent {
    headline?: string;
    body?: string;
    imageUrl?: string | null;
    ctaLabel?: string | null;
    ctaUrl?: string | null;
    promoCode?: string | null;
    promoExpiry?: string | null;
    /** Small print under the button — terms, expiry, conditions. */
    footnote?: string | null;
}

export interface RenderContext {
    content: TemplateContent;
    personalisation: Personalisation;
    unsubscribeUrl: string;
    preferencesUrl: string;
    supportEmail: string;
    /** Shown above the fold in an inbox list. */
    previewText?: string | null;
}

/** HTML-escape. Campaign copy is written by staff, not trusted blindly. */
function esc(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Substitute `{{token}}` from the allow-list, then remove any that remain.
 *
 * The final strip is what guarantees a passenger never sees template syntax:
 * a typo'd `{{frstName}}` becomes nothing rather than being delivered verbatim.
 */
export function render(text: string, p: Personalisation): string {
    const values: Record<string, string> = {
        firstName: (p.firstName ?? '').trim() || 'there',
        city: (p.city ?? '').trim() || 'your area',
        promoCode: (p.promoCode ?? '').trim(),
        promoExpiry: (p.promoExpiry ?? '').trim(),
        completedRides: p.completedRides != null ? String(p.completedRides) : '',
        ctaUrl: (p.ctaUrl ?? '').trim(),
    };

    return String(text ?? '')
        .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, key: string) =>
            Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '')
        // Anything still looking like a placeholder goes, whatever its shape.
        .replace(/\{\{[^}]*\}\}/g, '')
        .trim();
}

/** A button that survives Outlook, which ignores padding on anchors. */
function button(label: string, url: string): string {
    return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin:28px 0;">
      <tr>
        <td align="center" bgcolor="${BRAND.amber}" style="border-radius:10px;">
          <a href="${esc(url)}" target="_blank"
             style="display:inline-block;padding:16px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;font-weight:700;color:${BRAND.ink};text-decoration:none;border-radius:10px;">
            ${esc(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function promoBlock(code: string, expiry?: string | null): string {
    return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0;">
      <tr>
        <td align="center" style="background-color:${BRAND.wash};border:2px dashed ${BRAND.line};border-radius:12px;padding:22px 16px;">
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:${BRAND.muted};letter-spacing:2px;text-transform:uppercase;">Your code</p>
          <div style="font-size:30px;font-weight:800;letter-spacing:5px;color:${BRAND.ink};">${esc(code)}</div>
          ${expiry ? `<p style="margin:10px 0 0;font-size:13px;color:${BRAND.muted};">Valid until ${esc(expiry)}</p>` : ''}
        </td>
      </tr>
    </table>`;
}

/**
 * The shell every marketing email shares.
 *
 * 600px is the widest that reliably fits a phone without horizontal scroll once
 * clients apply their own padding.
 */
function shell(inner: string, ctx: RenderContext): string {
    const preview = ctx.previewText
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(ctx.previewText)}</div>`
        : '';

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>KekeRide</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.wash};">
${preview}
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:${BRAND.wash};padding:28px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">

      <tr>
        <td align="center" style="background-color:${BRAND.ink};border-radius:16px 16px 0 0;padding:26px 30px;">
          <span style="display:inline-block;background-color:${BRAND.amber};border-radius:10px;padding:8px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:19px;font-weight:800;color:${BRAND.ink};letter-spacing:0.5px;">
            KekeRide
          </span>
        </td>
      </tr>

      <tr>
        <td style="background-color:${BRAND.paper};padding:34px 30px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
          ${inner}
        </td>
      </tr>

      <tr>
        <td style="background-color:${BRAND.paper};border-top:1px solid ${BRAND.line};border-radius:0 0 16px 16px;padding:22px 30px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
          <p style="margin:0 0 10px;font-size:13px;color:${BRAND.muted};line-height:1.6;">
            Questions? Reach us at
            <a href="mailto:${esc(ctx.supportEmail)}" style="color:${BRAND.ink};">${esc(ctx.supportEmail)}</a>.
          </p>
          <p style="margin:0 0 10px;font-size:12px;color:${BRAND.muted};line-height:1.6;">
            <a href="${esc(ctx.preferencesUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Choose what we send you</a>
            &nbsp;·&nbsp;
            <a href="${esc(ctx.unsubscribeUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe</a>
          </p>
          <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;">
            KekeRide · Anambra State, Nigeria<br />
            You are receiving this because you asked us to send you updates.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function heading(text: string): string {
    return `<h1 style="margin:0 0 14px;font-size:23px;line-height:1.3;font-weight:800;color:${BRAND.ink};">${esc(text)}</h1>`;
}

function paragraphs(body: string): string {
    return String(body ?? '').split(/\n{2,}/).filter((s) => s.trim()).map(
        (para) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BRAND.body};">${esc(para.trim()).replace(/\n/g, '<br />')}</p>`,
    ).join('');
}

function image(url: string): string {
    return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 22px;">
      <tr><td>
        <img src="${esc(url)}" alt="" width="540"
             style="display:block;width:100%;max-width:540px;height:auto;border:0;border-radius:12px;" />
      </td></tr>
    </table>`;
}

export interface EmailTemplate {
    key: string;
    name: string;
    description: string;
    /** Which consent category a campaign on this template belongs to. */
    category: 'promotionalOffers' | 'productUpdates' | 'safetyAnnouncements';
    /** Grouping for the library screen. */
    group?: 'Promotions' | 'Lifecycle' | 'Service' | 'Community';
    /** Who this is written for. Only 'passenger' can be sent today. */
    audience?: 'passenger' | 'driver';
    /** One line on when to reach for it, shown on the card. */
    whenToUse?: string;
    defaults: TemplateContent;
}

/**
 * The template library.
 *
 * ── Category is a property of the template, not a free choice ────────────
 * A safety notice must not be sendable under promotional consent, and a
 * discount must not be sendable under a safety exemption. Binding it here
 * removes the opportunity rather than relying on whoever fills the form in.
 *
 * ── Two of these are for drivers, and cannot be sent ─────────────────────
 * Driver appreciation and the driver-facing referral exist because the copy is
 * the easy part and the consent record is not. They carry `audience: 'driver'`,
 * which the audience registry currently refuses — so they are visible, usable
 * as a starting point, and impossible to send until a driver consent record
 * exists. A library that quietly omitted them would make the gap invisible.
 *
 * ── Service templates are not marketing ──────────────────────────────────
 * Service interruption and safety update go under `safetyAnnouncements`, which
 * defaults to ON and is not withdrawable by an ordinary unsubscribe — they are
 * part of running a transport service. That is exactly why they must never be
 * used to carry an offer: the one category people cannot opt out of is the one
 * most easily abused.
 */
export const TEMPLATES: EmailTemplate[] = [
    {
        key: 'promotional_offer',
        name: 'Promotional offer',
        description: 'A discount or promo code.',
        category: 'promotionalOffers',
        defaults: {
            headline: 'Your next ride is on us',
            body: 'Hello {{firstName}},\n\nUse the code below on your next KekeRide trip and enjoy a discount.',
            ctaLabel: 'Book a ride',
            footnote: 'One use per passenger. Subject to availability.',
        },
    },
    {
        key: 'welcome',
        name: 'Welcome to KekeRide',
        description: 'Sent after a passenger joins.',
        category: 'productUpdates',
        defaults: {
            headline: 'Welcome to KekeRide',
            body: 'Hello {{firstName}},\n\nThank you for joining KekeRide. Getting a Keke is now a few taps away — open the app, set where you are going, and a nearby driver will come to you.',
            ctaLabel: 'Take your first ride',
        },
    },
    {
        key: 'service_area_launch',
        name: 'Service-area launch',
        description: 'KekeRide is now running somewhere new.',
        category: 'productUpdates',
        defaults: {
            headline: 'KekeRide is now in {{city}}',
            body: 'Hello {{firstName}},\n\nWe have started running in {{city}}. Drivers are on the road and ready to take you where you need to go.',
            ctaLabel: 'Book a ride',
        },
    },
    {
        key: 'app_update',
        name: 'App update',
        description: 'What has changed in the passenger app.',
        category: 'productUpdates',
        defaults: {
            headline: "What's new in the app",
            body: 'Hello {{firstName}},\n\nWe have made some improvements to the KekeRide app.',
            ctaLabel: 'Update the app',
        },
    },
    {
        key: 'reactivation',
        name: 'We miss you',
        description: 'For passengers who have not ridden in a while.',
        category: 'promotionalOffers',
        defaults: {
            headline: 'It has been a while',
            body: 'Hello {{firstName}},\n\nWe have not seen you on a KekeRide in some time. Whenever you are ready, a Keke is a few taps away.',
            ctaLabel: 'Book a ride',
        },
    },
    {
        key: 'referral',
        name: 'Referral campaign',
        description: 'Invite friends.',
        category: 'promotionalOffers',
        defaults: {
            headline: 'Bring a friend along',
            body: 'Hello {{firstName}},\n\nShare KekeRide with someone who needs a ride and you both benefit.',
            ctaLabel: 'Share KekeRide',
        },
    },
    {
        key: 'announcement',
        name: 'General announcement',
        description: 'Company or service news.',
        category: 'productUpdates',
        defaults: {
            headline: 'An update from KekeRide',
            body: 'Hello {{firstName}},\n\nWe wanted to let you know about something.',
            ctaLabel: 'Open KekeRide',
        },
    },
    {
        key: 'safety_notice',
        name: 'Safety or service notice',
        description: 'Something a passenger needs to know. Not marketing.',
        category: 'safetyAnnouncements',
        defaults: {
            headline: 'An important service notice',
            body: 'Hello {{firstName}},\n\nWe are writing to let you know about a change that affects your rides.',
            ctaLabel: 'Open KekeRide',
        },
    },
    {
        key: 'weekend_discount',
        name: 'Weekend discount',
        description: 'A time-boxed offer for Friday to Sunday.',
        category: 'promotionalOffers',
        group: 'Promotions',
        audience: 'passenger',
        whenToUse: 'Filling quiet weekend hours. Say when it ends — an offer with no deadline gets ignored.',
        defaults: {
            headline: 'Cheaper Kekes all weekend',
            body: 'Hello {{firstName}},\n\nFrom Friday evening until Sunday night, every KekeRide trip is discounted. '
                + 'No code needed — the lower fare shows in the app before you confirm.',
            ctaLabel: 'Book a weekend ride',
            footnote: 'Offer ends Sunday at midnight. Available in participating areas only.',
        },
    },
    {
        key: 'holiday',
        name: 'Holiday greeting',
        description: 'Christmas, Easter, Eid, Independence Day.',
        category: 'promotionalOffers',
        group: 'Community',
        audience: 'passenger',
        whenToUse: 'A greeting, not an advert. If it needs a promo code, use the promotional template instead.',
        defaults: {
            headline: 'From all of us at KekeRide',
            body: 'Hello {{firstName}},\n\nThank you for riding with us this year. '
                + 'However you are spending the holiday, we hope you get there safely.\n\n'
                + 'Our drivers are on the road throughout, so if you need a Keke, we are here.',
            ctaLabel: 'Open KekeRide',
            footnote: 'Fares may be higher than usual during peak holiday hours.',
        },
    },
    {
        key: 'passenger_appreciation',
        name: 'Passenger appreciation',
        description: 'Thanking frequent riders. No offer attached.',
        category: 'promotionalOffers',
        group: 'Community',
        audience: 'passenger',
        whenToUse: 'Pair with the high-frequency audience filter. Sending this to somebody with two rides reads as a form letter.',
        defaults: {
            headline: 'Thank you for riding with us',
            body: 'Hello {{firstName}},\n\nYou have been one of our most regular passengers, and we noticed. '
                + 'Thank you for trusting KekeRide to get you where you are going.',
            ctaLabel: 'Book your next ride',
            footnote: 'You are receiving this because you ride with us often.',
        },
    },
    {
        key: 'driver_appreciation',
        name: 'Driver appreciation',
        description: 'Thanking drivers. Cannot be sent yet — drivers have no consent record.',
        category: 'promotionalOffers',
        group: 'Community',
        audience: 'driver',
        whenToUse: 'Ready for when a driver consent record exists. Until then this is a draft nobody can send.',
        defaults: {
            headline: 'Thank you for driving with KekeRide',
            body: 'Hello {{firstName}},\n\nYour trips this month kept passengers moving, and we want to say so plainly. '
                + 'Thank you for the hours, the early starts and the care you take with every passenger.',
            ctaLabel: 'Open the driver app',
            footnote: 'Sent to active KekeRide drivers.',
        },
    },
    {
        key: 'service_interruption',
        name: 'Service interruption',
        description: 'A planned or ongoing disruption. Not marketing.',
        category: 'safetyAnnouncements',
        group: 'Service',
        audience: 'passenger',
        whenToUse: 'Say what is affected, where, and when it ends. Never attach an offer to this — '
            + 'safety consent cannot be withdrawn, so using it to advertise abuses the one channel people cannot leave.',
        defaults: {
            headline: 'Service disruption in your area',
            body: 'Hello {{firstName}},\n\nKekeRide service is disrupted in parts of the city. '
                + 'We expect normal service to return shortly.\n\n'
                + 'If you have a ride in progress, your driver will complete it as normal.',
            ctaLabel: 'Check the app',
            footnote: 'This is a service notice, not a promotion. You cannot unsubscribe from safety notices.',
        },
    },
    {
        key: 'feature_announcement',
        name: 'Feature announcement',
        description: 'Something new in the app.',
        category: 'productUpdates',
        group: 'Lifecycle',
        audience: 'passenger',
        whenToUse: 'One feature per message. A list of five improvements gets read as none.',
        defaults: {
            headline: 'Something new in KekeRide',
            body: 'Hello {{firstName}},\n\nWe have added something to the app that should make booking simpler. '
                + 'Update to the latest version to try it.',
            ctaLabel: 'See what is new',
            footnote: 'You are receiving this because you asked for product updates.',
        },
    },
];

export function templateByKey(key: string): EmailTemplate | undefined {
    return TEMPLATES.find((t) => t.key === key);
}

/** The rendered pair. Both are always produced; neither is optional. */
export interface RenderedEmail {
    html: string;
    text: string;
}

export function renderTemplate(templateKey: string, ctx: RenderContext): RenderedEmail {
    const c = ctx.content;
    const p = ctx.personalisation;

    const headline = render(c.headline ?? '', p);
    const body = render(c.body ?? '', p);
    const ctaLabel = render(c.ctaLabel ?? '', p);
    const ctaUrl = render(c.ctaUrl ?? p.ctaUrl ?? '', p);
    const promoCode = render(c.promoCode ?? p.promoCode ?? '', p);
    const promoExpiry = render(c.promoExpiry ?? p.promoExpiry ?? '', p);
    const footnote = render(c.footnote ?? '', p);

    const inner = [
        headline ? heading(headline) : '',
        c.imageUrl ? image(String(c.imageUrl)) : '',
        body ? paragraphs(body) : '',
        promoCode ? promoBlock(promoCode, promoExpiry || null) : '',
        // A button with no destination is a dead button; omitted rather than
        // rendered pointing at nothing.
        ctaLabel && ctaUrl ? button(ctaLabel, ctaUrl) : '',
        footnote ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:${BRAND.muted};">${esc(footnote)}</p>` : '',
    ].join('');

    return {
        html: shell(inner, { ...ctx, content: c }),
        text: renderPlainText({ headline, body, promoCode, promoExpiry, ctaLabel, ctaUrl, footnote }, ctx),
    };
}

/**
 * The plain-text alternative.
 *
 * Not a courtesy. A message with no text part is scored as more likely to be
 * spam, and some clients — and every screen reader on a text-only view — show
 * this instead of the HTML. It carries the same offer and the same unsubscribe
 * link, because a passenger reading this version must have the same way out.
 */
function renderPlainText(
    parts: {
        headline: string; body: string; promoCode: string; promoExpiry: string;
        ctaLabel: string; ctaUrl: string; footnote: string;
    },
    ctx: RenderContext,
): string {
    const lines: string[] = ['KekeRide', ''];

    if (parts.headline) lines.push(parts.headline.toUpperCase(), '');
    if (parts.body) lines.push(parts.body, '');
    if (parts.promoCode) {
        lines.push(`Your code: ${parts.promoCode}`);
        if (parts.promoExpiry) lines.push(`Valid until ${parts.promoExpiry}`);
        lines.push('');
    }
    if (parts.ctaLabel && parts.ctaUrl) lines.push(`${parts.ctaLabel}: ${parts.ctaUrl}`, '');
    if (parts.footnote) lines.push(parts.footnote, '');

    lines.push(
        '—',
        `Questions? ${ctx.supportEmail}`,
        `Choose what we send you: ${ctx.preferencesUrl}`,
        `Unsubscribe: ${ctx.unsubscribeUrl}`,
        '',
        'KekeRide · Anambra State, Nigeria',
        'You are receiving this because you asked us to send you updates.',
    );

    return lines.join('\n');
}
