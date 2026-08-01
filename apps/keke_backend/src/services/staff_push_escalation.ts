import { redis } from '../config/redis';
import { StaffPushService } from './staff_push_service';
import { PushReason } from '../models/StaffPushDelivery';

/**
 * How hard we chase a dispatcher who has not answered.
 *
 * ── The shape of it ─────────────────────────────────────────────────────
 *   1. one notification the moment the job arrives;
 *   2. one reminder after `reminderMs` if it is still unclaimed;
 *   3. one final call shortly before it expires;
 *   4. nothing, ever again, once it is claimed, assigned, cancelled, expired,
 *      or Park Dispatch is suspended.
 *
 * Three alerts, then silence. An alarm that cannot be escaped gets the phone
 * put on silent for the rest of the shift, and then nothing is heard again all
 * day — which is strictly worse than one missed request.
 *
 * ── Why Redis and not a timer ───────────────────────────────────────────
 * `setTimeout` dies with the process. A deploy in the middle of a shift would
 * silently cancel every pending reminder and nobody would know until a
 * passenger complained. Schedules live in Redis with a TTL and are swept, so
 * they survive a restart and expire on their own if the sweeper stops.
 */

const KEY_PREFIX = 'park_push:pending:';

/** Tuning, all overridable without a deploy. */
function config() {
    const num = (name: string, fallback: number) => {
        const raw = process.env[name];
        const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        enabled: (process.env.PARK_PUSH_ENABLED ?? 'true').toLowerCase() !== 'false',
        /** First reminder, if still unclaimed. */
        reminderMs: num('PARK_PUSH_REMINDER_MS', 12_000),
        /**
         * Final call, measured BACKWARDS from expiry — a reminder that lands
         * after the request has gone is worse than none, because it sends a
         * dispatcher to a job that is not there.
         */
        finalBeforeExpiryMs: num('PARK_PUSH_FINAL_BEFORE_EXPIRY_MS', 8_000),
    };
}

interface PendingJob {
    jobId: string;
    rideId: string;
    parkId: string;
    pickupAddress: string | null;
    expiresAt: string;
    remindAt: number;
    finalAt: number;
    sent: { reminder?: boolean; final?: boolean };
}

export class StaffPushEscalation {
    /**
     * Notification copy.
     *
     * A lock screen is a public surface — it lights up on a table, in a shared
     * room, in a pocket someone else can see. So: the landmark, the fare band
     * if useful, and nothing else. No passenger name, no phone number, no
     * payment detail, no instructions that mean anything to a stranger.
     */
    private static copyFor(pickupAddress: string | null, reason: PushReason): { title: string; body: string } {
        const where = pickupAddress?.trim() ? `Pickup near ${pickupAddress.trim()}` : 'A passenger is waiting';

        switch (reason) {
            case PushReason.REMINDER:
                return {
                    title: 'Still waiting — KekeRide',
                    body: `${where}. Nobody has taken it yet.`,
                };
            case PushReason.FINAL_REMINDER:
                return {
                    title: 'About to expire — KekeRide',
                    body: `${where}. This request is about to be lost.`,
                };
            default:
                return {
                    title: 'New KekeRide request',
                    body: `${where}. Open Park Dispatch to assign a driver.`,
                };
        }
    }

    /** A job has arrived at a park. Alert now, and schedule the follow-ups. */
    static async onJobOffered(job: {
        jobId: string; rideId: string; parkId: string;
        pickupAddress: string | null; expiresAt: Date;
    }): Promise<void> {
        const cfg = config();
        if (!cfg.enabled) return;

        const copy = this.copyFor(job.pickupAddress, PushReason.NEW_REQUEST);
        await StaffPushService.notifyParkDispatchers({
            parkId: job.parkId,
            jobId: job.jobId,
            rideId: job.rideId,
            title: copy.title,
            body: copy.body,
            reason: PushReason.NEW_REQUEST,
        });

        const expiresAt = new Date(job.expiresAt).getTime();
        const now = Date.now();
        const pending: PendingJob = {
            jobId: job.jobId,
            rideId: job.rideId,
            parkId: job.parkId,
            pickupAddress: job.pickupAddress,
            expiresAt: new Date(job.expiresAt).toISOString(),
            remindAt: now + cfg.reminderMs,
            finalAt: expiresAt - cfg.finalBeforeExpiryMs,
            sent: {},
        };

        /*
         * TTL slightly past expiry. Even if the sweeper never runs again, the
         * schedule cleans itself up rather than accumulating.
         */
        const ttlSeconds = Math.max(30, Math.ceil((expiresAt - now) / 1000) + 30);
        await redis.setex(`${KEY_PREFIX}${job.jobId}`, ttlSeconds, JSON.stringify(pending))
            .catch(() => { /* a missing reminder must not fail the offer */ });
    }

    /**
     * Stop chasing.
     *
     * Called on every terminal transition. Idempotent, and safe to call for a
     * job that was never scheduled.
     */
    static async stop(jobId: string): Promise<void> {
        await redis.del(`${KEY_PREFIX}${jobId}`).catch(() => { /* best effort */ });
    }

    /**
     * Send whatever is due. Called by the park job sweeper on its normal tick,
     * so there is no second timer to keep alive.
     *
     * Returns how many reminders went out, for the sweeper's log.
     */
    static async sweep(now: Date = new Date()): Promise<number> {
        const cfg = config();
        if (!cfg.enabled) return 0;

        let cursor = '0';
        let sent = 0;

        do {
            // SCAN, not KEYS: this runs every ten seconds against the same
            // Redis the dispatch reservations live in.
            const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
            cursor = next;

            for (const key of keys) {
                const raw = await redis.get(key);
                if (!raw) continue;

                let p: PendingJob;
                try { p = JSON.parse(raw); } catch { await redis.del(key); continue; }

                const t = now.getTime();
                const expired = t >= new Date(p.expiresAt).getTime();
                if (expired) { await redis.del(key); continue; }

                let due: PushReason | null = null;
                if (!p.sent.final && p.finalAt > 0 && t >= p.finalAt) due = PushReason.FINAL_REMINDER;
                else if (!p.sent.reminder && t >= p.remindAt) due = PushReason.REMINDER;
                if (!due) continue;

                /*
                 * Re-check the job before chasing anyone. Between scheduling and
                 * now a dispatcher may have claimed it, a driver may have been
                 * assigned, or operations may have suspended the whole thing —
                 * and a reminder for work that is already done is exactly the
                 * kind of alert that teaches people to ignore alerts.
                 */
                if (!(await this.stillNeedsAttention(p.jobId))) {
                    await redis.del(key);
                    continue;
                }

                const copy = this.copyFor(p.pickupAddress, due);
                await StaffPushService.notifyParkDispatchers({
                    parkId: p.parkId, jobId: p.jobId, rideId: p.rideId,
                    title: copy.title, body: copy.body, reason: due,
                });
                sent++;

                if (due === PushReason.FINAL_REMINDER) p.sent.final = true;
                else p.sent.reminder = true;

                const ttl = Math.max(15, Math.ceil((new Date(p.expiresAt).getTime() - t) / 1000) + 15);
                await redis.setex(key, ttl, JSON.stringify(p));
            }
        } while (cursor !== '0');

        return sent;
    }

    /**
     * Is this job still unclaimed and still live?
     *
     * Imported lazily to keep this module free of a circular dependency with
     * the dispatch service, which imports this one.
     */
    private static async stillNeedsAttention(jobId: string): Promise<boolean> {
        try {
            const { ParkDispatchJobRepository } = await import('../repositories/park_dispatch_job_repository');
            const { ParkJobStatus } = await import('../models/ParkDispatchJob');
            const { ParkDispatchSwitch } = await import('./park_dispatch_switch');

            if (await ParkDispatchSwitch.isDisabled()) return false;

            const job = await ParkDispatchJobRepository.findById(jobId);
            if (!job) return false;

            // Only an OFFERED job is genuinely unattended. Claimed means a
            // human already has it, which is the outcome we were chasing.
            return job.status === ParkJobStatus.OFFERED;
        } catch {
            // If we cannot tell, do not chase. Silence is the safer error.
            return false;
        }
    }
}
