/**
 * Service emails: the ones a passenger receives because of something that
 * happened to them, not because we want to sell them a trip.
 *
 * ── Why these are not in the template library ────────────────────────────
 * Every template in `email_templates.ts` is marketing-class and renders a
 * footer offering unsubscribe. A service message must not offer that — a
 * passenger cannot opt out of being told their own ride could not be filled —
 * and it must say plainly why it arrived. Rather than add a conditional to the
 * marketing renderer and rely on a boolean being right, these live apart. A
 * discount cannot be rendered through this file, and a ride receipt cannot be
 * rendered through that one.
 *
 * ── The rule these obey ─────────────────────────────────────────────────
 * No offer, no promo code, no discount. The call to action returns the
 * passenger to the product they just used. That is what keeps these genuine
 * service messages rather than advertising wearing a receipt's clothes.
 */
import { BRAND, esc } from './email_templates';

export interface ServiceContext {
    firstName?: string | null;
    pickupArea?: string | null;
    destinationArea?: string | null;
    /** Where "Book another ride" points. */
    appUrl: string;
    supportEmail: string;
    preferencesUrl: string;
}

export interface RenderedServiceEmail {
    subject: string;
    html: string;
    text: string;
    previewText: string;
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif`;

function firstNameOf(ctx: ServiceContext): string {
    const n = (ctx.firstName ?? '').trim();
    return n || 'there';
}

/**
 * The shell, with a service footer instead of an unsubscribe footer.
 *
 * `whyReceiving` is required rather than optional: a service message that does
 * not say why it arrived is indistinguishable from spam to the person reading
 * it, and to their mail provider.
 */
function serviceShell(inner: string, ctx: ServiceContext, whyReceiving: string, preview: string): string {
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>KekeRide</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.wash};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preview)}</div>
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:${BRAND.wash};padding:28px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;">

      <tr>
        <td align="center" style="background-color:${BRAND.ink};border-radius:16px 16px 0 0;padding:26px 30px;">
          <span style="display:inline-block;background-color:${BRAND.amber};border-radius:10px;padding:8px 16px;font-family:${FONT};font-size:19px;font-weight:800;color:${BRAND.ink};letter-spacing:0.5px;">
            KekeRide
          </span>
        </td>
      </tr>

      <tr>
        <td style="background-color:${BRAND.paper};padding:34px 30px 28px;font-family:${FONT};">
          ${inner}
        </td>
      </tr>

      <tr>
        <td style="background-color:${BRAND.paper};border-top:1px solid ${BRAND.line};border-radius:0 0 16px 16px;padding:22px 30px 28px;font-family:${FONT};">
          <p style="margin:0 0 10px;font-size:13px;color:${BRAND.muted};line-height:1.6;">
            ${esc(whyReceiving)}
          </p>
          <p style="margin:0 0 10px;font-size:13px;color:${BRAND.muted};line-height:1.6;">
            Questions? Reach us at
            <a href="mailto:${esc(ctx.supportEmail)}" style="color:${BRAND.ink};">${esc(ctx.supportEmail)}</a>.
          </p>
          <p style="margin:0 0 10px;font-size:12px;color:${BRAND.muted};line-height:1.6;">
            <a href="${esc(ctx.preferencesUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Choose what else we send you</a>
          </p>
          <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;">
            KekeRide · Anambra State, Nigeria<br />
            Your Ride. Your Way.
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
    return `<h1 style="margin:0 0 16px;font-size:23px;line-height:1.3;font-weight:700;color:${BRAND.ink};">${esc(text)}</h1>`;
}

function para(text: string): string {
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BRAND.body};">${esc(text)}</p>`;
}

function button(label: string, url: string): string {
    return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:26px 0 8px;">
      <tr><td align="center" style="background-color:${BRAND.amber};border-radius:10px;">
        <a href="${esc(url)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;color:${BRAND.ink};text-decoration:none;">${esc(label)}</a>
      </td></tr>
    </table>`;
}

/** Where the trip went, phrased only when we actually know. */
function journeyLine(ctx: ServiceContext): string | null {
    const from = (ctx.pickupArea ?? '').trim();
    const to = (ctx.destinationArea ?? '').trim();
    if (from && to) return `We hope your journey from ${from} to ${to} was smooth and convenient.`;
    if (to) return `We hope your journey to ${to} was smooth and convenient.`;
    // Saying nothing beats inventing a route. Historical addresses are poor,
    // and a wrong place name reads worse than no place name.
    return 'We hope your journey was smooth and convenient.';
}

export function renderRideCompleted(ctx: ServiceContext): RenderedServiceEmail {
    const name = firstNameOf(ctx);
    const journey = journeyLine(ctx)!;

    const inner = [
        heading('Thank you for riding with KekeRide today 💛'),
        para(`Hello ${name},`),
        para('Thank you for choosing KekeRide for your trip today.'),
        para(journey),
        para('Your support is helping us build a better way to move around Onitsha.'),
        para('Whenever you’re heading out again, simply open KekeRide and request your ride.'),
        button('Book another ride', ctx.appUrl),
    ].join('\n');

    const text = [
        `Hello ${name},`, '',
        'Thank you for choosing KekeRide for your trip today.', '',
        journey, '',
        'Your support is helping us build a better way to move around Onitsha.', '',
        'Whenever you’re heading out again, simply open KekeRide and request your ride.', '',
        `Book another ride: ${ctx.appUrl}`, '',
        'Your Ride. Your Way.', 'KekeRide.ng', '',
        'You received this because you completed a ride with KekeRide.',
    ].join('\n');

    return {
        subject: 'Thank you for riding with KekeRide today 💛',
        previewText: 'We hope your trip was smooth.',
        html: serviceShell(inner, ctx,
            'You received this because you completed a ride with KekeRide.',
            'We hope your trip was smooth.'),
        text,
    };
}

/**
 * The apology, for both NO_ELIGIBLE_DRIVER and NO_DRIVER_ACCEPTED.
 *
 * The wording is deliberately "we couldn't connect you" rather than "there were
 * no drivers near you". The second sentence would be a lie for
 * NO_DRIVER_ACCEPTED, where drivers were there and were offered the trip and
 * did not take it. One message, truthful for both causes; the cause itself is
 * recorded on the dispatch row for reporting.
 */
export function renderRideNotFulfilled(ctx: ServiceContext): RenderedServiceEmail {
    const name = firstNameOf(ctx);

    const inner = [
        heading('We’re sorry we couldn’t connect you with a Keke'),
        para(`Hello ${name},`),
        para('We noticed that we weren’t able to connect you with an available Keke for your trip today.'),
        para('We’re working to improve KekeRide availability across Onitsha.'),
        para('Please try again when you’re heading out — we’d love another opportunity to get you moving.'),
        button('Try KekeRide again', ctx.appUrl),
    ].join('\n');

    const text = [
        `Hello ${name},`, '',
        'We noticed that we weren’t able to connect you with an available Keke for your trip today.', '',
        'We’re working to improve KekeRide availability across Onitsha.', '',
        'Please try again when you’re heading out — we’d love another opportunity to get you moving.', '',
        `Try KekeRide again: ${ctx.appUrl}`, '',
        'Your Ride. Your Way.', 'KekeRide.ng', '',
        'You received this because you requested a ride with KekeRide.',
    ].join('\n');

    return {
        subject: 'We’re sorry we couldn’t connect you with a Keke',
        previewText: 'We couldn’t find you a Keke this time.',
        html: serviceShell(inner, ctx,
            'You received this because you requested a ride with KekeRide.',
            'We couldn’t find you a Keke this time.'),
        text,
    };
}

/** Push copy, kept beside the email so the two cannot drift apart. */
export function pushForTrigger(key: string, ctx: ServiceContext): { title: string; body: string } | null {
    const name = firstNameOf(ctx);
    switch (key) {
        case 'ride_completed':
            return {
                title: 'Thanks for riding with KekeRide 💛',
                body: `Thanks for riding with KekeRide today, ${name}. We hope you had a smooth trip.`,
            };
        case 'ride_not_fulfilled':
            return {
                title: 'We couldn’t connect you with a Keke',
                body: 'Sorry — we couldn’t connect you with an available Keke this time. '
                    + 'We’re growing the driver network across Onitsha. Please try again shortly.',
            };
        default:
            return null;
    }
}

export const SERVICE_TEMPLATE_KEYS = ['ride_completed_thank_you', 'ride_not_fulfilled_apology'] as const;

export function renderServiceTemplate(templateKey: string, ctx: ServiceContext): RenderedServiceEmail | null {
    switch (templateKey) {
        case 'ride_completed_thank_you':   return renderRideCompleted(ctx);
        case 'ride_not_fulfilled_apology': return renderRideNotFulfilled(ctx);
        default: return null;
    }
}
