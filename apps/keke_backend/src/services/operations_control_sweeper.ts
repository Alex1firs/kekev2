/**
 * Returns lapsed takeover leases to automatic dispatch.
 *
 * This is the mechanism that makes "a disconnect does not release control"
 * safe. Control can be held without any client contact — but not forever, and
 * not by a client that has died. The server's clock decides, on a timer that
 * runs whether or not anybody is connected.
 *
 * Modelled on StaleRideSweeper: same lifecycle, same overlap guard, same
 * refusal to let one bad tick stop the next.
 */
import { RideControlService } from './ride_control_service';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';

export class OperationsControlSweeper {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;

    static start(): void {
        if (this.timer) return;
        const config = loadOperationsDispatchConfig();
        if (!config.enabled) {
            console.log('[OPS_SWEEP] Operations Dispatch disabled — sweeper not started.');
            return;
        }
        this.timer = setInterval(() => void this.tick(), config.sweepIntervalMs);
        // Never hold the process open on this alone.
        this.timer.unref?.();
        console.log(`[OPS_SWEEP] started (every ${config.sweepIntervalMs}ms)`);
    }

    static stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    static async tick(): Promise<number> {
        // A slow tick must not overlap the next: two sweeps racing would try to
        // release the same lease twice, and while that is harmless (the second
        // finds AUTO and succeeds idempotently) it wastes a database round trip
        // per expired lease for no reason.
        if (this.running) return 0;
        this.running = true;
        try {
            const swept = await RideControlService.sweepExpired();
            if (swept > 0) {
                console.log(JSON.stringify({
                    level: 'info', scope: 'ops_sweep', event: 'leases_expired', count: swept,
                }));
            }
            return swept;
        } catch (err: any) {
            // Logged and swallowed. A failed sweep must not stop the next one —
            // and a lease that outlives its expiry by one interval is a far
            // smaller problem than a sweeper that has stopped.
            console.error('[OPS_SWEEP] tick failed:', err?.message);
            return 0;
        } finally {
            this.running = false;
        }
    }
}
