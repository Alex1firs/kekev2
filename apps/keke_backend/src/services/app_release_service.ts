/**
 * What version of each app we expect drivers to be running.
 *
 * ── Why this is server-authoritative ────────────────────────────────────
 * Without it, shipping a fix means telephoning drivers one at a time — which
 * is how the presence rollout actually went. The app asks the server what the
 * current build is; the server can therefore turn a nag on, or a hard block,
 * without another release.
 *
 * ── Why forcing is deliberately hard to trigger ─────────────────────────
 * A forced update takes a driver off the road until they can reach Play, which
 * on a Nigerian data plan mid-shift is a real cost. So `minimumSupportedBuild`
 * is a separate field from `latestBuild`, it defaults to 0 (nothing is ever
 * forced), and raising it is an explicit decision recorded in one place. A
 * routine release moves `latestBuild` alone and produces a dismissible prompt.
 *
 * Stored in the existing Setting key/value table rather than a new one: this
 * is configuration, it is read constantly and written rarely, and it does not
 * warrant its own migration.
 */
import { SettingService } from './setting_service';

export type AppPlatform = 'android' | 'ios';

export interface ReleasePolicy {
    platform: AppPlatform;
    /** Human version, e.g. "1.5.0". Display only. */
    latestVersion: string;
    /** The comparable integer. Android versionCode, iOS build number. */
    latestBuild: number;
    /**
     * Builds below this cannot continue. 0 disables forcing entirely, which is
     * the default and should stay the default for routine releases.
     */
    minimumSupportedBuild: number;
    /** Shown to the driver. Kept short — it lands in a dialog, not a page. */
    message: string;
    storeUrl: string;
}

/** What the app is told, including the verdict so the client cannot get it wrong. */
export interface ReleaseCheck extends ReleasePolicy {
    /** The build that asked, echoed back for the audit trail. */
    currentBuild: number | null;
    updateAvailable: boolean;
    updateRequired: boolean;
}

const KEY: Record<AppPlatform, string> = {
    android: 'driver_release_policy_android',
    ios: 'driver_release_policy_ios',
};

/*
 * Defaults describe the build that is actually on the store right now.
 * `minimumSupportedBuild: 0` means nothing is forced until somebody decides
 * otherwise — a default that can strand drivers is not a safe default.
 */
const DEFAULTS: Record<AppPlatform, ReleasePolicy> = {
    android: {
        platform: 'android',
        latestVersion: '1.5.0',
        latestBuild: 50,
        minimumSupportedBuild: 0,
        message: 'A new KekeRide Driver update is available.',
        storeUrl: 'https://play.google.com/store/apps/details?id=ng.kekeride.driver',
    },
    ios: {
        platform: 'ios',
        latestVersion: '1.5.0',
        latestBuild: 50,
        minimumSupportedBuild: 0,
        message: 'A new KekeRide Driver update is available.',
        // Replaced with the real listing once the app is on the App Store.
        storeUrl: '',
    },
};

export class AppReleaseService {
    static async get(platform: AppPlatform): Promise<ReleasePolicy> {
        try {
            const raw = await SettingService.getSetting(KEY[platform], '');
            if (!raw) return DEFAULTS[platform];
            const parsed = JSON.parse(raw);
            // Merge over the defaults so a partially-written setting cannot
            // produce a policy with a missing store URL or a NaN build.
            return { ...DEFAULTS[platform], ...parsed, platform };
        } catch {
            // A malformed setting must not stop drivers working. The default
            // never forces an update, so the failure mode is "no prompt".
            return DEFAULTS[platform];
        }
    }

    static async set(platform: AppPlatform, patch: Partial<ReleasePolicy>): Promise<ReleasePolicy> {
        const current = await this.get(platform);
        const next: ReleasePolicy = {
            ...current,
            ...patch,
            platform,
            latestBuild: Math.max(0, Number(patch.latestBuild ?? current.latestBuild) | 0),
            minimumSupportedBuild:
                Math.max(0, Number(patch.minimumSupportedBuild ?? current.minimumSupportedBuild) | 0),
        };

        /*
         * Refuse a policy that would lock out the build we are telling people
         * to install. This is the one mistake here that takes the whole fleet
         * off the road at once.
         */
        if (next.minimumSupportedBuild > next.latestBuild) {
            throw new Error(
                `minimumSupportedBuild (${next.minimumSupportedBuild}) cannot exceed `
                + `latestBuild (${next.latestBuild}) — that would block every driver.`);
        }

        await SettingService.setSetting(KEY[platform], JSON.stringify(next));
        console.log(JSON.stringify({
            level: 'info', scope: 'app_release', event: 'policy_updated',
            platform, latestBuild: next.latestBuild,
            minimumSupportedBuild: next.minimumSupportedBuild,
        }));
        return next;
    }

    /** The answer the app actually acts on. */
    static async check(platform: AppPlatform, currentBuild: number | null): Promise<ReleaseCheck> {
        const policy = await this.get(platform);
        const build = Number.isFinite(currentBuild as number) ? (currentBuild as number) : null;

        return {
            ...policy,
            currentBuild: build,
            // An unknown build is treated as up to date. Guessing "outdated"
            // would nag every driver whose app failed to report its version.
            updateAvailable: build !== null && build < policy.latestBuild,
            updateRequired:
                build !== null
                && policy.minimumSupportedBuild > 0
                && build < policy.minimumSupportedBuild,
        };
    }
}
