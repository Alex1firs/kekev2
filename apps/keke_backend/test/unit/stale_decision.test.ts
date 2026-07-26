/**
 * The decision window.
 *
 * A stale ride is never cancelled on a timer. Both parties are asked first, and a
 * cancellation only follows an explicit choice or silence from the party the ride
 * is actually waiting on. These tests pin that: the central property is that NO
 * evaluation can reach `cancel` unless a prompt is on record.
 */
import { StaleRideService, RideSnapshot } from '../../src/services/stale_ride_service';
import {
    loadStaleRideConfig,
    StaleRideConfig,
    StaleActionReason,
    StaleResolution,
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
};

const T0 = new Date('2026-07-26T06:00:00Z');
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

const ride = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
    rideId: 'RIDE-DECISION',
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
    ...over,
});

/** Prompt sent at `promptedAt`, window closing `decisionWindowMinutes` later. */
const asked = (over: Partial<RideSnapshot> = {}, promptedAt = 21) => ride({
    staleDecisionPromptedAt: at(promptedAt),
    staleDecisionDeadlineAt: at(promptedAt + CONFIG.decisionWindowMinutes),
    staleDecisionRound: 1,
    ...over,
});

// ── The invariant ──────────────────────────────────────────────────────────
describe('no silent cancellations', () => {
    it('an un-prompted ride NEVER evaluates to cancel, at any age', () => {
        const ages = [21, 25, 46, 120, 1440, 5477, 100_000];
        for (const status of ['accepted', 'arrived']) {
            for (const minutes of ages) {
                const e = StaleRideService.evaluate(
                    ride({ status, arrivedAt: status === 'arrived' ? T0 : null,
                           staleDecisionPromptedAt: null }),
                    CONFIG, at(minutes),
                );
                expect(e.action).not.toBe('cancel');
                expect(e.resolution).toBeNull();
            }
        }
    });

    it('the first thing a passed deadline produces is a prompt to BOTH parties', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(21));
        expect(e.action).toBe('prompt_decision');
        expect(e.promptParties).toEqual(['passenger', 'driver']);
        expect(e.decisionDeadlineAt).not.toBeNull();
        expect(e.explanation).toContain('nothing is cancelled yet');
    });

    it('gives them the configured window to answer', () => {
        const e = StaleRideService.evaluate(ride(), CONFIG, at(21));
        const windowMs = e.decisionDeadlineAt!.getTime() - at(21).getTime();
        expect(Math.round(windowMs / 60_000)).toBe(CONFIG.decisionWindowMinutes);
    });
});

// ── Waiting for an answer ──────────────────────────────────────────────────
describe('while the window is open, nothing happens', () => {
    it('holds while both are still deciding', () => {
        const e = StaleRideService.evaluate(asked(), CONFIG, at(22));
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('left to respond');
    });

    it('does not re-prompt a ride already asked', () => {
        const e = StaleRideService.evaluate(asked(), CONFIG, at(23));
        expect(e.action).not.toBe('prompt_decision');
    });
});

// ── Explicit choices ───────────────────────────────────────────────────────
describe('an explicit cancel is honoured and attributed', () => {
    it('the passenger choosing cancel resolves as PASSENGER_CHOSE_CANCEL', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'passenger', staleDecisionChoice: 'cancel' }),
            CONFIG, at(22),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.PASSENGER_CHOSE_CANCEL);
        expect(e.explanation).toContain('passenger chose to cancel');
    });

    it('the driver choosing cancel resolves as DRIVER_CHOSE_CANCEL', () => {
        const e = StaleRideService.evaluate(
            asked({ status: 'arrived', arrivedAt: T0, staleDecisionBy: 'driver', staleDecisionChoice: 'cancel' }),
            CONFIG, at(22),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.DRIVER_CHOSE_CANCEL);
    });

    it('honours a cancel immediately, without waiting for the window to close', () => {
        // Chosen one minute into a three-minute window.
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'passenger', staleDecisionChoice: 'cancel' }),
            CONFIG, at(22),
        );
        expect(e.action).toBe('cancel');
    });

    it('still records the underlying situation alongside the decision', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'cancel' }),
            CONFIG, at(22),
        );
        // Situation and resolution are separate facts.
        expect(e.reason).toBe(StaleActionReason.DRIVER_DID_NOT_ARRIVE);
        expect(e.resolution).toBe(StaleResolution.DRIVER_CHOSE_CANCEL);
    });
});

describe('choosing to keep waiting defers, and is bounded', () => {
    it('a "wait" choice inside the window holds the ride', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'passenger', staleDecisionChoice: 'wait' }),
            CONFIG, at(22),
        );
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('chose to keep waiting');
    });

    it('names who chose to wait, and which round it was', () => {
        const e = StaleRideService.evaluate(
            asked({ staleDecisionBy: 'driver', staleDecisionChoice: 'wait', staleDecisionRound: 1 }),
            CONFIG, at(22),
        );
        expect(e.explanation).toContain('driver chose to keep waiting');
        expect(e.explanation).toContain('round 1/1');
    });
});

// ── Silence ────────────────────────────────────────────────────────────────
describe('silence from both parties resolves the ride', () => {
    it('cancels once the window closes with no answer at all', () => {
        const e = StaleRideService.evaluate(asked(), CONFIG, at(25));
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.NO_RESPONSE_FROM_EITHER);
        expect(e.explanation).toContain('neither responded');
    });

    it('does not cancel a second before the window closes', () => {
        // Window closes at 24; at 23.9 it is still open.
        const e = StaleRideService.evaluate(asked(), CONFIG, new Date(at(24).getTime() - 1000));
        expect(e.action).toBe('none');
    });

    it('the resolution names silence rather than blaming anyone', () => {
        const e = StaleRideService.evaluate(asked(), CONFIG, at(30));
        expect(e.resolution).toBe(StaleResolution.NO_RESPONSE_FROM_EITHER);
        expect(e.explanation).not.toMatch(/no.?show/i);
        expect(e.explanation).not.toMatch(/fault|blame/i);
    });
});

describe('one party co-operating, the other silent', () => {
    it('cancels as DRIVER_UNRESPONSIVE when the passenger waited but the driver never answered', () => {
        // accepted -> the ride is waiting on the DRIVER to arrive.
        const e = StaleRideService.evaluate(
            asked({
                staleDecisionBy: 'passenger',
                staleDecisionChoice: 'wait',
                staleDecisionRound: 2,   // beyond maxExtensions (1)
                staleDeadlineOverrideAt: at(24),
            }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.DRIVER_UNRESPONSIVE);
        expect(e.explanation).toContain('passenger kept waiting');
        expect(e.explanation).toContain('driver never');
    });

    it('cancels as PASSENGER_UNRESPONSIVE when the driver waited at the pickup point', () => {
        // arrived -> the ride is waiting on the PASSENGER to appear.
        const e = StaleRideService.evaluate(
            asked({
                status: 'arrived',
                arrivedAt: T0,
                staleDecisionBy: 'driver',
                staleDecisionChoice: 'wait',
                staleDecisionRound: 2,
                staleDeadlineOverrideAt: at(24),
            }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('cancel');
        expect(e.resolution).toBe(StaleResolution.PASSENGER_UNRESPONSIVE);
        expect(e.explanation).toContain('driver kept waiting');
    });

    it('honours the co-operating party for the permitted rounds before resolving', () => {
        // Round 1 of 1: still within the allowance, so keep waiting.
        const e = StaleRideService.evaluate(
            asked({
                staleDecisionBy: 'passenger',
                staleDecisionChoice: 'wait',
                staleDecisionRound: 1,
                staleDeadlineOverrideAt: at(24),
            }),
            CONFIG, at(40),
        );
        expect(e.action).not.toBe('cancel');
    });

    it('a higher maxExtensions grants more patience before resolving', () => {
        const patient = { ...CONFIG, maxExtensions: 3 };
        const e = StaleRideService.evaluate(
            asked({
                staleDecisionBy: 'passenger',
                staleDecisionChoice: 'wait',
                staleDecisionRound: 2,
                staleDeadlineOverrideAt: at(24),
            }),
            patient, at(40),
        );
        expect(e.action).not.toBe('cancel');
    });
});

// ── A newer transition still always wins ───────────────────────────────────
describe('a real transition beats any pending decision', () => {
    it('a driver who arrives mid-decision saves the ride', () => {
        const e = StaleRideService.evaluate(
            asked({ arrivedAt: at(22), staleDecisionBy: null, staleDecisionChoice: null }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('already marked arrived');
    });

    it('a trip that starts mid-decision saves the ride', () => {
        const e = StaleRideService.evaluate(
            asked({ status: 'arrived', arrivedAt: T0, startedAt: at(22) }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('none');
    });

    it('even a pending explicit cancel loses to a completed trip', () => {
        const e = StaleRideService.evaluate(
            asked({
                status: 'completed',
                startedAt: at(22),
                completedAt: at(35),
                staleDecisionBy: 'passenger',
                staleDecisionChoice: 'cancel',
            }),
            CONFIG, at(40),
        );
        expect(e.action).toBe('none');
        expect(e.explanation).toContain('completedAt');
    });
});

// ── In-progress is untouched by all of this ────────────────────────────────
describe('in-progress trips are not part of the decision flow', () => {
    it('is flagged for review, never prompted or cancelled', () => {
        const running = ride({
            status: 'in_progress',
            arrivedAt: T0,
            startedAt: at(5),
            staleDecisionPromptedAt: null,
        });
        const e = StaleRideService.evaluate(running, CONFIG, at(400));
        expect(e.action).toBe('flag_for_review');
        expect(e.action).not.toBe('prompt_decision');
    });

    it('cannot be cancelled even with an explicit cancel choice recorded', () => {
        // Belt and braces: a stray decision row must not terminate a live trip.
        const running = ride({
            status: 'in_progress',
            startedAt: at(5),
            staleDecisionPromptedAt: at(400),
            staleDecisionBy: 'passenger',
            staleDecisionChoice: 'cancel',
        });
        const e = StaleRideService.evaluate(running, CONFIG, at(500));
        expect(e.action).not.toBe('cancel');
    });
});
