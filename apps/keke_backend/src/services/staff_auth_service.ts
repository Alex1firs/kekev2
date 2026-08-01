/**
 * Staff authentication: credentials, tokens, lockout, permission resolution.
 *
 * Kept strictly separate from AuthService (passengers/drivers). The separation
 * is cryptographic, not just organisational:
 *
 *   - staff tokens are signed with a DIFFERENT secret, so a staff token
 *     presented to authMiddleware fails signature verification rather than
 *     being rejected by a policy check somebody might later remove;
 *   - staff tokens additionally carry `aud: 'keke-staff'` and `typ: 'staff'`,
 *     so even under a shared secret they could not be mistaken for a customer
 *     token;
 *   - customer tokens carry neither, so they can never satisfy staffAuth.
 *
 * If STAFF_JWT_SECRET is not configured the secret is DERIVED from JWT_SECRET
 * via HMAC with a fixed label. That keeps the two key spaces distinct with no
 * new deployment configuration, while still allowing an operator to set an
 * independent secret. Setting it explicitly is preferred — see
 * docs/staff_identity_architecture.md.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { IsNull, LessThan, Not } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { StaffUser, StaffStatus } from '../models/StaffUser';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { StaffSession } from '../models/StaffSession';
import {
    StaffRole,
    StaffPermissionType,
    resolvePermissions as resolveRolePermissions,
} from '../config/staff_permissions';

const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}

/** Distinct key space for staff tokens. See the file header. */
const STAFF_JWT_SECRET: string =
    process.env.STAFF_JWT_SECRET && process.env.STAFF_JWT_SECRET.length > 0
        ? process.env.STAFF_JWT_SECRET
        : crypto.createHmac('sha256', _jwtSecret).update('keke.staff.jwt.v1').digest('hex');

export const STAFF_TOKEN_AUDIENCE = 'keke-staff';

/** Staff bcrypt cost is higher than the customer cost (10): fewer, higher-value accounts. */
const BCRYPT_ROUNDS = 12;

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const StaffAuthConfig = {
    /** Short-lived, stateless. Revocation is via credentialVersion + refresh. */
    get accessTokenMinutes(): number { return num('STAFF_ACCESS_TOKEN_MINUTES', 60); },
    /** One working day. A staff member signs in once per shift, not per hour. */
    get refreshTokenHours(): number { return num('STAFF_REFRESH_TOKEN_HOURS', 12); },
    get maxFailedLogins(): number { return num('STAFF_MAX_FAILED_LOGINS', 5); },
    get lockoutMinutes(): number { return num('STAFF_LOCKOUT_MINUTES', 15); },
    /** Invitation / reset links. Long enough to reach a person, short enough to matter. */
    get setupTokenHours(): number { return num('STAFF_SETUP_TOKEN_HOURS', 48); },
    get minPasswordLength(): number { return num('STAFF_MIN_PASSWORD_LENGTH', 12); },
};

export interface StaffTokenClaims {
    staffUserId: string;
    credentialVersion: number;
    sessionId: string;
    typ: 'staff';
}

export interface StaffIdentity {
    staffUserId: string;
    email: string;
    firstName: string;
    lastName: string;
    status: StaffStatus;
    roles: StaffRole[];
    permissions: Set<StaffPermissionType>;
    sessionId: string | null;
    isLegacy: false;
}

export type StaffLoginFailure =
    | 'invalid_credentials'
    | 'account_locked'
    | 'account_suspended'
    | 'account_deactivated'
    | 'account_not_set_up';

export class StaffAuthError extends Error {
    constructor(public readonly kind: StaffLoginFailure) {
        super(kind);
        this.name = 'StaffAuthError';
    }
}

export class StaffAuthService {
    // ── credentials ─────────────────────────────────────────────────────

    static async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    static async comparePassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    /**
     * Password policy for staff. Longer than the customer minimum (8) because a
     * staff account can suspend drivers and read personal data.
     */
    static validatePassword(password: unknown): { ok: true } | { ok: false; message: string } {
        if (typeof password !== 'string' || password.length < StaffAuthConfig.minPasswordLength) {
            return { ok: false, message: `Password must be at least ${StaffAuthConfig.minPasswordLength} characters.` };
        }
        if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
            return { ok: false, message: 'Password must contain upper case, lower case and a number.' };
        }
        return { ok: true };
    }

    /** Single-use setup/reset token. Only its SHA-256 is ever stored. */
    static generateSetupToken(): { token: string; hash: string; expiresAt: Date } {
        const token = crypto.randomBytes(32).toString('base64url');
        return {
            token,
            hash: this.hashOpaqueToken(token),
            expiresAt: new Date(Date.now() + StaffAuthConfig.setupTokenHours * 3600_000),
        };
    }

    static hashOpaqueToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    // ── tokens ──────────────────────────────────────────────────────────

    static issueAccessToken(claims: StaffTokenClaims): string {
        return jwt.sign(
            { ...claims, typ: 'staff' },
            STAFF_JWT_SECRET,
            {
                audience: STAFF_TOKEN_AUDIENCE,
                issuer: 'keke-backend',
                expiresIn: `${StaffAuthConfig.accessTokenMinutes}m`,
            },
        );
    }

    /**
     * Verify a staff access token. Returns null for anything that is not a
     * valid, unexpired, correctly-audienced staff token — including a perfectly
     * valid CUSTOMER token, which fails on the secret.
     */
    static verifyAccessToken(token: string): StaffTokenClaims | null {
        try {
            const decoded = jwt.verify(token, STAFF_JWT_SECRET, {
                audience: STAFF_TOKEN_AUDIENCE,
                issuer: 'keke-backend',
            }) as any;
            if (decoded?.typ !== 'staff' || !decoded?.staffUserId || !decoded?.sessionId) return null;
            return {
                staffUserId: String(decoded.staffUserId),
                credentialVersion: Number(decoded.credentialVersion ?? 0),
                sessionId: String(decoded.sessionId),
                typ: 'staff',
            };
        } catch {
            return null;
        }
    }

    /** Opaque high-entropy refresh token. Not a JWT — it carries no claims to forge. */
    static generateRefreshToken(): string {
        return crypto.randomBytes(48).toString('base64url');
    }

    // ── permission resolution ───────────────────────────────────────────

    /** Active, unrevoked role grants for a staff member. */
    static async loadRoles(staffUserId: string): Promise<StaffRole[]> {
        const rows = await AppDataSource.getRepository(StaffRoleAssignment).find({
            where: { staffUserId, revokedAt: IsNull() },
        });
        return rows.map((r) => r.role as StaffRole);
    }

    /**
     * The effective permission set.
     *
     * A staff member who is not ACTIVE resolves to the EMPTY set regardless of
     * their role grants. Suspension therefore removes authority immediately and
     * everywhere, without needing to find and revoke each grant — and without
     * any route having to remember to check status for itself.
     */
    static resolvePermissions(status: StaffStatus, roles: StaffRole[]): Set<StaffPermissionType> {
        if (status !== StaffStatus.ACTIVE) return new Set();
        return resolveRolePermissions(roles);
    }

    // ── login ───────────────────────────────────────────────────────────

    /**
     * Verify credentials and open a session.
     *
     * Failure modes are distinguished INTERNALLY (so the audit log is useful)
     * but the caller is expected to collapse them into one public message — see
     * routes/staff_auth_routes.ts. Telling an anonymous caller that an address
     * exists but the password is wrong is an account-enumeration oracle.
     */
    static async login(args: {
        email: string;
        password: string;
        ipAddress?: string | null;
        userAgent?: string | null;
        deviceId?: string | null;
    }): Promise<{ staff: StaffUser; roles: StaffRole[]; accessToken: string; refreshToken: string; session: StaffSession }> {
        const repo = AppDataSource.getRepository(StaffUser);
        const email = args.email.trim().toLowerCase();
        const staff = await repo.findOneBy({ email });

        if (!staff) {
            // Constant-ish work even for an unknown address, so response time
            // does not leak whether the account exists.
            await bcrypt.compare(args.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu');
            throw new StaffAuthError('invalid_credentials');
        }

        if (staff.status === StaffStatus.DEACTIVATED) throw new StaffAuthError('account_deactivated');
        if (staff.status === StaffStatus.SUSPENDED) throw new StaffAuthError('account_suspended');
        if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
            throw new StaffAuthError('account_locked');
        }
        if (!staff.passwordHash || staff.status === StaffStatus.INVITED) {
            throw new StaffAuthError('account_not_set_up');
        }

        const ok = await this.comparePassword(args.password, staff.passwordHash);
        if (!ok) {
            await this.registerFailedLogin(staff);
            throw new StaffAuthError('invalid_credentials');
        }

        // A successful login clears the failure counter and any expired lock.
        staff.failedLoginCount = 0;
        staff.lockedUntil = null;
        staff.lastLoginAt = new Date();
        if (staff.status === StaffStatus.LOCKED) staff.status = StaffStatus.ACTIVE;
        await repo.save(staff);

        const roles = await this.loadRoles(staff.id);
        const { accessToken, refreshToken, session } = await this.openSession(staff, {
            ipAddress: args.ipAddress ?? null,
            userAgent: args.userAgent ?? null,
            deviceId: args.deviceId ?? null,
        });

        return { staff, roles, accessToken, refreshToken, session };
    }

    /** Count a failure and lock the account once the threshold is crossed. */
    private static async registerFailedLogin(staff: StaffUser): Promise<void> {
        const repo = AppDataSource.getRepository(StaffUser);
        staff.failedLoginCount = (staff.failedLoginCount ?? 0) + 1;
        if (staff.failedLoginCount >= StaffAuthConfig.maxFailedLogins) {
            staff.lockedUntil = new Date(Date.now() + StaffAuthConfig.lockoutMinutes * 60_000);
            // LOCKED rather than SUSPENDED: this is automatic and self-clearing,
            // not an administrative decision about a person.
            if (staff.status === StaffStatus.ACTIVE) staff.status = StaffStatus.LOCKED;
        }
        await repo.save(staff);
    }

    static async openSession(
        staff: StaffUser,
        ctx: { ipAddress: string | null; userAgent: string | null; deviceId: string | null },
    ): Promise<{ accessToken: string; refreshToken: string; session: StaffSession }> {
        const sessionRepo = AppDataSource.getRepository(StaffSession);
        const refreshToken = this.generateRefreshToken();

        const session = await sessionRepo.save(sessionRepo.create({
            staffUserId: staff.id,
            refreshTokenHash: this.hashOpaqueToken(refreshToken),
            credentialVersion: staff.credentialVersion,
            deviceId: ctx.deviceId,
            expiresAt: new Date(Date.now() + StaffAuthConfig.refreshTokenHours * 3600_000),
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 300) : null,
        }));

        const accessToken = this.issueAccessToken({
            staffUserId: staff.id,
            credentialVersion: staff.credentialVersion,
            sessionId: session.id,
            typ: 'staff',
        });

        return { accessToken, refreshToken, session };
    }

    /**
     * Exchange a refresh token for a new access token, ROTATING the refresh
     * token in the process: the presented token is retired and a fresh one
     * issued. A stolen refresh token is therefore usable at most once, and its
     * use is visible as the legitimate holder's next refresh failing.
     */
    static async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; staff: StaffUser } | null> {
        const sessionRepo = AppDataSource.getRepository(StaffSession);
        const session = await sessionRepo.findOneBy({ refreshTokenHash: this.hashOpaqueToken(refreshToken) });
        if (!session) return null;
        if (session.revokedAt) return null;
        if (session.expiresAt.getTime() <= Date.now()) return null;

        const staff = await AppDataSource.getRepository(StaffUser).findOneBy({ id: session.staffUserId });
        if (!staff) return null;
        if (staff.status !== StaffStatus.ACTIVE) return null;
        // The account's credentials moved on (reset, suspension, role change).
        if (session.credentialVersion !== staff.credentialVersion) return null;

        const nextRefresh = this.generateRefreshToken();
        session.refreshTokenHash = this.hashOpaqueToken(nextRefresh);
        session.lastUsedAt = new Date();
        session.expiresAt = new Date(Date.now() + StaffAuthConfig.refreshTokenHours * 3600_000);
        await sessionRepo.save(session);

        return {
            accessToken: this.issueAccessToken({
                staffUserId: staff.id,
                credentialVersion: staff.credentialVersion,
                sessionId: session.id,
                typ: 'staff',
            }),
            refreshToken: nextRefresh,
            staff,
        };
    }

    static async revokeSession(sessionId: string, reason: string): Promise<void> {
        await AppDataSource.getRepository(StaffSession).update(
            { id: sessionId, revokedAt: IsNull() },
            { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
        );
    }

    /** Kill every live session for an account (suspension, credential reset). */
    static async revokeAllSessions(staffUserId: string, reason: string): Promise<number> {
        const result = await AppDataSource.getRepository(StaffSession).update(
            { staffUserId, revokedAt: IsNull() },
            { revokedAt: new Date(), revokedReason: reason.slice(0, 64) },
        );
        return result.affected ?? 0;
    }

    /**
     * Bump credentialVersion — the account-wide kill switch.
     *
     * Every token minted before this call carries the old version and is
     * rejected at the next request. Used by password change, credential reset,
     * suspension and role change, so those cannot leave a live session behind.
     */
    static async invalidateCredentials(staffUserId: string, reason: string): Promise<void> {
        await AppDataSource.getRepository(StaffUser)
            .createQueryBuilder()
            .update()
            .set({ credentialVersion: () => '"credentialVersion" + 1' })
            .where('id = :id', { id: staffUserId })
            .execute();
        await this.revokeAllSessions(staffUserId, reason);
    }

    /**
     * Resolve a bearer token to a live identity, or null.
     *
     * Every gate is re-checked against the DATABASE on each request rather than
     * trusted from the token: status, credential version and session state can
     * all change inside a token's lifetime, and a suspension that only takes
     * effect in an hour is not a suspension.
     */
    static async identify(accessToken: string): Promise<StaffIdentity | null> {
        const claims = this.verifyAccessToken(accessToken);
        if (!claims) return null;

        const staff = await AppDataSource.getRepository(StaffUser).findOneBy({ id: claims.staffUserId });
        if (!staff) return null;
        if (staff.status !== StaffStatus.ACTIVE) return null;
        if (staff.credentialVersion !== claims.credentialVersion) return null;

        const session = await AppDataSource.getRepository(StaffSession).findOneBy({ id: claims.sessionId });
        if (!session || session.revokedAt) return null;

        const roles = await this.loadRoles(staff.id);
        return {
            staffUserId: staff.id,
            email: staff.email,
            firstName: staff.firstName,
            lastName: staff.lastName,
            status: staff.status,
            roles,
            permissions: this.resolvePermissions(staff.status, roles),
            sessionId: session.id,
            isLegacy: false,
        };
    }

    /** Housekeeping: drop sessions that expired long ago. Safe to run any time. */
    static async pruneExpiredSessions(olderThanDays = 30): Promise<number> {
        const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
        const result = await AppDataSource.getRepository(StaffSession).delete({
            expiresAt: LessThan(cutoff),
            revokedAt: Not(IsNull()),
        });
        return result.affected ?? 0;
    }
}
