/**
 * Which park should be offered a ride, and in what order.
 *
 * Ranking is by ESTIMATED TRAVEL TIME first, then park priority. Distance alone
 * would be the obvious choice and is the wrong one: two parks four kilometres
 * away are not equivalent if one has nobody standing in it. So a park with no
 * assignable driver is filtered out entirely rather than ranked low — offering a
 * ride to an empty park burns the claim window and leaves the passenger worse
 * off than failing immediately.
 *
 * There is no server-side routing API. Travel time is a straight-line estimate
 * at KEKE_METRES_PER_MINUTE, the same constant the stale-ride sweeper already
 * uses. It is used ONLY to order candidates and to refuse absurd ones — never to
 * promise a passenger an arrival time.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Park, ParkStatus } from '../models/Park';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { ParkDispatchJob } from '../models/ParkDispatchJob';
import { ParkService } from './park_service';
import { haversineMeters } from './ride_integrity_service';
import { ParkDispatchConfig } from '../config/park_dispatch_config';

/**
 * Presence states in which a driver may be handed a ride by a dispatcher.
 *
 * The brief lists "AT_PARK, WAITING, AVAILABLE". The first two are presence
 * states; AVAILABLE is not — availability is a ROSTER property (active, not
 * suspended, wallet clear, badge issued), evaluated separately by
 * ParkRosterService.assignabilityProblems. Presence answers "is this person
 * physically here and free", roster answers "are they allowed to work".
 *
 * ONLINE is deliberately excluded. A driver who is working but not at the park
 * is precisely who direct dispatch already tried and failed to reach, and a
 * dispatcher cannot hand a trip slip to somebody who is not standing there.
 */
export const ASSIGNABLE_PRESENCE_STATES: DriverPresenceState[] = [
    DriverPresenceState.AT_PARK,
    DriverPresenceState.WAITING,
];

export interface ParkCandidate {
    park: Park;
    distanceKm: number;
    estimatedTravelMinutes: number;
    /** Drivers at this park in an assignable presence state. */
    assignableDriverCount: number;
    /** Why this park was excluded, when it was. */
    rejectedReason?: string;
}

export interface ParkSelectionResult {
    /** Ranked, offerable parks — best first. */
    candidates: ParkCandidate[];
    /** Everything considered and dropped, with reasons, for the dispatch timeline. */
    rejected: ParkCandidate[];
}

export class ParkSelectionService {
    /**
     * Rank the parks that could serve this pickup.
     *
     * @param excludeParkIds parks this ride has already been offered to.
     */
    static async selectForPickup(
        pickup: { lat: number; lng: number },
        config: ParkDispatchConfig,
        excludeParkIds: string[] = [],
    ): Promise<ParkSelectionResult> {
        const parks = await AppDataSource.getRepository(Park).find({
            where: { status: ParkStatus.ACTIVE },
        });

        const candidates: ParkCandidate[] = [];
        const rejected: ParkCandidate[] = [];

        // One grouped query for assignable drivers across every park, rather
        // than one per park.
        const presenceCounts = await this.assignableCountsByPark(parks.map((p) => p.parkId));

        for (const park of parks) {
            const distanceKm = haversineMeters(
                { lat: Number(park.lat), lng: Number(park.lng) },
                pickup,
            ) / 1000;
            const estimatedTravelMinutes = Math.round(
                (distanceKm * 1000) / Math.max(1, config.metresPerMinute),
            );
            const assignableDriverCount = presenceCounts.get(park.parkId) ?? 0;
            const candidate: ParkCandidate = { park, distanceKm, estimatedTravelMinutes, assignableDriverCount };

            if (excludeParkIds.includes(park.parkId)) {
                rejected.push({ ...candidate, rejectedReason: 'already_tried' });
                continue;
            }
            if (distanceKm > Number(park.serviceRadiusKm)) {
                rejected.push({ ...candidate, rejectedReason: 'outside_service_radius' });
                continue;
            }
            if (estimatedTravelMinutes > config.maxTravelMinutes) {
                rejected.push({ ...candidate, rejectedReason: 'too_far_by_time' });
                continue;
            }
            // Operating hours are a real constraint: a closed park has no
            // dispatcher on duty, so an offer would simply time out.
            if (!ParkService.isWithinOperatingHours(park)) {
                rejected.push({ ...candidate, rejectedReason: 'outside_operating_hours' });
                continue;
            }
            if (config.requireWaitingDriver && assignableDriverCount === 0) {
                rejected.push({ ...candidate, rejectedReason: 'no_assignable_driver' });
                continue;
            }

            candidates.push(candidate);
        }

        // Fastest first; park priority breaks ties; more drivers breaks the rest.
        candidates.sort((a, b) => {
            if (a.estimatedTravelMinutes !== b.estimatedTravelMinutes) {
                return a.estimatedTravelMinutes - b.estimatedTravelMinutes;
            }
            if (a.park.priority !== b.park.priority) return b.park.priority - a.park.priority;
            return b.assignableDriverCount - a.assignableDriverCount;
        });

        return { candidates, rejected };
    }

    /** Assignable-driver counts for many parks in one query. */
    static async assignableCountsByPark(parkIds: string[]): Promise<Map<string, number>> {
        if (parkIds.length === 0) return new Map();
        const rows = await AppDataSource.getRepository(DriverPresence)
            .createQueryBuilder('p')
            .select('p."parkId"', 'parkId')
            .addSelect('COUNT(*)', 'count')
            .where('p."parkId" IN (:...parkIds)', { parkIds })
            .andWhere('p.state IN (:...states)', { states: ASSIGNABLE_PRESENCE_STATES })
            .groupBy('p."parkId"')
            .getRawMany<{ parkId: string; count: string }>();
        return new Map(rows.map((r) => [r.parkId, Number(r.count)]));
    }

    /** Parks this ride has already been offered to, for sequential fallback. */
    static async parksAlreadyTried(rideId: string): Promise<string[]> {
        const jobs = await AppDataSource.getRepository(ParkDispatchJob).find({
            where: { rideId },
            select: ['parkId'],
        });
        return [...new Set(jobs.map((j) => j.parkId))];
    }

    /**
     * Whether a driver's presence permits being handed a ride right now.
     *
     * Read directly by the assignment path — a driver who walked off between
     * the dispatcher opening the queue and tapping assign must be caught.
     */
    static async isDriverPresenceAssignable(driverId: string, parkId: string): Promise<{ ok: boolean; state: DriverPresenceState | null }> {
        const presence = await AppDataSource.getRepository(DriverPresence).findOneBy({ driverId });
        if (!presence) return { ok: false, state: null };
        const ok = ASSIGNABLE_PRESENCE_STATES.includes(presence.state) && presence.parkId === parkId;
        return { ok, state: presence.state };
    }

    /** Assignable driver ids at a park, longest-waiting first. */
    static async assignableDriverIds(parkId: string): Promise<string[]> {
        const rows = await AppDataSource.getRepository(DriverPresence).find({
            where: { parkId, state: In(ASSIGNABLE_PRESENCE_STATES) },
            order: { since: 'ASC' },
        });
        return rows.map((r) => r.driverId);
    }
}
