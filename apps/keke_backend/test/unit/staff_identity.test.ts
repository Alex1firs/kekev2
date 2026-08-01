/**
 * Staff identity: permission resolution, token separation, audit discipline,
 * authorisation middleware and contact-privacy shaping.
 *
 * Everything here runs WITHOUT a database. The pieces that genuinely need one
 * (account creation, duplicate constraints, login, lockout, suspension) live in
 * test/integration/staff_identity_db.test.ts.
 *
 * The bar these tests are written to: each one should fail if a specific,
 * nameable safety property is removed. "Deny by default", "a suspended member
 * has no permissions", "a customer token cannot become a staff token" and "an
 * audit row never contains a password" are all properties somebody could
 * plausibly break with a small, well-meaning refactor.
 */
import jwt from 'jsonwebtoken';
import {
    StaffRole,
    StaffPermission,
    permissionsForRole,
    resolvePermissions,
    roleMatrixSnapshot,
    isStaffRole,
    LEGACY_FORBIDDEN_PERMISSIONS,
    ALL_PERMISSIONS,
} from '../../src/config/staff_permissions';
import { StaffAuthService, STAFF_TOKEN_AUDIENCE } from '../../src/services/staff_auth_service';
import { StaffStatus } from '../../src/models/StaffUser';
import {
    AuditService,
    AuditAction,
    AuditReasonRequiredError,
    REASON_REQUIRED_ACTIONS,
    SYSTEM_LEGACY_ADMIN,
} from '../../src/services/audit_service';
import { legacyPermissions, requireStaffPermission, requireRealStaff, requireStaffAuth, auditActorOf } from '../../src/middleware/staff_auth';
import { ROLE_PERMISSIONS } from '../../src/middleware/admin_permissions';
import { maskPhoneNumber } from '../../src/services/contact_access_service';
import { meetsMinimumVersion } from '../../src/config/contact_privacy_config';

/**
 * Middleware records denials, which would otherwise reach an uninitialised
 * DataSource. Spied rather than jest.mock'd: static class methods are
 * non-enumerable, so spreading the class in a module factory silently produces
 * an object with none of them.
 */
let recordSpy: jest.SpyInstance;
beforeAll(() => {
    recordSpy = jest.spyOn(AuditService, 'record').mockResolvedValue(undefined);
});
afterAll(() => recordSpy.mockRestore());

const mockRes = () => {
    const res: any = { statusCode: 0, body: null };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: any) => { res.body = payload; return res; };
    return res;
};

const staffActor = (permissions: string[], roles: StaffRole[] = [StaffRole.SUPPORT_OFFICER]) => ({
    isLegacy: false as const,
    staffUserId: 'staff-1',
    email: 'a@b.c',
    firstName: 'A',
    lastName: 'B',
    status: StaffStatus.ACTIVE,
    roles,
    permissions: new Set(permissions),
    sessionId: 'sess-1',
});

const legacyActor = () => ({
    isLegacy: true as const,
    staffUserId: SYSTEM_LEGACY_ADMIN,
    legacyRole: 'superadmin' as const,
    roles: [] as StaffRole[],
    permissions: legacyPermissions('superadmin'),
    sessionId: null,
});

// ═══════════════════════════════════════════════════════════════════════════
describe('permission catalogue and role matrix', () => {
    it('9 — a role holding a permission is granted it', () => {
        const permissions = resolvePermissions([StaffRole.PARK_DISPATCHER]);
        expect(permissions.has(StaffPermission.DISPATCH_ASSIGN_DRIVER)).toBe(true);
    });

    it('10 — a role NOT holding a permission is denied it', () => {
        const permissions = resolvePermissions([StaffRole.PARK_DISPATCHER]);
        expect(permissions.has(StaffPermission.WALLET_ADJUST)).toBe(false);
        expect(permissions.has(StaffPermission.STAFF_CREATE)).toBe(false);
    });

    it('11 — multiple roles resolve to the union of their permissions', () => {
        const combined = resolvePermissions([StaffRole.CASHIER, StaffRole.SUPPORT_OFFICER]);
        expect(combined.has(StaffPermission.WALLET_TOPUP_CREATE)).toBe(true);  // cashier
        expect(combined.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(true);  // support
        // …and nothing neither role holds.
        expect(combined.has(StaffPermission.PARK_CREATE)).toBe(false);
    });

    it('SUPER_ADMIN holds every permission in the catalogue', () => {
        const permissions = resolvePermissions([StaffRole.SUPER_ADMIN]);
        for (const p of ALL_PERMISSIONS) expect(permissions.has(p)).toBe(true);
    });

    it('a dispatcher has NO ride-lifecycle permission — the safety property Park Dispatch rests on', () => {
        const permissions = [...resolvePermissions([StaffRole.PARK_DISPATCHER])];
        // There is deliberately no such permission anywhere in the catalogue.
        expect(permissions.some((p) => /ride:(start|complete|arrive)/.test(p))).toBe(false);
        expect(permissions).not.toContain(StaffPermission.RIDE_INTERVENE);
    });

    it('a cashier cannot approve the settlement it creates (separation of duties)', () => {
        const cashier = resolvePermissions([StaffRole.CASHIER]);
        expect(cashier.has(StaffPermission.WALLET_TOPUP_CREATE)).toBe(true);
        expect(cashier.has(StaffPermission.SETTLEMENT_APPROVE)).toBe(false);
        expect(cashier.has(StaffPermission.WALLET_ADJUST)).toBe(false);
        expect(cashier.has(StaffPermission.WALLET_REVERSE)).toBe(false);
    });

    it('the read-only analyst sees no contact data of any kind', () => {
        const analyst = resolvePermissions([StaffRole.READ_ONLY_ANALYST]);
        expect(analyst.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(false);
        expect(analyst.has(StaffPermission.MONITOR_REVEAL_CONTACT)).toBe(false);
        expect(analyst.has(StaffPermission.DISPATCH_VIEW_PASSENGER_MASKED_CONTACT)).toBe(false);
    });

    it('rejects role names that are not in the catalogue', () => {
        expect(isStaffRole('SUPER_ADMIN')).toBe(true);
        expect(isStaffRole('ROOT')).toBe(false);
        expect(isStaffRole(null)).toBe(false);
        expect(isStaffRole({ role: 'SUPER_ADMIN' })).toBe(false);
    });

    it('the snapshot the admin UI renders covers every role', () => {
        const snapshot = roleMatrixSnapshot();
        expect(snapshot).toHaveLength(Object.keys(StaffRole).length);
        for (const entry of snapshot) {
            expect(entry.permissions).toEqual([...entry.permissions].sort());
            expect(entry.permissions.length).toBe(permissionsForRole(entry.role).length);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('status gates permissions', () => {
    it('12 — a suspended staff member holds no permissions at all', () => {
        const roles = [StaffRole.SUPER_ADMIN];
        expect(StaffAuthService.resolvePermissions(StaffStatus.ACTIVE, roles).size).toBeGreaterThan(0);
        expect(StaffAuthService.resolvePermissions(StaffStatus.SUSPENDED, roles).size).toBe(0);
    });

    it('every non-ACTIVE status resolves to the empty set', () => {
        for (const status of [StaffStatus.INVITED, StaffStatus.LOCKED, StaffStatus.SUSPENDED, StaffStatus.DEACTIVATED]) {
            expect(StaffAuthService.resolvePermissions(status, [StaffRole.SUPER_ADMIN]).size).toBe(0);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('16 — the legacy shared key is confined', () => {
    it('cannot hold any restricted permission, whichever key was presented', () => {
        for (const role of Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>) {
            const granted = legacyPermissions(role);
            for (const forbidden of LEGACY_FORBIDDEN_PERMISSIONS) {
                expect(granted.has(forbidden as any)).toBe(false);
            }
        }
    });

    it('cannot create staff, issue badges, touch wallets or reveal contacts', () => {
        const granted = legacyPermissions('superadmin');
        expect(granted.has(StaffPermission.STAFF_CREATE)).toBe(false);
        expect(granted.has(StaffPermission.BADGE_ISSUE)).toBe(false);
        expect(granted.has(StaffPermission.WALLET_ADJUST)).toBe(false);
        expect(granted.has(StaffPermission.RIDE_REVEAL_CONTACT)).toBe(false);
        expect(granted.has(StaffPermission.DISPATCH_ASSIGN_DRIVER)).toBe(false);
    });

    it('retains exactly the monitoring permissions it had before, so the dashboard still works', () => {
        expect([...legacyPermissions('superadmin')].sort())
            .toEqual(['admin:write', 'metrics:read', 'monitor:read', 'monitor:reveal_contact']);
        expect([...legacyPermissions('readonly')]).toEqual(['monitor:read']);
    });

    it('is refused outright by requireRealStaff', () => {
        const req: any = { actor: legacyActor(), originalUrl: '/admin/staff', method: 'POST', headers: {} };
        const res = mockRes();
        const next = jest.fn();
        requireRealStaff(req, res as any, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('authorisation middleware', () => {
    it('denies by default — no actor means 401, never a fallback identity', () => {
        const req: any = { headers: {}, originalUrl: '/admin/staff', method: 'GET' };
        const res = mockRes();
        const next = jest.fn();
        requireStaffPermission(StaffPermission.STAFF_READ)(req, res as any, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('separates 401 (who are you) from 403 (not allowed)', () => {
        const anonymous: any = { headers: {}, originalUrl: '/x', method: 'GET' };
        const anonRes = mockRes();
        requireStaffPermission(StaffPermission.STAFF_READ)(anonymous, anonRes as any, jest.fn());
        expect(anonRes.statusCode).toBe(401);

        const known: any = { actor: staffActor([StaffPermission.RIDE_READ]), headers: {}, originalUrl: '/x', method: 'GET' };
        const knownRes = mockRes();
        requireStaffPermission(StaffPermission.STAFF_READ)(known, knownRes as any, jest.fn());
        expect(knownRes.statusCode).toBe(403);
    });

    it('grants when the actor holds ANY of the accepted permissions', () => {
        const req: any = { actor: staffActor([StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT]), headers: {}, originalUrl: '/x', method: 'POST' };
        const next = jest.fn();
        requireStaffPermission(
            StaffPermission.RIDE_REVEAL_CONTACT,
            StaffPermission.DISPATCH_REVEAL_PASSENGER_CONTACT,
        )(req, mockRes() as any, next);
        expect(next).toHaveBeenCalled();
    });

    it('requireStaffAuth refuses an unauthenticated request', () => {
        const res = mockRes();
        const next = jest.fn();
        requireStaffAuth({ headers: {} } as any, res as any, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('17 — a denied attempt is recorded, not silently dropped', () => {
        recordSpy.mockClear();
        const req: any = { actor: staffActor([]), headers: {}, originalUrl: '/admin/staff', method: 'POST', ip: '1.2.3.4' };
        requireStaffPermission(StaffPermission.STAFF_CREATE)(req, mockRes() as any, jest.fn());
        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({ action: AuditAction.PERMISSION_DENIED, outcome: 'denied' }),
        );
    });

    it('shapes the audit actor correctly for staff and for the legacy key', () => {
        expect(auditActorOf(staffActor([])).isLegacy).toBe(false);
        expect(auditActorOf(legacyActor()).staffUserId).toBe(SYSTEM_LEGACY_ADMIN);
        expect(auditActorOf(legacyActor()).isLegacy).toBe(true);
        expect(auditActorOf(undefined).staffUserId).toBe('ANONYMOUS');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('14, 15 — staff and customer tokens cannot be confused', () => {
    const CUSTOMER_SECRET = process.env.JWT_SECRET!;

    it('a staff token is not verifiable with the customer secret', () => {
        const token = StaffAuthService.issueAccessToken({
            staffUserId: 's1', credentialVersion: 1, sessionId: 'sess', typ: 'staff',
        });
        // This is exactly what authMiddleware (passengers/drivers) does.
        expect(() => jwt.verify(token, CUSTOMER_SECRET)).toThrow();
    });

    it('a customer token is not accepted as a staff token', () => {
        const passengerToken = jwt.sign(
            { userId: 'u1', email: 'p@x.com', role: 'passenger' },
            CUSTOMER_SECRET,
            { expiresIn: '1h' },
        );
        expect(StaffAuthService.verifyAccessToken(passengerToken)).toBeNull();
    });

    it('a driver token is not accepted as a staff token', () => {
        const driverToken = jwt.sign(
            { userId: 'd1', email: 'd@x.com', role: 'driver' },
            CUSTOMER_SECRET,
            { expiresIn: '1h' },
        );
        expect(StaffAuthService.verifyAccessToken(driverToken)).toBeNull();
    });

    it('a staff token carries the staff audience and round-trips its claims', () => {
        const token = StaffAuthService.issueAccessToken({
            staffUserId: 's1', credentialVersion: 7, sessionId: 'sess-9', typ: 'staff',
        });
        const decoded = jwt.decode(token) as any;
        expect(decoded.aud).toBe(STAFF_TOKEN_AUDIENCE);
        expect(decoded.typ).toBe('staff');

        const claims = StaffAuthService.verifyAccessToken(token)!;
        expect(claims.staffUserId).toBe('s1');
        expect(claims.credentialVersion).toBe(7);
        expect(claims.sessionId).toBe('sess-9');
    });

    it('rejects a garbage or tampered token', () => {
        expect(StaffAuthService.verifyAccessToken('not.a.token')).toBeNull();
        const token = StaffAuthService.issueAccessToken({
            staffUserId: 's1', credentialVersion: 1, sessionId: 'sess', typ: 'staff',
        });
        expect(StaffAuthService.verifyAccessToken(`${token}x`)).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('credentials', () => {
    it('hashes and verifies a password without storing it', async () => {
        const hash = await StaffAuthService.hashPassword('Correct-Horse-99');
        expect(hash).not.toContain('Correct-Horse-99');
        expect(await StaffAuthService.comparePassword('Correct-Horse-99', hash)).toBe(true);
        expect(await StaffAuthService.comparePassword('wrong', hash)).toBe(false);
    });

    it('enforces a staff password policy stricter than the customer one', () => {
        expect(StaffAuthService.validatePassword('short').ok).toBe(false);
        expect(StaffAuthService.validatePassword('alllowercase123').ok).toBe(false);
        expect(StaffAuthService.validatePassword('NoDigitsHereAtAll').ok).toBe(false);
        expect(StaffAuthService.validatePassword('Correct-Horse-99').ok).toBe(true);
    });

    it('setup tokens are single-use material: only a hash is retained', () => {
        const setup = StaffAuthService.generateSetupToken();
        expect(setup.hash).not.toBe(setup.token);
        expect(setup.hash).toBe(StaffAuthService.hashOpaqueToken(setup.token));
        expect(setup.expiresAt.getTime()).toBeGreaterThan(Date.now());
        // Two tokens must never collide.
        expect(StaffAuthService.generateSetupToken().token).not.toBe(setup.token);
    });

    it('refresh tokens are opaque, not JWTs carrying forgeable claims', () => {
        const token = StaffAuthService.generateRefreshToken();
        expect(token.split('.')).toHaveLength(1);
        expect(token.length).toBeGreaterThan(40);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('18 — audit metadata never carries secrets', () => {
    it('redacts credentials, tokens and personal identifiers at any depth', () => {
        const redacted: any = AuditService.redact({
            password: 'hunter2',
            nested: { refreshToken: 'abc', deep: { mfaSecret: 'JBSWY3DP', phone: '08012345678' } },
            apiKey: 'k-123',
            authorization: 'Bearer xyz',
            safeField: 'keep me',
            count: 42,
        });

        expect(redacted.password).toBe('[redacted]');
        expect(redacted.nested.refreshToken).toBe('[redacted]');
        expect(redacted.nested.deep.mfaSecret).toBe('[redacted]');
        expect(redacted.nested.deep.phone).toBe('[redacted]');
        expect(redacted.apiKey).toBe('[redacted]');
        expect(redacted.authorization).toBe('[redacted]');
        expect(redacted.safeField).toBe('keep me');
        expect(redacted.count).toBe(42);
    });

    it('redaction is case-insensitive about key names', () => {
        const redacted: any = AuditService.redact({ PassWord: 'x', ACCESSTOKEN: 'y', Email: 'a@b.c' });
        expect(redacted.PassWord).toBe('[redacted]');
        expect(redacted.ACCESSTOKEN).toBe('[redacted]');
        expect(redacted.Email).toBe('[redacted]');
    });

    it('a built audit row carries no raw secret through the metadata path', () => {
        const row = AuditService.buildRow({
            actor: { staffUserId: 's1', roles: [StaffRole.SUPER_ADMIN], isLegacy: false },
            action: AuditAction.STAFF_UPDATED,
            resourceType: 'STAFF_USER',
            resourceId: 's2',
            metadata: { password: 'hunter2', fieldsChanged: ['firstName'] },
        });
        expect(JSON.stringify(row.metadata)).not.toContain('hunter2');
        expect((row.metadata as any).fieldsChanged).toEqual(['firstName']);
        expect(row.actorRoleSnapshot).toBe(StaffRole.SUPER_ADMIN);
    });

    it('caps oversized metadata rather than writing an unbounded blob', () => {
        const row = AuditService.buildRow({
            actor: { staffUserId: 's1', roles: [], isLegacy: false },
            action: AuditAction.STAFF_UPDATED,
            resourceType: 'STAFF_USER',
            metadata: { blob: 'x'.repeat(20_000) },
        });
        expect((row.metadata as any).truncated).toBe(true);
    });
});

describe('audit reason discipline', () => {
    it('refuses a reason-required action with no reason', () => {
        for (const action of REASON_REQUIRED_ACTIONS) {
            expect(() => AuditService.buildRow({
                actor: { staffUserId: 's1', roles: [], isLegacy: false },
                action,
                resourceType: 'STAFF_USER',
            })).toThrow(AuditReasonRequiredError);
        }
    });

    it('accepts the same action once a reason is supplied', () => {
        const row = AuditService.buildRow({
            actor: { staffUserId: 's1', roles: [], isLegacy: false },
            action: AuditAction.STAFF_SUSPENDED,
            resourceType: 'STAFF_USER',
            resourceId: 's2',
            reason: '  Left the company  ',
        });
        expect(row.reason).toBe('Left the company');
    });

    it('a whitespace-only reason does not count as a reason', () => {
        expect(() => AuditService.buildRow({
            actor: { staffUserId: 's1', roles: [], isLegacy: false },
            action: AuditAction.CONTACT_REVEALED,
            resourceType: 'RIDE_CONTACT',
            reason: '   ',
        })).toThrow(AuditReasonRequiredError);
    });

    it('does not demand a reason for routine actions', () => {
        expect(() => AuditService.buildRow({
            actor: { staffUserId: 's1', roles: [], isLegacy: false },
            action: AuditAction.STAFF_LOGIN_SUCCEEDED,
            resourceType: 'STAFF_SESSION',
        })).not.toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('21 — contact masking', () => {
    it('produces a recognisable but undialable number', () => {
        const masked = maskPhoneNumber('+2348012345678');
        expect(masked).toBe('0801••••678');
        expect(masked).not.toContain('2345');
    });

    it('handles local, international and malformed input without leaking', () => {
        expect(maskPhoneNumber('08012345678')).toBe('0801••••678');
        expect(maskPhoneNumber(null)).toBeNull();
        expect(maskPhoneNumber('')).toBeNull();
        expect(maskPhoneNumber('123')).toBe('•••');
    });
});

describe('24, 25 — app-version gating for the contact compatibility layer', () => {
    it('treats an unknown version as OLD, so an unreported client keeps working', () => {
        expect(meetsMinimumVersion(null, '2.0.0')).toBe(false);
        expect(meetsMinimumVersion(undefined, '2.0.0')).toBe(false);
        expect(meetsMinimumVersion('', '2.0.0')).toBe(false);
        expect(meetsMinimumVersion('not-a-version', '2.0.0')).toBe(false);
    });

    it('compares versions numerically, not lexically', () => {
        expect(meetsMinimumVersion('2.0.0', '2.0.0')).toBe(true);
        expect(meetsMinimumVersion('2.0.1', '2.0.0')).toBe(true);
        expect(meetsMinimumVersion('10.0.0', '9.0.0')).toBe(true);   // lexical would say false
        expect(meetsMinimumVersion('1.9.9', '2.0.0')).toBe(false);
    });

    it('tolerates the build suffixes a Flutter release actually reports', () => {
        expect(meetsMinimumVersion('2.1.0+42', '2.0.0')).toBe(true);
        expect(meetsMinimumVersion('2.1', '2.0.0')).toBe(true);
        expect(meetsMinimumVersion('1.9.0-beta.3', '2.0.0')).toBe(false);
    });
});
