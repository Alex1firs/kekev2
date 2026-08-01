/**
 * The one way a staff action gets recorded.
 *
 * Nothing else in the codebase may insert into `staff_audit_event`. A scattered
 * `repo.save(auditRow)` is how audit trails rot: the shape drifts, half the
 * call sites forget the actor, and redaction is applied in some places and not
 * others. Everything funnels through here so those three properties are
 * structural rather than a matter of reviewer diligence.
 *
 * Two write modes, and the difference matters:
 *
 *   record()        best-effort. Used for high-volume, low-stakes events
 *                   (reads, logins). A failure is logged loudly at error level
 *                   and surfaced via the failure hook — it never breaks the
 *                   operation the user asked for.
 *
 *   recordCritical() the audit row is part of the operation. If it cannot be
 *                   written, the operation FAILS. Used where an unrecorded
 *                   action would be worse than a refused one: contact reveals,
 *                   credential resets, role changes, money.
 *
 * The distinction exists because "audit events must not silently fail critical
 * operations" cuts both ways — a silent audit failure is unacceptable, but so
 * is a dashboard that stops working because an index is being rebuilt.
 */
import { AppDataSource } from '../config/data_source';
import { StaffAuditEvent } from '../models/StaffAuditEvent';
import { StaffRole } from '../config/staff_permissions';

/** The sentinel actor for anything done with the shared legacy API key. */
export const SYSTEM_LEGACY_ADMIN = 'SYSTEM_LEGACY_ADMIN';

/** Stable action verbs. Adding one here is how a new audited action is declared. */
export const AuditAction = {
    // staff lifecycle
    STAFF_CREATED: 'STAFF_CREATED',
    STAFF_UPDATED: 'STAFF_UPDATED',
    STAFF_SUSPENDED: 'STAFF_SUSPENDED',
    STAFF_REACTIVATED: 'STAFF_REACTIVATED',
    STAFF_DEACTIVATED: 'STAFF_DEACTIVATED',
    STAFF_CREDENTIALS_RESET: 'STAFF_CREDENTIALS_RESET',
    STAFF_PASSWORD_SET: 'STAFF_PASSWORD_SET',
    STAFF_ROLE_GRANTED: 'STAFF_ROLE_GRANTED',
    STAFF_ROLE_REVOKED: 'STAFF_ROLE_REVOKED',

    // authentication
    STAFF_LOGIN_SUCCEEDED: 'STAFF_LOGIN_SUCCEEDED',
    STAFF_LOGIN_FAILED: 'STAFF_LOGIN_FAILED',
    STAFF_LOGIN_BLOCKED: 'STAFF_LOGIN_BLOCKED',
    STAFF_LOGOUT: 'STAFF_LOGOUT',
    STAFF_TOKEN_REFRESHED: 'STAFF_TOKEN_REFRESHED',
    STAFF_SESSIONS_REVOKED: 'STAFF_SESSIONS_REVOKED',

    // authorisation
    PERMISSION_DENIED: 'PERMISSION_DENIED',

    // privacy
    CONTACT_REVEALED: 'CONTACT_REVEALED',
    CONTACT_ACCESSED_BY_ASSIGNED_DRIVER: 'CONTACT_ACCESSED_BY_ASSIGNED_DRIVER',

    // audit itself
    AUDIT_EXPORTED: 'AUDIT_EXPORTED',
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];

/**
 * Actions that are refused without a written justification.
 *
 * The test is not "is this important" but "would a reviewer six months from now
 * be unable to tell whether this was legitimate". Suspending a colleague,
 * reading a passenger's phone number and resetting someone's credentials all
 * fail that test without a reason; a login does not.
 */
export const REASON_REQUIRED_ACTIONS: ReadonlySet<string> = new Set<string>([
    AuditAction.STAFF_SUSPENDED,
    AuditAction.STAFF_DEACTIVATED,
    AuditAction.STAFF_CREDENTIALS_RESET,
    AuditAction.STAFF_ROLE_REVOKED,
    AuditAction.CONTACT_REVEALED,
]);

/** Keys whose VALUES are never stored, at any nesting depth. */
const REDACT_KEYS = [
    'password', 'passwordhash', 'newpassword', 'currentpassword', 'confirmpassword',
    'token', 'accesstoken', 'refreshtoken', 'setuptoken', 'settokenhash', 'setuptokenhash',
    'refreshtokenhash', 'secret', 'mfasecret', 'apikey', 'x-admin-key', 'adminkey',
    'authorization', 'cookie', 'otp', 'pin', 'phone', 'passengerphone', 'driverphone',
    'email', 'signature', 'hash',
];

const MAX_METADATA_BYTES = 8_000;

export interface AuditActor {
    /** StaffUser.id, or SYSTEM_LEGACY_ADMIN. */
    staffUserId: string;
    roles: StaffRole[];
    isLegacy: boolean;
}

export interface AuditInput {
    actor: AuditActor;
    action: AuditActionType | string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: 'success' | 'denied' | 'failure';
    parkId?: string | null;
    rideId?: string | null;
    driverId?: string | null;
    passengerId?: string | null;
    deviceId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    correlationId?: string | null;
}

/** Raised when a reason-required action arrives without one. */
export class AuditReasonRequiredError extends Error {
    constructor(action: string) {
        super(`Action ${action} requires a reason.`);
        this.name = 'AuditReasonRequiredError';
    }
}

/** Raised when a critical audit row could not be persisted. */
export class AuditWriteError extends Error {
    constructor(action: string, cause: string) {
        super(`Audit write failed for ${action}: ${cause}`);
        this.name = 'AuditWriteError';
    }
}

type FailureHook = (input: AuditInput, error: Error) => void;

export class AuditService {
    /**
     * Notified whenever a best-effort audit write fails, so a monitoring
     * pipeline can alarm on it. Without this, `record()` failures would only
     * ever be visible in logs nobody reads.
     */
    private static failureHook: FailureHook | null = null;

    static setFailureHook(hook: FailureHook | null): void {
        this.failureHook = hook;
    }

    /**
     * Strip anything that must never be persisted.
     *
     * Deny-list by key name at every depth, plus a hard size cap. Values that
     * merely LOOK like secrets are left alone — guessing at value shapes
     * produces false confidence; naming the keys we refuse is honest and
     * reviewable.
     */
    static redact(value: unknown, depth = 0): unknown {
        if (depth > 6) return '[truncated:depth]';
        if (value == null) return value;
        if (Array.isArray(value)) return value.slice(0, 50).map((v) => this.redact(v, depth + 1));
        if (typeof value !== 'object') return value;

        const out: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
            if (REDACT_KEYS.includes(key.toLowerCase())) {
                out[key] = '[redacted]';
                continue;
            }
            out[key] = this.redact(raw, depth + 1);
        }
        return out;
    }

    private static prepareMetadata(metadata?: Record<string, unknown> | null): Record<string, unknown> | null {
        if (metadata == null) return null;
        const redacted = this.redact(metadata) as Record<string, unknown>;
        const serialized = JSON.stringify(redacted);
        if (serialized.length > MAX_METADATA_BYTES) {
            return { truncated: true, bytes: serialized.length, preview: serialized.slice(0, 512) };
        }
        return redacted;
    }

    /** Build the row without touching the database (also the unit-test seam). */
    static buildRow(input: AuditInput): Partial<StaffAuditEvent> {
        if (REASON_REQUIRED_ACTIONS.has(input.action) && !input.reason?.trim()) {
            throw new AuditReasonRequiredError(input.action);
        }
        return {
            actorStaffUserId: input.actor.staffUserId,
            actorRoleSnapshot: input.actor.roles.length ? input.actor.roles.join(',') : null,
            actorIsLegacy: input.actor.isLegacy,
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? null,
            outcome: input.outcome ?? 'success',
            parkId: input.parkId ?? null,
            rideId: input.rideId ?? null,
            driverId: input.driverId ?? null,
            passengerId: input.passengerId ?? null,
            deviceId: input.deviceId ?? null,
            reason: input.reason?.trim() ? input.reason.trim().slice(0, 500) : null,
            metadata: this.prepareMetadata(input.metadata),
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
            correlationId: input.correlationId ?? null,
        };
    }

    /**
     * Best-effort write. Never throws for infrastructure reasons — but DOES
     * throw AuditReasonRequiredError, because a missing reason is a caller bug
     * that must not be papered over.
     */
    static async record(input: AuditInput): Promise<void> {
        let row: Partial<StaffAuditEvent>;
        try {
            row = this.buildRow(input);
        } catch (err) {
            if (err instanceof AuditReasonRequiredError) throw err;
            throw err;
        }

        try {
            const repo = AppDataSource.getRepository(StaffAuditEvent);
            await repo.save(repo.create(row));
        } catch (err: any) {
            // Loud, structured, and pushed to the hook. An audit trail with a
            // silent hole in it is worse than one with a recorded gap.
            console.error(JSON.stringify({
                level: 'error',
                event: 'audit_write_failed',
                action: input.action,
                actor: input.actor.staffUserId,
                resourceType: input.resourceType,
                resourceId: input.resourceId ?? null,
                error: err?.message ?? 'unknown',
            }));
            try {
                this.failureHook?.(input, err instanceof Error ? err : new Error(String(err)));
            } catch {
                /* a broken hook must not mask the original failure */
            }
        }
    }

    /**
     * The audit row is part of the operation. A write failure throws
     * AuditWriteError so the caller aborts and the user is told, rather than
     * completing a sensitive action nobody can later account for.
     */
    static async recordCritical(input: AuditInput): Promise<void> {
        const row = this.buildRow(input); // reason check first — cheapest failure
        try {
            const repo = AppDataSource.getRepository(StaffAuditEvent);
            await repo.save(repo.create(row));
        } catch (err: any) {
            console.error(JSON.stringify({
                level: 'error',
                event: 'critical_audit_write_failed',
                action: input.action,
                actor: input.actor.staffUserId,
                error: err?.message ?? 'unknown',
            }));
            try {
                this.failureHook?.(input, err instanceof Error ? err : new Error(String(err)));
            } catch {
                /* ignore */
            }
            throw new AuditWriteError(input.action, err?.message ?? 'unknown');
        }
    }
}
