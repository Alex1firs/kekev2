/**
 * Staff authentication endpoints — /api/v1/staff/auth/*
 *
 * Public surface, so it is the most hostile part of this phase. Two rules run
 * through every handler:
 *
 *  1. NO ACCOUNT ENUMERATION. Every login failure returns the same status, the
 *     same code and the same sentence, whether the address is unknown, the
 *     password is wrong, or the account is suspended. The distinction is
 *     recorded in the audit log, where it is useful, and nowhere a caller can
 *     see it.
 *  2. Everything is audited — successes AND failures — because a burst of
 *     failures against one account is the signal you most want, and it only
 *     exists if failures are recorded.
 */
import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { StaffAuthService, StaffAuthError } from '../services/staff_auth_service';
import { StaffService } from '../services/staff_service';
import { AuditService, AuditAction } from '../services/audit_service';
import { resolveActor, requireRealStaff, StaffRequest, auditActorOf } from '../middleware/staff_auth';
import { errBody, ErrorCode, AppError } from '../utils/errors';

const router = Router();

/**
 * Tighter than the customer limits. A staff account is worth far more to an
 * attacker than a passenger account, there are two orders of magnitude fewer of
 * them, and no legitimate human logs in ten times in fifteen minutes.
 *
 * Keyed by IP + submitted email so one attacker cannot lock out a whole office
 * behind a shared NAT, and cannot spread an attack across addresses either.
 */
const staffLoginLimiter = rateLimit({
    windowMs: Number(process.env.STAFF_LOGIN_WINDOW_MS) || 15 * 60_000,
    max: Number(process.env.STAFF_LOGIN_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return `${ipKeyGenerator(req.ip)}|${email}`;
    },
    message: { code: ErrorCode.RATE_LIMITED, message: 'Too many sign-in attempts. Please wait and try again.' },
});

const staffSetupLimiter = rateLimit({
    windowMs: Number(process.env.STAFF_SETUP_WINDOW_MS) || 15 * 60_000,
    max: Number(process.env.STAFF_SETUP_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: ErrorCode.RATE_LIMITED, message: 'Too many attempts. Please wait and try again.' },
});

/** One sentence for every credential failure. See rule 1 above. */
const GENERIC_LOGIN_FAILURE = 'Incorrect email or password.';

function requestContext(req: Request) {
    return {
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        correlationId: (req as any).requestId ?? null,
    };
}

/**
 * POST /staff/auth/login
 */
router.post('/login', staffLoginLimiter, async (req: Request, res: Response) => {
    const ctx = requestContext(req);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
        return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, 'Email and password are required.'));
    }

    try {
        const { staff, roles, accessToken, refreshToken } = await StaffAuthService.login({
            email,
            password,
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent,
            deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : null,
        });

        await AuditService.record({
            actor: { staffUserId: staff.id, roles, isLegacy: false },
            action: AuditAction.STAFF_LOGIN_SUCCEEDED,
            resourceType: 'STAFF_SESSION',
            resourceId: staff.id,
            ...ctx,
        });

        return res.json({
            accessToken,
            refreshToken,
            staff: StaffService.toDto(staff, roles),
        });
    } catch (err: any) {
        if (err instanceof StaffAuthError) {
            // The precise reason goes to the audit log, never to the caller.
            await AuditService.record({
                actor: { staffUserId: 'ANONYMOUS', roles: [], isLegacy: false },
                action: err.kind === 'account_locked'
                    ? AuditAction.STAFF_LOGIN_BLOCKED
                    : AuditAction.STAFF_LOGIN_FAILED,
                resourceType: 'STAFF_SESSION',
                resourceId: null,
                outcome: 'denied',
                // The email is redacted by AuditService; the reason code is the
                // part worth keeping.
                metadata: { reasonCode: err.kind },
                ...ctx,
            });
            return res.status(401).json(errBody(ErrorCode.INVALID_CREDENTIALS, GENERIC_LOGIN_FAILURE));
        }
        console.error('[STAFF_AUTH] login error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, 'Something went wrong. Please try again.'));
    }
});

/**
 * POST /staff/auth/refresh
 *
 * Rotates the refresh token: the presented one is retired as it is used, so a
 * stolen token works at most once and its theft surfaces as the real holder's
 * next refresh failing.
 */
router.post('/refresh', async (req: Request, res: Response) => {
    const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (!token) {
        return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, 'A refresh token is required.'));
    }

    const result = await StaffAuthService.refresh(token);
    if (!result) {
        return res.status(401).json(errBody(ErrorCode.SESSION_EXPIRED, 'Your session has expired. Please sign in again.'));
    }

    await AuditService.record({
        actor: { staffUserId: result.staff.id, roles: await StaffAuthService.loadRoles(result.staff.id), isLegacy: false },
        action: AuditAction.STAFF_TOKEN_REFRESHED,
        resourceType: 'STAFF_SESSION',
        resourceId: result.staff.id,
        ...requestContext(req),
    });

    return res.json({ accessToken: result.accessToken, refreshToken: result.refreshToken });
});

/**
 * POST /staff/auth/logout — ends THIS session only.
 */
router.post('/logout', resolveActor, requireRealStaff, async (req: StaffRequest, res: Response) => {
    const actor = req.actor!;
    if (!actor.isLegacy && actor.sessionId) {
        await StaffAuthService.revokeSession(actor.sessionId, 'logout');
    }
    await AuditService.record({
        actor: auditActorOf(actor),
        action: AuditAction.STAFF_LOGOUT,
        resourceType: 'STAFF_SESSION',
        resourceId: actor.isLegacy ? null : actor.sessionId,
        ...requestContext(req),
    });
    return res.json({ message: 'Signed out.' });
});

/**
 * POST /staff/auth/logout-all — ends every session for the caller.
 * The button somebody presses when they think they have been compromised.
 */
router.post('/logout-all', resolveActor, requireRealStaff, async (req: StaffRequest, res: Response) => {
    const actor = req.actor!;
    if (actor.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not available for legacy sessions.'));

    const revoked = await StaffAuthService.revokeAllSessions(actor.staffUserId, 'logout_all');
    await AuditService.record({
        actor: auditActorOf(actor),
        action: AuditAction.STAFF_SESSIONS_REVOKED,
        resourceType: 'STAFF_SESSION',
        resourceId: actor.staffUserId,
        metadata: { revokedCount: revoked },
        ...requestContext(req),
    });
    return res.json({ message: 'All sessions ended.', revoked });
});

/**
 * POST /staff/auth/set-password
 *
 * Consumes a single-use invitation or reset token. Unauthenticated by design —
 * the token IS the authentication, which is why it is single-use, hashed at
 * rest and short-lived.
 */
router.post('/set-password', staffSetupLimiter, async (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!token || !password) {
        return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, 'A setup token and a new password are required.'));
    }

    try {
        const staff = await StaffService.completeSetup(token, password, requestContext(req));
        return res.json({ message: 'Password set. You can now sign in.', staff });
    } catch (err: any) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json(errBody(err.code, err.message));
        }
        console.error('[STAFF_AUTH] set-password error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, 'Something went wrong. Please try again.'));
    }
});

/**
 * GET /staff/auth/me — who am I, and what may I do.
 * The admin UI renders its navigation from `permissions`.
 */
router.get('/me', resolveActor, requireRealStaff, async (req: StaffRequest, res: Response) => {
    const actor = req.actor!;
    if (actor.isLegacy) return res.status(403).json(errBody(ErrorCode.FORBIDDEN, 'Not a staff session.'));

    const dto = await StaffService.getById(actor.staffUserId);
    if (!dto) return res.status(404).json(errBody(ErrorCode.USER_NOT_FOUND, 'Staff account not found.'));
    return res.json({ staff: dto, permissions: [...actor.permissions].sort() });
});

export default router;
