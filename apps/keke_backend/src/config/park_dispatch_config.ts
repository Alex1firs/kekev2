/**
 * Park Dispatch fallback tuning.
 *
 * DEFAULT ON as of the Monday launch. `PARK_DISPATCH_ENABLED` defaults to true;
 * setting it to false restores the pre-Park behaviour exactly —
 * `finalizeUnsuccessfulDispatch` takes the path it took before any of this
 * existed and a failed search simply fails.
 *
 * Two ways to switch it off, because they cost different things:
 *   - this variable, which needs a container restart (~10s of 502s on this
 *     stack) but survives everything, including Redis being wiped;
 *   - ParkDispatchSwitch, a Redis override that takes effect on the next
 *     request with no restart at all. See services/park_dispatch_switch.ts.
 * The override can only disable, never enable.
 *
 * Every window here sits DOWNSTREAM of direct dispatch. Nothing in this file can
 * shorten, lengthen or otherwise influence a DispatchRun: by the time any of it
 * is read, the run has already finished and its outcome is known.
 *
 * The timings follow docs/park_dispatch_mode_architecture.md §5.3, which fixed a
 * 180-second total ceiling against the passenger app's 150-second client-side
 * watchdog. See PARK_ROUND_EVENT below for how that is kept honest on builds
 * already in the field.
 */

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.warn(`[park-dispatch-config] ${name}="${raw}" is not a valid number — using ${fallback}`);
        return fallback;
    }
    return parsed;
}

/**
 * Accepts the spellings people actually type into a compose file.
 *
 * This matters more now that PARK_DISPATCH_ENABLED defaults to true: under a
 * strict `=== 'true'` test, an operator writing `PARK_DISPATCH_ENABLED=1` to
 * turn it ON would have silently turned it OFF. An unrecognised value keeps the
 * default and says so, rather than guessing.
 */
function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    console.warn(`[park-dispatch-config] ${name}="${raw}" is not a boolean — using ${fallback}`);
    return fallback;
}

export interface ParkDispatchConfig {
    /**
     * Master switch. False means the fallback is never consulted at all.
     *
     * This is only the ENVIRONMENT half of the answer — callers that decide
     * whether a ride may enter the park phase must also consult
     * ParkDispatchSwitch, which can disable without a restart.
     */
    enabled: boolean;

    /**
     * How long a park has to CLAIM an offered request before it lapses.
     *
     * Short, because the dispatcher is answering a question they can see on a
     * screen in front of them, not making a cold decision.
     */
    claimWindowMs: number;

    /**
     * How long a claimed request has before the dispatcher must have assigned a
     * driver. Long enough to walk to a driver and confirm they will take it.
     */
    assignWindowMs: number;

    /**
     * How many parks a single ride may be offered to, in sequence.
     *
     * Two would push the worst case past the passenger's tolerance. One park,
     * for the pilot.
     */
    maxParksPerRide: number;

    /**
     * Estimated travel speed used to rank parks, metres per minute.
     *
     * Mirrors KEKE_METRES_PER_MINUTE in stale_ride_config.ts and defaults to the
     * same 230. There is no server-side routing API; a straight-line estimate is
     * what we have, and it is used only to ORDER candidate parks, never to
     * promise a passenger an arrival time.
     */
    metresPerMinute: number;

    /**
     * Parks whose estimated drive to the pickup exceeds this are not offered the
     * ride at all, even if the pickup is inside their service radius.
     */
    maxTravelMinutes: number;

    /** A park with no driver in an assignable state is skipped rather than offered. */
    requireWaitingDriver: boolean;

    /**
     * How long a SMARTPHONE driver has to accept a park assignment.
     *
     * Matches the direct-dispatch offer window (15s) because it is the same
     * card, the same countdown and the same muscle memory — a driver should not
     * have to learn that park offers behave differently.
     *
     * Feature-phone assignments do not use this: the dispatcher heard the driver
     * agree before pressing Assign.
     */
    driverAcceptWindowMs: number;

    /**
     * Emit a `ride:dispatch_round` event when the park phase opens.
     *
     * The passenger app has a 150-second client-side watchdog that re-arms on
     * every round transition, and renders "Still searching nearby…" for any
     * round >= 2 without printing the number. Emitting a round event as the park
     * phase begins therefore keeps builds ALREADY IN THE FIELD from declaring a
     * timeout while the server is still working — with copy that is true.
     * See docs/park_dispatch_mode_architecture.md §5.4.
     */
    emitRoundEvent: boolean;
}

export function loadParkDispatchConfig(): ParkDispatchConfig {
    return {
        enabled: bool('PARK_DISPATCH_ENABLED', true),
        claimWindowMs: num('PARK_CLAIM_WINDOW_MS', 25_000),
        assignWindowMs: num('PARK_ASSIGN_WINDOW_MS', 45_000),
        maxParksPerRide: Math.max(1, Math.floor(num('PARK_MAX_PARKS_PER_RIDE', 1))),
        metresPerMinute: num('KEKE_METRES_PER_MINUTE', 230),
        maxTravelMinutes: num('PARK_MAX_TRAVEL_MINUTES', 12),
        requireWaitingDriver: bool('PARK_REQUIRE_WAITING_DRIVER', true),
        driverAcceptWindowMs: num('PARK_DRIVER_ACCEPT_WINDOW_MS', 18_000),
        emitRoundEvent: bool('PARK_EMIT_ROUND_EVENT', true),
    };
}

/**
 * Priority of a queued request, so a dispatcher looking at several knows which
 * to answer first.
 *
 * Driven by how long the PASSENGER has been waiting, not by fare. Ranking by
 * fare would quietly teach dispatchers to serve expensive trips first, which is
 * exactly the bias the queue-fairness work exists to prevent.
 */
export function computeJobPriority(passengerWaitingMs: number): number {
    const minutes = passengerWaitingMs / 60_000;
    if (minutes >= 5) return 3;   // urgent — well past a reasonable wait
    if (minutes >= 3) return 2;   // elevated
    return 1;                     // normal
}

export const PRIORITY_LABEL: Record<number, string> = {
    1: 'normal',
    2: 'elevated',
    3: 'urgent',
};
