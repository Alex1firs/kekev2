/**
 * Stale-ride detection and recovery tuning.
 *
 * Every threshold lives here. A ride blocking a passenger and a driver for days
 * is an operational emergency, and the response has to be tunable from the
 * environment without a rebuild — so nothing in the sweep or the policy reads a
 * hardcoded duration.
 */

export interface StaleRideConfig {
    /** Master kill switch. False stops the sweeper entirely. */
    enabled: boolean;

    /**
     * When true the sweeper evaluates and reports but performs NO mutation.
     * Safe default for a first production rollout.
     */
    dryRun: boolean;

    /** How often the sweeper runs. */
    sweepIntervalMs: number;

    /** Maximum rides examined per state, per sweep. */
    batchSize: number;

    // ── accepted, never arrived ──────────────────────────────────────────
    /**
     * Floor on the arrival allowance, and the value used when no pickup ETA can
     * be derived. A Keke driver who accepted and has not arrived in this long
     * has almost certainly abandoned the ride.
     */
    acceptedMinMinutes: number;
    /** Arrival allowance = pickup ETA x this. */
    acceptedEtaMultiplier: number;
    /** Ceiling on the arrival allowance regardless of ETA. */
    acceptedMaxMinutes: number;

    // ── arrived, trip never started ──────────────────────────────────────
    /** Warn both parties after this long waiting at the pickup point. */
    arrivedWarnMinutes: number;
    /** Auto-cancel after this long with no trip start. */
    arrivedCancelMinutes: number;

    // ── in progress, never completed ─────────────────────────────────────
    /** Review threshold = estimated trip duration x this. */
    inProgressDurationMultiplier: number;
    /** Floor on the in-progress review threshold. */
    inProgressMinMinutes: number;
    /** Absolute threshold: past this a trip is always flagged for review. */
    inProgressAbsoluteMinutes: number;

    // ── the decision window ──────────────────────────────────────────────
    /**
     * Once a deadline is reached, BOTH parties are asked whether to keep waiting
     * or cancel, and this is how long they have to answer.
     *
     * Nothing is cancelled during this window. A cancellation only follows an
     * explicit choice, or silence from the party whose action the ride is waiting
     * on — so there is no such thing as a cancellation neither user saw coming.
     */
    decisionWindowMinutes: number;

    /** How long a "keep waiting" choice buys before asking again. */
    extensionMinutes: number;
    /**
     * How many times "keep waiting" may be chosen on one ride. After this, the
     * next decision round accepts only an explicit cancel or resolves on silence
     * — otherwise two co-operative users could hold a slot open forever.
     */
    maxExtensions: number;

    /**
     * Warn the driver of an approaching arrival deadline once this fraction of
     * the allowance has elapsed (0.6 = at 60%).
     */
    warnAtDeadlineFraction: number;

    // ── Coordination cadence ─────────────────────────────────────────────
    /**
     * How long between reminders once both parties know the ride is delayed.
     *
     * Deliberately long. Two people who have each said "still coming" and "still
     * waiting" are coordinating; nagging them every minute is worse than silence,
     * and teaches both to ignore the notification that actually matters.
     */
    reminderIntervalMinutes: number;

    /** Scale the reminder interval up for long trips. */
    reminderIntervalPerTripHour: number;

    /** Never remind more often than this, whatever the scaling produces. */
    reminderMinIntervalMinutes: number;

    // ── Evidence of genuine abandonment ──────────────────────────────────
    /**
     * How long a party must show NO liveness at all — no heartbeat, no socket,
     * no location, no interaction — before they count as gone rather than slow.
     *
     * This is the threshold that separates "stuck in traffic with a dead phone
     * battery" from "abandoned the ride", so it is deliberately generous.
     */
    partyOfflineMinutes: number;

    /**
     * With one party engaged and the other gone this long, escalate: tell the
     * engaged party we cannot reach the other, and offer them a way forward.
     * Escalation is NOT cancellation.
     */
    escalateAfterOfflineMinutes: number;

    /**
     * The only automatic-termination threshold. BOTH parties must have shown no
     * liveness and no interaction for this long. Anything less escalates to a
     * human instead.
     */
    mutualAbandonmentMinutes: number;

    /**
     * A driver whose distance to pickup shrinks by at least this much between
     * checks is genuinely approaching, which extends the deadline on its own.
     */
    approachProgressMetres: number;

    /**
     * Assumed Keke speed for deriving a pickup ETA from the accept-point to
     * pickup distance, in metres per minute. Matches the passenger app's own
     * ETA maths (230 m/min ~ 13.8 km/h), so operator-facing numbers agree with
     * what the passenger was shown.
     */
    kekeMetresPerMinute: number;
}

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.warn(`[stale-ride-config] ${name}="${raw}" is not a valid number — using ${fallback}`);
        return fallback;
    }
    return parsed;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    return raw.trim().toLowerCase() === 'true';
}

export function loadStaleRideConfig(): StaleRideConfig {
    return {
        enabled: bool('STALE_SWEEP_ENABLED', true),
        // Mutating by default: the incident this exists to prevent cost a
        // passenger and a driver four days each. Set STALE_SWEEP_DRY_RUN=true to
        // observe first.
        dryRun: bool('STALE_SWEEP_DRY_RUN', false),
        sweepIntervalMs: num('STALE_SWEEP_INTERVAL_MS', 90_000),
        batchSize: Math.floor(num('STALE_SWEEP_BATCH_SIZE', 50)),

        acceptedMinMinutes: num('STALE_ACCEPTED_MIN_MINUTES', 20),
        acceptedEtaMultiplier: num('STALE_ACCEPTED_ETA_MULTIPLIER', 3),
        acceptedMaxMinutes: num('STALE_ACCEPTED_MAX_MINUTES', 45),

        arrivedWarnMinutes: num('STALE_ARRIVED_WARN_MINUTES', 10),
        arrivedCancelMinutes: num('STALE_ARRIVED_CANCEL_MINUTES', 20),

        inProgressDurationMultiplier: num('STALE_INPROGRESS_DURATION_MULTIPLIER', 4),
        inProgressMinMinutes: num('STALE_INPROGRESS_MIN_MINUTES', 120),
        inProgressAbsoluteMinutes: num('STALE_INPROGRESS_ABSOLUTE_MINUTES', 360),

        decisionWindowMinutes: num('STALE_DECISION_WINDOW_MINUTES', 3),
        extensionMinutes: num('STALE_EXTENSION_MINUTES', 10),
        maxExtensions: Math.floor(num('STALE_MAX_EXTENSIONS', 1)),

        warnAtDeadlineFraction: Math.min(Math.max(num('STALE_WARN_DEADLINE_FRACTION', 0.6), 0.1), 0.95),

        reminderIntervalMinutes: num('STALE_REMINDER_INTERVAL_MINUTES', 12),
        reminderIntervalPerTripHour: num('STALE_REMINDER_PER_TRIP_HOUR_MINUTES', 5),
        reminderMinIntervalMinutes: num('STALE_REMINDER_MIN_INTERVAL_MINUTES', 10),

        partyOfflineMinutes: num('STALE_PARTY_OFFLINE_MINUTES', 10),
        escalateAfterOfflineMinutes: num('STALE_ESCALATE_AFTER_OFFLINE_MINUTES', 15),
        mutualAbandonmentMinutes: num('STALE_MUTUAL_ABANDONMENT_MINUTES', 90),
        approachProgressMetres: num('STALE_APPROACH_PROGRESS_METRES', 150),
        kekeMetresPerMinute: num('KEKE_METRES_PER_MINUTE', 230),
    };
}

/**
 * The SITUATION that made a ride stale. Recorded on `staleReason`.
 *
 * Separate from why it was finally cancelled: the situation describes what went
 * wrong, the outcome describes who decided. Both are needed to answer a support
 * question honestly.
 */
export enum StaleActionReason {
    /** accepted, deadline elapsed, driver never arrived. */
    DRIVER_DID_NOT_ARRIVE = 'SYSTEM_DRIVER_DID_NOT_ARRIVE',
    /** arrived, grace elapsed, trip never started. Blames nobody. */
    TRIP_NOT_STARTED_AFTER_ARRIVAL = 'SYSTEM_TRIP_NOT_STARTED_AFTER_ARRIVAL',
    /** in progress far past its expected duration. Flag only, never a cancel. */
    TRIP_EXCEEDED_EXPECTED_DURATION = 'SYSTEM_TRIP_EXCEEDED_EXPECTED_DURATION',
}

/** Who a decision prompt was answered by. */
export type StaleDecisionParty = 'passenger' | 'driver';
/** What they chose. */
export type StaleDecisionChoice = 'wait' | 'cancel';

/**
 * The operational state of a delayed ride, as operations staff see it.
 *
 * A delay is NOT an error. These are coordination states describing two people
 * working something out in the real world — traffic, a checkpoint, a gate, a
 * lift, reception. Most of them are healthy.
 */
export enum RideDelayState {
    /** Nothing wrong. */
    NONE = 'none',
    /** Driver is late but has confirmed they are en route. */
    DRIVER_CONFIRMED_EN_ROUTE = 'delayed_driver_confirmed_en_route',
    /** Passenger has confirmed they are still waiting. */
    PASSENGER_WAITING = 'delayed_passenger_waiting',
    /** Driver has arrived; we are now measuring the passenger's wait. */
    WAITING_FOR_PASSENGER = 'waiting_for_passenger',
    /** Delay with no confirmation from the driver yet. */
    WAITING_FOR_DRIVER = 'waiting_for_driver',
    /** No liveness from the driver at all. */
    DRIVER_OFFLINE = 'driver_offline',
    /** No liveness from the passenger at all. */
    PASSENGER_OFFLINE = 'passenger_offline',
    /** One party asked to cancel; the other has not answered yet. */
    CANCELLATION_REQUESTED = 'cancellation_requested',
    /** Both prompted, waiting on a response. */
    AWAITING_CONFIRMATION = 'awaiting_confirmation',
    /** Handed to a human. The system will not terminate this on its own. */
    ESCALATED_TO_SUPPORT = 'escalated_to_support',
}

/**
 * What kind of signal proves a ride is still alive.
 *
 * The distinction matters. An open app is not a driver who is coming: a driver
 * parked at home emits location updates indefinitely. So liveness stops us
 * calling someone offline, while only approach or intent moves a deadline.
 */
export enum ActivityKind {
    /** The app is alive — heartbeat, socket, a location fix. Extends nothing. */
    LIVENESS = 'liveness',
    /** Distance to pickup genuinely shrinking. Extends the deadline. */
    APPROACH = 'approach',
    /** A deliberate human action. Extends the deadline. */
    INTENT = 'intent',
}

/** Deliberate actions that prove someone is still engaged with this ride. */
export enum RideActivityType {
    DRIVER_STILL_COMING = 'driver_still_coming',
    PASSENGER_KEEP_WAITING = 'passenger_keep_waiting',
    DRIVER_APPROACHING = 'driver_approaching',
    CHAT_MESSAGE = 'chat_message',
    CALL_ATTEMPT = 'call_attempt',
    DRIVER_ARRIVED = 'driver_arrived',
    PASSENGER_ACKNOWLEDGED_ARRIVAL = 'passenger_acknowledged_arrival',
    LOCATION_SHARED = 'location_shared',
}

/**
 * How a stale ride ended. Every value is either a human decision or explicit,
 * evidenced abandonment — there is no bare "timed out".
 */
export enum StaleResolution {
    /** The passenger asked to cancel and the driver accepted. */
    CANCELLED_BY_MUTUAL_AGREEMENT_PASSENGER_INITIATED = 'CANCELLED_MUTUAL_PASSENGER_INITIATED',
    /** The driver asked to cancel and the passenger accepted. */
    CANCELLED_BY_MUTUAL_AGREEMENT_DRIVER_INITIATED = 'CANCELLED_MUTUAL_DRIVER_INITIATED',
    /** One party asked, the other never answered, so the request stood. */
    CANCELLED_REQUEST_UNANSWERED = 'CANCELLED_REQUEST_UNANSWERED',
    /**
     * The ONLY time-based termination. Both parties showed no liveness and no
     * interaction for STALE_MUTUAL_ABANDONMENT_MINUTES. Nobody is coordinating.
     */
    ABANDONED_BY_BOTH = 'SYSTEM_ABANDONED_BY_BOTH',
    /** Operations staff terminated it after escalation. */
    RESOLVED_BY_SUPPORT = 'SUPPORT_RESOLVED',
}
