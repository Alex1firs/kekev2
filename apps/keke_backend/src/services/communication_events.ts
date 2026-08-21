/**
 * The one-way door between the ride lifecycle and communications.
 *
 * ── Why this exists at all ──────────────────────────────────────────────
 * Ride code must be able to say "this ride completed" without knowing that
 * anybody is listening, and without being able to fail because a listener did.
 * Calling a communications service directly from `socket_handler` would couple
 * ride completion to Resend being reachable.
 *
 * ── The failure this is built against ───────────────────────────────────
 * A dispatch-path recorder in this codebase once did `void this.recordAsync()`
 * with a lookup outside its `try`. Under current Node an unhandled rejection
 * terminates the process — a telemetry write could have killed the process
 * mid-dispatch. That is the exact shape of bug this module has to make
 * impossible, so:
 *
 *   - `publish` is synchronous and returns void. There is nothing to await and
 *     therefore nothing a caller can forget to await.
 *   - Every handler runs inside its own try/catch INSIDE the async boundary,
 *     so a throw becomes a log line, never a rejected promise.
 *   - The dispatch to handlers is deferred with setImmediate, so it cannot run
 *     inside the caller's transaction or extend their critical section.
 *
 * A communications fault can lose a thank-you email. It cannot fail a ride,
 * an assignment, a payment, a dispatch or a wallet posting.
 */

export interface RideCommunicationEvent {
    /** 'ride.completed' | 'ride.not_fulfilled' */
    type: string;
    rideId: string;
    passengerId: string;
    /** Authoritative outcome code. Never guessed from status. */
    outcomeReason: string | null;
    pickupArea?: string | null;
    destinationArea?: string | null;
    occurredAt: string;
}

type Handler = (event: RideCommunicationEvent) => Promise<void> | void;

const handlers: Handler[] = [];

/** Register a listener. Called once at boot. */
export function onCommunicationEvent(handler: Handler): void {
    handlers.push(handler);
}

/** Test seam. Never called in production. */
export function resetCommunicationHandlers(): void {
    handlers.length = 0;
}

/**
 * Announce that something happened to a ride.
 *
 * Returns void, synchronously, always. Safe to call from inside a transaction:
 * the handlers do not run until the current call stack unwinds.
 */
export function publishCommunicationEvent(event: RideCommunicationEvent): void {
    if (handlers.length === 0) return;

    setImmediate(() => {
        for (const handler of handlers) {
            // Each handler is isolated: one throwing must not stop the others,
            // and must not become an unhandled rejection.
            void (async () => {
                try {
                    await handler(event);
                } catch (err: any) {
                    console.error(JSON.stringify({
                        level: 'error',
                        scope: 'comms_event',
                        event: event.type,
                        rideId: event.rideId,
                        message: err?.message ?? String(err),
                    }));
                }
            })();
        }
    });
}
