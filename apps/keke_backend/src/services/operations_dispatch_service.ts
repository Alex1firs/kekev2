/**
 * Manual assignment by a named dispatcher.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────
 * Everything a dispatcher SAW is stale. The driver list they are looking at
 * was true when it was rendered; by the time they tap ASSIGN, that driver may
 * have accepted another ride, gone offline, been suspended, or crossed a debt
 * threshold. So nothing displayed is trusted here — eligibility is re-derived
 * from DriverEligibilityService at the moment of assignment, against the same
 * rules automatic dispatch uses.
 *
 * ── And then the database decides anyway ─────────────────────────────────
 * Even a driver who passes revalidation may lose: assignDriverToRide's
 * conditional `WHERE status = 'searching'` is the sole arbiter, and a driver
 * who accepted automatically a millisecond earlier owns the ride. Operations
 * is told RIDE_ALREADY_TAKEN. That is a correct outcome, not an error — and it
 * is deliberately NOT solved by locking dispatch first, because a lock that
 * could fail open would be worse than losing a race cleanly.
 */
import { AppDataSource } from '../config/data_source';
import { Ride, RideStatus } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { User } from '../models/User';
import { toLocalDialable } from '../utils/phone';
import { DriverEligibilityService } from './driver_eligibility_service';
import { RideControlService, ControlActor } from './ride_control_service';
import { OperationsAuditService } from './operations_audit_service';
import { InterventionType, InterventionReason } from '../models/OperationsIntervention';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';

export interface OperationsHost {
    assignDriver(a: {
        rideId: string;
        driverId: string;
        assignedByStaffId?: string | null;
    }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
    emitToRide(rideId: string, event: string, payload: Record<string, unknown>): void;
    emitToAdmin(event: string, payload: Record<string, unknown>): void;
    emitToOps(event: string, payload: Record<string, unknown>): void;
    abortDispatch(rideId: string, reason: 'operations_control'): void;
    /**
     * Detach the currently-assigned driver without ending the ride. The
     * conditional UPDATE inside is the arbiter, exactly as assignDriver's is.
     */
    releaseAssignedDriver(a: {
        rideId: string;
        expectedDriverId: string;
        reason: string;
        releasedByStaffId?: string | null;
    }): Promise<
        | { ok: true; driverId: string; priorStatus: string; priorEvidence: Record<string, unknown> }
        | { ok: false; code: string; message: string }
    >;
}

/**
 * Why a driver was taken off a ride. Machine-readable so "how often does a
 * manually-assigned driver fall through, and why" is a GROUP BY rather than a
 * reading exercise.
 */
export enum ReassignReason {
    DRIVER_DECLINED_MANUALLY = 'DRIVER_DECLINED_MANUALLY',
    DRIVER_UNAVAILABLE = 'DRIVER_UNAVAILABLE',
    DRIVER_CANNOT_REACH_PICKUP = 'DRIVER_CANNOT_REACH_PICKUP',
    DRIVER_VEHICLE_PROBLEM = 'DRIVER_VEHICLE_PROBLEM',
    DRIVER_REQUESTED_REASSIGNMENT = 'DRIVER_REQUESTED_REASSIGNMENT',
    OPERATIONS_CORRECTION = 'OPERATIONS_CORRECTION',
    OTHER = 'OTHER',
}

/** Ride states in which a driver may be swapped. Pre-trip only. */
export const REASSIGNABLE_STATUSES = ['accepted', 'arrived'];

export type AssignFailure =
    | 'DISABLED'
    | 'RIDE_NOT_FOUND'
    | 'RIDE_NOT_ASSIGNABLE'
    | 'NOT_CONTROLLER'
    | 'DRIVER_NOT_FOUND'
    | 'DRIVER_NOT_ELIGIBLE'
    | 'RIDE_ALREADY_TAKEN'
    | 'HOST_UNAVAILABLE';

export type AssignResult =
    | { ok: true; rideId: string; driverId: string }
    | { ok: false; code: AssignFailure; message: string; eligibilityReason?: string };

export class OperationsDispatchService {
    private static host: OperationsHost | null = null;

    static setHost(host: OperationsHost | null): void {
        this.host = host;
    }

    /** Called after a takeover commits, to stop new automatic offers. */
    static pauseAutomaticDispatch(rideId: string): void {
        try {
            this.host?.abortDispatch(rideId, 'operations_control');
        } catch (err: any) {
            // The orchestrator also checks control before each round, so a
            // failed abort delays the pause by at most one round rather than
            // defeating it.
            console.warn(`[OPS] abortDispatch failed for ${rideId}: ${err?.message}`);
        }
    }

    /**
     * Assign a driver by hand.
     *
     * Order matters and is deliberate:
     *   1. feature flag
     *   2. ride still assignable
     *   3. caller still holds a LIVE lease
     *   4. driver exists and is approved
     *   5. driver passes the SAME eligibility filter automatic dispatch uses
     *   6. the authoritative conditional UPDATE
     *
     * Steps 2–5 are courtesy: they produce a good error message. Step 6 is the
     * one that is actually safe, and it would reject a bad assignment even if
     * every check above were removed.
     */
    static async assign(
        rideId: string,
        driverId: string,
        actor: ControlActor,
        reason: InterventionReason = InterventionReason.OPERATIONS_INTERVENTION,
    ): Promise<AssignResult> {
        const config = loadOperationsDispatchConfig();
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        const control = await RideControlService.get(rideId);

        const audit = (
            type: InterventionType,
            outcome: string,
            outcomeCode: string | null,
            detail: Record<string, unknown> | null = null,
        ) =>
            OperationsAuditService.record({
                type,
                rideId,
                staffUserId: actor.staffUserId,
                staffLabel: actor.label,
                reason,
                driverId,
                priorRideStatus: ride ? String(ride.status) : null,
                priorControlMode: control?.mode ?? null,
                outcome,
                outcomeCode,
                detail,
            });

        // Recorded BEFORE the attempt: an assignment that crashes the process
        // still leaves evidence that somebody tried.
        await audit(InterventionType.ASSIGNMENT_ATTEMPTED, 'pending', null);

        const fail = async (code: AssignFailure, message: string, extra?: Record<string, unknown>) => {
            await audit(InterventionType.ASSIGNMENT_FAILED, 'refused', code, extra ?? null);
            return { ok: false as const, code, message, ...(extra ?? {}) };
        };

        if (!config.enabled || !config.interventionEnabled) {
            return fail('DISABLED', 'Operations intervention is disabled.');
        }
        if (!ride) return fail('RIDE_NOT_FOUND', 'Ride not found.');

        // Only a ride nobody owns can be assigned. A completed or cancelled
        // ride is not assignable however recently the list was rendered.
        if (String(ride.status) !== RideStatus.SEARCHING) {
            return fail(
                'RIDE_NOT_ASSIGNABLE',
                `This ride is ${ride.status} and can no longer be assigned.`,
            );
        }

        if (!RideControlService.isOperationsControlled(control)) {
            return fail('NOT_CONTROLLER', 'Take control of this ride before assigning a driver.');
        }
        if (control!.ownerStaffId !== actor.staffUserId) {
            return fail(
                'NOT_CONTROLLER',
                `${control!.ownerLabel ?? 'Another dispatcher'} is handling this ride.`,
            );
        }

        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId });
        if (!profile) return fail('DRIVER_NOT_FOUND', 'That driver no longer exists.');

        // The same filter automatic dispatch runs, with the same rules. A
        // favourite, a driver the dispatcher personally rang, and a driver the
        // system found are all judged identically — there is no bypass here
        // and deliberately no parameter that could become one.
        const eligibility = await DriverEligibilityService.filter([driverId], {
            isCash: ride.paymentMode === 'cash',
        });
        if (!eligibility.eligible.includes(driverId)) {
            const why = eligibility.rejected.find((r) => r.driverId === driverId)?.reason ?? 'not_eligible';
            return fail(
                'DRIVER_NOT_ELIGIBLE',
                this.explainIneligibility(why),
                { eligibilityReason: why },
            );
        }

        if (!this.host) return fail('HOST_UNAVAILABLE', 'Dispatch is not available right now.');

        // THE authoritative step. Everything above only shapes the error text.
        const result = await this.host.assignDriver({
            rideId,
            driverId,
            assignedByStaffId: actor.staffUserId,
        });

        if (!result.ok) {
            // Losing to a driver who accepted first is the expected race and
            // is reported as such, not as a fault.
            const code: AssignFailure =
                result.code === 'RIDE_ALREADY_TAKEN' ? 'RIDE_ALREADY_TAKEN' : 'DRIVER_NOT_ELIGIBLE';
            return fail(code, result.message, { arbiterCode: result.code });
        }

        await audit(InterventionType.DRIVER_ASSIGNED, 'ok', null, {
            assignedVia: 'operations',
        });

        // Control is released by assignDriverToRide itself, for every source.
        return { ok: true, rideId, driverId };
    }

    /**
     * Take a driver off a ride that has not started, leaving the ride alive.
     *
     * ── Why this is release-then-assign, not swap ────────────────────────
     * The obvious implementation is one UPDATE moving the ride from Driver A
     * to Driver B. It is also wrong: it would need its own WHERE clause, its
     * own race analysis, and it would become a SECOND way a ride gains a
     * driver — the precise thing this system has spent three phases avoiding.
     *
     * So reassignment is two existing operations in sequence. Release returns
     * the ride to `searching` (its own conditional UPDATE arbitrates), and
     * then Operations assigns through assignDriverToRide exactly as before.
     * There is still one assignment path, and the new code is a release rather
     * than a rival to it.
     *
     * Between the two the ride is `searching` under a live Operations lease,
     * so automatic dispatch does not start offering it around while the
     * dispatcher is choosing.
     */
    static async releaseDriver(
        rideId: string,
        actor: ControlActor,
        reason: ReassignReason = ReassignReason.OPERATIONS_CORRECTION,
    ): Promise<
        | { ok: true; releasedDriverId: string }
        | { ok: false; code: string; message: string }
    > {
        const config = loadOperationsDispatchConfig();
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        const control = await RideControlService.get(rideId);

        const audit = (type: InterventionType, outcome: string, code: string | null, detail?: any) =>
            OperationsAuditService.record({
                type,
                rideId,
                staffUserId: actor.staffUserId,
                staffLabel: actor.label,
                reason,
                driverId: ride?.driverId ?? null,
                priorRideStatus: ride ? String(ride.status) : null,
                priorControlMode: control?.mode ?? null,
                outcome,
                outcomeCode: code,
                detail: detail ?? null,
            });

        const fail = async (code: string, message: string) => {
            await audit(InterventionType.DRIVER_RELEASE_FAILED, 'refused', code);
            return { ok: false as const, code, message };
        };

        if (!config.enabled || !config.interventionEnabled) {
            return fail('DISABLED', 'Operations intervention is disabled.');
        }
        if (!ride) return fail('RIDE_NOT_FOUND', 'Ride not found.');
        if (!ride.driverId) return fail('NO_DRIVER_ASSIGNED', 'This ride has no driver to release.');

        // Control is required: releasing a driver is an intervention, and the
        // lease is what stops two operators doing it to the same ride at once.
        if (!RideControlService.isOperationsControlled(control)) {
            return fail('NOT_CONTROLLER', 'Take control of this ride before reassigning.');
        }
        if (control!.ownerStaffId !== actor.staffUserId) {
            return fail('NOT_CONTROLLER',
                `${control!.ownerLabel ?? 'Another dispatcher'} is handling this ride.`);
        }
        if (!this.host) return fail('HOST_UNAVAILABLE', 'Dispatch is not available right now.');

        const result = await this.host.releaseAssignedDriver({
            rideId,
            expectedDriverId: ride.driverId,
            reason,
            releasedByStaffId: actor.staffUserId,
        });

        if (!result.ok) return fail(result.code, result.message);

        await audit(InterventionType.DRIVER_RELEASED, 'ok', null, {
            releasedDriverId: result.driverId,
            priorStatus: result.priorStatus,
            // Driver A's arrival evidence, preserved here because the ride row
            // no longer carries it.
            priorEvidence: result.priorEvidence,
        });

        return { ok: true, releasedDriverId: result.driverId };
    }

    /**
     * Record that a dispatcher rang a driver.
     *
     * Records the CALL, never its content, and changes nothing about the ride
     * or the driver. Ringing somebody is not a commitment: the driver still
     * has to come online and pass eligibility before they can be assigned.
     */
    static async recordDriverContacted(
        rideId: string,
        driverId: string,
        actor: ControlActor,
        detail: { presence?: string; distanceKm?: number | null; lastSeenSeconds?: number | null } = {},
    ): Promise<{ dialable: string | null; name: string }> {
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        const control = await RideControlService.get(rideId);
        await OperationsAuditService.record({
            type: InterventionType.DRIVER_CONTACTED,
            rideId,
            staffUserId: actor.staffUserId,
            staffLabel: actor.label,
            reason: InterventionReason.DRIVER_CONTACTED_MANUALLY,
            driverId,
            priorRideStatus: ride ? String(ride.status) : null,
            priorControlMode: control?.mode ?? null,
            outcome: 'ok',
            detail: {
                presence: detail.presence ?? null,
                distanceKm: detail.distanceKm ?? null,
                lastSeenSeconds: detail.lastSeenSeconds ?? null,
            },
        });

        // The number is returned so the operator's phone can actually dial it.
        //
        // Revealed on demand rather than shipped with the driver list: a list
        // of forty drivers should not put forty real numbers into a browser
        // that might be left unlocked on a bench. This call is already the
        // audited moment somebody decided to ring one person.
        //
        // Normalised to the local 0XXXXXXXXXX form Nigerian handsets dial
        // reliably. The stored value is NOT modified — normalisation happens
        // on the way out only.
        const [profile, user] = await Promise.all([
            AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId }),
            AppDataSource.getRepository(User).findOne({ where: { id: driverId } }),
        ]);
        return {
            dialable: toLocalDialable(user?.phone) ?? null,
            name: [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || 'this driver',
        };
    }

    /** Operator-facing sentence for an eligibility rejection code. */
    static explainIneligibility(code: string): string {
        switch (code) {
            case 'driver_suspended_or_rejected':
                return 'This driver is suspended or not approved.';
            case 'already_on_active_ride':
                return 'This driver is already on another ride.';
            case 'cash_debt_blocked':
                return 'This driver is blocked from cash rides by commission debt.';
            case 'no_driver_profile':
                return 'This driver has no approved profile.';
            case 'explicit_rejector':
                return 'This driver already declined this ride.';
            case 'not_available':
            case 'stale_heartbeat':
                return 'This driver is not online right now.';
            default:
                return `This driver cannot take the ride (${code}).`;
        }
    }
}
