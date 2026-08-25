/**
 * The driver app release policy.
 *
 * The rule that matters most here is that a routine release must never take
 * drivers off the road. Forcing is a separate, deliberate act, and one
 * mistyped number must not strand the fleet.
 */
import { AppReleaseService } from '../../src/services/app_release_service';
import { SettingService } from '../../src/services/setting_service';

describe('driver release policy', () => {
    const store = new Map<string, string>();

    beforeEach(() => {
        store.clear();
        jest.spyOn(SettingService, 'getSetting')
            .mockImplementation(async (k: string, d: string) => store.get(k) ?? d);
        jest.spyOn(SettingService, 'setSetting')
            .mockImplementation(async (k: string, v: string) => { store.set(k, v); });
    });
    afterEach(() => jest.restoreAllMocks());

    // ── Defaults ────────────────────────────────────────────────────────

    it('forces nothing by default', async () => {
        const p = await AppReleaseService.get('android');
        // A default that can strand drivers is not a safe default.
        expect(p.minimumSupportedBuild).toBe(0);
        expect(p.storeUrl).toContain('ng.kekeride.driver');
    });

    it('a malformed stored policy falls back rather than blocking anyone', async () => {
        store.set('driver_release_policy_android', '{ this is not json');
        const check = await AppReleaseService.check('android', 30);
        expect(check.updateRequired).toBe(false);
        expect(check.latestBuild).toBe(50);
    });

    // ── The verdict ─────────────────────────────────────────────────────

    it('an older build is offered an update, not forced', async () => {
        const check = await AppReleaseService.check('android', 30);
        expect(check.updateAvailable).toBe(true);
        expect(check.updateRequired).toBe(false);
    });

    it('the current build is offered nothing', async () => {
        const check = await AppReleaseService.check('android', 50);
        expect(check.updateAvailable).toBe(false);
        expect(check.updateRequired).toBe(false);
    });

    it('a newer build than the store is not nagged', async () => {
        // An internal build, or a policy not yet bumped after a release.
        const check = await AppReleaseService.check('android', 60);
        expect(check.updateAvailable).toBe(false);
    });

    it('an unknown build is treated as up to date', async () => {
        // Nagging every driver whose app failed to report its version would
        // punish them for our bug.
        const check = await AppReleaseService.check('android', null);
        expect(check.updateAvailable).toBe(false);
        expect(check.updateRequired).toBe(false);
    });

    it('forcing applies only below the explicit minimum', async () => {
        await AppReleaseService.set('android', { latestBuild: 50, minimumSupportedBuild: 40 });

        expect((await AppReleaseService.check('android', 39)).updateRequired).toBe(true);
        expect((await AppReleaseService.check('android', 40)).updateRequired).toBe(false);
        // Still offered the newer build, just not forced.
        expect((await AppReleaseService.check('android', 40)).updateAvailable).toBe(true);
    });

    // ── The guard that matters ──────────────────────────────────────────

    it('refuses a minimum above the latest build — that would block everyone', async () => {
        /*
         * The whole fleet, including drivers who just updated, would be locked
         * out by a policy demanding a build that does not exist. One typo.
         */
        await expect(
            AppReleaseService.set('android', { latestBuild: 50, minimumSupportedBuild: 60 }),
        ).rejects.toThrow(/cannot exceed/);

        // And nothing was written.
        expect((await AppReleaseService.get('android')).minimumSupportedBuild).toBe(0);
    });

    it('keeps the platforms separate', async () => {
        await AppReleaseService.set('android', { latestBuild: 50 });
        await AppReleaseService.set('ios', { latestBuild: 12, latestVersion: '1.0.0' });

        expect((await AppReleaseService.get('android')).latestBuild).toBe(50);
        expect((await AppReleaseService.get('ios')).latestBuild).toBe(12);
        // An Android release must not tell iOS drivers they are outdated.
        expect((await AppReleaseService.check('ios', 12)).updateAvailable).toBe(false);
    });

    it('a partial update leaves the rest of the policy intact', async () => {
        await AppReleaseService.set('android', { latestBuild: 51, latestVersion: '1.5.1' });
        const p = await AppReleaseService.get('android');
        expect(p.storeUrl).toContain('play.google.com');   // not lost
        expect(p.minimumSupportedBuild).toBe(0);           // not silently raised
    });
});
