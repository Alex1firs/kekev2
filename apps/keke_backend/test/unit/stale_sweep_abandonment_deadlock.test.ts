/**
 * Mutual abandonment must be able to close a ride nobody was asked about.
 *
 * A production deadlock sat between two correct-looking rules. The policy returns
 * `cancel` with ABANDONED_BY_BOTH purely on evidence — both parties offline and
 * quiet past the threshold — and never consults `staleDecisionPromptedAt`. The
 * sweeper then asked RideCleanupService to refuse any cancel with no prompt on
 * record. For a ride that went dark before it was ever prompted, both rules held
 * and neither yielded: the sweep logged `cancel_skipped/decision_prompt_not_sent`
 * every 90 seconds indefinitely, and the passenger's active-ride slot stayed
 * leaked, locking them out of booking.
 *
 * "No silent cancellations" is about not terminating a ride the parties never saw
 * coming. It cannot coherently apply to the one resolution whose entire premise
 * is that there is nobody there to see it. So abandonment is exempt, and these
 * tests pin the exemption as narrow: every other resolution still requires that
 * someone was actually asked.
 */
import { StaleResolution, RideDelayState, StaleActionReason } from '../../src/config/stale_ride_config';
import { StaleRideSweeper } from '../../src/services/stale_ride_sweeper';
import { RideCleanupService } from '../../src/services/ride_cleanup_service';
import { DispatchMonitorService } from '../../src/services/dispatch_monitor_service';
import { RideSnapshot, StaleEvaluation } from '../../src/services/stale_ride_service';

/** A ride that went dark before anyone was ever prompted — the wedged case. */
const darkRide = (over: Partial<RideSnapshot> = {}): RideSnapshot => ({
    rideId: 'RIDE-DARK',
    status: 'accepted',
    passengerId: 'pax', driverId: 'drv',
    acceptedAt: new Date('2026-07-21T09:00:00Z'),
    arrivedAt: null, startedAt: null, completedAt: null,
    estimatedDurationSec: null,
    acceptLat: null, acceptLng: null, pickupLat: null, pickupLng: null,
    staleWarnedAt: null,
    staleExtensionCount: 0,
    staleDeadlineOverrideAt: null,
    requiresOperationsReview: false,
    // The crux: nobody was ever asked, because nobody was there to ask.
    staleDecisionPromptedAt: null,
    staleDecisionDeadlineAt: null,
    staleDecisionBy: null, staleDecisionChoice: null, staleDecisionRound: 0,
    lastActivityAt: null, lastActivityType: null, lastReminderAt: null,
    driverLive: false, passengerLive: false,
    driverOfflineForMs: null, passengerOfflineForMs: null,
    cancellationRequestedBy: null, cancellationRequestedAt: null,
    cancellationRequestState: null,
    escalatedToSupportAt: null, escalationReason: null,
    ...over,
} as RideSnapshot);

const evaluation = (resolution: StaleResolution): StaleEvaluation => ({
    action: 'cancel',
    resolution,
    reason: StaleActionReason.DRIVER_DID_NOT_ARRIVE,
    delayState: RideDelayState.ESCALATED_TO_SUPPORT,
    explanation: 'test',
    ageMinutes: 4_000,
    deadlineMinutes: 45,
} as StaleEvaluation);

const runCancel = (ride: RideSnapshot, evaluated: StaleEvaluation) =>
    (StaleRideSweeper as unknown as {
        cancel(r: RideSnapshot, e: StaleEvaluation): Promise<string>;
    }).cancel(ride, evaluated);

describe('a ride nobody was ever asked about can still be released', () => {
    let terminate: jest.SpyInstance;

    beforeEach(() => {
        // The real terminate would need a live DB; what matters here is the flag
        // the sweeper hands it, which is where the deadlock lived.
        terminate = jest.spyOn(RideCleanupService, 'terminate')
            .mockResolvedValue({ rideId: 'RIDE-DARK', applied: true } as never);
        jest.spyOn(DispatchMonitorService, 'record').mockImplementation(() => undefined as never);
    });
    afterEach(() => jest.restoreAllMocks());

    const flagFor = (resolution: StaleResolution) => {
        const call = terminate.mock.calls.at(-1)?.[0] as { requireDecisionPrompt?: boolean };
        return call?.requireDecisionPrompt;
    };

    it('does not demand a decision prompt for mutual abandonment', async () => {
        await expect(
            runCancel(darkRide(), evaluation(StaleResolution.ABANDONED_BY_BOTH)),
        ).resolves.toBe('cancelled');

        // Before the fix this was `true`, RideCleanupService refused, and the ride
        // came back on the very next pass — forever.
        expect(flagFor(StaleResolution.ABANDONED_BY_BOTH)).toBe(false);
    });

    it.each([
        StaleResolution.CANCELLED_REQUEST_UNANSWERED,
        StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_PASSENGER_INITIATED,
        StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_DRIVER_INITIATED,
    ])('still demands a decision prompt for %s', async (resolution) => {
        await runCancel(darkRide(), evaluation(resolution));

        // The exemption must not widen. Every resolution that claims a human
        // decided something has to prove someone was asked.
        expect(flagFor(resolution)).toBe(true);
    });

    it('closes the ride instead of re-skipping it every pass', async () => {
        // Stand in for the real guard at ride_cleanup_service.ts:149 rather than
        // assuming success, so this reproduces the production deadlock end to end:
        // a ride with no prompt on record is refused whenever the flag is set.
        terminate.mockImplementation(async (args: {
            requireDecisionPrompt?: boolean; rideId: string;
        }) => args.requireDecisionPrompt
            ? { rideId: args.rideId, applied: false, skippedReason: 'decision_prompt_not_sent' }
            : { rideId: args.rideId, applied: true });

        const outcome = await runCancel(
            darkRide(), evaluation(StaleResolution.ABANDONED_BY_BOTH),
        );

        // 'skipped' is precisely the symptom that filled the production logs.
        expect(outcome).toBe('cancelled');
    });

    it('tells both parties they can move on, without blaming either', async () => {
        await runCancel(darkRide(), evaluation(StaleResolution.ABANDONED_BY_BOTH));
        const args = terminate.mock.calls.at(-1)?.[0] as {
            passengerMessage: string; driverMessage: string;
        };

        for (const copy of [args.passengerMessage, args.driverMessage]) {
            expect(copy).toMatch(/book again|accept new rides/i);
            expect(copy).not.toMatch(/no.?show|failed|your fault|abandoned/i);
        }
    });
});
