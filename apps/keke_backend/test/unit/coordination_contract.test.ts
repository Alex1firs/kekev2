/**
 * The app-facing coordination contract.
 *
 * These are the guarantees the two mobile apps are built on. If one breaks, an
 * app either shows an engineering code to someone standing in the rain, asks the
 * same question twice, or offers a button the server will refuse.
 */
import {
    CoordinationStage,
    stageOf,
    coordinationEventId,
    coordinationSnapshot,
    coordinationCopy,
    cancellationCopy,
} from '../../src/services/ride_coordination_contract';
import { loadStaleRideConfig, RideDelayState } from '../../src/config/stale_ride_config';
import { Ride } from '../../src/models/Ride';

const config = loadStaleRideConfig();
const T0 = new Date('2026-07-26T09:00:00Z');

/** A minimal accepted ride with nothing wrong with it. */
function ride(overrides: Partial<Ride> = {}): Ride {
    return {
        rideId: 'RIDE-1',
        passengerId: 'p1',
        driverId: 'd1',
        status: 'accepted',
        acceptedAt: T0,
        arrivedAt: null,
        startedAt: null,
        completedAt: null,
        delayState: null,
        staleReason: null,
        staleWarnedAt: null,
        staleExtensionCount: 0,
        staleDecisionPromptedAt: null,
        staleDecisionDeadlineAt: null,
        staleDecisionBy: null,
        staleDecisionChoice: null,
        staleDecisionRound: 0,
        cancellationRequestedBy: null,
        cancellationRequestedAt: null,
        cancellationRequestState: null,
        escalatedToSupportAt: null,
        ...overrides,
    } as unknown as Ride;
}

describe('stage precedence', () => {
    it('an ordinary ride has nothing to coordinate', () => {
        expect(stageOf(ride())).toBe(CoordinationStage.NONE);
        expect(coordinationSnapshot(ride(), config, T0).stage).toBe(CoordinationStage.NONE);
    });

    it('a warned ride is running late', () => {
        expect(stageOf(ride({ staleWarnedAt: T0 }))).toBe(CoordinationStage.RUNNING_LATE);
    });

    it('an open unanswered prompt outranks a general delay', () => {
        const r = ride({ staleWarnedAt: T0, staleDecisionPromptedAt: T0 });
        expect(stageOf(r)).toBe(CoordinationStage.AWAITING_DECISION);
    });

    it('an answered prompt becomes a confirmed status, not a question', () => {
        const r = ride({ staleDecisionPromptedAt: T0, staleDecisionChoice: 'wait' });
        expect(stageOf(r)).toBe(CoordinationStage.CONFIRMED_EN_ROUTE);
        expect(coordinationSnapshot(r, config, T0).decisionOpen).toBe(false);
    });

    it('a pending cancellation request outranks the delay it came from', () => {
        const r = ride({
            staleWarnedAt: T0,
            staleDecisionPromptedAt: T0,
            cancellationRequestState: 'pending',
            cancellationRequestedBy: 'passenger',
        });
        // It is the question actually in front of the person.
        expect(stageOf(r)).toBe(CoordinationStage.CANCELLATION_REQUESTED);
    });

    it('escalation outranks everything', () => {
        const r = ride({
            staleWarnedAt: T0,
            staleDecisionPromptedAt: T0,
            cancellationRequestState: 'pending',
            cancellationRequestedBy: 'driver',
            escalatedToSupportAt: T0,
        });
        // Once a human owns the ride, the apps must stop showing countdowns that
        // will never fire.
        expect(stageOf(r)).toBe(CoordinationStage.ESCALATED);
        expect(coordinationSnapshot(r, config, T0).escalatedToSupport).toBe(true);
    });

    it('an arrived ride that was warned is waiting on the passenger', () => {
        const r = ride({ status: 'arrived' as any, arrivedAt: T0, staleWarnedAt: T0 });
        expect(stageOf(r)).toBe(CoordinationStage.WAITING_FOR_PASSENGER);
        expect(coordinationSnapshot(r, config, T0).waitingFor).toBe('passenger');
    });
});

describe('idempotency identifiers', () => {
    it('the same coordination moment always produces the same id', () => {
        // The whole point: a socket event and the push notification that follows
        // it must collapse to one prompt in the app.
        const a = coordinationEventId('RIDE-1', 'decision', 1);
        const b = coordinationEventId('RIDE-1', 'decision', 1);
        expect(a).toBe(b);
    });

    it('a new round produces a new id', () => {
        expect(coordinationEventId('RIDE-1', 'decision', 1))
            .not.toBe(coordinationEventId('RIDE-1', 'decision', 2));
    });

    it('different rides never collide', () => {
        expect(coordinationEventId('RIDE-1', 'decision', 1))
            .not.toBe(coordinationEventId('RIDE-2', 'decision', 1));
    });

    it('a snapshot of the same row twice yields the same id', () => {
        const r = ride({ staleDecisionPromptedAt: T0, staleDecisionRound: 2 });
        expect(coordinationSnapshot(r, config, T0).eventId)
            .toBe(coordinationSnapshot(r, config, new Date(T0.getTime() + 60_000)).eventId);
    });
});

describe('deadlines are absolute', () => {
    it('an open decision reports the server deadline, not a duration', () => {
        const deadline = new Date(T0.getTime() + 3 * 60_000);
        const snap = coordinationSnapshot(
            ride({ staleDecisionPromptedAt: T0, staleDecisionDeadlineAt: deadline }),
            config, T0,
        );
        expect(snap.respondByAt).toBe(deadline.toISOString());
        expect(snap.respondBySeconds).toBe(180);
    });

    it('remaining seconds shrink with real time and never go negative', () => {
        const deadline = new Date(T0.getTime() + 60_000);
        const r = ride({ staleDecisionPromptedAt: T0, staleDecisionDeadlineAt: deadline });
        expect(coordinationSnapshot(r, config, new Date(T0.getTime() + 30_000)).respondBySeconds).toBe(30);
        // An app that slept through the window sees zero, not a negative count.
        expect(coordinationSnapshot(r, config, new Date(T0.getTime() + 600_000)).respondBySeconds).toBe(0);
    });

    it('a pending cancellation request carries its own window', () => {
        const requestedAt = new Date(T0.getTime() + 10_000);
        const snap = coordinationSnapshot(
            ride({
                cancellationRequestState: 'pending',
                cancellationRequestedBy: 'driver',
                cancellationRequestedAt: requestedAt,
            }),
            config, T0,
        );
        // Derived from when the request was made, so a restart mid-window resumes
        // where it actually is.
        expect(snap.respondByAt).toBe(
            new Date(requestedAt.getTime() + config.decisionWindowMinutes * 60_000).toISOString(),
        );
    });

    it('a ride with no open question has no deadline at all', () => {
        expect(coordinationSnapshot(ride({ staleWarnedAt: T0 }), config, T0).respondByAt).toBeNull();
    });
});

describe('extensions the server would refuse are not advertised', () => {
    it('reports what is left', () => {
        expect(coordinationSnapshot(ride({ staleWarnedAt: T0 }), config, T0).extensionsRemaining)
            .toBe(config.maxExtensions);
        expect(coordinationSnapshot(
            ride({ staleWarnedAt: T0, staleExtensionCount: config.maxExtensions }), config, T0,
        ).extensionsRemaining).toBe(0);
    });

    it('never goes negative even if the counter overshoots', () => {
        expect(coordinationSnapshot(
            ride({ staleWarnedAt: T0, staleExtensionCount: config.maxExtensions + 5 }), config, T0,
        ).extensionsRemaining).toBe(0);
    });

    it('drops "keep waiting" from the passenger copy once exhausted', () => {
        const exhausted = coordinationSnapshot(
            ride({ staleWarnedAt: T0, staleExtensionCount: config.maxExtensions }), config, T0,
        );
        const copy = coordinationCopy(exhausted, 'passenger')!;
        // Offering a button the backend refuses is worse than not offering it.
        expect(copy.actions).not.toContain('keep_waiting');
        expect(copy.actions).toContain('request_cancel');
    });
});

describe('copy is human on both sides', () => {
    const late = () => coordinationSnapshot(ride({ staleWarnedAt: T0 }), config, T0);

    it('uses the exact product copy for a delayed driver', () => {
        expect(coordinationCopy(late(), 'driver')!.title)
            .toBe('Are you still heading to the passenger?');
        expect(coordinationCopy(late(), 'driver')!.body)
            .toBe('The passenger is waiting. Let us know if you are still on your way.');
        expect(coordinationCopy(late(), 'passenger')!.title)
            .toBe('Your driver is taking longer than expected');
    });

    it('offers the driver a safe primary action and navigation', () => {
        const actions = coordinationCopy(late(), 'driver')!.actions;
        expect(actions[0]).toBe('still_coming');
        expect(actions).toContain('open_navigation');
        // Cancel is available but last.
        expect(actions[actions.length - 1]).toBe('request_cancel');
    });

    it('never leaks an engineering code into anything displayed', () => {
        const snap = coordinationSnapshot(
            ride({ staleWarnedAt: T0, staleReason: 'driver_never_arrived', delayState: RideDelayState.WAITING_FOR_DRIVER }),
            config, T0,
        );
        for (const role of ['passenger', 'driver'] as const) {
            const copy = coordinationCopy(snap, role)!;
            for (const banned of ['driver_never_arrived', 'waiting_for_driver', 'stale', 'SYSTEM_', '_']) {
                expect(copy.title).not.toContain(banned);
            }
            expect(copy.body).not.toContain('driver_never_arrived');
            expect(copy.body).not.toContain('stale');
        }
        // The code still travels, for analytics and support — just never as copy.
        expect(snap.reasonCode).toBe('driver_never_arrived');
    });

    it('never tells either side the other is at fault', () => {
        for (const status of ['accepted', 'arrived'] as const) {
            const snap = coordinationSnapshot(
                ride({ status: status as any, staleWarnedAt: T0, arrivedAt: status === 'arrived' ? T0 : null }),
                config, T0,
            );
            for (const role of ['passenger', 'driver'] as const) {
                const copy = coordinationCopy(snap, role)!;
                const text = `${copy.title} ${copy.body}`.toLowerCase();
                for (const blame of ['no-show', 'no show', 'failed to', 'fault', 'did not bother']) {
                    expect(text).not.toContain(blame);
                }
            }
        }
    });

    it('shows the requester a pending state and the other party a question', () => {
        const snap = coordinationSnapshot(
            ride({
                cancellationRequestState: 'pending',
                cancellationRequestedBy: 'passenger',
                cancellationRequestedAt: T0,
            }),
            config, T0,
        );
        // The passenger asked, so they wait.
        const mine = coordinationCopy(snap, 'passenger')!;
        expect(mine.actions).not.toContain('accept_cancellation');
        expect(mine.title).toContain('Waiting for a response');
        // The driver answers.
        const theirs = coordinationCopy(snap, 'driver')!;
        expect(theirs.title).toBe('Passenger requested to cancel this ride');
        expect(theirs.actions).toContain('accept_cancellation');
        expect(theirs.actions).toContain('continue_ride');
    });

    it('offers the escalated passenger a way forward and the driver support', () => {
        const snap = coordinationSnapshot(ride({ escalatedToSupportAt: T0 }), config, T0);
        expect(coordinationCopy(snap, 'passenger')!.actions).toContain('find_another_driver');
        expect(coordinationCopy(snap, 'driver')!.actions).toContain('contact_support');
        // Both are told it is a support matter, in the same words.
        expect(coordinationCopy(snap, 'passenger')!.title).toBe('This ride needs support assistance');
        expect(coordinationCopy(snap, 'driver')!.title).toBe('This ride needs support assistance');
    });

    it('omits the call action when there is no number to dial', () => {
        const copy = coordinationCopy(late(), 'passenger', { canCall: false })!;
        expect(copy.actions).not.toContain('call_other_party');
    });

    it('returns nothing when there is nothing to say', () => {
        expect(coordinationCopy(coordinationSnapshot(ride(), config, T0), 'passenger')).toBeNull();
    });
});

describe('cancellation copy', () => {
    it('explains a both-unresponsive close without blaming either side', () => {
        const p = cancellationCopy('SYSTEM_ABANDONED_BY_BOTH', 'passenger');
        expect(p.outcome).toBe('closed_no_response');
        expect(p.body).toBe("This ride was closed because we couldn't reach either you or the driver.");

        const d = cancellationCopy('SYSTEM_ABANDONED_BY_BOTH', 'driver');
        expect(d.body).toBe('This ride was closed after neither party responded.');
        for (const blame of ['your fault', 'you failed', 'no-show']) {
            expect(`${p.body} ${d.body}`).not.toContain(blame);
        }
    });

    it('distinguishes who cancelled, so nobody is told they did when they did not', () => {
        expect(cancellationCopy('CANCELLED_MUTUAL_DRIVER_INITIATED', 'passenger').outcome)
            .toBe('cancelled_by_driver');
        expect(cancellationCopy('CANCELLED_MUTUAL_PASSENGER_INITIATED', 'passenger').outcome)
            .toBe('cancelled_by_passenger');
        // And the passenger's copy for a driver-initiated cancel does not say
        // "you cancelled".
        expect(cancellationCopy('CANCELLED_MUTUAL_DRIVER_INITIATED', 'passenger').body)
            .not.toContain('you cancelled');
    });

    it('names an unanswered request honestly', () => {
        const c = cancellationCopy('CANCELLED_REQUEST_UNANSWERED', 'passenger');
        expect(c.outcome).toBe('cancelled_request_unanswered');
        expect(c.body).toContain('no answer');
    });

    it('falls back to plain copy for an unknown reason rather than showing the code', () => {
        const c = cancellationCopy('SOME_FUTURE_REASON_CODE', 'passenger');
        expect(c.body).not.toContain('SOME_FUTURE_REASON_CODE');
        expect(c.body).not.toContain('_');
        expect(c.outcome).toBe('cancelled');
    });

    it('handles a null reason', () => {
        expect(cancellationCopy(null, 'driver').body).not.toContain('null');
    });
});

describe('an in-progress trip is never in this conversation', () => {
    it('a started ride reports no waiting party', () => {
        const r = ride({ status: 'in_progress' as any, startedAt: T0, staleWarnedAt: T0 });
        // The backend only ever FLAGS these for a human — it never cancels one —
        // so there is no side the ride is "waiting on".
        expect(coordinationSnapshot(r, config, T0).waitingFor).toBeNull();
    });
});
