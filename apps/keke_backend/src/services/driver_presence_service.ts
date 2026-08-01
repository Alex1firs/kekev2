/**
 * Driver operational presence.
 *
 * ── What this is NOT ────────────────────────────────────────────────────
 * It is not the dispatch availability heartbeat. `driver:available:<id>` in
 * Redis, with its 45-second TTL, answers "could dispatch ring this phone in the
 * next few seconds" and is read by DispatchService on the hot path. Nothing in
 * this file writes that key, reads it, or is read by dispatch. The two systems
 * are deliberately disjoint:
 *
 *   - a feature-phone driver standing in a park has NO heartbeat and is very
 *     much AT_PARK;
 *   - a driver whose app is open at home HAS a heartbeat and is ONLINE, not
 *     WAITING;
 *   - a presence bug must never be able to affect who gets rung.
 *
 * ── Independent of the ride lifecycle ───────────────────────────────────
 * A ride moving to `accepted` does not itself move a driver to ASSIGNED.
 * Something has to record that, and until a later phase wires it, presence is
 * driven by the driver app and by dispatchers. This is the point of Part C:
 * presence is an observation about a person, not a projection of a row in
 * `ride`. Keeping them separate means a stuck ride cannot corrupt what we
 * believe about where somebody is, and vice versa.
 *
 * ── The state machine ───────────────────────────────────────────────────
 * Transitions are constrained, but only against the genuinely impossible. The
 * rule that earns its place is that a driver cannot jump from OFFLINE straight
 * into a ride-shaped state: if we believe someone is at home and the next thing
 * we hear is "carrying a passenger", one of those two facts is wrong and the
 * system should say so rather than quietly accept it.
 *
 * Everything else is permitted, because the real world is not tidy — a driver
 * abandons a pickup, walks back to the queue, goes for fuel mid-shift. An
 * administrator can override any transition with `force`, which is recorded as
 * an override rather than silently allowed.
 */
import { AppDataSource } from '../config/data_source';
import {
    DriverPresence,
    DriverPresenceState,
    PresenceSource,
} from '../models/DriverPresence';
import { DriverProfile } from '../models/DriverProfile';
import { DriverPresenceRepository } from '../repositories/driver_presence_repository';
import { ParkRepository, AT_PARK_STATES, ON_RIDE_STATES } from '../repositories/park_repository';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

export const PresenceAuditAction = {
    PRESENCE_CHANGED: 'PRESENCE_CHANGED',
    PRESENCE_FORCED: 'PRESENCE_FORCED',
} as const;

const S = DriverPresenceState;

/**
 * Legal transitions. A state may always be re-entered (a no-op, which produces
 * no event), so identity is not listed.
 */
const ALLOWED: Record<DriverPresenceState, DriverPresenceState[]> = {
    [S.OFFLINE]: [S.ONLINE, S.AT_PARK, S.UNAVAILABLE],
    [S.ONLINE]: [S.OFFLINE, S.AT_PARK, S.WAITING, S.ASSIGNED, S.UNAVAILABLE],
    [S.AT_PARK]: [S.WAITING, S.ONLINE, S.OFFLINE, S.UNAVAILABLE, S.ASSIGNED],
    [S.WAITING]: [S.ASSIGNED, S.AT_PARK, S.ONLINE, S.OFFLINE, S.UNAVAILABLE],
    // A ride can fall through at any point: the passenger cancels, the driver
    // gives up, the dispatcher reassigns. Every ride state can therefore return
    // to a resting state.
    [S.ASSIGNED]: [S.EN_ROUTE, S.WAITING, S.AT_PARK, S.ONLINE, S.OFFLINE, S.UNAVAILABLE],
    [S.EN_ROUTE]: [S.PASSENGER_BOARDING, S.ASSIGNED, S.WAITING, S.AT_PARK, S.ONLINE, S.OFFLINE],
    [S.PASSENGER_BOARDING]: [S.TRIP_STARTED, S.EN_ROUTE, S.WAITING, S.AT_PARK, S.ONLINE, S.OFFLINE],
    [S.TRIP_STARTED]: [S.ONLINE, S.AT_PARK, S.WAITING, S.OFFLINE, S.UNAVAILABLE],
    [S.UNAVAILABLE]: [S.ONLINE, S.AT_PARK, S.WAITING, S.OFFLINE],
};

/** States that only make sense at a park, so a parkId is mandatory. */
const PARK_REQUIRED: DriverPresenceState[] = [S.AT_PARK, S.WAITING];

/** States that clear any park association. */
const PARK_CLEARING: DriverPresenceState[] = [S.OFFLINE, S.ONLINE];

export interface PresenceChangeInput {
    driverId: string;
    state: DriverPresenceState;
    parkId?: string | null;
    rideId?: string | null;
    note?: string | null;
    source: PresenceSource;
    setByStaffId?: string | null;
    /** Bypass the transition check. Recorded as an override. Requires a reason. */
    force?: boolean;
    reason?: string | null;
}

export interface PresenceDto {
    driverId: string;
    state: DriverPresenceState;
    parkId: string | null;
    since: Date;
    secondsInState: number;
    source: PresenceSource;
    rideId: string | null;
    note: string | null;
    previousState: DriverPresenceState | null;
    lastHeartbeatAt: Date | null;
    /** True when this driver is at a park in a working state. */
    atPark: boolean;
    /** True when this driver is on a ride. */
    onRide: boolean;
}

export class DriverPresenceService {
    static toDto(p: DriverPresence): PresenceDto {
        const since = p.since instanceof Date ? p.since : new Date(p.since);
        return {
            driverId: p.driverId,
            state: p.state,
            parkId: p.parkId,
            since,
            secondsInState: Math.max(0, Math.round((Date.now() - since.getTime()) / 1000)),
            source: p.source,
            rideId: p.rideId,
            note: p.note,
            previousState: p.previousState,
            lastHeartbeatAt: p.lastHeartbeatAt,
            atPark: AT_PARK_STATES.includes(p.state),
            onRide: ON_RIDE_STATES.includes(p.state),
        };
    }

    /** Current presence, creating an OFFLINE baseline the first time we ask. */
    static async get(driverId: string): Promise<PresenceDto> {
        const existing = await DriverPresenceRepository.find(driverId);
        if (existing) return this.toDto(existing);
        return this.toDto(await this.ensureRow(driverId));
    }

    static async getMany(driverIds: string[]): Promise<Map<string, PresenceDto>> {
        const rows = await DriverPresenceRepository.findMany(driverIds);
        return new Map([...rows.entries()].map(([id, p]) => [id, this.toDto(p)]));
    }

    /**
     * Whether a transition is legal. Exposed so the UI can grey out buttons
     * rather than offering an action the server will refuse.
     */
    static canTransition(from: DriverPresenceState, to: DriverPresenceState): boolean {
        if (from === to) return true;
        return (ALLOWED[from] ?? []).includes(to);
    }

    static allowedNextStates(from: DriverPresenceState): DriverPresenceState[] {
        return ALLOWED[from] ?? [];
    }

    /**
     * Record a presence change.
     *
     * Returns the new state plus whether anything actually changed — a repeated
     * report of the same state is a successful no-op, not an error, because
     * apps retry and dispatchers double-tap.
     */
    static async setState(
        input: PresenceChangeInput,
        ctx: { actor?: AuditActor; ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<{ presence: PresenceDto; changed: boolean }> {
        const driverId = String(input.driverId ?? '').trim();
        if (!driverId) throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A driver id is required.');
        if (!Object.values(DriverPresenceState).includes(input.state)) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown presence state: ${input.state}`);
        }

        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId });
        if (!profile) throw new AppError(404, ErrorCode.PROFILE_NOT_FOUND, 'Driver not found.');

        const current = (await DriverPresenceRepository.findFresh(driverId)) ?? (await this.ensureRow(driverId));
        const from = current.state;
        const to = input.state;

        // Park association, resolved before the legality check so an invalid
        // park is reported as such rather than as an illegal transition.
        let parkId: string | null = input.parkId ?? current.parkId;
        if (PARK_CLEARING.includes(to)) parkId = null;
        if (PARK_REQUIRED.includes(to)) {
            if (!parkId) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                    `${to} requires a park — a driver cannot be waiting at no park.`);
            }
            await ParkRepository.findById(parkId).then((park) => {
                if (!park) throw new AppError(404, ErrorCode.NOT_FOUND, 'Park not found.');
            });
        }

        const legal = this.canTransition(from, to);
        if (!legal && !input.force) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `A driver cannot go from ${from} to ${to}. Allowed: ${this.allowedNextStates(from).join(', ') || 'none'}.`);
        }
        if (!legal && input.force && !input.reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'Overriding a presence transition requires a reason.');
        }

        // A genuine no-op: refresh the heartbeat, leave `since` alone so dwell
        // time keeps counting from when the state was actually entered, and
        // write no event.
        if (from === to && parkId === current.parkId) {
            current.lastHeartbeatAt = new Date();
            await DriverPresenceRepository.save(current);
            return { presence: this.toDto(current), changed: false };
        }

        const now = new Date();
        const previousSince = current.since instanceof Date ? current.since : new Date(current.since);
        const durationSec = Math.max(0, Math.round((now.getTime() - previousSince.getTime()) / 1000));

        current.previousState = from;
        current.state = to;
        current.parkId = parkId;
        current.since = now;
        current.source = input.source;
        current.setByStaffId = input.setByStaffId ?? null;
        current.rideId = ON_RIDE_STATES.includes(to) ? (input.rideId ?? current.rideId ?? null) : null;
        current.note = to === S.UNAVAILABLE ? (input.note?.slice(0, 200) ?? null) : (input.note?.slice(0, 200) ?? null);
        current.lastHeartbeatAt = input.source === PresenceSource.DRIVER_APP ? now : current.lastHeartbeatAt;

        await DriverPresenceRepository.save(current);
        await DriverPresenceRepository.recordEvent({
            driverId,
            fromState: from,
            toState: to,
            parkId,
            source: input.source,
            setByStaffId: input.setByStaffId ?? null,
            rideId: current.rideId,
            note: current.note,
            previousStateDurationSec: durationSec,
            occurredAt: now,
        });

        // Audited only when a HUMAN caused it. A driver app reporting its own
        // state hundreds of times a day is operational telemetry and belongs in
        // the presence event log, not in the staff audit trail — burying real
        // staff actions under app noise makes the audit log useless.
        if (ctx.actor && (input.source === PresenceSource.DISPATCHER || input.source === PresenceSource.ADMIN)) {
            await AuditService.record({
                actor: ctx.actor,
                action: legal ? PresenceAuditAction.PRESENCE_CHANGED : PresenceAuditAction.PRESENCE_FORCED,
                resourceType: 'DRIVER_PRESENCE',
                resourceId: driverId,
                driverId,
                parkId,
                rideId: current.rideId,
                reason: input.reason?.trim() || null,
                metadata: { from, to, forced: !legal, source: input.source, durationSec },
                ipAddress: ctx.ipAddress ?? null,
                correlationId: ctx.correlationId ?? null,
            });
        }

        return { presence: this.toDto(current), changed: true };
    }

    /**
     * A driver app reporting in without changing state.
     *
     * Only refreshes `lastHeartbeatAt`. It never promotes OFFLINE to ONLINE:
     * an app that is merely running is not a person who has started work, and
     * inferring otherwise is how a driver at home ends up in a park queue.
     */
    static async heartbeat(driverId: string): Promise<PresenceDto> {
        const row = (await DriverPresenceRepository.findFresh(driverId)) ?? (await this.ensureRow(driverId));
        row.lastHeartbeatAt = new Date();
        await DriverPresenceRepository.save(row);
        return this.toDto(row);
    }

    /** Everyone at a park, longest-waiting first. The dispatcher board's read. */
    static async atPark(parkId: string, states?: DriverPresenceState[]): Promise<PresenceDto[]> {
        const rows = await DriverPresenceRepository.findAtPark(parkId, states ?? AT_PARK_STATES);
        return rows.map((r) => this.toDto(r));
    }

    static async history(driverId: string, limit = 50) {
        return DriverPresenceRepository.history(driverId, limit);
    }

    /**
     * Drivers who have been in one state suspiciously long.
     *
     * Reported, never auto-corrected. A driver WAITING for four hours might
     * have gone home without telling anyone — or might genuinely have been
     * waiting four hours on a slow day, which is exactly the operational fact a
     * supervisor needs to see rather than have quietly erased.
     */
    static async stale(parkId: string, thresholdMinutes = 180): Promise<PresenceDto[]> {
        const cutoffSec = thresholdMinutes * 60;
        const dwell = await DriverPresenceRepository.dwellTimes(parkId);
        const stuck = dwell.filter((d) => d.seconds >= cutoffSec).map((d) => d.driverId);
        if (stuck.length === 0) return [];
        const rows = await DriverPresenceRepository.findMany(stuck);
        return [...rows.values()].map((r) => this.toDto(r));
    }

    /** Create the OFFLINE baseline row for a driver we have never seen. */
    private static async ensureRow(driverId: string): Promise<DriverPresence> {
        const existing = await DriverPresenceRepository.findFresh(driverId);
        if (existing) return existing;
        try {
            return await DriverPresenceRepository.save(DriverPresenceRepository.create({
                driverId,
                state: DriverPresenceState.OFFLINE,
                since: new Date(),
                source: PresenceSource.SYSTEM,
            }));
        } catch {
            // Lost a race with a concurrent creator — theirs is as good as ours.
            const row = await DriverPresenceRepository.findFresh(driverId);
            if (!row) throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Could not initialise driver presence.');
            return row;
        }
    }
}
