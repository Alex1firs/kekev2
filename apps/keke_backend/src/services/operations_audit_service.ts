/**
 * Durable record of Operations acts, written twice on purpose.
 *
 *   1. `operations_intervention` — the queryable table. "How many rides did
 *      Operations rescue last week, and which dispatcher?" is a GROUP BY here.
 *   2. `dispatch_event` — the ride's narrative timeline, so an investigator
 *      opening a ride sees "no driver accepted → Ada took control → Ada rang
 *      Emeka → Emeka assigned" as ONE story rather than two systems.
 *
 * Neither write may fail an operation. An audit outage must not stop a
 * dispatcher assigning a Keke to a passenger standing in the rain — the act
 * has already happened in the authoritative table by the time we get here.
 */
import { AppDataSource } from '../config/data_source';
import { OperationsIntervention, InterventionType } from '../models/OperationsIntervention';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { DispatchEventType } from '../models/DispatchEvent';

export interface InterventionRecord {
    type: InterventionType;
    rideId: string;
    staffUserId: string | null;
    staffLabel: string | null;
    reason?: string | null;
    driverId?: string | null;
    priorRideStatus?: string | null;
    priorControlMode?: string | null;
    outcome?: string | null;
    outcomeCode?: string | null;
    detail?: Record<string, unknown> | null;
}

/**
 * Which intervention types earn a place on the ride timeline.
 *
 * Renewals deliberately do not: a three-minute lease renewed for a ten-minute
 * call would add twenty rows saying nothing happened, and bury the four that
 * matter. They are still written to the intervention table, where they are
 * evidence that control was continuously held.
 */
const TIMELINE_EVENT: Partial<Record<InterventionType, DispatchEventType>> = {
    [InterventionType.TAKEOVER_CLAIMED]: DispatchEventType.OPS_TAKEOVER_CLAIMED,
    [InterventionType.TAKEOVER_RELEASED]: DispatchEventType.OPS_TAKEOVER_RELEASED,
    [InterventionType.CONTROL_EXPIRED]: DispatchEventType.OPS_CONTROL_EXPIRED,
    [InterventionType.DRIVER_CONTACTED]: DispatchEventType.OPS_DRIVER_CONTACTED,
    [InterventionType.DRIVER_ASSIGNED]: DispatchEventType.OPS_DRIVER_ASSIGNED,
    [InterventionType.ASSIGNMENT_FAILED]: DispatchEventType.OPS_ASSIGNMENT_FAILED,
    [InterventionType.DRIVER_RELEASED]: DispatchEventType.OPS_DRIVER_RELEASED,
};

export class OperationsAuditService {
    /** Fire-and-forget. Never throws, never blocks the caller. */
    static record(r: InterventionRecord): Promise<void> {
        return this.recordAsync(r).catch((err: any) => {
            console.warn(`[OPS_AUDIT] failed to record ${r.type}: ${err?.message}`);
        });
    }

    static async recordAsync(r: InterventionRecord): Promise<void> {
        try {
            if (AppDataSource.isInitialized) {
                const repo = AppDataSource.getRepository(OperationsIntervention);
                await repo.save(
                    repo.create({
                        rideId: r.rideId,
                        type: r.type,
                        staffUserId: r.staffUserId ?? null,
                        staffLabel: r.staffLabel ?? null,
                        reason: r.reason ?? null,
                        driverId: r.driverId ?? null,
                        priorRideStatus: r.priorRideStatus ?? null,
                        priorControlMode: r.priorControlMode ?? null,
                        outcome: r.outcome ?? null,
                        outcomeCode: r.outcomeCode ?? null,
                        detail: r.detail ?? null,
                    }),
                );
            }
        } catch (err: any) {
            console.warn(`[OPS_AUDIT] intervention insert failed (${r.type}): ${err?.message}`);
        }

        const eventType = TIMELINE_EVENT[r.type];
        if (!eventType) return;

        // The timeline carries the staff LABEL, not the id, and never a phone
        // or a passenger name — same rule as every other dispatch_event.
        DispatchMonitorService.record({
            rideId: r.rideId,
            eventType,
            driverId: r.driverId ?? null,
            detail: {
                staffLabel: r.staffLabel ?? null,
                reason: r.reason ?? null,
                outcome: r.outcome ?? null,
                outcomeCode: r.outcomeCode ?? null,
                ...(r.detail ?? {}),
            },
        });
    }

    /** Intervention history for one ride, oldest first. */
    static async forRide(rideId: string): Promise<OperationsIntervention[]> {
        return AppDataSource.getRepository(OperationsIntervention).find({
            where: { rideId },
            order: { createdAt: 'ASC' },
        });
    }
}
