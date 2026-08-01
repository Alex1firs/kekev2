/**
 * Expires park dispatch jobs whose window has elapsed.
 *
 * A job left OFFERED because nobody was watching the device, or CLAIMED because
 * a dispatcher walked away, must not hold a passenger's ride open indefinitely.
 * The sweep resolves it and either offers the next park or lets the ride fail —
 * which is exactly where the ride would have been had no park taken it.
 *
 * Modelled on StaleRideSweeper, including the Postgres ADVISORY LOCK: several
 * backend instances may run this, and only one may act in a given tick.
 * Without it, two instances would both expire the same job and both try to
 * offer the next park.
 *
 * Runs only when PARK_DISPATCH_ENABLED is true. With the feature off there is
 * nothing to sweep and the timer is never armed.
 */
import { AppDataSource } from '../config/data_source';
import { ParkDispatchService } from './park_dispatch_service';
import { loadParkDispatchConfig } from '../config/park_dispatch_config';

/** Distinct from the stale-ride sweeper's lock id so the two never contend. */
const ADVISORY_LOCK_ID = 918_273_641;

function intervalMs(): number {
    const raw = Number(process.env.PARK_JOB_SWEEP_INTERVAL_MS);
    return Number.isFinite(raw) && raw >= 1000 ? raw : 10_000;
}

export class ParkJobSweeper {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;

    static start(): void {
        if (this.timer) return;
        if (!loadParkDispatchConfig().enabled) {
            console.log(JSON.stringify({
                level: 'info',
                message: 'Park job sweeper not started — PARK_DISPATCH_ENABLED is false',
            }));
            return;
        }

        this.timer = setInterval(() => { void this.tick(); }, intervalMs());
        // Never hold the process open on our account.
        this.timer.unref?.();
        console.log(JSON.stringify({
            level: 'info',
            message: `Park job sweeper started (every ${intervalMs()}ms)`,
        }));
    }

    static stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One pass. Exported for tests, which drive it directly rather than on a timer. */
    static async tick(): Promise<number> {
        // Overlap guard for a slow pass on one instance.
        if (this.running) return 0;
        this.running = true;

        let lockHeld = false;
        try {
            const rows = await AppDataSource.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_ID]);
            lockHeld = rows?.[0]?.locked === true;
            if (!lockHeld) return 0;

            const expired = await ParkDispatchService.sweepExpired(new Date());
            if (expired > 0) {
                console.log(JSON.stringify({ level: 'info', event: 'park_jobs_expired', count: expired }));
            }
            return expired;
        } catch (err: any) {
            // A sweep failure must never take the process down; the next tick
            // sees the same expired jobs and tries again.
            console.error(JSON.stringify({ level: 'error', event: 'park_job_sweep_failed', error: err?.message }));
            return 0;
        } finally {
            if (lockHeld) {
                try {
                    await AppDataSource.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
                } catch {
                    /* the lock is session-scoped; a dropped connection releases it */
                }
            }
            this.running = false;
        }
    }
}
