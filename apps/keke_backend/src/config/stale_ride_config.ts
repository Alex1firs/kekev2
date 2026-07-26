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

    // ── extensions ───────────────────────────────────────────────────────
    /** How long a driver "still on my way" confirmation buys. */
    extensionMinutes: number;
    /**
     * How many extensions one ride may receive. A confirmation must never be
     * able to hold a passenger's slot open indefinitely.
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

        extensionMinutes: num('STALE_EXTENSION_MINUTES', 10),
        maxExtensions: Math.floor(num('STALE_MAX_EXTENSIONS', 1)),

        warnAtDeadlineFraction: Math.min(Math.max(num('STALE_WARN_DEADLINE_FRACTION', 0.6), 0.1), 0.95),
        kekeMetresPerMinute: num('KEKE_METRES_PER_MINUTE', 230),
    };
}

/** Explicit, auditable reasons for a system-initiated terminal action. */
export enum StaleActionReason {
    /** accepted, deadline elapsed, driver never arrived. */
    DRIVER_DID_NOT_ARRIVE = 'SYSTEM_DRIVER_DID_NOT_ARRIVE',
    /** arrived, grace elapsed, trip never started. Blames nobody. */
    TRIP_NOT_STARTED_AFTER_ARRIVAL = 'SYSTEM_TRIP_NOT_STARTED_AFTER_ARRIVAL',
    /** in progress far past its expected duration. Flag only, never a cancel. */
    TRIP_EXCEEDED_EXPECTED_DURATION = 'SYSTEM_TRIP_EXCEEDED_EXPECTED_DURATION',
}
