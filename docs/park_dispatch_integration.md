# Park Dispatch Integration — Phase 3

**Park Dispatch as a downstream fallback to the existing dispatch engine.**

**Branch:** `feat/staff-identity-foundation` · **Status:** implemented, not merged, not deployed.
**Default:** `PARK_DISPATCH_ENABLED=false` — deploying this changes nothing.
**Builds on:** [`park_operations_architecture.md`](./park_operations_architecture.md) (Phase 2).

---

## 1. Where the fallback sits

```
  ride:request
      │
      ▼
  ┌──────────────────────────────────────────────────────────┐
  │  DIRECT DISPATCH — completely unchanged                   │
  │  DispatchRun · 2 rounds · 2/3.5/5 km then 5/6.5 km        │
  │  15s offers · 110s lifetime · atomic driver reservation   │
  └───────┬──────────────────────────────────┬───────────────┘
          │ a driver accepts                 │ rounds exhausted
          ▼                                  ▼
    status = accepted            finalizeUnsuccessfulDispatch
        [DONE]                             │
                                           ▼
                          ┌────────────────────────────────┐
                          │ ParkDispatchService.offerToPark │  ← THE ONLY HOOK
                          └────────┬──────────────┬────────┘
                          returns false      returns true
                                   │              │
                                   ▼              ▼
                          status = 'failed'   ride stays 'searching'
                          (exactly as today)  park owns the request
                                                  │
                                                  ▼
                                   dispatcher claims → assigns a driver
                                                  │
                                                  ▼
                          SAME conditional UPDATE: searching → accepted
                                                  │
                                                  ▼
                            the ride belongs to the driver, exactly as if
                            they had accepted it directly
```

**One hook, one line of reasoning:** by the time `offerToPark` is called, the run has finished, its
rounds are exhausted, its evidence is sealed and its outcome is known. Nothing in the fallback can
shorten a round, change a radius tier, alter eligibility, or influence which drivers were rung.

`DispatchRun`, `DispatchOrchestrator`, `DispatchService`, `DriverEligibilityService` and
`dispatch_config.ts` are **untouched** by this phase.

## 2. The three guarantees

### 2.1 There is exactly one ride flow

The body of `ride:accept` was extracted into `SocketHandler.assignDriverToRide`. Both callers use it:

| Caller | `source` | Difference |
|---|---|---|
| `ride:accept` | `direct` | `ride:confirmed` on the accepting socket |
| Park assignment | `park` | `ride:confirmed` + `ride:park_assignment` to the driver's room; provenance columns written |

Order of operations, the atomic UPDATE, evidence capture, emitted events and state cleanup are
identical. The handler is now a shell that maps failure codes back to the exact events the driver app
has always received.

This is the brief's own constraint — *do not create a second ride flow* — taken seriously. A duplicated
flow would inevitably drift and produce rides that behave subtly differently under load, at exactly the
moment nobody is looking.

### 2.2 `RideStatus` gains no values

The ride is `searching` for the whole park phase. It becomes `accepted` through the same conditional
`WHERE status = 'searching'` a direct acceptance uses. So every existing conditional UPDATE, stale
sweeper query, eligibility filter and monitoring query keeps working **without knowing park dispatch
exists**.

Park state lives in its own machine on `park_dispatch_job`:

```
  OFFERED ──claim──► CLAIMED ──assign──► ASSIGNED   (ride is now accepted)
     │                  │
     │                  ├──skip / reject──► resolved → next park, or ride fails
     │                  └──escalate──────► resolved → RIDE KEEPS SEARCHING
     │
     └──window elapses──► EXPIRED → next park, or ride fails

  Any live state ──passenger cancels / direct driver wins──► CANCELLED
```

### 2.3 The arbiter never moves

The ride row is the sole arbiter of who owns a ride. A direct driver accepting during the park phase
simply wins the conditional UPDATE; the park assignment is refused with "This ride was taken by another
driver", the job is cancelled, and the dispatcher's screen updates. There is a test for exactly this,
including an assertion that the provenance columns stay null because the park path never got that far.

## 3. The dispatcher's authority

Claim · Assign · Skip · Escalate · Reject. That is the complete list.

**Assignment is the last thing a dispatcher does.** From that moment the ride is `accepted`, owned by
the driver, and arrival / start / completion run through the existing handlers with the existing GPS
gates. No endpoint on the dispatcher router advances a ride — not because it is disabled, but because
no such capability exists in the permission catalogue. There is nothing to grant or misconfigure.

**Escalation deliberately does not fail the ride.** It resolves the job, leaves the ride `searching`,
and the existing stale-ride coordination continues to own it — the same posture
`escalatedToSupportAt` takes elsewhere in the platform. Escalation means "somebody look at this", never
"this is over".

### The queue card

Every field the brief specifies, plus the deadline so a device can count down:

| Field | Note |
|---|---|
| Pickup / destination | from the ride |
| Passenger name | **first name only** |
| Passenger phone | **masked** (`0801••••678`) |
| Estimated fare, payment mode | from the ride |
| Time waiting | since the PASSENGER requested, not since the park was offered |
| Priority | `normal` / `elevated` / `urgent` |
| Parks tried | distinct parks this ride has been offered to |
| Expires at | claim or assignment deadline, whichever applies |

A dispatcher sourcing a driver has no need to phone a passenger who never asked to hear from them. A
supervisor holds `dispatch:reveal_passenger_contact`; that reveal is audited and expires.

**Priority is derived from how long the passenger has waited, never from fare.** Ranking by fare would
quietly teach dispatchers to serve expensive trips first — the exact bias the queue-fairness work
exists to prevent.

## 4. Park selection

Ranked by **estimated travel time**, then park priority, then driver count.

Distance alone is the obvious choice and the wrong one: two parks four kilometres away are not
equivalent if one has nobody standing in it. A park with no assignable driver is **filtered out
entirely** rather than ranked low — offering a ride to an empty park burns the claim window and leaves
the passenger worse off than failing immediately.

Exclusion reasons, all recorded on the ride's dispatch timeline: `already_tried`,
`outside_service_radius`, `too_far_by_time`, `outside_operating_hours`, `no_assignable_driver`.

There is no server-side routing API. Travel time is a straight-line estimate at
`KEKE_METRES_PER_MINUTE` (230), the constant the stale-ride sweeper already uses. It orders candidates
and refuses absurd ones; it never promises a passenger an arrival time.

**Assignable presence is `AT_PARK` and `WAITING` only.** The brief lists "AT_PARK, WAITING, AVAILABLE";
the first two are presence states, and AVAILABLE is a *roster* property (active, not suspended, wallet
clear, badge issued) evaluated separately by `ParkRosterService.assignabilityProblems`. `ONLINE` is
excluded on purpose: a driver working but not at the park is precisely who the rounds just failed to
reach, and a dispatcher cannot hand a trip slip to somebody who is not standing there.

## 5. Feature-phone support

Two modes on one assignment, not two paths:

| Mode | What it means |
|---|---|
| `electronic` | Smartphone driver. `ride:park_assignment` and `ride:confirmed` land in their app. |
| `verbal` | Feature-phone driver. The dispatcher read the trip details out and is recording that they did. |

The ride is **identical** in every other respect: same status, same ownership, same lifecycle. What
differs is the honest record of how the driver came to know — `ride.assignmentMode`. That column is why
a missing GPS trail on a `verbal` ride is explained rather than read as a fault by support later.

**Passengers are never asked to scan a QR code or enter a driver PIN.** Nothing in this phase adds a
step to the passenger journey. The existing 4-character `pickupCode` remains what it has always been: a
passive strip on the card that the backend never validates.

## 6. Passenger experience

| Moment | What the passenger sees |
|---|---|
| Direct dispatch running | "Finding a Keke near you…" (unchanged) |
| Park phase opens | "Still searching nearby…" on existing builds; "Checking a nearby Keke park…" on newer ones |
| Dispatcher claims | "A driver is being assigned…" |
| Driver assigned | The normal driver card — name, photo, unit, plate, call button |

The driver card is **identical** whether the ride came from direct dispatch or a park. The passenger
must not be able to tell, and must not care, which supply channel found their Keke.

### Keeping existing builds honest

The passenger app has a **150-second client-side watchdog** that re-arms on every `ride:dispatch_round`
event, and `SearchingCopy.of(round)` renders "Still searching nearby…" for any round ≥ 2 without
printing the number. The fallback emits a round-3 event as the park phase opens, so builds already in
the field do not declare a timeout while the server is still working — with copy that is true.
`ride:park_state` carries the specific copy for newer builds and is ignored by older ones.

## 7. Timing

| Phase | Window |
|---|---|
| Direct dispatch | 110 s (unchanged) |
| Park claim | 25 s |
| Park driver assignment | 45 s |
| **Total ceiling** | **180 s** |
| Parks per ride | 1 (a second would push the wait past what a passenger tolerates) |

A test asserts the arithmetic, so a config change that broke the 180-second ceiling fails the build.

## 8. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PARK_DISPATCH_ENABLED` | **`false`** | Master switch. Off means the fallback is never consulted |
| `PARK_CLAIM_WINDOW_MS` | `25000` | Time to claim an offer |
| `PARK_ASSIGN_WINDOW_MS` | `45000` | Time to assign after claiming |
| `PARK_MAX_PARKS_PER_RIDE` | `1` | Sequential park fallback depth |
| `PARK_MAX_TRAVEL_MINUTES` | `12` | Refuse absurdly distant parks |
| `PARK_REQUIRE_WAITING_DRIVER` | `true` | Skip parks with nobody assignable |
| `PARK_EMIT_ROUND_EVENT` | `true` | Re-arm the passenger app watchdog |
| `PARK_JOB_SWEEP_INTERVAL_MS` | `10000` | Expiry sweep cadence |

## 9. Monitoring

`GET /admin/park-dispatch/overview` and the **Park Dispatch** admin screen:

active queues · pending assignments · dispatcher response times · assignment success rate · average
passenger wait · park utilisation — plus the feature-flag state, which is shown first because a
dashboard of zeroes means something very different when the fallback is off.

Response and assignment times are **medians**. One dispatcher who left a device on a bench would drag a
mean into meaninglessness.

Every park event lands on the SAME ride timeline as the direct-dispatch events, so the admin monitor
tells one continuous story: rounds tried → nobody accepted → park offered → dispatcher claimed → driver
assigned.

## 10. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| Full suite with integration | **507 passed, 0 failed** |
| Pre-existing dispatch / ride / coordination tests | 279 passed — **no regressions** |
| New Phase 3 tests | 53 (22 unit, 31 DB-backed) |
| Migration up / constraints / down | verified on a scratch database |
| One-live-job-per-ride index | verified to reject a second, and to allow re-offer after expiry |

**End-to-end against a real stack** (Postgres + Redis + backend + admin UI), driven through the real
HTTP API:

```
queue size: 3 | priorities: urgent(420s), elevated(180s), normal(0s)
claimed: Zik Avenue → Amaku
assignable drivers: Ifeanyi(feature_phone), Chinedu(feature_phone), Emeka(smartphone), Tobenna(BLOCKED)
ASSIGNED Ifeanyi mode: verbal
  ride is now: {"status":"accepted","driverId":"e82888c4…","dispatchMode":"park","assignmentMode":"verbal"}
```

A feature-phone driver, assigned verbally, producing a ride indistinguishable from a directly-accepted
one apart from its provenance.

## 11. Known limitations

1. **Sequential multi-park fallback is capped at one park.** The code supports more
   (`PARK_MAX_PARKS_PER_RIDE`); the default is 1 because two would push the worst case past 180 s.
2. **No dispatcher mobile app.** The API is complete and exercised by tests and the seeding script; the
   Flutter dispatcher client is a separate deliverable.
3. **Travel time is straight-line.** Adequate for ranking, and deliberately never shown to a passenger
   as an ETA.
4. **`ride:park_assignment` is emitted but no driver app consumes it yet.** A smartphone driver
   assigned from a park currently learns about the ride the same way they learn about any assigned
   ride — through `ride:assigned` and active-ride recovery. The dedicated event is additive and ignored
   by current builds.
5. **The expiry sweep is a fixed 10-second timer.** Fine at pilot volume; a queue-driven design would
   be better at scale.
6. **Park utilisation on the monitoring screen issues one metrics query per park.** Acceptable for a
   handful of parks; needs batching before dozens.
7. **Pre-existing, unrelated:** migration `AddMissingEnumValues1746600000000` still fails on a virgin
   database. Worked around manually for local runs. Untouched.

## 12. Deployment

```
npm run build
npm run migration:run          # 1790000000000-CreateParkDispatchJob
# restart — nothing changes yet: PARK_DISPATCH_ENABLED is false
```

Then, when operations is ready and a park is live with a dispatcher on duty:

```
PARK_DISPATCH_ENABLED=true     # one variable, no deploy
```

**Rollback is the same variable back to `false`.** Live jobs stop being created immediately; any job
already in flight resolves normally or expires. No data changes, no redeploy.

**Full rollback:** `npm run migration:revert` drops `park_dispatch_job` and the four `ride` columns.
The enum values added to `dispatch_event_eventtype_enum` are deliberately not removed — Postgres cannot
drop one without recreating the type, and rows may reference them.

### Before enabling in production

1. Complete the Phase 1 legacy-key retirement — a park role reachable by a shared secret defeats the
   attribution this design rests on.
2. Confirm at least one park is `ACTIVE` with a supervisor, a staging zone, a roster and a dispatcher
   who can open a shift. With no eligible park, `offerToPark` returns false on every ride and the
   fallback is a no-op — safe, but pointless.
3. Decide whether the 180-second worst-case wait is acceptable. It is roughly 1.6× today's ceiling, and
   it is the one product question this phase cannot answer for you.
