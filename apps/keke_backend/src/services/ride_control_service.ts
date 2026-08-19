/**
 * Who controls dispatch for a ride, and the atomic transitions between them.
 *
 * ── The one rule ─────────────────────────────────────────────────────────
 * Every transition here is a CONDITIONAL UPDATE whose WHERE clause names the
 * exact state the caller believed it was acting on. If the row moved
 * underneath them, `affected` is 0 and the caller is told they lost. There is
 * no read-then-write anywhere in this file, because two dispatchers pressing
 * TAKE OVER at the same instant is not a rare case — it is the normal case on
 * a busy morning, and a read-then-write would give both of them control.
 *
 * ── What control is NOT ──────────────────────────────────────────────────
 * Holding control does not assign anybody, does not change the ride's status,
 * and cannot beat an assignment that already committed. assignDriverToRide
 * remains the sole arbiter of who owns a ride. Control only decides whether
 * the SYSTEM keeps making new offers.
 *
 * ── Leases, not sockets ──────────────────────────────────────────────────
 * A disconnect never releases control. See RideDispatchControl for why.
 */
import { AppDataSource } from '../config/data_source';
import {
    RideDispatchControl,
    DispatchControlMode,
    ControlReleaseReason,
} from '../models/RideDispatchControl';
import { Ride, RideStatus } from '../models/Ride';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';
import { OperationsAuditService } from './operations_audit_service';
import { InterventionType } from '../models/OperationsIntervention';
import { OperationsDispatchService } from './operations_dispatch_service';

/** Ride states in which taking control is meaningful. */
export const CONTROLLABLE_STATUSES: string[] = [
    RideStatus.SEARCHING,
    RideStatus.ACCEPTED,
    RideStatus.ARRIVED,
];

export interface ControlActor {
    staffUserId: string;
    label: string;
}

export type TakeoverResult =
    | { ok: true; control: RideDispatchControl; idempotent: boolean }
    | { ok: false; code: TakeoverFailure; message: string; control?: RideDispatchControl | null };

export type TakeoverFailure =
    | 'RIDE_NOT_FOUND'
    | 'RIDE_NOT_CONTROLLABLE'
    | 'ALREADY_CONTROLLED'
    | 'NOT_OWNER'
    | 'VERSION_CONFLICT'
    | 'DISABLED';

export class RideControlService {
    /** Current control for a ride. A missing row means AUTO, not an error. */
    static async get(rideId: string): Promise<RideDispatchControl | null> {
        return AppDataSource.getRepository(RideDispatchControl).findOne({ where: { rideId } });
    }

    static async getMany(rideIds: string[]): Promise<Map<string, RideDispatchControl>> {
        if (rideIds.length === 0) return new Map();
        const rows = await AppDataSource.getRepository(RideDispatchControl)
            .createQueryBuilder('c')
            .where('c."rideId" IN (:...ids)', { ids: rideIds })
            .getMany();
        return new Map(rows.map((r) => [r.rideId, r]));
    }

    /**
     * True when Operations currently holds a LIVE lease on this ride.
     *
     * Checks the expiry against the clock rather than trusting `mode` alone,
     * so a lease that lapsed between sweeps is already treated as released.
     * Dispatch asks this before creating a new offer, so being wrong in the
     * optimistic direction would mean offering a ride a dispatcher is
     * personally handling.
     */
    static isOperationsControlled(
        control: RideDispatchControl | null | undefined,
        now: Date = new Date(),
    ): boolean {
        if (!control) return false;
        if (control.mode !== DispatchControlMode.OPERATIONS) return false;
        if (!control.leaseExpiresAt) return false;
        return new Date(control.leaseExpiresAt).getTime() > now.getTime();
    }

    /**
     * Take control of a ride.
     *
     * Three outcomes, all decided by the database:
     *   - a fresh row is inserted (nobody had control) → won
     *   - an existing AUTO/expired row is flipped → won
     *   - the same staff member already holds it → idempotent success
     *   - somebody else holds a live lease → ALREADY_CONTROLLED
     *
     * The insert races other inserts via ON CONFLICT DO NOTHING, and the flip
     * races other flips via a WHERE that excludes live leases. Both paths are
     * single statements.
     */
    static async takeover(
        rideId: string,
        actor: ControlActor,
        now: Date = new Date(),
    ): Promise<TakeoverResult> {
        const config = loadOperationsDispatchConfig();
        if (!config.enabled || !config.interventionEnabled) {
            return { ok: false, code: 'DISABLED', message: 'Operations intervention is disabled.' };
        }

        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (!ride) return { ok: false, code: 'RIDE_NOT_FOUND', message: 'Ride not found.' };
        if (!CONTROLLABLE_STATUSES.includes(String(ride.status))) {
            return {
                ok: false,
                code: 'RIDE_NOT_CONTROLLABLE',
                message: `This ride is ${ride.status} and can no longer be taken over.`,
            };
        }

        const repo = AppDataSource.getRepository(RideDispatchControl);
        const leaseExpiresAt = new Date(now.getTime() + config.leaseDurationMs);

        // ── ONE statement decides ────────────────────────────────────────
        // An INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING.
        //
        // This was originally two statements — an insert with orIgnore, then
        // an update — and the seam between them was a real bug: TypeORM
        // reports identifiers for an IGNORED insert too, so a second
        // dispatcher arriving at a ride that already had a control row was
        // told they had won while the row still named somebody else. A test
        // caught it. There is now no seam: either the row comes back holding
        // this actor's lease, or nothing comes back and they lost.
        //
        // The DO UPDATE fires only when the existing row is genuinely
        // claimable — AUTO, or a lapsed lease, or already this same person —
        // so a live lease held by anyone else makes the WHERE false and the
        // statement returns no rows.
        const rows: any[] = await repo.query(
            `
            INSERT INTO "ride_dispatch_control"
                ("rideId", "mode", "ownerStaffId", "ownerLabel", "takenOverAt",
                 "leaseExpiresAt", "lastRenewedAt", "releasedAt", "releaseReason",
                 "version", "takeoverCount")
            VALUES ($1, $2, $3, $4, $5, $6, $5, NULL, NULL, 1, 1)
            ON CONFLICT ("rideId") DO UPDATE
               SET "mode"           = EXCLUDED."mode",
                   "ownerStaffId"   = EXCLUDED."ownerStaffId",
                   "ownerLabel"     = EXCLUDED."ownerLabel",
                   "takenOverAt"    = EXCLUDED."takenOverAt",
                   "leaseExpiresAt" = EXCLUDED."leaseExpiresAt",
                   "lastRenewedAt"  = EXCLUDED."lastRenewedAt",
                   "releasedAt"     = NULL,
                   "releaseReason"  = NULL,
                   "version"        = "ride_dispatch_control"."version" + 1,
                   "takeoverCount"  = "ride_dispatch_control"."takeoverCount" + 1
             WHERE "ride_dispatch_control"."mode" = $7
                OR "ride_dispatch_control"."leaseExpiresAt" IS NULL
                OR "ride_dispatch_control"."leaseExpiresAt" <= $5
                OR "ride_dispatch_control"."ownerStaffId" = $3
            RETURNING *, (xmax = 0) AS "wasInsert"
            `,
            [
                rideId,
                DispatchControlMode.OPERATIONS,
                actor.staffUserId,
                actor.label,
                now,
                leaseExpiresAt,
                DispatchControlMode.AUTO,
            ],
        );

        if (rows.length === 0) {
            // Somebody else holds a live lease. Name them, so the operator
            // knows who to talk to rather than just being refused.
            const holder = await repo.findOne({ where: { rideId } });
            return {
                ok: false,
                code: 'ALREADY_CONTROLLED',
                message: `${holder?.ownerLabel ?? 'Another dispatcher'} is already handling this ride.`,
                control: holder,
            };
        }

        const control = await repo.findOne({ where: { rideId } });
        // `xmax = 0` is Postgres telling us this tuple was inserted rather than
        // updated — a fresh takeover as opposed to a re-claim.
        const wasInsert = rows[0]?.wasInsert === true;
        const idempotent = !wasInsert && (control?.takeoverCount ?? 0) > 1;

        await this.record(
            InterventionType.TAKEOVER_CLAIMED,
            rideId,
            actor,
            ride,
            null,
            'ok',
            idempotent ? { idempotent: true } : null,
        );
        // Stop NEW automatic offers now rather than waiting for the next round
        // boundary. Offers already on a driver's screen are deliberately left
        // alone — that driver may be about to accept, and the conditional
        // UPDATE is the right place to settle it.
        OperationsDispatchService.pauseAutomaticDispatch(rideId);
        return { ok: true, control: control!, idempotent };
    }

    /**
     * Extend the lease. Only the holder may, and only while it is still live —
     * a client that was asleep past expiry must take over again rather than
     * silently resurrect control somebody else may since have taken.
     */
    static async renew(
        rideId: string,
        actor: ControlActor,
        now: Date = new Date(),
    ): Promise<TakeoverResult> {
        const config = loadOperationsDispatchConfig();
        const repo = AppDataSource.getRepository(RideDispatchControl);

        const renewed = await repo
            .createQueryBuilder()
            .update()
            .set({
                leaseExpiresAt: new Date(now.getTime() + config.leaseDurationMs),
                lastRenewedAt: now,
                version: () => '"version" + 1',
            })
            .where('"rideId" = :rideId', { rideId })
            .andWhere('mode = :ops', { ops: DispatchControlMode.OPERATIONS })
            .andWhere('"ownerStaffId" = :me', { me: actor.staffUserId })
            .andWhere('"leaseExpiresAt" > :now', { now })
            .execute();

        const control = await repo.findOne({ where: { rideId } });
        if (!renewed.affected) {
            return {
                ok: false,
                code: 'NOT_OWNER',
                message: 'Your control of this ride has ended. Take it over again to continue.',
                control,
            };
        }
        return { ok: true, control: control!, idempotent: false };
    }

    /**
     * Hand control back to automatic dispatch.
     *
     * `expectedVersion` makes a replayed or double-tapped release harmless:
     * the second one names a version that no longer exists and is refused
     * rather than releasing a lease the same person has since re-taken.
     */
    static async release(
        rideId: string,
        actor: ControlActor | null,
        reason: ControlReleaseReason,
        opts: { expectedVersion?: number; force?: boolean } = {},
        now: Date = new Date(),
    ): Promise<TakeoverResult> {
        const repo = AppDataSource.getRepository(RideDispatchControl);
        const before = await repo.findOne({ where: { rideId } });

        const qb = repo
            .createQueryBuilder()
            .update()
            .set({
                mode: DispatchControlMode.AUTO,
                ownerStaffId: null,
                ownerLabel: null,
                leaseExpiresAt: null,
                releasedAt: now,
                releaseReason: reason,
                version: () => '"version" + 1',
            })
            .where('"rideId" = :rideId', { rideId })
            .andWhere('mode = :ops', { ops: DispatchControlMode.OPERATIONS });

        // System-initiated releases (assignment, expiry, terminal ride) are not
        // owned by anyone and must always land.
        if (!opts.force && actor) {
            qb.andWhere('"ownerStaffId" = :me', { me: actor.staffUserId });
        }
        if (opts.expectedVersion != null) {
            qb.andWhere('version = :v', { v: opts.expectedVersion });
        }

        const released = await qb.execute();
        const control = await repo.findOne({ where: { rideId } });

        if (!released.affected) {
            // Already AUTO is a success from the caller's point of view: what
            // they wanted is true. Only a genuine ownership/version mismatch
            // is a failure.
            if (before && before.mode === DispatchControlMode.AUTO) {
                return { ok: true, control: control!, idempotent: true };
            }
            return {
                ok: false,
                code: opts.expectedVersion != null ? 'VERSION_CONFLICT' : 'NOT_OWNER',
                message: 'This ride is no longer under your control.',
                control,
            };
        }

        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        await this.record(
            reason === ControlReleaseReason.LEASE_EXPIRED
                ? InterventionType.CONTROL_EXPIRED
                : InterventionType.TAKEOVER_RELEASED,
            rideId,
            actor,
            ride,
            null,
            'ok',
            { reason },
        );
        return { ok: true, control: control!, idempotent: false };
    }

    /**
     * Return every lapsed lease to AUTO.
     *
     * The server's clock is the authority. A dispatcher whose phone died at
     * 09:03 does not hold a passenger's ride at 09:20 because nobody told the
     * server — this sweep is what makes that true, and it is why socket state
     * is irrelevant to control.
     */
    static async sweepExpired(now: Date = new Date()): Promise<number> {
        const repo = AppDataSource.getRepository(RideDispatchControl);
        const expired = await repo
            .createQueryBuilder('c')
            .where('c.mode = :ops', { ops: DispatchControlMode.OPERATIONS })
            .andWhere('c."leaseExpiresAt" IS NOT NULL')
            .andWhere('c."leaseExpiresAt" <= :now', { now })
            .limit(200)
            .getMany();

        let swept = 0;
        for (const row of expired) {
            const r = await this.release(
                row.rideId,
                null,
                ControlReleaseReason.LEASE_EXPIRED,
                { force: true },
                now,
            );
            if (r.ok) swept += 1;
        }
        return swept;
    }

    /**
     * Release because a driver was assigned, whoever assigned them. Called
     * from the assignment path, after the ride row has already committed.
     */
    static async releaseOnAssignment(rideId: string): Promise<void> {
        try {
            await this.release(rideId, null, ControlReleaseReason.ASSIGNED, { force: true });
        } catch (err: any) {
            // Never let control bookkeeping fail an assignment that succeeded.
            console.warn(`[OPS_CONTROL] release-on-assignment failed for ${rideId}: ${err?.message}`);
        }
    }

    /** Release because the ride reached a terminal state. */
    static async releaseOnTerminal(rideId: string): Promise<void> {
        try {
            await this.release(rideId, null, ControlReleaseReason.RIDE_TERMINAL, { force: true });
        } catch (err: any) {
            console.warn(`[OPS_CONTROL] release-on-terminal failed for ${rideId}: ${err?.message}`);
        }
    }

    private static async record(
        type: InterventionType,
        rideId: string,
        actor: ControlActor | null,
        ride: Ride | null,
        driverId: string | null,
        outcome: string,
        detail: Record<string, unknown> | null = null,
    ): Promise<void> {
        const control = await this.get(rideId).catch(() => null);
        await OperationsAuditService.record({
            type,
            rideId,
            staffUserId: actor?.staffUserId ?? null,
            staffLabel: actor?.label ?? null,
            driverId,
            priorRideStatus: ride ? String(ride.status) : null,
            priorControlMode: control?.mode ?? null,
            outcome,
            detail,
        });
    }
}
