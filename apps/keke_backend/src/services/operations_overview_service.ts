/**
 * Every park at once, and — when a park cannot dispatch — why.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A park that cannot take work looks exactly like a quiet park from every
 * screen we had. The only place the difference was written down was the
 * dispatch trace, one ride at a time, in a table nobody watches. During the
 * first production setup a park sat active, staffed and rostered while every
 * ride failed, and the reason — not one driver had been marked present — was
 * discoverable only by reading `dispatch_event` rows by hand.
 *
 * So this reports the same reasons the selector itself applies, in the same
 * order, and names the missing thing rather than the failing check.
 *
 * ── Relationship to dispatch ────────────────────────────────────────────
 * Read-only, and not on any dispatch path. It re-derives the selector's
 * conditions for display; it never decides anything. `ParkSelectionService`
 * remains the only code that chooses a park, and nothing here can change what
 * it picks.
 */

import { AppDataSource } from '../config/data_source';
import { Park, ParkStatus } from '../models/Park';
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { DispatcherShiftService } from './dispatcher_shift_service';
import { ParkDispatchJob, ParkJobStatus } from '../models/ParkDispatchJob';
import { LIVE_JOB_STATUSES } from '../repositories/park_dispatch_job_repository';
import { ASSIGNABLE_PRESENCE_STATES } from './park_selection_service';
import { ParkRosterService } from './park_roster_service';
import { ParkService } from './park_service';
import { ParkDispatchSwitch } from './park_dispatch_switch';
import { loadParkDispatchConfig } from '../config/park_dispatch_config';

/** What DispatcherShiftService.allOnDuty() gives us, narrowed to what we use. */
type OnDutyShift = { parkId: string; staffUserId: string; staffName?: string | null };

/** A reason a park cannot currently be given a ride, in the operator's words. */
export interface ParkBlocker {
    /** Stable identifier, for styling and for tests. */
    code:
        | 'not_active'
        | 'outside_hours'
        | 'no_driver_present'
        | 'present_but_unassignable'
        | 'no_dispatcher_on_shift'
        | 'dispatch_suspended';
    /** What an operator should read. */
    message: string;
    /** Whether this alone stops rides arriving, or only stops them being worked. */
    severity: 'blocking' | 'warning';
}

export interface ParkOverviewRow {
    parkId: string;
    name: string;
    code: string;
    status: ParkStatus;
    city: string | null;
    withinOperatingHours: boolean;
    opensAt: string | null;
    closesAt: string | null;

    dispatchersOnShift: number;
    dispatcherNames: string[];

    rosterActive: number;
    driversPresent: number;
    driversAssignable: number;
    driversOnTrip: number;

    waitingRequests: number;
    claimedRequests: number;
    activeTrips: number;

    canDispatch: boolean;
    blockers: ParkBlocker[];
}

export interface OperationsOverview {
    generatedAt: string;
    parkDispatchEnabled: boolean;
    suspended: boolean;
    suspendedReason: string | null;
    totals: {
        parks: number;
        parksActive: number;
        parksBlocked: number;
        dispatchersOnShift: number;
        driversPresent: number;
        waitingRequests: number;
        activeTrips: number;
    };
    parks: ParkOverviewRow[];
}

export class OperationsOverviewService {
    static async build(): Promise<OperationsOverview> {
        // Every park, including drafts and suspended ones. A park that cannot
        // dispatch is precisely what an operator opens this screen to find, so
        // filtering them out would hide the answer.
        const parks = await AppDataSource.getRepository(Park).find({ order: { name: 'ASC' } });

        const config = loadParkDispatchConfig();
        const killSwitch = await ParkDispatchSwitch.state();

        const parkIds = parks.map((p) => p.parkId);
        const [presenceRows, shiftRows, jobRows, rosterRows] = await Promise.all([
            this.presenceByPark(parkIds),
            this.shiftsByPark(parkIds),
            this.jobsByPark(parkIds),
            this.rosterByPark(parkIds),
        ]);

        const rows: ParkOverviewRow[] = [];
        for (const park of parks) {
            rows.push(await this.describe(
                park,
                presenceRows.get(park.parkId) ?? new Map(),
                shiftRows.get(park.parkId) ?? [],
                jobRows.get(park.parkId) ?? new Map(),
                rosterRows.get(park.parkId) ?? 0,
                { enabled: config.enabled, suspended: killSwitch.disabled, requireWaitingDriver: config.requireWaitingDriver },
            ));
        }

        return {
            generatedAt: new Date().toISOString(),
            parkDispatchEnabled: config.enabled,
            suspended: killSwitch.disabled,
            suspendedReason: killSwitch.reason ?? null,
            totals: {
                parks: rows.length,
                parksActive: rows.filter((r) => r.status === ParkStatus.ACTIVE).length,
                parksBlocked: rows.filter((r) => !r.canDispatch).length,
                dispatchersOnShift: rows.reduce((n, r) => n + r.dispatchersOnShift, 0),
                driversPresent: rows.reduce((n, r) => n + r.driversPresent, 0),
                waitingRequests: rows.reduce((n, r) => n + r.waitingRequests, 0),
                activeTrips: rows.reduce((n, r) => n + r.activeTrips, 0),
            },
            parks: rows,
        };
    }

    /**
     * One park's row, for the dispatcher's own board.
     *
     * The same derivation as the operations screen, so a dispatcher looking at
     * an empty queue and a supervisor looking at the overview are told the same
     * thing in the same words. Two independent explanations of "why is nothing
     * arriving" would eventually disagree, and the one on the park floor is the
     * one that would be wrong.
     */
    static async forPark(parkId: string): Promise<ParkOverviewRow | null> {
        const park = await AppDataSource.getRepository(Park).findOneBy({ parkId });
        if (!park) return null;

        const config = loadParkDispatchConfig();
        const killSwitch = await ParkDispatchSwitch.state();

        const [presence, shifts, jobs, roster] = await Promise.all([
            this.presenceByPark([parkId]),
            this.shiftsByPark([parkId]),
            this.jobsByPark([parkId]),
            this.rosterByPark([parkId]),
        ]);

        return this.describe(
            park,
            presence.get(parkId) ?? new Map(),
            shifts.get(parkId) ?? [],
            jobs.get(parkId) ?? new Map(),
            roster.get(parkId) ?? 0,
            {
                enabled: config.enabled,
                suspended: killSwitch.disabled,
                requireWaitingDriver: config.requireWaitingDriver,
            },
        );
    }

    private static async describe(
        park: Park,
        presence: Map<DriverPresenceState, number>,
        shifts: OnDutyShift[],
        jobs: Map<ParkJobStatus, number>,
        rosterActive: number,
        flags: { enabled: boolean; suspended: boolean; requireWaitingDriver: boolean },
    ): Promise<ParkOverviewRow> {
        const sum = (states: DriverPresenceState[]) =>
            states.reduce((total, s) => total + (presence.get(s) ?? 0), 0);

        const driversPresent = sum(ASSIGNABLE_PRESENCE_STATES);
        const driversOnTrip = sum([
            DriverPresenceState.ASSIGNED,
            DriverPresenceState.EN_ROUTE,
            DriverPresenceState.PASSENGER_BOARDING,
            DriverPresenceState.TRIP_STARTED,
        ]);

        /*
         * Present is not the same as assignable, and the gap is the single most
         * confusing thing about this system: park SELECTION counts presence
         * only, so a request will be sent to a park whose only present driver
         * has no badge — and the dispatcher then cannot assign anybody. That
         * looks like the software losing the ride. It is worth its own count.
         */
        const driversAssignable = await this.assignableCount(park.parkId);

        const withinOperatingHours = ParkService.isWithinOperatingHours(park);
        const waitingRequests = jobs.get(ParkJobStatus.OFFERED) ?? 0;
        const claimedRequests = (jobs.get(ParkJobStatus.CLAIMED) ?? 0)
            + (jobs.get(ParkJobStatus.PENDING_ACCEPTANCE) ?? 0);

        const blockers: ParkBlocker[] = [];

        if (park.status !== ParkStatus.ACTIVE) {
            blockers.push({
                code: 'not_active',
                severity: 'blocking',
                message: `Park is ${park.status}. Only an active park is offered rides.`,
            });
        }
        if (!withinOperatingHours) {
            blockers.push({
                code: 'outside_hours',
                severity: 'blocking',
                message: park.opensAt
                    ? `Closed now. Opens ${park.opensAt}, closes ${park.closesAt}.`
                    : 'Outside operating hours.',
            });
        }
        if (flags.requireWaitingDriver && driversPresent === 0) {
            blockers.push({
                code: 'no_driver_present',
                severity: 'blocking',
                message: rosterActive === 0
                    ? 'Nobody is on the roster. Add drivers to this park.'
                    : `${rosterActive} driver(s) rostered but none marked present. `
                        + 'Smartphone drivers appear when they arrive; mark feature-phone drivers in Who’s here.',
            });
        }
        if (driversPresent > 0 && driversAssignable === 0) {
            blockers.push({
                code: 'present_but_unassignable',
                severity: 'blocking',
                message: `${driversPresent} driver(s) present but none can be assigned `
                    + '— usually no badge issued, a wallet block, or KYC not approved.',
            });
        }
        if (shifts.length === 0) {
            /*
             * Not blocking: selection does not check for a dispatcher, so rides
             * WILL be sent to a park with nobody on shift and will sit there
             * until they expire. Which is arguably worse than being refused,
             * and is exactly why it is worth showing.
             */
            blockers.push({
                code: 'no_dispatcher_on_shift',
                severity: 'warning',
                message: 'No dispatcher on shift. Requests will arrive and nobody will see them.',
            });
        }
        if (flags.suspended || !flags.enabled) {
            blockers.push({
                code: 'dispatch_suspended',
                severity: 'blocking',
                message: flags.suspended
                    ? 'Park Dispatch is suspended by operations.'
                    : 'Park Dispatch is disabled in configuration.',
            });
        }

        return {
            parkId: park.parkId,
            name: park.name,
            code: park.code,
            status: park.status,
            city: park.city ?? null,
            withinOperatingHours,
            opensAt: park.opensAt ?? null,
            closesAt: park.closesAt ?? null,

            dispatchersOnShift: shifts.length,
            dispatcherNames: shifts.map((s) => s.staffName || s.staffUserId).filter(Boolean),

            rosterActive,
            driversPresent,
            driversAssignable,
            driversOnTrip,

            waitingRequests,
            claimedRequests,
            activeTrips: driversOnTrip,

            canDispatch: !blockers.some((b) => b.severity === 'blocking'),
            blockers,
        };
    }

    /**
     * How many drivers could actually be handed a ride right now.
     *
     * Reuses the roster service's own assignability rules rather than
     * reimplementing them, so this can never drift from what the dispatcher
     * sees when they open the queue.
     */
    private static async assignableCount(parkId: string): Promise<number> {
        try {
            const entries = await ParkRosterService.view(parkId, { status: RosterStatus.ACTIVE });
            return entries.filter((e) => ParkRosterService.assignabilityProblems(e).length === 0).length;
        } catch {
            return 0;
        }
    }

    private static async presenceByPark(
        parkIds: string[],
    ): Promise<Map<string, Map<DriverPresenceState, number>>> {
        const out = new Map<string, Map<DriverPresenceState, number>>();
        if (parkIds.length === 0) return out;

        const rows = await AppDataSource.getRepository(DriverPresence)
            .createQueryBuilder('p')
            .select('p."parkId"', 'parkId')
            .addSelect('p.state', 'state')
            .addSelect('COUNT(*)', 'count')
            .where('p."parkId" IN (:...parkIds)', { parkIds })
            .groupBy('p."parkId"')
            .addGroupBy('p.state')
            .getRawMany<{ parkId: string; state: DriverPresenceState; count: string }>();

        for (const r of rows) {
            if (!out.has(r.parkId)) out.set(r.parkId, new Map());
            out.get(r.parkId)!.set(r.state, Number(r.count));
        }
        return out;
    }

    /**
     * Open shifts grouped by park, with the dispatcher's name already resolved.
     *
     * Goes through the shift service rather than the repository so the name
     * decoration is the same one the dispatcher board shows. A second join
     * written here would be a second thing to keep correct.
     */
    private static async shiftsByPark(parkIds: string[]): Promise<Map<string, OnDutyShift[]>> {
        const out = new Map<string, OnDutyShift[]>();
        if (parkIds.length === 0) return out;

        const shifts = await DispatcherShiftService.allOnDuty();
        for (const s of shifts) {
            if (!parkIds.includes(s.parkId)) continue;
            if (!out.has(s.parkId)) out.set(s.parkId, []);
            out.get(s.parkId)!.push(s);
        }
        return out;
    }

    private static async jobsByPark(parkIds: string[]): Promise<Map<string, Map<ParkJobStatus, number>>> {
        const out = new Map<string, Map<ParkJobStatus, number>>();
        if (parkIds.length === 0) return out;

        const rows = await AppDataSource.getRepository(ParkDispatchJob)
            .createQueryBuilder('j')
            .select('j."parkId"', 'parkId')
            .addSelect('j.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('j."parkId" IN (:...parkIds)', { parkIds })
            .andWhere('j.status IN (:...live)', { live: LIVE_JOB_STATUSES })
            .groupBy('j."parkId"')
            .addGroupBy('j.status')
            .getRawMany<{ parkId: string; status: ParkJobStatus; count: string }>();

        for (const r of rows) {
            if (!out.has(r.parkId)) out.set(r.parkId, new Map());
            out.get(r.parkId)!.set(r.status, Number(r.count));
        }
        return out;
    }

    private static async rosterByPark(parkIds: string[]): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        if (parkIds.length === 0) return out;

        const rows = await AppDataSource.getRepository(ParkDriverRoster)
            .createQueryBuilder('r')
            .select('r."parkId"', 'parkId')
            .addSelect('COUNT(*)', 'count')
            .where('r."parkId" IN (:...parkIds)', { parkIds })
            .andWhere('r.status = :status', { status: RosterStatus.ACTIVE })
            .groupBy('r."parkId"')
            .getRawMany<{ parkId: string; count: string }>();

        for (const r of rows) out.set(r.parkId, Number(r.count));
        return out;
    }
}
