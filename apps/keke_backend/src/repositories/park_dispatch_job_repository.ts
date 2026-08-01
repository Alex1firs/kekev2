/**
 * Data access for park dispatch jobs.
 *
 * Every state change goes through a CONDITIONAL update that names the status it
 * expects to find. Two dispatchers tapping "take this ride" at the same instant,
 * or a claim racing the expiry sweep, must produce exactly one winner — and the
 * loser must be told, not silently overwritten. The application cannot arbitrate
 * that; the database can.
 */
import { In, LessThan, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { ParkDispatchJob, ParkJobStatus, ParkAssignmentMode } from '../models/ParkDispatchJob';

/**
 * Statuses in which a job is still somebody's problem.
 *
 * PENDING_ACCEPTANCE counts as live: a driver holding an unanswered offer means
 * the ride is still in this park's hands, and it must not be offered elsewhere.
 */
export const LIVE_JOB_STATUSES = [
    ParkJobStatus.OFFERED,
    ParkJobStatus.CLAIMED,
    ParkJobStatus.PENDING_ACCEPTANCE,
];

export interface JobListQuery {
    parkId?: string;
    status?: ParkJobStatus;
    statuses?: ParkJobStatus[];
    from?: Date;
    to?: Date;
    page?: number;
    pageSize?: number;
}

export class ParkDispatchJobRepository {
    private static get repo(): Repository<ParkDispatchJob> {
        return AppDataSource.getRepository(ParkDispatchJob);
    }

    static findById(jobId: string): Promise<ParkDispatchJob | null> {
        return this.repo.findOneBy({ jobId });
    }

    /** The live job for a ride, if any. At most one exists — enforced by index. */
    static findLiveForRide(rideId: string): Promise<ParkDispatchJob | null> {
        return this.repo.findOne({ where: { rideId, status: In(LIVE_JOB_STATUSES) } });
    }

    static findAllForRide(rideId: string): Promise<ParkDispatchJob[]> {
        return this.repo.find({ where: { rideId }, order: { offeredAt: 'ASC' } });
    }

    /**
     * The dispatcher's queue: live jobs at one park, most urgent first, then
     * longest-waiting. Urgency before age, because a five-minute-old request is
     * a worse problem than a two-minute-old one regardless of arrival order.
     */
    static findQueueForPark(parkId: string): Promise<ParkDispatchJob[]> {
        return this.repo.find({
            where: { parkId, status: In(LIVE_JOB_STATUSES) },
            order: { priority: 'DESC', offeredAt: 'ASC' },
        });
    }

    static countLiveForPark(parkId: string): Promise<number> {
        return this.repo.count({ where: { parkId, status: In(LIVE_JOB_STATUSES) } });
    }

    static create(data: Partial<ParkDispatchJob>): ParkDispatchJob {
        return this.repo.create(data);
    }

    static save(job: ParkDispatchJob): Promise<ParkDispatchJob> {
        return this.repo.save(job);
    }

    /**
     * Claim a job, only if it is still OFFERED.
     *
     * Returns whether THIS caller won. Two dispatchers at the same park can tap
     * the same request within milliseconds of each other; exactly one gets true.
     */
    static async claimIfOffered(
        jobId: string,
        patch: { claimedByStaffId: string; shiftId: string | null; claimedAt: Date; assignmentDeadlineAt: Date; responseTimeMs: number },
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({ status: ParkJobStatus.CLAIMED, ...patch })
            .where('"jobId" = :jobId AND status = :expected', { jobId, expected: ParkJobStatus.OFFERED })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Mark a job assigned, only if it is still CLAIMED.
     *
     * Called AFTER the ride's conditional searching→accepted UPDATE has already
     * succeeded, so this records what happened rather than arbitrating it. The
     * ride row remains the single arbiter of who owns a ride.
     */
    static async markAssignedFromStatuses(
        jobId: string,
        fromStatuses: ParkJobStatus[],
        patch: {
            assignedDriverId: string;
            assignedByStaffId: string;
            assignmentMode: ParkAssignmentMode;
            assignedAt: Date;
            assignmentTimeMs: number | null;
            passengerWaitMs: number | null;
        },
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({ status: ParkJobStatus.ASSIGNED, resolvedAt: patch.assignedAt, ...patch })
            .where('"jobId" = :jobId AND status IN (:...from)', { jobId, from: fromStatuses })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Resolve a live job to a terminal status, only if it is still live. */
    static async resolveIfLive(
        jobId: string,
        status: ParkJobStatus,
        reason: string | null,
        resolvedByStaffId?: string | null,
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({
                status,
                resolvedAt: new Date(),
                resolutionReason: reason ? reason.slice(0, 500) : null,
                ...(resolvedByStaffId ? { claimedByStaffId: resolvedByStaffId } : {}),
            })
            .where('"jobId" = :jobId AND status IN (:...live)', { jobId, live: LIVE_JOB_STATUSES })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Cancel every live job for a ride — the passenger cancelled, or a direct driver won. */
    static async cancelLiveForRide(rideId: string, reason: string): Promise<number> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({ status: ParkJobStatus.CANCELLED, resolvedAt: new Date(), resolutionReason: reason.slice(0, 500) })
            .where('"rideId" = :rideId AND status IN (:...live)', { rideId, live: LIVE_JOB_STATUSES })
            .execute();
        return result.affected ?? 0;
    }

    /**
     * Offer a specific driver the ride, only if the job is still CLAIMED.
     *
     * Conditional so two dispatchers cannot put two drivers on one ride, and so
     * a claim that expired between the dispatcher's tap and this write does not
     * silently resurrect.
     */
    static async offerToDriverIfClaimed(
        jobId: string,
        patch: { pendingDriverId: string; pendingSince: Date; pendingExpiresAt: Date },
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({ status: ParkJobStatus.PENDING_ACCEPTANCE, ...patch })
            .where('"jobId" = :jobId AND status = :expected', { jobId, expected: ParkJobStatus.CLAIMED })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Return a job to the dispatcher after a decline or a timeout.
     *
     * Conditional on the job still being PENDING for THIS driver: a decline
     * arriving after the sweep already timed the offer out must not clobber a
     * fresh offer the dispatcher has since made to somebody else.
     */
    static async returnToClaimedIfPending(
        jobId: string,
        driverId: string,
        declinedDriverIds: string[],
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({
                status: ParkJobStatus.CLAIMED,
                pendingDriverId: null,
                pendingSince: null,
                pendingExpiresAt: null,
                declineCount: () => '"declineCount" + 1',
                declinedDriverIds,
            })
            .where('"jobId" = :jobId AND status = :expected AND "pendingDriverId" = :driverId', {
                jobId, expected: ParkJobStatus.PENDING_ACCEPTANCE, driverId,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** The job a driver currently holds an unanswered offer for, if any. */
    static findPendingForDriver(rideId: string, driverId: string): Promise<ParkDispatchJob | null> {
        return this.repo.findOne({
            where: { rideId, pendingDriverId: driverId, status: ParkJobStatus.PENDING_ACCEPTANCE },
        });
    }

    /** Pending offers whose window has closed. */
    static findExpiredPending(now: Date, limit = 100): Promise<ParkDispatchJob[]> {
        return this.repo.createQueryBuilder('j')
            .where('j.status = :pending', { pending: ParkJobStatus.PENDING_ACCEPTANCE })
            .andWhere('j."pendingExpiresAt" < :now', { now })
            .orderBy('j."pendingExpiresAt"', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * Jobs whose window has elapsed.
     *
     * OFFERED past its offer expiry, or CLAIMED past its assignment deadline.
     * Both are "nobody did the next thing in time" and both free the ride.
     */
    static async findExpired(now: Date, limit = 100): Promise<ParkDispatchJob[]> {
        return this.repo.createQueryBuilder('j')
            .where('j.status = :offered AND j."offerExpiresAt" < :now', { offered: ParkJobStatus.OFFERED, now })
            .orWhere('j.status = :claimed AND j."assignmentDeadlineAt" < :now', { claimed: ParkJobStatus.CLAIMED, now })
            .orderBy('j."offeredAt"', 'ASC')
            .take(limit)
            .getMany();
    }

    static async list(query: JobListQuery): Promise<{ items: ParkDispatchJob[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50)));

        const qb = this.repo.createQueryBuilder('j');
        if (query.parkId) qb.andWhere('j."parkId" = :parkId', { parkId: query.parkId });
        if (query.status) qb.andWhere('j.status = :status', { status: query.status });
        if (query.statuses?.length) qb.andWhere('j.status IN (:...statuses)', { statuses: query.statuses });
        if (query.from) qb.andWhere('j."offeredAt" >= :from', { from: query.from });
        if (query.to) qb.andWhere('j."offeredAt" <= :to', { to: query.to });

        qb.orderBy('j."offeredAt"', 'DESC').skip((page - 1) * pageSize).take(pageSize);
        const [items, total] = await qb.getManyAndCount();
        return { items, total, page, pageSize };
    }

    /**
     * Operational metrics for the monitoring screen.
     *
     * Computed in SQL over the stored interval columns rather than by pulling
     * every job into memory — this runs on a dashboard that refreshes.
     */
    static async metrics(since: Date, parkId?: string): Promise<{
        offered: number;
        claimed: number;
        assigned: number;
        skipped: number;
        rejected: number;
        escalated: number;
        expired: number;
        cancelled: number;
        assignmentSuccessRatePct: number;
        medianResponseTimeMs: number | null;
        medianAssignmentTimeMs: number | null;
        avgPassengerWaitMs: number | null;
    }> {
        const qb = AppDataSource.getRepository(ParkDispatchJob).createQueryBuilder('j')
            .where('j."offeredAt" >= :since', { since });
        if (parkId) qb.andWhere('j."parkId" = :parkId', { parkId });

        const row = await qb
            .select('COUNT(*)', 'offered')
            .addSelect(`COUNT(*) FILTER (WHERE j."claimedAt" IS NOT NULL)`, 'claimed')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'assigned')`, 'assigned')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'skipped')`, 'skipped')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'rejected')`, 'rejected')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'escalated')`, 'escalated')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'expired')`, 'expired')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'cancelled')`, 'cancelled')
            // Median, not mean: one dispatcher who went to lunch would drag a
            // mean response time into meaninglessness.
            .addSelect(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY j."responseTimeMs")`, 'medianResponse')
            .addSelect(`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY j."assignmentTimeMs")`, 'medianAssignment')
            .addSelect(`AVG(j."passengerWaitMs")`, 'avgWait')
            .getRawOne<Record<string, string | null>>();

        const n = (v: string | null | undefined) => (v == null ? 0 : Number(v));
        const offered = n(row?.offered);
        const assigned = n(row?.assigned);

        return {
            offered,
            claimed: n(row?.claimed),
            assigned,
            skipped: n(row?.skipped),
            rejected: n(row?.rejected),
            escalated: n(row?.escalated),
            expired: n(row?.expired),
            cancelled: n(row?.cancelled),
            assignmentSuccessRatePct: offered > 0 ? Math.round((assigned / offered) * 100) : 0,
            medianResponseTimeMs: row?.medianResponse == null ? null : Math.round(Number(row.medianResponse)),
            medianAssignmentTimeMs: row?.medianAssignment == null ? null : Math.round(Number(row.medianAssignment)),
            avgPassengerWaitMs: row?.avgWait == null ? null : Math.round(Number(row.avgWait)),
        };
    }

    /** Per-dispatcher response behaviour, for the supervisor view. */
    static async dispatcherStats(since: Date, parkId?: string) {
        const qb = AppDataSource.getRepository(ParkDispatchJob).createQueryBuilder('j')
            .where('j."claimedByStaffId" IS NOT NULL')
            .andWhere('j."offeredAt" >= :since', { since });
        if (parkId) qb.andWhere('j."parkId" = :parkId', { parkId });

        return qb
            .select('j."claimedByStaffId"', 'staffUserId')
            .addSelect('COUNT(*)', 'claimed')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'assigned')`, 'assigned')
            .addSelect(`COUNT(*) FILTER (WHERE j.status = 'skipped')`, 'skipped')
            .addSelect(`ROUND(AVG(j."responseTimeMs"))`, 'avgResponseMs')
            .groupBy('j."claimedByStaffId"')
            .getRawMany<{ staffUserId: string; claimed: string; assigned: string; skipped: string; avgResponseMs: string | null }>();
    }
}
