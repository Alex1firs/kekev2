/**
 * Scheduled sweep for rides stuck in accepted / arrived / in_progress.
 *
 * Safety properties, in order of importance:
 *
 *  1. Never cancels a live trip. `in_progress` is only ever FLAGGED, and every
 *     terminal write is conditional, so a driver's arrive/start/complete landing
 *     mid-sweep always wins.
 *  2. Safe with multiple backend instances. A Postgres advisory lock admits one
 *     sweeper at a time; `FOR UPDATE SKIP LOCKED` keeps concurrent batches from
 *     touching the same row.
 *  3. Idempotent. Re-running produces no additional effect: warnings are gated on
 *     a persisted `staleWarnedAt`, flags on `requiresOperationsReview`, and
 *     cancels on the ride still being in a cancellable state.
 *  4. Independent of client apps. This is the entire point — the incident
 *     happened precisely because nothing ran unless an app was open.
 *  5. Bounded. Fixed batch per state per sweep, so a large backlog drains over
 *     several passes instead of stalling the event loop.
 *
 * Runs as an in-process interval (the backend is a single long-lived container),
 * but the advisory lock means scaling to several instances needs no change, and
 * `runOnce()` is exported so the same sweep can be driven from cron or a CLI
 * instead — see scripts/sweep_stale_rides.ts.
 */
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { UserRole } from '../models/User';
import { loadStaleRideConfig, StaleRideConfig, StaleActionReason, StaleResolution } from '../config/stale_ride_config';
import { StaleRideService, RideSnapshot, StaleEvaluation } from './stale_ride_service';
import { RideCleanupService } from './ride_cleanup_service';
import { NotificationService } from './notification_service';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { DispatchEventType } from '../models/DispatchEvent';

/** Arbitrary but fixed key so every instance contends for the same lock. */
const ADVISORY_LOCK_KEY = 8_472_119;

/** States the sweep examines. `searching` is owned by the dispatch orchestrator. */
const SWEPT_STATUSES = ['accepted', 'arrived', 'in_progress', 'started'];

export interface SweepPlanItem extends StaleEvaluation {
    passengerId: string | null;
    driverId: string | null;
    acceptedAt: Date | null;
    arrivedAt: Date | null;
    startedAt: Date | null;
    /** Driver heartbeat age in ms at evaluation, null when no live heartbeat. */
    driverHeartbeatAgeMs: number | null;
    driverHeartbeatFresh: boolean;
}

export interface SweepReport {
    startedAt: string;
    finishedAt: string;
    dryRun: boolean;
    /** False when another instance held the lock; nothing was examined. */
    acquiredLock: boolean;
    examined: number;
    warned: number;
    cancelled: number;
    flagged: number;
    skipped: number;
    /** Decision prompts sent to both parties. */
    prompted: number;
    /** Races lost to a legitimate newer transition. */
    lostRaces: number;
    errors: number;
    /** Every evaluation, for dry-run reporting and audit. */
    plan: SweepPlanItem[];
}

export class StaleRideSweeper {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;

    /** Start the periodic sweep. Idempotent. */
    static start(config: StaleRideConfig = loadStaleRideConfig()): void {
        if (!config.enabled) {
            console.log('[STALE_SWEEP] disabled by STALE_SWEEP_ENABLED=false');
            return;
        }
        if (this.timer) return;

        console.log(JSON.stringify({
            level: 'info', scope: 'stale_sweep', event: 'started',
            intervalMs: config.sweepIntervalMs, dryRun: config.dryRun,
            batchSize: config.batchSize,
            acceptedMinMinutes: config.acceptedMinMinutes,
            acceptedEtaMultiplier: config.acceptedEtaMultiplier,
            acceptedMaxMinutes: config.acceptedMaxMinutes,
            arrivedCancelMinutes: config.arrivedCancelMinutes,
            inProgressMinMinutes: config.inProgressMinMinutes,
        }));

        this.timer = setInterval(() => {
            // Overlap guard: a slow sweep must not stack on itself.
            if (this.running) return;
            void this.runOnce(config).catch((err) => {
                console.error('[STALE_SWEEP] sweep threw:', err?.message);
            });
        }, config.sweepIntervalMs);
        // Never hold the process open for a sweep.
        this.timer.unref?.();
    }

    static stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * One sweep pass. Safe to call directly (CLI, tests, cron).
     *
     * `overrides` lets a caller force dry-run without touching the environment.
     */
    static async runOnce(
        config: StaleRideConfig = loadStaleRideConfig(),
        overrides: { dryRun?: boolean; now?: Date } = {},
    ): Promise<SweepReport> {
        const dryRun = overrides.dryRun ?? config.dryRun;
        const now = overrides.now ?? new Date();
        const startedAt = new Date();
        const report: SweepReport = {
            startedAt: startedAt.toISOString(),
            finishedAt: startedAt.toISOString(),
            dryRun,
            acquiredLock: false,
            examined: 0, warned: 0, cancelled: 0, flagged: 0,
            prompted: 0, skipped: 0, lostRaces: 0, errors: 0,
            plan: [],
        };

        this.running = true;
        try {
            if (!AppDataSource.isInitialized) {
                report.finishedAt = new Date().toISOString();
                return report;
            }

            // A dry run reads only, so it needs no exclusive lock and can be run
            // by an operator at any time without disturbing the live sweeper.
            const lockConn = dryRun ? null : AppDataSource.createQueryRunner();
            try {
                if (lockConn) {
                    await lockConn.connect();
                    const got = await lockConn.query(
                        'SELECT pg_try_advisory_lock($1) AS locked',
                        [ADVISORY_LOCK_KEY],
                    );
                    report.acquiredLock = got?.[0]?.locked === true;
                    if (!report.acquiredLock) {
                        // Another instance is sweeping. Not an error.
                        report.finishedAt = new Date().toISOString();
                        return report;
                    }
                } else {
                    report.acquiredLock = true;
                }

                const candidates = await this.loadCandidates(config, now);
                report.examined = candidates.length;

                for (const ride of candidates) {
                    try {
                        const evaluation = StaleRideService.evaluate(ride, config, now);
                        const item = await this.describe(ride, evaluation);
                        report.plan.push(item);

                        if (evaluation.action === 'none') {
                            report.skipped += 1;
                            continue;
                        }
                        if (dryRun) {
                            // Counted so the operator sees the shape of the change,
                            // but nothing is written.
                            if (evaluation.action === 'warn') report.warned += 1;
                            if (evaluation.action === 'prompt_decision') report.prompted += 1;
                            if (evaluation.action === 'cancel') report.cancelled += 1;
                            if (evaluation.action === 'flag_for_review') report.flagged += 1;
                            continue;
                        }

                        if (evaluation.action === 'warn') {
                            const sent = await this.sendWarning(ride, evaluation);
                            if (sent) report.warned += 1; else report.skipped += 1;
                        } else if (evaluation.action === 'prompt_decision') {
                            const sent = await this.promptDecision(ride, evaluation, config);
                            if (sent) report.prompted += 1; else report.skipped += 1;
                        } else if (evaluation.action === 'cancel') {
                            const outcome = await this.cancel(ride, evaluation);
                            if (outcome === 'cancelled') report.cancelled += 1;
                            else if (outcome === 'lost_race') report.lostRaces += 1;
                            else report.skipped += 1;
                        } else if (evaluation.action === 'flag_for_review') {
                            const flagged = await RideCleanupService.flagForOperationsReview({
                                rideId: ride.rideId,
                                reason: evaluation.reason ?? StaleActionReason.TRIP_EXCEEDED_EXPECTED_DURATION,
                                ageMinutes: evaluation.ageMinutes ?? 0,
                                thresholdMinutes: evaluation.deadlineMinutes ?? 0,
                            });
                            if (flagged.applied) report.flagged += 1; else report.skipped += 1;
                        }
                    } catch (err: any) {
                        // One bad ride must not abort the sweep.
                        report.errors += 1;
                        console.error(JSON.stringify({
                            level: 'error', scope: 'stale_sweep', event: 'ride_failed',
                            rideId: ride.rideId, error: err?.message,
                        }));
                    }
                }
            } finally {
                if (lockConn) {
                    try {
                        await lockConn.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
                    } catch { /* the lock is session-scoped; release is best-effort */ }
                    await lockConn.release();
                }
            }
        } finally {
            this.running = false;
            report.finishedAt = new Date().toISOString();
        }

        if (report.warned || report.prompted || report.cancelled || report.flagged || report.errors) {
            console.log(JSON.stringify({
                level: 'info', scope: 'stale_sweep', event: 'completed',
                dryRun: report.dryRun, examined: report.examined,
                warned: report.warned, prompted: report.prompted,
                cancelled: report.cancelled,
                flagged: report.flagged, lostRaces: report.lostRaces,
                skipped: report.skipped, errors: report.errors,
            }));
        }
        return report;
    }

    /**
     * Load a bounded batch of candidates.
     *
     * The WHERE clause is deliberately generous — it selects on status and a
     * coarse minimum age and lets the policy decide. Encoding deadlines in SQL
     * would split the rules across two places, which is how a policy and its
     * implementation drift apart.
     */
    private static async loadCandidates(config: StaleRideConfig, now: Date): Promise<RideSnapshot[]> {
        // Cheapest possible floor: nothing can be actionable before the smallest
        // configured warning time.
        const earliestActionableMinutes = Math.max(
            1,
            Math.min(
                config.acceptedMinMinutes * config.warnAtDeadlineFraction,
                config.arrivedWarnMinutes,
            ),
        );
        const cutoff = new Date(now.getTime() - earliestActionableMinutes * 60_000);

        const rows: Ride[] = await AppDataSource.getRepository(Ride)
            .createQueryBuilder('r')
            .where('r.status IN (:...statuses)', { statuses: SWEPT_STATUSES })
            .andWhere('r."completedAt" IS NULL')
            .andWhere('(r."acceptedAt" <= :cutoff OR r."startedAt" <= :cutoff OR r."acceptedAt" IS NULL)', { cutoff })
            .orderBy('r."acceptedAt"', 'ASC', 'NULLS LAST')
            .limit(config.batchSize)
            // Row-level locks skipped rather than waited on: a row another worker
            // (or a live transaction) holds is simply left for the next pass.
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .getMany();

        return rows.map((r) => this.toSnapshot(r));
    }

    private static toSnapshot(r: Ride): RideSnapshot {
        const num = (v: unknown): number | null => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        return {
            rideId: r.rideId,
            status: r.status as unknown as string,
            passengerId: r.passengerId ?? null,
            driverId: r.driverId ?? null,
            acceptedAt: r.acceptedAt ?? null,
            arrivedAt: r.arrivedAt ?? null,
            startedAt: r.startedAt ?? null,
            completedAt: r.completedAt ?? null,
            estimatedDurationSec: r.estimatedDurationSec ?? null,
            acceptLat: num(r.acceptLat),
            acceptLng: num(r.acceptLng),
            pickupLat: num(r.pickupLat),
            pickupLng: num(r.pickupLng),
            staleWarnedAt: r.staleWarnedAt ?? null,
            staleExtensionCount: r.staleExtensionCount ?? 0,
            staleDeadlineOverrideAt: r.staleDeadlineOverrideAt ?? null,
            requiresOperationsReview: r.requiresOperationsReview ?? false,
            staleDecisionPromptedAt: r.staleDecisionPromptedAt ?? null,
            staleDecisionDeadlineAt: r.staleDecisionDeadlineAt ?? null,
            staleDecisionBy: r.staleDecisionBy ?? null,
            staleDecisionChoice: r.staleDecisionChoice ?? null,
            staleDecisionRound: r.staleDecisionRound ?? 0,
        };
    }

    /** Enrich an evaluation with the driver-liveness context an operator needs. */
    private static async describe(
        ride: RideSnapshot, evaluation: StaleEvaluation,
    ): Promise<SweepPlanItem> {
        let driverHeartbeatAgeMs: number | null = null;
        let driverHeartbeatFresh = false;
        if (ride.driverId) {
            const freshness = await DispatchMonitorService.freshness(ride.driverId);
            driverHeartbeatAgeMs = freshness.heartbeatAgeMs;
            driverHeartbeatFresh = freshness.fresh;
        }
        return {
            ...evaluation,
            passengerId: ride.passengerId,
            driverId: ride.driverId,
            acceptedAt: ride.acceptedAt,
            arrivedAt: ride.arrivedAt,
            startedAt: ride.startedAt,
            driverHeartbeatAgeMs,
            driverHeartbeatFresh,
        };
    }

    /**
     * Staged warning. Marked in the database with a conditional update, so a
     * restart or a duplicate worker cannot double-send.
     */
    private static async sendWarning(ride: RideSnapshot, evaluation: StaleEvaluation): Promise<boolean> {
        const rideRepo = AppDataSource.getRepository(Ride);
        const claim = await rideRepo
            .createQueryBuilder()
            .update()
            .set({ staleWarnedAt: new Date(), staleReason: evaluation.reason ?? null })
            .where('"rideId" = :rideId AND "staleWarnedAt" IS NULL AND "completedAt" IS NULL AND status = :status',
                { rideId: ride.rideId, status: ride.status })
            .execute();

        // Somebody else already warned, or the ride moved on.
        if (!claim.affected || claim.affected === 0) return false;

        const minutesLeft = evaluation.deadlineAt
            ? Math.max(0, Math.round((evaluation.deadlineAt.getTime() - Date.now()) / 60_000))
            : 0;

        try {
            if (ride.status === 'accepted' && ride.driverId) {
                await NotificationService.sendToUser(
                    ride.driverId, UserRole.DRIVER,
                    'Still heading to your passenger?',
                    `Your passenger is still waiting. This ride will be cancelled in about ${minutesLeft} minutes ` +
                    `if you are no longer on your way — open the app to confirm you are still coming.`,
                    { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active' },
                );
            } else if (ride.status === 'arrived') {
                if (ride.driverId) {
                    await NotificationService.sendToUser(
                        ride.driverId, UserRole.DRIVER,
                        'Start the trip?',
                        `You marked arrived ${Math.round(evaluation.ageMinutes ?? 0)} minutes ago. Start the trip, ` +
                        `or cancel if you could not pick the passenger up.`,
                        { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active' },
                    );
                }
                if (ride.passengerId) {
                    await NotificationService.sendToUser(
                        ride.passengerId, UserRole.PASSENGER,
                        'Has your trip started?',
                        'Your driver marked arrived a while ago. If you have not been picked up, you can cancel.',
                        { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active' },
                    );
                }
            }
        } catch (err: any) {
            console.warn(`[STALE_SWEEP] warning notify failed for ${ride.rideId}: ${err?.message}`);
        }

        // Both events, so the admin timeline shows detection and the warning.
        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_RIDE_DETECTED,
            driverId: ride.driverId,
            detail: {
                status: ride.status,
                ageMinutes: Math.round(evaluation.ageMinutes ?? 0),
                deadlineMinutes: Math.round(evaluation.deadlineMinutes ?? 0),
                explanation: evaluation.explanation,
            },
        });
        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_WARNING_SENT,
            driverId: ride.driverId,
            detail: { reason: evaluation.reason, minutesUntilDeadline: minutesLeft },
        });
        return true;
    }

    /**
     * Ask BOTH parties whether to keep waiting or cancel.
     *
     * This is the step that replaced cancelling on a timer. It pushes a realtime
     * prompt and a push notification to each side, records the window, and
     * returns — nothing is terminated here. The prompt is claimed with a
     * conditional UPDATE, so two workers cannot both ask.
     *
     * Copy differs per role because the two sides are in genuinely different
     * situations: the passenger is waiting for a driver who has not shown up, and
     * the driver is waiting for a passenger who has not appeared. Neither is told
     * the other is at fault.
     */
    private static async promptDecision(
        ride: RideSnapshot,
        evaluation: StaleEvaluation,
        config: StaleRideConfig,
    ): Promise<boolean> {
        const deadlineAt = evaluation.decisionDeadlineAt
            ?? new Date(Date.now() + config.decisionWindowMinutes * 60_000);
        const rideRepo = AppDataSource.getRepository(Ride);

        // Claim the prompt. `staleDecisionPromptedAt IS NULL` makes this the
        // once-only gate, and bumping the round lets the policy count how many
        // times this ride has been through the conversation.
        const claim = await rideRepo
            .createQueryBuilder()
            .update()
            .set({
                staleDecisionPromptedAt: new Date(),
                staleDecisionDeadlineAt: deadlineAt,
                staleDecisionBy: null,
                staleDecisionChoice: null,
                staleReason: evaluation.reason ?? null,
                staleDetectedAt: new Date(),
                staleDecisionRound: () => '"staleDecisionRound" + 1',
            })
            .where('"rideId" = :rideId AND "staleDecisionPromptedAt" IS NULL AND status = :status AND "completedAt" IS NULL',
                { rideId: ride.rideId, status: ride.status })
            .execute();

        if (!claim.affected || claim.affected === 0) return false;

        const respondBySec = Math.max(30, Math.round((deadlineAt.getTime() - Date.now()) / 1000));
        const waitingFor: 'driver' | 'passenger' = ride.status === 'accepted' ? 'driver' : 'passenger';

        // Realtime prompt — the in-app dialog with the two actions.
        const promptBase = {
            rideId: ride.rideId,
            reason: evaluation.reason,
            respondBySeconds: respondBySec,
            respondByAt: deadlineAt.toISOString(),
            waitingFor,
            options: ['wait', 'cancel'],
        };
        try {
            RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:stale_decision_required', {
                ...promptBase,
                role: 'passenger',
                title: waitingFor === 'driver' ? 'Your driver is running late' : 'Are you at the pickup point?',
                body: waitingFor === 'driver'
                    ? 'Your driver has not arrived yet. Would you like to keep waiting, or cancel and book another Keke?'
                    : 'Your driver is waiting at the pickup point. Are you still coming, or would you like to cancel?',
            });
            if (ride.driverId) {
                RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:stale_decision_required', {
                    ...promptBase,
                    role: 'driver',
                    title: waitingFor === 'driver' ? 'Are you still going to this pickup?' : 'Passenger has not arrived',
                    body: waitingFor === 'driver'
                        ? 'Your passenger is still waiting. Are you still on your way, or would you like to cancel?'
                        : 'The passenger has not shown up yet. Do you want to keep waiting, or cancel this ride?',
                });
            }
        } catch (err: any) {
            console.warn(`[STALE_SWEEP] decision prompt emit failed for ${ride.rideId}: ${err?.message}`);
        }

        // Push as well, because the decisive case is a party whose app is closed —
        // and someone who never sees the prompt must not be treated as having
        // chosen anything.
        try {
            if (ride.passengerId) {
                await NotificationService.sendToUser(
                    ride.passengerId, UserRole.PASSENGER,
                    waitingFor === 'driver' ? 'Your driver is running late' : 'Your driver is waiting',
                    waitingFor === 'driver'
                        ? 'Tap to keep waiting or cancel and book another Keke.'
                        : 'Tap to confirm you are coming, or cancel the ride.',
                    { type: 'STALE_RIDE_DECISION', rideId: ride.rideId, intent: 'active' },
                );
            }
            if (ride.driverId) {
                await NotificationService.sendToUser(
                    ride.driverId, UserRole.DRIVER,
                    waitingFor === 'driver' ? 'Still going to this pickup?' : 'Passenger has not arrived',
                    'Tap to keep going or cancel this ride.',
                    { type: 'STALE_RIDE_DECISION', rideId: ride.rideId, intent: 'active' },
                );
            }
        } catch (err: any) {
            console.warn(`[STALE_SWEEP] decision push failed for ${ride.rideId}: ${err?.message}`);
        }

        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_DECISION_REQUESTED,
            driverId: ride.driverId,
            detail: {
                reason: evaluation.reason,
                waitingFor,
                round: ride.staleDecisionRound + 1,
                respondBySeconds: respondBySec,
                askedParties: ['passenger', 'driver'],
            },
        });
        console.log(JSON.stringify({
            level: 'info', scope: 'stale_sweep', event: 'decision_requested',
            rideId: ride.rideId, waitingFor, respondBySeconds: respondBySec,
            round: ride.staleDecisionRound + 1,
        }));
        return true;
    }

    /** Terminal cancel, through the shared cleanup service. */
    private static async cancel(
        ride: RideSnapshot, evaluation: StaleEvaluation,
    ): Promise<'cancelled' | 'lost_race' | 'skipped'> {
        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_RIDE_DETECTED,
            driverId: ride.driverId,
            detail: {
                status: ride.status,
                ageMinutes: Math.round(evaluation.ageMinutes ?? 0),
                deadlineMinutes: Math.round(evaluation.deadlineMinutes ?? 0),
                explanation: evaluation.explanation,
                action: 'cancel',
            },
        });

        // Copy names the actual resolution, so neither party is left guessing why
        // their ride ended — and nobody is blamed for something they did not do.
        const res = evaluation.resolution;
        let passengerMessage: string;
        let driverMessage: string;
        switch (res) {
            case StaleResolution.PASSENGER_CHOSE_CANCEL:
                passengerMessage = 'Your ride has been cancelled as you requested. You can book again now.';
                driverMessage = 'The passenger cancelled this ride. You can accept new rides now.';
                break;
            case StaleResolution.DRIVER_CHOSE_CANCEL:
                passengerMessage = 'Your driver could not complete this pickup, so the ride was cancelled. You can book again now.';
                driverMessage = 'This ride has been cancelled as you requested. You can accept new rides now.';
                break;
            case StaleResolution.DRIVER_UNRESPONSIVE:
                passengerMessage = 'We could not reach your driver, so we cancelled the ride. You can book again now.';
                driverMessage = 'This ride was cancelled because we did not hear back from you. You can accept new rides now.';
                break;
            case StaleResolution.PASSENGER_UNRESPONSIVE:
                passengerMessage = 'This ride was cancelled because we did not hear back from you. You can book again whenever you are ready.';
                driverMessage = 'The passenger did not respond, so this ride was cancelled. You can accept new rides now.';
                break;
            default:
                passengerMessage = 'We did not hear back about this ride, so we cancelled it. You can book again now.';
                driverMessage = 'We did not hear back about this ride, so we cancelled it. You can accept new rides now.';
                break;
        }

        // The window closed unanswered — record that plainly before terminating.
        if (res === StaleResolution.NO_RESPONSE_FROM_EITHER
            || res === StaleResolution.DRIVER_UNRESPONSIVE
            || res === StaleResolution.PASSENGER_UNRESPONSIVE) {
            DispatchMonitorService.record({
                rideId: ride.rideId,
                eventType: DispatchEventType.STALE_DECISION_TIMED_OUT,
                driverId: ride.driverId,
                detail: {
                    resolution: res,
                    rounds: ride.staleDecisionRound,
                    answeredBy: ride.staleDecisionBy,
                    answeredChoice: ride.staleDecisionChoice,
                },
            });
        }

        const outcome = await RideCleanupService.terminate({
            rideId: ride.rideId,
            // The DECISION is the cancellation reason...
            reason: res ?? StaleResolution.NO_RESPONSE_FROM_EITHER,
            // ...and the SITUATION is recorded alongside it.
            situation: evaluation.reason ?? StaleActionReason.DRIVER_DID_NOT_ARRIVE,
            expectedStatuses: [ride.status],
            passengerMessage,
            driverMessage,
            // Refuses outright if no prompt was ever sent.
            requireDecisionPrompt: true,
        });

        if (!outcome.applied) {
            const lost = (outcome.skippedReason ?? '').startsWith('lost_race')
                || (outcome.skippedReason ?? '').startsWith('status_changed');
            console.log(JSON.stringify({
                level: 'info', scope: 'stale_sweep',
                event: lost ? 'cancel_lost_race' : 'cancel_skipped',
                rideId: ride.rideId, reason: outcome.skippedReason,
            }));
            return lost ? 'lost_race' : 'skipped';
        }

        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_AUTO_CANCELLED,
            driverId: ride.driverId,
            detail: {
                // Both facts, kept distinct.
                situation: evaluation.reason,
                resolution: res,
                decidedBy: ride.staleDecisionBy,
                decidedChoice: ride.staleDecisionChoice,
                decisionRounds: ride.staleDecisionRound,
                previousStatus: ride.status,
                ageMinutes: Math.round(evaluation.ageMinutes ?? 0),
                bothPartiesAsked: true,
            },
        });
        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_CLEANUP_COMPLETED,
            driverId: ride.driverId,
            detail: {
                passengerSlotReleased: outcome.passengerSlotReleased,
                driverReservationReleased: outcome.driverReservationReleased,
                driverAvailabilityRestored: outcome.driverAvailabilityRestored,
                driverAvailabilityWithheldReason: outcome.driverAvailabilityWithheldReason ?? null,
            },
        });
        return 'cancelled';
    }
}
