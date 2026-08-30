/**
 * Service zone runtime configuration.
 *
 * Two levers, with deliberately different amounts of friction:
 *
 *   SERVICE_ZONES_ENABLED   the EMERGENCY kill switch. An environment
 *                           variable, so changing it needs a deploy — it must
 *                           not be something anybody can flip at 2am and
 *                           forget. While false, every dispatch logs a warning
 *                           and the health endpoint reports it, so the
 *                           override cannot quietly become the running
 *                           configuration.
 *
 *   zone.enforcement        the ROUTINE dial, per zone, in the database. No
 *                           deploy, effective within the cache TTL. This is
 *                           what planned rollout uses.
 */

export const ServiceZoneConfig = {
    /**
     * Master switch. False short-circuits the resolver everywhere and every
     * path behaves exactly as it did before service zones existed.
     */
    get enabled(): boolean {
        const raw = (process.env.SERVICE_ZONES_ENABLED ?? 'true').trim().toLowerCase();
        return raw !== 'false' && raw !== '0' && raw !== 'no';
    },

    /**
     * How long the in-process zone set may be stale.
     *
     * Zones change roughly never, and resolution happens on every ride request
     * and every dispatch tier, so this is cached aggressively. An admin write
     * busts the cache explicitly, making the TTL a backstop for other processes
     * (the other blue-green colour, a worker) rather than the primary path.
     */
    get cacheTtlMs(): number {
        const raw = Number(process.env.SERVICE_ZONE_CACHE_TTL_MS);
        return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
    },
};

/**
 * Why the disabled state is loud.
 *
 * A kill switch that is quiet is a kill switch that stays on. This is called on
 * every dispatch while the override is active — not once at boot, where it
 * would scroll away within minutes and nobody would ever see it again.
 */
export function warnZonesDisabled(context: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({
        level: 'warn',
        scope: 'service_zone',
        event: 'zones_globally_disabled',
        detail: 'SERVICE_ZONES_ENABLED=false — geographic constraint is NOT being applied',
        ...context,
    }));
}
