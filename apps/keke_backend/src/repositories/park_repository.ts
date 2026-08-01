/**
 * Data access for parks and zones.
 *
 * The repository layer exists to keep query shape out of the services. Services
 * decide policy — who may do what, what must be audited, what a count means —
 * and repositories decide how the rows are fetched. The practical payoff is
 * that every N+1 risk lives in one file where it can be seen: the roster and
 * count queries below are all batched by design, because a park screen that
 * issues one query per driver is fine with twelve drivers and unusable with
 * two hundred.
 */
import { Brackets, In, IsNull, Not, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Park, ParkStatus } from '../models/Park';
import { ParkZone, ParkZoneKind } from '../models/ParkZone';
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { StaffRole } from '../config/staff_permissions';

export interface ParkListQuery {
    search?: string;
    status?: ParkStatus;
    city?: string;
    page?: number;
    pageSize?: number;
}

/** Live counts for one park. Always derived — never a stored counter. */
export interface ParkCounts {
    /** Non-removed roster members. */
    rosterSize: number;
    /** Roster members whose status is ACTIVE (eligible to be queued). */
    rosterActive: number;
    /** Drivers physically at the park in any working state. */
    activeDriverCount: number;
    /** Drivers at the park, in the queue, available for work right now. */
    waitingDriverCount: number;
    /** Drivers at the park currently on a ride. */
    onRideCount: number;
    /** Drivers at the park but not taking work. */
    unavailableCount: number;
    /** activeDriverCount as a percentage of capacityDrivers. */
    capacityUtilisationPct: number;
}

/** Presence states that mean "physically at this park, working". */
export const AT_PARK_STATES: DriverPresenceState[] = [
    DriverPresenceState.AT_PARK,
    DriverPresenceState.WAITING,
    DriverPresenceState.ASSIGNED,
    DriverPresenceState.EN_ROUTE,
    DriverPresenceState.PASSENGER_BOARDING,
    DriverPresenceState.TRIP_STARTED,
];

/** Presence states that mean "on a ride right now". */
export const ON_RIDE_STATES: DriverPresenceState[] = [
    DriverPresenceState.ASSIGNED,
    DriverPresenceState.EN_ROUTE,
    DriverPresenceState.PASSENGER_BOARDING,
    DriverPresenceState.TRIP_STARTED,
];

export class ParkRepository {
    private static get repo(): Repository<Park> {
        return AppDataSource.getRepository(Park);
    }

    private static get zones(): Repository<ParkZone> {
        return AppDataSource.getRepository(ParkZone);
    }

    static findById(parkId: string): Promise<Park | null> {
        return this.repo.findOneBy({ parkId });
    }

    static findByCode(code: string): Promise<Park | null> {
        return this.repo.findOneBy({ code: code.trim().toUpperCase() });
    }

    static async list(query: ParkListQuery): Promise<{ items: Park[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));

        const qb = this.repo.createQueryBuilder('p');
        if (query.status) qb.andWhere('p.status = :status', { status: query.status });
        if (query.city) qb.andWhere('p.city ILIKE :city', { city: `%${query.city}%` });
        if (query.search?.trim()) {
            const term = `%${query.search.trim()}%`;
            qb.andWhere(new Brackets((w) => {
                w.where('p.name ILIKE :term', { term })
                    .orWhere('p.code ILIKE :term', { term })
                    .orWhere('p."addressLine" ILIKE :term', { term })
                    .orWhere('p.city ILIKE :term', { term });
            }));
        }

        qb.orderBy('p.priority', 'DESC').addOrderBy('p.name', 'ASC')
            .skip((page - 1) * pageSize).take(pageSize);

        const [items, total] = await qb.getManyAndCount();
        return { items, total, page, pageSize };
    }

    static save(park: Park): Promise<Park> {
        return this.repo.save(park);
    }

    static create(data: Partial<Park>): Park {
        return this.repo.create(data);
    }

    /** Parks eligible to be offered work. Used by Phase 4; correct to define now. */
    static findDispatchable(): Promise<Park[]> {
        return this.repo.find({ where: { status: ParkStatus.ACTIVE }, order: { priority: 'DESC' } });
    }

    // ── zones ───────────────────────────────────────────────────────────

    static listZones(parkId: string, opts: { kind?: ParkZoneKind; includeInactive?: boolean } = {}): Promise<ParkZone[]> {
        const where: Record<string, unknown> = { parkId };
        if (opts.kind) where.kind = opts.kind;
        if (!opts.includeInactive) where.active = true;
        return this.zones.find({ where, order: { priority: 'DESC', name: 'ASC' } });
    }

    static findZone(zoneId: string): Promise<ParkZone | null> {
        return this.zones.findOneBy({ zoneId });
    }

    static findZoneByCode(parkId: string, code: string): Promise<ParkZone | null> {
        return this.zones.findOneBy({ parkId, code: code.trim().toUpperCase() });
    }

    static saveZone(zone: ParkZone): Promise<ParkZone> {
        return this.zones.save(zone);
    }

    static createZone(data: Partial<ParkZone>): ParkZone {
        return this.zones.create(data);
    }

    // ── derived counts ──────────────────────────────────────────────────

    /**
     * Live counts for one park.
     *
     * Derived on every read rather than kept as columns on `park`. A cached
     * "waiting drivers" number is wrong within seconds of a driver walking
     * away, and a dispatcher who learns the number is unreliable stops reading
     * it — which is worse than the join costs.
     */
    static async counts(park: Park): Promise<ParkCounts> {
        const rosterRepo = AppDataSource.getRepository(ParkDriverRoster);
        const presenceRepo = AppDataSource.getRepository(DriverPresence);

        const [rosterSize, rosterActive] = await Promise.all([
            rosterRepo.count({ where: { parkId: park.parkId, status: Not(RosterStatus.REMOVED) } }),
            rosterRepo.count({ where: { parkId: park.parkId, status: RosterStatus.ACTIVE } }),
        ]);

        // One grouped query instead of one per state.
        const rows = await presenceRepo.createQueryBuilder('pr')
            .select('pr.state', 'state')
            .addSelect('COUNT(*)', 'count')
            .where('pr."parkId" = :parkId', { parkId: park.parkId })
            .groupBy('pr.state')
            .getRawMany<{ state: DriverPresenceState; count: string }>();

        const byState = new Map<DriverPresenceState, number>(
            rows.map((r) => [r.state, Number(r.count)]),
        );
        const sum = (states: DriverPresenceState[]) =>
            states.reduce((total, s) => total + (byState.get(s) ?? 0), 0);

        const activeDriverCount = sum(AT_PARK_STATES);
        const capacity = park.capacityDrivers > 0 ? park.capacityDrivers : 1;

        return {
            rosterSize,
            rosterActive,
            activeDriverCount,
            waitingDriverCount: byState.get(DriverPresenceState.WAITING) ?? 0,
            onRideCount: sum(ON_RIDE_STATES),
            unavailableCount: byState.get(DriverPresenceState.UNAVAILABLE) ?? 0,
            capacityUtilisationPct: Math.round((activeDriverCount / capacity) * 100),
        };
    }

    /**
     * Counts for many parks at once, for the park LIST screen.
     *
     * Two grouped queries total, regardless of how many parks are listed. The
     * per-park version above would be 3n.
     */
    static async countsForMany(parks: Park[]): Promise<Map<string, ParkCounts>> {
        const out = new Map<string, ParkCounts>();
        if (parks.length === 0) return out;
        const parkIds = parks.map((p) => p.parkId);

        const rosterRows = await AppDataSource.getRepository(ParkDriverRoster)
            .createQueryBuilder('r')
            .select('r."parkId"', 'parkId')
            .addSelect('r.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where('r."parkId" IN (:...parkIds)', { parkIds })
            .groupBy('r."parkId"').addGroupBy('r.status')
            .getRawMany<{ parkId: string; status: RosterStatus; count: string }>();

        const presenceRows = await AppDataSource.getRepository(DriverPresence)
            .createQueryBuilder('pr')
            .select('pr."parkId"', 'parkId')
            .addSelect('pr.state', 'state')
            .addSelect('COUNT(*)', 'count')
            .where('pr."parkId" IN (:...parkIds)', { parkIds })
            .groupBy('pr."parkId"').addGroupBy('pr.state')
            .getRawMany<{ parkId: string; state: DriverPresenceState; count: string }>();

        for (const park of parks) {
            const roster = rosterRows.filter((r) => r.parkId === park.parkId);
            const presence = presenceRows.filter((r) => r.parkId === park.parkId);
            const byState = new Map<DriverPresenceState, number>(
                presence.map((r) => [r.state, Number(r.count)]),
            );
            const sum = (states: DriverPresenceState[]) =>
                states.reduce((total, s) => total + (byState.get(s) ?? 0), 0);

            const activeDriverCount = sum(AT_PARK_STATES);
            const capacity = park.capacityDrivers > 0 ? park.capacityDrivers : 1;

            out.set(park.parkId, {
                rosterSize: roster.filter((r) => r.status !== RosterStatus.REMOVED)
                    .reduce((t, r) => t + Number(r.count), 0),
                rosterActive: roster.filter((r) => r.status === RosterStatus.ACTIVE)
                    .reduce((t, r) => t + Number(r.count), 0),
                activeDriverCount,
                waitingDriverCount: byState.get(DriverPresenceState.WAITING) ?? 0,
                onRideCount: sum(ON_RIDE_STATES),
                unavailableCount: byState.get(DriverPresenceState.UNAVAILABLE) ?? 0,
                capacityUtilisationPct: Math.round((activeDriverCount / capacity) * 100),
            });
        }
        return out;
    }

    // ── staff assigned to a park ────────────────────────────────────────

    /**
     * Live park-scoped role grants for a park.
     *
     * Deliberately reads `staff_role_assignment` rather than introducing a
     * second "park dispatcher" table. Two tables answering "who may work at
     * this park" would drift, and the one that drifts is always the one an
     * authorisation check reads.
     */
    static assignedStaff(parkId: string): Promise<StaffRoleAssignment[]> {
        return AppDataSource.getRepository(StaffRoleAssignment).find({
            where: {
                parkId,
                revokedAt: IsNull(),
                role: In([StaffRole.PARK_DISPATCHER, StaffRole.PARK_SUPERVISOR, StaffRole.CASHIER]),
            },
            order: { grantedAt: 'ASC' },
        });
    }
}
