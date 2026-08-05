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

        /*
         * The master switch follows the categories. A passenger should not have
         * to reason about a hidden parent setting: ticking either category is
         * consent, clearing both is an unsubscribe.
         */
        const marketing = asBool(body.marketing)
            ?? ((promotionalOffers ?? false) || (productUpdates ?? false));

        const allowed = [ConsentSource.SIGNUP, ConsentSource.PROFILE, ConsentSource.IN_APP_PROMPT];
        const source = allowed.includes(body.source) ? body.source : ConsentSource.PROFILE;

        const pref = await MarketingConsentService.setPreferences(userId, {
            marketing,
            promotionalOffers,
            productUpdates,
            safetyAnnouncements: asBool(body.safetyAnnouncements),
        }, {
            source,
            // Kept for a disputed opt-in. Never shown to staff in any screen.
            ipAddress: req.ip ?? null,
            reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null,
        });

        return res.json({
            marketing: pref.marketing,
            promotionalOffers: pref.promotionalOffers,
            productUpdates: pref.productUpdates,
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
 * Record that the passenger was shown the one-time prompt and declined.
 *
 * Without this, "no row" would mean both "never asked" and "asked and said no",
 * and the app would show the prompt again on every launch. Writing a row with
 * everything false says: they were asked, the answer was no, do not ask again.
 */
router.post('/me/communication-preferences/decline', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        await MarketingConsentService.setPreferences(req.user!.userId, {
            marketing: false,
            promotionalOffers: false,
            productUpdates: false,
        }, {
            source: ConsentSource.IN_APP_PROMPT,
            ipAddress: req.ip ?? null,
            reason: 'declined_prompt',
        });
        return res.json({ ok: true, hasBeenAsked: true });
    } catch (err: any) {
        console.error('[PREFS]', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't save that."));
    }
});

export default router;
