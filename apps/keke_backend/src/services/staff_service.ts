/**
 * Staff lifecycle: create, invite, update, suspend, reactivate, reset, roles.
 *
 * Every mutating method here takes the ACTING staff member and writes an audit
 * row through AuditService. Nothing changes a staff account without leaving a
 * record of who changed it — that is the entire reason this subsystem exists.
 *
 * Output shaping is centralised in `toDto`: no method returns an entity, so a
 * password hash, MFA secret or setup-token hash cannot reach a response by
 * somebody forgetting to strip it.
 */
import { Brackets, ILike, IsNull, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { StaffUser, StaffStatus } from '../models/StaffUser';
import { StaffRoleAssignment } from '../models/StaffRoleAssignment';
import { StaffAuthService } from './staff_auth_service';
import { AuditService, AuditAction, AuditActor } from './audit_service';
import { AuthService } from './auth_service';
import { StaffRole, StaffPermissionType, isStaffRole } from '../config/staff_permissions';
import { AppError, ErrorCode } from '../utils/errors';
import { StaffPushService } from './staff_push_service';

export interface StaffDto {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    status: StaffStatus;
    roles: StaffRole[];
    permissions: StaffPermissionType[];
    mfaEnabled: boolean;
    lastLoginAt: Date | null;
    lastPasswordChangeAt: Date | null;
    lockedUntil: Date | null;
    suspendedAt: Date | null;
    suspendedBy: string | null;
    suspensionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface StaffListQuery {
    search?: string;
    status?: StaffStatus;
    role?: StaffRole;
    page?: number;
    pageSize?: number;
}

const MAX_PAGE_SIZE = 100;

export class StaffService {
    private static get repo(): Repository<StaffUser> {
        return AppDataSource.getRepository(StaffUser);
    }

    private static get roleRepo(): Repository<StaffRoleAssignment> {
        return AppDataSource.getRepository(StaffRoleAssignment);
    }

    /**
     * The ONLY shape a staff record leaves this service in.
     *
     * passwordHash, mfaSecret, setupTokenHash and credentialVersion are absent
     * by construction rather than deleted afterwards.
     */
    static toDto(staff: StaffUser, roles: StaffRole[]): StaffDto {
        return {
            id: staff.id,
            firstName: staff.firstName,
            lastName: staff.lastName,
            email: staff.email,
            phone: staff.phone,
            status: staff.status,
            roles,
            permissions: [...StaffAuthService.resolvePermissions(staff.status, roles)].sort(),
            mfaEnabled: staff.mfaEnabled,
            lastLoginAt: staff.lastLoginAt,
            lastPasswordChangeAt: staff.lastPasswordChangeAt,
            lockedUntil: staff.lockedUntil,
            suspendedAt: staff.suspendedAt,
            suspendedBy: staff.suspendedBy,
            suspensionReason: staff.suspensionReason,
            createdAt: staff.createdAt,
            updatedAt: staff.updatedAt,
        };
    }

    static async getRoles(staffUserId: string): Promise<StaffRole[]> {
        const rows = await this.roleRepo.find({ where: { staffUserId, revokedAt: IsNull() } });
        return rows.map((r) => r.role as StaffRole);
    }

    static async getById(staffUserId: string): Promise<StaffDto | null> {
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) return null;
        return this.toDto(staff, await this.getRoles(staff.id));
    }

    /** Paged, filtered list for the admin Staff screen. */
    static async list(query: StaffListQuery): Promise<{ items: StaffDto[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));

        const qb = this.repo.createQueryBuilder('s');
        if (query.status) qb.andWhere('s.status = :status', { status: query.status });
        if (query.search?.trim()) {
            const term = `%${query.search.trim()}%`;
            qb.andWhere(new Brackets((w) => {
                w.where('s."firstName" ILIKE :term', { term })
                    .orWhere('s."lastName" ILIKE :term', { term })
                    .orWhere('s.email ILIKE :term', { term })
                    .orWhere('s.phone ILIKE :term', { term });
            }));
        }
        if (query.role) {
            // Built through the query builder rather than as a raw string so
            // TypeORM qualifies the table with the connection's schema. An
            // unqualified name resolves against search_path, which silently
            // targets the wrong schema whenever the DataSource is not on
            // `public`.
            qb.andWhere((sub) => {
                const exists = sub.subQuery()
                    .select('1')
                    .from(StaffRoleAssignment, 'ra')
                    .where('ra."staffUserId" = s.id::text')
                    .andWhere('ra.role = :role')
                    .andWhere('ra."revokedAt" IS NULL')
                    .getQuery();
                return `EXISTS ${exists}`;
            }, { role: query.role });
        }

        qb.orderBy('s."createdAt"', 'DESC').skip((page - 1) * pageSize).take(pageSize);
        const [rows, total] = await qb.getManyAndCount();

        // One query for every listed member's roles rather than N.
        const ids = rows.map((r) => r.id);
        const grants = ids.length
            ? await this.roleRepo.createQueryBuilder('ra')
                .where('ra."staffUserId" IN (:...ids)', { ids })
                .andWhere('ra."revokedAt" IS NULL')
                .getMany()
            : [];
        const byStaff = new Map<string, StaffRole[]>();
        for (const g of grants) {
            const list = byStaff.get(g.staffUserId) ?? [];
            list.push(g.role as StaffRole);
            byStaff.set(g.staffUserId, list);
        }

        return {
            items: rows.map((r) => this.toDto(r, byStaff.get(r.id) ?? [])),
            total,
            page,
            pageSize,
        };
    }

    /**
     * Create an account in INVITED state and return a single-use setup token.
     *
     * No password is chosen for the new member and no temporary password is
     * issued: a credential somebody else has seen is not a credential. The
     * caller is responsible for delivering the token; it is returned exactly
     * once and only its hash is stored.
     */
    static async createStaff(
        actor: AuditActor,
        input: { firstName: string; lastName: string; email: string; phone: string; roles: unknown },
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<{ staff: StaffDto; setupToken: string; setupTokenExpiresAt: Date }> {
        const firstName = String(input.firstName ?? '').trim();
        const lastName = String(input.lastName ?? '').trim();
        const email = AuthService.normalizeEmail(String(input.email ?? ''));
        const rawPhone = String(input.phone ?? '').trim();

        if (!firstName || !lastName) {
            throw new AppError(400, ErrorCode.MISSING_FIELDS, 'First and last name are required.');
        }
        if (!AuthService.validateEmail(email)) {
            throw new AppError(400, ErrorCode.INVALID_EMAIL, 'Please provide a valid email address.');
        }
        if (!rawPhone) {
            throw new AppError(400, ErrorCode.MISSING_FIELDS, 'A phone number is required for a staff account.');
        }
        const phone = AuthService.normalizePhone(rawPhone);

        const roles = this.parseRoles(input.roles);
        if (roles.length === 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'At least one role is required.');
        }

        if (await this.repo.findOneBy({ email })) {
            throw new AppError(409, ErrorCode.EMAIL_ALREADY_REGISTERED, 'A staff account with this email already exists.');
        }
        if (await this.repo.findOneBy({ phone })) {
            throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'A staff account with this phone number already exists.');
        }

        const setup = StaffAuthService.generateSetupToken();
        const saved = await this.repo.save(this.repo.create({
            firstName, lastName, email, phone,
            passwordHash: null,
            status: StaffStatus.INVITED,
            setupTokenHash: setup.hash,
            setupTokenExpiresAt: setup.expiresAt,
            createdByStaffId: actor.staffUserId,
        }));

        for (const role of roles) {
            await this.roleRepo.save(this.roleRepo.create({
                staffUserId: saved.id,
                role,
                parkId: null,
                grantedByStaffId: actor.staffUserId,
            }));
        }

        // Critical: an account that exists with no record of who created it is
        // exactly the gap this system was built to close.
        await AuditService.recordCritical({
            actor,
            action: AuditAction.STAFF_CREATED,
            resourceType: 'STAFF_USER',
            resourceId: saved.id,
            metadata: { roles, status: StaffStatus.INVITED },
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return {
            staff: this.toDto(saved, roles),
            setupToken: setup.token,
            setupTokenExpiresAt: setup.expiresAt,
        };
    }

    /** Consume a setup/reset token and set the first (or new) password. */
    static async completeSetup(
        token: string,
        password: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        const policy = StaffAuthService.validatePassword(password);
        if (!policy.ok) throw new AppError(400, ErrorCode.WEAK_PASSWORD, policy.message);

        const hash = StaffAuthService.hashOpaqueToken(token);
        const staff = await this.repo.findOneBy({ setupTokenHash: hash });
        if (!staff || !staff.setupTokenExpiresAt || staff.setupTokenExpiresAt.getTime() <= Date.now()) {
            throw new AppError(400, ErrorCode.INVALID_OTP, 'This setup link is invalid or has expired.');
        }
        if (staff.status === StaffStatus.DEACTIVATED || staff.status === StaffStatus.SUSPENDED) {
            throw new AppError(403, ErrorCode.FORBIDDEN, 'This account cannot be activated.');
        }

        staff.passwordHash = await StaffAuthService.hashPassword(password);
        staff.status = StaffStatus.ACTIVE;
        staff.lastPasswordChangeAt = new Date();
        staff.failedLoginCount = 0;
        staff.lockedUntil = null;
        // Single-use: consumed tokens are cleared, not merely expired.
        staff.setupTokenHash = null;
        staff.setupTokenExpiresAt = null;
        staff.credentialVersion += 1;
        await this.repo.save(staff);

        // Any session opened before the credential changed is now dead.
        await StaffAuthService.revokeAllSessions(staff.id, 'password_set');

        const roles = await this.getRoles(staff.id);
        await AuditService.record({
            actor: { staffUserId: staff.id, roles, isLegacy: false },
            action: AuditAction.STAFF_PASSWORD_SET,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return this.toDto(staff, roles);
    }

    static async updateProfile(
        actor: AuditActor,
        staffUserId: string,
        input: { firstName?: string; lastName?: string; phone?: string },
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');

        const changed: Record<string, unknown> = {};
        if (input.firstName != null && input.firstName.trim()) {
            staff.firstName = input.firstName.trim();
            changed.firstName = true;
        }
        if (input.lastName != null && input.lastName.trim()) {
            staff.lastName = input.lastName.trim();
            changed.lastName = true;
        }
        if (input.phone != null && input.phone.trim()) {
            const phone = AuthService.normalizePhone(input.phone.trim());
            const clash = await this.repo.findOneBy({ phone });
            if (clash && clash.id !== staff.id) {
                throw new AppError(409, ErrorCode.VALIDATION_ERROR, 'Another staff account already uses this phone number.');
            }
            staff.phone = phone;
            changed.phone = true;
        }

        await this.repo.save(staff);
        await AuditService.record({
            actor,
            action: AuditAction.STAFF_UPDATED,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            // Field NAMES only — the values are personal data and the audit log
            // is not the place to keep a second copy of them.
            metadata: { fieldsChanged: Object.keys(changed) },
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return this.toDto(staff, await this.getRoles(staff.id));
    }

    /**
     * Suspend an account.
     *
     * Three things happen together, and all three are required: the status
     * changes (so permission resolution returns the empty set), the credential
     * version is bumped (so existing access tokens die at the next request),
     * and every session is revoked (so no refresh token survives).
     */
    static async suspend(
        actor: AuditActor,
        staffUserId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to suspend a staff member.');
        }
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');
        if (staff.id === actor.staffUserId) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'You cannot suspend your own account.');
        }

        staff.status = StaffStatus.SUSPENDED;
        staff.suspendedAt = new Date();
        staff.suspendedBy = actor.staffUserId;
        staff.suspensionReason = reason.trim().slice(0, 500);
        await this.repo.save(staff);
        await StaffAuthService.invalidateCredentials(staff.id, 'suspended');

        await AuditService.recordCritical({
            actor,
            action: AuditAction.STAFF_SUSPENDED,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            reason: reason.trim(),
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        const fresh = await this.repo.findOneBy({ id: staff.id });
        /*
         * Silence their devices.
         *
         * A suspended dispatcher whose phone keeps buzzing with park requests
         * is being told about work they can no longer do, and is holding a
         * device that still looks like a live dispatch terminal.
         */
        await StaffPushService.revoke({
            staffUserId, reason: `staff suspended: ${reason.slice(0, 120)}`,
        }).catch(() => { /* the suspension stands regardless */ });

        return this.toDto(fresh!, await this.getRoles(staff.id));
    }

    /** Lift a suspension or an automatic lock. Never revives a DEACTIVATED account. */
    static async reactivate(
        actor: AuditActor,
        staffUserId: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');
        if (staff.status === StaffStatus.DEACTIVATED) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A deactivated account cannot be reactivated. Create a new account.');
        }

        // An INVITED account has no credential yet, so reactivation must not
        // promote it to ACTIVE — it would be an account nobody can sign into
        // and nobody can invite again.
        staff.status = staff.passwordHash ? StaffStatus.ACTIVE : StaffStatus.INVITED;
        staff.suspendedAt = null;
        staff.suspendedBy = null;
        staff.suspensionReason = null;
        staff.failedLoginCount = 0;
        staff.lockedUntil = null;
        await this.repo.save(staff);

        await AuditService.record({
            actor,
            action: AuditAction.STAFF_REACTIVATED,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            metadata: { restoredStatus: staff.status },
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return this.toDto(staff, await this.getRoles(staff.id));
    }

    static async deactivate(
        actor: AuditActor,
        staffUserId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to deactivate a staff member.');
        }
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');
        if (staff.id === actor.staffUserId) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'You cannot deactivate your own account.');
        }

        staff.status = StaffStatus.DEACTIVATED;
        staff.suspendedAt = new Date();
        staff.suspendedBy = actor.staffUserId;
        staff.suspensionReason = reason.trim().slice(0, 500);
        staff.setupTokenHash = null;
        staff.setupTokenExpiresAt = null;
        await this.repo.save(staff);
        await StaffAuthService.invalidateCredentials(staff.id, 'deactivated');

        await AuditService.recordCritical({
            actor,
            action: AuditAction.STAFF_DEACTIVATED,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            reason: reason.trim(),
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return this.toDto(staff, await this.getRoles(staff.id));
    }

    /**
     * Issue a fresh single-use reset token and kill every existing session.
     *
     * The old password stops working immediately. An administrator resetting
     * credentials is almost always responding to a suspected compromise, so
     * leaving the previous credential alive until the new one is chosen would
     * defeat the purpose.
     */
    static async resetCredentials(
        actor: AuditActor,
        staffUserId: string,
        reason: string,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<{ setupToken: string; setupTokenExpiresAt: Date; staff: StaffDto }> {
        if (!reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required to reset credentials.');
        }
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');
        if (staff.status === StaffStatus.DEACTIVATED) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A deactivated account cannot have its credentials reset.');
        }

        const setup = StaffAuthService.generateSetupToken();
        staff.setupTokenHash = setup.hash;
        staff.setupTokenExpiresAt = setup.expiresAt;
        staff.passwordHash = null;
        staff.failedLoginCount = 0;
        staff.lockedUntil = null;
        if (staff.status === StaffStatus.LOCKED || staff.status === StaffStatus.ACTIVE) {
            staff.status = StaffStatus.INVITED;
        }
        await this.repo.save(staff);
        await StaffAuthService.invalidateCredentials(staff.id, 'credential_reset');

        await AuditService.recordCritical({
            actor,
            action: AuditAction.STAFF_CREDENTIALS_RESET,
            resourceType: 'STAFF_USER',
            resourceId: staff.id,
            reason: reason.trim(),
            ipAddress: ctx.ipAddress ?? null,
            userAgent: ctx.userAgent ?? null,
            correlationId: ctx.correlationId ?? null,
        });

        return {
            setupToken: setup.token,
            setupTokenExpiresAt: setup.expiresAt,
            staff: this.toDto(staff, await this.getRoles(staff.id)),
        };
    }

    /**
     * Replace a staff member's role set.
     *
     * Grants and revocations are both recorded; revoked rows are retained with
     * a timestamp so "what could this person do in March" stays answerable.
     * Any change bumps the credential version — a demotion that leaves the old
     * permission set live in an existing token is not a demotion.
     */
    static async setRoles(
        actor: AuditActor,
        staffUserId: string,
        rolesInput: unknown,
        reason: string | null,
        ctx: { ipAddress?: string | null; userAgent?: string | null; correlationId?: string | null } = {},
    ): Promise<StaffDto> {
        const staff = await this.repo.findOneBy({ id: staffUserId });
        if (!staff) throw new AppError(404, ErrorCode.NOT_FOUND, 'Staff member not found.');

        const desired = this.parseRoles(rolesInput);
        if (desired.length === 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'At least one role is required.');
        }

        const current = await this.roleRepo.find({ where: { staffUserId, revokedAt: IsNull() } });
        const currentRoles = new Set(current.map((r) => r.role as StaffRole));
        const desiredSet = new Set(desired);

        const toGrant = desired.filter((r) => !currentRoles.has(r));
        const toRevoke = current.filter((r) => !desiredSet.has(r.role as StaffRole));

        if (toRevoke.length > 0 && !reason?.trim()) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'A reason is required when removing a role.');
        }

        for (const row of toRevoke) {
            row.revokedAt = new Date();
            row.revokedByStaffId = actor.staffUserId;
            row.revokeReason = reason!.trim().slice(0, 500);
            await this.roleRepo.save(row);
            await AuditService.recordCritical({
                actor,
                action: AuditAction.STAFF_ROLE_REVOKED,
                resourceType: 'STAFF_ROLE',
                resourceId: staff.id,
                reason: reason!.trim(),
                metadata: { role: row.role },
                ipAddress: ctx.ipAddress ?? null,
                userAgent: ctx.userAgent ?? null,
                correlationId: ctx.correlationId ?? null,
            });
        }

        for (const role of toGrant) {
            await this.roleRepo.save(this.roleRepo.create({
                staffUserId: staff.id,
                role,
                parkId: null,
                grantedByStaffId: actor.staffUserId,
            }));
            await AuditService.recordCritical({
                actor,
                action: AuditAction.STAFF_ROLE_GRANTED,
                resourceType: 'STAFF_ROLE',
                resourceId: staff.id,
                metadata: { role },
                reason: reason?.trim() || null,
                ipAddress: ctx.ipAddress ?? null,
                userAgent: ctx.userAgent ?? null,
                correlationId: ctx.correlationId ?? null,
            });
        }

        if (toGrant.length > 0 || toRevoke.length > 0) {
            await StaffAuthService.invalidateCredentials(staff.id, 'roles_changed');
        }

        return this.toDto(staff, await this.getRoles(staff.id));
    }

    /** Recent audit rows for one staff member, for the detail screen. */
    static async recentActions(staffUserId: string, limit = 25) {
        const repo = AppDataSource.getRepository(
            (await import('../models/StaffAuditEvent')).StaffAuditEvent,
        );
        return repo.find({
            where: { actorStaffUserId: staffUserId },
            order: { createdAt: 'DESC' },
            take: Math.min(100, Math.max(1, limit)),
        });
    }

    /** Never trust a role name from the client. */
    private static parseRoles(input: unknown): StaffRole[] {
        const raw = Array.isArray(input) ? input : input == null ? [] : [input];
        const out = new Set<StaffRole>();
        for (const candidate of raw) {
            if (!isStaffRole(candidate)) {
                throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Unknown role: ${String(candidate)}`);
            }
            out.add(candidate);
        }
        return [...out];
    }
}
