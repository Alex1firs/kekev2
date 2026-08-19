/**
 * Pure translation from orchestrator log events to durable admin-trail rows.
 *
 * Kept separate from the socket handler so the mapping is directly testable, and
 * so the rule it enforces is inspectable in one place: an orchestrator event is
 * only projected when there is an exact, honestly-nameable counterpart. Anything
 * softer is dropped rather than approximated — there is deliberately no path here
 * that can produce a "notification delivered" or "driver saw it" row.
 */
import { DispatchEventType } from '../models/DispatchEvent';
import type { RecordArgs } from './dispatch_monitor_service';

/** Orchestrator log events that carry no operator meaning of their own. */
const IGNORED = new Set([
    'no_target',            // absence of candidates; already implied by discovery rows
    'release',              // reservation bookkeeping
    'assign',              // duplicate of the accept handler's own row
    'dispatch_outcome',     // duplicate of dispatch_finished
    'dispatch_cancelled',   // the cancel handler writes the authoritative row
    'search_lifetime_exceeded',
    'round_skipped',
    'offer_acknowledged',   // the ack handler writes the authoritative row
    'driver_rejected',      // the reject handler writes the authoritative row
    'acceptance',           // the accept handler writes the authoritative row
    'candidates_discovered_empty',
]);

/**
 * Project one orchestrator event. Returns zero, one or many rows —
 * `candidates_discovered` fans out to one row per candidate, and `offer_sent`
 * splits into the independent transport facts it actually represents.
 */
export function projectDispatchEvent(
    rideId: string,
    event: string,
    f: Record<string, any>,
): RecordArgs[] {
    if (IGNORED.has(event)) return [];

    const round =
        typeof f.round === 'number' ? f.round
        : typeof f.dispatchRound === 'number' ? f.dispatchRound
        : null;
    const radiusKm = typeof f.radiusKm === 'number' ? f.radiusKm : null;
    const base = { rideId, dispatchRound: round, radiusKm };

    switch (event) {
        case 'round_start': {
            // The orchestrator logs the tier LIST for this round, not a single
            // radius. Record the widest tier in the scalar column too: it is
            // how far this round will actually reach, and without it a round
            // that found nobody records no radius at all — which is precisely
            // the ride an operator is investigating when they ask "how far did
            // we look?". The full list stays in detail; nothing is invented.
            const tiers: unknown = f.radiusTiersKm;
            const widest = Array.isArray(tiers)
                ? tiers.filter((t) => typeof t === 'number').reduce((a, b) => Math.max(a, b), 0)
                : null;
            return [{
                ...base,
                radiusKm: widest || base.radiusKm,
                eventType: DispatchEventType.ROUND_STARTED,
                detail: { radiusTiersKm: f.radiusTiersKm ?? null },
            }];
        }

        case 'round_transition':
            return [{
                rideId,
                dispatchRound: typeof f.toRound === 'number' ? f.toRound : round,
                eventType: DispatchEventType.ROUND_TRANSITION,
                detail: { fromRound: f.fromRound ?? null, toRound: f.toRound ?? null, elapsedMs: f.elapsedMs ?? null },
            }];

        case 'candidates_discovered':
            if (!Array.isArray(f.candidates)) return [];
            return f.candidates
                .filter((c: any) => c && c.driverId)
                .map((c: any) => ({
                    ...base,
                    eventType: DispatchEventType.CANDIDATE_DISCOVERED,
                    driverId: String(c.driverId),
                    distanceKm: typeof c.distanceKm === 'number' ? c.distanceKm : null,
                    withFreshness: true,
                }));

        case 'eligibility_reject':
            return [{
                ...base,
                eventType: DispatchEventType.ELIGIBILITY_REJECTED,
                driverId: f.driverId ?? null,
                detail: { reason: f.reason ?? null },
                withFreshness: true,
            }];

        case 'candidate_stale':
            return [{
                ...base,
                eventType: DispatchEventType.CANDIDATE_STALE,
                driverId: f.driverId ?? null,
                detail: { reason: f.reason ?? 'stale_heartbeat' },
                withFreshness: true,
            }];

        case 'reserve':
            if (f.result === 'acquired') {
                return [{
                    ...base,
                    eventType: DispatchEventType.RESERVATION_ACQUIRED,
                    driverId: f.driverId ?? null,
                    detail: { ttlSec: f.ttlSec ?? null },
                }];
            }
            return [{
                ...base,
                eventType: DispatchEventType.RESERVATION_CONFLICT,
                driverId: f.driverId ?? null,
                detail: { reservedBy: f.reservedBy ?? null },
            }];

        case 'offer_queued':
            return [{
                ...base,
                eventType: DispatchEventType.NOTIFICATION_QUEUED,
                driverId: f.driverId ?? null,
                withFreshness: true,
            }];

        case 'offer_sent': {
            // Two independent facts, recorded separately. NEITHER means the
            // handset received anything — only a device ack does.
            const rows: RecordArgs[] = [];
            if (f.socketDelivered === true) {
                rows.push({
                    ...base,
                    eventType: DispatchEventType.SOCKET_OFFER_EMITTED,
                    driverId: f.driverId ?? null,
                });
            }
            if (typeof f.pushSuccessCount === 'number' && f.pushSuccessCount > 0) {
                rows.push({
                    ...base,
                    eventType: DispatchEventType.FCM_ACCEPTED_BY_PROVIDER,
                    driverId: f.driverId ?? null,
                    detail: { acceptedTokenCount: f.pushSuccessCount },
                });
            }
            return rows;
        }

        case 'offer_delivery_failed':
            return [{
                ...base,
                eventType: DispatchEventType.OFFER_DELIVERY_FAILED,
                driverId: f.driverId ?? null,
                detail: { reason: f.reason ?? 'no_transport_available' },
            }];

        case 'offer_expiry':
            return [{
                ...base,
                eventType: DispatchEventType.OFFER_EXPIRED,
                driverId: f.driverId ?? null,
            }];

        case 'dispatch_finished':
            if (!f.finalOutcomeCode) return [];
            // A cancelled or vanished ride is NOT a dispatch failure. The
            // orchestrator still classifies an outcome for these (the passenger
            // path ignores it — see finalizeUnsuccessfulDispatch), but recording
            // "no driver accepted" against a ride the passenger cancelled would
            // misattribute it in exactly the supply reports this monitor exists
            // to produce. The cancel handler writes the authoritative row.
            if (f.stopReason === 'cancelled' || f.stopReason === 'ride_gone') return [];
            return [{
                rideId,
                dispatchRound: round,
                eventType: DispatchEventType.DISPATCH_FAILED,
                detail: {
                    outcomeCode: f.finalOutcomeCode,
                    dispatchResult: f.dispatchResult ?? null,
                    stopReason: f.stopReason ?? null,
                    elapsedMs: f.elapsedMs ?? null,
                },
            }];

        default:
            return [];
    }
}
