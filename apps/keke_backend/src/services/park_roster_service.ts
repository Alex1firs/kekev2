/**
 * Park driver rosters and the park queue.
 *
 * Three distinct concepts live here and are deliberately never merged:
 *
 *   MEMBERSHIP  this driver works out of this park. Durable, survives them
 *               going home for a week.
 *   PRESENCE    where they are right now. Owned by DriverPresenceService.
 *   QUEUE       who is next. An explicit ordering a supervisor can correct.
 *
 * Systems that collapse these become unusable within a month: a driver goes for
 * fuel and either loses their place in the queue (unfair) or keeps it while
 * appearing available (wrong). Keeping them separate is what lets a driver step
 * out of the queue without leaving the roster, and be at the park without
 * being available.
 */
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { DriverProfile, DriverStatus } from '../models/DriverProfile';
import { AppDataSource } from '../config/data_source';
import { ParkRosterRepository, RosterEntry } from '../repositories/park_roster_repository';
import { ParkService } from './park_service';
import { DriverPresenceService } from './driver_presence_service';
import { DriverPresenceState, PresenceSource } from '../models/DriverPresence';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';
import { DEBT_CASH_BLOCK } from './wallet_service';

export const RosterAuditAction = {
    ROSTER_DRIVER_ADDED: 'ROSTER_DRIVER_ADDED',
    ROSTER_DRIVER_REMOVED: 'ROSTER_DRIVER_REMOVED',
    ROSTER_DRIVER_SUSPENDED: 'ROSTER_DRIVER_SUSPENDED',
    ROSTER_DRIVER_REINSTATED: 'ROSTER_DRIVER_REINSTATED',
    ROSTER_QUEUE_JOINED: 'ROSTER_QUEUE_JOINED',
    ROSTER_QUEUE_LEFT: 'ROSTER_QUEUE_LEFT',
    ROSTER_QUEUE_REORDERED: 'ROSTER_QUEUE_REORDERED',
    ROSTER_DRIVER_SKIPPED: 'ROSTER_DRIVER_SKIPPED',
} as const;

/** Why a driver cannot currently be given work. Empty means they can. */
export interface AssignabilityProblem {
    code: string;
    message: string;
}

export class ParkRosterService {
    // ── reads ───────────────────────────────────────────────────────────

    static async view(parkId: string, opts: { status?: RosterStatus; queuedOnly?: boolean; search?: string } = {}): Promise<RosterEntry[]> {
        await ParkService.requirePark(parkId);
        return ParkRosterRepository.loadRosterView(
            { parkId, status: opts.status, queuedOnly: opts.queuedOnly, search: opts.search },
            DEBT_CASH_BLOCK,
        );
    }

    /**
     * The queue, in order, annotated with why each driver can or cannot take work.
     *
     * The annotation is the point. A dispatcher looking at position 1 needs to
     * know immediately that this driver is wallet-blocked, so they can send them
     * to the cashier instead of discovering it at the moment of assignment with
     * a passenger waiting.
     */
    static async queue(parkId: string): Promise<Array<RosterEntry & { assignable: boolean; problems: AssignabilityProblem[] }>> {
        const entries = await this.view(parkId, { queuedOnly: true });
        return entries.map((e) => {
            const problems = this.assignabilityProblems(e);
            return { ...e, assignable: problems.length === 0, problems };
        });
    }

    /**
     * Whether this roster entry could be given a ride right now.
     *
     * Phase 2 only REPORTS this. Nothing assigns yet — the actual assignment
     * path arrives in Phase 4 and will apply DriverEligibilityService, which
     * remains the single definition of dispatch eligibility. The checks here
     * are the operational ones a dispatcher can see and act on, and they are
     * deliberately a superset that never contradicts it.
     */
    static assignabilityProblems(entry: RosterEntry): AssignabilityProblem[] {
        const problems: AssignabilityProblem[] = [];

        if (entry.status === RosterStatus.SUSPENDED) {
            problems.push({ code: 'roster_suspended', message: entry.suspensionReason || 'Suspended from this park roster' });
        }
        if (entry.driverStatus === DriverStatus.SUSPENDED || entry.driverStatus === DriverStatus.REJECTED) {
            problems.push({ code: 'driver_suspended', message: 'Driver account is suspended or rejected' });
        }
        if (entry.driverStatus !== DriverStatus.APPROVED) {
            problems.push({ code: 'driver_not_approved', message: `Driver KYC is ${entry.driverStatus}` });
        }
        if (entry.walletBlocked) {
            problems.push({
                code: 'wallet_blocked',
                message: `Owes ₦${entry.commissionDebt.toLocaleString()} — must pay before taking a cash ride`,
            });
        }
        if (!entry.badgeSerial) {
            problems.push({ code: 'no_badge', message: 'No badge issued' });
        }
        if (entry.presenceState && ![DriverPresenceState.WAITING, DriverPresenceState.AT_PARK].includes(entry.presenceState)) {
            problems.push({ code: 'not_waiting', message: `Currently ${entry.presenceState.replace(/_/g, ' ')}` });
        }
        if (!entry.presenceState) {
            problems.push({ code: 'presence_unknown', message: 'Presence not recorded' });
        }
        return problems;
    }

    // ── membership ──────────────────────────────────────────────────────

    static async addDriver(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<RosterEntry> {
        await ParkService.requirePark(parkId);

        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId });
        if (!profile) throw new AppError(404, ErrorCode.PROFILE_NOT_FOUND, 'Driver not found.');
        if (profile.status === DriverStatus.REJECTED) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A rejected driver cannot be added to a roster.');
        }

        const existing = await ParkRosterRepository.findMembership(parkId, driverId);
        if (existing) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'This driver is already on the roster.');
        }

        await ParkRosterRepository.save(ParkRosterRepository.create({
            parkId,
            driverId,
            status: RosterStatus.ACTIVE,
            joinedAt: new Date(),
            addedByStaffId: actor.staffUserId,
        }));

        await AuditService.recordCritical({
            actor,
            action: RosterAuditAction.ROSTER_DRIVER_ADDED,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            metadata: { driverStatus: profile.status, deviceCapability: profile.deviceCapability },
            ...ctx,
        });

        const view = await this.view(parkId, {});
        return view.find((e) => e.driverId === driverId)!;
    }

    static async removeDriver(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        reason: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<void> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to remove a driver from a roster.');
        }
        const membership = await this.requireMembership(parkId, driverId);

        membership.status = RosterStatus.REMOVED;
        membership.removedAt = new Date();
        membership.removedByStaffId = actor.staffUserId;
        membership.removeReason = reason.trim().slice(0, 500);
        membership.queuePosition = null;
        membership.queuedAt = null;
        await ParkRosterRepository.save(membership);
        await ParkRosterRepository.compactQueue(parkId);

        await AuditService.recordCritical({
            actor,
            action: RosterAuditAction.ROSTER_DRIVER_REMOVED,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            reason: reason.trim(),
            ...ctx,
        });
    }

    static async setSuspended(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        suspended: boolean,
        reason: string | null,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<void> {
        if (suspended && !reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to suspend a driver on a roster.');
        }
        const membership = await this.requireMembership(parkId, driverId);

        membership.status = suspended ? RosterStatus.SUSPENDED : RosterStatus.ACTIVE;
        membership.suspensionReason = suspended ? reason!.trim().slice(0, 500) : null;
        if (suspended) {
            // A suspended driver leaves the queue: leaving them in it would put
            // an unassignable driver at the front of a dispatcher's screen.
            membership.queuePosition = null;
            membership.queuedAt = null;
        }
        await ParkRosterRepository.save(membership);
        if (suspended) await ParkRosterRepository.compactQueue(parkId);

        await AuditService.recordCritical({
            actor,
            action: suspended ? RosterAuditAction.ROSTER_DRIVER_SUSPENDED : RosterAuditAction.ROSTER_DRIVER_REINSTATED,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            reason: reason?.trim() || (suspended ? undefined : 'reinstated'),
            ...ctx,
        });
    }

    // ── queue ───────────────────────────────────────────────────────────

    /**
     * Put a driver in the queue, at the back.
     *
     * Also moves their presence to WAITING, because joining a park's queue IS
     * the operational act of becoming available there — recording one without
     * the other produces a roster and a presence board that disagree, and a
     * dispatcher who has to guess which is right.
     */
    static async joinQueue(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<{ queuePosition: number }> {
        const membership = await this.requireMembership(parkId, driverId);
        if (membership.status !== RosterStatus.ACTIVE) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'A suspended driver cannot join the queue.');
        }
        if (membership.queuePosition != null) {
            return { queuePosition: membership.queuePosition };
        }

        const position = (await ParkRosterRepository.maxQueuePosition(parkId)) + 1;
        membership.queuePosition = position;
        membership.queuedAt = new Date();
        await ParkRosterRepository.save(membership);

        await DriverPresenceService.setState({
            driverId,
            state: DriverPresenceState.WAITING,
            parkId,
            source: PresenceSource.DISPATCHER,
            setByStaffId: actor.staffUserId,
        }, { actor, ipAddress: ctx.ipAddress, correlationId: ctx.correlationId });

        await AuditService.record({
            actor,
            action: RosterAuditAction.ROSTER_QUEUE_JOINED,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            metadata: { queuePosition: position },
            ...ctx,
        });

        return { queuePosition: position };
    }

    /**
     * Take a driver out of the queue.
     *
     * Presence becomes AT_PARK, not OFFLINE: they are still standing there, they
     * just are not next. Claiming they had gone home would be a lie the
     * dispatcher can see through by looking up.
     */
    static async leaveQueue(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        reason: string | null,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<void> {
        const membership = await this.requireMembership(parkId, driverId);
        if (membership.queuePosition == null) return;

        membership.queuePosition = null;
        membership.queuedAt = null;
        await ParkRosterRepository.save(membership);
        await ParkRosterRepository.compactQueue(parkId);

        await DriverPresenceService.setState({
            driverId,
            state: DriverPresenceState.AT_PARK,
            parkId,
            source: PresenceSource.DISPATCHER,
            setByStaffId: actor.staffUserId,
            note: reason ?? null,
        }, { actor, ipAddress: ctx.ipAddress, correlationId: ctx.correlationId });

        await AuditService.record({
            actor,
            action: RosterAuditAction.ROSTER_QUEUE_LEFT,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            reason: reason ?? null,
            ...ctx,
        });
    }

    /**
     * Record that a driver was passed over, WITH a reason.
     *
     * The skip counter is the raw material for bias detection: a dispatcher who
     * skips the same person repeatedly is visible in the data rather than only
     * in complaints. The driver keeps their position, because a skip is usually
     * a system-side fact (wallet blocked, wrong vehicle) and punishing them for
     * it would compound the unfairness.
     */
    static async recordSkip(
        actor: AuditActor,
        parkId: string,
        driverId: string,
        reason: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<void> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to skip a driver.');
        }
        const membership = await this.requireMembership(parkId, driverId);
        membership.skipCount += 1;
        await ParkRosterRepository.save(membership);

        await AuditService.recordCritical({
            actor,
            action: RosterAuditAction.ROSTER_DRIVER_SKIPPED,
            resourceType: 'PARK_ROSTER',
            resourceId: `${parkId}:${driverId}`,
            parkId,
            driverId,
            reason: reason.trim(),
            metadata: { skipCount: membership.skipCount, queuePosition: membership.queuePosition },
            ...ctx,
        });
    }

    static async reorderQueue(
        actor: AuditActor,
        parkId: string,
        orderedRosterIds: string[],
        reason: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<void> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to reorder the queue.');
        }
        const current = await ParkRosterRepository.findQueue(parkId);
        const currentIds = new Set(current.map((c) => c.id));

        // The new order must be a permutation of the current queue. Accepting a
        // partial list would silently drop whoever was omitted.
        if (orderedRosterIds.length !== currentIds.size || !orderedRosterIds.every((id) => currentIds.has(id))) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'The new order must contain exactly the drivers currently in the queue.');
        }

        await ParkRosterRepository.reorderQueue(parkId, orderedRosterIds);
        await AuditService.recordCritical({
            actor,
            action: RosterAuditAction.ROSTER_QUEUE_REORDERED,
            resourceType: 'PARK_ROSTER',
            resourceId: parkId,
            parkId,
            reason: reason.trim(),
            metadata: { size: orderedRosterIds.length },
            ...ctx,
        });
    }

    private static async requireMembership(parkId: string, driverId: string): Promise<ParkDriverRoster> {
        const membership = await ParkRosterRepository.findMembership(parkId, driverId);
        if (!membership) throw new AppError(404, ErrorCode.NOT_FOUND, 'This driver is not on the roster.');
        return membership;
    }
}
