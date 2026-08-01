# Staff Role & Permission Matrix

**Source of truth:** `apps/keke_backend/src/config/staff_permissions.ts`.
This document is generated from that file — if the two disagree, the code is right and this is stale.
The same matrix is served live at `GET /api/v1/admin/staff/role-matrix` and rendered read-only in the
admin dashboard under **Role Matrix**.

---

## Roles

| Code | Abbr. | Who holds it | Permissions |
|---|---|---|---|
| `SUPER_ADMIN` | SA | Very few people. MFA mandatory once enforcement lands | 40 |
| `OPERATIONS_ADMIN` | OA | Runs supply: parks, devices, rosters, badges | 19 |
| `PARK_SUPERVISOR` | PS | Runs **one** park; supervises dispatchers, approves settlements | 17 |
| `PARK_DISPATCHER` | PD | The park floor. Claims requests, assigns drivers | 8 |
| `CASHIER` | CA | Handles driver cash at a park | 5 |
| `SUPPORT_OFFICER` | SO | Handles live passenger and driver calls | 10 |
| `READ_ONLY_ANALYST` | RA | Reads numbers | 9 |

A person may hold several roles; their effective permissions are the **union**. A person who is not
`ACTIVE` holds **none**, whatever they were granted.

## The matrix

| Permission | SA | OA | PS | PD | CA | SO | RA |
|---|---|---|---|---|---|---|---|
| `admin:write` | ✅ | ✅ | · | · | · | · | · |
| `audit:export` | ✅ | · | · | · | · | · | · |
| `audit:read` | ✅ | ✅ | ✅ | · | · | ✅ | ✅ |
| `badge:issue` | ✅ | ✅ | · | · | · | · | · |
| `badge:read` | ✅ | ✅ | ✅ | ✅ | ✅ | · | ✅ |
| `badge:replace` | ✅ | ✅ | · | · | · | · | · |
| `badge:revoke` | ✅ | ✅ | · | · | · | · | · |
| `dispatch:assign_driver` | ✅ | · | ✅ | ✅ | · | · | · |
| `dispatch:claim` | ✅ | · | ✅ | ✅ | · | · | · |
| `dispatch:release` | ✅ | · | ✅ | ✅ | · | · | · |
| `dispatch:report_issue` | ✅ | · | ✅ | ✅ | · | · | · |
| `dispatch:reveal_passenger_contact` | ✅ | · | ✅ | · | · | · | · |
| `dispatch:view_passenger_masked_contact` | ✅ | · | ✅ | ✅ | · | ✅ | · |
| `metrics:read` | ✅ | ✅ | ✅ | · | · | · | ✅ |
| `monitor:read` | ✅ | ✅ | ✅ | · | · | ✅ | ✅ |
| `monitor:reveal_contact` | ✅ | · | · | · | · | ✅ | · |
| `park:activate` | ✅ | ✅ | · | · | · | · | · |
| `park:assign_dispatcher` | ✅ | ✅ | ✅ | · | · | · | · |
| `park:create` | ✅ | ✅ | · | · | · | · | · |
| `park:read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `park:suspend` | ✅ | ✅ | · | · | · | · | · |
| `park:update` | ✅ | ✅ | · | · | · | · | · |
| `park:view_metrics` | ✅ | ✅ | ✅ | · | · | · | ✅ |
| `ride:cancel_override` | ✅ | · | · | · | · | ✅ | · |
| `ride:intervene` | ✅ | · | · | · | · | ✅ | · |
| `ride:read` | ✅ | ✅ | ✅ | ✅ | · | ✅ | ✅ |
| `ride:reveal_contact` | ✅ | · | · | · | · | ✅ | · |
| `settlement:approve` | ✅ | · | ✅ | · | · | · | · |
| `settlement:read` | ✅ | ✅ | ✅ | · | ✅ | · | ✅ |
| `staff:assign_roles` | ✅ | · | · | · | · | · | · |
| `staff:create` | ✅ | · | · | · | · | · | · |
| `staff:read` | ✅ | ✅ | · | · | · | · | · |
| `staff:reset_credentials` | ✅ | · | · | · | · | · | · |
| `staff:suspend` | ✅ | · | · | · | · | · | · |
| `staff:update` | ✅ | · | · | · | · | · | · |
| `wallet:adjust` | ✅ | · | · | · | · | · | · |
| `wallet:read` | ✅ | ✅ | ✅ | · | ✅ | ✅ | ✅ |
| `wallet:reverse` | ✅ | · | · | · | · | · | · |
| `wallet:topup_confirm` | ✅ | · | · | · | · | · | · |
| `wallet:topup_create` | ✅ | · | · | · | ✅ | · | · |

## The deliberate absences

These are the design decisions the matrix encodes. Each has a test that fails if it is reversed.

**A dispatcher holds no ride-lifecycle permission — because none exists.** There is no
`ride:mark_arrived`, `ride:start` or `ride:complete` anywhere in the catalogue. "A dispatcher cannot
fake a completed trip" is therefore not a permission setting somebody could change; it is the absence
of a capability. This is the property the whole Park Dispatch fraud model rests on
(`park_dispatch_mode_architecture.md` §1.1 rule 2).

**A cashier cannot approve the settlement it creates.** `wallet:topup_create` without
`settlement_approve`, `wallet:adjust` or `wallet:reverse`. Separation of duties is the primary control
against cash loss at a park, and it only works if the two capabilities never sit in one role.

**Operations cannot touch money or read a passenger's number.** `OPERATIONS_ADMIN` runs supply. It has
`wallet:read` for visibility and nothing that moves a balance, and no contact-reveal permission of any
kind — there is no supply-management task that requires a passenger's phone number.

**A dispatcher sees masked contact only.** `dispatch:view_passenger_masked_contact` yes,
`dispatch:reveal_passenger_contact` no. Revealing is a supervisor action, and it is audited, reasoned
and time-boxed.

**The read-only analyst sees no contact data at all.** Not masked, not revealed. Analysis works on
aggregates.

**`audit:export` is `SUPER_ADMIN` only.** Reading the audit log is routine; bulk-exporting it is a
personal-data egress event, so it is a separate and much rarer permission — and the export itself is
audited with a mandatory reason.

**Only `SUPER_ADMIN` manages staff.** Creating, suspending, resetting and re-roling colleagues is the
one capability that can manufacture authority, so it sits with the smallest possible group.
`OPERATIONS_ADMIN` gets `staff:read` so it can see who is on shift, and nothing more.

## What the legacy shared key can hold

Exactly four permissions, and never more:

`monitor:read` · `monitor:reveal_contact` · `metrics:read` · `admin:write`

`LEGACY_FORBIDDEN_PERMISSIONS` in `staff_permissions.ts` names 24 permissions a legacy key may never
hold — the whole park domain, all badge mutations, all money movement, staff administration, contact
reveal and audit export. `legacyPermissions()` filters through it, so adding a permission to a legacy
role in future cannot accidentally grant a shared secret the power to issue a badge. See
[admin_auth_migration.md](./admin_auth_migration.md).

## Changing this matrix

Editing a role's permissions is a **code change** in `src/config/staff_permissions.ts`, reviewed in a
diff. That is deliberate: what a role can do is a property of the system's design, not operational
data, and it should not be adjustable at three in the morning from a web form. Granting a *person* a
role is operational and needs no deploy.

After changing the matrix, regenerate the table above and re-run
`test/unit/staff_identity.test.ts` — several tests assert specific absences.
