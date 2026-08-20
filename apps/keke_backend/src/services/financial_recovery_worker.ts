/**
 * Retries financial postings that failed, on the server's own initiative.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * 99 completed cash rides carried unposted commission for a month because
 * `paymentFailed = true` was a flag nobody was watching. An admin queue helps,
 * but it still depends on a person noticing. A transient database blip should
 * cost nothing at all.
 *
 * ── What makes it safe ───────────────────────────────────────────────────
 * Idempotency is checked against the LEDGER inside retryFailedPosting, not
 * against the flag, so a ride whose money is already posted can never be
 * charged twice however many times this runs.
 *
 * Quarantined rides are excluded. The historical 99 are marked
 * `financialQuarantine = true` precisely so that switching this on does not
 * silently post ~₦80k across 46 drivers who have spent a month believing they
 * owed nothing. That decision belongs to a person.
 *
 * ── Bounded ──────────────────────────────────────────────────────────────
 * Exponential backoff, capped attempts. After the cap the ride stops being
 * retried and appears in Financial Exceptions for a human — an escalation, not
 * an infinite loop.
 */
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { WalletService } from './wallet_service';

/** 1m, 5m, 25m, ~2h, ~10h — then stop and escalate. */
const MAX_ATTEMPTS = Number(process.env.FINANCIAL_RETRY_MAX_ATTEMPTS) || 5;
const BASE_DELAY_MS = Number(process.env.FINANCIAL_RETRY_BASE_MS) || 60_000;
const INTERVAL_MS = Number(process.env.FINANCIAL_RETRY_INTERVAL_MS) || 60_000;
const BATCH = 20;

const backoffMs = (attempt: number) => BASE_DELAY_MS * Math.pow(5, Math.max(0, attempt));

export class FinancialRecoveryWorker {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;

    static start(): void {
        if (this.timer) return;
        if (process.env.FINANCIAL_RECOVERY_ENABLED === 'false') {
            console.log('[FIN_RECOVERY] disabled by env — not started.');
            return;
        }
        this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
        this.timer.unref?.();
        console.log(`[FIN_RECOVERY] started (every ${INTERVAL_MS}ms, max ${MAX_ATTEMPTS} attempts)`);
    }

    static stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    static async tick(): Promise<{ attempted: number; recovered: number; exhausted: number }> {
        if (this.running) return { attempted: 0, recovered: 0, exhausted: 0 };
        this.running = true;
        const out = { attempted: 0, recovered: 0, exhausted: 0 };

        try {
            const repo = AppDataSource.getRepository(Ride);
            const due = await repo
                .createQueryBuilder('r')
                .where(`r.status = 'completed'`)
                .andWhere(`COALESCE(r."paymentFailed", false) = true`)
                // The historical dataset is deliberately untouchable here.
                .andWhere(`COALESCE(r."financialQuarantine", false) = false`)
                .andWhere(`COALESCE(r."financialRetryCount", 0) < :max`, { max: MAX_ATTEMPTS })
                .andWhere(`r."financialNextRetryAt" IS NOT NULL AND r."financialNextRetryAt" <= now()`)
                .orderBy('r."financialNextRetryAt"', 'ASC')
                .limit(BATCH)
                .getMany();

            for (const ride of due) {
                out.attempted += 1;
                const attempt = (ride.financialRetryCount ?? 0) + 1;
                try {
                    const result = await WalletService.retryFailedPosting(ride.rideId, {
                        staffUserId: 'SYSTEM',
                        label: 'automatic recovery',
                    });

                    if (result.ok || (result as any).code === 'ALREADY_POSTED') {
                        // ALREADY_POSTED counts as recovered: the money is
                        // there, which is the outcome we wanted.
                        await repo.update(ride.rideId, {
                            financialRetryCount: attempt,
                            financialNextRetryAt: null,
                            financialLastError: null,
                        } as any);
                        out.recovered += 1;
                        console.log(JSON.stringify({
                            level: 'info', scope: 'fin_recovery', event: 'recovered',
                            rideId: ride.rideId, attempt,
                        }));
                        continue;
                    }

                    // A refusal that will never succeed — no driver, no fare,
                    // not completed. Stop immediately rather than burning
                    // attempts on something structurally impossible.
                    await repo.update(ride.rideId, {
                        financialRetryCount: MAX_ATTEMPTS,
                        financialNextRetryAt: null,
                        financialLastError: `${(result as any).code}: ${(result as any).message}`.slice(0, 300),
                    } as any);
                    out.exhausted += 1;
                } catch (err: any) {
                    const exhausted = attempt >= MAX_ATTEMPTS;
                    await repo.update(ride.rideId, {
                        financialRetryCount: attempt,
                        financialNextRetryAt: exhausted ? null : new Date(Date.now() + backoffMs(attempt)),
                        financialLastError: String(err?.message ?? 'unknown').slice(0, 300),
                    } as any);
                    if (exhausted) {
                        out.exhausted += 1;
                        // Now it becomes a human's problem, with its history intact.
                        console.error(JSON.stringify({
                            level: 'error', scope: 'fin_recovery', event: 'escalated_to_exceptions',
                            rideId: ride.rideId, attempts: attempt, error: err?.message,
                        }));
                    }
                }
            }

            if (out.attempted > 0) {
                console.log(JSON.stringify({ level: 'info', scope: 'fin_recovery', event: 'tick', ...out }));
            }
            return out;
        } catch (err: any) {
            // A failed sweep must never stop the next one.
            console.error('[FIN_RECOVERY] tick failed:', err?.message);
            return out;
        } finally {
            this.running = false;
        }
    }
}
