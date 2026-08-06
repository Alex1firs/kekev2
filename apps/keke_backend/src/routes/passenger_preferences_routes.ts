/**
 * A passenger's own communication preferences, from inside the app.
 *
 * ── Why this is the route that matters ───────────────────────────────────
 * It is the only way consent can lawfully enter the system. Nobody was asked at
 * signup — the screen showed no terms, no privacy link and no checkbox — so
 * every existing passenger is opted out and stays that way until they use one
 * of these endpoints themselves.
 *
 * Authenticated as the passenger, not as staff. Consent given by an
 * administrator on somebody's behalf is not consent, and there is deliberately
 * no endpoint here that lets one account set another's preferences.
 */

import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth_middleware';
import { MarketingConsentService } from '../services/marketing_consent_service';
import { ConsentSource } from '../models/PassengerCommunicationPreference';
import { errBody, ErrorCode } from '../utils/errors';

const router = Router();

/**
 * What this passenger currently receives.
 *
 * A passenger who has never been asked gets every category false and
 * `hasBeenAsked: false` — which is what the app uses to decide whether to show
 * the one-time prompt. The distinction between "said no" and "never asked"
 * matters: we may ask once, and we must not nag somebody who declined.
 */
router.get('/me/communication-preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pref = await MarketingConsentService.find(userId);

        return res.json({
            marketing: pref?.marketing ?? false,
            promotionalOffers: pref?.promotionalOffers ?? false,
            productUpdates: pref?.productUpdates ?? false,
            surveys: pref?.surveys ?? false,
            // Per channel: a passenger may take email and refuse SMS, and the
            // app has to render those independently.
            marketingEmail: pref?.marketingEmail ?? false,
            marketingPush: pref?.marketingPush ?? false,
            marketingInApp: pref?.marketingInApp ?? false,
            marketingSms: pref?.marketingSms ?? false,
            // Defaults true for somebody with no row: a service withdrawal is
            // something a passenger needs whether or not they want our offers.
            safetyAnnouncements: pref?.safetyAnnouncements ?? true,
            hasBeenAsked: pref != null,
            consentAt: pref?.consentAt ?? null,
            unsubscribedAt: pref?.unsubscribedAt ?? null,
        });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your preferences."));
    }
});

/**
 * Set them.
 *
 * `source` says which screen the passenger used, and it is recorded because
 * "they opted in" is only a defence if we can say when, how and from where. The
 * client may name the screen; anything it sends that is not a known source is
 * replaced rather than trusted.
 */
router.put('/me/communication-preferences', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const body = req.body ?? {};

        const asBool = (v: unknown): boolean | undefined =>
            v === undefined ? undefined : v === true || v === 'true';

        const promotionalOffers = asBool(body.promotionalOffers);
        const productUpdates = asBool(body.productUpdates);
        const marketingEmail = asBool(body.marketingEmail);
        const marketingPush = asBool(body.marketingPush);
        const marketingInApp = asBool(body.marketingInApp);
        const marketingSms = asBool(body.marketingSms);

        /*
         * The master switch follows the choices below it. A passenger should
         * not have to reason about a hidden parent setting: turning on any
         * channel or category is consent, clearing them all is an unsubscribe.
         */
        const marketing = asBool(body.marketing)
            ?? ((promotionalOffers ?? false) || (productUpdates ?? false)
                || (marketingEmail ?? false) || (marketingPush ?? false)
                || (marketingInApp ?? false) || (marketingSms ?? false));

        const allowed = [ConsentSource.SIGNUP, ConsentSource.PROFILE, ConsentSource.IN_APP_PROMPT];
        const source = allowed.includes(body.source) ? body.source : ConsentSource.PROFILE;

        const pref = await MarketingConsentService.setPreferences(userId, {
            marketing,
            promotionalOffers,
            productUpdates,
            surveys: asBool(body.surveys),
            marketingEmail,
            marketingPush,
            marketingInApp,
            marketingSms,
            safetyAnnouncements: asBool(body.safetyAnnouncements),
        }, {
            source,
            // Kept for a disputed opt-in. Never shown to staff in any screen.
            ipAddress: req.ip ?? null,
            reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null,
            appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 40) : null,
        });

        return res.json({
            marketing: pref.marketing,
            promotionalOffers: pref.promotionalOffers,
            productUpdates: pref.productUpdates,
            surveys: pref.surveys,
            marketingEmail: pref.marketingEmail,
            marketingPush: pref.marketingPush,
            marketingInApp: pref.marketingInApp,
            marketingSms: pref.marketingSms,
            safetyAnnouncements: pref.safetyAnnouncements,
            hasBeenAsked: true,
            consentAt: pref.consentAt,
            unsubscribedAt: pref.unsubscribedAt,
        });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't save your preferences."));
    }
});

/**
 * Should the one-time prompt be shown, and record that it was?
 *
 * The decision is made on the server so that reinstalling the app cannot reset
 * it — a passenger who declined must stay declined.
 */
router.get('/me/communication-prompt', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const decision = await MarketingConsentService.shouldShowPrompt(req.user!.userId);
        return res.json(decision);
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        // Never block the app on this. Not showing the prompt is always safe.
        return res.json({ show: false, reason: 'answered' });
    }
});

router.post('/me/communication-prompt/shown', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        await MarketingConsentService.recordPromptShown(req.user!.userId);
        return res.json({ ok: true });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.json({ ok: false });
    }
});

/**
 * The passenger answered — yes or no. Either way the prompt is finished.
 *
 * A decline is recorded as deliberately as an accept: it is the difference
 * between "never asked" and "asked and refused", and without it the prompt
 * returns forever.
 */
router.post('/me/communication-prompt/answer', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const body = req.body ?? {};
        const accepted = body.accepted === true || body.accepted === 'true';

        const pref = await MarketingConsentService.answerPrompt(
            req.user!.userId,
            accepted,
            {
                email: body.email !== false,
                push: body.push !== false,
                inApp: body.inApp !== false,
                // Never granted by a general yes — see answerPrompt.
                sms: body.sms === true,
            },
            {
                ipAddress: req.ip ?? null,
                appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 40) : null,
            },
        );

        return res.json({
            marketing: pref.marketing,
            marketingEmail: pref.marketingEmail,
            marketingPush: pref.marketingPush,
            marketingInApp: pref.marketingInApp,
            marketingSms: pref.marketingSms,
            hasBeenAsked: true,
            answered: true,
        });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't save that."));
    }
});

/** Retained: the Phase 1 decline endpoint, so an older build keeps working. */
router.post('/me/communication-preferences/decline', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        await MarketingConsentService.answerPrompt(req.user!.userId, false, {}, {
            ipAddress: req.ip ?? null,
        });
        return res.json({ ok: true, hasBeenAsked: true });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't save that."));
    }
});

export default router;
