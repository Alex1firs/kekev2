/**
 * How much of a passenger's identity travels with a dispatch offer.
 *
 * Today the offer payload carries the passenger's full dialable number to
 * EVERY driver the ride rings, whether or not they take it. That is the defect
 * this configuration exists to retire — but it cannot simply be deleted,
 * because the driver app builds its in-ride call button from the offer payload
 * (driver_controller.dart) and never re-reads contact data afterwards. Removing
 * the field in one step would silently break the call button on every handset
 * in the field.
 *
 * So the transition is staged, and the stage is a runtime setting:
 *
 *   legacy            (default)  offer carries the full phone, exactly as today.
 *   masked_versioned             offer carries a MASKED number for drivers whose
 *                                app is new enough to fetch the real one at
 *                                assignment; full number for everyone else.
 *   strict_versioned             offer carries NO contact data for new-enough
 *                                apps; legacy behaviour for the rest.
 *   strict                       offer carries no contact data for anyone.
 *                                Only safe once fleet adoption is complete.
 *
 * "New enough" is decided per driver from the app version their device last
 * registered (device_token.appVersion). An app that has never reported a
 * version is treated as OLD, so tightening the default can never break a client
 * that has not told us what it is.
 *
 * See docs/contact_privacy_migration.md for the release sequence.
 */

export type ContactPrivacyMode =
    | 'legacy'
    | 'masked_versioned'
    | 'strict_versioned'
    | 'strict';

const VALID_MODES: ContactPrivacyMode[] = ['legacy', 'masked_versioned', 'strict_versioned', 'strict'];

export const ContactPrivacyConfig = {
    /**
     * Default is `legacy`: this phase adds the machinery and changes no
     * observable behaviour. Flipping the mode is a deliberate, separate act.
     */
    get mode(): ContactPrivacyMode {
        const raw = (process.env.CONTACT_PRIVACY_MODE ?? 'legacy').trim() as ContactPrivacyMode;
        if (!VALID_MODES.includes(raw)) {
            console.warn(`[contact-privacy] CONTACT_PRIVACY_MODE="${raw}" is not recognised — using "legacy".`);
            return 'legacy';
        }
        return raw;
    },

    /**
     * The lowest driver app version that fetches contact details at assignment
     * time instead of reading them from the offer payload.
     */
    get minDriverAppVersion(): string {
        return (process.env.CONTACT_PRIVACY_MIN_DRIVER_APP_VERSION ?? '99.99.99').trim();
    },

    /** How long an assignment-time contact grant stays valid after the ride ends. */
    get assignedDriverGraceHours(): number {
        const raw = Number(process.env.CONTACT_ASSIGNED_DRIVER_GRACE_HOURS);
        return Number.isFinite(raw) && raw > 0 ? raw : 2;
    },

    /** How long a staff contact reveal stays valid. */
    get staffRevealMinutes(): number {
        const raw = Number(process.env.CONTACT_STAFF_REVEAL_MINUTES);
        return Number.isFinite(raw) && raw > 0 ? raw : 30;
    },
};

/**
 * Semver-ish comparison tolerant of the shapes a Flutter build actually
 * reports ("1.4.2", "1.4.2+17", "1.4"). Returns true when `version` is at least
 * `minimum`. Anything unparseable is treated as BELOW the minimum — an unknown
 * client is an old client.
 */
export function meetsMinimumVersion(version: string | null | undefined, minimum: string): boolean {
    if (!version) return false;
    const parse = (v: string): number[] | null => {
        const core = v.trim().split('+')[0].split('-')[0];
        const parts = core.split('.').map((p) => Number.parseInt(p, 10));
        if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
        while (parts.length < 3) parts.push(0);
        return parts.slice(0, 3);
    };

    const actual = parse(version);
    const required = parse(minimum);
    if (!actual || !required) return false;

    for (let i = 0; i < 3; i += 1) {
        if (actual[i] > required[i]) return true;
        if (actual[i] < required[i]) return false;
    }
    return true;
}
