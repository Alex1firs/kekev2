/**
 * How the operational notification path is doing, and whether marketing may run.
 *
 * ── Why marketing watches operational, not the reverse ───────────────────
 * The two systems share one thing that can be exhausted: KekeRide's quota and
 * connection to FCM. If ride alerts start failing or slowing, the last thing
 * that should be competing for that capacity is a promotion. So marketing asks
 * this before every batch, and stops when the answer is no.
 *
 * Operational traffic never asks. It does not consult this module, it cannot be
 * paused by it, and NotificationService does not import it — the recording hook
 * is a fire-and-forget call that cannot throw into the send path. A monitor
 * that could delay the thing it monitors would be worse than no monitor.
 *
 * ── Redis, with a fail-open for operational and fail-CLOSED for marketing ─
 * If Redis is unavailable we cannot know whether operational traffic is
 * healthy. Operational sending is unaffected either way. Marketing stops,
 * because "we cannot tell" is not a reason to add load.
 */

import { redis } from '../config/redis';

/** Rolling window over which failures are judged. */
const WINDOW_SECONDS = 300;

/** Failure share above which operational is considered degraded. */
const DEGRADED_FAILURE_RATE = 0.25;

/** Below this many attempts the rate is noise, not a signal. */
const MIN_SAMPLE = 20;

/** Median send duration above which FCM is considered slow, in milliseconds. */
const DEGRADED_LATENCY_MS = 5_000;

/** How long marketing stays paused after a degradation is seen. */
const COOLDOWN_SECONDS = 600;

const K = {
    attempts: 'push:op:attempts',
    failures: 'push:op:failures',
    latency: 'push:op:latency_ms',
    pausedUntil: 'push:marketing:paused_until',
    manualPause: 'push:marketing:manual_pause',
};

export interface OperationalHealth {
    healthy: boolean;
    attempts: number;
    failures: number;
    failureRate: number;
    avgLatencyMs: number | null;
    reasons: string[];
}

export class OperationalPushHealth {
    /**
     * Record the outcome of an operational send.
     *
     * Called fire-and-forget from NotificationService. Every error is swallowed:
     * a monitoring write must never be able to fail a ride notification, and a
     * lost sample is worth incomparably less than a delayed alert.
     */
    static record(attempted: number, failed: number, durationMs: number): void {
        void (async () => {
            try {
                const pipeline = redis.pipeline();
                pipeline.incrby(K.attempts, attempted);
                pipeline.expire(K.attempts, WINDOW_SECONDS);
                pipeline.incrby(K.failures, failed);
                pipeline.expire(K.failures, WINDOW_SECONDS);
                // A short list of recent durations, for a median that one slow
                // send cannot dominate.
                pipeline.lpush(K.latency, String(Math.round(durationMs)));
                pipeline.ltrim(K.latency, 0, 49);
                pipeline.expire(K.latency, WINDOW_SECONDS);
                await pipeline.exec();

                if (failed > 0 && attempted > 0 && failed / attempted >= DEGRADED_FAILURE_RATE) {
                    // Pause immediately rather than waiting for the next poll:
                    // the degradation is happening now.
                    await redis.setex(K.pausedUntil, COOLDOWN_SECONDS,
                        String(Date.now() + COOLDOWN_SECONDS * 1000));
                }
            } catch {
                /* monitoring only */
            }
        })();
    }

    static async health(): Promise<OperationalHealth> {
        try {
            const [attemptsRaw, failuresRaw, latencies] = await Promise.all([
                redis.get(K.attempts),
                redis.get(K.failures),
                redis.lrange(K.latency, 0, -1),
            ]);

            const attempts = Number(attemptsRaw ?? 0);
            const failures = Number(failuresRaw ?? 0);
            const failureRate = attempts > 0 ? failures / attempts : 0;

            const nums = latencies.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            const avgLatencyMs = nums.length ? nums[Math.floor(nums.length / 2)] : null;

            const reasons: string[] = [];
            // Below the sample floor the rate is noise; a single failed send out
            // of two should not stop a campaign.
            if (attempts >= MIN_SAMPLE && failureRate >= DEGRADED_FAILURE_RATE) {
                reasons.push(`${Math.round(failureRate * 100)}% of operational pushes are failing.`);
            }
            if (avgLatencyMs != null && avgLatencyMs >= DEGRADED_LATENCY_MS) {
                reasons.push(`Operational pushes are taking ${avgLatencyMs}ms.`);
            }

            return { healthy: reasons.length === 0, attempts, failures, failureRate, avgLatencyMs, reasons };
        } catch {
            /*
             * Cannot read the monitor. Reported as UNhealthy so marketing
             * stops — see the note on fail-closed at the top. Operational
             * sending never consults this and is unaffected.
             */
            return {
                healthy: false, attempts: 0, failures: 0, failureRate: 0, avgLatencyMs: null,
                reasons: ['Cannot read operational push health.'],
            };
        }
    }

    /**
     * May a marketing batch run right now?
     *
     * Asked before EVERY batch, not once per campaign: a degradation that
     * begins halfway through a send must stop the remainder of it.
     */
    static async marketingMayRun(): Promise<{ allowed: boolean; reason?: string }> {
        try {
            if (await redis.get(K.manualPause)) {
                return { allowed: false, reason: 'Marketing push is paused by operations.' };
            }
            const pausedUntil = await redis.get(K.pausedUntil);
            if (pausedUntil && Number(pausedUntil) > Date.now()) {
                const seconds = Math.ceil((Number(pausedUntil) - Date.now()) / 1000);
                return {
                    allowed: false,
                    reason: `Operational notifications were degraded; marketing resumes in ${seconds}s.`,
                };
            }
        } catch {
            return { allowed: false, reason: 'Cannot confirm operational health.' };
        }

        const health = await this.health();
        if (!health.healthy) {
            // Latch the pause so the next batch does not have to rediscover it.
            try {
                await redis.setex(K.pausedUntil, COOLDOWN_SECONDS,
                    String(Date.now() + COOLDOWN_SECONDS * 1000));
            } catch { /* best effort */ }
            return { allowed: false, reason: health.reasons.join(' ') };
        }
        return { allowed: true };
    }

    /** Operations pausing marketing by hand. Never affects operational push. */
    static async pauseMarketing(reason: string): Promise<void> {
        await redis.set(K.manualPause, reason || 'paused');
    }

    static async resumeMarketing(): Promise<void> {
        await redis.del(K.manualPause);
        await redis.del(K.pausedUntil);
    }
}
