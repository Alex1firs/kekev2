/**
 * The app-facing shape of a coordination state.
 *
 * One place builds it, so the socket events, the push notifications, the
 * recovery endpoint and the two mobile apps cannot drift apart. Everything the
 * apps render comes from here; nothing is re-derived on the device, because the
 * policy that decides what is permitted lives on the server (StaleRideService)
 * and a second implementation on a phone would eventually disagree with it.
 *
 * Two rules shape this file:
 *
 *  1. No engineering codes cross the wire as display text. `driver_never_arrived`
 *     is a fine database value and a terrible thing to show someone standing in
 *     the rain. Codes still travel — for analytics and support — but always
 *     alongside human copy the app can render verbatim.
 *
 *  2. Deadlines travel as absolute server timestamps. A phone that has been
 *     asleep for two minutes must resume the countdown where it actually is,
 *     not restart it, so `respondByAt` is authoritative and `respondBySeconds`
 *     is only a convenience for a client with a bad clock.
 */
import { Ride } from '../models/Ride';
import { RideDelayState, StaleRideConfig } from '../config/stale_ride_config';

/**
 * What the apps show. Deliberately coarser than RideDelayState: the operational
 * dashboard wants nine distinct states, a passenger wants to know whether their
 * driver is coming.
 */
export enum CoordinationStage {
    /** Nothing to say. Ordinary ride. */
    NONE = 'none',
    /** Running late; nobody has been asked anything yet. */
    RUNNING_LATE = 'running_late',
    /** Both parties have been asked to choose, and nobody has answered. */
    AWAITING_DECISION = 'awaiting_decision',
    /** Someone said they are still coming. */
    CONFIRMED_EN_ROUTE = 'confirmed_en_route',
    /** Driver has arrived; the passenger has not appeared. */
    WAITING_FOR_PASSENGER = 'waiting_for_passenger',
    /** One party asked to cancel; the other has to answer. */
    CANCELLATION_REQUESTED = 'cancellation_requested',
    /** A human has this ride. Timers no longer act on it. */
    ESCALATED = 'escalated',
}

/**
 * Actions the apps may offer. The server decides which are available, so a
 * button is never drawn for something the backend would refuse — an app that
 * offers "Keep waiting" past the extension limit has lied to the person holding
 * it.
 */
export type CoordinationAction =
    | 'still_coming'
    | 'keep_waiting'
    | 'on_my_way'
    | 'accept_cancellation'
    | 'continue_ride'
    | 'request_cancel'
    | 'find_another_driver'
    | 'call_other_party'
    | 'message_other_party'
    | 'contact_support'
    | 'share_location'
    | 'open_navigation';

export interface CoordinationSnapshot {
    rideId: string;
    /** The live ride status, so the app can tell accepted-late from arrived-late. */
    rideStatus: string;
    stage: CoordinationStage;
    /** The operational state, passed through for support tooling and analytics. */
    delayState: string | null;

    /** Which side the ride is waiting on. Null when it is waiting on nobody. */
    waitingFor: 'driver' | 'passenger' | null;

    /**
     * Idempotency key. Deterministic — the same coordination moment always
     * produces the same id, so a socket event and its push notification collapse
     * to one prompt, and a replay after reconnect cannot double-ask.
     */
    eventId: string;

    /** Absolute deadline for the open question, if there is one. */
    respondByAt: string | null;
    /** Convenience mirror of respondByAt. Never the source of truth. */
    respondBySeconds: number | null;

    /** True while a decision prompt is open and unanswered. */
    decisionOpen: boolean;
    /** Who answered, once someone has. */
    decidedBy: 'passenger' | 'driver' | null;
    decidedChoice: 'wait' | 'cancel' | null;
    /** Which round of the conversation this is. */
    round: number;

    /** Set while a cancellation request is awaiting an answer. */
    cancellationRequestedBy: 'passenger' | 'driver' | null;
    cancellationRequestState: 'pending' | 'accepted' | 'declined' | null;

    /** How many "keep waiting" choices are still available. */
    extensionsRemaining: number;
    /** True once a human owns this ride; the sweeper stops acting on it. */
    escalatedToSupport: boolean;

    /** Machine-readable situation, for analytics and support. Never displayed. */
    reasonCode: string | null;
}

/** The per-role copy that accompanies a snapshot. */
export interface CoordinationCopy {
    title: string;
    body: string;
    actions: CoordinationAction[];
}

type Party = 'passenger' | 'driver';

/**
 * Derive the app-facing stage from the persisted row.
 *
 * Ordered by precedence rather than by database column, because more than one
 * thing is usually true at once. A pending cancellation request outranks a
 * general delay — it is the question actually in front of the person. Escalation
 * outranks everything, because once a human owns the ride the app must stop
 * showing countdowns that will never fire.
 */
export function stageOf(ride: Pick<Ride,
    'status' | 'delayState' | 'staleWarnedAt' | 'staleDecisionPromptedAt' | 'staleDecisionChoice'
    | 'cancellationRequestState' | 'escalatedToSupportAt' | 'arrivedAt'>): CoordinationStage {
    if (ride.escalatedToSupportAt != null) return CoordinationStage.ESCALATED;
    if (ride.cancellationRequestState === 'pending') return CoordinationStage.CANCELLATION_REQUESTED;

    // An open, unanswered prompt is the loudest thing there is.
    if (ride.staleDecisionPromptedAt != null && ride.staleDecisionChoice == null) {
        return CoordinationStage.AWAITING_DECISION;
    }
    if (ride.staleDecisionChoice === 'wait' || ride.delayState === RideDelayState.DRIVER_CONFIRMED_EN_ROUTE) {
        return CoordinationStage.CONFIRMED_EN_ROUTE;
    }
    if (ride.delayState === RideDelayState.WAITING_FOR_PASSENGER
        || (ride.status as unknown as string) === 'arrived' && ride.staleWarnedAt != null) {
        return CoordinationStage.WAITING_FOR_PASSENGER;
    }
    if (ride.staleWarnedAt != null || ride.delayState === RideDelayState.WAITING_FOR_DRIVER) {
        return CoordinationStage.RUNNING_LATE;
    }
    return CoordinationStage.NONE;
}

/**
 * A stable id for one coordination moment.
 *
 * Deterministic on purpose. A random id would defeat the whole point: the app
 * must be able to tell that the push notification it just received and the
 * socket event it received two seconds earlier are the same question, and show
 * one prompt rather than two.
 */
export function coordinationEventId(rideId: string, kind: string, sequence: number | string): string {
    return `${rideId}:${kind}:${sequence}`;
}

export function coordinationSnapshot(ride: Ride, config: StaleRideConfig, now = new Date()): CoordinationSnapshot {
    const stage = stageOf(ride);
    const decisionOpen = ride.staleDecisionPromptedAt != null
        && ride.staleDecisionChoice == null
        && ride.completedAt == null;

    // Whichever question is open supplies the deadline. A pending cancellation
    // request is answered first, so its window wins.
    let respondBy: Date | null = null;
    if (ride.cancellationRequestState === 'pending' && ride.cancellationRequestedAt != null) {
        respondBy = new Date(
            new Date(ride.cancellationRequestedAt).getTime() + config.decisionWindowMinutes * 60_000,
        );
    } else if (decisionOpen && ride.staleDecisionDeadlineAt != null) {
        respondBy = new Date(ride.staleDecisionDeadlineAt);
    }

    const status = ride.status as unknown as string;
    const waitingFor: Party | null = stage === CoordinationStage.NONE
        ? null
        : (status === 'arrived' ? 'passenger' : status === 'accepted' ? 'driver' : null);

    // The id names the moment, so it is derived from the thing that is open.
    const kind = ride.cancellationRequestState === 'pending'
        ? `cancel_request_${ride.cancellationRequestedBy ?? 'unknown'}`
        : decisionOpen ? 'decision'
            : ride.escalatedToSupportAt != null ? 'escalation'
                : stage;
    const sequence = ride.cancellationRequestState === 'pending'
        ? (ride.cancellationRequestedAt ? new Date(ride.cancellationRequestedAt).getTime() : 0)
        : ride.staleDecisionRound ?? 0;

    return {
        rideId: ride.rideId,
        rideStatus: status,
        stage,
        delayState: ride.delayState ?? null,
        waitingFor,
        eventId: coordinationEventId(ride.rideId, kind, sequence),
        respondByAt: respondBy?.toISOString() ?? null,
        respondBySeconds: respondBy
            ? Math.max(0, Math.round((respondBy.getTime() - now.getTime()) / 1000))
            : null,
        decisionOpen,
        decidedBy: (ride.staleDecisionBy as Party | null) ?? null,
        decidedChoice: (ride.staleDecisionChoice as 'wait' | 'cancel' | null) ?? null,
        round: ride.staleDecisionRound ?? 0,
        cancellationRequestedBy: (ride.cancellationRequestedBy as Party | null) ?? null,
        cancellationRequestState:
            (ride.cancellationRequestState as 'pending' | 'accepted' | 'declined' | null) ?? null,
        extensionsRemaining: Math.max(0, config.maxExtensions - (ride.staleExtensionCount ?? 0)),
        escalatedToSupport: ride.escalatedToSupportAt != null,
        reasonCode: ride.staleReason ?? null,
    };
}

/**
 * Human copy for a snapshot, from the point of view of one party.
 *
 * Both sides are told the same facts, phrased for their own situation, and
 * neither is told the other is at fault. A driver stuck behind an accident and a
 * passenger standing on a kerb are both doing their best; the copy assumes that.
 */
export function coordinationCopy(
    snapshot: CoordinationSnapshot,
    role: Party,
    opts: { canCall?: boolean } = {},
): CoordinationCopy | null {
    const canCall = opts.canCall !== false;
    const call: CoordinationAction[] = canCall ? ['call_other_party'] : [];
    const waitAllowed = snapshot.extensionsRemaining > 0;

    switch (snapshot.stage) {
        case CoordinationStage.NONE:
            return null;

        case CoordinationStage.RUNNING_LATE:
            return role === 'driver'
                ? {
                    title: 'Are you still heading to the passenger?',
                    body: 'The passenger is waiting. Let us know if you are still on your way.',
                    actions: ['still_coming', ...call, 'open_navigation', 'request_cancel'],
                }
                : {
                    title: 'Your driver is taking longer than expected',
                    body: 'We are checking whether the driver is still on the way.',
                    actions: [...(waitAllowed ? ['keep_waiting' as CoordinationAction] : []), ...call, 'request_cancel'],
                };

        case CoordinationStage.AWAITING_DECISION:
            if (snapshot.waitingFor === 'passenger') {
                return role === 'driver'
                    ? {
                        title: 'Passenger is taking longer to come out',
                        body: 'We have reminded the passenger that you are waiting.',
                        actions: [...(waitAllowed ? ['keep_waiting' as CoordinationAction] : []), ...call, 'request_cancel'],
                    }
                    : {
                        title: 'Your driver is waiting',
                        body: 'Please meet your driver at the pickup point.',
                        actions: ['on_my_way', ...call, 'request_cancel'],
                    };
            }
            return role === 'driver'
                ? {
                    title: 'Are you still heading to the passenger?',
                    body: 'The passenger is waiting. Let us know if you are still on your way.',
                    actions: ['still_coming', ...call, 'open_navigation', 'request_cancel'],
                }
                : {
                    title: 'Your driver is taking longer than expected',
                    body: 'Waiting for your driver to confirm.',
                    actions: [...(waitAllowed ? ['keep_waiting' as CoordinationAction] : []), ...call, 'request_cancel'],
                };

        case CoordinationStage.CONFIRMED_EN_ROUTE:
            return role === 'driver'
                ? {
                    title: 'Passenger notified that you are still coming',
                    body: 'They know you are on your way. Please head to the pickup point.',
                    actions: [...call, 'open_navigation', 'request_cancel'],
                }
                : {
                    title: 'Your driver confirmed they are still coming',
                    body: 'They are on their way to the pickup point.',
                    actions: ['keep_waiting', ...call, 'request_cancel'],
                };

        case CoordinationStage.WAITING_FOR_PASSENGER:
            return role === 'driver'
                ? {
                    title: 'Passenger is taking longer to come out',
                    body: 'We have reminded the passenger that you are waiting.',
                    actions: [...(waitAllowed ? ['keep_waiting' as CoordinationAction] : []), ...call, 'request_cancel'],
                }
                : {
                    title: 'Your driver is waiting',
                    body: 'Please meet your driver at the pickup point.',
                    actions: ['on_my_way', ...call, 'request_cancel'],
                };

        case CoordinationStage.CANCELLATION_REQUESTED: {
            const mine = snapshot.cancellationRequestedBy === role;
            if (mine) {
                return {
                    title: 'Waiting for a response to your cancellation',
                    body: 'We have asked the other person. The ride stays active until they answer.',
                    actions: [...call],
                };
            }
            return role === 'driver'
                ? {
                    title: 'Passenger requested to cancel this ride',
                    body: 'You can accept the cancellation, or let them know you are still coming.',
                    actions: ['accept_cancellation', 'continue_ride', ...call],
                }
                : {
                    title: 'Your driver requested to cancel this ride',
                    body: 'You can accept, or ask them to keep coming.',
                    actions: ['accept_cancellation', 'continue_ride', ...call],
                };
        }

        case CoordinationStage.ESCALATED:
            return role === 'driver'
                ? {
                    title: 'This ride needs support assistance',
                    body: 'Our team has been notified and is looking into it. Nothing will be cancelled automatically.',
                    actions: ['contact_support', ...call, 'request_cancel'],
                }
                : {
                    title: 'This ride needs support assistance',
                    body: 'We have not been able to reach your driver. Our team has been notified.',
                    actions: ['find_another_driver', 'contact_support', ...call],
                };
    }
}

/**
 * Human copy for a ride that has ended, keyed on the resolution the server
 * recorded.
 *
 * The apps must not keep their own table of these — it would drift from
 * StaleResolution the first time one changed. `reason` is the raw stored value;
 * anything unrecognised falls back to plain, unblaming copy rather than showing
 * the code itself.
 */
export function cancellationCopy(reason: string | null, role: Party): { title: string; body: string; outcome: string } {
    switch (reason) {
        case 'SYSTEM_ABANDONED_BY_BOTH':
            return role === 'passenger'
                ? {
                    outcome: 'closed_no_response',
                    title: 'Ride closed',
                    body: "This ride was closed because we couldn't reach either you or the driver.",
                }
                : {
                    outcome: 'closed_no_response',
                    title: 'Ride closed',
                    body: 'This ride was closed after neither party responded.',
                };

        case 'CANCELLED_REQUEST_UNANSWERED':
            return role === 'passenger'
                ? {
                    outcome: 'cancelled_request_unanswered',
                    title: 'Ride cancelled',
                    body: 'The cancellation went ahead because there was no answer. You can book again now.',
                }
                : {
                    outcome: 'cancelled_request_unanswered',
                    title: 'Ride cancelled',
                    body: 'The cancellation request went unanswered, so the ride was closed. You can accept new rides now.',
                };

        case 'CANCELLED_MUTUAL_PASSENGER_INITIATED':
            return role === 'passenger'
                ? {
                    outcome: 'cancelled_by_passenger',
                    title: 'Ride cancelled',
                    body: 'Your ride has been cancelled. You can book again now.',
                }
                : {
                    outcome: 'cancelled_by_passenger',
                    title: 'Ride cancelled',
                    body: 'The passenger cancelled this ride. You can accept new rides now.',
                };

        case 'CANCELLED_MUTUAL_DRIVER_INITIATED':
            return role === 'passenger'
                ? {
                    outcome: 'cancelled_by_driver',
                    title: 'Ride cancelled',
                    body: 'Your driver could not complete this pickup. You can book another Keke now.',
                }
                : {
                    outcome: 'cancelled_by_driver',
                    title: 'Ride cancelled',
                    body: 'This ride has been cancelled. You can accept new rides now.',
                };

        case 'SUPPORT_RESOLVED':
            return {
                outcome: 'resolved_by_support',
                title: 'Ride closed by support',
                body: 'Our team closed this ride. Please contact support if you need anything else.',
            };

        default:
            // Includes passenger_cancelled / driver_cancelled from the ordinary
            // (non-coordination) paths, and anything added later. Plain copy
            // beats leaking a code.
            return role === 'passenger'
                ? { outcome: 'cancelled', title: 'Ride cancelled', body: 'This ride has been cancelled. You can book again now.' }
                : { outcome: 'cancelled', title: 'Ride cancelled', body: 'This ride has been cancelled. You can accept new rides now.' };
    }
}
