/**
 * Unsubscribe and preferences, for passengers.
 *
 * ── No authentication, deliberately ──────────────────────────────────────
 * A passenger reading mail on a phone they are not signed in on must still be
 * able to stop it. An unsubscribe link that demands a login is one people
 * answer with the spam button instead, and a spam complaint costs the sending
 * domain — the same domain that carries KekeRide's verification codes.
 *
 * The token is the authorisation: 24 random bytes, per passenger, and it can do
 * exactly two things — turn marketing off, or turn a category back on. It
 * cannot read an address, change a password or reach anything else.
 */

import { Router, Request, Response } from 'express';
import { MarketingConsentService } from '../services/marketing_consent_service';
import { ConsentSource } from '../models/PassengerCommunicationPreference';
import { loadCommunicationsConfig } from '../config/communications_config';

const router = Router();

/** Minimal, self-contained page. No external assets: this must render anywhere. */
function page(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${title} · KekeRide</title>
<style>
  body{margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;}
  .wrap{max-width:520px;margin:0 auto;padding:40px 16px;}
  .card{background:#fff;border-radius:16px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .brand{display:inline-block;background:#f5c518;border-radius:10px;padding:8px 16px;font-weight:800;margin-bottom:22px;}
  h1{font-size:21px;margin:0 0 12px;} p{font-size:15px;line-height:1.65;color:#3f4654;margin:0 0 16px;}
  label{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-bottom:1px solid #e5e7eb;font-size:15px;}
  label:last-of-type{border-bottom:0;}
  input[type=checkbox]{width:22px;height:22px;margin-top:2px;flex:none;}
  button{width:100%;min-height:52px;background:#f5c518;border:0;border-radius:10px;font-size:16px;font-weight:700;color:#1a1a2e;cursor:pointer;margin-top:20px;}
  .muted{font-size:13px;color:#6b7280;}
</style></head>
<body><div class="wrap"><div class="card">
<div class="brand">KekeRide</div>
${body}
</div></div></body></html>`;
}

/**
 * GET — a one-click confirmation page.
 *
 * A GET must not change anything: mail clients and security scanners fetch
 * every link in a message, and an unsubscribe that acted on GET would opt
 * people out because their employer's scanner opened the email.
 */
router.get('/unsubscribe', async (req: Request, res: Response) => {
    const token = String(req.query.token ?? '');
    if (!token) return res.status(400).send(page('Unsubscribe', '<h1>This link is incomplete</h1><p>Please use the link exactly as it appears in the email.</p>'));

    return res.send(page('Unsubscribe', `
        <h1>Stop marketing emails?</h1>
        <p>You will no longer receive offers, promotions or product news from KekeRide.</p>
        <p class="muted">You will still receive essential messages about your account and your rides — verification codes, password resets and safety notices.</p>
        <form method="POST" action="/comms/unsubscribe">
            <input type="hidden" name="token" value="${token.replace(/"/g, '')}">
            <button type="submit">Unsubscribe me</button>
        </form>`));
});

/**
 * POST — the actual unsubscribe.
 *
 * Also the RFC 8058 one-click endpoint that Gmail and Yahoo POST to directly,
 * which is why it accepts a form body and answers plainly.
 */
router.post('/unsubscribe', async (req: Request, res: Response) => {
    const token = String(req.body?.token ?? req.query.token ?? '');
    const ok = token ? await MarketingConsentService.unsubscribeByToken(token, 'email_link') : false;

    /*
     * A one-click POST from a mail provider wants a bare 200, not a page.
     * Answering with HTML there is treated as a failure by some of them.
     */
    if (req.get('List-Unsubscribe') || req.query.oneclick === '1') {
        return res.status(ok ? 200 : 400).send(ok ? 'unsubscribed' : 'invalid token');
    }

    if (!ok) {
        return res.status(400).send(page('Unsubscribe', `
            <h1>We could not find that link</h1>
            <p>It may already have been used. If you are still receiving emails, write to
            <a href="mailto:${loadCommunicationsConfig().replyToAddress}">${loadCommunicationsConfig().replyToAddress}</a>
            and we will take care of it.</p>`));
    }

    return res.send(page('Unsubscribed', `
        <h1>You are unsubscribed</h1>
        <p>We will not send you any more marketing emails.</p>
        <p class="muted">You will still receive essential messages about your account and your rides. If you change your mind, you can turn updates back on in the KekeRide app.</p>`));
});

/** The preference centre — per-category, rather than all-or-nothing. */
router.get('/preferences', async (req: Request, res: Response) => {
    const token = String(req.query.token ?? '');
    if (!token) return res.status(400).send(page('Preferences', '<h1>This link is incomplete</h1>'));

    const pref = await MarketingConsentService.findByToken(token);
    if (!pref) {
        return res.status(404).send(page('Preferences', `
            <h1>We could not find that link</h1>
            <p>It may have been replaced by a newer email.</p>`));
    }

    const box = (name: string, label: string, hint: string, checked: boolean) => `
        <label><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}>
        <span><strong>${label}</strong><br><span class="muted">${hint}</span></span></label>`;

    return res.send(page('Preferences', `
        <h1>What we send you</h1>
        <p>Choose what you would like to hear about.</p>
        <form method="POST" action="/comms/preferences">
            <input type="hidden" name="token" value="${token.replace(/"/g, '')}">
            ${box('promotionalOffers', 'Offers and promotions', 'Discounts and promo codes.', pref.marketing && pref.promotionalOffers)}
            ${box('productUpdates', 'Product news', 'New features and service areas.', pref.marketing && pref.productUpdates)}
            ${box('safetyAnnouncements', 'Safety and service notices', 'Things that affect your rides. We recommend leaving this on.', pref.safetyAnnouncements)}
            <button type="submit">Save my choices</button>
        </form>
        <p class="muted" style="margin-top:18px;">Essential emails about your account and rides are always sent, whatever you choose here.</p>`));
});

router.post('/preferences', async (req: Request, res: Response) => {
    const token = String(req.body?.token ?? '');
    const pref = token ? await MarketingConsentService.findByToken(token) : null;
    if (!pref) return res.status(400).send(page('Preferences', '<h1>We could not find that link</h1>'));

    const on = (name: string) => req.body?.[name] === 'on' || req.body?.[name] === 'true';
    const promotionalOffers = on('promotionalOffers');
    const productUpdates = on('productUpdates');

    await MarketingConsentService.setPreferences(pref.userId, {
        // The master switch follows the categories: ticking either is consent,
        // clearing both is an unsubscribe. A passenger should not have to
        // reason about a hidden parent setting.
        marketing: promotionalOffers || productUpdates,
        promotionalOffers,
        productUpdates,
        safetyAnnouncements: on('safetyAnnouncements'),
    }, {
        source: ConsentSource.UNSUBSCRIBE_LINK,
        ipAddress: req.ip ?? null,
        reason: 'preference_centre',
    });

    return res.send(page('Preferences saved', `
        <h1>Saved</h1>
        <p>Thank you — your choices have been updated.</p>`));
});

export default router;
