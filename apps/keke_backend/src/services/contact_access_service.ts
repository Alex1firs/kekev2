/**
 * Who may see whose phone number, and for how long.
 *
 * One service owns every path by which a real contact detail reaches a human,
 * so "who has seen this passenger's number" is a single query rather than an
 * archaeology exercise across sockets, routes and the admin dashboard.
 *
 * Three access paths, three different rules:
 *
 *   1. MASKED     — no permission needed beyond seeing the ride at all. Enough
 *                   to recognise a number read out on a call, useless for
 *                   contacting somebody unprompted.
 *   2. ASSIGNED   — the driver actually holding the ride gets the real number,
 *      DRIVER       automatically, for the ride plus a short grace period. This
 *                   is not a "reveal" decision; it is the job.
 *   3. STAFF      — a named staff member with the right permission, WITH a
 *      REVEAL       written reason, time-boxed, and audited critically.
 *
 * Nothing here ever returns a contact detail without writing a
 * ContactRevealEvent first. If the record cannot be written, the caller does
 * not get the number.
 */
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { User } from '../models/User';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import {
    ContactRevealEvent,
    ContactRevealActorType,
    ContactSubjectRole,
} from '../models/ContactRevealEvent';
import { ContactPrivacyConfig, meetsMinimumVersion } from '../config/contact_privacy_config';
import { toLocalDialable } from '../utils/phone';
import { AuditService, AuditAction, AuditActor, SYSTEM_LEGACY_ADMIN } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

/** Ride states in which the assigned driver legitimately needs the passenger. */
const DRIVER_CONTACT_RIDE_STATES = ['accepted', 'arrived', 'in_progress', 'started'];

export interface MaskedContact {
    firstName: string;
    phoneMasked: string | null;
    /** Always false — a masked contact is not dialable, and the UI must know. */
    dialable: false;
}

export interface FullContact {
    firstName: string;
    phone: string | null;
    dialable: true;
    /** When this grant lapses. Clients must not cache beyond it. */
    expiresAt: Date;
}

/** Mask a number to a recognisable but undialable form: 0803••••521. */
export function maskPhoneNumber(phone?: string | null): string | null {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 6) return '•••';
    const local = toLocalDialable(digits) ?? digits;
    const cleaned = String(local).replace(/\D/g, '');
    return `${cleaned.slice(0, 4)}••••${cleaned.slice(-3)}`;
}

export class ContactAccessService {
    /**
     * The masked view. Safe to hand to anyone already entitled to see the ride
     * — a dispatcher, a monitoring screen, a park roster view.
     */
    static async maskedPassengerContact(passengerId: string): Promise<MaskedContact | null> {
        const user = await AppDataSource.getRepository(User).findOneBy({ id: passengerId });
        if (!user) return null;
        return {
            firstName: user.firstName,
            phoneMasked: maskPhoneNumber(user.phone),
            dialable: false,
        };
    }

    /**
     * The real number, for the driver who actually holds the ride.
     *
     * Refuses when the caller is not the assigned driver, or when the ride is
     * not in a state where contact is warranted. The grace period after
     * completion exists because a driver frequently needs to call about a
     * forgotten bag — but it is bounded, and it is recorded.
     */
    static async passengerContactForAssignedDriver(
        rideId: string,
        driverId: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<FullContact> {
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (!ride) throw new AppError(404, ErrorCode.RIDE_NOT_FOUND, 'Ride not found.');
        if (!ride.driverId || ride.driverId !== driverId) {
            // Deliberately the same message as a genuinely missing ride: a
            // driver probing ride ids must not learn which ones exist.
            throw new AppError(404, ErrorCode.RIDE_NOT_FOUND, 'Ride not found.');
        }

        const status = String(ride.status);
        const graceMs = ContactPrivacyConfig.assignedDriverGraceHours * 3600_000;
        const withinGrace = ride.completedAt
            ? Date.now() - new Date(ride.completedAt).getTime() < graceMs
            : false;
        if (!DRIVER_CONTACT_RIDE_STATES.includes(status) && !withinGrace) {
            throw new AppError(403, ErrorCode.FORBIDDEN, 'Contact details are no longer available for this ride.');
        }

        const passenger = await AppDataSource.getRepository(User).findOneBy({ id: ride.passengerId });
        if (!passenger) throw new AppError(404, ErrorCode.USER_NOT_FOUND, 'Passenger not found.');

        const expiresAt = new Date(Date.now() + graceMs);
        await this.writeRevealEvent({
            rideId,
            actorType: ContactRevealActorType.ASSIGNED_DRIVER,
            actorId: driverId,
            subjectUserId: passenger.id,
            subjectRole: ContactSubjectRole.PASSENGER,
            fields: 'firstName,phone',
            reason: null,
            expiresAt,
            ipAddress: ctx.ipAddress ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        await AuditService.record({
            actor: { staffUserId: driverId, roles: [], isLegacy: false },
            action: AuditAction.CONTACT_ACCESSED_BY_ASSIGNED_DRIVER,
            resourceType: 'RIDE_CONTACT',
            resourceId: rideId,
            rideId,
            driverId,
            passengerId: passenger.id,
            metadata: { rideStatus: status, withinGrace },
            ipAddress: ctx.ipAddress ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return {
            firstName: passenger.firstName,
            phone: toLocalDialable(passenger.phone) ?? null,
            dialable: true,
            expiresAt,
        };
    }

    /**
     * A staff member deliberately looking up a passenger's number.
     *
     * Requires a reason, is time-boxed, and is audited CRITICALLY — if the
     * record cannot be written the number is not returned. The permission check
     * itself belongs to the route; this method assumes it has already passed
     * and concerns itself with recording and shaping.
     */
    static async revealPassengerContactForStaff(args: {
        rideId: string;
        actor: AuditActor;
        reason: string;
        deviceId?: string | null;
        ipAddress?: string | null;
        userAgent?: string | null;
        correlationId?: string | null;
    }): Promise<FullContact> {
        if (!args.reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to reveal contact details.');
        }

        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: args.rideId } });
        if (!ride) throw new AppError(404, ErrorCode.RIDE_NOT_FOUND, 'Ride not found.');

        const passenger = await AppDataSource.getRepository(User).findOneBy({ id: ride.passengerId });
        if (!passenger) throw new AppError(404, ErrorCode.USER_NOT_FOUND, 'Passenger not found.');

        const expiresAt = new Date(Date.now() + ContactPrivacyConfig.staffRevealMinutes * 60_000);

        // Critical first: an unrecorded reveal must not happen, so the audit row
        // is written BEFORE the number is returned and its failure aborts.
        await AuditService.recordCritical({
            actor: args.actor,
            action: AuditAction.CONTACT_REVEALED,
            resourceType: 'RIDE_CONTACT',
            resourceId: args.rideId,
            rideId: args.rideId,
            passengerId: passenger.id,
            driverId: ride.driverId ?? null,
            deviceId: args.deviceId ?? null,
            reason: args.reason.trim(),
            metadata: { fields: ['firstName', 'phone'], expiresAt: expiresAt.toISOString() },
            ipAddress: args.ipAddress ?? null,
            userAgent: args.userAgent ?? null,
            correlationId: args.correlationId ?? null,
        });

        await this.writeRevealEvent({
            rideId: args.rideId,
            actorType: args.actor.isLegacy ? ContactRevealActorType.LEGACY_ADMIN : ContactRevealActorType.STAFF,
            actorId: args.actor.isLegacy ? SYSTEM_LEGACY_ADMIN : args.actor.staffUserId,
            subjectUserId: passenger.id,
            subjectRole: ContactSubjectRole.PASSENGER,
            fields: 'firstName,phone',
            reason: args.reason.trim(),
            expiresAt,
            deviceId: args.deviceId ?? null,
            ipAddress: args.ipAddress ?? null,
            correlationId: args.correlationId ?? null,
        });

        return {
            firstName: passenger.firstName,
            phone: toLocalDialable(passenger.phone) ?? null,
            dialable: true,
            expiresAt,
        };
    }

    /** Every reveal against a ride, for the admin contact-exposure view. */
    static async revealHistory(rideId: string) {
        return AppDataSource.getRepository(ContactRevealEvent).find({
            where: { rideId },
            order: { createdAt: 'DESC' },
            take: 100,
        });
    }

    // ── dispatch offer shaping ──────────────────────────────────────────

    /**
     * The newest app version this driver's active devices have reported.
     *
     * Null when nothing has reported one, which the caller treats as "old".
     */
    static async driverAppVersion(driverId: string): Promise<string | null> {
        const tokens = await AppDataSource.getRepository(DeviceToken).find({
            where: { userId: driverId, role: UserRole.DRIVER, isActive: true },
            order: { updatedAt: 'DESC' },
            take: 5,
        });
        for (const token of tokens) {
            if (token.appVersion) return token.appVersion;
        }
        return null;
    }

    /**
     * What passenger contact data, if any, belongs in a dispatch OFFER to this
     * candidate driver — who has not accepted anything yet, and may never.
     *
     * Returns the fields to merge into the offer payload. The legacy
     * `passengerPhone` key is preserved verbatim in the modes that still send
     * it, because that is the key installed apps read.
     *
     * @deprecated the `passengerPhone` field in dispatch offers is being retired.
     *   Drivers should call GET /rides/:rideId/contact after assignment instead.
     *   See docs/contact_privacy_migration.md.
     */
    static async offerContactFields(
        driverId: string,
        passenger: { firstName?: string | null; phone?: string | null } | null,
    ): Promise<Record<string, unknown>> {
        const mode = ContactPrivacyConfig.mode;
        const fullPhone = toLocalDialable(passenger?.phone) ?? null;

        if (mode === 'legacy') {
            return { passengerPhone: fullPhone };
        }
        if (mode === 'strict') {
            return { passengerPhone: null };
        }

        // Versioned modes: an app that has not told us what it is gets the old
        // behaviour, so tightening the mode cannot break an unknown client.
        const version = await this.driverAppVersion(driverId);
        const isNewApp = meetsMinimumVersion(version, ContactPrivacyConfig.minDriverAppVersion);
        if (!isNewApp) {
            return { passengerPhone: fullPhone };
        }
        if (mode === 'masked_versioned') {
            return { passengerPhone: null, passengerPhoneMasked: maskPhoneNumber(passenger?.phone) };
        }
        return { passengerPhone: null };
    }

    private static async writeRevealEvent(input: {
        rideId: string | null;
        actorType: ContactRevealActorType;
        actorId: string;
        subjectUserId: string;
        subjectRole: ContactSubjectRole;
        fields: string;
        reason: string | null;
        expiresAt: Date;
        deviceId?: string | null;
        ipAddress?: string | null;
        correlationId?: string | null;
    }): Promise<void> {
        const repo = AppDataSource.getRepository(ContactRevealEvent);
        await repo.save(repo.create({
            rideId: input.rideId,
            actorType: input.actorType,
            actorId: input.actorId,
            subjectUserId: input.subjectUserId,
            subjectRole: input.subjectRole,
            fields: input.fields,
            reason: input.reason,
            expiresAt: input.expiresAt,
            deviceId: input.deviceId ?? null,
            ipAddress: input.ipAddress ?? null,
            correlationId: input.correlationId ?? null,
        }));
    }
}
