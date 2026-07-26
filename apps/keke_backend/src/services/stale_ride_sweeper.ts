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
import { RideActivityService } from './ride_activity_service';
import { RideActivityType } from '../config/stale_ride_config';
import { coordinationEventId } from './ride_coordination_contract';

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
    /** Slow-cadence check-ins. */
    reminded: number;
    /** Rides handed to a human instead of being cancelled. */
    escalated: number;
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
            prompted: 0, reminded: 0, escalated: 0, skipped: 0, lostRaces: 0, errors: 0,
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

                for (const rawRide of candidates) {
                    try {
                        // Gather live evidence first. The policy is pure, so it can
                        // only be as good as what we hand it: whether each party is
                        // showing any sign of life, and whether the driver is
                        // genuinely closing the distance to the pickup.
                        const ride = await this.withLiveEvidence(rawRide, config);
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
                            if (evaluation.action === 'remind') report.reminded += 1;
                            if (evaluation.action === 'escalate') report.escalated += 1;
                            if (evaluation.action === 'cancel') report.cancelled += 1;
                            if (evaluation.action === 'flag_for_review') report.flagged += 1;
                            continue;
                        }

                        // Keep the operations dashboard honest about what is
                        // happening, whatever action follows.
                        await this.persistDelayState(ride, evaluation);

                        if (evaluation.action === 'warn') {
                            const sent = await this.sendWarning(ride, evaluation);
                            if (sent) report.warned += 1; else report.skipped += 1;
                        } else if (evaluation.action === 'remind') {
                            const sent = await this.sendReminder(ride, evaluation, config);
                            if (sent) report.reminded += 1; else report.skipped += 1;
                        } else if (evaluation.action === 'escalate') {
                            const done = await this.escalate(ride, evaluation, config);
                            if (done) report.escalated += 1; else report.skipped += 1;
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
                            rideId: rawRide.rideId, error: err?.message,
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

        if (report.warned || report.prompted || report.reminded || report.escalated
            || report.cancelled || report.flagged || report.errors) {
            console.log(JSON.stringify({
                level: 'info', scope: 'stale_sweep', event: 'completed',
                dryRun: report.dryRun, examined: report.examined,
                warned: report.warned, prompted: report.prompted,
                reminded: report.reminded, escalated: report.escalated,
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

        // SELECT ... FOR UPDATE SKIP LOCKED is only legal inside a transaction,
        // and TypeORM refuses the lock outright without one. The transaction wraps
        // the read alone: these row locks are released at commit, and nothing
        // depends on holding them. Two sweepers are kept apart by the advisory
        // lock above, and every write is a conditional UPDATE that re-checks the
        // state it relies on, so a row changing after this read is already handled.
        const rows: Ride[] = await AppDataSource.transaction((manager) =>
            manager.getRepository(Ride)
                .createQueryBuilder('r')
                .where('r.status IN (:...statuses)', { statuses: SWEPT_STATUSES })
                .andWhere('r."completedAt" IS NULL')
                .andWhere('(r."acceptedAt" <= :cutoff OR r."startedAt" <= :cutoff OR r."acceptedAt" IS NULL)', { cutoff })
                .orderBy('r."acceptedAt"', 'ASC', 'NULLS LAST')
                .limit(config.batchSize)
                // Row-level locks skipped rather than waited on: a row another
                // worker (or a live transaction) holds is left for the next pass.
                .setLock('pessimistic_write')
                .setOnLocked('skip_locked')
                .getMany(),
        );

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
            lastActivityAt: r.lastActivityAt ?? null,
            lastActivityType: r.lastActivityType ?? null,
            lastReminderAt: r.lastReminderAt ?? null,
            // Filled in by the sweeper from live Redis before evaluation.
            driverLive: true,
            passengerLive: true,
            driverOfflineForMs: null,
            passengerOfflineForMs: null,
            cancellationRequestedBy: r.cancellationRequestedBy ?? null,
            cancellationRequestedAt: r.cancellationRequestedAt ?? null,
            cancellationRequestState: r.cancellationRequestState ?? null,
            escalatedToSupportAt: r.escalatedToSupportAt ?? null,
        };
    }

    /**
     * Gather live evidence about a ride before the policy judges it.
     *
     * Two questions: is each party showing any sign of life, and is the driver
     * genuinely closing the distance to the pickup? Approach counts as activity —
     * a driver stuck in traffic who is still making progress has not abandoned
     * anything, whatever the clock says.
     */
    private static async withLiveEvidence(
        ride: RideSnapshot, config: StaleRideConfig,
    ): Promise<RideSnapshot> {
        let lastActivityAt = ride.lastActivityAt;
        let lastActivityType = ride.lastActivityType;

        // Approach only matters while the driver is still travelling to pickup.
        if (ride.status === 'accepted' && ride.driverId
            && ride.pickupLat != null && ride.pickupLng != null) {
            const approach = await RideActivityService.checkDriverApproach(
                ride.rideId, ride.driverId,
                { lat: ride.pickupLat, lng: ride.pickupLng },
                config,
            );
            if (approach.approaching) {
                lastActivityAt = new Date();
                lastActivityType = RideActivityType.DRIVER_APPROACHING;
            }
        }

        const [driver, passenger] = await Promise.all([
            ride.driverId
                ? RideActivityService.driverLiveness(ride.driverId, lastActivityAt, config)
                : Promise.resolve({ live: false, offlineForMs: null, via: null } as const),
            ride.passengerId
                ? RideActivityService.passengerLiveness(ride.passengerId, lastActivityAt, config)
                : Promise.resolve({ live: false, offlineForMs: null, via: null } as const),
        ]);

        return {
            ...ride,
            lastActivityAt,
            lastActivityType,
            driverLive: driver.live,
            passengerLive: passenger.live,
            driverOfflineForMs: driver.offlineForMs,
            passengerOfflineForMs: passenger.offlineForMs,
        };
    }

    /**
     * Keep the operations dashboard truthful about what is happening, on every
     * pass, whatever action follows. Support staff seeing "Delayed — driver
     * confirmed en route" is the difference between a calm answer and a guess.
     */
    private static async persistDelayState(
        ride: RideSnapshot, evaluation: StaleEvaluation,
    ): Promise<void> {
        if (evaluation.delayState === ride.status) return;
        try {
            await AppDataSource.getRepository(Ride)
                .createQueryBuilder()
                .update()
                .set({ delayState: evaluation.delayState })
                .where('"rideId" = :rideId AND "completedAt" IS NULL AND ("delayState" IS NULL OR "delayState" != :state)',
                    { rideId: ride.rideId, state: evaluation.delayState })
                .execute();
        } catch (err: any) {
            console.warn(`[STALE_SWEEP] delayState persist failed for ${ride.rideId}: ${err?.message}`);
        }
    }

    /**
     * A slow-cadence check-in for two people who are already coordinating.
     *
     * Deliberately infrequent (see reminderIntervalMinutes). Someone who has said
     * "still coming" does not need telling every minute; a notification that
     * arrives constantly is one both parties learn to swipe away, which is exactly
     * how the message that matters gets missed.
     */
    private static async sendReminder(
        ride: RideSnapshot, evaluation: StaleEvaluation, config: StaleRideConfig,
    ): Promise<boolean> {
        const interval = StaleRideService.reminderIntervalMinutes(ride, config);
        const rideRepo = AppDataSource.getRepository(Ride);
        // Claim the reminder so two workers cannot both send it.
        const claim = await rideRepo
            .createQueryBuilder()
            .update()
            .set({ lastReminderAt: new Date() })
            .where(`"rideId" = :rideId AND "completedAt" IS NULL
                    AND ("lastReminderAt" IS NULL OR "lastReminderAt" <= :cutoff)`,
                { rideId: ride.rideId, cutoff: new Date(Date.now() - interval * 60_000) })
            .execute();
        if (!claim.affected) return false;

        const waitingForDriver = ride.status === 'accepted';
        // Keyed on the reminder count so each check-in is its own event, but a
        // duplicated delivery of the same one collapses in the app.
        const remindEventId = coordinationEventId(
            ride.rideId, 'reminder', ride.lastReminderAt ? new Date(ride.lastReminderAt).getTime() : 0,
        );
        try {
            // Both sides hear the same facts, phrased for their situation. Neither
            // is told the other is at fault.
            RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:delay_update', {
                rideId: ride.rideId,
                eventId: remindEventId,
                rideStatus: ride.status,
                delayState: evaluation.delayState,
                role: 'passenger',
                title: waitingForDriver ? 'Your driver is still on the way' : 'Your driver is waiting for you',
                body: waitingForDriver
                    ? 'They have confirmed they are coming. You can call or message them, or cancel if you need to.'
                    : 'Your driver is at the pickup point. Let them know if you need a moment.',
                actions: waitingForDriver
                    ? ['continue_waiting', 'call_driver', 'message_driver', 'find_another_driver', 'request_cancel']
                    : ['on_my_way', 'call_driver', 'message_driver', 'request_cancel'],
            });
            if (ride.driverId) {
                RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:delay_update', {
                    rideId: ride.rideId,
                    eventId: remindEventId,
                    rideStatus: ride.status,
                    delayState: evaluation.delayState,
                    role: 'driver',
                    title: waitingForDriver ? 'Your passenger is still waiting' : 'Still waiting for the passenger',
                    body: waitingForDriver
                        ? 'They know you are delayed and are waiting for you.'
                        : 'The passenger has not appeared yet. You can call or message them.',
                    actions: waitingForDriver
                        ? ['still_coming', 'share_location', 'call_passenger', 'message_passenger', 'request_cancel']
                        : ['call_passenger', 'message_passenger', 'request_cancel'],
                });
            }
        } catch { /* realtime is best-effort */ }

        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_REMINDER_SENT,
            driverId: ride.driverId,
            detail: {
                delayState: evaluation.delayState,
                intervalMinutes: Math.round(interval),
                ageMinutes: Math.round(evaluation.ageMinutes ?? 0),
            },
        });
        return true;
    }

    /**
     * Hand the ride to a human, and give the engaged party somewhere to go.
     *
     * This replaces cancelling on one-sided silence. "We cannot reach your driver
     * — find another?" respects a passenger who has done everything right; a ride
     * silently disappearing does not. Nothing is terminated here, and once
     * escalated the system stops acting on this ride at all.
     */
    private static async escalate(
        ride: RideSnapshot, evaluation: StaleEvaluation, config: StaleRideConfig,
    ): Promise<boolean> {
        const target = evaluation.escalationTarget;
        const reason = target === 'driver' ? 'driver_unreachable' : 'passenger_unreachable';

        const claim = await AppDataSource.getRepository(Ride)
            .createQueryBuilder()
            .update()
            .set({
                escalatedToSupportAt: new Date(),
                escalationReason: reason,
                delayState: evaluation.delayState,
                requiresOperationsReview: true,
            })
            .where('"rideId" = :rideId AND "escalatedToSupportAt" IS NULL AND "completedAt" IS NULL',
                { rideId: ride.rideId })
            .execute();
        if (!claim.affected) return false;

        const escalationEventId = coordinationEventId(ride.rideId, 'escalation', reason);
        try {
            if (target === 'driver') {
                // The passenger is the engaged party: offer them a way forward.
                RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:delay_escalated', {
                    rideId: ride.rideId,
                    eventId: escalationEventId,
                    rideStatus: ride.status,
                    unreachableParty: target,
                    delayState: evaluation.delayState,
                    title: 'We are unable to reach your driver',
                    body: 'We have not been able to contact them. You can look for another Keke, or keep waiting.',
                    actions: ['find_another_driver', 'continue_waiting', 'request_cancel'],
                    supportNotified: true,
                });
                if (ride.passengerId) {
                    await NotificationService.sendToUser(
                        ride.passengerId, UserRole.PASSENGER,
                        'Unable to reach your driver',
                        'Tap to find another Keke, or keep waiting. Support has been notified.',
                        { type: 'RIDE_ESCALATED', rideId: ride.rideId, intent: 'active', eventId: escalationEventId },
                    );
                }
                DispatchMonitorService.record({
                    rideId: ride.rideId,
                    eventType: DispatchEventType.REMATCH_OFFERED,
                    driverId: ride.driverId,
                    detail: { offeredTo: 'passenger', becauseOf: reason },
                });
            } else {
                // The driver is engaged and waiting: tell them where they stand.
                if (ride.driverId) {
                    RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:delay_escalated', {
                        rideId: ride.rideId,
                        eventId: escalationEventId,
                        rideStatus: ride.status,
                        unreachableParty: target,
                        delayState: evaluation.delayState,
                        title: 'Unable to reach the passenger',
                        body: 'We have not been able to contact them. Support has been notified. You can request to cancel.',
                        actions: ['request_cancel', 'call_passenger', 'continue_waiting'],
                        supportNotified: true,
                    });
                    await NotificationService.sendToUser(
                        ride.driverId, UserRole.DRIVER,
                        'Unable to reach the passenger',
                        'Support has been notified. You can request to cancel this ride.',
                        { type: 'RIDE_ESCALATED', rideId: ride.rideId, intent: 'active', eventId: escalationEventId },
                    );
                }
            }

            // High-priority operations signal — a human owns this now.
            RideCleanupService.hostRef?.emitToAdmin('admin:ride_requires_review', {
                rideId: ride.rideId,
                reason,
                delayState: evaluation.delayState,
                passengerId: ride.passengerId,
                driverId: ride.driverId,
                unreachableParty: target,
                unreachableForMinutes: Math.round(
                    ((target === 'driver' ? ride.driverOfflineForMs : ride.passengerOfflineForMs) ?? 0) / 60_000,
                ),
                severity: 'high',
                autoCancelled: false,
            });
        } catch (err: any) {
            console.warn(`[STALE_SWEEP] escalation notify failed for ${ride.rideId}: ${err?.message}`);
        }

        DispatchMonitorService.record({
            rideId: ride.rideId,
            eventType: DispatchEventType.STALE_ESCALATED_TO_SUPPORT,
            driverId: ride.driverId,
            detail: {
                reason,
                unreachableParty: target,
                engagedParty: target === 'driver' ? 'passenger' : 'driver',
                escalateAfterOfflineMinutes: config.escalateAfterOfflineMinutes,
                autoCancelled: false,
                explanation: evaluation.explanation,
            },
        });
        console.warn(JSON.stringify({
            level: 'warn', scope: 'stale_sweep', event: 'escalated_to_support',
            rideId: ride.rideId, reason, unreachableParty: target,
        }));
        return true;
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

        // Realtime first. This stage used to be push-only, which meant a party
        // sitting in the app with a healthy socket saw nothing at all — the soft
        // reminder, the gentlest step in the whole ladder, was invisible to
        // exactly the person most likely to act on it.
        const warnEventId = coordinationEventId(ride.rideId, 'warning', ride.status);
        try {
            if (ride.status === 'accepted') {
                RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:delay_notice', {
                    rideId: ride.rideId,
                    eventId: warnEventId,
                    rideStatus: ride.status,
                    role: 'passenger',
                    delayState: evaluation.delayState,
                    title: 'Your driver is taking longer than expected',
                    body: 'We are checking whether the driver is still on the way.',
                    actions: ['keep_waiting', 'call_other_party', 'request_cancel'],
                });
                if (ride.driverId) {
                    RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:delay_notice', {
                        rideId: ride.rideId,
                        eventId: warnEventId,
                        rideStatus: ride.status,
                        role: 'driver',
                        delayState: evaluation.delayState,
                        title: 'Are you still heading to the passenger?',
                        body: 'The passenger is waiting. Let us know if you are still on your way.',
                        actions: ['still_coming', 'call_other_party', 'open_navigation', 'request_cancel'],
                    });
                }
            } else if (ride.status === 'arrived') {
                RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:delay_notice', {
                    rideId: ride.rideId,
                    eventId: warnEventId,
                    rideStatus: ride.status,
                    role: 'passenger',
                    delayState: evaluation.delayState,
                    title: 'Your driver is waiting',
                    body: 'Please meet your driver at the pickup point.',
                    actions: ['on_my_way', 'call_other_party', 'request_cancel'],
                });
                if (ride.driverId) {
                    RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:delay_notice', {
                        rideId: ride.rideId,
                        eventId: warnEventId,
                        rideStatus: ride.status,
                        role: 'driver',
                        delayState: evaluation.delayState,
                        title: 'Passenger is taking longer to come out',
                        body: 'We have reminded the passenger that you are waiting.',
                        actions: ['keep_waiting', 'call_other_party', 'request_cancel'],
                    });
                }
            }
        } catch { /* realtime is best-effort; the push below still goes */ }

        try {
            if (ride.status === 'accepted' && ride.driverId) {
                // No cancellation threat here. Nothing is cancelled on a timer any
                // more, so saying otherwise would be a lie that also teaches
                // drivers to distrust the next message.
                await NotificationService.sendToUser(
                    ride.driverId, UserRole.DRIVER,
                    'Still heading to your passenger?',
                    'Your passenger is waiting. Open the app to let them know you are still on your way.',
                    { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active', eventId: warnEventId },
                );
            } else if (ride.status === 'arrived') {
                if (ride.driverId) {
                    await NotificationService.sendToUser(
                        ride.driverId, UserRole.DRIVER,
                        'Start the trip?',
                        `You marked arrived ${Math.round(evaluation.ageMinutes ?? 0)} minutes ago. Start the trip, ` +
                        `or cancel if you could not pick the passenger up.`,
                        { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active', eventId: warnEventId },
                    );
                }
                if (ride.passengerId) {
                    await NotificationService.sendToUser(
                        ride.passengerId, UserRole.PASSENGER,
                        'Has your trip started?',
                        'Your driver marked arrived a while ago. If you have not been picked up, you can cancel.',
                        { type: 'STALE_RIDE_WARNING', rideId: ride.rideId, intent: 'active', eventId: warnEventId },
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
        //
        // `eventId` is deterministic on (ride, round): the push notification sent
        // a moment later carries the same id, so an app that receives both shows
        // one prompt. `extensionsRemaining` lets the app decide whether offering
        // "Keep waiting" would be honest before it draws the button.
        const round = ride.staleDecisionRound + 1;
        const promptBase = {
            rideId: ride.rideId,
            eventId: coordinationEventId(ride.rideId, 'decision', round),
            rideStatus: ride.status,
            reason: evaluation.reason,
            respondBySeconds: respondBySec,
            respondByAt: deadlineAt.toISOString(),
            waitingFor,
            round,
            extensionsRemaining: Math.max(0, config.maxExtensions - (ride.staleExtensionCount ?? 0)),
            options: ['wait', 'cancel'],
        };
        // `options: ['wait','cancel']` says what the SERVER accepts; `actions`
        // says what each side should be offered. They are not the same thing:
        // "wait" means "I'm still coming" to a driver who has not arrived and
        // "keep waiting" to one who is parked at the pickup point, and an app
        // given only the wire value cannot tell those apart. Both are sent, so
        // older builds keep working off `options`.
        try {
            RideCleanupService.hostRef?.emitToRide(ride.rideId, 'ride:stale_decision_required', {
                ...promptBase,
                role: 'passenger',
                actions: waitingFor === 'driver'
                    ? ['keep_waiting', 'call_other_party', 'request_cancel']
                    : ['on_my_way', 'call_other_party', 'request_cancel'],
                title: waitingFor === 'driver'
                    ? 'Your driver is taking longer than expected'
                    : 'Your driver is waiting',
                body: waitingFor === 'driver'
                    ? 'We are checking whether the driver is still on the way.'
                    : 'Please meet your driver at the pickup point.',
            });
            if (ride.driverId) {
                RideCleanupService.hostRef?.emitToDriver(ride.driverId, 'ride:stale_decision_required', {
                    ...promptBase,
                    role: 'driver',
                    actions: waitingFor === 'driver'
                        ? ['still_coming', 'call_other_party', 'open_navigation', 'request_cancel']
                        : ['keep_waiting', 'call_other_party', 'request_cancel'],
                    title: waitingFor === 'driver'
                        ? 'Are you still heading to the passenger?'
                        : 'Passenger is taking longer to come out',
                    body: waitingFor === 'driver'
                        ? 'The passenger is waiting. Let us know if you are still on your way.'
                        : 'We have reminded the passenger that you are waiting.',
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
                    { type: 'STALE_RIDE_DECISION', rideId: ride.rideId, intent: 'active', eventId: promptBase.eventId },
                );
            }
            if (ride.driverId) {
                await NotificationService.sendToUser(
                    ride.driverId, UserRole.DRIVER,
                    waitingFor === 'driver' ? 'Still going to this pickup?' : 'Passenger has not arrived',
                    'Tap to keep going or cancel this ride.',
                    { type: 'STALE_RIDE_DECISION', rideId: ride.rideId, intent: 'active', eventId: promptBase.eventId },
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
            case StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_PASSENGER_INITIATED:
                passengerMessage = 'Your ride has been cancelled as you asked. You can book again now.';
                driverMessage = 'The passenger cancelled and you accepted. You can accept new rides now.';
                break;
            case StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_DRIVER_INITIATED:
                passengerMessage = 'Your driver could not make this pickup and you accepted the cancellation. You can book again now.';
                driverMessage = 'This ride has been cancelled as you asked. You can accept new rides now.';
                break;
            case StaleResolution.CANCELLED_REQUEST_UNANSWERED:
                passengerMessage = 'This ride was cancelled after a cancellation request went unanswered. You can book again now.';
                driverMessage = 'This ride was cancelled after a cancellation request went unanswered. You can accept new rides now.';
                break;
            case StaleResolution.ABANDONED_BY_BOTH:
                passengerMessage = 'We lost contact with this ride, so we released it. You can book again whenever you are ready.';
                driverMessage = 'We lost contact with this ride, so we released it. You can accept new rides now.';
                break;
            default:
                passengerMessage = 'This ride has been closed. You can book again now.';
                driverMessage = 'This ride has been closed. You can accept new rides now.';
                break;
        }

        // The window closed unanswered — record that plainly before terminating.
        if (res === StaleResolution.CANCELLED_REQUEST_UNANSWERED
            || res === StaleResolution.ABANDONED_BY_BOTH) {
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
            reason: res ?? StaleResolution.ABANDONED_BY_BOTH,
            // ...and the SITUATION is recorded alongside it.
            situation: evaluation.reason ?? StaleActionReason.DRIVER_DID_NOT_ARRIVE,
            expectedStatuses: [ride.status],
            passengerMessage,
            driverMessage,
            // Refuses outright if no prompt was ever sent — EXCEPT for mutual
            // abandonment, which is the one resolution that rests on evidenced
            // absence rather than on an answer. Demanding a prompt there is
            // self-contradictory: both parties are provably unreachable, so there
            // is nobody to ask, and the ride wedges forever instead of closing —
            // retrying every pass while the passenger's booking slot stays leaked.
            // Every other resolution still requires that someone was asked.
            requireDecisionPrompt: res !== StaleResolution.ABANDONED_BY_BOTH,
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
