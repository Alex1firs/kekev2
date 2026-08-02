/**
 * Dispatcher shifts: who is on duty, where, and since when.
 *
 * Authority at a park is the INTERSECTION of two independent facts:
 *
 *   1. a park-scoped role grant — may this person ever dispatch here;
 *   2. an open shift          — are they working right now.
 *
 * Both are required. A dispatcher with the role but no open shift can look;
 * they cannot act. That separation is what lets "who was on duty at 14:20" be
 * answered from a table rather than inferred backwards from the actions
 * somebody took, which is exactly the reasoning an investigation cannot rely on.
 *
 * Multiple dispatchers may be on duty at one park simultaneously. The pilot has
 * one, but nothing here assumes it — the constraint enforced is the one that is
 * genuinely true, that a PERSON cannot be in two places, not that a park has
 * one dispatcher.
 */
import { DispatcherShift, DispatcherShiftStatus, ShiftEndActor } from '../models/DispatcherShift';
import { Park, ParkStatus } from '../models/Park';
import { StaffUser } from '../models/StaffUser';
import { AppDataSource } from '../config/data_source';
import { DispatcherShiftRepository } from '../repositories/dispatcher_shift_repository';
import { ParkRepository } from '../repositories/park_repository';
import { ParkDispatchJob } from '../models/ParkDispatchJob';
import { ParkService } from './park_service';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';
import { haversineMeters } from './ride_integrity_service';
import { StaffPushService } from './staff_push_service';
import { staffHoldsParkRole } from '../middleware/park_scope';
import { StaffRole } from '../config/staff_permissions';

export const ShiftAuditAction = {
    SHIFT_OPENED: 'SHIFT_OPENED',
    SHIFT_CLOSED: 'SHIFT_CLOSED',
    SHIFT_FORCE_CLOSED: 'SHIFT_FORCE_CLOSED',
} as const;

export interface ShiftDto {
    shiftId: string;
    parkId: string;
    parkName?: string | null;
    parkCode?: string | null;
    staffUserId: string;
    staffName?: string | null;
    deviceId: string | null;
    status: DispatcherShiftStatus;
    startedAt: Date;
    startLocationVerified: boolean;
    startDistanceM: number | null;
    endedAt: Date | null;
    endedBy: ShiftEndActor | null;
    endReason: string | null;
    handoverNotes: string | null;
    durationMinutes: number;
    requestsReceived: number;
    assignmentsMade: number;
}

/** What a dispatcher is shown before they sign off. */
export interface ShiftSummary {
    shiftId: string;
    parkId: string;
    startedAt: Date;
    durationMinutes: number;

    assigned: number;
    skipped: number;
    rejected: number;
    escalated: number;
    expired: number;
    /** Mean offer-to-claim across this shift's requests. */
    avgResponseSeconds: number | null;

    /** Live requests this dispatcher still holds. Blocks a quiet sign-off. */
    myUnresolved: number;
    /** Live requests anywhere at this park, held by anyone. */
    parkUnresolved: number;
    unresolved: Array<{ jobId: string; rideId: string; status: string; claimedAt: Date | null }>;
}

export class DispatcherShiftService {
    static toDto(shift: DispatcherShift, extras: { parkName?: string | null; parkCode?: string | null; staffName?: string | null } = {}): ShiftDto {
        const started = shift.startedAt instanceof Date ? shift.startedAt : new Date(shift.startedAt);
        const ended = shift.endedAt ? (shift.endedAt instanceof Date ? shift.endedAt : new Date(shift.endedAt)) : null;
        return {
            shiftId: shift.shiftId,
            parkId: shift.parkId,
            parkName: extras.parkName ?? null,
            parkCode: extras.parkCode ?? null,
            staffUserId: shift.staffUserId,
            staffName: extras.staffName ?? null,
            deviceId: shift.deviceId,
            status: shift.status,
            startedAt: started,
            startLocationVerified: shift.startLocationVerified,
            startDistanceM: shift.startDistanceM,
            endedAt: ended,
            endedBy: shift.endedBy,
            endReason: shift.endReason,
            handoverNotes: shift.handoverNotes,
            durationMinutes: Math.max(0, Math.round(((ended ?? new Date()).getTime() - started.getTime()) / 60_000)),
            requestsReceived: shift.requestsReceived,
            assignmentsMade: shift.assignmentsMade,
        };
    }

    /**
     * Open a shift.
     *
     * Location is CHECKED but never blocking. A GPS fix taken inside a
     * corrugated-roof park at six in the morning is unreliable, and refusing to
     * let somebody start work over it would cause far more harm than the risk
     * it mitigates. The distance and the verdict are recorded, surfaced to
     * supervisors, and reportable — which is the proportionate control.
     */
    static async open(
        actor: AuditActor,
        input: { parkId: string; lat?: number | null; lng?: number | null; deviceId?: string | null },
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ShiftDto> {
        const park = await ParkService.requirePark(input.parkId);

        if (park.status !== ParkStatus.ACTIVE) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `This park is ${park.status}. A shift can only be opened at an active park.`);
        }

        // The person must be allowed to work here at all.
        const permitted = await staffHoldsParkRole(actor.staffUserId, park.parkId, [
            StaffRole.PARK_DISPATCHER, StaffRole.PARK_SUPERVISOR,
        ]);
        if (!permitted) {
            throw new AppError(403, ErrorCode.FORBIDDEN,
                'You are not assigned to this park. Ask operations to assign you before opening a shift.');
        }

        // One open shift per person, anywhere. Checked here for a clear message;
        // the partial unique index in the database is what actually guarantees
        // it under concurrency.
        const existing = await DispatcherShiftRepository.findOpenForStaff(actor.staffUserId);
        if (existing) {
            const samePark = existing.parkId === park.parkId;
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, samePark
                ? 'You already have an open shift at this park.'
                : 'You already have an open shift at another park. Close it before opening a new one.');
        }

        let distanceM: number | null = null;
        let verified = false;
        if (Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng))) {
            distanceM = haversineMeters(
                { lat: Number(input.lat), lng: Number(input.lng) },
                { lat: Number(park.lat), lng: Number(park.lng) },
            );
            verified = distanceM <= park.operatingRadiusM;
        }

        let shift: DispatcherShift;
        try {
            shift = await DispatcherShiftRepository.save(DispatcherShiftRepository.create({
                parkId: park.parkId,
                staffUserId: actor.staffUserId,
                deviceId: input.deviceId ?? null,
                status: DispatcherShiftStatus.OPEN,
                startedAt: new Date(),
                startLat: Number.isFinite(Number(input.lat)) ? Number(input.lat) : null,
                startLng: Number.isFinite(Number(input.lng)) ? Number(input.lng) : null,
                startDistanceM: distanceM,
                startLocationVerified: verified,
            }));
        } catch (err: any) {
            // The unique index fired: a concurrent request opened one first.
            if (String(err?.message ?? '').includes('UQ_shift_one_open_per_dispatcher')) {
                throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'You already have an open shift.');
            }
            throw err;
        }

        await AuditService.recordCritical({
            actor,
            action: ShiftAuditAction.SHIFT_OPENED,
            resourceType: 'DISPATCHER_SHIFT',
            resourceId: shift.shiftId,
            parkId: park.parkId,
            // Opening creates a shift; there was no prior state to record.
            previousValue: null,
            newValue: 'open',
            deviceId: input.deviceId ?? null,
            metadata: {
                startDistanceM: distanceM == null ? null : Math.round(distanceM),
                startLocationVerified: verified,
                operatingRadiusM: park.operatingRadiusM,
            },
            ...ctx,
        });

        return this.toDto(shift, { parkName: park.name, parkCode: park.code });
    }

    /**
     * What this shift did, and what it is about to leave behind.
     *
     * Read-only, so a dispatcher can be shown the consequences of signing off
     * BEFORE they sign off rather than after.
     */
    static async summary(staffUserId: string): Promise<ShiftSummary> {
        const shift = await DispatcherShiftRepository.findOpenForStaff(staffUserId);
        if (!shift) throw new AppError(404, ErrorCode.NOT_FOUND, 'You do not have an open shift.');

        const since = new Date(shift.startedAt);
        const jobs = AppDataSource.getRepository(ParkDispatchJob);

        const [mine, live] = await Promise.all([
            jobs.createQueryBuilder('j')
                .select('j.status', 'status')
                .addSelect('COUNT(*)', 'count')
                .addSelect('AVG(j."responseTimeMs")', 'avgResponseMs')
                .where('j."claimedByStaffId" = :staffUserId', { staffUserId })
                .andWhere('j."claimedAt" >= :since', { since })
                .groupBy('j.status')
                .getRawMany<{ status: string; count: string; avgResponseMs: string | null }>(),

            // Everything still live at this park — not only this dispatcher's.
            // Signing off with somebody else's unclaimed request on the board
            // is still leaving a passenger waiting if nobody else is on duty.
            jobs.createQueryBuilder('j')
                .where('j."parkId" = :parkId', { parkId: shift.parkId })
                .andWhere('j.status IN (:...live)', { live: ['offered', 'claimed', 'pending_acceptance'] })
                .getMany(),
        ]);

        const countOf = (status: string) => Number(mine.find((m) => m.status === status)?.count ?? 0);
        const responses = mine.map((m) => Number(m.avgResponseMs)).filter((n) => Number.isFinite(n) && n > 0);

        const minesLive = live.filter((j) => j.claimedByStaffId === staffUserId);

        return {
            shiftId: shift.shiftId,
            parkId: shift.parkId,
            startedAt: shift.startedAt,
            durationMinutes: Math.round((Date.now() - new Date(shift.startedAt).getTime()) / 60_000),

            assigned: countOf('assigned'),
            skipped: countOf('skipped'),
            rejected: countOf('rejected'),
            escalated: countOf('escalated'),
            expired: countOf('expired'),
            avgResponseSeconds: responses.length
                ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length / 1000)
                : null,

            /*
             * The two numbers that decide whether this shift may simply end.
             * `myUnresolved` is work this dispatcher took responsibility for
             * and has not finished; `parkUnresolved` is everything still live
             * at the park, which matters when nobody else is on duty.
             */
            myUnresolved: minesLive.length,
            parkUnresolved: live.length,
            unresolved: minesLive.map((j) => ({
                jobId: j.jobId,
                rideId: j.rideId,
                status: j.status,
                claimedAt: j.claimedAt,
            })),
        };
    }

    /**
     * Close one's own shift.
     *
     * Refuses while this dispatcher still holds live requests, unless they
     * explicitly hand over. A shift that ends quietly with a claimed request
     * still on the board leaves a passenger waiting on somebody who has gone
     * home — the job would eventually expire, but "eventually" is measured in
     * a passenger's patience.
     *
     * `handoverNotes` is what makes it deliberate: state who is taking over, or
     * release the requests first.
     */
    static async close(
        actor: AuditActor,
        input: { handoverNotes?: string | null; force?: boolean },
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ShiftDto> {
        const shift = await DispatcherShiftRepository.findOpenForStaff(actor.staffUserId);
        if (!shift) throw new AppError(404, ErrorCode.NOT_FOUND, 'You do not have an open shift.');

        const summary = await this.summary(actor.staffUserId);
        if (summary.myUnresolved > 0 && !input.handoverNotes?.trim() && !input.force) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                summary.myUnresolved === 1
                    ? 'You still have 1 request in hand. Finish or release it, or write a handover note saying who is taking it.'
                    : `You still have ${summary.myUnresolved} requests in hand. `
                        + 'Finish or release them, or write a handover note saying who is taking them.');
        }

        const closed = await DispatcherShiftRepository.closeIfOpen(shift.shiftId, {
            endedAt: new Date(),
            endedBy: ShiftEndActor.DISPATCHER,
            endedByStaffId: actor.staffUserId,
            handoverNotes: input.handoverNotes?.slice(0, 1000) ?? null,
        });
        if (!closed) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'That shift was already closed.');
        }

        await AuditService.record({
            actor,
            action: ShiftAuditAction.SHIFT_CLOSED,
            resourceType: 'DISPATCHER_SHIFT',
            resourceId: shift.shiftId,
            parkId: shift.parkId,
            previousValue: 'open',
            newValue: 'closed',
            metadata: {
                durationMinutes: Math.round((Date.now() - new Date(shift.startedAt).getTime()) / 60_000),
                // Recorded so a shift handed over with work outstanding is
                // visible later, not just at the moment it happened.
                unresolvedAtClose: summary.myUnresolved,
                assigned: summary.assigned,
            },
            ...ctx,
        });

        const fresh = await DispatcherShiftRepository.findById(shift.shiftId);
        /*
         * Unbind this dispatcher's devices from the park.
         *
         * Push is addressed by park, so a device left bound after the shift
         * ends keeps alerting somebody who has gone home — and worse, keeps
         * them alerted about a park they are no longer responsible for.
         */
        await StaffPushService.revoke({
            staffUserId: actor.staffUserId, reason: 'shift closed',
        }).catch(() => { /* the close stands regardless */ });

        return this.toDto(fresh!);
    }

    /**
     * Close somebody else's shift.
     *
     * A supervisor recovering from a dispatcher who left without signing off, or
     * whose device died. Requires a reason and is audited critically, because
     * force-closing somebody's shift changes the record of who was accountable
     * for a stretch of time.
     */
    static async forceClose(
        actor: AuditActor,
        shiftId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<ShiftDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to close another dispatcher\'s shift.');
        }
        const shift = await DispatcherShiftRepository.findById(shiftId);
        if (!shift) throw new AppError(404, ErrorCode.NOT_FOUND, 'Shift not found.');
        if (shift.status !== DispatcherShiftStatus.OPEN) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'That shift is not open.');
        }

        const closed = await DispatcherShiftRepository.closeIfOpen(shiftId, {
            endedAt: new Date(),
            endedBy: ShiftEndActor.SUPERVISOR,
            endedByStaffId: actor.staffUserId,
            endReason: reason.trim().slice(0, 500),
        });
        if (!closed) throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'That shift was already closed.');

        await AuditService.recordCritical({
            actor,
            action: ShiftAuditAction.SHIFT_FORCE_CLOSED,
            resourceType: 'DISPATCHER_SHIFT',
            previousValue: 'open',
            newValue: 'force_closed',
            resourceId: shiftId,
            parkId: shift.parkId,
            reason: reason.trim(),
            metadata: { closedStaffUserId: shift.staffUserId },
            ...ctx,
        });

        const fresh = await DispatcherShiftRepository.findById(shiftId);
        return this.toDto(fresh!);
    }

    /** The caller's open shift, if they have one. */
    static async current(staffUserId: string): Promise<ShiftDto | null> {
        const shift = await DispatcherShiftRepository.findOpenForStaff(staffUserId);
        if (!shift) return null;
        const park = await ParkRepository.findById(shift.parkId);
        return this.toDto(shift, { parkName: park?.name ?? null, parkCode: park?.code ?? null });
    }

    /** Everyone on duty at a park right now. */
    static async onDuty(parkId: string): Promise<ShiftDto[]> {
        const shifts = await DispatcherShiftRepository.findOpenAtPark(parkId);
        return this.decorate(shifts);
    }

    /** Everyone on duty anywhere, for the operations overview. */
    static async allOnDuty(): Promise<ShiftDto[]> {
        return this.decorate(await DispatcherShiftRepository.findAllOpen());
    }

    static async list(query: Parameters<typeof DispatcherShiftRepository.list>[0]) {
        const result = await DispatcherShiftRepository.list(query);
        return { ...result, items: await this.decorate(result.items) };
    }

    static statsForPark(parkId: string, since: Date) {
        return DispatcherShiftRepository.statsForPark(parkId, since);
    }

    /** Attach park and staff names in two queries, not two per shift. */
    private static async decorate(shifts: DispatcherShift[]): Promise<ShiftDto[]> {
        if (shifts.length === 0) return [];
        const parkIds = [...new Set(shifts.map((s) => s.parkId))];
        const staffIds = [...new Set(shifts.map((s) => s.staffUserId))];

        const [parks, staff] = await Promise.all([
            AppDataSource.getRepository(Park).createQueryBuilder('p')
                .where('p."parkId" IN (:...parkIds)', { parkIds }).getMany(),
            AppDataSource.getRepository(StaffUser).createQueryBuilder('s')
                .where('s.id IN (:...staffIds)', { staffIds }).getMany(),
        ]);
        const parkBy = new Map(parks.map((p) => [p.parkId, p]));
        const staffBy = new Map(staff.map((s) => [s.id, s]));

        return shifts.map((s) => this.toDto(s, {
            parkName: parkBy.get(s.parkId)?.name ?? null,
            parkCode: parkBy.get(s.parkId)?.code ?? null,
            staffName: staffBy.get(s.staffUserId)
                ? `${staffBy.get(s.staffUserId)!.firstName} ${staffBy.get(s.staffUserId)!.lastName}`
                : null,
        }));
    }
}
