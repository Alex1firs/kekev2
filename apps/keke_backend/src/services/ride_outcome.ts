/**
 * Why a ride ended the way it did.
 *
 * `status` says WHAT happened; this says WHY. The two are stored separately
 * because "failed" is an outcome, not an explanation — and the difference
 * between "there were no Kekes in Awada" and "there were six and none of them
 * answered" is the difference between a recruitment problem and a driver
 * behaviour problem. A console that shows only `failed` cannot tell an operator
 * which business they are in.
 *
 * ## Codes are the source of truth, English is a rendering
 *
 * Everything persisted here is a stable machine-readable code. Human labels
 * live in [[OUTCOME_LABELS]] and exist only for display; they can be reworded,
 * translated or A/B-tested without a migration, and no query ever matches on
 * them.
 *
 * ## Nothing here infers
 *
 * Every function in this file maps evidence that was actually recorded onto a
 * code. There is deliberately no path that guesses a reason from a status. A
 * ride that ended before this file existed has no evidence, and says so —
 * see [[LEGACY_UNAVAILABLE]]. Inventing a plausible cause for 444 historical
 * rides would corrupt the exact supply reports this work exists to produce.
 */

/** Terminal outcome codes. Persisted on the ride row; never reworded. */
export enum RideOutcomeCode {
    // ── Completed ────────────────────────────────────────────────────────
    COMPLETED = 'COMPLETED',

    // ── Dispatch never produced a driver ─────────────────────────────────
    /** Nobody passed eligibility, or nobody was reachable at all. */
    NO_ELIGIBLE_DRIVER = 'NO_ELIGIBLE_DRIVER',
    /** Genuinely eligible drivers were rung and none accepted. */
    NO_DRIVER_ACCEPTED = 'NO_DRIVER_ACCEPTED',
    /** The search lifetime budget ran out. */
    REQUEST_EXPIRED = 'REQUEST_EXPIRED',
    /** Dispatch could not run to completion — a fault, not a supply problem. */
    TECHNICAL_FAILURE = 'TECHNICAL_FAILURE',

    // ── Somebody cancelled ───────────────────────────────────────────────
    PASSENGER_CANCELLED = 'PASSENGER_CANCELLED',
    DRIVER_CANCELLED = 'DRIVER_CANCELLED',
    ADMIN_CANCELLED = 'ADMIN_CANCELLED',
    SYSTEM_CANCELLED = 'SYSTEM_CANCELLED',

    /**
     * The ride ended before its reason was ever recorded. Not a guess and not
     * an error — an honest statement that the evidence does not exist.
     */
    LEGACY_UNAVAILABLE = 'LEGACY_UNAVAILABLE',
}

/** Who ended the ride. Null when nobody did (a completion, or a dispatch miss). */
export enum CancelActorRole {
    PASSENGER = 'passenger',
    DRIVER = 'driver',
    ADMIN = 'admin',
    SYSTEM = 'system',
}

/**
 * Display strings. The UI may override these; nothing in the backend branches
 * on them, and no query compares against them.
 */
export const OUTCOME_LABELS: Record<RideOutcomeCode, string> = {
    [RideOutcomeCode.COMPLETED]: 'Completed',
    [RideOutcomeCode.NO_ELIGIBLE_DRIVER]: 'No drivers available',
    [RideOutcomeCode.NO_DRIVER_ACCEPTED]: 'No driver accepted',
    [RideOutcomeCode.REQUEST_EXPIRED]: 'Search timed out',
    [RideOutcomeCode.TECHNICAL_FAILURE]: 'Technical failure',
    [RideOutcomeCode.PASSENGER_CANCELLED]: 'Passenger cancelled',
    [RideOutcomeCode.DRIVER_CANCELLED]: 'Driver cancelled',
    [RideOutcomeCode.ADMIN_CANCELLED]: 'Admin cancelled',
    [RideOutcomeCode.SYSTEM_CANCELLED]: 'System cancelled',
    [RideOutcomeCode.LEGACY_UNAVAILABLE]: 'Reason unavailable — legacy ride',
};

/**
 * The operationally important distinction, stated once so reporting cannot
 * drift from the console.
 *
 * `supply` — demand existed and we had nobody to serve it. Recruit drivers.
 * `behaviour` — we had drivers and they did not take the trip. Different fix.
 * `technical` — we broke. Neither of the above; must not pollute supply stats.
 * `intentional` — somebody chose to end it. Not a failure at all.
 */
export type OutcomeClass = 'success' | 'supply' | 'behaviour' | 'technical' | 'intentional' | 'unknown';

export function classifyOutcome(code: RideOutcomeCode | null): OutcomeClass {
    switch (code) {
        case RideOutcomeCode.COMPLETED:
            return 'success';
        case RideOutcomeCode.NO_ELIGIBLE_DRIVER:
            return 'supply';
        case RideOutcomeCode.NO_DRIVER_ACCEPTED:
        case RideOutcomeCode.REQUEST_EXPIRED:
            return 'behaviour';
        case RideOutcomeCode.TECHNICAL_FAILURE:
            return 'technical';
        case RideOutcomeCode.PASSENGER_CANCELLED:
        case RideOutcomeCode.DRIVER_CANCELLED:
        case RideOutcomeCode.ADMIN_CANCELLED:
        case RideOutcomeCode.SYSTEM_CANCELLED:
            return 'intentional';
        default:
            return 'unknown';
    }
}

/**
 * Map a dispatch outcome code (as produced by DispatchEvidence and persisted in
 * the `dispatch_failed` event) onto a ride outcome code.
 *
 * These already share a vocabulary; this exists so the coupling is explicit and
 * a change on either side fails a test rather than silently mislabelling rides.
 */
export function outcomeFromDispatchCode(code: string | null | undefined): RideOutcomeCode | null {
    switch (code) {
        case 'NO_ELIGIBLE_DRIVER':
            return RideOutcomeCode.NO_ELIGIBLE_DRIVER;
        case 'NO_DRIVER_ACCEPTED':
            return RideOutcomeCode.NO_DRIVER_ACCEPTED;
        case 'REQUEST_EXPIRED':
            return RideOutcomeCode.REQUEST_EXPIRED;
        default:
            return null;
    }
}

/**
 * Map a persisted `cancellationReason` onto an outcome code and actor.
 *
 * The vocabulary is closed and comes from two places: the passenger cancel
 * handler (`passenger_cancelled`) and StaleResolution, which RideCleanupService
 * writes. Driver-initiated and support-initiated cancellations DO exist in this
 * product — they arrive through the mutual cancellation-request flow and
 * through support escalation respectively — so both are attributed here rather
 * than being lumped in with "system".
 *
 * `requestedBy` disambiguates the one genuinely ambiguous reason. When one
 * party asks to cancel and the other never answers, the request stands; the
 * ride ends because of the party who asked, not because of the system. That
 * actor is recorded on the ride as `cancellationRequestedBy`, so it is passed
 * in rather than guessed. Absent it, the honest answer is `system`.
 *
 * Anything unrecognised beginning `SYSTEM_` is a system cancellation — that
 * prefix is an invariant of StaleResolution, not an inference. Anything else
 * unrecognised returns null rather than being forced into a bucket.
 */
export function outcomeFromCancellationReason(
    reason: string | null | undefined,
    requestedBy?: string | null,
): { code: RideOutcomeCode; actor: CancelActorRole } | null {
    if (!reason) return null;
    switch (reason) {
        case 'passenger_cancelled':
        case 'CANCELLED_MUTUAL_PASSENGER_INITIATED':
            return { code: RideOutcomeCode.PASSENGER_CANCELLED, actor: CancelActorRole.PASSENGER };

        case 'driver_cancelled':
        case 'CANCELLED_MUTUAL_DRIVER_INITIATED':
            return { code: RideOutcomeCode.DRIVER_CANCELLED, actor: CancelActorRole.DRIVER };

        case 'admin_cancelled':
        case 'SUPPORT_RESOLVED':
            return { code: RideOutcomeCode.ADMIN_CANCELLED, actor: CancelActorRole.ADMIN };

        case 'CANCELLED_REQUEST_UNANSWERED':
            if (requestedBy === 'passenger') {
                return { code: RideOutcomeCode.PASSENGER_CANCELLED, actor: CancelActorRole.PASSENGER };
            }
            if (requestedBy === 'driver') {
                return { code: RideOutcomeCode.DRIVER_CANCELLED, actor: CancelActorRole.DRIVER };
            }
            return { code: RideOutcomeCode.SYSTEM_CANCELLED, actor: CancelActorRole.SYSTEM };

        default:
            if (reason.startsWith('SYSTEM_')) {
                return { code: RideOutcomeCode.SYSTEM_CANCELLED, actor: CancelActorRole.SYSTEM };
            }
            return null;
    }
}

/**
 * What to show for a ride whose outcome was never recorded.
 *
 * Used only when a terminal ride has no `outcomeReason`, no dispatch_failed
 * event and no cancellationReason — i.e. it predates this telemetry. The label
 * is deliberately explicit about WHY it is blank so nobody reads it as a bug.
 */
export const LEGACY_UNAVAILABLE = {
    code: RideOutcomeCode.LEGACY_UNAVAILABLE,
    label: OUTCOME_LABELS[RideOutcomeCode.LEGACY_UNAVAILABLE],
} as const;

/** Human label for a code, with the legacy fallback for null. */
export function outcomeLabel(code: string | null | undefined): string {
    if (!code) return LEGACY_UNAVAILABLE.label;
    return OUTCOME_LABELS[code as RideOutcomeCode] ?? code;
}
