/**
 * Driver badge issuance, activation, revocation and replacement.
 *
 * The badge is an IDENTITY CLAIM, never a credential. Its payload can be
 * photographed from two metres away, so nothing here may unlock a wallet, a
 * profile, a payment or an account — the badge's entire authority, once
 * scanning arrives in a later phase, is "assign this ride, to this driver, at
 * this park, by this dispatcher, during this shift", and every one of those
 * qualifiers is checked server-side at the moment of use.
 *
 * Because it is not a secret, the QR payload does not need to be encrypted. It
 * needs to be UNFORGEABLE and REVOCABLE:
 *
 *   unforgeable — a truncated HMAC over an opaque id, so a hand-made card fails
 *                 verification without the server holding any per-badge secret;
 *   revocable   — status is checked server-side on every use, so a photographed
 *                 or stolen badge dies the moment somebody says so.
 *
 * Static, not rotating. A paper card cannot rotate, and the drivers this exists
 * for have no screen to rotate on. See docs/park_dispatch_mode_architecture.md
 * §9.5 for when rotation would become necessary.
 *
 * Phase 2 issues and manages badges. SCANNING one to assign a ride is Phase 4;
 * `verifyPayload` is provided here so the format is settled and testable before
 * anything depends on it.
 */
import crypto from 'crypto';
import { DriverBadge, BadgeStatus } from '../models/DriverBadge';
import { DriverProfile, DriverStatus } from '../models/DriverProfile';
import { User } from '../models/User';
import { AppDataSource } from '../config/data_source';
import { DriverBadgeRepository } from '../repositories/driver_badge_repository';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

export const BadgeAuditAction = {
    BADGE_ISSUED: 'BADGE_ISSUED',
    BADGE_ACTIVATED: 'BADGE_ACTIVATED',
    BADGE_REVOKED: 'BADGE_REVOKED',
    BADGE_REPLACED: 'BADGE_REPLACED',
    BADGE_PRINTED: 'BADGE_PRINTED',
} as const;

/** Current signing key version. Bumped when a key is rotated. */
export const BADGE_KEY_VERSION = 1;

const PAYLOAD_PREFIX = 'KR1';
const SIGNATURE_BYTES = 10;   // 80 bits — unforgeable in practice, small QR

function signingKey(version: number): string {
    const configured = process.env[`BADGE_SIGNING_KEY_V${version}`] ?? process.env.BADGE_SIGNING_KEY;
    if (configured && configured.length > 0) return configured;

    // Derived from JWT_SECRET when unset, exactly as the staff token secret is:
    // it keeps the key space distinct with no new deployment configuration,
    // while allowing an operator to set an independent key. A missing
    // JWT_SECRET already prevents the process from starting.
    const base = process.env.JWT_SECRET;
    if (!base) throw new Error('FATAL: no BADGE_SIGNING_KEY and no JWT_SECRET to derive one from.');
    return crypto.createHmac('sha256', base).update(`keke.badge.v${version}`).digest('hex');
}

export interface BadgeDto {
    badgeSerial: string;
    driverId: string;
    driverName: string;
    unitNumber: string | null;
    vehiclePlate: string | null;
    shortCode: string;
    status: BadgeStatus;
    parkId: string | null;
    issuedAt: Date;
    activatedAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
    /** The exact string to encode as a QR. Never contains personal data. */
    qrPayload: string;
}

export class BadgeService {
    // ── payload ─────────────────────────────────────────────────────────

    /**
     * Build the QR payload.
     *
     *   KR1|<keyVersion>|<badgeSerial>|<driverPublicId>|<issuedEpochDays>|<sig>
     *
     * Contains no name, phone, plate, NIN or internal user id. A photographed
     * payload therefore reveals nothing about the human it identifies.
     */
    static buildPayload(badge: Pick<DriverBadge, 'badgeSerial' | 'driverPublicId' | 'issuedAt' | 'keyVersion'>): string {
        const issuedDays = Math.floor(new Date(badge.issuedAt).getTime() / 86_400_000);
        const body = [PAYLOAD_PREFIX, badge.keyVersion, badge.badgeSerial, badge.driverPublicId, issuedDays].join('|');
        return `${body}|${this.sign(body, badge.keyVersion)}`;
    }

    private static sign(body: string, keyVersion: number): string {
        return crypto.createHmac('sha256', signingKey(keyVersion))
            .update(body)
            .digest('base64url')
            .slice(0, Math.ceil((SIGNATURE_BYTES * 8) / 6));
    }

    /**
     * Verify a scanned payload's structure and signature.
     *
     * Signature-only: it proves the card was issued by us and has not been
     * altered. It says NOTHING about whether the badge is still valid — that
     * requires the database, and a caller that skips it would happily accept a
     * revoked badge. Hence the deliberately blunt return field name.
     */
    static verifyPayload(payload: string): {
        valid: boolean;
        reason?: string;
        badgeSerial?: string;
        driverPublicId?: string;
        keyVersion?: number;
    } {
        if (typeof payload !== 'string' || payload.length > 200) {
            return { valid: false, reason: 'malformed' };
        }
        const parts = payload.split('|');
        if (parts.length !== 6) return { valid: false, reason: 'malformed' };

        const [prefix, versionRaw, badgeSerial, driverPublicId, issuedDays, signature] = parts;
        if (prefix !== PAYLOAD_PREFIX) return { valid: false, reason: 'unknown_format' };

        const keyVersion = Number(versionRaw);
        if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 9) {
            return { valid: false, reason: 'unknown_key_version' };
        }

        let expected: string;
        try {
            expected = this.sign([prefix, versionRaw, badgeSerial, driverPublicId, issuedDays].join('|'), keyVersion);
        } catch {
            return { valid: false, reason: 'unknown_key_version' };
        }

        // Constant-time compare. The window is small, but a timing side channel
        // on a signature check is free to avoid and awkward to explain later.
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return { valid: false, reason: 'bad_signature' };
        }
        return { valid: true, badgeSerial, driverPublicId, keyVersion };
    }

    // ── issuance ────────────────────────────────────────────────────────

    static async issue(
        actor: AuditActor,
        input: { driverId: string; parkId?: string | null },
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<BadgeDto> {
        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: input.driverId });
        if (!profile) throw new AppError(404, ErrorCode.PROFILE_NOT_FOUND, 'Driver not found.');

        // A badge asserts a verified identity. Issuing one to a driver whose KYC
        // is not approved would make the badge a way to bypass KYC rather than a
        // way to represent it.
        if (profile.status !== DriverStatus.APPROVED) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                `A badge can only be issued to an approved driver — this one is ${profile.status}.`);
        }
        if (!profile.photoUrl) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                'This driver has no verified photo. The photo is the control that defeats badge sharing, so a badge cannot be issued without one.');
        }

        const existing = await DriverBadgeRepository.findLiveForDriver(input.driverId);
        if (existing) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR,
                `This driver already holds badge ${existing.badgeSerial}. Replace it instead of issuing a second.`);
        }

        const badge = await this.createBadgeRow(actor, profile.userId, input.parkId ?? profile.homeParkId ?? null);

        await AuditService.recordCritical({
            actor,
            action: BadgeAuditAction.BADGE_ISSUED,
            resourceType: 'DRIVER_BADGE',
            resourceId: badge.badgeSerial,
            driverId: input.driverId,
            parkId: badge.parkId,
            metadata: { badgeSerial: badge.badgeSerial, keyVersion: badge.keyVersion },
            // Issuing creates: there was no badge before this.
            previousValue: null,
            newValue: badge.status,
            ...ctx,
        });

        return this.toDto(badge, profile);
    }

    /**
     * Create the row, retrying on the collisions that concurrency can produce.
     *
     * Serial and short code are both allocated optimistically and arbitrated by
     * the database's partial unique indexes. Badge issuance is a rare,
     * human-paced act, so a retry loop is cheaper and far less fragile than
     * holding a lock.
     */
    private static async createBadgeRow(actor: AuditActor, driverId: string, parkId: string | null): Promise<DriverBadge> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const badgeSerial = await DriverBadgeRepository.nextSerial();
            const shortCode = await this.allocateShortCode();
            const driverPublicId = crypto.randomBytes(12).toString('base64url');

            try {
                return await DriverBadgeRepository.save(DriverBadgeRepository.create({
                    badgeSerial,
                    driverId,
                    driverPublicId,
                    shortCode,
                    keyVersion: BADGE_KEY_VERSION,
                    status: BadgeStatus.PENDING_ACTIVATION,
                    parkId,
                    issuedAt: new Date(),
                    issuedByStaffId: actor.staffUserId,
                }));
            } catch (err: any) {
                lastError = err;
                const message = String(err?.message ?? '');
                const collision = message.includes('UQ_badge_shortcode_live')
                    || message.includes('PK_driver_badge')
                    || message.includes('duplicate key');
                if (!collision) throw err;
                // Another issue won the race for this serial or code — try again.
            }
        }
        throw new AppError(500, ErrorCode.INTERNAL_ERROR,
            `Could not allocate a badge serial after several attempts: ${String((lastError as any)?.message ?? 'unknown')}`);
    }

    /**
     * A six-digit code not currently held by a live badge.
     *
     * Uniform random rather than sequential: sequential codes let anyone holding
     * one badge guess the codes of badges issued around it, and while the code
     * authorises nothing on its own, handing out a trivially enumerable
     * identifier space costs nothing to avoid.
     */
    private static async allocateShortCode(): Promise<string> {
        for (let i = 0; i < 20; i += 1) {
            const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            if (!(await DriverBadgeRepository.shortCodeTaken(code))) return code;
        }
        throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Could not allocate a unique badge code.');
    }

    /**
     * Activate a badge — the act of confirming the physical card reached the
     * right human. Until then it identifies nobody.
     */
    static async activate(
        actor: AuditActor,
        badgeSerial: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<BadgeDto> {
        const badge = await this.requireBadge(badgeSerial);
        if (badge.status === BadgeStatus.ACTIVE) return this.toDto(badge);
        if (badge.status !== BadgeStatus.PENDING_ACTIVATION) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, `A ${badge.status} badge cannot be activated.`);
        }

        badge.status = BadgeStatus.ACTIVE;
        badge.activatedAt = new Date();
        badge.activatedByStaffId = actor.staffUserId;
        const saved = await DriverBadgeRepository.save(badge);

        await AuditService.recordCritical({
            actor,
            action: BadgeAuditAction.BADGE_ACTIVATED,
            resourceType: 'DRIVER_BADGE',
            resourceId: badge.badgeSerial,
            driverId: badge.driverId,
            parkId: badge.parkId,
            ...ctx,
        });
        return this.toDto(saved);
    }

    static async revoke(
        actor: AuditActor,
        badgeSerial: string,
        reason: string,
        status: BadgeStatus.REVOKED | BadgeStatus.LOST = BadgeStatus.REVOKED,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<BadgeDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to revoke a badge.');
        }
        const badge = await this.requireBadge(badgeSerial);
        if (badge.status === BadgeStatus.REVOKED || badge.status === BadgeStatus.LOST) {
            return this.toDto(badge);
        }

        // Captured before the overwrite, so the trail says what it was revoked
        // FROM — an active badge and a pending one are different incidents.
        const previousStatus = badge.status;

        badge.status = status;
        badge.revokedAt = new Date();
        badge.revokedByStaffId = actor.staffUserId;
        badge.revokeReason = reason.trim().slice(0, 500);
        const saved = await DriverBadgeRepository.save(badge);

        await AuditService.recordCritical({
            actor,
            action: BadgeAuditAction.BADGE_REVOKED,
            resourceType: 'DRIVER_BADGE',
            resourceId: badge.badgeSerial,
            driverId: badge.driverId,
            parkId: badge.parkId,
            reason: reason.trim(),
            metadata: { newStatus: status },
            previousValue: previousStatus,
            newValue: status,
            ...ctx,
        });
        return this.toDto(saved);
    }

    /**
     * Replace a badge: retire the old one and issue a new one, atomically from
     * the caller's point of view. The old serial keeps pointing at the new one,
     * so a card found in a gutter next month can be traced.
     */
    static async replace(
        actor: AuditActor,
        badgeSerial: string,
        reason: string,
        ctx: { ipAddress?: string | null; correlationId?: string | null } = {},
    ): Promise<BadgeDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to replace a badge.');
        }
        const old = await this.requireBadge(badgeSerial);
        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: old.driverId });
        if (!profile) throw new AppError(404, ErrorCode.PROFILE_NOT_FOUND, 'Driver not found.');

        // Retire first: the partial unique index allows only one live badge per
        // driver, so the new one cannot exist until the old one steps aside.
        old.status = BadgeStatus.REPLACED;
        old.revokedAt = new Date();
        old.revokedByStaffId = actor.staffUserId;
        old.revokeReason = reason.trim().slice(0, 500);
        await DriverBadgeRepository.save(old);

        const replacement = await this.createBadgeRow(actor, old.driverId, old.parkId);
        old.replacedByBadgeSerial = replacement.badgeSerial;
        await DriverBadgeRepository.save(old);

        await AuditService.recordCritical({
            actor,
            action: BadgeAuditAction.BADGE_REPLACED,
            resourceType: 'DRIVER_BADGE',
            resourceId: replacement.badgeSerial,
            driverId: old.driverId,
            parkId: old.parkId,
            reason: reason.trim(),
            metadata: { replacedSerial: old.badgeSerial },
            ...ctx,
        });

        return this.toDto(replacement, profile);
    }

    static async markPrinted(actor: AuditActor, badgeSerial: string): Promise<BadgeDto> {
        const badge = await this.requireBadge(badgeSerial);
        badge.printedAt = new Date();
        const saved = await DriverBadgeRepository.save(badge);
        await AuditService.record({
            actor,
            action: BadgeAuditAction.BADGE_PRINTED,
            resourceType: 'DRIVER_BADGE',
            resourceId: badgeSerial,
            driverId: badge.driverId,
        });
        return this.toDto(saved);
    }

    // ── reads ───────────────────────────────────────────────────────────

    static async get(badgeSerial: string): Promise<BadgeDto | null> {
        const badge = await DriverBadgeRepository.findBySerial(badgeSerial);
        return badge ? this.toDto(badge) : null;
    }

    static async list(query: Parameters<typeof DriverBadgeRepository.list>[0]) {
        const result = await DriverBadgeRepository.list(query);
        const dtos = await Promise.all(result.items.map((b) => this.toDto(b)));
        return { ...result, items: dtos };
    }

    static async toDto(badge: DriverBadge, profile?: DriverProfile | null): Promise<BadgeDto> {
        const p = profile ?? await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: badge.driverId });
        const user = p ? null : await AppDataSource.getRepository(User).findOneBy({ id: badge.driverId });
        return {
            badgeSerial: badge.badgeSerial,
            driverId: badge.driverId,
            driverName: p ? `${p.firstName} ${p.lastName}` : (user ? `${user.firstName} ${user.lastName}` : 'Unknown'),
            unitNumber: p?.unitNumber ?? null,
            vehiclePlate: p?.vehiclePlate ?? null,
            shortCode: badge.shortCode,
            status: badge.status,
            parkId: badge.parkId,
            issuedAt: badge.issuedAt,
            activatedAt: badge.activatedAt,
            revokedAt: badge.revokedAt,
            revokeReason: badge.revokeReason,
            qrPayload: this.buildPayload(badge),
        };
    }

    private static async requireBadge(badgeSerial: string): Promise<DriverBadge> {
        const badge = await DriverBadgeRepository.findBySerial(badgeSerial);
        if (!badge) throw new AppError(404, ErrorCode.NOT_FOUND, 'Badge not found.');
        return badge;
    }
}
