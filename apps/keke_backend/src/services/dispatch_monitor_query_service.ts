/**
 * Read side of the Live Ride Requests monitor.
 *
 * Composes the four separated tiers without mixing them:
 *   1. LIVE TRANSIENT  — the in-memory DispatchRun ledger, injected by the socket
 *                        handler. Authoritative for "right now" (current round,
 *                        active radius) and lost on restart, by design.
 *   2. PERSISTED       — dispatch_event rows. Durable, ordered, no personal data.
 *   3. ANALYTICS       — aggregates over the same rows.
 *   4. PII             — User/DriverProfile, joined last and MASKED by default.
 *
 * Nothing here re-implements eligibility, reservation or nearby-driver logic; it
 * only reads what those systems already recorded.
 */
import { In, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Ride, RideStatus } from '../models/Ride';
import { User } from '../models/User';
import { DriverProfile } from '../models/DriverProfile';
import { DispatchEvent, DispatchEventType, OfferDeliveryState } from '../models/DispatchEvent';
import { DispatchMonitorService } from './dispatch_monitor_service';
import { StaleRideService, RideSnapshot } from './stale_ride_service';
import { loadStaleRideConfig } from '../config/stale_ride_config';
import { outcomeLabel, classifyOutcome, RideOutcomeCode } from './ride_outcome';

/** Ride statuses the monitor treats as "live". */
export const LIVE_RIDE_STATUSES: RideStatus[] = [
    RideStatus.SEARCHING,
    RideStatus.ACCEPTED,
    RideStatus.ARRIVED,
    RideStatus.IN_PROGRESS,
    RideStatus.STARTED,
];

/** Live context the socket handler can supply for an in-flight ride. */
export interface LiveDispatchContext {
    dispatchRound: number;
    radiusKm: number | null;
    eligibleDriverCount: number;
    offersSentCount: number;
    explicitRejectCount: number;
    expiredOfferCount: number;
    deliveryFailureCount: number;
    acknowledgedCount: number;
}

export type LiveContextResolver = (rideId: string) => LiveDispatchContext | null;

/**
 * Masks a Nigerian phone to a support-usable shape: enough to confirm identity
 * on a call, not enough to be a usable contact list export.
 */
export function maskPhone(phone?: string | null): string | null {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 6) return '•••';
    return `${digits.slice(0, 4)}••••${digits.slice(-3)}`;
}

/** Masks a name to first name plus surname initial. */
export function maskName(first?: string | null, last?: string | null): string {
    const f = (first || '').trim();
    const l = (last || '').trim();
    if (!f && !l) return 'Unknown';
    if (!l) return f;
    return `${f} ${l.charAt(0).toUpperCase()}.`;
}

export function maskEmail(email?: string | null): string | null {
    if (!email) return null;
    const [local, domain] = email.split('@');
    if (!domain) return '•••';
    const head = local.slice(0, 2);
    return `${head}${'•'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

/**
 * "Area" from a full address: the trailing locality, not the street.
 * Coarse on purpose — the list view is for supply patterns, not doorsteps.
 */
export function areaOf(address?: string | null): string | null {
    if (!address) return null;
    const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return parts.slice(-2).join(', ');
}

/**
 * Strongest delivery evidence held for one driver on one ride.
 *
 * Strictly ordered, never upgraded by inference: a queued offer with no
 * confirmation is UNKNOWN, not "probably delivered".
 */
export function resolveDeliveryState(events: DispatchEvent[]): OfferDeliveryState {
    const types = new Set(events.map((e) => e.eventType));
    if (types.has(DispatchEventType.DEVICE_OFFER_ACK)) return OfferDeliveryState.ACKNOWLEDGED;
    if (types.has(DispatchEventType.FCM_ACCEPTED_BY_PROVIDER)) return OfferDeliveryState.PROVIDER_ACCEPTED;
    if (types.has(DispatchEventType.SOCKET_OFFER_EMITTED)) return OfferDeliveryState.SOCKET_EMITTED;
    if (types.has(DispatchEventType.OFFER_DELIVERY_FAILED)) return OfferDeliveryState.FAILED;
    return OfferDeliveryState.UNKNOWN;
}

/**
 * What became of one candidate driver. Distinguishes the six operationally
 * different situations that all look like "no ride" from a naive count.
 */
export type CandidateOutcome =
    | 'accepted'
    | 'rejected'
    | 'expired'
    | 'delivery_failed'
    | 'stale_before_offer'
    | 'reservation_conflict'
    | 'ineligible'
    | 'cancelled_before_response'
    | 'awaiting_response';

export function resolveCandidateOutcome(
    events: DispatchEvent[],
    rideCancelled: boolean,
): CandidateOutcome {
    const types = new Set(events.map((e) => e.eventType));
    if (types.has(DispatchEventType.DRIVER_ACCEPTED)) return 'accepted';
    if (types.has(DispatchEventType.DRIVER_REJECTED)) return 'rejected';
    if (types.has(DispatchEventType.OFFER_EXPIRED)) return 'expired';
    if (types.has(DispatchEventType.OFFER_DELIVERY_FAILED)) return 'delivery_failed';
    if (types.has(DispatchEventType.CANDIDATE_STALE)) return 'stale_before_offer';
    if (types.has(DispatchEventType.RESERVATION_CONFLICT)) return 'reservation_conflict';
    if (types.has(DispatchEventType.ELIGIBILITY_REJECTED)) return 'ineligible';
    if (types.has(DispatchEventType.NOTIFICATION_QUEUED)) {
        return rideCancelled ? 'cancelled_before_response' : 'awaiting_response';
    }
    return 'awaiting_response';
}

/**
 * How overdue a live ride is, as a single label the admin UI can filter on.
 *
 * Derived from the same StaleRideService policy the sweeper uses, so the monitor
 * can never disagree with what the sweep is about to do.
 */
export type StaleClass =
    | 'ok'
    /** accepted past its ETA-aware arrival deadline. */
    | 'accepted_too_long'
    /** arrived but the trip was never started. */
    | 'arrived_not_started'
    /** in progress past its review threshold. */
    | 'in_progress_too_long'
    /** already flagged for a human. */
    | 'pending_operations_review'
    /** terminated by the system rather than by a person. */
    | 'system_auto_cancelled';

export function staleClassOf(ride: Ride): StaleClass {
    if (ride.requiresOperationsReview) return 'pending_operations_review';
    if (typeof ride.cancellationReason === 'string' && ride.cancellationReason.startsWith('SYSTEM_')) {
        return 'system_auto_cancelled';
    }

    const config = loadStaleRideConfig();
    const snapshot: RideSnapshot = {
        rideId: ride.rideId,
        status: ride.status as unknown as string,
        passengerId: ride.passengerId ?? null,
        driverId: ride.driverId ?? null,
        acceptedAt: ride.acceptedAt ?? null,
        arrivedAt: ride.arrivedAt ?? null,
        startedAt: ride.startedAt ?? null,
        completedAt: ride.completedAt ?? null,
        estimatedDurationSec: ride.estimatedDurationSec ?? null,
        acceptLat: Number.isFinite(Number(ride.acceptLat)) ? Number(ride.acceptLat) : null,
        acceptLng: Number.isFinite(Number(ride.acceptLng)) ? Number(ride.acceptLng) : null,
        pickupLat: Number.isFinite(Number(ride.pickupLat)) ? Number(ride.pickupLat) : null,
        pickupLng: Number.isFinite(Number(ride.pickupLng)) ? Number(ride.pickupLng) : null,
        staleWarnedAt: ride.staleWarnedAt ?? null,
        staleExtensionCount: ride.staleExtensionCount ?? 0,
        staleDeadlineOverrideAt: ride.staleDeadlineOverrideAt ?? null,
        requiresOperationsReview: ride.requiresOperationsReview ?? false,
        staleDecisionPromptedAt: ride.staleDecisionPromptedAt ?? null,
        staleDecisionDeadlineAt: ride.staleDecisionDeadlineAt ?? null,
        staleDecisionBy: ride.staleDecisionBy ?? null,
        staleDecisionChoice: ride.staleDecisionChoice ?? null,
        staleDecisionRound: ride.staleDecisionRound ?? 0,
        lastActivityAt: ride.lastActivityAt ?? null,
        lastActivityType: ride.lastActivityType ?? null,
        lastReminderAt: ride.lastReminderAt ?? null,
        // The monitor renders a coarse state label; liveness is resolved live by
        // the sweeper, so assume reachable here rather than guessing offline.
        driverLive: true,
        passengerLive: true,
        driverOfflineForMs: null,
        passengerOfflineForMs: null,
        cancellationRequestedBy: ride.cancellationRequestedBy ?? null,
        cancellationRequestedAt: ride.cancellationRequestedAt ?? null,
        cancellationRequestState: ride.cancellationRequestState ?? null,
        escalatedToSupportAt: ride.escalatedToSupportAt ?? null,
    };

    const evaluation = StaleRideService.evaluate(snapshot, config, new Date());
    if (evaluation.action === 'none') return 'ok';
    if (evaluation.action === 'flag_for_review') return 'in_progress_too_long';
    // 'warn' and 'cancel' both mean overdue; the state says which kind.
    return snapshot.status === 'arrived' ? 'arrived_not_started' : 'accepted_too_long';
}

export interface MonitorRollup {
    dispatchRound: number | null;
    radiusKm: number | null;
    candidateCount: number;
    eligibleDriverCount: number;
    reservedDriverCount: number;
    notifiedDriverCount: number;
    acknowledgedCount: number;
    rejectionCount: number;
    expiredOfferCount: number;
    deliveryFailureCount: number;
    staleCount: number;
    reservationConflictCount: number;
    finalOutcomeCode: string | null;
    source: 'live' | 'persisted';
}

export class DispatchMonitorQueryService {
    private static liveResolver: LiveContextResolver | null = null;

    /** Injected by the socket handler so live rides report in-memory truth. */
    static setLiveContextResolver(resolver: LiveContextResolver | null): void {
        this.liveResolver = resolver;
    }

    /** Rollup per ride, computed from the persisted event trail. */
    static async rollupsFor(rideIds: string[]): Promise<Map<string, MonitorRollup>> {
        const out = new Map<string, MonitorRollup>();
        if (rideIds.length === 0) return out;

        const rows: Array<{
            rideId: string;
            eventType: DispatchEventType;
            count: string;
            maxRound: string | null;
            maxRadius: string | null;
            driverCount: string;
        }> = await AppDataSource.getRepository(DispatchEvent)
            .createQueryBuilder('e')
            .select('e.rideId', 'rideId')
            .addSelect('e.eventType', 'eventType')
            .addSelect('COUNT(*)', 'count')
            .addSelect('MAX(e.dispatchRound)', 'maxRound')
            .addSelect('MAX(e.radiusKm)', 'maxRadius')
            .addSelect('COUNT(DISTINCT e.driverId)', 'driverCount')
            .where('e.rideId IN (:...rideIds)', { rideIds })
            .groupBy('e.rideId')
            .addGroupBy('e.eventType')
            .getRawMany();

        const outcomeRows = await AppDataSource.getRepository(DispatchEvent).find({
            where: { rideId: In(rideIds), eventType: DispatchEventType.DISPATCH_FAILED },
        });
        const outcomeByRide = new Map(
            outcomeRows.map((r) => [r.rideId, (r.detail?.outcomeCode as string) ?? null]),
        );

        for (const rideId of rideIds) {
            out.set(rideId, {
                dispatchRound: null,
                radiusKm: null,
                candidateCount: 0,
                eligibleDriverCount: 0,
                reservedDriverCount: 0,
                notifiedDriverCount: 0,
                acknowledgedCount: 0,
                rejectionCount: 0,
                expiredOfferCount: 0,
                deliveryFailureCount: 0,
                staleCount: 0,
                reservationConflictCount: 0,
                finalOutcomeCode: outcomeByRide.get(rideId) ?? null,
                source: 'persisted',
            });
        }

        for (const row of rows) {
            const target = out.get(row.rideId);
            if (!target) continue;
            const distinct = Number(row.driverCount) || 0;
            const count = Number(row.count) || 0;
            const round = row.maxRound != null ? Number(row.maxRound) : null;
            if (round != null && (target.dispatchRound == null || round > target.dispatchRound)) {
                target.dispatchRound = round;
            }
            const radius = row.maxRadius != null ? Number(row.maxRadius) : null;
            if (radius != null && (target.radiusKm == null || radius > target.radiusKm)) {
                target.radiusKm = radius;
            }

            switch (row.eventType) {
                case DispatchEventType.CANDIDATE_DISCOVERED: target.candidateCount = distinct; break;
                case DispatchEventType.ELIGIBILITY_PASSED: target.eligibleDriverCount = distinct; break;
                case DispatchEventType.RESERVATION_ACQUIRED: target.reservedDriverCount = distinct; break;
                // "Notified" means an offer genuinely left the server for a
                // device — a queued-only offer is not counted as notified.
                case DispatchEventType.SOCKET_OFFER_EMITTED:
                case DispatchEventType.FCM_ACCEPTED_BY_PROVIDER:
                    target.notifiedDriverCount = Math.max(target.notifiedDriverCount, distinct);
                    break;
                case DispatchEventType.DEVICE_OFFER_ACK: target.acknowledgedCount = distinct; break;
                case DispatchEventType.DRIVER_REJECTED: target.rejectionCount = count; break;
                case DispatchEventType.OFFER_EXPIRED: target.expiredOfferCount = count; break;
                case DispatchEventType.OFFER_DELIVERY_FAILED: target.deliveryFailureCount = count; break;
                case DispatchEventType.CANDIDATE_STALE: target.staleCount = count; break;
                case DispatchEventType.RESERVATION_CONFLICT: target.reservationConflictCount = count; break;
                default: break;
            }
        }

        // Eligible count is not emitted as its own event by the orchestrator
        // (it logs rejections), so derive it honestly: discovered minus dropped.
        for (const [rideId, rollup] of out) {
            if (rollup.eligibleDriverCount === 0 && rollup.candidateCount > 0) {
                const dropped = rollup.staleCount + rollup.reservationConflictCount;
                rollup.eligibleDriverCount = Math.max(0, rollup.candidateCount - dropped);
            }
            // Live in-memory truth wins for an in-flight ride.
            const live = this.liveResolver?.(rideId);
            if (live) {
                rollup.source = 'live';
                rollup.dispatchRound = live.dispatchRound;
                rollup.radiusKm = live.radiusKm ?? rollup.radiusKm;
                rollup.eligibleDriverCount = live.eligibleDriverCount;
                rollup.notifiedDriverCount = live.offersSentCount;
                rollup.rejectionCount = live.explicitRejectCount;
                rollup.expiredOfferCount = live.expiredOfferCount;
                rollup.deliveryFailureCount = live.deliveryFailureCount;
                rollup.acknowledgedCount = live.acknowledgedCount;
            }
        }

        return out;
    }

    /** The Live Ride Requests list. */
    static async liveRequests(opts: { statuses?: RideStatus[]; limit?: number } = {}) {
        const statuses = opts.statuses?.length ? opts.statuses : LIVE_RIDE_STATUSES;
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

        const rides = await AppDataSource.getRepository(Ride).find({
            where: { status: In(statuses) },
            order: { createdAt: 'DESC' },
            take: limit,
        });
        if (rides.length === 0) return { requests: [], counts: {}, serverTime: new Date().toISOString() };

        const [rollups, people] = await Promise.all([
            this.rollupsFor(rides.map((r) => r.rideId)),
            this.peopleFor(rides),
        ]);

        const requests = rides.map((ride) => {
            const rollup = rollups.get(ride.rideId)!;
            const passenger = people.passengers.get(ride.passengerId);
            const driver = ride.driverId ? people.drivers.get(ride.driverId) : null;
            const createdMs = new Date(ride.createdAt).getTime();

            return {
                rideId: ride.rideId,
                status: ride.status,
                // MASKED BY DEFAULT — unmasking is a separate audited call.
                passengerName: maskName(passenger?.firstName, passenger?.lastName),
                passengerPhoneMasked: maskPhone(passenger?.phone),
                passengerId: ride.passengerId,
                pickupArea: areaOf(ride.pickupAddress),
                destinationArea: areaOf(ride.destinationAddress),
                requestedAt: new Date(ride.createdAt).toISOString(),
                requestAgeSec: Math.max(0, Math.floor((Date.now() - createdMs) / 1000)),
                estimatedFare: ride.fare != null ? Number(ride.fare) : null,
                estimatedDistanceM: ride.estimatedDistanceM ?? null,
                estimatedDurationSec: ride.estimatedDurationSec ?? null,
                paymentMode: ride.paymentMode,
                dispatchRound: rollup.dispatchRound,
                searchRadiusKm: rollup.radiusKm,
                eligibleDriverCount: rollup.eligibleDriverCount,
                notifiedDriverCount: rollup.notifiedDriverCount,
                acknowledgedCount: rollup.acknowledgedCount,
                rejectionCount: rollup.rejectionCount,
                expiredOfferCount: rollup.expiredOfferCount,
                deliveryFailureCount: rollup.deliveryFailureCount,
                finalOutcomeCode: rollup.finalOutcomeCode,
                dataSource: rollup.source,
                // Stale-lifecycle visibility. `staleClass` is a single derived
                // label so the UI does not have to recompute the policy.
                staleClass: staleClassOf(ride),
                requiresOperationsReview: ride.requiresOperationsReview === true,
                staleReason: ride.staleReason ?? null,
                staleDetectedAt: ride.staleDetectedAt ? new Date(ride.staleDetectedAt).toISOString() : null,
                staleWarnedAt: ride.staleWarnedAt ? new Date(ride.staleWarnedAt).toISOString() : null,
                staleExtensionCount: ride.staleExtensionCount ?? 0,
                cancellationReason: ride.cancellationReason ?? null,
                assignedDriver: driver
                    ? {
                          driverId: driver.userId,
                          name: maskName(driver.firstName, driver.lastName),
                          phoneMasked: maskPhone(people.driverPhones.get(driver.userId)),
                          vehiclePlate: driver.vehiclePlate ?? null,
                          vehicleModel: driver.vehicleModel ?? null,
                      }
                    : null,
                pickup: this.coords(ride.pickupLat, ride.pickupLng),
                destination: this.coords(ride.destinationLat, ride.destinationLng),
            };
        });

        const counts: Record<string, number> = {};
        for (const r of requests) counts[r.status] = (counts[r.status] ?? 0) + 1;

        return { requests, counts, serverTime: new Date().toISOString() };
    }

    private static coords(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
        const a = Number(lat);
        const b = Number(lng);
        if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
        return { lat: a, lng: b };
    }

    /** PII join, kept in one place so masking cannot be forgotten at a call site. */
    /**
     * Passenger users, driver profiles and driver phones for a set of rides,
     * in three batched queries regardless of page size.
     *
     * Public so RideOperationsService can reuse it: the operations console and
     * the live monitor must resolve identity the same way, or the same ride
     * would render two different names depending on which page you opened.
     */
    static async peopleFor(rides: Ride[]) {
        const passengerIds = [...new Set(rides.map((r) => r.passengerId).filter(Boolean))];
        const driverIds = [...new Set(rides.map((r) => r.driverId).filter(Boolean))] as string[];

        const [passengers, drivers, driverUsers] = await Promise.all([
            passengerIds.length
                ? AppDataSource.getRepository(User).find({ where: { id: In(passengerIds) } })
                : Promise.resolve([]),
            driverIds.length
                ? AppDataSource.getRepository(DriverProfile).find({ where: { userId: In(driverIds) } })
                : Promise.resolve([]),
            driverIds.length
                ? AppDataSource.getRepository(User).find({ where: { id: In(driverIds) } })
                : Promise.resolve([]),
        ]);

        return {
            passengers: new Map(passengers.map((u) => [u.id, u])),
            drivers: new Map(drivers.map((d) => [d.userId, d])),
            driverPhones: new Map(driverUsers.map((u) => [u.id, u.phone as string | null])),
        };
    }

    /** Full detail for one ride: trip, dispatch summary and driver timeline. */
    static async requestDetail(rideId: string) {
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (!ride) return null;

        const events = await AppDataSource.getRepository(DispatchEvent).find({
            where: { rideId },
            order: { sequence: 'ASC' },
        });

        const rollups = await this.rollupsFor([rideId]);
        const rollup = rollups.get(rideId)!;
        const people = await this.peopleFor([ride]);
        const passenger = people.passengers.get(ride.passengerId);

        // Passenger history summary — counts only, no trip details.
        const rideRepo = AppDataSource.getRepository(Ride);
        const [completedCount, cancelledCount] = await Promise.all([
            rideRepo.count({ where: { passengerId: ride.passengerId, status: RideStatus.COMPLETED } }),
            rideRepo.count({ where: { passengerId: ride.passengerId, status: RideStatus.CANCELED } }),
        ]);

        const rideCancelled = (ride.status as unknown as string) === 'canceled';

        // Group per candidate driver.
        const byDriver = new Map<string, DispatchEvent[]>();
        for (const e of events) {
            if (!e.driverId) continue;
            const list = byDriver.get(e.driverId) ?? [];
            list.push(e);
            byDriver.set(e.driverId, list);
        }

        const driverProfiles = byDriver.size
            ? await AppDataSource.getRepository(DriverProfile).find({
                  where: { userId: In([...byDriver.keys()]) },
              })
            : [];
        const profileById = new Map(driverProfiles.map((p) => [p.userId, p]));

        const candidates = [...byDriver.entries()].map(([driverId, driverEvents]) => {
            const profile = profileById.get(driverId);
            const first = driverEvents[0];
            const discovered = driverEvents.find((e) => e.eventType === DispatchEventType.CANDIDATE_DISCOVERED);
            const queued = driverEvents.find((e) => e.eventType === DispatchEventType.NOTIFICATION_QUEUED);
            const responded = driverEvents.find(
                (e) =>
                    e.eventType === DispatchEventType.DRIVER_REJECTED ||
                    e.eventType === DispatchEventType.DRIVER_ACCEPTED,
            );

            return {
                driverId,
                name: maskName(profile?.firstName, profile?.lastName),
                vehiclePlate: profile?.vehiclePlate ?? null,
                vehicleModel: profile?.vehicleModel ?? null,
                dispatchRound: first?.dispatchRound ?? null,
                distanceKm: discovered?.distanceKm ?? null,
                heartbeatAgeMs: discovered?.heartbeatAgeMs ?? first?.heartbeatAgeMs ?? null,
                locationAgeMs: discovered?.locationAgeMs ?? first?.locationAgeMs ?? null,
                deliveryState: resolveDeliveryState(driverEvents),
                outcome: resolveCandidateOutcome(driverEvents, rideCancelled),
                // Never collected today; surfaced explicitly so the UI can say so.
                rejectionReasonCollected: false,
                responseTimeMs:
                    queued && responded
                        ? new Date(responded.occurredAt).getTime() - new Date(queued.occurredAt).getTime()
                        : null,
                events: driverEvents.map((e) => ({
                    eventType: e.eventType,
                    occurredAt: new Date(e.occurredAt).toISOString(),
                    dispatchRound: e.dispatchRound,
                    detail: e.detail,
                })),
            };
        });

        const acceptedEvent = events.find((e) => e.eventType === DispatchEventType.DRIVER_ACCEPTED);

        const driverProfile = ride.driverId ? profileById.get(ride.driverId) ?? null : null;

        return {
            ride: {
                rideId: ride.rideId,
                status: ride.status,
                createdAt: new Date(ride.createdAt).toISOString(),
                pickup: this.coords(ride.pickupLat, ride.pickupLng),
                // The full address as captured at request time, alongside the
                // coarse area. Operations reads "Awada", not a coordinate pair
                // — and neither is re-geocoded here, so opening a ride costs no
                // third-party API call.
                pickupAddress: ride.pickupAddress ?? null,
                pickupArea: areaOf(ride.pickupAddress),
                destination: this.coords(ride.destinationLat, ride.destinationLng),
                destinationAddress: ride.destinationAddress ?? null,
                destinationArea: areaOf(ride.destinationAddress),
                estimatedFare: ride.fare != null ? Number(ride.fare) : null,
                finalFare: ride.finalFare != null ? Number(ride.finalFare) : null,
                estimatedDistanceM: ride.estimatedDistanceM ?? null,
                estimatedDurationSec: ride.estimatedDurationSec ?? null,
                paymentMode: ride.paymentMode,
                acceptedAt: ride.acceptedAt ? new Date(ride.acceptedAt).toISOString() : null,
                arrivedAt: ride.arrivedAt ? new Date(ride.arrivedAt).toISOString() : null,
                startedAt: ride.startedAt ? new Date(ride.startedAt).toISOString() : null,
                completedAt: ride.completedAt ? new Date(ride.completedAt).toISOString() : null,

                // WHY it ended. `outcomeRecorded: false` is the honest signal
                // that this ride predates the trail — the console renders it as
                // "Reason unavailable — legacy ride" rather than as an em dash,
                // which would read as "nothing went wrong".
                outcomeReason: ride.outcomeReason ?? null,
                outcomeLabel: outcomeLabel(ride.outcomeReason),
                outcomeClass: classifyOutcome(ride.outcomeReason as RideOutcomeCode | null),
                outcomeRecorded: ride.outcomeReason != null,
                outcomeDetail: ride.outcomeDetail ?? null,
                cancelledByRole: ride.cancelledByRole ?? null,
                cancellationReason: ride.cancellationReason ?? null,

                dispatchMode: ride.dispatchMode ?? 'direct',
                assignmentMode: ride.assignmentMode ?? null,
                tripDurationSec: ride.tripDurationSec ?? null,
            },

            // A ride with no driver says so explicitly. An absent block would
            // render as an empty panel, which reads as a loading failure.
            driver: ride.driverId
                ? {
                      driverId: ride.driverId,
                      name: maskName(driverProfile?.firstName, driverProfile?.lastName),
                      phoneMasked: maskPhone(people.driverPhones.get(ride.driverId)),
                      vehiclePlate: driverProfile?.vehiclePlate ?? null,
                      vehicleModel: driverProfile?.vehicleModel ?? null,
                      driverStatus: driverProfile?.status ?? null,
                      acceptedAt: ride.acceptedAt ? new Date(ride.acceptedAt).toISOString() : null,
                  }
                : null,
            passenger: {
                passengerId: ride.passengerId,
                name: maskName(passenger?.firstName, passenger?.lastName),
                phoneMasked: maskPhone(passenger?.phone),
                emailMasked: maskEmail(passenger?.email),
                completedRides: completedCount,
                cancelledRides: cancelledCount,
                appVersion: (events.find((e) => e.eventType === DispatchEventType.RIDE_CREATED)?.detail
                    ?.appVersion as string) ?? null,
                platform: (events.find((e) => e.eventType === DispatchEventType.RIDE_CREATED)?.detail
                    ?.platform as string) ?? null,
            },
            dispatchSummary: {
                ...rollup,
                timeToAssignmentMs:
                    (acceptedEvent?.detail?.timeToAssignmentMs as number | undefined) ?? null,
                acceptedAt: acceptedEvent ? new Date(acceptedEvent.occurredAt).toISOString() : null,
            },
            candidates,
            timeline: this.buildTimeline(ride, events, profileById),
        };
    }

    /**
     * The chronological story of one ride, from two authoritative sources.
     *
     * The dispatch trail covers request → assignment. What happens AFTER a
     * driver accepts — arrival, trip start, completion — is not in that trail:
     * those transitions are recorded as timestamps on the ride row itself, by
     * RideIntegrityService, because they carry GPS evidence that belongs with
     * the ride rather than with dispatch. Neither source is complete alone.
     *
     * So the two are merged here rather than a third being invented. Nothing is
     * synthesised: every entry corresponds to a row or a non-null timestamp
     * that something actually wrote. A ride missing `arrivedAt` simply has no
     * arrival entry — the timeline stays short rather than being padded out
     * with plausible-looking steps.
     */
    private static buildTimeline(
        ride: Ride,
        events: DispatchEvent[],
        profileById: Map<string, DriverProfile>,
    ) {
        type Entry = {
            sequence: number;
            source: 'dispatch_event' | 'ride_record';
            eventType: string;
            occurredAt: string;
            driverId: string | null;
            driverName: string | null;
            dispatchRound: number | null;
            radiusKm: number | null;
            distanceKm: number | null;
            heartbeatAgeMs: number | null;
            locationAgeMs: number | null;
            detail: Record<string, unknown> | null;
        };

        const entries: Entry[] = events.map((e) => ({
            sequence: e.sequence,
            source: 'dispatch_event',
            eventType: e.eventType,
            occurredAt: new Date(e.occurredAt).toISOString(),
            driverId: e.driverId,
            driverName: e.driverId
                ? maskName(profileById.get(e.driverId)?.firstName, profileById.get(e.driverId)?.lastName)
                : null,
            dispatchRound: e.dispatchRound,
            radiusKm: e.radiusKm,
            distanceKm: e.distanceKm,
            heartbeatAgeMs: e.heartbeatAgeMs,
            locationAgeMs: e.locationAgeMs,
            detail: e.detail,
        }));

        const driverName = ride.driverId
            ? maskName(profileById.get(ride.driverId)?.firstName, profileById.get(ride.driverId)?.lastName)
            : null;

        const lifecycle: Array<[Date | null | undefined, string, Record<string, unknown> | null]> = [
            [ride.arrivedAt, 'driver_arrived', ride.arrivedPickupDistanceM != null
                ? { distanceFromPickupM: Math.round(Number(ride.arrivedPickupDistanceM)) } : null],
            [ride.startedAt, 'trip_started', null],
            // A terminal completedAt is also stamped on cancellations, so it is
            // only read as a completion when the ride actually completed.
            [ride.status === RideStatus.COMPLETED ? ride.completedAt : null, 'trip_completed',
                ride.tripDurationSec != null ? { tripDurationSec: ride.tripDurationSec } : null],
        ];

        for (const [at, eventType, detail] of lifecycle) {
            if (!at) continue;
            entries.push({
                // Sorted by time below; sequence only orders same-millisecond
                // dispatch rows, and these never collide with those.
                sequence: Number.MAX_SAFE_INTEGER,
                source: 'ride_record',
                eventType,
                occurredAt: new Date(at).toISOString(),
                driverId: ride.driverId ?? null,
                driverName,
                dispatchRound: null,
                radiusKm: null,
                distanceKm: null,
                heartbeatAgeMs: null,
                locationAgeMs: null,
                detail,
            });
        }

        return entries.sort((a, b) => {
            const t = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
            return t !== 0 ? t : a.sequence - b.sequence;
        });
    }

    /**
     * Driver behaviour metrics over a window.
     *
     * Descriptive only. It reports what happened and deliberately separates the
     * causes an operator would act on differently — a driver whose device never
     * received the offer needs battery-settings help, not a training session, and
     * neither is expressible as a single "bad driver" score. No scoring, ranking
     * or penalty is produced here.
     */
    static async driverMetrics(opts: { sinceHours?: number; driverId?: string; limit?: number } = {}) {
        const sinceHours = Math.min(Math.max(opts.sinceHours ?? 24, 1), 24 * 30);
        const since = new Date(Date.now() - sinceHours * 3600_000);
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

        const qb = AppDataSource.getRepository(DispatchEvent)
            .createQueryBuilder('e')
            .select('e.driverId', 'driverId')
            .addSelect('e.eventType', 'eventType')
            .addSelect('COUNT(*)', 'count')
            .where('e.driverId IS NOT NULL')
            .andWhere('e.createdAt >= :since', { since })
            .groupBy('e.driverId')
            .addGroupBy('e.eventType');
        if (opts.driverId) qb.andWhere('e.driverId = :driverId', { driverId: opts.driverId });

        const rows: Array<{ driverId: string; eventType: DispatchEventType; count: string }> =
            await qb.getRawMany();

        interface Acc {
            driverId: string;
            offersQueued: number;
            offersNotified: number;
            acknowledged: number;
            accepted: number;
            rejected: number;
            expired: number;
            deliveryFailures: number;
            staleOccurrences: number;
            reservationConflicts: number;
            ineligibleOccurrences: number;
        }
        const acc = new Map<string, Acc>();
        const blank = (driverId: string): Acc => ({
            driverId,
            offersQueued: 0,
            offersNotified: 0,
            acknowledged: 0,
            accepted: 0,
            rejected: 0,
            expired: 0,
            deliveryFailures: 0,
            staleOccurrences: 0,
            reservationConflicts: 0,
            ineligibleOccurrences: 0,
        });

        for (const row of rows) {
            const entry = acc.get(row.driverId) ?? blank(row.driverId);
            const n = Number(row.count) || 0;
            switch (row.eventType) {
                case DispatchEventType.NOTIFICATION_QUEUED: entry.offersQueued += n; break;
                case DispatchEventType.SOCKET_OFFER_EMITTED:
                case DispatchEventType.FCM_ACCEPTED_BY_PROVIDER:
                    entry.offersNotified = Math.max(entry.offersNotified, n);
                    break;
                case DispatchEventType.DEVICE_OFFER_ACK: entry.acknowledged += n; break;
                case DispatchEventType.DRIVER_ACCEPTED: entry.accepted += n; break;
                case DispatchEventType.DRIVER_REJECTED: entry.rejected += n; break;
                case DispatchEventType.OFFER_EXPIRED: entry.expired += n; break;
                case DispatchEventType.OFFER_DELIVERY_FAILED: entry.deliveryFailures += n; break;
                case DispatchEventType.CANDIDATE_STALE: entry.staleOccurrences += n; break;
                case DispatchEventType.RESERVATION_CONFLICT: entry.reservationConflicts += n; break;
                case DispatchEventType.ELIGIBILITY_REJECTED: entry.ineligibleOccurrences += n; break;
                default: break;
            }
            acc.set(row.driverId, entry);
        }

        // Median response time per driver, from queued -> explicit response.
        const responseRows: Array<{ driverId: string; rideId: string; eventType: string; occurredAt: Date }> =
            await AppDataSource.getRepository(DispatchEvent)
                .createQueryBuilder('e')
                .select(['e.driverId AS "driverId"', 'e.rideId AS "rideId"', 'e.eventType AS "eventType"', 'e.occurredAt AS "occurredAt"'])
                .where('e.driverId IS NOT NULL')
                .andWhere('e.createdAt >= :since', { since })
                .andWhere('e.eventType IN (:...types)', {
                    types: [
                        DispatchEventType.NOTIFICATION_QUEUED,
                        DispatchEventType.DRIVER_ACCEPTED,
                        DispatchEventType.DRIVER_REJECTED,
                    ],
                })
                .orderBy('e.occurredAt', 'ASC')
                .getRawMany();

        const queuedAt = new Map<string, number>();
        const samples = new Map<string, number[]>();
        for (const r of responseRows) {
            const key = `${r.rideId}:${r.driverId}`;
            const t = new Date(r.occurredAt).getTime();
            if (r.eventType === DispatchEventType.NOTIFICATION_QUEUED) {
                queuedAt.set(key, t);
            } else {
                const start = queuedAt.get(key);
                if (start != null) {
                    const list = samples.get(r.driverId) ?? [];
                    list.push(t - start);
                    samples.set(r.driverId, list);
                    queuedAt.delete(key);
                }
            }
        }

        const median = (values: number[]): number | null => {
            if (values.length === 0) return null;
            const sorted = [...values].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
        };

        const driverIds = [...acc.keys()];
        const profiles = driverIds.length
            ? await AppDataSource.getRepository(DriverProfile).find({ where: { userId: In(driverIds) } })
            : [];
        const profileById = new Map(profiles.map((p) => [p.userId, p]));

        const metrics = driverIds.map((driverId) => {
            const a = acc.get(driverId)!;
            const profile = profileById.get(driverId);
            const respondedCount = a.accepted + a.rejected;
            // Rate over offers genuinely notified, not over queued: a driver
            // cannot accept what never reached their phone.
            const denominator = a.offersNotified > 0 ? a.offersNotified : null;

            /** Suggested follow-up — advisory, never punitive. */
            const flags: string[] = [];
            if (a.deliveryFailures > 0) flags.push('notification_delivery_help');
            if (a.staleOccurrences >= 3) flags.push('battery_or_network_help');
            if (a.offersNotified >= 3 && a.acknowledged === 0) flags.push('ack_unsupported_or_app_update');
            if (a.expired >= 3 && a.rejected === 0) flags.push('operational_follow_up');
            if (denominator != null && a.rejected / denominator >= 0.7 && a.rejected >= 3) {
                flags.push('training_conversation');
            }

            return {
                driverId,
                name: maskName(profile?.firstName, profile?.lastName),
                vehiclePlate: profile?.vehiclePlate ?? null,
                status: profile?.status ?? null,
                offersQueued: a.offersQueued,
                offersNotified: a.offersNotified,
                deviceAcknowledged: a.acknowledged,
                accepted: a.accepted,
                explicitRejects: a.rejected,
                offerExpiries: a.expired,
                notificationDeliveryFailures: a.deliveryFailures,
                staleHeartbeatOccurrences: a.staleOccurrences,
                reservationConflicts: a.reservationConflicts,
                ineligibleOccurrences: a.ineligibleOccurrences,
                medianResponseMs: median(samples.get(driverId) ?? []),
                // Null rather than 0 when there is nothing to divide by, so the
                // UI shows "—" instead of implying a 0% acceptance rate.
                acceptanceRate: denominator ? Number((a.accepted / denominator).toFixed(3)) : null,
                respondedCount,
                suggestedFollowUp: flags,
                windowHours: sinceHours,
            };
        });

        metrics.sort((a, b) => b.offersNotified - a.offersNotified);
        return { metrics: metrics.slice(0, limit), windowHours: sinceHours, since: since.toISOString() };
    }

    /** Historical dispatch-event query with filters and pagination. */
    static async historicalEvents(filters: {
        rideId?: string;
        driverId?: string;
        eventTypes?: DispatchEventType[];
        from?: Date;
        to?: Date;
        dispatchRound?: number;
        limit?: number;
        offset?: number;
    }) {
        const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
        const offset = Math.max(filters.offset ?? 0, 0);

        const where: Record<string, unknown> = {};
        if (filters.rideId) where.rideId = filters.rideId;
        if (filters.driverId) where.driverId = filters.driverId;
        if (filters.eventTypes?.length) where.eventType = In(filters.eventTypes);
        if (filters.dispatchRound != null) where.dispatchRound = filters.dispatchRound;
        if (filters.from && filters.to) where.createdAt = Between(filters.from, filters.to);
        else if (filters.from) where.createdAt = MoreThanOrEqual(filters.from);
        else if (filters.to) where.createdAt = LessThanOrEqual(filters.to);

        const [rows, total] = await AppDataSource.getRepository(DispatchEvent).findAndCount({
            where,
            order: { createdAt: 'DESC', sequence: 'DESC' },
            take: limit,
            skip: offset,
        });

        return {
            events: rows.map((e) => ({
                id: e.id,
                rideId: e.rideId,
                sequence: e.sequence,
                eventType: e.eventType,
                dispatchRound: e.dispatchRound,
                driverId: e.driverId,
                radiusKm: e.radiusKm,
                distanceKm: e.distanceKm,
                heartbeatAgeMs: e.heartbeatAgeMs,
                locationAgeMs: e.locationAgeMs,
                detail: e.detail,
                occurredAt: new Date(e.occurredAt).toISOString(),
            })),
            total,
            limit,
            offset,
        };
    }

    /** Unmasked contact for support escalation. Caller MUST audit-log this. */
    static async revealContact(rideId: string) {
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (!ride) return null;
        const [passenger, driverUser] = await Promise.all([
            AppDataSource.getRepository(User).findOne({ where: { id: ride.passengerId } }),
            ride.driverId
                ? AppDataSource.getRepository(User).findOne({ where: { id: ride.driverId } })
                : Promise.resolve(null),
        ]);
        return {
            rideId,
            passenger: passenger
                ? { name: `${passenger.firstName} ${passenger.lastName}`.trim(), phone: passenger.phone, email: passenger.email }
                : null,
            driver: driverUser
                ? { name: `${driverUser.firstName} ${driverUser.lastName}`.trim(), phone: driverUser.phone }
                : null,
        };
    }
}

/** Re-exported so the socket handler can forget a ride's sequence counter. */
export { DispatchMonitorService };
