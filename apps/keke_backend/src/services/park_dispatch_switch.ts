import { redis } from '../config/redis';

/**
 * The Park Dispatch kill switch.
 *
 * Two layers, deliberately:
 *
 *   1. `PARK_DISPATCH_ENABLED` (env, default TRUE as of launch) — the shipped
 *      posture. Changing it needs a container restart, which on this stack
 *      means a ~10 second window where the API returns 502.
 *
 *   2. This Redis override — takes effect on the next request, no restart, no
 *      deploy. It is what you actually reach for at 09:00 on a Monday when the
 *      park floor is going wrong and ten seconds of 502 is ten seconds of
 *      passengers being told the app is broken.
 *
 * The override can only DISABLE. It cannot turn Park Dispatch on when the
 * environment says off — an operator holding a monitoring credential should
 * never be able to switch on a dispatch path that the deployment has not
 * enabled.
 *
 * ## What "off" means
 *
 * Off stops NEW work entering the park phase. It does not abandon work already
 * in flight: a job a dispatcher has already claimed can still be assigned, and
 * a driver who has already been offered a ride can still accept it. Killing
 * live jobs would strand passengers who are, at that moment, being served
 * perfectly well — the opposite of what the switch is for. In-flight jobs drain
 * within one claim/assign window (~70s at defaults), and nothing new arrives
 * behind them.
 *
 * If Redis is unreachable the switch reports "not disabled": Redis being down
 * is not a reason to take a working dispatch path offline, and the env variable
 * is still there as the harder control.
 */
const KEY = 'park_dispatch:disabled';

export interface KillSwitchState {
    disabled: boolean;
    reason: string | null;
    setBy: string | null;
    setAt: string | null;
}

export class ParkDispatchSwitch {
    /**
     * Cheap enough to call on every dispatch decision: one Redis GET on a key
     * that is almost always absent.
     */
    static async isDisabled(): Promise<boolean> {
        try {
            return (await redis.get(KEY)) !== null;
        } catch (err) {
            console.error('[park-dispatch-switch] read failed, treating as enabled:', err);
            return false;
        }
    }

    static async state(): Promise<KillSwitchState> {
        try {
            const raw = await redis.get(KEY);
            if (raw === null) return { disabled: false, reason: null, setBy: null, setAt: null };
            const parsed = JSON.parse(raw);
            return {
                disabled: true,
                reason: parsed.reason ?? null,
                setBy: parsed.setBy ?? null,
                setAt: parsed.setAt ?? null,
            };
        } catch {
            // A key that exists but does not parse is still a kill signal.
            return { disabled: true, reason: null, setBy: null, setAt: null };
        }
    }

    /**
     * No TTL. A kill switch that silently re-arms the system after an hour is a
     * trap — whoever turned it off decides when it comes back.
     */
    static async disable(reason: string, setBy: string, setAt: Date = new Date()): Promise<void> {
        await redis.set(KEY, JSON.stringify({ reason, setBy, setAt: setAt.toISOString() }));
    }

    static async enable(): Promise<void> {
        await redis.del(KEY);
    }
}
