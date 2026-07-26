/**
 * Human-centred coordination for delayed rides.
 *
 * A ride is two real people coordinating in the real world. Traffic, a police
 * checkpoint, road works, rain, a passenger still inside a building, a driver at
 * a locked gate, security clearance, a slow lift, office reception — all normal.
 *
 * So the rules under test are:
 *   - time triggers COMMUNICATION, never cancellation
 *   - any meaningful interaction keeps the ride alive
 *   - cancelling is a two-person act
 *   - one party going quiet ESCALATES to a human; it does not cancel
 *   - the only clock-driven termination is mutual abandonment, with evidence
 */
import { StaleRideService, RideSnapshot } from '../../src/services/stale_ride_service';
import {
    loadStaleRideConfig,
    StaleRideConfig,
    StaleActionReason,
    StaleResolution,
    RideDelayState,
    RideActivityType,
} from '../../src/config/stale_ride_config';

const CONFIG: StaleRideConfig = {
    ...loadStaleRideConfig(),
    acceptedMinMinutes: 20,
    acceptedEtaMultiplier: 3,
    acceptedMaxMinutes: 45,
    arrivedWarnMinutes: 10,
    arrivedCancelMinutes: 20,
    decisionWindowMinutes: 3,
    extensionMinutes: 10,
    maxExtensions: 1,
    warnAtDeadlineFraction: 0.6,
    kekeMetresPerMinute: 230,
    reminderIntervalMinutes: 12,
    reminderIntervalPerTripHour: 5,
    reminderMinIntervalMinutes: 10,
    partyOfflineMinutes: 10,
    escalateAfterOfflineMinutes: 15,
    mutualAbandonmentMinutes: 90,
    approachProgressMetres: 150,
};

const T0 = new Date('2026-07-26T06:00:00Z');
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const MIN = 60_000;

const ride = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
    rideId: 'RIDE-COORD',
    status: 'accepted',
    passengerId: 'pax-1',
    driverId: 'drv-1',
    acceptedAt: T0,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    estimatedDurationSec: null,
    acceptLat: null, acceptLng: null,
    pickupLat: 6.2097, pickupLng: 7.0562,
    staleWarnedAt: at(12),
    staleExtensionCount: 0,
    staleDeadlineOverrideAt: null,
    requiresOperationsReview: false,
    staleDecisionPromptedAt: null,
    staleDecisionDeadlineAt: null,
    staleDecisionBy: null,
    staleDecisionChoice: null,
    staleDecisionRound: 0,
    lastActivityAt: null,
    lastActivityType: null,
    lastReminderAt: null,
    // Both reachable unless a test says otherwise.
    driverLive: true,
    passengerLive: true,
    driverOfflineForMs: null,
    passengerOfflineForMs: null,
    cancellationRequestedBy: null,
    cancellationRequestedAt: null,
    cancellationRequestState: null,
    escalatedToSupportAt: null,
    ...over,
});

const asked = (over: Partial<RideSnapshot> = {}, promptedAt = 21) => ride({
    staleDecisionPromptedAt: at(promptedAt),
    staleDecisionDeadlineAt: at(promptedAt + CONFIG.decisionWindowMinutes),
    staleDecisionRound: 1,
    lastReminderAt: at(promptedAt),
    ...over,
});

// ── The core principle ─────────────────────────────────────────────────────
describe('time alone never means failure', () => {
    it('a long delay with both parties reachable NEVER cancels', () => {
        // Four days late — the original incident — but both apps are alive.
        // Real delays happen; the system talks instead of terminating.
        for (const minutes of [21, 46, 120, 600, 1440, 5477]) {
            const e = StaleRideService.evaluate(ride(), CONFIG, at(minutes));
            expect(e.action).not.toBe('cancel');
        }
    });

    it('the first thing a passed deadline produces is a conversation', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(21));
        expect(e.action).toBe('prompt_decision');
        expect(e.promptParties).toEqual(['passenger', 'driver']);
        expect(e.delayState).toBe(RideDelayState.AWAITING_CONFIRMATION);
        expect(e.explanation).toContain('nothing is cancelled');
    });

    it('no un-prompted ride can ever reach cancel while anyone is reachable', () => {
        for (const status of ['accepted', 'arrived']) {
            for (const minutes of [21, 100, 5000, 100_000]) {
                const e = StaleRideService.evaluate(
                    ride({ status, arrivedAt: status === 'arrived' ? T0 : null }),
                    CONFIG, at(minutes),
                );
                expect(e.action).not.toBe('cancel');
            }
        }
    });
});

// ── Stage 1-3: warn, inform, keep waiting ──────────────────────────────────
describe('a confirmed delay is a healthy coordination state', () => {
    it('a driver who confirmed shows as en route, not as a problem', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'wait' }),
            CONFIG, at(23),
        );
        expect(e.action).toBe('none');
        expect(e.delayState).toBe(RideDelayState.DRIVER_CONFIRMED_EN_ROUTE);
    });

    it('a passenger who confirmed shows as waiting', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'passenger', staleDecisionChoice: 'wait' }),
            CONFIG, at(23),
        );
        expect(e.delayState).toBe(RideDelayState.PASSENGER_WAITING);
    });

    it('does NOT nag: no reminder before the interval elapses', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'wait', lastReminderAt: at(22) }),
            CONFIG, at(25),
        );
        expect(e.action).toBe('none');
    });

    it('checks in again after the reminder interval', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'wait', lastReminderAt: at(22) }),
            CONFIG, at(22 + CONFIG.reminderIntervalMinutes + 1),
        );
        expect(e.action).toBe('remind');
        expect(e.promptParties).toEqual(['passenger', 'driver']);
    });

    it('scales the reminder interval up for a long trip', () => {
        const short = ride({ estimatedDurationSec: 10 * 60 });
        const long = ride({ estimatedDurationSec: 2 * 3600 });
        const shortInterval = StaleRideService.reminderIntervalMinutes(short, CONFIG);
        const longInterval = StaleRideService.reminderIntervalMinutes(long, CONFIG);
        expect(longInterval).toBeGreaterThan(shortInterval);
        // Never below the floor, however short the trip.
        expect(shortInterval).toBeGreaterThanOrEqual(CONFIG.reminderMinIntervalMinutes);
    });
});

// ── Stage 4: cancelling is a two-person act ────────────────────────────────
describe('a cancellation request goes to the other party', () => {
    it('a pending request waits for the other side, and says so', () => {
        const e = StaleRideService.evaluate(
            asked({
                cancellationRequestedBy: 'passenger',
                cancellationRequestState: 'pending',
                cancellationRequestedAt: at(22),
            }),
            CONFIG, at(23),
        );
        expect(e.action).toBe('none');
        expect(e.delayState).toBe(RideDelayState.CANCELLATION_REQUESTED);
        expect(e.explanation).toContain('asked to cancel');
        expect(e.explanation).toContain('waiting for the driver');
    });

    it('a request outranks everything else, including a long delay', () => {
        const e = StaleRideService.evaluate(
            asked({
                cancellationRequestedBy: 'driver',
                cancellationRequestState: 'pending',
                cancellationRequestedAt: at(22),
            }),
            CONFIG, at(500),
        );
        // Not cancelled by the clock: the other party still gets to answer.
        expect(e.delayState).toBe(RideDelayState.CANCELLATION_REQUESTED);
    });

    it('an unanswered request eventually stands — still a human decision', () => {
        const e = StaleRideService.evaluate(
            asked({
                cancellationRequestedBy: 'passenger',
                cancellationRequestState: 'pending',
                cancellationRequestedAt: at(22),
            }),
            CONFIG, at(22 + CONFIG.decisionWindowMinutes + 1),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.CANCELLED_REQUEST_UNANSWERED);
        expect(e.explanation).toContain('did not respond');
    });

    it('a declined request is not treated as pending', () => {
        const e = StaleRideService.evaluate(
            asked({
                cancellationRequestedBy: 'passenger',
                cancellationRequestState: 'declined',
                cancellationRequestedAt: at(22),
                staleDecisionBy: 'driver',
                staleDecisionChoice: 'wait',
            }),
            CONFIG, at(30),
        );
        expect(e.action).not.toBe('cancel');
        expect(e.delayState).toBe(RideDelayState.DRIVER_CONFIRMED_EN_ROUTE);
    });
});

// ── Stage 5: unresponsive party escalates, never cancels ───────────────────
describe('one party engaged and the other unreachable escalates to a human', () => {
    it('an unreachable driver escalates rather than cancelling', () => {
        const e = StaleRideService.evaluate(
            asked({
                staleDecisionBy: 'passenger',
                staleDecisionChoice: 'wait',
                driverLive: false,
                driverOfflineForMs: 16 * MIN,
                passengerLive: true,
            }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('escalate');
        expect(e.action).not.toBe('cancel');
        expect(e.escalationTarget).toBe('driver');
        expect(e.delayState).toBe(RideDelayState.DRIVER_OFFLINE);
        expect(e.explanation).toContain('NOT cancelling');
    });

    it('an unreachable passenger at the pickup point escalates too', () => {
        const e = StaleRideService.evaluate(
            asked({
                status: 'arrived',
                arrivedAt: T0,
                staleDecisionBy: 'driver',
                staleDecisionChoice: 'wait',
                passengerLive: false,
                passengerOfflineForMs: 20 * MIN,
                driverLive: true,
            }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('escalate');
        expect(e.escalationTarget).toBe('passenger');
        expect(e.delayState).toBe(RideDelayState.PASSENGER_OFFLINE);
    });

    it('does not escalate before the offline threshold', () => {
        const e = StaleRideService.evaluate(
            asked({ driverLive: false, driverOfflineForMs: 5 * MIN }),
            CONFIG, at(30),
        );
        expect(e.action).not.toBe('escalate');
        expect(e.action).not.toBe('cancel');
    });

    it('an already-escalated ride is left to the human who owns it', () => {
        const e = StaleRideService.evaluate(
            asked({
                driverLive: false,
                driverOfflineForMs: 60 * MIN,
                escalatedToSupportAt: at(40),
            }),
            CONFIG, at(200),
        );
        expect(e.action).toBe('none');
        expect(e.delayState).toBe(RideDelayState.ESCALATED_TO_SUPPORT);
        expect(e.explanation).toContain('awaiting a human decision');
    });
});

// ── The only clock-driven termination ──────────────────────────────────────
describe('mutual abandonment is the sole automatic termination', () => {
    it('cancels only when BOTH are gone and quiet past the threshold', () => {
        const e = StaleRideService.evaluate(
            asked({
                driverLive: false,
                passengerLive: false,
                driverOfflineForMs: 60 * MIN,
                passengerOfflineForMs: 60 * MIN,
                lastActivityAt: at(0),
            }),
            CONFIG, at(CONFIG.mutualAbandonmentMinutes + 5),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.ABANDONED_BY_BOTH);
        expect(e.explanation).toContain('any sign of life');
        expect(e.explanation).toContain('treating the ride as abandoned');
    });

    it('does NOT cancel when both are gone but not yet past the threshold', () => {
        const e = StaleRideService.evaluate(
            asked({
                driverLive: false,
                passengerLive: false,
                lastActivityAt: at(20),
            }),
            CONFIG, at(30),
        );
        expect(e.action).not.toBe('cancel');
    });

    it('does NOT cancel when even one party is still reachable', () => {
        const e = StaleRideService.evaluate(
            asked({
                driverLive: false,
                passengerLive: true,
                driverOfflineForMs: 200 * MIN,
                lastActivityAt: at(0),
            }),
            CONFIG, at(500),
        );
        expect(e.action).not.toBe('cancel');
    });

    it('recent activity resets the abandonment clock', () => {
        const e = StaleRideService.evaluate(
            asked({
                driverLive: false,
                passengerLive: false,
                // Someone messaged five minutes ago, so the ride is not abandoned.
                lastActivityAt: at(495),
                lastActivityType: RideActivityType.CHAT_MESSAGE,
            }),
            CONFIG, at(500),
        );
        expect(e.action).not.toBe('cancel');
    });

    it('the abandonment threshold is far longer than the arrival deadline', () => {
        // A delay must have a great deal of room before it looks like abandonment.
        expect(CONFIG.mutualAbandonmentMinutes).toBeGreaterThan(CONFIG.acceptedMaxMinutes);
        expect(CONFIG.mutualAbandonmentMinutes).toBeGreaterThan(CONFIG.escalateAfterOfflineMinutes);
    });
});

// ── Stage 6/7: arrival and trip start change the story ─────────────────────
describe('arrival and trip start change the workflow entirely', () => {
    it('an arrived ride is no longer a driver-delay scenario', () => {
        const e = StaleRideService.evaluate(
            ride({ arrivedAt: at(19) }), CONFIG, at(5000),
        );
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('already marked arrived');
    });

    it('a started trip is never touched by accepted-ride logic', () => {
        for (const minutes of [30, 200, 5000]) {
            const e = StaleRideService.evaluate(
                ride({ status: 'in_progress', arrivedAt: T0, startedAt: at(20) }),
                CONFIG, at(minutes),
            );
            expect(e.action).not.toBe('cancel');
            expect(e.action).not.toBe('prompt_decision');
        }
    });

    it('an over-running trip is flagged for a human, never cancelled', () => {
        const e = StaleRideService.evaluate(
            ride({ status: 'in_progress', startedAt: T0 }), CONFIG, at(400),
        );
        expect(e.action).toBe('flag_for_review');
        expect(e.reason).toBe(StaleActionReason.TRIP_EXCEEDED_EXPECTED_DURATION);
    });

    it('a started trip cannot be cancelled even with a pending request', () => {
        const e = StaleRideService.evaluate(
            ride({
                status: 'in_progress',
                startedAt: at(20),
                cancellationRequestedBy: 'passenger',
                cancellationRequestState: 'pending',
                cancellationRequestedAt: at(21),
            }),
            CONFIG, at(500),
        );
        expect(e.action).not.toBe('cancel');
    });
});

// ── Escalation hierarchy ───────────────────────────────────────────────────
describe('the escalation hierarchy is respected in order', () => {
    it('observe -> warn -> ask -> remind -> escalate -> terminate', () => {
        const seen: string[] = [];
        // Observe
        seen.push(StaleRideService.evaluate(ride({ staleWarnedAt: null }), CONFIG, at(5)).action);
        // Warn
        seen.push(StaleRideService.evaluate(ride({ staleWarnedAt: null }), CONFIG, at(13)).action);
        // Ask both
        seen.push(StaleRideService.evaluate(ride(), CONFIG, at(21)).action);
        // Remind
        seen.push(StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'wait', lastReminderAt: at(21) }),
            CONFIG, at(21 + CONFIG.reminderIntervalMinutes + 1),
        ).action);
        // Escalate
        seen.push(StaleRideService.evaluate(
            asked({ driverLive: false, driverOfflineForMs: 20 * MIN }), CONFIG, at(45),
        ).action);
        // Terminate, only on mutual abandonment
        seen.push(StaleRideService.evaluate(
            asked({
                driverLive: false, passengerLive: false, lastActivityAt: at(0),
            }),
            CONFIG, at(CONFIG.mutualAbandonmentMinutes + 5),
        ).action);

        expect(seen).toEqual(['none', 'warn', 'prompt_decision', 'remind', 'escalate', 'cancel']);
    });
});
