/**
 * Stale-ride policy: decides WHAT should happen to a ride, and nothing else.
 *
 * Deliberately pure — no database, no Redis, no sockets, no clock of its own.
 * Every decision is a function of a ride snapshot plus `now`, so the whole
 * policy is exhaustively testable and a reviewer can read the rules in one place
 * instead of inferring them from a worker loop.
 *
 * Execution lives in ride_cleanup_service.ts (terminal actions) and
 * stale_ride_sweeper.ts (scheduling). This file never mutates anything.
 */
import {
    StaleRideConfig,
    StaleActionReason,
    StaleResolution,
    StaleDecisionParty,
    StaleDecisionChoice,
} from '../config/stale_ride_config';

/** The subset of a ride the policy needs. Keeps tests free of entity plumbing. */
export interface RideSnapshot {
    rideId: string;
    status: string;
    passengerId: string | null;
    driverId: string | null;
    acceptedAt: Date | null;
    arrivedAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    /** Estimated TRIP duration (not pickup ETA). Null on older rides. */
    estimatedDurationSec: number | null;
    /** Driver position when they accepted, for deriving a pickup ETA. */
    acceptLat: number | null;
    acceptLng: number | null;
    pickupLat: number | null;
    pickupLng: number | null;
    staleWarnedAt: Date | null;
    staleExtensionCount: number;
    staleDeadlineOverrideAt: Date | null;
    requiresOperationsReview: boolean;
    // The decision window.
    staleDecisionPromptedAt: Date | null;
    staleDecisionDeadlineAt: Date | null;
    staleDecisionBy: string | null;
    staleDecisionChoice: string | null;
    staleDecisionRound: number;
}

export type StaleAction =
    /** Nothing to do. */
    | 'none'
    /** Send a staged heads-up; the deadline has not passed yet. */
    | 'warn'
    /**
     * The deadline passed. Ask BOTH parties whether to keep waiting or cancel.
     * This replaces cancelling on a timer: no ride is ever terminated before its
     * passenger and driver have been asked.
     */
    | 'prompt_decision'
    /**
     * Terminal, and only reachable once a decision window has closed — either
     * because somebody chose to cancel, or because the party the ride is waiting
     * on stayed silent through the permitted rounds.
     */
    | 'cancel'
    /** Flag for a human. Never used for accepted/arrived. */
    | 'flag_for_review';

export interface StaleEvaluation {
    rideId: string;
    status: string;
    action: StaleAction;
    /** The SITUATION (what went wrong). */
    reason: StaleActionReason | null;
    /** For `cancel`, WHO decided or whose silence resolved it. */
    resolution: StaleResolution | null;
    /** Which parties still need to answer, for `prompt_decision`. */
    promptParties: StaleDecisionParty[];
    /** When the decision window closes, for `prompt_decision`. */
    decisionDeadlineAt: Date | null;
    /** Why the policy chose this, in plain words, for dry-run output and logs. */
    explanation: string;
    /** Reference instant the deadline is measured from. */
    since: Date | null;
    /** Age at evaluation, in minutes. */
    ageMinutes: number | null;
    /** Allowance in minutes, after ETA scaling, clamping and any extension. */
    deadlineMinutes: number | null;
    /** Absolute moment the deadline expires. */
    deadlineAt: Date | null;
    /** Derived pickup ETA in minutes, when computable. */
    estimatedPickupEtaMinutes: number | null;
}

const MS_PER_MIN = 60_000;

/** Great-circle distance in metres. */
function haversineMetres(
    aLat: number, aLng: number, bLat: number, bLng: number,
): number {
    const R = 6_371_000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const sLat = Math.sin(dLat / 2);
    const sLng = Math.sin(dLng / 2);
    const h =
        sLat * sLat +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * sLng * sLng;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export class StaleRideService {
    /**
     * Pickup ETA in minutes, derived from where the driver was when they
     * accepted to where the passenger is waiting.
     *
     * The passenger app computes this client-side and never transmits it, so it
     * is not stored — but accept coordinates are, which makes it recoverable
     * server-side. Uses the same assumed speed the passenger was shown, so the
     * operator's numbers match the passenger's experience.
     *
     * Returns null when accept coordinates are missing (driver GPS unavailable
     * at accept), in which case the caller falls back to the configured minimum.
     */
    static estimatedPickupEtaMinutes(ride: RideSnapshot, config: StaleRideConfig): number | null {
        const { acceptLat, acceptLng, pickupLat, pickupLng } = ride;
        if (acceptLat == null || acceptLng == null || pickupLat == null || pickupLng == null) return null;
        const a = Number(acceptLat), b = Number(acceptLng), c = Number(pickupLat), d = Number(pickupLng);
        if (![a, b, c, d].every(Number.isFinite)) return null;
        // 0,0 is the "no fix" sentinel used elsewhere in the codebase.
        if ((a === 0 && b === 0) || (c === 0 && d === 0)) return null;
        const metres = haversineMetres(a, b, c, d);
        if (!Number.isFinite(metres)) return null;
        return metres / Math.max(1, config.kekeMetresPerMinute);
    }

    /**
     * Arrival allowance for an accepted ride:
     *
     *   clamp(ETA x multiplier, min, max)
     *
     * A driver 30 seconds away and a driver 12 minutes away should not share one
     * flat timeout — a blanket value either cancels legitimate long approaches or
     * lets abandoned nearby ones sit for far too long.
     */
    static acceptedDeadlineMinutes(ride: RideSnapshot, config: StaleRideConfig): {
        deadlineMinutes: number;
        etaMinutes: number | null;
    } {
        const etaMinutes = this.estimatedPickupEtaMinutes(ride, config);
        const scaled = etaMinutes == null
            ? config.acceptedMinMinutes
            : etaMinutes * config.acceptedEtaMultiplier;
        const clamped = Math.min(
            Math.max(scaled, config.acceptedMinMinutes),
            Math.max(config.acceptedMinMinutes, config.acceptedMaxMinutes),
        );
        return { deadlineMinutes: clamped, etaMinutes };
    }

    /** Review threshold for an in-progress trip. */
    static inProgressReviewMinutes(ride: RideSnapshot, config: StaleRideConfig): number {
        const estMinutes = ride.estimatedDurationSec != null
            ? ride.estimatedDurationSec / 60
            : null;
        const scaled = estMinutes == null
            ? config.inProgressMinMinutes
            : estMinutes * config.inProgressDurationMultiplier;
        return Math.min(
            Math.max(scaled, config.inProgressMinMinutes),
            Math.max(config.inProgressMinMinutes, config.inProgressAbsoluteMinutes),
        );
    }

    /**
     * Decide what should happen to one ride.
     *
     * Ordering matters: a later lifecycle event always wins. A ride with
     * `arrivedAt` set is no longer an accepted-ride candidate however old its
     * `acceptedAt` is, so a driver who arrives seconds before the sweep can
     * never be cancelled for not arriving.
     */
    static evaluate(ride: RideSnapshot, config: StaleRideConfig, now: Date): StaleEvaluation {
        const base: StaleEvaluation = {
            rideId: ride.rideId,
            status: ride.status,
            action: 'none',
            reason: null,
            resolution: null,
            promptParties: [],
            decisionDeadlineAt: null,
            explanation: '',
            since: null,
            ageMinutes: null,
            deadlineMinutes: null,
            deadlineAt: null,
            estimatedPickupEtaMinutes: null,
        };

        // Terminal or not-yet-assigned rides are never candidates. `searching` is
        // owned by the dispatch orchestrator's own lifetime budget.
        if (ride.completedAt != null) {
            return { ...base, explanation: 'ride already has completedAt' };
        }

        // ── accepted, never arrived ──────────────────────────────────────
        if (ride.status === 'accepted') {
            // Any later event disqualifies it, regardless of age.
            if (ride.arrivedAt != null) {
                return { ...base, explanation: 'driver already marked arrived' };
            }
            if (ride.startedAt != null) {
                return { ...base, explanation: 'trip already started' };
            }
            const since = ride.acceptedAt;
            if (since == null) {
                // Pre-dates acceptedAt being recorded; the sweep must not guess.
                return { ...base, explanation: 'no acceptedAt timestamp — not evaluable' };
            }

            const { deadlineMinutes, etaMinutes } = this.acceptedDeadlineMinutes(ride, config);
            // An extension moves the deadline, but only within maxExtensions.
            const effectiveDeadlineAt = ride.staleDeadlineOverrideAt != null
                ? new Date(Math.max(
                    since.getTime() + deadlineMinutes * MS_PER_MIN,
                    ride.staleDeadlineOverrideAt.getTime(),
                ))
                : new Date(since.getTime() + deadlineMinutes * MS_PER_MIN);

            const ageMinutes = (now.getTime() - since.getTime()) / MS_PER_MIN;
            const common = {
                ...base,
                since,
                ageMinutes,
                deadlineMinutes,
                deadlineAt: effectiveDeadlineAt,
                estimatedPickupEtaMinutes: etaMinutes,
            };

            if (now.getTime() >= effectiveDeadlineAt.getTime()) {
                // Deadline reached. Ask, do not cancel.
                return this.resolveDecision(ride, config, now, {
                    ...common,
                    reason: StaleActionReason.DRIVER_DID_NOT_ARRIVE,
                    // The ride is waiting on the DRIVER to arrive, so the driver's
                    // silence is what makes waiting pointless.
                    awaitingParty: 'driver',
                    situation:
                        `accepted ${ageMinutes.toFixed(1)}min ago, never arrived; allowance ` +
                        `${deadlineMinutes.toFixed(1)}min` +
                        (etaMinutes != null ? ` (pickup ETA ${etaMinutes.toFixed(1)}min)` : ' (no ETA available)'),
                });
            }

            // Staged warning once most of the allowance is gone, and only once.
            const warnAt = since.getTime() + deadlineMinutes * config.warnAtDeadlineFraction * MS_PER_MIN;
            if (ride.staleWarnedAt == null && now.getTime() >= warnAt) {
                return {
                    ...common,
                    action: 'warn',
                    reason: StaleActionReason.DRIVER_DID_NOT_ARRIVE,
                    explanation:
                        `accepted ${ageMinutes.toFixed(1)}min ago; warning driver before the ` +
                        `${deadlineMinutes.toFixed(1)}min arrival deadline`,
                };
            }

            return { ...common, explanation: 'within arrival allowance' };
        }

        // ── arrived, trip never started ──────────────────────────────────
        if (ride.status === 'arrived') {
            if (ride.startedAt != null) {
                return { ...base, explanation: 'trip already started' };
            }
            const since = ride.arrivedAt;
            if (since == null) {
                return { ...base, explanation: 'no arrivedAt timestamp — not evaluable' };
            }

            const deadlineMinutes = config.arrivedCancelMinutes;
            const effectiveDeadlineAt = ride.staleDeadlineOverrideAt != null
                ? new Date(Math.max(
                    since.getTime() + deadlineMinutes * MS_PER_MIN,
                    ride.staleDeadlineOverrideAt.getTime(),
                ))
                : new Date(since.getTime() + deadlineMinutes * MS_PER_MIN);

            const ageMinutes = (now.getTime() - since.getTime()) / MS_PER_MIN;
            const common = {
                ...base,
                since,
                ageMinutes,
                deadlineMinutes,
                deadlineAt: effectiveDeadlineAt,
            };

            if (now.getTime() >= effectiveDeadlineAt.getTime()) {
                return this.resolveDecision(ride, config, now, {
                    ...common,
                    // Deliberately blames nobody. Calling this a passenger no-show
                    // would be a guess: a timer expiring is not evidence anyone
                    // failed to show up, and no driver flow collects that.
                    reason: StaleActionReason.TRIP_NOT_STARTED_AFTER_ARRIVAL,
                    // The driver is present and waiting; the trip needs the
                    // PASSENGER to appear, so their silence is decisive.
                    awaitingParty: 'passenger',
                    situation:
                        `driver arrived ${ageMinutes.toFixed(1)}min ago, trip never started; ` +
                        `grace ${deadlineMinutes}min`,
                });
            }

            if (ride.staleWarnedAt == null && ageMinutes >= config.arrivedWarnMinutes) {
                return {
                    ...common,
                    action: 'warn',
                    reason: StaleActionReason.TRIP_NOT_STARTED_AFTER_ARRIVAL,
                    explanation:
                        `arrived ${ageMinutes.toFixed(1)}min ago; reminding both parties to start the trip`,
                };
            }

            return { ...common, explanation: 'within post-arrival grace period' };
        }

        // ── in progress, never completed ─────────────────────────────────
        // NEVER auto-cancelled. A trip physically happened and a fare is owed;
        // cancelling would destroy the driver's earnings and the payment record.
        if (ride.status === 'in_progress' || ride.status === 'started') {
            const since = ride.startedAt;
            if (since == null) {
                return { ...base, explanation: 'no startedAt timestamp — not evaluable' };
            }
            const deadlineMinutes = this.inProgressReviewMinutes(ride, config);
            const ageMinutes = (now.getTime() - since.getTime()) / MS_PER_MIN;
            const common = {
                ...base,
                since,
                ageMinutes,
                deadlineMinutes,
                deadlineAt: new Date(since.getTime() + deadlineMinutes * MS_PER_MIN),
            };

            if (ride.requiresOperationsReview) {
                return { ...common, explanation: 'already flagged for operations review' };
            }
            if (ageMinutes >= deadlineMinutes) {
                return {
                    ...common,
                    action: 'flag_for_review',
                    reason: StaleActionReason.TRIP_EXCEEDED_EXPECTED_DURATION,
                    explanation:
                        `in progress ${ageMinutes.toFixed(1)}min, past the ` +
                        `${deadlineMinutes.toFixed(0)}min review threshold; flagged for operations ` +
                        `(never auto-cancelled — a real fare may be owed)`,
                };
            }
            return { ...common, explanation: 'within expected trip duration' };
        }

        return { ...base, explanation: `status "${ride.status}" is not swept` };
    }

    /**
     * The decision window. Called once a state's deadline has passed.
     *
     * This is what makes cancellation a conversation rather than a timeout. The
     * possible outcomes, in order:
     *
     *  1. Nobody has been asked yet          -> `prompt_decision` (ask BOTH)
     *  2. Somebody chose "cancel"            -> `cancel`, attributed to them
     *  3. Somebody chose "wait"              -> `none`; the extension moved the
     *                                           deadline, so we re-ask later
     *  4. Window still open, nobody answered -> `none`; keep waiting
     *  5. Window closed, nobody answered     -> `cancel` on silence
     *  6. Window closed, only the OTHER party answered "wait", and the party the
     *     ride is waiting on has been silent through the permitted rounds
     *                                        -> `cancel`, naming who was silent
     *
     * `awaitingParty` is the party whose action the ride actually needs — the
     * driver arriving, or the passenger appearing. Their silence is decisive
     * because no amount of waiting substitutes for it.
     */
    private static resolveDecision(
        ride: RideSnapshot,
        config: StaleRideConfig,
        now: Date,
        ctx: StaleEvaluation & {
            reason: StaleActionReason;
            awaitingParty: StaleDecisionParty;
            situation: string;
        },
    ): StaleEvaluation {
        const { awaitingParty, situation, ...common } = ctx;
        const bothParties: StaleDecisionParty[] = ['passenger', 'driver'];

        // 1. Nobody asked yet — this is the first thing that happens at a deadline.
        if (ride.staleDecisionPromptedAt == null) {
            return {
                ...common,
                action: 'prompt_decision',
                promptParties: bothParties,
                decisionDeadlineAt: new Date(now.getTime() + config.decisionWindowMinutes * MS_PER_MIN),
                explanation:
                    `${situation}. Asking both parties whether to keep waiting or cancel ` +
                    `(${config.decisionWindowMinutes}min to respond) — nothing is cancelled yet`,
            };
        }

        const choice = ride.staleDecisionChoice as StaleDecisionChoice | null;
        const by = ride.staleDecisionBy as StaleDecisionParty | null;

        // 2. Somebody said cancel. Their choice is honoured immediately.
        if (choice === 'cancel' && by) {
            return {
                ...common,
                action: 'cancel',
                resolution: by === 'passenger'
                    ? StaleResolution.PASSENGER_CHOSE_CANCEL
                    : StaleResolution.DRIVER_CHOSE_CANCEL,
                explanation: `${situation}. The ${by} chose to cancel when asked`,
            };
        }

        // 3. Somebody said wait. The extension pushed the deadline, so the outer
        //    branch has already decided we are inside it; nothing to do now.
        //    (If the extension has since lapsed, `staleDecisionDeadlineAt` gates
        //    the next round below.)
        const windowClosed = ride.staleDecisionDeadlineAt != null
            && now.getTime() >= ride.staleDecisionDeadlineAt.getTime();

        if (choice === 'wait' && by) {
            const roundsUsed = ride.staleDecisionRound;
            const canAskAgain = roundsUsed <= config.maxExtensions;
            if (!windowClosed || canAskAgain) {
                // Re-ask on the next deadline rather than acting now.
                return {
                    ...common,
                    action: 'none',
                    explanation:
                        `${situation}. The ${by} chose to keep waiting ` +
                        `(round ${roundsUsed}/${config.maxExtensions}); will ask again at the new deadline`,
                };
            }
            // 6. One side is co-operating, the other never answered across every
            //    permitted round. Waiting longer cannot produce the missing party.
            if (by !== awaitingParty) {
                return {
                    ...common,
                    action: 'cancel',
                    resolution: awaitingParty === 'driver'
                        ? StaleResolution.DRIVER_UNRESPONSIVE
                        : StaleResolution.PASSENGER_UNRESPONSIVE,
                    explanation:
                        `${situation}. The ${by} kept waiting, but the ${awaitingParty} never ` +
                        `responded across ${config.maxExtensions + 1} rounds`,
                };
            }
            return {
                ...common,
                action: 'cancel',
                resolution: StaleResolution.NO_RESPONSE_FROM_EITHER,
                explanation:
                    `${situation}. Extensions exhausted with no resolution from either party`,
            };
        }

        // 4. Window still open and nobody has answered. Wait for them.
        if (!windowClosed) {
            const secondsLeft = ride.staleDecisionDeadlineAt
                ? Math.max(0, Math.round((ride.staleDecisionDeadlineAt.getTime() - now.getTime()) / 1000))
                : 0;
            return {
                ...common,
                action: 'none',
                promptParties: bothParties,
                decisionDeadlineAt: ride.staleDecisionDeadlineAt,
                explanation:
                    `${situation}. Both parties asked; ${secondsLeft}s left to respond`,
            };
        }

        // 5. Window closed with silence from everyone. Nobody is engaged with this
        //    ride, so holding the passenger's booking slot and the driver's
        //    availability open helps no one.
        return {
            ...common,
            action: 'cancel',
            resolution: StaleResolution.NO_RESPONSE_FROM_EITHER,
            explanation:
                `${situation}. Both parties were asked and neither responded within ` +
                `${config.decisionWindowMinutes}min`,
        };
    }

    /** Whether a "keep waiting" choice may still be accepted for this ride. */
    static canExtend(ride: RideSnapshot, config: StaleRideConfig): boolean {
        if (ride.status !== 'accepted' && ride.status !== 'arrived') return false;
        if (ride.startedAt != null || ride.completedAt != null) return false;
        return ride.staleExtensionCount < config.maxExtensions;
    }
}
