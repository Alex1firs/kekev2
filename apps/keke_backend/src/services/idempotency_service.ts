import { redis } from '../config/redis';

/**
 * Replay-safe responses for actions that must not happen twice.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A dispatcher assigns a driver on a park tablet, the connection stalls, the
 * reply never arrives. They tap again. Without this, the second request either
 * assigns a second time or — because the job is no longer claimable — comes
 * back as "already assigned", which reads as a failure for something that
 * actually worked. Both outcomes teach a dispatcher to distrust the screen.
 *
 * With it, the retry returns the ORIGINAL outcome: same driver, same message,
 * no second assignment.
 *
 * ── What this is not ────────────────────────────────────────────────────
 * Not a substitute for the atomic arbiter. The conditional UPDATE on the ride
 * remains the only thing that decides who gets it; this sits in front, so the
 * arbiter is not asked the same question twice. If Redis is unavailable the
 * request proceeds unprotected — the arbiter still guarantees correctness, and
 * refusing to dispatch because a cache is down would be the worse failure.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Keys are namespaced per actor, so one dispatcher's key can never replay
 * another's result, and expire after a few minutes: long enough to cover a
 * retry over a bad connection, far too short to hide a genuine second
 * assignment made deliberately later.
 */

const TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS) || 300;
const IN_FLIGHT = '__in_flight__';

export interface ReplayedResult<T> {
    replayed: boolean;
    value: T;
}

export class IdempotencyService {
    private static keyFor(scope: string, actorId: string, key: string): string {
        // The actor is part of the key so a guessed or copied idempotency key
        // cannot make one staff member replay another's outcome.
        return `idem:${scope}:${actorId}:${key}`;
    }

    /**
     * Run `fn` at most once for this (scope, actor, key).
     *
     * The first caller wins a marker and executes. A concurrent second caller
     * sees the marker and is told the work is already running rather than being
     * allowed to duplicate it. A later caller gets the stored result back.
     *
     * A FAILED attempt does not store anything: the key stays usable, because a
     * dispatcher whose assignment genuinely errored must be able to try again.
     */
    static async run<T>(
        scope: string,
        actorId: string,
        key: string | null | undefined,
        fn: () => Promise<T>,
    ): Promise<ReplayedResult<T>> {
        if (!key) return { replayed: false, value: await fn() };

        const redisKey = this.keyFor(scope, actorId, key);

        let claimed = false;
        try {
            claimed = (await redis.set(redisKey, IN_FLIGHT, 'EX', TTL_SECONDS, 'NX')) === 'OK';
        } catch (err) {
            // Redis down: proceed unprotected rather than refuse to dispatch.
            console.error('[idempotency] claim failed, proceeding unprotected:', (err as Error)?.message);
            return { replayed: false, value: await fn() };
        }

        if (!claimed) {
            const stored = await redis.get(redisKey).catch(() => null);
            if (stored && stored !== IN_FLIGHT) {
                return { replayed: true, value: JSON.parse(stored) as T };
            }
            /*
             * Still in flight. This is a genuine double-submit — two taps
             * milliseconds apart — and the honest answer is that the first one
             * is still being worked on, not that it failed.
             */
            throw new InFlightError();
        }

        try {
            const value = await fn();
            await redis.set(redisKey, JSON.stringify(value), 'EX', TTL_SECONDS).catch(() => {});
            return { replayed: false, value };
        } catch (err) {
            // Release the key so a real retry is possible.
            await redis.del(redisKey).catch(() => {});
            throw err;
        }
    }
}

/** Raised when the same idempotency key is already being processed. */
export class InFlightError extends Error {
    constructor() {
        super('That action is already being processed.');
        this.name = 'InFlightError';
    }
}
