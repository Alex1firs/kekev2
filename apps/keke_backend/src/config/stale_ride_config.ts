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

/**
 * How a stale ride was RESOLVED. Recorded on `cancellationReason`.
 *
 * Every value names a decision someone made, or names silence explicitly. There
 * is no generic "system cancelled" outcome, because a passenger asking support
 * "why was my ride cancelled?" deserves a real answer.
 */
export enum StaleResolution {
    /** The passenger chose to cancel when asked. */
    PASSENGER_CHOSE_CANCEL = 'PASSENGER_CHOSE_CANCEL',
    /** The driver chose to cancel when asked. */
    DRIVER_CHOSE_CANCEL = 'DRIVER_CHOSE_CANCEL',
    /**
     * Both were asked and neither answered. Nobody is engaged with this ride, so
     * holding the passenger's booking slot and the driver's availability open
     * serves no one.
     */
    NO_RESPONSE_FROM_EITHER = 'SYSTEM_NO_RESPONSE_FROM_EITHER',
    /**
     * The passenger said keep waiting, but the driver never answered across the
     * permitted rounds. Waiting longer cannot help — the driver is gone.
     */
    DRIVER_UNRESPONSIVE = 'SYSTEM_DRIVER_UNRESPONSIVE',
    /**
     * The driver said keep waiting, but the passenger never answered across the
     * permitted rounds.
     */
    PASSENGER_UNRESPONSIVE = 'SYSTEM_PASSENGER_UNRESPONSIVE',
}

/** Who a decision prompt was answered by. */
export type StaleDecisionParty = 'passenger' | 'driver';
/** What they chose. */
export type StaleDecisionChoice = 'wait' | 'cancel';
