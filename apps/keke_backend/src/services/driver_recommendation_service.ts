/**
 * Which driver should the dispatcher pick.
 *
 * The dispatcher should not have to think. A passenger is waiting, the
 * dispatcher has seconds, and asking them to weigh seven attributes in their
 * head is how the wrong driver gets picked — or the right one gets picked
 * slowly, which is the same thing to the passenger.
 *
 * So the ranking does the weighing and shows its work through BADGES. The
 * dispatcher sees an ordered list with the best driver first and a short,
 * honest reason on each row. They can always override; the recommendation is a
 * default, not a decision.
 *
 * ── What the score is NOT ───────────────────────────────────────────────
 * It is not a performance rating and must never become one. It contains no
 * measure of how "good" a driver is, no earnings, no passenger ratings, and
 * nothing that would make a driver's livelihood depend on an opaque number.
 * Every input is either an operational fact (are they here, are they free) or
 * a hard eligibility gate (wallet, KYC, badge) they can see and fix.
 */
import { RosterEntry } from '../repositories/park_roster_repository';
import { ParkRosterService } from './park_roster_service';
import { DriverPresenceState } from '../models/DriverPresence';
import { ParkDispatchJobRepository } from '../repositories/park_dispatch_job_repository';
import { ParkDispatchJob } from '../models/ParkDispatchJob';
import { AppDataSource } from '../config/data_source';
import { DispatchEvent, DispatchEventType } from '../models/DispatchEvent';
import { haversineMeters } from './ride_integrity_service';

/** Badges the dispatcher sees. Short, honest, and never euphemistic. */
export type DriverBadgeTag =
    | 'recommended'
    | 'nearby'
    | 'returning_soon'
    | 'busy'
    | 'offline'
    | 'wallet_blocked'
    | 'feature_phone'
    | 'smartphone'
    | 'no_badge'
    | 'declined_this_ride'
    | 'out_of_park'
    | 'suspended';

export interface RecommendedDriver extends RosterEntry {
    /** 0–100. Higher is a better fit RIGHT NOW, not a better driver. */
    score: number;
    /** Ordered badges, most important first. */
    badges: DriverBadgeTag[];
    /** One line explaining the ranking, shown under the name. */
    reason: string;
    assignable: boolean;
    problems: Array<{ code: string; message: string }>;
    /** True for the top assignable driver. Exactly one per list. */
    recommended: boolean;
    /** Straight-line metres from the driver's park to the pickup. */
    distanceToPickupM: number | null;
    /** Share of park offers this driver has accepted, 0–1. Null when unknown. */
    acceptanceRate: number | null;
    /** Rides this driver has been assigned today. */
    workloadToday: number;
    requiresVerbalAssignment: boolean;
}

/**
 * Weights, as plain numbers so the ranking can be read and argued with.
 *
 * Presence dominates by design: a driver standing in the park ready to go beats
 * every other consideration, because that is the entire problem park dispatch
 * exists to solve.
 */
const WEIGHTS = {
    waiting: 40,          // in the queue, ready
    atPark: 28,           // present but not queued
    queuePosition: 15,    // fairness — front of the queue scores higher
    acceptance: 10,       // has historically taken park offers
    lowWorkload: 7,       // spread work across the roster
} as const;

export class DriverRecommendationService {
    /**
     * Rank every roster driver at a park for one specific ride.
     *
     * Returns ALL of them, assignable or not, in score order. Hiding the
     * unassignable ones would leave a dispatcher wondering where somebody went
     * and re-asking the queue; showing them with a reason answers the question
     * before it is asked.
     */
    static async rankForJob(args: {
        parkId: string;
        pickup?: { lat: number; lng: number } | null;
        parkLocation?: { lat: number; lng: number } | null;
        /** Drivers who already declined THIS ride. */
        declinedDriverIds?: string[];
    }): Promise<RecommendedDriver[]> {
        const roster = await ParkRosterService.view(args.parkId, {});
        if (roster.length === 0) return [];

        const declined = new Set(args.declinedDriverIds ?? []);
        const driverIds = roster.map((r) => r.driverId);
        const [acceptance, workload] = await Promise.all([
            this.acceptanceRates(driverIds),
            this.workloadToday(driverIds),
        ]);

        // Distance from the PARK to the pickup is the same for every driver at
        // that park, so it does not separate them. It is shown because a
        // dispatcher wants to know how far the trip starts from, not because it
        // ranks anybody.
        const distanceToPickupM = args.pickup && args.parkLocation
            ? Math.round(haversineMeters(args.parkLocation, args.pickup))
            : null;

        const maxQueuePosition = Math.max(
            1,
            ...roster.map((r) => r.queuePosition ?? 0),
        );

        const ranked: RecommendedDriver[] = roster.map((entry) => {
            const problems = ParkRosterService.assignabilityProblems(entry);
            const hardProblems = problems.filter((p) => !['not_waiting', 'presence_unknown'].includes(p.code));
            const presenceOk = entry.presenceState === DriverPresenceState.WAITING
                || entry.presenceState === DriverPresenceState.AT_PARK;
            const hasDeclined = declined.has(entry.driverId);
            const assignable = hardProblems.length === 0 && presenceOk && !hasDeclined;

            let score = 0;
            if (entry.presenceState === DriverPresenceState.WAITING) score += WEIGHTS.waiting;
            else if (entry.presenceState === DriverPresenceState.AT_PARK) score += WEIGHTS.atPark;

            // Front of the queue scores higher. This is what makes the
            // recommendation agree with the fairness rules rather than quietly
            // competing with them.
            if (entry.queuePosition != null) {
                const positionScore = 1 - (entry.queuePosition - 1) / maxQueuePosition;
                score += WEIGHTS.queuePosition * Math.max(0, positionScore);
            }

            const rate = acceptance.get(entry.driverId) ?? null;
            // An unknown rate scores as neutral, not as zero. A driver's first
            // park offer must not be penalised for having no history.
            score += WEIGHTS.acceptance * (rate ?? 0.6);

            const today = workload.get(entry.driverId) ?? 0;
            score += WEIGHTS.lowWorkload * Math.max(0, 1 - today / 8);

            // Anything that makes them unassignable zeroes the score. A driver
            // who cannot take the ride must never outrank one who can, however
            // well they score on everything else.
            if (!assignable) score = 0;

            const badges = this.badgesFor(entry, { assignable, hasDeclined, presenceOk, problems });

            return {
                ...entry,
                score: Math.round(score),
                badges,
                reason: this.reasonFor(entry, { assignable, hasDeclined, problems, queuePosition: entry.queuePosition }),
                assignable,
                problems: hasDeclined
                    ? [...problems, { code: 'declined_this_ride', message: 'Already declined this ride' }]
                    : problems,
                recommended: false,
                distanceToPickupM,
                acceptanceRate: rate,
                workloadToday: today,
                requiresVerbalAssignment: !entry.smartphoneCapable,
            };
        });

        ranked.sort((a, b) => {
            if (a.assignable !== b.assignable) return a.assignable ? -1 : 1;
            if (b.score !== a.score) return b.score - a.score;
            // Stable tie-break on queue position keeps the order identical
            // between two refreshes, which matters when somebody is about to tap.
            return (a.queuePosition ?? 9999) - (b.queuePosition ?? 9999);
        });

        const top = ranked.find((r) => r.assignable);
        if (top) {
            top.recommended = true;
            top.badges = ['recommended', ...top.badges.filter((b) => b !== 'recommended')];
        }
        return ranked;
    }

    /** The badges shown on a driver row, most important first. */
    private static badgesFor(
        entry: RosterEntry,
        ctx: { assignable: boolean; hasDeclined: boolean; presenceOk: boolean; problems: Array<{ code: string }> },
    ): DriverBadgeTag[] {
        const badges: DriverBadgeTag[] = [];

        if (ctx.hasDeclined) badges.push('declined_this_ride');

        if (ctx.problems.some((p) => p.code === 'wallet_blocked')) badges.push('wallet_blocked');
        if (ctx.problems.some((p) => p.code === 'roster_suspended' || p.code === 'driver_suspended')) badges.push('suspended');
        if (ctx.problems.some((p) => p.code === 'no_badge')) badges.push('no_badge');

        switch (entry.presenceState) {
            case DriverPresenceState.WAITING:
                badges.push('nearby');
                break;
            case DriverPresenceState.AT_PARK:
                badges.push('nearby');
                break;
            case DriverPresenceState.TRIP_STARTED:
            case DriverPresenceState.PASSENGER_BOARDING:
                badges.push('busy');
                break;
            case DriverPresenceState.EN_ROUTE:
            case DriverPresenceState.ASSIGNED:
                // On a job but heading back toward the park afterwards. Worth
                // showing so a dispatcher can hold a request for thirty seconds
                // rather than skipping it.
                badges.push('returning_soon');
                break;
            case DriverPresenceState.OFFLINE:
                badges.push('offline');
                break;
            case DriverPresenceState.ONLINE:
                badges.push('out_of_park');
                break;
            case DriverPresenceState.UNAVAILABLE:
                badges.push('busy');
                break;
            default:
                badges.push('offline');
        }

        badges.push(entry.smartphoneCapable ? 'smartphone' : 'feature_phone');
        return badges;
    }

    /** One honest line under the driver's name. */
    private static reasonFor(
        entry: RosterEntry,
        ctx: { assignable: boolean; hasDeclined: boolean; problems: Array<{ message: string; code: string }>; queuePosition: number | null },
    ): string {
        if (ctx.hasDeclined) return 'Already declined this ride';
        if (!ctx.assignable) {
            const hard = ctx.problems.find((p) => !['not_waiting', 'presence_unknown'].includes(p.code));
            if (hard) return hard.message;
            if (entry.presenceState) return `Currently ${entry.presenceState.replace(/_/g, ' ')}`;
            return 'Presence not recorded';
        }
        const parts: string[] = [];
        if (ctx.queuePosition != null) parts.push(`#${ctx.queuePosition} in queue`);
        if (entry.presenceState === DriverPresenceState.WAITING) parts.push('waiting now');
        else parts.push('at the park');
        if (!entry.smartphoneCapable) parts.push('assign verbally');
        return parts.join(' · ');
    }

    /**
     * Share of park offers each driver has accepted.
     *
     * Uses the dispatch event trail rather than a stored counter, so it cannot
     * drift and needs no backfill. Drivers with no history return null and are
     * scored neutrally — a first offer must not be penalised.
     */
    static async acceptanceRates(driverIds: string[], sinceDays = 30): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        if (driverIds.length === 0) return out;

        const since = new Date(Date.now() - sinceDays * 86_400_000);
        const rows = await AppDataSource.getRepository(DispatchEvent)
            .createQueryBuilder('e')
            .select('e."driverId"', 'driverId')
            .addSelect('e."eventType"', 'eventType')
            .addSelect('COUNT(*)', 'count')
            .where('e."driverId" IN (:...driverIds)', { driverIds })
            .andWhere('e."eventType" IN (:...types)', {
                types: [
                    DispatchEventType.PARK_DRIVER_OFFERED,
                    DispatchEventType.PARK_DRIVER_ACCEPTED,
                    DispatchEventType.PARK_DRIVER_DECLINED,
                ],
            })
            .andWhere('e."occurredAt" >= :since', { since })
            .groupBy('e."driverId"').addGroupBy('e."eventType"')
            .getRawMany<{ driverId: string; eventType: string; count: string }>();

        const byDriver = new Map<string, { offered: number; accepted: number }>();
        for (const row of rows) {
            const entry = byDriver.get(row.driverId) ?? { offered: 0, accepted: 0 };
            if (row.eventType === DispatchEventType.PARK_DRIVER_OFFERED) entry.offered += Number(row.count);
            if (row.eventType === DispatchEventType.PARK_DRIVER_ACCEPTED) entry.accepted += Number(row.count);
            byDriver.set(row.driverId, entry);
        }
        for (const [driverId, { offered, accepted }] of byDriver) {
            if (offered > 0) out.set(driverId, Math.min(1, accepted / offered));
        }
        return out;
    }

    /** Park assignments each driver has taken since midnight. */
    static async workloadToday(driverIds: string[]): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        if (driverIds.length === 0) return out;

        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);

        const rows = await AppDataSource.getRepository(ParkDispatchJob)
            .createQueryBuilder('j')
            .select('j."assignedDriverId"', 'driverId')
            .addSelect('COUNT(*)', 'count')
            .where('j."assignedDriverId" IN (:...driverIds)', { driverIds })
            .andWhere('j."assignedAt" >= :midnight', { midnight })
            .groupBy('j."assignedDriverId"')
            .getRawMany<{ driverId: string; count: string }>();

        for (const row of rows) out.set(row.driverId, Number(row.count));
        return out;
    }

    /** Drivers who already declined a specific job, for the ranking to demote. */
    static async declinedFor(jobId: string): Promise<string[]> {
        const job = await ParkDispatchJobRepository.findById(jobId);
        return job?.declinedDriverIds ?? [];
    }
}
