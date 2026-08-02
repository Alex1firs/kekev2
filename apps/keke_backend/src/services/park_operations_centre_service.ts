/**
 * The Park Operations Centre: every park's live state, health and alerts.
 *
 * ── Why this is separate from OperationsOverviewService ─────────────────
 * The overview answers one question — can this park take a ride, and if not
 * why. It is small, it is read on every dispatcher board, and it must stay
 * cheap. This answers a different question: what is happening across the whole
 * network right now, and what should somebody go and fix. It costs more per
 * park and is read by a handful of people on one screen.
 *
 * Keeping them apart means the dispatcher's board is not paying for metrics
 * nobody on a park floor reads. The overview's blocker derivation is reused
 * rather than restated, so the two cannot disagree about whether a park is
 * dispatching.
 *
 * ── Health, and why it is three colours ─────────────────────────────────
 * Green, amber, red map to a decision, not to a score. Red means rides are
 * being lost right now. Amber means they will be shortly unless somebody acts.
 * Green means leave it alone. A number between 0 and 100 would invite argument
 * about the threshold; a colour invites action.
 *
 * Read-only. Nothing here can change a ride, a job, a presence or a shift.
 */

import { In, MoreThan } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Park, ParkStatus } from '../models/Park';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { DriverProfile } from '../models/DriverProfile';
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { StaffPushDelivery, PushDeliveryState } from '../models/StaffPushDelivery';
import { StaffUser } from '../models/StaffUser';
import { StaffAuditEvent } from '../models/StaffAuditEvent';
import { Ride } from '../models/Ride';
import { ParkDispatchJobRepository } from '../repositories/park_dispatch_job_repository';
import { OperationsOverviewService, ParkOverviewRow } from './operations_overview_service';
import { DispatcherShiftService } from './dispatcher_shift_service';

/**
 * How stale a driver's last position may be before we stop believing it.
 *
 * Long enough to survive a tunnel, a lift and a minute of bad signal; short
 * enough that a phone which has actually stopped reporting is noticed within
 * one dispatcher's attention span.
 */
const GPS_STALE_MS = 3 * 60_000;

/** A dispatcher who has done nothing for this long is probably not there. */
const DISPATCHER_IDLE_MS = 20 * 60_000;

/** Queue depth at which a park is visibly falling behind. */
const QUEUE_ALERT_DEPTH = 5;

/** Median offer→claim above which dispatch is too slow to be useful. */
const LATENCY_ALERT_MS = 90_000;

/** Share of pushes that may fail before the channel is considered broken. */
const PUSH_FAILURE_ALERT_PCT = 30;

export type Health = 'green' | 'amber' | 'red';

export interface OpsAlert {
    code:
        | 'no_dispatcher_on_shift'
        | 'no_assignable_drivers'
        | 'push_failing'
        | 'gps_heartbeat_lost'
        | 'dispatcher_inactive'
        | 'closed_during_operating_hours'
        | 'queue_over_threshold'
        | 'dispatch_latency_high';
    severity: 'red' | 'amber';
    message: string;
    /** What to do about it, in the words of the person who has to do it. */
    action: string;
}

export interface ParkOpsRow {
    parkId: string;
    name: string;
    code: string;
    city: string | null;

    /** Open / Closed / Offline — what an operator would say out loud. */
    operationalStatus: 'open' | 'closed' | 'offline';
    parkStatus: ParkStatus;
    withinOperatingHours: boolean;
    opensAt: string | null;
    closesAt: string | null;

    supervisorName: string | null;
    dispatchersOnShift: Array<{ staffUserId: string; name: string | null; shiftMinutes: number; lastActivityMinutes: number | null }>;

    driversOnline: number;
    driversWaiting: number;
    driversOnTrip: number;
    driversPresent: number;
    driversAssignable: number;
    featurePhoneDrivers: number;
    smartphoneDrivers: number;

    activeRequests: number;
    queueLength: number;

    /** Median offer→claim today, seconds. Null when nothing was offered. */
    avgDispatchSeconds: number | null;
    successfulDispatchPct: number | null;
    failedDispatchPct: number | null;

    lastRideDispatchedAt: string | null;
    lastDispatcherActivityAt: string | null;

    /** Drivers reporting position recently, over drivers who should be. */
    gpsHealthy: number;
    gpsStale: number;

    pushAcceptedToday: number;
    pushFailedToday: number;
    pushFailureRatePct: number | null;

    health: Health;
    alerts: OpsAlert[];
    /** The dispatch-blocking reasons, shared with the dispatcher's own board. */
    blockers: ParkOverviewRow['blockers'];
}

export interface OperationsCentre {
    generatedAt: string;
    parkDispatchEnabled: boolean;
    suspended: boolean;
    suspendedReason: string | null;
    totals: {
        parks: number;
        red: number;
        amber: number;
        green: number;
        dispatchersOnShift: number;
        driversPresent: number;
        activeRequests: number;
        driversOnTrip: number;
    };
    parks: ParkOpsRow[];
}

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export class ParkOperationsCentreService {
    static async build(): Promise<OperationsCentre> {
        const overview = await OperationsOverviewService.build();
        const parks = await AppDataSource.getRepository(Park).find({ order: { name: 'ASC' } });
        const byId = new Map(parks.map((p) => [p.parkId, p]));

        const rows: ParkOpsRow[] = [];
        for (const base of overview.parks) {
            const park = byId.get(base.parkId);
            if (!park) continue;
            rows.push(await this.describe(park, base));
        }

        // Worst first. This screen is read when something is wrong.
        const rank: Record<Health, number> = { red: 0, amber: 1, green: 2 };
        rows.sort((a, b) => rank[a.health] - rank[b.health] || a.name.localeCompare(b.name));

        return {
            generatedAt: new Date().toISOString(),
            parkDispatchEnabled: overview.parkDispatchEnabled,
            suspended: overview.suspended,
            suspendedReason: overview.suspendedReason,
            totals: {
                parks: rows.length,
                red: rows.filter((r) => r.health === 'red').length,
                amber: rows.filter((r) => r.health === 'amber').length,
                green: rows.filter((r) => r.health === 'green').length,
                dispatchersOnShift: rows.reduce((n, r) => n + r.dispatchersOnShift.length, 0),
                driversPresent: rows.reduce((n, r) => n + r.driversPresent, 0),
                activeRequests: rows.reduce((n, r) => n + r.activeRequests, 0),
                driversOnTrip: rows.reduce((n, r) => n + r.driversOnTrip, 0),
            },
            parks: rows,
        };
    }

    private static async describe(park: Park, base: ParkOverviewRow): Promise<ParkOpsRow> {
        const since = startOfToday();

        const [presence, devices, metrics, shifts, supervisor, lastRide, push] = await Promise.all([
            this.presence(park.parkId),
            this.deviceMix(park.parkId),
            ParkDispatchJobRepository.metrics(since, park.parkId),
            DispatcherShiftService.onDuty(park.parkId),
            this.supervisorName(park.supervisorStaffId),
            this.lastRideDispatched(park.parkId),
            this.pushHealth(park.parkId, since),
        ]);

        /*
         * Open / Closed / Offline are three different things and an operator
         * needs to tell them apart at a glance: closed is a schedule working
         * correctly, offline is somebody having turned the park off, and only
         * one of them is a reason to call anyone.
         */
        const operationalStatus: ParkOpsRow['operationalStatus'] =
            park.status !== ParkStatus.ACTIVE ? 'offline'
                : base.withinOperatingHours ? 'open' : 'closed';

        /*
         * Last activity comes from the audit trail, not from the shift row.
         *
         * DispatcherShift has no activity timestamp, and adding one would mean
         * a write on every dispatcher action purely to power a panel. The audit
         * trail already records every claim, assignment, skip, rejection and
         * presence change against the person who did it, with a time — which is
         * the same question asked of data that is already authoritative.
         */
        const activity = await this.lastActivityByStaff(shifts.map((s) => s.staffUserId));

        const dispatchers = shifts.map((s) => {
            const at = activity.get(s.staffUserId) ?? null;
            return {
                staffUserId: s.staffUserId,
                name: s.staffName ?? null,
                shiftMinutes: (s as any).durationMinutes ?? 0,
                lastActivityMinutes: at
                    ? Math.round((Date.now() - at.getTime()) / 60_000)
                    : null,
            };
        });

        const lastActivityAt = [...activity.values()]
            .reduce<Date | null>((latest, t) => (!latest || t > latest ? t : latest), null);

        const row: ParkOpsRow = {
            parkId: park.parkId,
            name: park.name,
            code: park.code,
            city: park.city ?? null,

            operationalStatus,
            parkStatus: park.status,
            withinOperatingHours: base.withinOperatingHours,
            opensAt: park.opensAt ?? null,
            closesAt: park.closesAt ?? null,

            supervisorName: supervisor,
            dispatchersOnShift: dispatchers,

            driversOnline: presence.online,
            driversWaiting: presence.waiting,
            driversOnTrip: base.driversOnTrip,
            driversPresent: base.driversPresent,
            driversAssignable: base.driversAssignable,
            featurePhoneDrivers: devices.featurePhone,
            smartphoneDrivers: devices.smartphone,

            activeRequests: base.waitingRequests + base.claimedRequests,
            queueLength: base.waitingRequests,

            avgDispatchSeconds: metrics.medianResponseTimeMs == null
                ? null : Math.round(metrics.medianResponseTimeMs / 1000),
            successfulDispatchPct: metrics.assignmentSuccessRatePct ?? null,
            failedDispatchPct: metrics.assignmentSuccessRatePct == null
                ? null : Math.max(0, 100 - metrics.assignmentSuccessRatePct),

            lastRideDispatchedAt: lastRide ? lastRide.toISOString() : null,
            lastDispatcherActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,

            gpsHealthy: presence.gpsHealthy,
            gpsStale: presence.gpsStale,

            pushAcceptedToday: push.accepted,
            pushFailedToday: push.failed,
            pushFailureRatePct: push.ratePct,

            health: 'green',
            alerts: [],
            blockers: base.blockers,
        };

        row.alerts = this.alertsFor(row, base);
        row.health = this.healthOf(row);
        return row;
    }

    /**
     * What somebody should be told to go and fix.
     *
     * Every alert carries an action, because an alert a person cannot act on
     * trains them to ignore the panel it lives in.
     */
    private static alertsFor(row: ParkOpsRow, base: ParkOverviewRow): OpsAlert[] {
        const alerts: OpsAlert[] = [];
        const trading = row.operationalStatus === 'open';

        if (trading && row.dispatchersOnShift.length === 0) {
            alerts.push({
                code: 'no_dispatcher_on_shift',
                severity: 'red',
                message: 'No dispatcher on shift while the park is open.',
                action: 'Requests will arrive and nobody will see them. Call the supervisor.',
            });
        }

        if (trading && row.driversAssignable === 0) {
            alerts.push({
                code: 'no_assignable_drivers',
                severity: 'red',
                message: row.driversPresent > 0
                    ? `${row.driversPresent} driver(s) present, none assignable.`
                    : 'No driver is marked present.',
                action: row.driversPresent > 0
                    ? 'Check badges, wallet balances and KYC on the roster.'
                    : 'Smartphone drivers appear on arrival; mark feature-phone drivers in Who’s here.',
            });
        }

        if (row.pushFailureRatePct != null && row.pushFailureRatePct >= PUSH_FAILURE_ALERT_PCT) {
            alerts.push({
                code: 'push_failing',
                severity: 'red',
                message: `${row.pushFailureRatePct}% of dispatcher alerts failed today.`,
                action: 'Dispatchers may not be woken by a new request. Re-run device setup on their phone.',
            });
        }

        if (trading && row.gpsStale > 0 && row.gpsHealthy === 0) {
            alerts.push({
                code: 'gps_heartbeat_lost',
                severity: 'red',
                message: `No driver has reported a position in the last ${Math.round(GPS_STALE_MS / 60_000)} minutes.`,
                action: 'Automatic check-in cannot work. Mark arrivals by hand until it recovers.',
            });
        } else if (trading && row.gpsStale > 0) {
            alerts.push({
                code: 'gps_heartbeat_lost',
                severity: 'amber',
                message: `${row.gpsStale} driver(s) have stopped reporting their position.`,
                action: 'Their presence may be out of date. Confirm in person.',
            });
        }

        for (const d of row.dispatchersOnShift) {
            if (d.lastActivityMinutes != null && d.lastActivityMinutes >= DISPATCHER_IDLE_MS / 60_000) {
                alerts.push({
                    code: 'dispatcher_inactive',
                    severity: 'amber',
                    message: `${d.name ?? 'A dispatcher'} has done nothing for ${d.lastActivityMinutes} minutes.`,
                    action: 'Confirm they are still at the counter, or force-close the shift.',
                });
            }
        }

        /*
         * A park that is off during its own advertised hours. Distinct from
         * "closed": the schedule says it should be trading and it is not, which
         * is somebody having suspended it and possibly forgotten.
         */
        if (base.withinOperatingHours && park_is_off(row)) {
            alerts.push({
                code: 'closed_during_operating_hours',
                severity: 'red',
                message: `Park is ${row.parkStatus} during its operating hours (${row.opensAt}–${row.closesAt}).`,
                action: 'Reactivate it, or change its hours so the schedule tells the truth.',
            });
        }

        if (row.queueLength >= QUEUE_ALERT_DEPTH) {
            alerts.push({
                code: 'queue_over_threshold',
                severity: 'amber',
                message: `${row.queueLength} requests waiting.`,
                action: 'More passengers than this park is clearing. Add a dispatcher or drivers.',
            });
        }

        if (row.avgDispatchSeconds != null && row.avgDispatchSeconds * 1000 >= LATENCY_ALERT_MS) {
            alerts.push({
                code: 'dispatch_latency_high',
                severity: 'amber',
                message: `Requests are taking ${row.avgDispatchSeconds}s to be picked up.`,
                action: 'Passengers are waiting. Check whether the dispatcher is overloaded.',
            });
        }

        return alerts;
    }

    /**
     * Red when rides are being lost now, amber when they will be, green
     * otherwise. A closed park is green: a shop that is shut at night is not
     * broken, and colouring it otherwise trains people to ignore the colour.
     */
    private static healthOf(row: ParkOpsRow): Health {
        if (row.operationalStatus === 'closed') return 'green';
        if (row.alerts.some((a) => a.severity === 'red')) return 'red';
        if (row.alerts.length > 0) return 'amber';
        if (row.operationalStatus === 'offline') return 'amber';
        return 'green';
    }

    // ── Data ────────────────────────────────────────────────────────────

    private static async presence(parkId: string) {
        const rows = await AppDataSource.getRepository(DriverPresence).find({ where: { parkId } });
        const cutoff = Date.now() - GPS_STALE_MS;

        let waiting = 0;
        let online = 0;
        let gpsHealthy = 0;
        let gpsStale = 0;

        for (const r of rows) {
            if (r.state === DriverPresenceState.WAITING) waiting += 1;
            if (r.state !== DriverPresenceState.OFFLINE) online += 1;

            // Only drivers who are supposed to be reporting count towards GPS
            // health. An offline driver's silent phone is not a fault.
            if (r.state === DriverPresenceState.OFFLINE) continue;
            const beat = r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt).getTime() : 0;
            if (beat >= cutoff) gpsHealthy += 1; else gpsStale += 1;
        }

        return { waiting, online, gpsHealthy, gpsStale };
    }

    private static async deviceMix(parkId: string) {
        const roster = await AppDataSource.getRepository(ParkDriverRoster).find({
            where: { parkId, status: RosterStatus.ACTIVE },
        });
        if (roster.length === 0) return { featurePhone: 0, smartphone: 0 };

        const profiles = await AppDataSource.getRepository(DriverProfile).find({
            where: { userId: In(roster.map((r) => r.driverId)) },
        });

        let featurePhone = 0;
        let smartphone = 0;
        for (const p of profiles) {
            if (String(p.deviceCapability) === 'feature_phone') featurePhone += 1;
            else if (String(p.deviceCapability) === 'smartphone') smartphone += 1;
        }
        return { featurePhone, smartphone };
    }

    /**
     * When each of these staff members last did anything at all.
     *
     * One grouped query rather than one per dispatcher: a park with four people
     * on shift should not cost four round trips to render one row.
     */
    private static async lastActivityByStaff(staffUserIds: string[]): Promise<Map<string, Date>> {
        const out = new Map<string, Date>();
        if (staffUserIds.length === 0) return out;

        const rows = await AppDataSource.getRepository(StaffAuditEvent)
            .createQueryBuilder('a')
            .select('a."actorStaffUserId"', 'staffUserId')
            .addSelect('MAX(a."createdAt")', 'lastAt')
            .where('a."actorStaffUserId" IN (:...ids)', { ids: staffUserIds })
            .groupBy('a."actorStaffUserId"')
            .getRawMany<{ staffUserId: string; lastAt: string }>();

        for (const r of rows) {
            if (r.lastAt) out.set(r.staffUserId, new Date(r.lastAt));
        }
        return out;
    }

    private static async supervisorName(staffUserId: string | null): Promise<string | null> {
        if (!staffUserId) return null;
        const staff = await AppDataSource.getRepository(StaffUser).findOneBy({ id: staffUserId });
        return staff ? `${staff.firstName} ${staff.lastName}` : null;
    }

    /** When this park last put a passenger in a Keke. */
    private static async lastRideDispatched(parkId: string): Promise<Date | null> {
        const ride = await AppDataSource.getRepository(Ride).findOne({
            where: { parkId },
            order: { createdAt: 'DESC' },
            select: ['rideId', 'createdAt'],
        });
        return ride?.createdAt ? new Date(ride.createdAt) : null;
    }

    /**
     * Whether dispatcher alerts are actually reaching phones.
     *
     * Counts provider acceptance as success and the three real failure states
     * as failure. Everything in between — queued, opened, viewed — says nothing
     * about whether the channel works, so it is excluded from the ratio rather
     * than quietly counted as one or the other.
     */
    private static async pushHealth(parkId: string, since: Date) {
        const repo = AppDataSource.getRepository(StaffPushDelivery);
        const rows = await repo.find({
            where: { parkId, createdAt: MoreThan(since) },
            select: ['id', 'state'],
        });

        const failedStates = [
            PushDeliveryState.FAILED,
            PushDeliveryState.TOKEN_INVALID,
            PushDeliveryState.PERMISSION_DENIED,
        ];

        let accepted = 0;
        let failed = 0;
        for (const r of rows) {
            if (failedStates.includes(r.state)) failed += 1;
            else if (r.state !== PushDeliveryState.QUEUED) accepted += 1;
        }

        const total = accepted + failed;
        return {
            accepted,
            failed,
            ratePct: total === 0 ? null : Math.round((failed / total) * 100),
        };
    }
}

/** A park that is not ACTIVE is off, whatever its schedule says. */
function park_is_off(row: ParkOpsRow): boolean {
    return row.parkStatus !== ParkStatus.ACTIVE;
}
