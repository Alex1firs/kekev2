/**
 * The dispatcher's whole screen, in one payload.
 *
 * A park device is on sponsored mobile data and repaints often. Five calls to
 * render one screen is a real cost, not a theoretical one, so this assembles
 * everything in parallel and returns it once: the queue, ranked drivers, live
 * counts, today's totals and park health.
 *
 * Everything here is READ-ONLY. Nothing in this file changes a job, a ride, a
 * presence or a queue — the dashboard reports, and the action endpoints act.
 */
import { AppDataSource } from '../config/data_source';
import { Park } from '../models/Park';
import { ParkDispatchJob, ParkJobStatus } from '../models/ParkDispatchJob';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { Ride } from '../models/Ride';
import { ParkRepository, ParkCounts } from '../repositories/park_repository';
import { ParkDispatchJobRepository } from '../repositories/park_dispatch_job_repository';
import { DispatcherShiftRepository } from '../repositories/dispatcher_shift_repository';
import { ParkDispatchService, QueueCard } from './park_dispatch_service';
import { DriverRecommendationService, RecommendedDriver } from './driver_recommendation_service';
import { DriverPresenceService } from './driver_presence_service';
import { DispatcherShiftService, ShiftDto } from './dispatcher_shift_service';
import { ParkService, ParkDto } from './park_service';
import { loadParkDispatchConfig } from '../config/park_dispatch_config';
import { ParkDispatchSwitch } from './park_dispatch_switch';

/** Everything the dispatcher's header strip shows. */
export interface DispatcherCounters {
    /** Requests waiting for this park to act. */
    queueDepth: number;
    /** Requests this dispatcher has claimed and not yet resolved. */
    activeAssignments: number;
    /** Offers sitting with a driver, waiting for them to answer. */
    awaitingDriverResponse: number;
    /** Passengers currently waiting on this park. Same as queueDepth, named for humans. */
    waitingPassengers: number;

    availableDrivers: number;
    driversOnTrips: number;
    driversUnavailable: number;
    driversOffline: number;

    /** activeDriverCount as a share of park capacity. */
    parkUtilisationPct: number;

    /** Mean seconds a passenger waited on jobs this park finished today. */
    avgPassengerWaitSeconds: number | null;
    /** Median seconds from offer to claim, today. */
    dispatcherResponseSeconds: number | null;

    jobsAssignedToday: number;
    jobsCompletedToday: number;
    failedAssignmentsToday: number;
    escalatedJobsToday: number;
}

export interface DispatcherDashboard {
    park: ParkDto;
    counters: DispatcherCounters;
    queue: QueueCard[];
    drivers: RecommendedDriver[];
    myShift: ShiftDto | null;
    onDuty: ShiftDto[];
    parkHealth: ParkHealth;
    /** Stated explicitly so no client invents a lifecycle capability. */
    capabilities: {
        canClaim: boolean;
        canAssign: boolean;
        canAdvanceRideLifecycle: false;
        /** Env setting AND the runtime kill switch, together. */
        parkDispatchEnabled: boolean;
        /** Why new work stopped arriving, when it has. */
        pausedReason: string | null;
    };
    serverTime: string;
}

/** What operations needs to see to know whether a park is healthy. */
export interface ParkHealth {
    parkId: string;
    name: string;
    code: string;
    status: string;
    withinOperatingHours: boolean;
    capacityDrivers: number;
    counts: ParkCounts;
    driversWaiting: number;
    driversAssigned: number;
    currentQueueDepth: number;
    currentDispatchers: Array<{ staffUserId: string; name: string | null; shiftMinutes: number }>;
    /** Median offer→claim, today, in seconds. */
    avgAssignmentSeconds: number | null;
    avgPassengerWaitSeconds: number | null;
    /** Share of offers this park converted into an assignment today. */
    acceptanceRatePct: number;
    jobsPerDispatcher: Array<{ staffUserId: string; name: string; claimed: number; assigned: number }>;
}

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export class DispatcherDashboardService {
    /** The whole dispatcher screen. One round trip. */
    static async build(parkId: string, staffUserId: string): Promise<DispatcherDashboard> {
        const park = await ParkService.requirePark(parkId);

        const [counts, queue, myShift, onDuty, presence, todayMetrics, drivers, killSwitch] = await Promise.all([
            ParkRepository.counts(park),
            ParkDispatchService.queueForPark(parkId),
            DispatcherShiftService.current(staffUserId),
            DispatcherShiftService.onDuty(parkId),
            this.presenceBreakdown(parkId),
            ParkDispatchJobRepository.metrics(startOfToday(), parkId),
            ParkDispatchService.assignableDrivers(parkId),
            ParkDispatchSwitch.state(),
        ]);

        const mine = queue.filter((c) => c.claimedByStaffId === staffUserId);
        const awaiting = queue.filter((c) => c.status === ParkJobStatus.PENDING_ACCEPTANCE);

        const counters: DispatcherCounters = {
            queueDepth: queue.length,
            activeAssignments: mine.length,
            awaitingDriverResponse: awaiting.length,
            waitingPassengers: queue.length,

            availableDrivers: presence.waiting + presence.atPark,
            driversOnTrips: presence.onTrip,
            driversUnavailable: presence.unavailable,
            driversOffline: presence.offline,

            parkUtilisationPct: counts.capacityUtilisationPct,

            avgPassengerWaitSeconds: todayMetrics.avgPassengerWaitMs == null
                ? null : Math.round(todayMetrics.avgPassengerWaitMs / 1000),
            dispatcherResponseSeconds: todayMetrics.medianResponseTimeMs == null
                ? null : Math.round(todayMetrics.medianResponseTimeMs / 1000),

            jobsAssignedToday: todayMetrics.assigned,
            jobsCompletedToday: await this.completedRidesToday(parkId),
            // A failed assignment is one this park could not fill at all —
            // expired, skipped or rejected. Cancellations are excluded: a
            // passenger changing their mind is not the park's failure.
            failedAssignmentsToday: todayMetrics.expired + todayMetrics.skipped + todayMetrics.rejected,
            escalatedJobsToday: todayMetrics.escalated,
        };

        return {
            park: ParkService.toDto(park, { counts }),
            counters,
            queue,
            drivers,
            myShift,
            onDuty,
            parkHealth: await this.parkHealth(park),
            capabilities: {
                canClaim: myShift != null,
                canAssign: myShift != null,
                canAdvanceRideLifecycle: false,
                /**
                 * Both layers, collapsed into the one thing a dispatcher needs
                 * to know: are new requests still going to arrive? Without
                 * this, a killed switch looks exactly like a quiet morning,
                 * and the dispatcher sits watching an empty queue.
                 */
                parkDispatchEnabled: loadParkDispatchConfig().enabled && !killSwitch.disabled,
                pausedReason: killSwitch.disabled ? (killSwitch.reason ?? 'Paused by operations') : null,
            },
            serverTime: new Date().toISOString(),
        };
    }

    /** One grouped query for every presence state at a park. */
    static async presenceBreakdown(parkId: string): Promise<{
        waiting: number; atPark: number; onTrip: number; unavailable: number; offline: number;
    }> {
        const rows = await AppDataSource.getRepository(DriverPresence)
            .createQueryBuilder('p')
            .select('p.state', 'state')
            .addSelect('COUNT(*)', 'count')
            .where('p."parkId" = :parkId', { parkId })
            .groupBy('p.state')
            .getRawMany<{ state: DriverPresenceState; count: string }>();

        const by = new Map(rows.map((r) => [r.state, Number(r.count)]));
        const n = (s: DriverPresenceState) => by.get(s) ?? 0;
        return {
            waiting: n(DriverPresenceState.WAITING),
            atPark: n(DriverPresenceState.AT_PARK),
            onTrip: n(DriverPresenceState.ASSIGNED) + n(DriverPresenceState.EN_ROUTE)
                + n(DriverPresenceState.PASSENGER_BOARDING) + n(DriverPresenceState.TRIP_STARTED),
            unavailable: n(DriverPresenceState.UNAVAILABLE),
            offline: n(DriverPresenceState.OFFLINE),
        };
    }

    /**
     * Rides this park sourced that have since COMPLETED today.
     *
     * Read from `ride`, not from the job, because completion is a ride fact the
     * dispatcher has no part in — the job's books close at assignment.
     */
    static async completedRidesToday(parkId: string): Promise<number> {
        const row = await AppDataSource.getRepository(Ride)
            .createQueryBuilder('r')
            .select('COUNT(*)', 'count')
            .where('r."parkId" = :parkId', { parkId })
            .andWhere('r.status = :status', { status: 'completed' })
            .andWhere('r."completedAt" >= :since', { since: startOfToday() })
            .getRawOne<{ count: string }>();
        return Number(row?.count ?? 0);
    }

    /** Park health for the operations view. */
    static async parkHealth(park: Park): Promise<ParkHealth> {
        const since = startOfToday();
        const [counts, presence, queueDepth, onDuty, metrics, perDispatcher] = await Promise.all([
            ParkRepository.counts(park),
            this.presenceBreakdown(park.parkId),
            ParkDispatchJobRepository.countLiveForPark(park.parkId),
            DispatcherShiftService.onDuty(park.parkId),
            ParkDispatchJobRepository.metrics(since, park.parkId),
            ParkDispatchJobRepository.dispatcherStats(since, park.parkId),
        ]);

        const nameBy = new Map(onDuty.map((s) => [s.staffUserId, s.staffName]));

        return {
            parkId: park.parkId,
            name: park.name,
            code: park.code,
            status: park.status,
            withinOperatingHours: ParkService.isWithinOperatingHours(park),
            capacityDrivers: park.capacityDrivers,
            counts,
            driversWaiting: presence.waiting,
            driversAssigned: presence.onTrip,
            currentQueueDepth: queueDepth,
            currentDispatchers: onDuty.map((s) => ({
                staffUserId: s.staffUserId,
                name: s.staffName ?? null,
                shiftMinutes: s.durationMinutes,
            })),
            avgAssignmentSeconds: metrics.medianAssignmentTimeMs == null
                ? null : Math.round(metrics.medianAssignmentTimeMs / 1000),
            avgPassengerWaitSeconds: metrics.avgPassengerWaitMs == null
                ? null : Math.round(metrics.avgPassengerWaitMs / 1000),
            acceptanceRatePct: metrics.assignmentSuccessRatePct,
            jobsPerDispatcher: perDispatcher.map((d) => ({
                staffUserId: d.staffUserId,
                name: nameBy.get(d.staffUserId) ?? d.staffUserId,
                claimed: Number(d.claimed),
                assigned: Number(d.assigned),
            })),
        };
    }

    /** Park health for every active park, for the operations overview. */
    static async allParkHealth(): Promise<ParkHealth[]> {
        const parks = await ParkRepository.findDispatchable();
        return Promise.all(parks.map((p) => this.parkHealth(p)));
    }
}
