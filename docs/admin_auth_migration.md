# Admin Authentication Migration

Retiring the shared `x-admin-key` in favour of named staff accounts, without an outage and without a
window in which the dashboard is unusable.

Related: [`staff_identity_architecture.md`](./staff_identity_architecture.md) ·
[`staff_role_permission_matrix.md`](./staff_role_permission_matrix.md)

---

## 1. Where we started

`middleware/admin_auth.ts` accepted one of up to four environment-variable keys.
`middleware/admin_permissions.ts` mapped a key to a role label and gated routes on four permissions.

Three specific problems, all now fixed:

| Problem | Fix |
|---|---|
| `AuditLog.adminId` held a role label, so no action named a person | Real staff identity; `legacyAuditActor()` writes a staff id |
| `attachAdminIdentity` and `requirePermission` **defaulted to `superadmin`** when no identity resolved | Deny by default — no actor is a 401 |
| 12 admin routes read `req.headers['x-admin-key'].slice(-8)` unconditionally | Replaced with `legacyAuditActor(req)`; the old expression would have thrown on every staff-session request |

That last one is worth stating plainly: it was not a pre-existing bug, it was a **bug this migration
would have introduced**. A staff session carries no `x-admin-key`, so `.slice()` on `undefined` would
have turned twelve working admin endpoints into 500s the moment somebody signed in properly.

## 2. The request chain now

```
   /api/v1/admin/*
        │
   adminAuth            ── presents neither a Bearer token nor a valid key → 401
        │                  (a Bearer token is waved through; one verifier, in one place)
   resolveActor         ── Bearer  → StaffAuthService.identify() → named staff actor
        │                  x-admin-key → LEGACY actor (SYSTEM_LEGACY_ADMIN)
        │                  A presented-but-invalid staff token does NOT fall back to the key.
   requireStaffAuth     ── nothing resolved → 401
        │
   attachAdminIdentity  ── projects the actor onto the legacy `req.admin` shape
        │                  every existing handler already reads
   adminLimiter
        │
   route handlers (unchanged) + requirePermission(...)
```

Every route in `admin_routes.ts` is **untouched**. The compatibility bridge is `attachAdminIdentity`.

**A staff token always wins over a legacy key.** If a request presents both, the staff identity is
used. Falling back to the shared identity when a human's session expires is exactly how an action ends
up attributed to nobody.

## 3. What the legacy key can and cannot do

**Can** — everything it could before: `monitor:read`, `monitor:reveal_contact`, `metrics:read`,
`admin:write`. The dashboard keeps working with no change.

**Cannot** — 24 permissions listed in `LEGACY_FORBIDDEN_PERMISSIONS`:

- the entire park domain (`park:*`, `dispatch:*`)
- all badge mutations (`badge:issue|revoke|replace`)
- all money movement (`wallet:topup_create|topup_confirm|adjust|reverse`, `settlement:approve`)
- staff administration (`staff:create|update|suspend|reset_credentials|assign_roles`)
- `ride:reveal_contact` and `audit:export`

Two independent mechanisms enforce this, so neither is a single point of failure:

1. `legacyPermissions()` filters the legacy role map through the forbidden set. Redundant today — no
   legacy role maps to a restricted permission — and it stays correct if somebody adds one later.
2. Every mutating staff, park, badge and finance route also carries `requireRealStaff`, which refuses
   the legacy actor outright with a 403 and an audit row.

Legacy actions are recorded as `SYSTEM_LEGACY_ADMIN` with `actorIsLegacy = true`. The sentinel is
deliberately not a uuid: it must be impossible to mistake for a person in a query or on a screen. The
admin UI renders it as an amber "Legacy shared key" chip.

## 4. Migration steps

### Step 1 — deploy (no behaviour change)

Run the migration and deploy. `LEGACY_ADMIN_KEY_ENABLED` defaults to `true`, so every existing key,
bookmark and workflow keeps working. Nobody has to do anything on deploy day.

### Step 2 — create the first administrator

```
npm run staff:bootstrap -- --email=ops@kekeride.ng --first=Ada --last=Obi --phone=08012345678
```

Prints a single-use setup token, once. Redeem it at
`POST /api/v1/staff/auth/set-password { token, password }` or through the dashboard link.

### Step 3 — create the rest of the team

Sign in at the dashboard (**Staff account** tab) → **Staff** → **New staff member**. Assign roles from
[the matrix](./staff_role_permission_matrix.md). Each person gets their own setup token, delivered over
a trusted channel.

**Do not grant `PARK_SUPERVISOR`, `PARK_DISPATCHER` or `CASHIER` yet.** `parkId` scoping is stored but
not enforced until Phase 2 creates the park entity, so those roles are currently global.

### Step 4 — run in parallel

Both credentials work. Watch adoption:

```sql
SELECT "actorIsLegacy", count(*)
  FROM staff_audit_event
 WHERE "createdAt" > now() - interval '7 days'
 GROUP BY 1;
```

Move on when the legacy count is at or near zero for a full week.

### Step 5 — disable the shared key

```
LEGACY_ADMIN_KEY_ENABLED=false
```

`adminAuth` then refuses `x-admin-key` outright with *"Shared admin keys are disabled. Sign in with a
staff account."* The `ADMIN_API_KEY` startup guard also steps aside, so a fully-migrated deployment can
boot without one.

**Rollback is one variable.** Unset it (or set `true`) and restart: the keys work again immediately. No
data changes, no redeploy of application code.

### Step 6 — remove the keys

Delete `ADMIN_API_KEY`, `ADMIN_OPERATIONS_API_KEY`, `ADMIN_SUPPORT_API_KEY`, `ADMIN_READONLY_API_KEY`
from the environment. Then delete the legacy branch from `admin_auth.ts`, `resolveActor` and
`legacyAuditActor`, and drop the `actorIsLegacy` column if desired.

**Milestone: before Phase 2 grants any park role in production.** A park role reachable by a shared
secret would defeat the attribution the whole park design depends on.

## 5. Kill switches

| Switch | Effect | Rollback |
|---|---|---|
| `LEGACY_ADMIN_KEY_ENABLED=false` | shared keys refused; staff sessions only | set `true`, restart |
| Suspend a staff account | that person's authority ends at their next request | reactivate |
| `POST /admin/staff/:id/revoke-sessions` | every device signed out; password still valid | they sign in again |
| `POST /admin/staff/:id/reset-credentials` | sessions killed **and** password invalidated | issue the reset link |

## 6. Admin dashboard changes

- **Login** now offers two tabs: *Staff account* (email + password, primary) and *Legacy key*
  (labelled, with a warning naming exactly what it cannot do).
- The staff token is kept in `sessionStorage`; `adminFetch` sends `Authorization: Bearer` when a staff
  session exists and `x-admin-key` otherwise. A 401 triggers one transparent refresh-and-retry before
  the user is returned to the login screen.
- Signing in as staff **clears any stored shared key** on that workstation. Two credentials in one
  browser is how an action ends up attributed to the wrong one.
- The top bar shows the signed-in person and their roles, or an amber "Legacy shared key" chip.
- Navigation is permission-gated via `data-requires-permission`. This is presentational only — the
  server denies the same actions independently, and a hidden button is a courtesy, not a boundary.
- New sections: **Staff**, **Role Matrix**, **Staff Audit**. The old audit view is retained and
  relabelled **Audit Log (legacy)**.

## 7. What was deliberately not done

- **No backfill of `audit_log`.** Rows written before staff identity existed name a role because that
  is all that was ever captured. Rewriting them with invented identities would corrupt the record.
- **No forced password rotation.** `lastPasswordChangeAt` is recorded; a 90-day policy is not
  implemented.
- **No MFA enforcement.** Fields exist; enrolment and the per-role requirement are Phase 2.
- **The Socket.IO handshake is unchanged.** Staff tokens fail there on the secret, and keeping this
  change out of the live dispatch path was worth more than a third layer of defence.
