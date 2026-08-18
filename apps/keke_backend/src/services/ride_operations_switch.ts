import { redis } from '../config/redis';

/**
 * The Ride Operations telemetry kill switch.
 *
 * Dispatch telemetry (the durable `dispatch_event` trail behind the Ride
 * Operations console) is written from inside the live dispatch path. It is
 * already fire-and-forget and swallows its own errors — see
 * DispatchMonitorService — but "already safe" is not the same as "can be turned
 * off at 09:00 on a Monday without a deploy". This is that control.
 *
 * Two layers, mirroring ParkDispatchSwitch deliberately so there is one shape
 * of kill switch in this system rather than two:
 *
 *   1. `RIDE_OPERATIONS_TELEMETRY_ENABLED` (env, default TRUE) — the shipped
 *      posture. Changing it needs a container restart.
 *
 *   2. A Redis override — takes effect within [[CACHE_TTL_MS]], no restart.
 *
 * The override can only DISABLE. It cannot switch telemetry on when the
 * environment says off.
 *
 * ## Why the value is cached
 *
 * The other switch can afford a Redis GET per dispatch decision. This one
 * cannot: telemetry fires many times per ride (one row per candidate
 * discovered, per eligibility rejection, per offer), and every one of those
 * sits on the dispatch path. An awaited round-trip per event would put network
 * I/O between a passenger and a driver — precisely the thing rule 1 of this
 * work forbids.
 *
 * So the check is a synchronous read of a cached boolean, refreshed in the
 * background at most once per [[CACHE_TTL_MS]]. The refresh never blocks a
 * caller: whoever notices the cache is stale kicks off a refresh and proceeds
 * with the value it already had.
 *
 * ## What "off" means
 *
 * Off stops NEW dispatch telemetry rows being written. It does not alter
 * dispatch behaviour in any way — no timing, no ordering, no eligibility, no
 * outcome. Rides dispatched while it is off simply have a thinner trail, and
 * the console says so rather than inventing one. Terminal outcome codes on the
 * ride row itself (`outcomeReason`) are NOT governed by this switch: those are
 * part of the ride record, not telemetry, and are written on the same
 * transaction path as the status they explain.
 *
 * If Redis is unreachable the switch reports "not disabled". Redis being down
 * is not a reason to lose observability, and the env variable remains as the
 * harder control.
 */
const KEY = 'ride_operations:telemetry_disabled';

/** How long a cached switch reading is trusted before a background refresh. */
const CACHE_TTL_MS = 5_000;

function envEnabled(): boolean {
    const raw = process.env.RIDE_OPERATIONS_TELEMETRY_ENABLED;
    if (raw == null || raw.trim() === '') return true;
    return raw.trim().toLowerCase() !== 'false';
}

export interface TelemetrySwitchState {
    /** Effective posture right now. */
    enabled: boolean;
    /** The shipped posture from the environment. */
    envEnabled: boolean;
    /** Whether a Redis override is currently suppressing telemetry. */
    overrideDisabled: boolean;
    reason: string | null;
    setBy: string | null;
    setAt: string | null;
}

export class RideOperationsSwitch {
    private static cachedDisabled = false;
    private static cachedAt = 0;
    private static refreshing = false;

    /**
     * Synchronous, allocation-free, and safe to call on the dispatch path.
     *
     * Returns the last known posture and refreshes in the background when the
     * cache has aged out. The first call in a process returns the env posture,
     * which is the correct default: a freshly started container has not yet
     * been told to suppress anything.
     */
    static isEnabled(): boolean {
        if (!envEnabled()) return false;
        if (Date.now() - this.cachedAt > CACHE_TTL_MS) this.scheduleRefresh();
        return !this.cachedDisabled;
    }

    private static scheduleRefresh(): void {
        if (this.refreshing) return;
        this.refreshing = true;
        // Detached on purpose: nobody awaits this, and a slow or failing Redis
        // must not appear as latency anywhere on the dispatch path.
        void (async () => {
            try {
                const v = await redis.get(KEY);
                this.cachedDisabled = v !== null;
            } catch {
                // Unreachable Redis is not a reason to drop observability.
                this.cachedDisabled = false;
            } finally {
                this.cachedAt = Date.now();
                this.refreshing = false;
            }
        })();
    }

    /** Authoritative read, for the admin surface. Not for the dispatch path. */
    static async state(): Promise<TelemetrySwitchState> {
        const env = envEnabled();
        try {
            const raw = await redis.get(KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            return {
                enabled: env && raw === null,
                envEnabled: env,
                overrideDisabled: raw !== null,
                reason: parsed?.reason ?? null,
                setBy: parsed?.setBy ?? null,
                setAt: parsed?.setAt ?? null,
            };
        } catch {
            return {
                enabled: env,
                envEnabled: env,
                overrideDisabled: false,
                reason: null,
                setBy: null,
                setAt: null,
            };
        }
    }

    /** Suppress telemetry without a deploy. Disable-only, by design. */
    static async disable(reason: string, setBy: string): Promise<void> {
        await redis.set(
            KEY,
            JSON.stringify({ reason, setBy, setAt: new Date().toISOString() }),
        );
        this.cachedDisabled = true;
        this.cachedAt = Date.now();
    }

    /** Clear the override. Falls back to whatever the environment says. */
    static async enable(): Promise<void> {
        await redis.del(KEY);
        this.cachedDisabled = false;
        this.cachedAt = Date.now();
    }

    /** Testing seam: drop cached state so a test can set its own posture. */
    static resetCache(): void {
        this.cachedDisabled = false;
        this.cachedAt = 0;
        this.refreshing = false;
    }
}
