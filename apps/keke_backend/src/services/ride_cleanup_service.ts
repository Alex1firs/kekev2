/**
 * The single path by which a ride reaches a terminal state and every piece of
 * its state is released.
 *
 * Extracted so the scheduled sweep, the historical CLI and (in future) any admin
 * action all run the identical cleanup. The production incident this exists to
 * prevent was caused by one code path forgetting one Redis key, so "the same
 * service, always" is the whole point.
 *
 * The invariants it must satisfy, all of them, every time:
 *   - ride row: status, completedAt, cancellationReason
 *   - passenger active-ride slot        (ownership-checked)
 *   - driver reservation                (ownership-checked)
 *   - driverRideMap                     (in-memory, via host)
 *   - active dispatch loop + timers     (in-memory, via host)
 *   - realtime rooms: passenger, driver, admin
 *   - notifications to both parties
 *   - dispatch evidence / admin audit trail
 *   - driver availability, restored ONLY when genuinely fit
 *
 * Ownership-checked release is not a detail: forcing a release could delete a
 * NEWER ride's Redis state and hand the same driver to two rides at once.
 */
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { UserRole } from '../models/User';
import { DispatchService } from './dispatch_service';
import { NotificationService } from './notification_service';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { DispatchEventType } from '../models/DispatchEvent';
import { cancellationCopy, coordinationEventId } from './ride_coordination_contract';

/**
 * The in-memory and realtime state only the socket handler owns. Registered once
 * at construction, so this service stays free of socket.io.
 */
export interface RideCleanupHost {
    /** Stop any dispatch run and cancel its timers. */
    abortDispatch(rideId: string, reason: string): void;
    /** Release driver reservations this ride was holding (ownership-checked). */
    releaseRideReservations(rideId: string, reason: string): Promise<void>;
    /** Drivers that were offered this ride, for dismissal. */
    notifiedDrivers(rideId: string): string[];
    /** Forget driver -> ride mapping. */
    forgetDriverRide(driverId: string): void;
    /** Drop remaining per-ride dispatch bookkeeping. */
    clearDispatchState(rideId: string): void;
    emitToRide(rideId: string, event: string, payload: Record<string, unknown>): void;
    emitToDriver(driverId: string, event: string, payload: Record<string, unknown>): void;
    emitToAdmin(event: string, payload: Record<string, unknown>): void;
}

export interface TerminateArgs {
    rideId: string;
    /** Explicit reason, e.g. PASSENGER_CHOSE_CANCEL. */
    reason: string;
    /** The situation that made it stale, recorded separately from the decision. */
    situation?: string;
    /**
     * Require that both parties were asked before this ride can be cancelled.
     *
     * Set for every automatic stale cancellation. It is the structural guarantee
     * behind "no silent cancellations": if `staleDecisionPromptedAt` is null the
     * cancel is refused outright, so a coding mistake elsewhere cannot produce a
     * termination the passenger and driver never saw coming.
     */
    requireDecisionPrompt?: boolean;
    /** Statuses the ride must still be in. The conditional-update guard. */
    expectedStatuses: string[];
    /** Human-facing copy. */
    passengerMessage: string;
    driverMessage: string;
    /** Skip every mutation and report what would have happened. */
    dryRun?: boolean;
}

export interface TerminateResult {
    rideId: string;
    /** False when a newer legitimate transition won the race. */
    applied: boolean;
    skippedReason?: string;
    passengerSlotReleased: boolean;
    driverReservationReleased: boolean;
    driverAvailabilityRestored: boolean;
    driverAvailabilityWithheldReason?: string;
    dryRun: boolean;
}

export class RideCleanupService {
    private static host: RideCleanupHost | null = null;

    static setHost(host: RideCleanupHost | null): void {
        this.host = host;
    }

    /** Shared with the sweeper so decision prompts use the same realtime seam. */
    static get hostRef(): RideCleanupHost | null {
        return this.host;
    }

    /**
     * Cancel a ride and release everything it holds.
     *
     * Race-safety rests on a conditional UPDATE: the status change only applies
     * `WHERE status IN (expectedStatuses) AND startedAt IS NULL`, so a driver who
     * legitimately arrives, starts or completes between evaluation and execution
     * always wins and `applied` comes back false. Nothing is released in that
     * case — releasing state for a ride that is still live would be worse than
     * leaving it stale.
     */
    static async terminate(args: TerminateArgs): Promise<TerminateResult> {
        const dryRun = args.dryRun === true;
        const result: TerminateResult = {
            rideId: args.rideId,
            applied: false,
            passengerSlotReleased: false,
            driverReservationReleased: false,
            driverAvailabilityRestored: false,
            dryRun,
        };

        // A sweep must never throw because the datasource is mid-shutdown or not
        // yet up (deploy restart, startup race). Skipping is always safe: the
        // next pass will find the ride again.
        if (!AppDataSource.isInitialized) {
            result.skippedReason = 'datasource_unavailable';
            return result;
        }

        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId: args.rideId } });
        if (!ride) {
            result.skippedReason = 'ride_not_found';
            return result;
        }
        if (!args.expectedStatuses.includes(ride.status as unknown as string)) {
            result.skippedReason = `status_changed_to_${ride.status}`;
            return result;
        }

        if (dryRun) {
            result.skippedReason = 'dry_run';
            return result;
        }

        // NO SILENT CANCELLATIONS. An automatic stale cancellation may only
        // proceed once both parties have actually been asked.
        if (args.requireDecisionPrompt && ride.staleDecisionPromptedAt == null) {
            result.skippedReason = 'decision_prompt_not_sent';
            console.warn(JSON.stringify({
                level: 'warn', scope: 'ride_cleanup', event: 'refused_silent_cancel',
                rideId: args.rideId, reason: args.reason,
                detail: 'no decision prompt on record — refusing to cancel',
            }));
            return result;
        }

        // ── The authoritative conditional write ──────────────────────────
        // A single guarded UPDATE. If a driver's arrive/start/complete landed
        // first, affected === 0 and we abandon the whole cleanup.
        const update = await rideRepo
            .createQueryBuilder()
            .update()
            .set({
                status: 'canceled' as any,
                completedAt: new Date(),
                cancellationReason: args.reason,
                // The situation and the decision are separate facts: "the driver
                // never arrived" is why it went wrong, "the passenger chose to
                // cancel" is how it ended.
                staleReason: args.situation ?? args.reason,
                staleDetectedAt: new Date(),
            })
            .where(
                '"rideId" = :rideId AND status IN (:...expected) AND "startedAt" IS NULL AND "completedAt" IS NULL',
                { rideId: args.rideId, expected: args.expectedStatuses },
            )
            .execute();

        if (!update.affected || update.affected === 0) {
            // Re-read so the log says what actually won.
            const fresh = await rideRepo.findOne({ where: { rideId: args.rideId } });
            result.skippedReason = `lost_race_status_${fresh?.status ?? 'unknown'}`;
            return result;
        }

        result.applied = true;
        const passengerId = ride.passengerId;
        const driverId = ride.driverId;

        // ── Stop dispatch activity ───────────────────────────────────────
        try {
            this.host?.abortDispatch(args.rideId, args.reason);
            await this.host?.releaseRideReservations(args.rideId, args.reason);
        } catch (err: any) {
            console.warn(`[RIDE_CLEANUP] dispatch teardown failed for ${args.rideId}: ${err?.message}`);
        }

        // ── Realtime + notifications ─────────────────────────────────────
        // The socket payload used to carry only `reason` — a raw value like
        // SYSTEM_ABANDONED_BY_BOTH. An app in the foreground therefore had either
        // an engineering code to show someone or nothing at all, and the apps
        // ended up guessing (the passenger app read every cancellation as
        // "you cancelled"). The human copy travels with it now, so the phone
        // renders what the server decided rather than re-deriving it.
        const passengerOutcome = cancellationCopy(args.reason, 'passenger');
        const driverOutcome = cancellationCopy(args.reason, 'driver');
        try {
            this.host?.emitToRide(args.rideId, 'ride:cancelled', {
                rideId: args.rideId,
                reason: args.reason,
                systemCancelled: true,
                outcome: passengerOutcome.outcome,
                title: passengerOutcome.title,
                body: args.passengerMessage || passengerOutcome.body,
                eventId: coordinationEventId(args.rideId, 'cancelled', args.reason),
            });
            if (driverId) {
                this.host?.emitToDriver(driverId, 'ride:cancelled', {
                    rideId: args.rideId,
                    reason: args.reason,
                    systemCancelled: true,
                    outcome: driverOutcome.outcome,
                    title: driverOutcome.title,
                    body: args.driverMessage || driverOutcome.body,
                    eventId: coordinationEventId(args.rideId, 'cancelled', args.reason),
                });
            }
            for (const offered of this.host?.notifiedDrivers(args.rideId) ?? []) {
                if (offered === driverId) continue;
                this.host?.emitToDriver(offered, 'ride:cancelled', { rideId: args.rideId });
            }
            this.host?.emitToAdmin('ride:status_update', { rideId: args.rideId, status: 'canceled' });
        } catch (err: any) {
            console.warn(`[RIDE_CLEANUP] realtime notify failed for ${args.rideId}: ${err?.message}`);
        }

        // Push notifications. The service already de-duplicates per
        // (user, type, ride) within a short window, and the caller marks
        // staleWarnedAt, so neither a retry nor a restart double-sends.
        try {
            if (passengerId) {
                await NotificationService.sendToUser(
                    passengerId, UserRole.PASSENGER,
                    'Ride Cancelled', args.passengerMessage,
                    { type: 'RIDE_CANCELLED', rideId: args.rideId, intent: 'home' },
                );
            }
            if (driverId) {
                await NotificationService.sendToUser(
                    driverId, UserRole.DRIVER,
                    'Ride Cancelled', args.driverMessage,
                    { type: 'RIDE_CANCELLED', rideId: args.rideId, intent: 'home' },
                );
            }
        } catch (err: any) {
            console.warn(`[RIDE_CLEANUP] push notify failed for ${args.rideId}: ${err?.message}`);
        }

        // ── Release held state, ownership-checked throughout ─────────────
        if (passengerId) {
            try {
                // Scoped to THIS rideId: if the passenger has since started a
                // newer ride, that newer slot must survive untouched.
                result.passengerSlotReleased =
                    await DispatchService.releasePassengerActive(passengerId, args.rideId);
            } catch (err: any) {
                console.warn(`[RIDE_CLEANUP] passenger slot release failed: ${err?.message}`);
            }
        }

        if (driverId) {
            try {
                result.driverReservationReleased =
                    await DispatchService.releaseDriver(driverId, args.rideId);
            } catch (err: any) {
                console.warn(`[RIDE_CLEANUP] driver reservation release failed: ${err?.message}`);
            }
            try {
                this.host?.forgetDriverRide(driverId);
            } catch { /* in-memory only */ }

            const availability = await this.restoreDriverAvailability(driverId, args.rideId);
            result.driverAvailabilityRestored = availability.restored;
            result.driverAvailabilityWithheldReason = availability.withheldReason;
        }

        try {
            this.host?.clearDispatchState(args.rideId);
        } catch { /* in-memory only */ }

        // ── Durable audit trail ──────────────────────────────────────────
        DispatchMonitorService.record({
            rideId: args.rideId,
            eventType: DispatchEventType.RIDE_CANCELLED,
            driverId: driverId ?? null,
            detail: {
                cancelledBy: 'system',
                reason: args.reason,
                statusBeforeCancel: ride.status,
                passengerSlotReleased: result.passengerSlotReleased,
                driverReservationReleased: result.driverReservationReleased,
                driverAvailabilityRestored: result.driverAvailabilityRestored,
                driverAvailabilityWithheldReason: result.driverAvailabilityWithheldReason ?? null,
            },
        });
        DispatchMonitorService.forget(args.rideId);

        console.log(JSON.stringify({
            level: 'info', scope: 'ride_cleanup', event: 'terminated',
            rideId: args.rideId, reason: args.reason,
            previousStatus: ride.status, passengerId, driverId,
            passengerSlotReleased: result.passengerSlotReleased,
            driverReservationReleased: result.driverReservationReleased,
            driverAvailabilityRestored: result.driverAvailabilityRestored,
            driverAvailabilityWithheldReason: result.driverAvailabilityWithheldReason ?? null,
        }));

        return result;
    }

    /**
     * Put a freed driver back in the dispatch pool — but only if they genuinely
     * belong there.
     *
     * Marking an unfit driver available is worse than leaving them out: it sends
     * offers to a phone that is off, suspended or already on another trip, which
     * the passenger experiences as a silent non-answer. So availability is only
     * restored when ALL of the following hold, and the reason is recorded when
     * it is withheld.
     */
    private static async restoreDriverAvailability(
        driverId: string, rideId: string,
    ): Promise<{ restored: boolean; withheldReason?: string }> {
        try {
            // 1. Not suspended or rejected.
            const profile = await AppDataSource.getRepository(DriverProfile)
                .findOneBy({ userId: driverId });
            if (!profile) return { restored: false, withheldReason: 'no_driver_profile' };
            if (profile.status === 'suspended' || profile.status === 'rejected') {
                return { restored: false, withheldReason: `driver_${profile.status}` };
            }

            // 2. Not already on another live ride.
            const other = await AppDataSource.getRepository(Ride)
                .createQueryBuilder('r')
                .where('r."driverId" = :driverId', { driverId })
                .andWhere('r."rideId" != :rideId', { rideId })
                .andWhere('r.status IN (:...live)', { live: ['accepted', 'arrived', 'in_progress'] })
                .getOne();
            if (other) {
                return { restored: false, withheldReason: `assigned_to_${other.rideId}` };
            }

            // 3. Deliberate-offline tombstone absent — respect a driver who chose
            //    to go offline rather than dragging them back online.
            const offline = await DispatchService.isDriverDeliberatelyOffline(driverId);
            if (offline) return { restored: false, withheldReason: 'driver_went_offline' };

            // 4. Heartbeat fresh. A stale driver is not available by definition,
            //    and their next heartbeat will re-register them anyway.
            const available = await DispatchService.isDriverAvailable(driverId);
            if (!available) return { restored: false, withheldReason: 'stale_heartbeat' };

            // Nothing to write: availability IS the live heartbeat key, which is
            // already valid. The ride assignment was the only thing excluding
            // them, and that is now gone. Confirming rather than forcing avoids
            // fabricating presence the driver's phone never reported.
            return { restored: true };
        } catch (err: any) {
            return { restored: false, withheldReason: `check_failed:${err?.message ?? 'unknown'}` };
        }
    }

    /** Flag an over-running trip for humans. Never cancels, never touches money. */
    static async flagForOperationsReview(args: {
        rideId: string;
        reason: string;
        ageMinutes: number;
        thresholdMinutes: number;
        dryRun?: boolean;
    }): Promise<{ applied: boolean; skippedReason?: string }> {
        if (args.dryRun) return { applied: false, skippedReason: 'dry_run' };
        if (!AppDataSource.isInitialized) {
            return { applied: false, skippedReason: 'datasource_unavailable' };
        }

        const rideRepo = AppDataSource.getRepository(Ride);
        // Conditional: only an in-progress, uncompleted, not-yet-flagged trip.
        const update = await rideRepo
            .createQueryBuilder()
            .update()
            .set({
                requiresOperationsReview: true,
                staleReason: args.reason,
                staleDetectedAt: new Date(),
            })
            .where(
                '"rideId" = :rideId AND status IN (:...live) AND "completedAt" IS NULL AND "requiresOperationsReview" = false',
                { rideId: args.rideId, live: ['in_progress', 'started'] },
            )
            .execute();

        if (!update.affected || update.affected === 0) {
            return { applied: false, skippedReason: 'already_flagged_or_status_changed' };
        }

        const ride = await rideRepo.findOne({ where: { rideId: args.rideId } });

        // High-priority admin signal. Payment and trip records are untouched:
        // this is a request for a human decision, not a resolution.
        this.host?.emitToAdmin('admin:ride_requires_review', {
            rideId: args.rideId,
            reason: args.reason,
            ageMinutes: Math.round(args.ageMinutes),
            thresholdMinutes: Math.round(args.thresholdMinutes),
            passengerId: ride?.passengerId ?? null,
            driverId: ride?.driverId ?? null,
            severity: 'high',
        });

        DispatchMonitorService.record({
            rideId: args.rideId,
            eventType: DispatchEventType.OPERATIONS_REVIEW_REQUIRED,
            driverId: ride?.driverId ?? null,
            detail: {
                reason: args.reason,
                ageMinutes: Math.round(args.ageMinutes),
                thresholdMinutes: Math.round(args.thresholdMinutes),
                autoCancelled: false,
                paymentUntouched: true,
            },
        });

        console.warn(JSON.stringify({
            level: 'warn', scope: 'ride_cleanup', event: 'operations_review_required',
            rideId: args.rideId, reason: args.reason,
            ageMinutes: Math.round(args.ageMinutes),
        }));

        return { applied: true };
    }
}
