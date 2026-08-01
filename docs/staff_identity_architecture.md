# Staff Identity Architecture

**Phase 1 of the Park Dispatch programme.** Prerequisite for every later phase.
**Branch:** `feat/staff-identity-foundation` · **Status:** implemented, not merged, not deployed.

Related: [`park_dispatch_mode_architecture.md`](./park_dispatch_mode_architecture.md) §8 ·
[`staff_role_permission_matrix.md`](./staff_role_permission_matrix.md) ·
[`admin_auth_migration.md`](./admin_auth_migration.md) ·
[`contact_privacy_migration.md`](./contact_privacy_migration.md)

---

## 1. Why this exists

The admin surface authenticated with up to four environment-variable API keys mapped to role labels
(`middleware/admin_permissions.ts`). Three consequences made it unusable as a foundation for Park
Dispatch:

1. **No human behind an action.** `AuditLog.adminId` held a role label, so "which person issued this
   badge / revealed this number / approved this settlement" was unanswerable.
2. **Deny-by-default was absent.** `attachAdminIdentity` and `requirePermission` both *defaulted to
   `superadmin`* when no identity resolved — a missing identity meant maximum privilege.
3. **A shared secret cannot be revoked per person.** Somebody leaving meant rotating a key for
   everybody, so in practice it never happened.

Park Dispatch's entire fraud model rests on attribution. Building park tables against a shared key
would mean `ParkAuditEvent.staffId` holding a role label — the control would exist on paper and be
worthless in an investigation.

## 2. What was built

| Component | Location |
|---|---|
| Permission catalogue + role matrix | `src/config/staff_permissions.ts` |
| `StaffUser`, `StaffRoleAssignment`, `StaffSession` | `src/models/Staff*.ts` |
| `StaffAuditEvent`, `ContactRevealEvent` | `src/models/` |
| Authentication, tokens, lockout, permission resolution | `src/services/staff_auth_service.ts` |
| Account lifecycle (create/invite/suspend/roles/reset) | `src/services/staff_service.ts` |
| The one audit writer | `src/services/audit_service.ts` |
| Contact access + offer shaping | `src/services/contact_access_service.ts` |
| Actor resolution + authorisation guards | `src/middleware/staff_auth.ts` |
| Auth endpoints | `src/routes/staff_auth_routes.ts` |
| Staff/audit/contact endpoints | `src/routes/staff_admin_routes.ts` |
| First-account bootstrap | `src/scripts/bootstrap_staff.ts` |
| Migration | `src/migrations/1788000000000-CreateStaffIdentity.ts` |
| Admin UI | `apps/keke_admin/{index.html,app.js,styles.css}` |

## 3. Data model

```
StaffUser                      one human who works for KekeRide
  id · email (unique) · phone (unique, normalised) · firstName · lastName
  passwordHash (bcrypt cost 12, NULL while INVITED)
  status: invited | active | locked | suspended | deactivated
  credentialVersion             ← the account-wide session kill switch
  lastPasswordChangeAt · setupTokenHash · setupTokenExpiresAt
  lastLoginAt · failedLoginCount · lockedUntil
  suspendedAt · suspendedBy · suspensionReason
  mfaEnabled · mfaSecret · mfaEnrolledAt      (fields present, enforcement deferred)
  createdByStaffId · createdAt · updatedAt

StaffRoleAssignment            a durable grant, never deleted
  staffUserId · role · parkId (nullable, for Phase 2 park scoping)
  grantedByStaffId · grantedAt
  revokedAt · revokedByStaffId · revokeReason

StaffSession                   one sign-in
  staffUserId · refreshTokenHash (SHA-256) · credentialVersion
  deviceId · issuedAt · expiresAt · lastUsedAt
  revokedAt · revokedReason · ipAddress · userAgent

StaffAuditEvent                append-only, written by AuditService only
  actorStaffUserId · actorRoleSnapshot · actorIsLegacy
  action · resourceType · resourceId · outcome
  parkId · rideId · driverId · passengerId · deviceId
  reason · metadata (redacted) · ipAddress · userAgent · correlationId · createdAt

ContactRevealEvent             who may currently see whose number, and until when
  rideId · actorType · actorId · subjectUserId · subjectRole
  fields · reason · expiresAt · deviceId · ipAddress · correlationId
```

Plus one nullable column on an existing table: `device_token.appVersion` (see
[contact_privacy_migration.md](./contact_privacy_migration.md)).

### Three design decisions worth defending

**Staff are not `User` rows.** Staff need MFA, device binding, shifts, credential rotation and
suspension that customers do not; and a defect in customer authentication must not be able to reach
staff privileges. This revises the Phase 0 proposal (`User.role = 'park_dispatcher'`) — see the
revision log in `park_dispatch_mode_architecture.md` §0.1 (R2).

**Permissions are code-defined; role assignments are durable.** A permission is a property of the
software, so it belongs in source where a diff reviews it and TypeScript types every call site. A role
assignment is a property of a person, so it belongs in the database where it can be granted and revoked
without a deploy. Route handlers ask for a *permission*, never a role name.

**Role grants are revoked, never deleted.** "What could this person do last March" must stay
answerable, and a `DELETE` erases precisely the fact an investigation needs.

## 4. Authentication flow

```
  POST /api/v1/staff/auth/login          { email, password }
        │
        ├─ unknown email        → bcrypt against a dummy hash, then fail
        ├─ deactivated/suspended/locked → fail (recorded, not disclosed)
        ├─ no password set      → fail
        ├─ wrong password       → failedLoginCount++, lock at 5 → LOCKED for 15 min
        └─ correct              → clear counters, open StaffSession
                                  ↓
                    accessToken  (JWT, 60 min, aud=keke-staff, typ=staff)
                    refreshToken (opaque 48 bytes; only its SHA-256 is stored)

  Every request:  resolveActor → StaffAuthService.identify(token)
        re-checked against the DATABASE, not trusted from the token:
          · account still exists and is ACTIVE
          · staff.credentialVersion === token.credentialVersion
          · session not revoked
        → StaffIdentity { staffUserId, roles, permissions }

  POST /api/v1/staff/auth/refresh        rotates the refresh token as it is used
  POST /api/v1/staff/auth/logout         revokes THIS session
  POST /api/v1/staff/auth/logout-all     revokes every session for the caller
  POST /api/v1/staff/auth/set-password   consumes a single-use setup/reset token
  GET  /api/v1/staff/auth/me             identity + effective permissions
```

### Token separation is cryptographic, not policy

Staff tokens are signed with a **different secret** from customer tokens. `STAFF_JWT_SECRET` is used
when configured; otherwise it is derived as `HMAC-SHA256(JWT_SECRET, "keke.staff.jwt.v1")`, which
keeps the two key spaces distinct with no new deployment configuration.

A staff token presented to `authMiddleware` therefore **fails signature verification** — it is not
merely rejected by a check somebody could later delete. Three additional layers, in order of how much
they would have to fail together:

1. staff tokens carry `aud: keke-staff` and `typ: staff`; `verifyAccessToken` requires both;
2. customer tokens carry neither, so they can never satisfy `staffAuth`;
3. `authMiddleware` explicitly rejects any token carrying the staff marker, covering a deployment
   misconfigured to share one secret.

The Socket.IO handshake (`socket_handler.ts:306`) verifies with `JWT_SECRET` and is covered by the
secret separation alone. It was deliberately left untouched to keep this change out of the live
dispatch path — noted under Limitations.

### Two revocation mechanisms, on purpose

| Mechanism | Scope | Used by |
|---|---|---|
| `StaffSession.revokedAt` | one session | logout, admin killing one device |
| `StaffUser.credentialVersion` | every session, instantly | password change, credential reset, **suspension**, **role change** |

The second needs no session lookup on the hot path, so it cannot be missed. It is why a suspension
takes effect on the *next request* rather than at the next token expiry — verified by
`suspension removes authority immediately from a live session`.

## 5. Permission resolution

```
   roles = active, unrevoked StaffRoleAssignment rows
   permissions = status === ACTIVE ? union(roleMatrix[role]) : ∅
```

A staff member who is not `ACTIVE` resolves to the **empty set** regardless of their grants. Suspension
therefore removes authority everywhere at once, without any route remembering to check status itself.

`requireStaffPermission(...perms)` denies by default, accepts any one of the listed permissions, and
**audits every denial** — an attempted escalation is as visible as a successful action.

## 6. Audit architecture

One writer: `AuditService`. Nothing else inserts into `staff_audit_event`.

| Mode | Behaviour | Used for |
|---|---|---|
| `record()` | best-effort; failure is logged at error level and pushed to a failure hook, never breaking the operation | logins, reads, denials |
| `recordCritical()` | the row is part of the operation; a write failure **throws** and aborts | contact reveals, credential resets, role changes, staff creation, exports |

The split matters both ways: a silent audit failure is unacceptable, and so is a dashboard that stops
working because an index is being rebuilt.

**Redaction** is a key-name deny-list applied at every depth, plus an 8 KB cap:
`password`, `token`, `secret`, `apiKey`, `authorization`, `cookie`, `otp`, `pin`, `phone`, `email`,
`hash`, `signature` and their variants. Values that merely *look* like secrets are left alone —
guessing at value shapes produces false confidence; naming the keys we refuse is reviewable.

**Reason-required actions:** `STAFF_SUSPENDED`, `STAFF_DEACTIVATED`, `STAFF_CREDENTIALS_RESET`,
`STAFF_ROLE_REVOKED`, `CONTACT_REVEALED`. The test is not "is this important" but "would a reviewer six
months from now be unable to tell whether this was legitimate".

The legacy `audit_log` table is untouched. It records the role-level actions of the shared-key era and
is kept as history; rewriting it with identities it never captured would be inventing history. The
admin UI shows both, with the legacy view labelled.

## 7. Bootstrap

The first `SUPER_ADMIN` cannot be created through the API (creating staff requires `staff:create`).
Rather than seeding a default credential into a migration — the most reliable way to ship a production
backdoor — it is created deliberately from a shell:

```
npm run staff:bootstrap -- --email=ops@kekeride.ng --first=Ada --last=Obi --phone=08012345678
```

No password is set. A single-use setup token is printed once; the new administrator chooses their own
password through `POST /api/v1/staff/auth/set-password`. The command refuses to run when an active
`SUPER_ADMIN` already exists, unless `--force` (itself audited).

## 8. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STAFF_JWT_SECRET` | derived from `JWT_SECRET` | staff token signing key. Setting it explicitly is preferred |
| `STAFF_ACCESS_TOKEN_MINUTES` | `60` | access token lifetime |
| `STAFF_REFRESH_TOKEN_HOURS` | `12` | one working day |
| `STAFF_MAX_FAILED_LOGINS` | `5` | lockout threshold |
| `STAFF_LOCKOUT_MINUTES` | `15` | lockout duration |
| `STAFF_SETUP_TOKEN_HOURS` | `48` | invitation / reset link lifetime |
| `STAFF_MIN_PASSWORD_LENGTH` | `12` | stricter than the customer minimum of 8 |
| `STAFF_LOGIN_RATE_LIMIT_MAX` | `10` / 15 min | keyed by IP **+** email |
| `LEGACY_ADMIN_KEY_ENABLED` | `true` | the migration kill switch |
| `CONTACT_PRIVACY_MODE` | `legacy` | see contact_privacy_migration.md |

## 9. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Full suite (`npx jest`) with integration enabled | **373 passed, 0 failed** (279 pre-existing + 94 new) |
| Pre-existing dispatch / ride / coordination tests | 279 passed — no regressions |
| Migration `up` on a scratch database | all 5 tables + the column created |
| Unique constraints actually enforced | duplicate email and duplicate phone both rejected at DB level |
| Migration `down` | every table and the column removed cleanly |

DB-backed tests run against a disposable Postgres:

```
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/keke_test npm test
```

They use their own Postgres schema (`staff_identity_test`) because the pre-existing
`dispatch-db.test.ts` also runs with `dropSchema: true` against the same URL, and Jest runs test files
in parallel workers.

## 10. Known limitations

1. **MFA is modelled but not enforced.** `mfaEnabled` / `mfaSecret` / `mfaEnrolledAt` exist so
   enrolment can be added without a second migration on a table that will by then hold real staff.
   TOTP enrolment and the per-role requirement (`SUPER_ADMIN`, `PARK_SUPERVISOR`, finance) are Phase 2.
2. **Setup tokens are delivered by hand.** The token is returned once in the API response and shown
   once in the UI. Emailing it (`EmailService` already exists) is deliberately not wired up yet —
   delivering credentials over email deserves its own decision, not a default.
3. **Device binding is a column, not a mechanism.** `StaffSession.deviceId` is recorded but nothing
   issues or validates a device credential; that arrives with `ParkDevice` in Phase 2.
4. ~~**`park_id` role scoping is not enforced.**~~ **CLOSED in Phase 2.** `middleware/park_scope.ts`
   now enforces it: a grant with a `parkId` authorises that park and no other. See
   [park_operations_architecture.md](./park_operations_architecture.md) §6.
5. **The Socket.IO handshake was not modified.** Covered by secret separation, but it lacks the
   explicit `typ === 'staff'` rejection that `authMiddleware` now has. Deliberate: keeping this change
   out of the live dispatch path was worth more than a third layer of defence.
6. **No password-expiry enforcement.** `lastPasswordChangeAt` is recorded; a 90-day rotation policy is
   not implemented.
7. **`AuditLog.adminId` is still a `varchar`.** New rows written through admin routes now carry a real
   staff id, but historical rows keep their role labels and there is no backfill — by design.
8. **Pre-existing, unrelated:** migration `AddMissingEnumValues1746600000000` fails on a *virgin*
   database (`type "ledger_entry_balancetype_enum" does not exist` — `InitialSchema` never creates it).
   Production was built incrementally so it never hit this. Not touched here; worth a separate fix
   before anyone rebuilds an environment from scratch.
