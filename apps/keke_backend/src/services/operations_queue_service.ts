/**
 * The live Operations queue, and the judgement of which rides need a human.
 *
 * ── Derived, never manufactured ──────────────────────────────────────────
 * Every field here comes from something that was actually recorded: the ride
 * row, the persisted dispatch trail, live presence, and the control row. Where
 * evidence does not exist the field is null and the UI says so. A dispatcher
 * deciding whether to ring a driver must be able to trust that "0 eligible"
 * means the system looked and found none — not that nobody has looked yet.
 *
 * ── NEEDS ATTENTION ──────────────────────────────────────────────────────
 * The point of the queue is that nobody should have to open twenty rides to
 * find the one going wrong. Attention state is computed from the same evidence
 * an investigator would read, with thresholds in config so the rollout can be
 * noisy now and quiet later without an app release.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Ride, RideStatus } from '../models/Ride';
import { DispatchMonitorQueryService, LIVE_RIDE_STATUSES, maskName, maskPhone } from './dispatch_monitor_query_service';
import { RideControlService } from './ride_control_service';
import { DispatchControlMode } from '../models/RideDispatchControl';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';
import { outcomeLabel, classifyOutcome, RideOutcomeCode, resolveAreaLine } from './ride_outcome';
import { areaOf } from './dispatch_monitor_query_service';
import { ServiceZoneService } from './service_zone_service';
import { coverageOf, ZoneCoverage } from './service_zone_policy';

/** What the queue says about a ride at a glance. */
export type QueueState =
    | 'AUTO_HEALTHY'
    | 'NEEDS_ATTENTION'
    | 'OPERATIONS_CONTROL'
    | 'ASSIGNED'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'FAILED';

/** Why a ride needs a human. Stable codes; the UI translates them. */
export type AttentionTrigger =
    | 'NO_ELIGIBLE_DRIVER'
    | 'NO_DRIVER_ACCEPTED'
    | 'WAIT_EXCEEDS_THRESHOLD'
    | 'TECHNICAL_FAILURE'
    | 'DISPATCH_EXHAUSTED';

export type AttentionSeverity = 'none' | 'warning' | 'urgent';

export interface QueueRow {
    rideId: string;
    requestedAt: string;
    waitingSeconds: number;
    status: string;
    queueState: QueueState;
    attention: { triggers: AttentionTrigger[]; severity: AttentionSeverity };

    passenger: { id: string; name: string; phoneMasked: string | null } | null;
    /** Which city this ride belongs to. Null for rides created before zones. */
    zoneCode: string | null;
    /**
     * The human name of that city — "Onitsha", "Awka".
     *
     * Served from the zone table rather than mapped in the console, so a third
     * city needs a row and not a front-end release. Null when the ride has no
     * zone, or names one that is no longer operational.
     */
    zoneName: string | null;
    /**
     * in_zone · out_of_coverage · unresolved.
     *
     * The distinction an operator has to be able to make at a glance:
     * "this pickup is outside every active service area" is a different
     * situation from "this ride predates zones and we never classified it".
     */
    zoneCoverage: ZoneCoverage;
    pickupAddress: string | null;
    pickupArea: string | null;
    destinationAddress: string | null;
    destinationArea: string | null;
    fare: number | null;
    paymentMode: string | null;

    dispatchRound: number | null;
    radiusKm: number | null;
    candidateCount: number;
    eligibleDriverCount: number;
    offersSent: number;
    rejected: number;
    expired: number;
    acknowledged: number;
    accepted: boolean;
    finalOutcomeCode: string | null;

    outcomeReason: string | null;
    outcomeLabel: string | null;

    driver: { id: string; name: string; phoneMasked: string | null } | null;

    control: {
        mode: string;
        ownerStaffId: string | null;
        ownerLabel: string | null;
        leaseExpiresAt: string | null;
        version: number;
    };
}

export class OperationsQueueService {
    /**
     * The live queue: everything currently in flight, newest first, plus
     * rides that ended very recently so a dispatcher sees the outcome of what
     * they were just watching rather than it vanishing.
     */
    static async liveQueue(opts: { includeRecentMinutes?: number; limit?: number } = {}): Promise<{
        rows: QueueRow[];
        counts: Record<QueueState, number>;
        generatedAt: string;
    }> {
        const config = loadOperationsDispatchConfig();
        const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
        const recentMs = (opts.includeRecentMinutes ?? 10) * 60_000;
        const now = new Date();

        const repo = AppDataSource.getRepository(Ride);
        const rides = await repo
            .createQueryBuilder('r')
            .where('r.status IN (:...live)', { live: LIVE_RIDE_STATUSES })
            .orWhere('r."updatedAt" >= :since', { since: new Date(now.getTime() - recentMs) })
            .orderBy('r."createdAt"', 'DESC')
            .take(limit)
            .getMany();

        if (rides.length === 0) {
            return { rows: [], counts: this.emptyCounts(), generatedAt: now.toISOString() };
        }

        const ids = rides.map((r) => r.rideId);
        const [rollups, people, controls, zones] = await Promise.all([
            DispatchMonitorQueryService.rollupsFor(ids),
            DispatchMonitorQueryService.peopleFor(rides),
            RideControlService.getMany(ids),
            // Cached for 60s in-process; one load for the whole queue.
            ServiceZoneService.operationalZones().catch(() => []),
        ]);
        const zoneNames = new Map(zones.map((z) => [z.code, z.name]));
        const operationalCodes = new Set(zones.map((z) => z.code));

        const counts = this.emptyCounts();
        const rows: QueueRow[] = rides.map((r) => {
            const rollup = rollups.get(r.rideId);
            const control = controls.get(r.rideId) ?? null;
            const p = people.passengers.get(r.passengerId);
            const d = r.driverId ? people.drivers.get(r.driverId) : undefined;
            const waitingSeconds = Math.max(
                0,
                Math.round((now.getTime() - new Date(r.createdAt).getTime()) / 1000),
            );

            const attention = this.assessAttention(r, rollup, waitingSeconds, config);
            const queueState = this.queueState(r, control, attention, now);
            counts[queueState] += 1;

            const pickupArea = resolveAreaLine(
                r.pickupSubLocality, r.pickupLocality, areaOf(r.pickupAddress));
            const destArea = resolveAreaLine(
                r.destinationSubLocality, r.destinationLocality, areaOf(r.destinationAddress));

            return {
                rideId: r.rideId,
                requestedAt: new Date(r.createdAt).toISOString(),
                waitingSeconds,
                status: String(r.status),
                queueState,
                attention,
                passenger: p
                    ? { id: r.passengerId, name: maskName(p.firstName, p.lastName), phoneMasked: maskPhone(p.phone) }
                    : null,
                // Display only: a dispatcher can see that a request is an Awka
                // one without anything being filtered for them. Assignment
                // safety is server-side, in ManualAssignmentZoneGuard.
                zoneCode: (r as any).zoneCode ?? null,
                zoneName: zoneNames.get((r as any).zoneCode) ?? null,
                zoneCoverage: coverageOf(
                    (r as any).zoneCode ?? null, (r as any).zoneMatchKind ?? null, operationalCodes),
                pickupAddress: r.pickupAddress ?? null,
                pickupArea: pickupArea.area,
                destinationAddress: r.destinationAddress ?? null,
                destinationArea: destArea.area,
                fare: r.fare != null ? Number(r.fare) : null,
                paymentMode: r.paymentMode ?? null,

                dispatchRound: rollup?.dispatchRound ?? null,
                radiusKm: rollup?.radiusKm ?? null,
                candidateCount: rollup?.candidateCount ?? 0,
                eligibleDriverCount: rollup?.eligibleDriverCount ?? 0,
                offersSent: rollup?.notifiedDriverCount ?? 0,
                rejected: rollup?.rejectionCount ?? 0,
                expired: rollup?.expiredOfferCount ?? 0,
                acknowledged: rollup?.acknowledgedCount ?? 0,
                accepted: !!r.driverId,
                finalOutcomeCode: rollup?.finalOutcomeCode ?? null,

                outcomeReason: r.outcomeReason ?? null,
                outcomeLabel: r.outcomeReason ? outcomeLabel(r.outcomeReason) : null,

                driver: r.driverId
                    ? {
                          id: r.driverId,
                          name: maskName(d?.firstName, d?.lastName),
                          phoneMasked: maskPhone(people.driverPhones.get(r.driverId)),
                      }
                    : null,

                control: {
                    mode: control?.mode ?? DispatchControlMode.AUTO,
                    ownerStaffId: control?.ownerStaffId ?? null,
                    ownerLabel: control?.ownerLabel ?? null,
                    leaseExpiresAt: control?.leaseExpiresAt
                        ? new Date(control.leaseExpiresAt).toISOString()
                        : null,
                    version: control?.version ?? 0,
                },
            };
        });

        return { rows, counts, generatedAt: now.toISOString() };
    }

    /**
     * Does this ride need a human, and how badly?
     *
     * Only reads evidence. A ride with no dispatch rollup has not been
     * searched yet and is not "failing" — it is new, and saying otherwise
     * would make the queue cry wolf within seconds of every request.
     */
    static assessAttention(
        ride: Ride,
        rollup: { candidateCount: number; eligibleDriverCount: number; notifiedDriverCount: number; finalOutcomeCode: string | null } | undefined,
        waitingSeconds: number,
        config = loadOperationsDispatchConfig(),
    ): { triggers: AttentionTrigger[]; severity: AttentionSeverity } {
        const triggers: AttentionTrigger[] = [];

        // A ride that already ended needs no attention — its outcome is the
        // answer, and Ride Operations is where it gets investigated.
        const terminal = [RideStatus.COMPLETED, RideStatus.CANCELED].includes(ride.status as RideStatus);
        if (terminal) return { triggers, severity: 'none' };

        if (ride.status === RideStatus.FAILED) {
            const code = ride.outcomeReason;
            if (code === RideOutcomeCode.TECHNICAL_FAILURE) triggers.push('TECHNICAL_FAILURE');
            else if (code === RideOutcomeCode.NO_DRIVER_ACCEPTED) triggers.push('NO_DRIVER_ACCEPTED');
            else triggers.push('DISPATCH_EXHAUSTED');
            return { triggers, severity: 'urgent' };
        }

        if (ride.status === RideStatus.SEARCHING && rollup) {
            // Searched and found nobody eligible — a supply problem a
            // dispatcher can fix by ringing an offline driver.
            if (rollup.candidateCount > 0 && rollup.eligibleDriverCount === 0) {
                triggers.push('NO_ELIGIBLE_DRIVER');
            }
            // Offers went out and nobody has taken them.
            if (rollup.notifiedDriverCount > 0 && !ride.driverId && waitingSeconds * 1000 >= config.waitAttentionThresholdMs) {
                triggers.push('NO_DRIVER_ACCEPTED');
            }
        }

        if (
            !ride.driverId &&
            ride.status === RideStatus.SEARCHING &&
            waitingSeconds * 1000 >= config.waitAttentionThresholdMs
        ) {
            triggers.push('WAIT_EXCEEDS_THRESHOLD');
        }

        if (triggers.length === 0) return { triggers, severity: 'none' };
        const urgent =
            waitingSeconds * 1000 >= config.waitUrgentThresholdMs ||
            triggers.includes('TECHNICAL_FAILURE');
        return { triggers: [...new Set(triggers)], severity: urgent ? 'urgent' : 'warning' };
    }

    private static queueState(
        ride: Ride,
        control: { mode: string; leaseExpiresAt: Date | null } | null,
        attention: { severity: AttentionSeverity },
        now: Date,
    ): QueueState {
        if (RideControlService.isOperationsControlled(control as any, now)) return 'OPERATIONS_CONTROL';
        switch (ride.status) {
            case RideStatus.COMPLETED:
                return 'COMPLETED';
            case RideStatus.CANCELED:
                return 'CANCELLED';
            case RideStatus.FAILED:
                return 'FAILED';
            case RideStatus.ACCEPTED:
            case RideStatus.ARRIVED:
            case RideStatus.IN_PROGRESS:
            case RideStatus.STARTED:
                return 'ASSIGNED';
            default:
                return attention.severity === 'none' ? 'AUTO_HEALTHY' : 'NEEDS_ATTENTION';
        }
    }

    private static emptyCounts(): Record<QueueState, number> {
        return {
            AUTO_HEALTHY: 0,
            NEEDS_ATTENTION: 0,
            OPERATIONS_CONTROL: 0,
            ASSIGNED: 0,
            COMPLETED: 0,
            CANCELLED: 0,
            FAILED: 0,
        };
    }
}
