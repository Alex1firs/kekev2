/**
 * Park Dispatch — a DOWNSTREAM fallback, never a change to dispatch.
 *
 * ── Where this sits ─────────────────────────────────────────────────────
 * `DispatchRun` and the orchestrator are untouched. By the time anything here
 * runs, the run has finished, its rounds are exhausted, its evidence is sealed
 * and its outcome is known. This service is consulted at exactly one point —
 * inside `finalizeUnsuccessfulDispatch`, immediately before the ride would have
 * been marked `failed` — and it either takes responsibility for the ride or
 * declines, in which case the ride fails exactly as it does today.
 *
 * That placement is the whole safety argument. Nothing here can shorten a round,
 * change a radius tier, alter eligibility, or influence which drivers get rung.
 *
 * ── One ride, one owner ─────────────────────────────────────────────────
 * The ride stays `searching` for the entire park phase. It becomes `accepted`
 * through the SAME conditional UPDATE a direct acceptance uses, in the same
 * method (`SocketHandler.assignDriverToRide`). So:
 *
 *   - `RideStatus` gains no new values, and every existing conditional UPDATE,
 *     sweeper query and eligibility filter keeps working unchanged;
 *   - a direct driver accepting during the park phase simply wins the UPDATE,
 *     and the park job is cancelled;
 *   - there is no second ride flow to drift out of step with the first.
 *
 * ── The dispatcher's authority ──────────────────────────────────────────
 * Claim, assign, skip, escalate, reject. That is the complete list. Nothing here
 * advances a ride: once a driver is assigned, the dispatcher is finished and the
 * existing lifecycle owns the ride.
 */
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { User } from '../models/User';
import { DriverProfile } from '../models/DriverProfile';
import { ParkDispatchJob, ParkJobStatus, ParkAssignmentMode } from '../models/ParkDispatchJob';
import { DispatchEventType } from '../models/DispatchEvent';
import { ParkDispatchJobRepository } from '../repositories/park_dispatch_job_repository';
import { ParkRepository } from '../repositories/park_repository';
import { ParkSelectionService } from './park_selection_service';
import { ParkRosterService } from './park_roster_service';
import { DispatcherShiftService } from './dispatcher_shift_service';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { AuditService, AuditActor } from './audit_service';
import { loadParkDispatchConfig, computeJobPriority, PRIORITY_LABEL } from '../config/park_dispatch_config';
import { AppError, ErrorCode } from '../utils/errors';
import { maskPhoneNumber } from './contact_access_service';

export const ParkDispatchAuditAction = {
    PARK_JOB_CLAIMED: 'PARK_JOB_CLAIMED',
    PARK_JOB_ASSIGNED: 'PARK_JOB_ASSIGNED',
    PARK_JOB_SKIPPED: 'PARK_JOB_SKIPPED',
    PARK_JOB_REJECTED: 'PARK_JOB_REJECTED',
    PARK_JOB_ESCALATED: 'PARK_JOB_ESCALATED',
} as const;

/**
 * Everything the host (SocketHandler) owns that this service needs.
 *
 * Same pattern as RideCleanupService.setHost. The service holds no reference to
 * socket.io and no in-memory dispatch state; the host lends it exactly the
 * capabilities it needs and nothing more. In particular `assignDriver` is the
 * host's single assignment method — this service cannot invent its own.
 */
export interface ParkDispatchHost {
    assignDriver(args: {
        rideId: string;
        driverId: string;
        parkId: string;
        parkJobId: string;
        assignmentMode: 'electronic' | 'verbal';
        assignedByStaffId: string;
    }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
    emitToRide(rideId: string, event: string, payload: Record<string, unknown>): void;
    emitToPark(parkId: string, event: string, payload: Record<string, unknown>): void;
    emitToAdmin(event: string, payload: Record<string, unknown>): void;
    notifyPassenger(passengerId: string, title: string, body: string, data: Record<string, unknown>): void;
}

/** One card in the dispatcher's queue. */
export interface QueueCard {
    jobId: string;
    rideId: string;
    parkId: string;
    status: ParkJobStatus;
    priority: number;
    priorityLabel: string;

    pickupAddress: string | null;
    destinationAddress: string | null;
    pickupLat: number | null;
    pickupLng: number | null;
    /** First name only. A dispatcher needs to greet somebody, not identify them. */
    passengerName: string;
    /** Masked, never dialable, until a supervisor deliberately reveals it. */
    passengerPhoneMasked: string | null;
    estimatedFare: number;
    paymentMode: string;

    /** Seconds since the PASSENGER requested — not since the park was offered. */
    waitingSeconds: number;
    /** Seconds this job has been in this park's queue. */
    queuedSeconds: number;
    /** How many parks this ride has already been offered to, including this one. */
    parksTried: number;
    estimatedTravelMinutes: number | null;
    /** Deadline for the current step, so the device can count down. */
    expiresAt: Date;
    claimedByStaffId: string | null;
}

export class ParkDispatchService {
    private static host: ParkDispatchHost | null = null;

    static setHost(host: ParkDispatchHost): void {
        this.host = host;
    }

    private static requireHost(): ParkDispatchHost {
        if (!this.host) throw new Error('ParkDispatchService host not configured');
        return this.host;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Fallback entry point
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Offer a ride that direct dispatch could not fill to the best eligible park.
     *
     * Returns TRUE only when a park has genuinely taken the request into its
     * queue. The caller must fail the ride exactly as before on false — this
     * method never leaves a ride in limbo, and never throws into the dispatch
     * path: any error is caught and reported as "no park took it".
     */
    static async offerToPark(rideId: string): Promise<boolean> {
        const config = loadParkDispatchConfig();
        if (!config.enabled) return false;

        try {
            const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
            if (!ride) return false;

            // Only a ride still genuinely searching may enter the park phase.
            // If a direct driver won in the meantime, there is nothing to do.
            if (String(ride.status) !== 'searching') return false;
            if (ride.pickupLat == null || ride.pickupLng == null) return false;

            // One live job per ride, ever. The unique index enforces it; this
            // check makes the common case cheap and the message clear.
            const existing = await ParkDispatchJobRepository.findLiveForRide(rideId);
            if (existing) return true;

            const tried = await ParkSelectionService.parksAlreadyTried(rideId);
            if (tried.length >= config.maxParksPerRide) {
                this.recordExhausted(rideId, 'max_parks_reached', tried.length);
                return false;
            }

            const { candidates, rejected } = await ParkSelectionService.selectForPickup(
                { lat: Number(ride.pickupLat), lng: Number(ride.pickupLng) },
                config,
                tried,
            );

            if (candidates.length === 0) {
                this.recordExhausted(rideId, 'no_eligible_park', tried.length, {
                    considered: rejected.map((r) => ({ parkId: r.park.parkId, reason: r.rejectedReason })),
                });
                return false;
            }

            const chosen = candidates[0];
            const now = new Date();
            const waitedMs = Math.max(0, now.getTime() - new Date(ride.createdAt).getTime());

            const job = await ParkDispatchJobRepository.save(ParkDispatchJobRepository.create({
                rideId,
                parkId: chosen.park.parkId,
                status: ParkJobStatus.OFFERED,
                priority: computeJobPriority(waitedMs),
                attemptNumber: tried.length + 1,
                offeredAt: now,
                offerExpiresAt: new Date(now.getTime() + config.claimWindowMs),
                parkToPickupKm: Number(chosen.distanceKm.toFixed(3)),
                estimatedTravelMinutes: chosen.estimatedTravelMinutes,
            }));

            DispatchMonitorService.record({
                rideId,
                eventType: DispatchEventType.PARK_OFFERED,
                detail: {
                    parkId: chosen.park.parkId,
                    parkCode: chosen.park.code,
                    attemptNumber: job.attemptNumber,
                    estimatedTravelMinutes: chosen.estimatedTravelMinutes,
                    assignableDriverCount: chosen.assignableDriverCount,
                    claimWindowMs: config.claimWindowMs,
                    rejectedParks: rejected.map((r) => ({ parkId: r.park.parkId, reason: r.rejectedReason })),
                },
            });

            const host = this.requireHost();
            host.emitToPark(chosen.park.parkId, 'park:request_offered', {
                jobId: job.jobId,
                rideId,
                priority: job.priority,
                expiresAt: job.offerExpiresAt,
            });
            host.emitToAdmin('park:job_offered', { jobId: job.jobId, rideId, parkId: chosen.park.parkId });

            // Keep the PASSENGER honestly informed. `ride:dispatch_round` is what
            // builds already in the field understand: it re-arms their 150s
            // watchdog and renders "Still searching nearby…", which is true.
            // `ride:park_state` is the specific copy newer builds show.
            if (config.emitRoundEvent) {
                host.emitToRide(rideId, 'ride:dispatch_round', {
                    rideId,
                    dispatchRound: 3,
                    totalRounds: 3,
                    reason: 'park_fallback',
                });
            }
            host.emitToRide(rideId, 'ride:park_state', {
                rideId,
                state: 'checking_park',
                message: 'Checking a nearby Keke park…',
            });

            return true;
        } catch (err: any) {
            // A fallback that throws into the dispatch path would turn "no
            // driver found" into a crash. It fails closed instead: the ride
            // takes exactly the route it takes today.
            console.error(JSON.stringify({
                level: 'error', event: 'park_offer_failed', rideId, error: err?.message,
            }));
            return false;
        }
    }

    private static recordExhausted(rideId: string, reason: string, parksTried: number, extra: Record<string, unknown> = {}): void {
        DispatchMonitorService.record({
            rideId,
            eventType: DispatchEventType.PARK_DISPATCH_EXHAUSTED,
            detail: { reason, parksTried, ...extra },
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Dispatcher actions
    // ═══════════════════════════════════════════════════════════════════

    /** The live queue for a park, as cards a device can render directly. */
    static async queueForPark(parkId: string): Promise<QueueCard[]> {
        const jobs = await ParkDispatchJobRepository.findQueueForPark(parkId);
        if (jobs.length === 0) return [];

        const rideIds = jobs.map((j) => j.rideId);
        const rides = await AppDataSource.getRepository(Ride)
            .createQueryBuilder('r').where('r."rideId" IN (:...rideIds)', { rideIds }).getMany();
        const rideBy = new Map(rides.map((r) => [r.rideId, r]));

        const passengerIds = [...new Set(rides.map((r) => r.passengerId))];
        const passengers = passengerIds.length
            ? await AppDataSource.getRepository(User)
                .createQueryBuilder('u').where('u.id IN (:...ids)', { ids: passengerIds }).getMany()
            : [];
        const passengerBy = new Map(passengers.map((p) => [p.id, p]));

        // How many parks each ride has been through, in one query.
        const attempts = await AppDataSource.getRepository(ParkDispatchJob)
            .createQueryBuilder('j')
            .select('j."rideId"', 'rideId')
            .addSelect('COUNT(DISTINCT j."parkId")', 'count')
            .where('j."rideId" IN (:...rideIds)', { rideIds })
            .groupBy('j."rideId"')
            .getRawMany<{ rideId: string; count: string }>();
        const attemptsBy = new Map(attempts.map((a) => [a.rideId, Number(a.count)]));

        const now = Date.now();
        return jobs.map((job) => {
            const ride = rideBy.get(job.rideId);
            const passenger = ride ? passengerBy.get(ride.passengerId) : undefined;
            return {
                jobId: job.jobId,
                rideId: job.rideId,
                parkId: job.parkId,
                status: job.status,
                priority: job.priority,
                priorityLabel: PRIORITY_LABEL[job.priority] ?? 'normal',

                pickupAddress: ride?.pickupAddress ?? null,
                destinationAddress: ride?.destinationAddress ?? null,
                pickupLat: ride?.pickupLat != null ? Number(ride.pickupLat) : null,
                pickupLng: ride?.pickupLng != null ? Number(ride.pickupLng) : null,
                // First name only, and a masked number. A dispatcher needs to
                // greet somebody and recognise them; they do not need the means
                // to contact a passenger who never asked to hear from them.
                passengerName: passenger?.firstName ?? 'Passenger',
                passengerPhoneMasked: maskPhoneNumber(passenger?.phone),
                estimatedFare: ride ? Number(ride.fare) : 0,
                paymentMode: ride?.paymentMode ?? 'cash',

                waitingSeconds: ride ? Math.max(0, Math.round((now - new Date(ride.createdAt).getTime()) / 1000)) : 0,
                queuedSeconds: Math.max(0, Math.round((now - new Date(job.offeredAt).getTime()) / 1000)),
                parksTried: attemptsBy.get(job.rideId) ?? 1,
                estimatedTravelMinutes: job.estimatedTravelMinutes,
                expiresAt: job.status === ParkJobStatus.CLAIMED && job.assignmentDeadlineAt
                    ? job.assignmentDeadlineAt
                    : job.offerExpiresAt,
                claimedByStaffId: job.claimedByStaffId,
            };
        });
    }

    /** Take responsibility for sourcing a driver. */
    static async claim(
        actor: AuditActor,
        jobId: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<QueueCard> {
        const config = loadParkDispatchConfig();
        const job = await this.requireJob(jobId);
        const shift = await this.requireOpenShiftAtPark(actor.staffUserId, job.parkId);

        if (job.status === ParkJobStatus.CLAIMED && job.claimedByStaffId === actor.staffUserId) {
            return this.cardFor(job);
        }
        if (job.status !== ParkJobStatus.OFFERED) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `This request is already ${job.status}.`);
        }

        const now = new Date();
        const won = await ParkDispatchJobRepository.claimIfOffered(jobId, {
            claimedByStaffId: actor.staffUserId,
            shiftId: shift.shiftId,
            claimedAt: now,
            assignmentDeadlineAt: new Date(now.getTime() + config.assignWindowMs),
            responseTimeMs: now.getTime() - new Date(job.offeredAt).getTime(),
        });
        if (!won) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'Another dispatcher took this request first.');
        }

        DispatchMonitorService.record({
            rideId: job.rideId,
            eventType: DispatchEventType.PARK_CLAIMED,
            detail: {
                parkId: job.parkId,
                jobId,
                claimedByStaffId: actor.staffUserId,
                responseTimeMs: now.getTime() - new Date(job.offeredAt).getTime(),
            },
        });
        await AuditService.record({
            actor,
            action: ParkDispatchAuditAction.PARK_JOB_CLAIMED,
            resourceType: 'PARK_DISPATCH_JOB',
            resourceId: jobId,
            parkId: job.parkId,
            rideId: job.rideId,
            ...ctx,
        });

        this.requireHost().emitToRide(job.rideId, 'ride:park_state', {
            rideId: job.rideId,
            state: 'assigning_driver',
            message: 'A driver is being assigned…',
        });

        const fresh = await this.requireJob(jobId);
        return this.cardFor(fresh);
    }

    /**
     * Assign a driver. The dispatcher's last act on this ride.
     *
     * Ordering matters and is deliberate: every check runs BEFORE the ride is
     * touched, the ride assignment happens through the host's single assignment
     * method, and only then is the job recorded as assigned. If the ride
     * assignment fails — a direct driver won the race, the driver went busy —
     * the job stays claimed and the dispatcher can try somebody else.
     */
    static async assignDriver(
        actor: AuditActor,
        jobId: string,
        driverId: string,
        mode: ParkAssignmentMode,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<{ jobId: string; rideId: string; driverId: string; assignmentMode: ParkAssignmentMode }> {
        const job = await this.requireJob(jobId);
        await this.requireOpenShiftAtPark(actor.staffUserId, job.parkId);

        if (job.status !== ParkJobStatus.CLAIMED) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                job.status === ParkJobStatus.OFFERED
                    ? 'Take this request first, then assign a driver.'
                    : `This request is already ${job.status}.`);
        }
        if (job.claimedByStaffId !== actor.staffUserId) {
            throw new AppError(403, ErrorCode.FORBIDDEN, 'Another dispatcher is handling this request.');
        }

        // The driver must be on THIS park's roster and allowed to work.
        const roster = await ParkRosterService.view(job.parkId, {});
        const entry = roster.find((r) => r.driverId === driverId);
        if (!entry) {
            throw new AppError(404, ErrorCode.NOT_FOUND, 'That driver is not on this park roster.');
        }
        const problems = ParkRosterService.assignabilityProblems(entry);
        // presence_unknown / not_waiting are re-derived below against live
        // presence, so they are excluded here to avoid a confusing double report.
        const blocking = problems.filter((p) => !['not_waiting', 'presence_unknown'].includes(p.code));
        if (blocking.length > 0) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `This driver cannot take a ride: ${blocking.map((p) => p.message).join('; ')}.`);
        }

        // Presence, checked against live state at the moment of assignment —
        // a driver may have walked off since the queue was rendered.
        const presence = await ParkSelectionService.isDriverPresenceAssignable(driverId, job.parkId);
        if (!presence.ok) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                presence.state
                    ? `This driver is ${presence.state.replace(/_/g, ' ')} — only drivers at the park and waiting can be assigned.`
                    : 'This driver has no recorded presence at the park.');
        }

        // Hand to the ONE assignment path. This is the same method a direct
        // acceptance goes through, so from here the ride is indistinguishable
        // from one a smartphone driver accepted themselves.
        const result = await this.requireHost().assignDriver({
            rideId: job.rideId,
            driverId,
            parkId: job.parkId,
            parkJobId: job.jobId,
            assignmentMode: mode === ParkAssignmentMode.VERBAL ? 'verbal' : 'electronic',
            assignedByStaffId: actor.staffUserId,
        });

        if (!result.ok) {
            // The job stays CLAIMED: the dispatcher still owns the problem and
            // can assign somebody else.
            throw new AppError(
                result.code === 'RIDE_ALREADY_TAKEN' ? 409 : 400,
                ErrorCode.VALIDATION_ERROR,
                result.code === 'RIDE_ALREADY_TAKEN'
                    ? 'This ride was taken by another driver. It is no longer yours to assign.'
                    : result.message,
            );
        }

        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: job.rideId } });
        const now = new Date();
        await ParkDispatchJobRepository.markAssignedIfClaimed(jobId, {
            assignedDriverId: driverId,
            assignedByStaffId: actor.staffUserId,
            assignmentMode: mode,
            assignedAt: now,
            assignmentTimeMs: job.claimedAt ? now.getTime() - new Date(job.claimedAt).getTime() : null,
            passengerWaitMs: ride ? now.getTime() - new Date(ride.createdAt).getTime() : null,
        });

        await AuditService.recordCritical({
            actor,
            action: ParkDispatchAuditAction.PARK_JOB_ASSIGNED,
            resourceType: 'PARK_DISPATCH_JOB',
            resourceId: jobId,
            parkId: job.parkId,
            rideId: job.rideId,
            driverId,
            metadata: { assignmentMode: mode, attemptNumber: job.attemptNumber },
            ...ctx,
        });

        // The driver takes the queue slot with them.
        try {
            await ParkRosterService.leaveQueue(actor, job.parkId, driverId, 'assigned to a ride', ctx);
        } catch {
            /* the assignment stands regardless of queue bookkeeping */
        }

        const host = this.requireHost();
        host.emitToPark(job.parkId, 'park:job_assigned', { jobId, rideId: job.rideId, driverId });
        host.emitToAdmin('park:job_assigned', { jobId, rideId: job.rideId, parkId: job.parkId, driverId });

        return { jobId, rideId: job.rideId, driverId, assignmentMode: mode };
    }

    /** No driver here for this one. Resolve and move on immediately. */
    static async skip(actor: AuditActor, jobId: string, reason: string, ctx: { ipAddress?: string | null; correlationId?: string | null } = {}): Promise<void> {
        await this.resolve(actor, jobId, ParkJobStatus.SKIPPED, reason, DispatchEventType.PARK_SKIPPED,
            ParkDispatchAuditAction.PARK_JOB_SKIPPED, ctx);
    }

    /** The dispatcher declines the request outright. */
    static async reject(actor: AuditActor, jobId: string, reason: string, ctx: { ipAddress?: string | null; correlationId?: string | null } = {}): Promise<void> {
        await this.resolve(actor, jobId, ParkJobStatus.REJECTED, reason, DispatchEventType.PARK_REJECTED,
            ParkDispatchAuditAction.PARK_JOB_REJECTED, ctx);
    }

    /**
     * Escalate to a human.
     *
     * Deliberately NOT a cancellation. The ride keeps searching and the existing
     * stale-ride coordination continues to own it, exactly as
     * `escalatedToSupportAt` does elsewhere in the platform. Escalation means
     * "somebody look at this", never "this is over".
     */
    static async escalate(actor: AuditActor, jobId: string, reason: string, ctx: { ipAddress?: string | null; correlationId?: string | null } = {}): Promise<void> {
        await this.resolve(actor, jobId, ParkJobStatus.ESCALATED, reason, DispatchEventType.PARK_ESCALATED,
            ParkDispatchAuditAction.PARK_JOB_ESCALATED, ctx);
        this.requireHost().emitToAdmin('park:job_escalated', { jobId, reason });
    }

    private static async resolve(
        actor: AuditActor,
        jobId: string,
        status: ParkJobStatus,
        reason: string,
        eventType: DispatchEventType,
        auditAction: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null },
    ): Promise<void> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required.');
        }
        const job = await this.requireJob(jobId);
        await this.requireOpenShiftAtPark(actor.staffUserId, job.parkId);

        const resolved = await ParkDispatchJobRepository.resolveIfLive(jobId, status, reason.trim(), actor.staffUserId);
        if (!resolved) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `This request is already ${job.status}.`);
        }

        DispatchMonitorService.record({
            rideId: job.rideId,
            eventType,
            detail: { parkId: job.parkId, jobId, reason: reason.trim(), staffUserId: actor.staffUserId },
        });
        await AuditService.recordCritical({
            actor,
            action: auditAction,
            resourceType: 'PARK_DISPATCH_JOB',
            resourceId: jobId,
            parkId: job.parkId,
            rideId: job.rideId,
            reason: reason.trim(),
            ...ctx,
        });

        // Skip and reject free the ride to try the next park (or to fail). An
        // escalation deliberately does not — a human is looking at it.
        if (status !== ParkJobStatus.ESCALATED) {
            await this.releaseRide(job.rideId);
        }
    }

    /**
     * A park is done with this ride. Try the next park, or let it fail.
     *
     * Failing here means writing `failed` on a ride the dispatch loop has long
     * since stopped watching — which is exactly what would have happened at the
     * end of `finalizeUnsuccessfulDispatch` had no park taken it.
     */
    private static async releaseRide(rideId: string): Promise<void> {
        const offered = await this.offerToPark(rideId);
        if (offered) return;

        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });
        if (!ride || String(ride.status) !== 'searching') return;

        await rideRepo.createQueryBuilder()
            .update()
            .set({ status: 'failed' as any })
            .where('"rideId" = :rideId AND status = :searching', { rideId, searching: 'searching' })
            .execute();

        const host = this.requireHost();
        host.emitToRide(rideId, 'ride:failed', {
            code: 'NO_DRIVER_FOUND',
            dispatchResult: 'park_dispatch_exhausted',
            message: 'No drivers available nearby',
        });
        host.emitToAdmin('ride:status_update', { rideId, status: 'failed' });
        host.notifyPassenger(ride.passengerId, 'No Driver Found',
            "We couldn't find a nearby driver. Please try again.",
            { type: 'NO_DRIVER', rideId, intent: 'retry' });

        const { DispatchService } = await import('./dispatch_service');
        await DispatchService.releasePassengerActive(ride.passengerId, rideId);
    }

    /**
     * Cancel any live job for a ride.
     *
     * Called when the passenger cancels or a direct driver wins the race. The
     * dispatcher's screen updates rather than leaving them working a request
     * that no longer exists.
     */
    static async cancelForRide(rideId: string, reason: string): Promise<void> {
        try {
            const live = await ParkDispatchJobRepository.findLiveForRide(rideId);
            if (!live) return;
            await ParkDispatchJobRepository.cancelLiveForRide(rideId, reason);
            this.host?.emitToPark(live.parkId, 'park:job_cancelled', { jobId: live.jobId, rideId, reason });
            this.host?.emitToAdmin('park:job_cancelled', { jobId: live.jobId, rideId, reason });
        } catch (err: any) {
            console.error(JSON.stringify({ level: 'error', event: 'park_job_cancel_failed', rideId, error: err?.message }));
        }
    }

    /**
     * Resolve jobs whose window elapsed.
     *
     * Safe to call repeatedly; each expiry is a conditional update, so two
     * concurrent sweeps cannot both expire the same job.
     */
    static async sweepExpired(now: Date = new Date()): Promise<number> {
        const config = loadParkDispatchConfig();
        if (!config.enabled) return 0;

        const expired = await ParkDispatchJobRepository.findExpired(now);
        let count = 0;
        for (const job of expired) {
            const resolved = await ParkDispatchJobRepository.resolveIfLive(
                job.jobId, ParkJobStatus.EXPIRED,
                job.status === ParkJobStatus.OFFERED ? 'claim window elapsed' : 'assignment window elapsed',
            );
            if (!resolved) continue;
            count += 1;

            DispatchMonitorService.record({
                rideId: job.rideId,
                eventType: DispatchEventType.PARK_JOB_EXPIRED,
                detail: { parkId: job.parkId, jobId: job.jobId, expiredFrom: job.status },
            });
            this.host?.emitToPark(job.parkId, 'park:job_expired', { jobId: job.jobId, rideId: job.rideId });
            await this.releaseRide(job.rideId);
        }
        return count;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private static async requireJob(jobId: string): Promise<ParkDispatchJob> {
        const job = await ParkDispatchJobRepository.findById(jobId);
        if (!job) throw new AppError(404, ErrorCode.NOT_FOUND, 'Request not found.');
        return job;
    }

    /**
     * A dispatcher may only act on a park where they are ON DUTY.
     *
     * The role grant says they may ever work here; the open shift says they are
     * working now. Both are required — that is what makes "who was accountable
     * at 14:20" answerable from a table.
     */
    private static async requireOpenShiftAtPark(staffUserId: string, parkId: string) {
        const shift = await DispatcherShiftService.current(staffUserId);
        if (!shift) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'You have no open shift. Start your shift first.');
        }
        if (shift.parkId !== parkId) {
            throw new AppError(403, ErrorCode.FORBIDDEN, 'This request belongs to a different park.');
        }
        return shift;
    }

    private static async cardFor(job: ParkDispatchJob): Promise<QueueCard> {
        const cards = await this.queueForPark(job.parkId);
        const card = cards.find((c) => c.jobId === job.jobId);
        if (card) return card;
        // The job left the live queue between the action and this read.
        const cardsAll = await this.queueForPark(job.parkId);
        return cardsAll[0] ?? {
            jobId: job.jobId, rideId: job.rideId, parkId: job.parkId, status: job.status,
            priority: job.priority, priorityLabel: PRIORITY_LABEL[job.priority] ?? 'normal',
            pickupAddress: null, destinationAddress: null, pickupLat: null, pickupLng: null,
            passengerName: 'Passenger', passengerPhoneMasked: null, estimatedFare: 0, paymentMode: 'cash',
            waitingSeconds: 0, queuedSeconds: 0, parksTried: job.attemptNumber,
            estimatedTravelMinutes: job.estimatedTravelMinutes,
            expiresAt: job.offerExpiresAt, claimedByStaffId: job.claimedByStaffId,
        };
    }

    /** Driver ids at a park a dispatcher may currently assign, longest-waiting first. */
    static async assignableDrivers(parkId: string) {
        const roster = await ParkRosterService.view(parkId, {});
        const assignableIds = new Set(await ParkSelectionService.assignableDriverIds(parkId));
        return roster
            .filter((r) => assignableIds.has(r.driverId))
            .map((r) => ({
                ...r,
                problems: ParkRosterService.assignabilityProblems(r),
                assignable: ParkRosterService.assignabilityProblems(r).length === 0,
                /** A feature-phone driver must be told verbally — the UI needs to know. */
                requiresVerbalAssignment: !r.smartphoneCapable,
            }));
    }
}
