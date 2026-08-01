# Park Operations Architecture — Phase 2

**The operational foundation for Park Dispatch Mode.** Parks, zones, dispatcher shifts, driver
presence, rosters, queues and badges.

**Branch:** `feat/staff-identity-foundation` · **Status:** implemented, not merged, not deployed.
**Builds on:** [`staff_identity_architecture.md`](./staff_identity_architecture.md) (Phase 1).
**Designed in:** [`park_dispatch_mode_architecture.md`](./park_dispatch_mode_architecture.md) (Phase 0.5).

---

## 0. What this phase does and does not do

**Does:** create the entities, services, APIs and admin screens that park operations need — a park you
can configure and activate, dispatchers who can open and close shifts at it, a roster of drivers with
a fair queue, live operational presence for every driver, and physical badges.

**Does not:** touch dispatch. No change to dispatch rounds, `DispatchRun`, the assignment algorithm,
driver eligibility, or the ride lifecycle. There is no park fallback. Nothing in this phase can affect
how a passenger's ride is dispatched today — the code is additive and nothing in the dispatch path
reads it.

**The rule that shapes everything:** the dispatcher never drives the ride. They receive requests,
assign a driver and monitor the assignment. After assignment the ride belongs to the driver, exactly
as it does today. This is enforced by the *absence of a capability*, not by a permission setting: there
is no `ride:mark_arrived`, `ride:start` or `ride:complete` anywhere in the catalogue, so there is
nothing to grant, misconfigure or escalate to.

---

## 1. Data model

```
park                      a real place with real staff
  parkId · name · code (unique) · address · city · state
  lat · lng                          coordinates, Nigeria bounding box enforced
  operatingRadiusM                   on-site radius, for shift-start attestation
  serviceRadiusKm                    how far a pickup may be for this park to be eligible
  capacityDrivers · maxConcurrentAssignments · priority
  status: draft | active | inactive | suspended
  opensAt · closesAt · daysOfWeek · timezone
  supervisorStaffId                  the one accountable human
  escalationContact* · commissionConfig (reserved)
  suspendedAt/By/Reason · createdByStaffId

park_zone                 a named sub-area: staging, boarding, or service
  zoneId · parkId · name · code (unique per park) · kind
  lat · lng · radiusM · priority · capacityDrivers · active

dispatcher_shift          who is on duty, where, since when
  shiftId · parkId · staffUserId · deviceId · status
  startedAt · startLat/Lng · startDistanceM · startLocationVerified
  endedAt · endedBy · endedByStaffId · endReason · handoverNotes
  requestsReceived · assignmentsMade · openClaimsAtClose

driver_presence           one row per driver, overwritten
  driverId (PK) · state · parkId · since · source · setByStaffId
  rideId · note · previousState · lastHeartbeatAt

driver_presence_event     append-only transition log
  driverId · fromState · toState · parkId · source · setByStaffId
  rideId · note · previousStateDurationSec · occurredAt

park_driver_roster        membership, and queue position
  parkId · driverId · status: active | suspended | removed
  queuePosition · queuedAt · joinedAt · addedByStaffId
  removedAt/By/Reason · suspensionReason · skipCount · notes

driver_badge              the physical card
  badgeSerial (PK) · driverId · driverPublicId · shortCode · keyVersion
  status: pending_activation | active | revoked | lost | replaced
  parkId · issuedAt/By · printedAt · activatedAt/By
  revokedAt/By/Reason · replacedByBadgeSerial

driver_profile            + deviceCapability · unitNumber · homeParkId
```

### Three constraints enforced by the database, not by code

Each guards a race an application-level check loses:

| Constraint | Why the database |
|---|---|
| One **open shift** per dispatcher (partial unique index) | A person cannot be on duty in two places. Two concurrent open requests both pass a read-then-write check |
| One **live roster row** per (park, driver), excluding removed | A driver may rejoin a park they left, so the constraint must not see removed rows |
| One **live badge** per driver, one **live short code** globally | A six-digit code must never resolve to two people. Scoped to usable statuses so a revoked badge retires its code rather than blocking it forever |

Plus `CHECK` constraints on park geometry: a negative radius or zero capacity is never a legitimate
state, and catching it in the database means it cannot arrive through a route nobody thought to guard.

### Two deliberate absences from the schema

**Driver counts are not columns on `park`.** A cached "waiting drivers" number is wrong within seconds
of somebody walking away, and a dispatcher who learns a number is unreliable stops reading it — which
is worse than the join costs. `ParkRepository.counts()` derives them; `countsForMany()` does a whole
page of parks in two grouped queries.

**There is no `park_dispatcher_assignment` table.** "Who may work at this park" is already answered by
`staff_role_assignment.parkId` from Phase 1. Two tables answering one question drift, and the one that
drifts is always the one an authorisation check reads. Phase 2 makes that column *enforced* rather
than merely stored — see §5.

---

## 2. Part A — Parks

### The status machine

```
   DRAFT ──activate──► ACTIVE ──deactivate──► INACTIVE ──activate──► ACTIVE
     ▲                   │
     │                   └──suspend (reason)──► SUSPENDED ──activate──► ACTIVE
     └─ every park starts here, whatever status the caller sends
```

**A park is never born active.** `ParkService.create` ignores any status in the request. And activation
is gated on the park being genuinely usable:

| Blocker | The operational failure it prevents |
|---|---|
| no supervisor assigned | nobody to escalate to when something goes wrong |
| coordinates missing | every distance calculation is meaningless |
| service radius ≤ 0 | the park can never match a pickup |
| no staging zone defined | dispatchers have nowhere to send drivers |

"Somebody will remember to finish setting it up" is not a control. `GET /admin/parks/:id` returns
`activationBlockers`, and the admin UI shows them as a bordered callout rather than a quiet field.

### Zones

Modelled as **circles**, not polygons. PostGIS is not installed, and a circle is both sufficient for
pilot operations and something a dispatcher can describe out loud — "the shed, fifty metres" — which a
polygon is not. Three kinds, because a park's geography is not one undifferentiated blob:

- `staging` — where drivers physically wait;
- `boarding` — where a passenger meets their Keke;
- `service` — a sub-area of the park's coverage.

A `staging` or `boarding` zone placed kilometres from the park is rejected: it is a data-entry error,
and catching it costs far less than a dispatcher sending drivers to the wrong street. A `service` zone
away from the park is allowed, because that is what it is for.

### Operating hours

Stored as local wall-clock strings plus a timezone, not UTC instants — a park opens at 6am *local*.
Evaluated through `Intl.DateTimeFormat` in the park's own zone. A window whose close precedes its open
(22:00 → 04:00) is treated as crossing midnight, which is what a night shift actually is. An unknown
timezone leaves the park open rather than permanently shut.

---

## 3. Part B — Dispatcher shifts

**Authority at a park is the intersection of two independent facts:**

1. a park-scoped role grant — may this person *ever* dispatch here;
2. an open shift — are they working *right now*.

Both are required. A dispatcher with the role but no open shift can read the dashboard; they cannot
record anything. That separation is what makes "who was on duty at 14:20" answerable from a table
rather than inferred backwards from the actions somebody took.

### Location is checked, never blocking

A GPS fix taken inside a corrugated-roof park at six in the morning is unreliable. Refusing to let
somebody start work over it would cause far more harm than the risk it mitigates. So the distance and
the verdict are **recorded** (`startDistanceM`, `startLocationVerified`), surfaced to supervisors as a
chip on the park detail screen, and reportable. That is the proportionate control.

### Multiple dispatchers

Several dispatchers may hold open shifts at one park simultaneously. The pilot has one, but nothing
assumes it. The constraint enforced is the one that is genuinely true — a *person* cannot be in two
places — not an artificial one about parks.

### Force-close

A supervisor recovering from a dispatcher who left without signing off, or whose device died. Requires
a reason, audited critically, and performed with a conditional UPDATE so two supervisors force-closing
the same shift cannot both succeed and overwrite each other's reason.

---

## 4. Part C — Driver presence

Nine operational states, replacing the binary online/offline view:

```
  OFFLINE ──► ONLINE ──► AT_PARK ──► WAITING ──► ASSIGNED ──► EN_ROUTE
                                                                  │
                                        UNAVAILABLE          PASSENGER_BOARDING
                                                                  │
                                                             TRIP_STARTED
```

### What presence is NOT

**It is not the dispatch availability heartbeat.** `driver:available:<id>` in Redis, with its
45-second TTL, answers "could dispatch ring this phone in the next few seconds" and is read by
`DispatchService` on the hot path. Nothing in `DriverPresenceService` writes that key, reads it, or is
read by dispatch. The two systems are deliberately disjoint:

- a **feature-phone driver** standing in a park has no heartbeat and is very much `AT_PARK`;
- a driver whose app is open **at home** has a heartbeat and is `ONLINE`, not `WAITING`;
- a presence bug must never be able to affect who gets rung.

### Independent of the ride lifecycle

A ride reaching `accepted` does not itself move anybody to `ASSIGNED`. Something has to record it, and
until a later phase wires it, presence is driven by the driver app and by dispatchers. This is the
point of Part C: presence is an observation about a **person**, not a projection of a row in `ride`.
Keeping them separate means a stuck ride cannot corrupt what we believe about where somebody is, and a
presence bug cannot corrupt a ride. There is a test asserting exactly this.

### The transition rules

Constrained only against the genuinely impossible. The rule that earns its place:

> A driver cannot jump from `OFFLINE` straight into a ride-shaped state.

If we believe somebody is at home and the next thing we hear is "carrying a passenger", one of those
two facts is wrong and the system should say so rather than quietly accept it.

Everything else is permitted, because the real world is not tidy — a driver abandons a pickup, walks
back to the queue, goes for fuel mid-shift. Every state can reach `OFFLINE`, so a driver can always
stop working. An administrator can override any transition with `force` **and a reason**, recorded as
`PRESENCE_FORCED` rather than silently allowed.

### What is and is not audited

Presence changes are written to the staff audit trail **only when a human causes them**
(`source = dispatcher | admin`). A driver app reporting its own state hundreds of times a day is
operational telemetry and belongs in `driver_presence_event`; putting it in the staff audit log would
bury the staff actions that matter under app noise.

### The two tables

`driver_presence` holds *now* and is overwritten. `driver_presence_event` holds *how we got here* and
never is. A repeated report of the same state produces **no event** and does not reset `since` — dwell
time keeps counting from when the state was actually entered.

---

## 5. Part D — Roster, queue and badges

### Three concepts, never merged

| Concept | Question it answers | Owned by |
|---|---|---|
| **Membership** | does this driver work out of this park? | `park_driver_roster.status` |
| **Presence** | where are they right now? | `DriverPresenceService` |
| **Queue** | who is next? | `park_driver_roster.queuePosition` |

Systems that collapse these become unusable within a month: a driver goes for fuel and either loses
their place (unfair) or keeps it while appearing available (wrong). Keeping them separate is what lets
a driver step out of the queue without leaving the roster, and be at the park without being available.

A driver may belong to **more than one park's roster** — a real pattern where two parks sit close
together.

### Not assuming an Android phone

`DriverProfile.deviceCapability` is `smartphone | feature_phone | none`. It defaults to `smartphone`
because every driver on the platform today signed up through the app — but **nothing infers capability
from that default**; it is a declared property, corrected by whoever onboards the driver. The whole
reason Park Dispatch exists is the drivers for whom it is false.

It is surfaced as a chip on every roster and queue row, not hidden in a detail view, because it changes
how a ride runs: a feature-phone driver has no app to accept anything.

### What the roster view joins

Per driver: name, unit, vehicle, capability, phone, badge, wallet balance, commission debt, last ride,
live presence, queue position. Naively that is nine queries per row.
`ParkRosterRepository.loadRosterView` does it in **six queries total**, including a `DISTINCT ON` for
last-ride-per-driver.

Wallet balance and last ride are deliberately **not** cached on the roster row: a cached balance is
wrong within one ride, and gating an assignment on a stale number is exactly the failure that makes
drivers distrust the system.

### Assignability is reported, never enforced

`ParkRosterService.assignabilityProblems` annotates each queue entry with why a driver cannot take
work — wallet blocked, no badge, not waiting, KYC not approved. A dispatcher looking at position 1
needs to know immediately that this driver owes ₦2,400, so they can send them to the cashier instead of
discovering it with a passenger waiting.

**Phase 2 only reports this.** Nothing assigns yet. Phase 4 will apply `DriverEligibilityService`,
which remains the single definition of dispatch eligibility; these checks are the operational ones a
dispatcher can see and act on, and are a superset that never contradicts it.

### Queue fairness primitives

- join at the back, positions compacted on leave so there are never holes;
- `skipCount` incremented with a **mandatory reason**, and the driver keeps their place — a skip is
  usually a system-side fact (wallet blocked, wrong vehicle) and punishing them would compound it;
- reorder must be a **permutation** of the current queue: a partial list would silently drop whoever
  was omitted;
- every skip and reorder is audited critically, which is what makes bias measurable rather than a
  matter of opinion.

### Badges

The badge is an **identity claim, never a credential**. A QR can be photographed from two metres away,
so nothing it carries unlocks a wallet, a profile or an account.

```
KR1|<keyVersion>|<badgeSerial>|<driverPublicId>|<issuedEpochDays>|<sig>
```

No name, phone, plate, NIN or internal user id — a photographed payload reveals nothing about the
human. `driverPublicId` is a fresh opaque identifier, because printing `User.id` on thousands of cards
turns an internal uuid into a public one we can never rotate.

Unforgeable via a truncated HMAC (80 bits) and revocable via a server-side status check.
`verifyPayload` returns signature validity **only** — a revoked badge still verifies, which is why the
contract is deliberately blunt and the database check is not optional.

Issuance requires an **approved driver with a verified photo**. The photo is the control that defeats
badge sharing, so a badge without one would be worse than no badge. Badges start
`pending_activation`: until somebody confirms the physical card reached the right person, it identifies
nobody.

Scanning a badge to assign a ride is **Phase 4**. Phase 2 issues, activates, revokes and replaces.

---

## 6. Park scoping — closing the Phase 1 gap

Phase 1 recorded a limitation: `StaffRoleAssignment.parkId` was stored but nothing consulted it, so a
`PARK_DISPATCHER` granted at one park was effectively a dispatcher everywhere. Harmless while no parks
existed; real the moment they did.

`middleware/park_scope.ts` closes it:

- a grant **with** a `parkId` authorises that park and no other;
- a grant with `parkId = NULL` is global — how `OPERATIONS_ADMIN` and `SUPER_ADMIN` reach every park;
- a permission alone is never sufficient for a park-bound route: `requireParkScope()` runs **in
  addition to** `requireStaffPermission`, never instead of it.

Scope is resolved from the database on every check, for the same reason Phase 1 re-reads status: a
reassignment that only takes effect in an hour is not a reassignment.

---

## 7. API surface

### Admin — `/api/v1/admin` (inherits the Phase 1 auth chain)

```
GET    /parks                             list, filtered to the caller's park scope
POST   /parks                             create (always DRAFT)
GET    /parks/:parkId                     detail + zones + on-duty + activation blockers
PATCH  /parks/:parkId
POST   /parks/:parkId/activate            refuses unless genuinely ready
POST   /parks/:parkId/deactivate | /suspend
PUT    /parks/:parkId/supervisor          nominee must hold the role at this park
GET    /parks/:parkId/zones · POST · PATCH /zones/:zoneId
GET    /parks/:parkId/roster · /queue
POST   /parks/:parkId/roster              add driver
DELETE /parks/:parkId/roster/:driverId    reason required
POST   /parks/:parkId/roster/:driverId/suspend | /reinstate
GET    /parks/:parkId/shifts · /presence · /presence/stale
GET    /shifts/on-duty                    every park
POST   /shifts/:shiftId/force-close       reason required
GET    /drivers/:driverId/presence · POST (admin override)
GET    /badges · POST
POST   /badges/:serial/activate | /revoke | /replace
```

### Dispatcher — `/api/v1/dispatcher` (staff sessions only; legacy key refused)

```
GET  /me                     identity, assigned parks, current shift
POST /shifts/open | /close
GET  /dashboard              park + counts + queue + presence + on-duty, ONE round trip
GET  /roster · /queue
POST /queue/join | /leave | /skip | /reorder
POST /presence               a dispatcher recording what a driver is doing
GET  /presence/:driverId     state, allowed next states, recent history
```

The dashboard is one round trip because a park device is on metered mobile data and five calls to paint
one screen is a real cost. Its payload states `capabilities.canAssignRides: false` explicitly, so a
client has no code path expecting otherwise.

---

## 8. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Full suite with integration enabled | **454 passed, 0 failed** |
| Pre-existing dispatch / ride / coordination tests | 279 passed — no regressions |
| Phase 1 staff identity tests | 94 passed |
| New Phase 2 tests | 81 (40 unit, 41 DB-backed) |
| Migration `up` on a scratch DB | 7 tables + 3 columns created |
| Each partial unique index | verified to reject what it claims |
| `CHECK` constraints | negative service radius rejected |
| Migration `down` | every table and column removed cleanly |
| End-to-end against a real stack | park created → zones → supervisor → activated → shift opened → 6 drivers rostered → queue → presence → badges issued, all through the real HTTP API |

---

## 9. Known limitations

1. ~~**Park request assignment does not exist.**~~ **DELIVERED in Phase 3.** See
   [park_dispatch_integration.md](./park_dispatch_integration.md).
2. **Badge scanning is not implemented.** `verifyPayload` settles the format and is tested; the scan →
   photo-confirm → assign flow is Phase 4.
3. **Shift counters are always zero.** `requestsReceived` / `assignmentsMade` are maintained by later
   phases. They exist now so a shift closed today is comparable with one closed after go-live.
4. **No automatic shift-abandonment sweep.** `findStaleOpen` exists and the data is queryable; nothing
   runs it on a timer. Deliberate — introducing a background mutator in the same phase that introduces
   the entity gives it no chance to be observed first.
5. **`ParkDevice` does not exist.** `deviceId` is recorded on shifts as free text; nothing issues or
   validates a device credential. Phase 3.
6. **MFA still not enforced** (carried from Phase 1).
7. **Presence has no automatic decay.** A driver left `WAITING` overnight stays `WAITING`;
   `DriverPresenceService.stale()` reports it, nothing corrects it. Reporting beats silently erasing an
   operational fact a supervisor needs to see.
8. **Pre-existing, unrelated:** migration `AddMissingEnumValues1746600000000` still fails on a virgin
   database (`ledger_entry_balancetype_enum` is never created by `InitialSchema`). Worked around
   manually for the local end-to-end run. Untouched here; worth a separate fix before anyone rebuilds
   an environment from scratch.

---

## 10. Deployment

Additive and inert. Deploy order:

```
npm run build
npm run migration:run          # 1789000000000-CreateParkInfrastructure
# restart
```

No feature flag is needed because there is nothing to switch on: the tables are empty, no dispatch code
path reads them, and every new route requires a park-scoped staff role that nobody holds until
operations grants one.

**Rollback:** `npm run migration:revert` drops all seven tables and the three columns. Nothing else
references them, so nothing else breaks.

**Before granting park roles in production**, complete the Phase 1 legacy-key retirement
([admin_auth_migration.md](./admin_auth_migration.md) step 5). A park role reachable by a shared secret
would defeat the attribution the whole design depends on.
